/*
 * Demo mode: a fake Mi Scooter 3 that speaks the real encrypted protocol.
 * Useful for trying the UI without hardware.
 */

import { NinebotCrypto } from './crypto.js';
import {
  ADDR,
  CMD,
  REG,
  buildFrame,
  parseFrame,
  concatBytes,
  randomBytes,
  asciiToBytes,
  u16le,
  delay,
} from './protocol.js';

export class MockScooter {
  constructor({
    name = 'Mi Scooter 3',
    serial = 'MISCOOTER3DEMO',
    buttonDelay = 1800,
    onLog = () => {},
  } = {}) {
    this.name = name;
    this.serial = serial;
    this.serialBytes = asciiToBytes(serial.padEnd(14, '0').slice(0, 14));
    this.buttonDelay = buttonDelay;
    this.onLog = onLog;
    this.crypto = new NinebotCrypto(name);
    this.randomBleData = randomBytes(16);
    this.randomAppData = null;
    this.ackSent = false;
    this.buttonTimer = null;
    this.paired = false;
    this.locked = false;
    this.battery = 78;
    this.kers = 0;
    this.powerOff = false;
  }

  log(text) {
    this.onLog({ kind: 'info', text: `Demo: ${text}` });
  }

  reply(cmd, arg, data = new Uint8Array(0), emit, src = ADDR.BLE) {
    const plain = buildFrame({
      src,
      dst: ADDR.APP,
      cmd,
      arg,
      data,
      checksum: false,
    });
    const encrypted = this.crypto.encrypt(plain);
    emit(encrypted);
  }

  receive(encryptedFrame, emit) {
    let plain;
    try {
      plain = this.crypto.decrypt(encryptedFrame);
    } catch (error) {
      this.log(`could not decrypt frame: ${error.message}`);
      return;
    }

    let parsed;
    try {
      parsed = parseFrame(plain);
    } catch {
      this.log('invalid frame received');
      return;
    }

    const { cmd, arg, data } = parsed;

    if (cmd === CMD.PAIR_START) {
      this.log('0x5B: sending random data and serial number');
      this.reply(
        CMD.PAIR_START,
        0,
        concatBytes(this.randomBleData, this.serialBytes),
        emit,
      );
      this.crypto.calcKey(this.crypto.nameBytes, this.randomBleData);
      this.crypto.randomBleData = this.randomBleData;
      return;
    }

    if (cmd === CMD.PAIR_KEY) {
      if (data.length === 16) this.randomAppData = data.slice();
      if (!this.ackSent) {
        this.ackSent = true;
        this.reply(CMD.PAIR_KEY, 0, new Uint8Array(0), emit);
        this.log('0x5C: key accepted, waiting for the power button');
      }
      if (!this.buttonTimer) {
        this.buttonTimer = setTimeout(() => {
          this.buttonTimer = null;
          this.log('power button pressed');
          const ready = buildFrame({
            src: ADDR.BLE,
            dst: ADDR.APP,
            cmd: CMD.PAIR_KEY,
            arg: 1,
            data: new Uint8Array(0),
            checksum: false,
          });
          const encrypted = this.crypto.encrypt(ready);
          this.crypto.calcKey(this.randomAppData, this.randomBleData);
          this.paired = true;
          emit(encrypted);
        }, this.buttonDelay);
      }
      return;
    }

    if (cmd === CMD.PAIR_BIND) {
      const serial = BufferLike.toAscii(data);
      if (serial === BufferLike.toAscii(this.serialBytes)) {
        this.paired = true;
        this.log('0x5D: pairing confirmed');
        this.reply(CMD.PAIR_BIND, 1, new Uint8Array(0), emit);
      } else {
        this.log('0x5D: serial number mismatch');
        this.reply(CMD.PAIR_BIND, 0, new Uint8Array(0), emit);
      }
      return;
    }

    if (cmd === CMD.READ) {
      this.reply(CMD.READ_RESP, arg, this.readRegister(arg, data[0] || 0), emit, ADDR.ESC);
      return;
    }

    if (cmd === CMD.WRITE) {
      const value = data.length >= 2 ? u16le(data) : 0;
      if (arg === REG.LOCK) {
        this.locked = true;
        this.log('lock enabled (0x70)');
      } else if (arg === REG.UNLOCK) {
        this.locked = false;
        this.log('lock disabled (0x71)');
      } else if (arg === REG.KERS && value <= 2) {
        this.kers = value;
      } else {
        this.log(`write register 0x${arg.toString(16)} = ${value}`);
      }
      this.reply(CMD.WRITE_RESP, 0, new Uint8Array(0), emit, ADDR.ESC);
      return;
    }

    if (cmd === 0x79) {
      this.powerOff = true;
      this.log('power-off command');
    }
  }

  readRegister(register, length) {
    const size = Math.max(0, Number(length) || 0);
    const out = new Uint8Array(size);
    if (register === REG.BATTERY && size >= 2) {
      out[0] = this.battery & 0xff;
      out[1] = (this.battery >> 8) & 0xff;
    } else if (register === REG.STATUS && size >= 2) {
      out[0] = this.locked ? 2 : 0;
    } else if (register === REG.FW_VERSION && size >= 2) {
      out[0] = 0x57;
      out[1] = 0x01;
    } else if (register === REG.KERS && size >= 2) {
      out[0] = this.kers;
    } else if (register === 0x68 && size >= 2) {
      out[0] = 0x32; out[1] = 1;
    } else if (register === REG.ODOMETER && size >= 4) {
      new DataView(out.buffer).setUint32(0, 123450, true);
    } else if (register === REG.VOLTAGE && size >= 2) {
      new DataView(out.buffer).setUint16(0, 3850, true);
    } else if (register === REG.FRAME_TEMP && size >= 2) {
      new DataView(out.buffer).setUint16(0, 285, true);
    } else if (register === REG.SERIAL) {
      out.set(this.serialBytes.subarray(0, size));
    }
    return out;
  }

  destroy() {
    if (this.buttonTimer) clearTimeout(this.buttonTimer);
    this.buttonTimer = null;
  }
}

const BufferLike = {
  toAscii(bytes) {
    let out = '';
    for (const byte of bytes) out += String.fromCharCode(byte);
    return out;
  },
};

export class MockTransport {
  constructor(scooter, { latency = 15, onLog = () => {} } = {}) {
    this.scooter = scooter;
    this.latency = latency;
    this.onLog = onLog;
    this.frameHandlers = new Set();
    this.disconnectHandlers = new Set();
    this.connected = true;
  }

  onFrame(handler) {
    this.frameHandlers.add(handler);
    return () => this.frameHandlers.delete(handler);
  }

  onDisconnect(handler) {
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
  }

  emitFrame(frame) {
    for (const handler of this.frameHandlers) {
      try {
        handler(frame);
      } catch (error) {
        console.error(error);
      }
    }
  }

  async connect() {
    this.connected = true;
    this.onLog({ kind: 'transport', text: 'Demo scooter connected (virtual NUS)' });
    return { name: 'Демо', service: 'mock' };
  }

  async write(frame) {
    if (!this.connected) throw new Error('Demo connection closed');
    await delay(this.latency);
    this.scooter.receive(frame, (reply) => this.emitFrame(reply));
  }

  async disconnect() {
    if (!this.connected) return;
    this.connected = false;
    this.scooter.destroy();
    for (const handler of this.disconnectHandlers) {
      try {
        handler();
      } catch {
        // ignore
      }
    }
  }
}
