/*
 * Ninebot legacy frame format used by Xiaomi/Ninebot scooters (Mi Scooter 3).
 *
 *  5A A5 LEN SRC DST CMD ARG DATA[LEN] CK_LO CK_HI
 *
 * LEN is the number of DATA bytes.
 * Checksum is 0xFFFF XOR (16-bit sum of LEN..last data byte), little-endian.
 * Encrypted (NinebotCrypto) frames replace the 2-byte checksum with a
 * 6-byte crypto trailer and encrypt SRC..DATA.
 */

export const ADDR = Object.freeze({
  ESC: 0x20,
  BLE: 0x21,
  BMS: 0x22,
  EXT_BMS: 0x23,
  // Mi 3 AES replies observed at 0x23; meaning depends on protocol profile.
  MI3_REPLY: 0x23,
  APP: 0x3e,
});

export const CMD = Object.freeze({
  READ: 0x01,
  WRITE: 0x02,
  WRITE_NORESP: 0x03,
  READ_RESP: 0x04,
  WRITE_RESP: 0x05,
  START_UPDATE: 0x07,
  WRITE_UPDATE: 0x08,
  FINISH_UPDATE: 0x09,
  REBOOT: 0x0a,
  USER_RESET: 0x5a,
  SET_ODOMETER: 0x5c,
  PAIR_START: 0x5b,
  PAIR_KEY: 0x5c,
  PAIR_BIND: 0x5d,
  HEAD_INPUTS: 0x64,
  HEAD_INPUTS_NOANS: 0x65,
});

export const REG = Object.freeze({
  MAGIC: 0x00,
  SERIAL: 0x10,
  PIN: 0x17,
  FW_VERSION: 0x1a,
  ERROR: 0x1b,
  WARNING: 0x1c,
  STATUS: 0x1d,
  MODE: 0x1f,
  BATTERY: 0x22,
  REMAINING_KM: 0x25,
  ODOMETER: 0x29,
  FRAME_TEMP: 0x3e,
  VOLTAGE: 0x47,
  LOCK: 0x70,
  UNLOCK: 0x71,
  SPEED_LIMIT: 0x72,
  SPEED_LIMIT_NORMAL: 0x73,
  SPEED_LIMIT_ECO: 0x74,
  RIDE_MODE: 0x75,
  REBOOT: 0x78,
  POWER_OFF: 0x79,
  KERS: 0x7b,
  CRUISE: 0x7c,
  TAIL_LIGHT: 0x7d,
});

export const REG_NAMES = Object.freeze({
  0x10: 'serial number',
  0x17: 'PIN',
  0x1a: 'firmware version',
  0x1b: 'error code',
  0x1c: 'warning code',
  0x1d: 'ESC status',
  0x1f: 'mode',
  0x22: 'battery',
  0x25: 'remaining range',
  0x29: 'odometer',
  0x3e: 'temperature',
  0x47: 'voltage',
  0x70: 'lock',
  0x71: 'unlock',
  0x72: 'speed limit',
  0x73: 'Normal limit',
  0x74: 'Eco limit',
  0x75: 'ride mode',
  0x78: 'reboot',
  0x79: 'power off',
  0x7b: 'KERS',
  0x7c: 'cruise control',
  0x7d: 'tail light',
});

// NB_INF_BOOL (0x1D), bit 1. 0x70/0x71 are self-clearing commands.
export const STATUS_LOCK_MASK = 0x0002;

export const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
export const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
export const FFE0_SERVICE = '0000ffe0-0000-1000-8000-00805f9b34fb';
export const FFE1_CHAR = '0000ffe1-0000-1000-8000-00805f9b34fb';

export function checksum16(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i]) & 0xffff;
  const inv = (~sum) & 0xffff;
  return [inv & 0xff, (inv >> 8) & 0xff];
}

/**
 * Build a Ninebot frame.
 *
 * The crypto layer expects a frame WITHOUT the 2-byte checksum (the encrypted
 * format replaces it with a 6-byte trailer). Pass `checksum: false` when the
 * frame will be encrypted.
 *
 * @param {{src?:number,dst:number,cmd:number,arg?:number,data?:Uint8Array|number[],checksum?:boolean}} p
 * @returns {Uint8Array}
 */
