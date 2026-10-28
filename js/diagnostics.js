import { REG, bytesToHex, u16le, versionToString } from './protocol.js';

export const KERS_NAMES = ['Слабая', 'Средняя', 'Сильная'];
export const DIAGNOSTIC_FIELDS = [
  { id: 'drv', label: 'Версия DRV', reg: REG.FW_VERSION, size: 2, decode: b => versionToString(u16le(b)) },
  { id: 'ble', label: 'Версия BLE', reg: 0x68, size: 2, decode: b => versionToString(u16le(b)) },
  { id: 'odometer', label: 'Общий пробег', reg: REG.ODOMETER, size: 4,
    decode: b => `${(new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, true) / 1000).toFixed(2)} км` },
  { id: 'voltage', label: 'Напряжение', reg: REG.VOLTAGE, size: 2, decode: b => `${(u16le(b) / 100).toFixed(2)} В` },
  { id: 'temperature', label: 'Температура контроллера', reg: REG.FRAME_TEMP, size: 2, decode: b => `${(u16le(b) / 10).toFixed(1)} °C` },
  { id: 'error', label: 'Код ошибки', reg: REG.ERROR, size: 2, decode: b => String(u16le(b)) },
  { id: 'warning', label: 'Код предупреждения', reg: REG.WARNING, size: 2, decode: b => String(u16le(b)) },
  { id: 'flags', label: 'Флаги состояния', reg: REG.STATUS, size: 2, decode: b => `0x${u16le(b).toString(16).padStart(4, '0')}` },
  { id: 'kers', label: 'Рекуперация KERS', reg: REG.KERS, size: 2,
    decode: b => KERS_NAMES[u16le(b)] ?? `Неизвестный уровень ${u16le(b)}` },
];

// Explicit allowlist: never include device id/name/serial, keys or raw traffic.
export function diagnosticReport(diagnostics, version, transport) {
  return JSON.stringify({ appVersion: version, protocol: diagnostics.protocol,
    capturedAt: diagnostics.capturedAt, transport: { gattWrite: transport.gattWrite,
      frames: transport.frames, gapMs: transport.gapMs },
    fields: diagnostics.fields.map(({ id, label, reg, state, value, raw, code }) =>
      ({ id, label, register: `0x${reg.toString(16)}`, state, value, raw, code })),
  }, null, 2);
}

export function decodedDiagnostic(field, bytes) {
  return { id: field.id, label: field.label, reg: field.reg, state: 'ok',
    value: field.decode(bytes), raw: bytesToHex(bytes) };
}
