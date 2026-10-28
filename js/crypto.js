/*
 * NinebotCrypto ("first crypto protocol") used by Ninebot F-series / Mi Scooter 3.
 *
 * Based on the open implementation published by the ScooterHacking team:
 * https://github.com/scooterhacking/NinebotCrypto
 * JavaScript adaptation for Mi3 BLE; modified 2026-10-25.
 * License: AGPL-3.0-only; see ../LICENSE and ../THIRD_PARTY_NOTICES.md.
 *
 * Flow:
 *   1. App -> BLE : 0x5B (encrypted with key derived from BLE name + FW constant)
 *   2. BLE -> App : 0x5B reply, contains 16 random bytes + 14-byte serial
 *   3. App -> BLE : 0x5C + 16 random bytes, retry every 500 ms until accepted
 *   4. User presses the power button
 *   5. BLE -> App : 0x5C 01 -> final key = SHA1(appRandom || bleRandom)
 *   6. App -> BLE : 0x5D + serial
 *   7. BLE -> App : 0x5D 01 -> paired
 *
 * Only AES-128-ECB encryption is required.
 */

import { aes128EcbEncrypt } from './aes.js';
import { sha1 } from './sha1.js';
import { concatBytes, equalBytes, cleanAscii } from './protocol.js';

export const FIRMWARE_DATA = Uint8Array.from([
  0x97, 0xcf, 0xb8, 0x02, 0x84, 0x41, 0x43, 0xde,
  0x56, 0x00, 0x2b, 0x3b, 0x34, 0x78, 0x0a, 0x5d,
]);

export class NinebotCryptoError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NinebotCryptoError';
    this.code = code;
  }
}

function pad16(bytes) {
  const out = new Uint8Array(16);
  out.set(bytes.subarray(0, 16));
  return out;
}

export function deriveKey(part1, part2) {
  const hash = sha1(concatBytes(pad16(part1), pad16(part2)));
  return hash.slice(0, 16);
}

function xor16(a, b) {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = a[i] ^ b[i];
  return out;
}

function startsWithBytes(bytes, expected) {
  if (bytes.length < expected.length) return false;
  for (let i = 0; i < expected.length; i++) if (bytes[i] !== expected[i]) return false;
  return true;
}