export function buildFrame({
  src = ADDR.APP,
  dst,
  cmd,
  arg = 0,
  data = new Uint8Array(0),
  checksum = true,
}) {
  const payload = data instanceof Uint8Array ? data : Uint8Array.from(data);
  if (payload.length > 255) throw new Error('Payload is too long (max 255 bytes)');
  const body = new Uint8Array(5 + payload.length);
  body[0] = payload.length;
  body[1] = src & 0xff;
  body[2] = dst & 0xff;
  body[3] = cmd & 0xff;
  body[4] = arg & 0xff;
  body.set(payload, 5);
  const frame = new Uint8Array(2 + body.length + (checksum ? 2 : 0));
  frame[0] = 0x5a;
  frame[1] = 0xa5;
  frame.set(body, 2);
  if (checksum) {
    const [lo, hi] = checksum16(body);
    frame[frame.length - 2] = lo;
    frame[frame.length - 1] = hi;
  }
  return frame;
}

/**
 * Parse a plain frame (with checksum) or a decrypted crypto frame (without).
 * @param {Uint8Array} frame
 * @returns {{raw:Uint8Array,len:number,src:number,dst:number,cmd:number,arg:number,data:Uint8Array,hasChecksum:boolean,checksumOk:boolean|null}}
 */
export function parseFrame(frame) {
  if (!(frame instanceof Uint8Array) || frame.length < 7) throw new Error('Frame is too short');
  if (frame[0] !== 0x5a || frame[1] !== 0xa5) throw new Error('Bad frame header');
  const len = frame[2];
  const hasChecksum = frame.length === len + 9;
  if (!hasChecksum && frame.length !== len + 7) {
    throw new Error(`Bad frame length: ${frame.length}, LEN=${len}`);
  }
  const src = frame[3];
  const dst = frame[4];
  const cmd = frame[5];
  const arg = frame[6];
  const data = frame.slice(7, 7 + len);
  let checksumOk = null;
  if (hasChecksum) {
    const body = frame.subarray(2, 7 + len);
    const [lo, hi] = checksum16(body);
    checksumOk = frame[len + 7] === lo && frame[len + 8] === hi;
  }
  return { raw: frame, len, src, dst, cmd, arg, data, hasChecksum, checksumOk };
}

export function isNinebotFrame(bytes) {
  return bytes.length >= 3 && bytes[0] === 0x5a && bytes[1] === 0xa5;
}

export function bytesToHex(bytes, separator = ' ') {
  const out = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i].toString(16).padStart(2, '0').toUpperCase();
  return out.join(separator);
}

export function hexToBytes(text) {
  const cleaned = String(text).replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
  if (cleaned.length % 2 !== 0) throw new Error('Hex string has an odd number of digits');
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function asciiToBytes(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

export function bytesToAscii(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

export function cleanAscii(bytes) {
  return bytesToAscii(bytes).replace(/\0+$/g, '').replace(/[^\x20-\x7e]/g, '·');
}

export function concatBytes(...parts) {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function u16le(bytes, offset = 0) {
  return (bytes[offset] | (bytes[offset + 1] << 8)) & 0xffff;
}

export function versionToString(value) {
  const major = (value >> 8) & 0xff;
  const minor = (value >> 4) & 0x0f;
  const patch = value & 0x0f;
  return `${major}.${minor}.${patch}`;
}

export function randomBytes(length) {
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('Secure key generation unavailable. Use HTTPS and a browser with Web Crypto.');
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function registerLabel(reg) {
  return REG_NAMES[reg] ? `${REG_NAMES[reg]}` : `register 0x${reg.toString(16).padStart(2, '0')}`;
}

export function describeData(reg, data) {
  if (!data || data.length === 0) return '';
  switch (reg) {
    case REG.BATTERY: {
      if (data.length >= 2) return `${u16le(data)}%`;
      break;
    }
    case REG.STATUS: {
      if (data.length >= 2) return `lock ${(u16le(data) & STATUS_LOCK_MASK) !== 0 ? 'on' : 'off'} · flags 0x${u16le(data).toString(16).padStart(4, '0')}`;
      break;
    }
    case REG.LOCK:
    case REG.UNLOCK: {
      if (data.length >= 2) return `command register: ${u16le(data)}`;
      break;
    }
    case REG.SERIAL: {
      return cleanAscii(data).trim();
    }
    case REG.FW_VERSION: {
      if (data.length >= 2) return versionToString(u16le(data));
      break;
    }
    case REG.ERROR:
    case REG.WARNING: {
      if (data.length >= 2) return `code ${u16le(data)}`;
      break;
    }
    case REG.KERS: {
      if (data.length >= 2) return ['weak', 'medium', 'strong'][u16le(data)] || `level ${u16le(data)}`;
      break;
    }
    case REG.CRUISE: {
      if (data.length >= 2) return u16le(data) ? 'on' : 'off';
      break;
    }
    case REG.TAIL_LIGHT: {
      if (data.length >= 2) return u16le(data) ? 'on' : 'off';
      break;
    }
    default:
      break;
  }
  if (data.length <= 8) return bytesToHex(data);
  return `${data.length} bytes: ${bytesToHex(data.subarray(0, 8))}…`;
}

/**
 * Human-readable one-line description of a frame.
 * @param {Uint8Array} frame
 * @returns {{label:string,details:string}}
 */
export function describeFrame(frame) {
  if (!frame || frame.length < 7) return { label: 'frame', details: bytesToHex(frame || new Uint8Array()) };
  let p;
  try {
    p = parseFrame(frame);
  } catch (error) {
    return { label: 'invalid frame', details: error.message };
  }
  const { cmd, arg, data } = p;
  const regText = registerLabel(arg);

  switch (cmd) {
    case CMD.PAIR_START:
      return {
        label: '0x5B · pairing hello',
        details: 'serial number and key request',
      };
    case CMD.PAIR_KEY:
      return {
        label: arg === 1 ? '0x5C · power button pressed' : '0x5C · pairing key',
        details: arg === 1 ? 'button confirmed' : p.dst === ADDR.APP && data.length === 0 ? 'key accepted, waiting for the power button' : `${data.length} random key bytes`,
      };
    case CMD.PAIR_BIND:
      return {
        label: '0x5D · pairing confirmation',
        details: arg === 1 ? 'pairing completed' : `arg=${arg}`,
      };
    case CMD.READ:
      if (p.dst === ADDR.APP) return { label: `0x01 · reply ${regText}`, details: describeData(arg, data) || bytesToHex(data) };
      return { label: `0x01 · read ${regText}`, details: `length ${data[0] ?? 0}` };
    case CMD.READ_RESP: {
      const value = describeData(arg, data);
      return { label: `0x04 · reply ${regText}`, details: value || bytesToHex(data) };
    }
    case CMD.WRITE:
      if (p.dst === ADDR.APP) return { label: `0x02 · write reply ${regText}`, details: `acknowledgement data: ${bytesToHex(data)}` };
      return {
        label: `0x02 · write ${regText}`,
        details: data.length >= 2 ? `${u16le(data)}` : bytesToHex(data),
      };
    case CMD.WRITE_RESP:
      return { label: '0x05 · write acknowledged', details: arg === 0 ? 'success' : `error code ${arg}` };
    case CMD.WRITE_NORESP:
      return { label: `0x03 · write ${regText}`, details: bytesToHex(data) };
    case CMD.REBOOT:
      return { label: '0x0A · reboot', details: '' };
    case CMD.HEAD_INPUTS:
    case CMD.HEAD_INPUTS_NOANS:
      return { label: cmd === 0x64 ? '0x64 · telemetry' : '0x65 · telemetry', details: `${data.length} bytes` };
    case 0x79:
      return { label: '0x79 · power off', details: '' };
    case 0x78:
      return { label: '0x78 · ESC reboot', details: '' };
    default:
      return {
        label: `0x${cmd.toString(16).padStart(2, '0').toUpperCase()} · command`,
        details: data.length ? bytesToHex(data) : '',
      };
  }
}