export class NinebotCrypto {
  /**
   * @param {string} name BLE advertised device name (used for the initial key)
   */
  constructor(name) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new NinebotCryptoError('NAME', 'Bluetooth name for AES key is missing');
    }
    this.setName(name);
  }

  setName(name) {
    this.name = name;
    this.nameBytes = new TextEncoder().encode(name);
    this.key = deriveKey(this.nameBytes, FIRMWARE_DATA);
    this.randomBleData = new Uint8Array(16);
    this.randomAppData = new Uint8Array(16);
    this.messageCounter = -1;
    this.serial = '';
    this.serialBytes = new Uint8Array(0);
    this.cryptoReady = false;
  }

  reset() {
    this.key = deriveKey(this.nameBytes, FIRMWARE_DATA);
    this.randomBleData = new Uint8Array(16);
    this.randomAppData = new Uint8Array(16);
    this.messageCounter = -1;
    this.serial = '';
    this.serialBytes = new Uint8Array(0);
    this.cryptoReady = false;
  }

  /** Update the key manually (used by the mock scooter). */
  calcKey(part1, part2) {
    this.key = deriveKey(part1, part2);
  }

  cryptoFirst(data) {
    const keystream = aes128EcbEncrypt(FIRMWARE_DATA, this.key);
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = data[i] ^ keystream[i & 15];
    return out;
  }

  cryptoNext(data, counter) {
    const out = new Uint8Array(data.length);
    const iv = new Uint8Array(16);
    iv[0] = 0x01;
    new DataView(iv.buffer).setUint32(1, counter >>> 0, false);
    iv.set(this.randomBleData.subarray(0, 8), 5);
    let block = 0;
    for (let offset = 0; offset < data.length; offset += 16) {
      block += 1;
      iv[15] = block & 0xff;
      const keystream = aes128EcbEncrypt(iv, this.key);
      const count = Math.min(16, data.length - offset);
      for (let i = 0; i < count; i++) out[offset + i] = data[offset + i] ^ keystream[i];
    }
    return out;
  }

  calcCrcFirst(payload) {
    let sum = 0;
    for (let i = 0; i < payload.length; i++) sum = (sum + payload[i]) & 0xffff;
    const inv = (~sum) & 0xffff;
    return Uint8Array.of(inv & 0xff, (inv >> 8) & 0xff);
  }

  calcCrcNext(frame, counter) {
    const payloadLen = frame.length - 3;
    let byteIndex = 3;
    const iv = new Uint8Array(16);
    iv[0] = 0x59;
    new DataView(iv.buffer).setUint32(1, counter >>> 0, false);
    iv.set(this.randomBleData.subarray(0, 8), 5);
    iv[15] = payloadLen & 0xff;

    let chain = aes128EcbEncrypt(iv, this.key);

    const headerBlock = new Uint8Array(16);
    headerBlock.set(frame.subarray(0, 3));
    let mixed = xor16(headerBlock, chain);
    chain = aes128EcbEncrypt(mixed, this.key);

    let remaining = payloadLen;
    while (remaining > 0) {
      const count = Math.min(remaining, 16);
      const block = new Uint8Array(16);
      block.set(frame.subarray(byteIndex, byteIndex + count));
      mixed = xor16(block, chain);
      chain = aes128EcbEncrypt(mixed, this.key);
      remaining -= count;
      byteIndex += count;
    }

    iv[0] = 0x01;
    iv[15] = 0x00;
    const finalKey = aes128EcbEncrypt(iv, this.key);
    const out = new Uint8Array(4);
    for (let i = 0; i < 4; i++) out[i] = finalKey[i] ^ chain[i];
    return out;
  }

  /**
   * Encrypt a plaintext frame.
   * @param {Uint8Array} frame 5A A5 LEN SRC DST CMD ARG DATA CK_LO CK_HI
   * @returns {Uint8Array}
   */
  encrypt(frame) {
    if (!(frame instanceof Uint8Array) || frame.length < 7) {
      throw new NinebotCryptoError('FRAME', 'Frame too short for encryption');
    }
    if (frame[0] !== 0x5a || frame[1] !== 0xa5) {
      throw new NinebotCryptoError('FRAME', 'Invalid frame header (expected 5A A5)');
    }
    if (frame.length !== frame[2] + 7) {
      throw new NinebotCryptoError(
        'FRAME',
        'Encryption requires a frame without checksum (5A A5 LEN SRC DST CMD ARG DATA)',
      );
    }

    const payload = frame.subarray(3);
    this.messageCounter += 1;
    const counter = this.messageCounter;

    let encryptedPayload;
    let trailer;

    if (counter === 0) {
      const crc = this.calcCrcFirst(payload);
      encryptedPayload = this.cryptoFirst(payload);
      trailer = Uint8Array.of(0x00, 0x00, crc[0], crc[1], 0x00, 0x00);
    } else {
      const unsignedCounter = counter >>> 0;
      const crc = this.calcCrcNext(frame, unsignedCounter);
      encryptedPayload = this.cryptoNext(payload, unsignedCounter);
      trailer = new Uint8Array(6);
      trailer.set(crc, 0);
      trailer[4] = (unsignedCounter >>> 8) & 0xff;
      trailer[5] = unsignedCounter & 0xff;
    }

    const out = concatBytes(frame.subarray(0, 3), encryptedPayload, trailer);

    // Remember the 16-byte random key from the 0x5C request.
    if (
      frame[2] === 0x10 &&
      frame[3] === 0x3e &&
      frame[4] === 0x21 &&
      frame[5] === 0x5c &&
      frame[6] === 0x00
    ) {
      this.randomAppData = payload.slice(4, 20);
    }

    return out;
  }

  validateDecrypted(frame, counter) {
    if (frame.length < 7 || frame[0] !== 0x5a || frame[1] !== 0xa5) {
      throw new NinebotCryptoError('CRYPTO', 'Decrypted frame is invalid');
    }

    const src = frame[3];
    const dst = frame[4];
    const isScooterAddress = src === 0x20 || src === 0x21 || src === 0x22 || src === 0x23;
    const isAppAddress = src === 0x3e || dst === 0x3e;

    if (dst === 0x3e) {
      // Scooter -> app. Every reply in this app is addressed to 0x3E.
      if (!isScooterAddress) {
        throw new NinebotCryptoError(
          'CRYPTO',
          'Unexpected frame source. Check the Bluetooth name used for AES.',
        );
      }
      if (counter <= 0) {
        // The very first reply must be 0x5B: 30 data bytes, BLE -> APP.
        if (frame[2] !== 0x1e || src !== 0x21 || frame[5] !== 0x5b) {
          throw new NinebotCryptoError(
            'CRYPTO',
            'Invalid hello reply. Check the Bluetooth name used for AES.',
          );
        }
        const serial = frame.subarray(frame.length - 14);
        for (let i = 0; i < serial.length; i++) {
          if (serial[i] < 0x20 || serial[i] > 0x7e) {
            throw new NinebotCryptoError(
              'CRYPTO',
              'Invalid serial in hello reply. Check the Bluetooth name used for AES.',
            );
          }
        }
      }
      return;
    }

    // App -> scooter (used by the demo mock scooter, not by the app).
    if (isAppAddress && (dst === 0x20 || dst === 0x21 || dst === 0x22 || dst === 0x23)) {
      return;
    }

    throw new NinebotCryptoError(
      'CRYPTO',
      'Unexpected decrypted addresses. Check the Bluetooth name used for AES.',
    );
  }

  computeIncomingCounter(frame) {
    let counter = this.messageCounter;
    if ((counter & 0x0008000) > 0 && (frame[frame.length - 2] >> 7) === 0) {
      counter += 0x0010000;
    }
    counter = (counter & 0xffff0000) + ((frame[frame.length - 2] << 8) + frame[frame.length - 1]);
    return counter;
  }

  /**
   * Decrypt an encrypted frame (header + payload + 6-byte crypto trailer).
   * @param {Uint8Array} frame
   * @returns {Uint8Array} plaintext frame without checksum
   */
  decrypt(frame) {
    if (!(frame instanceof Uint8Array) || frame.length < 13) {
      throw new NinebotCryptoError('FRAME', 'Encrypted frame too short');
    }
    if (frame[0] !== 0x5a || frame[1] !== 0xa5) {
      throw new NinebotCryptoError('FRAME', 'Invalid encrypted frame header');
    }
    if (frame.length !== frame[2] + 13) {
      throw new NinebotCryptoError(
        'FRAME',
        'Encrypted frame length must equal LEN + 13 bytes',
      );
    }

    const counter = this.computeIncomingCounter(frame);
    const payload = frame.subarray(3, frame.length - 6);
    const decrypted = counter <= 0 ? this.cryptoFirst(payload) : this.cryptoNext(payload, counter);
    const check = counter <= 0 ? this.cryptoFirst(decrypted) : this.cryptoNext(decrypted, counter);
    if (!equalBytes(check, payload)) {
      throw new NinebotCryptoError(
        'CRYPTO',
        'Could not decrypt reply. Check that the AES Bluetooth name matches the scooter.',
      );
    }

    const out = concatBytes(frame.subarray(0, 3), decrypted);
    this.validateDecrypted(out, counter);

    if (counter <= 0) {
      // 0x5B reply: 30 data bytes = 16 random + 14 serial.
      if (startsWithBytes(out, Uint8Array.of(0x5a, 0xa5, 0x1e, 0x21, 0x3e, 0x5b))) {
        if (decrypted.length >= 34) {
          this.randomBleData = decrypted.slice(4, 20);
          this.serialBytes = decrypted.slice(decrypted.length - 14);
          this.serial = cleanAscii(this.serialBytes).trim();
          this.key = deriveKey(this.nameBytes, this.randomBleData);
          // Key proposals start at counter 3 after the counter-0 hello/reply
          // exchange; see docs/protocol.md for the handshake sequence.
          this.messageCounter = 2;
        }
      }
    } else {
      // 0x5C 01: the scooter confirmed the power button.
      if (startsWithBytes(out, Uint8Array.of(0x5a, 0xa5, 0x00, 0x21, 0x3e, 0x5c, 0x01))) {
        this.key = deriveKey(this.randomAppData, this.randomBleData);
        this.cryptoReady = true;
      }

      // Keep the send counter in sync with the scooter. This is the fixed
      // counter handling from BetterNinebotCrypto.swift (issue #13).
      if (counter > this.messageCounter) {
        this.messageCounter = counter;
      } else {
        this.messageCounter += 1;
      }
    }

    return out;
  }

  getState() {
    return {
      name: this.name,
      counter: this.messageCounter,
      serial: this.serial,
      cryptoReady: this.cryptoReady,
      key: Array.from(this.key),
      randomBleData: Array.from(this.randomBleData),
      randomAppData: Array.from(this.randomAppData),
    };
  }
}
