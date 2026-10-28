import { bytesToHex } from './protocol.js';

export function visibleLogEntry(entry, detailed = false) {
  if (detailed) return true;
  if (entry.kind === 'out' || entry.kind === 'in') return false;
  if (entry.kind === 'transport' && /^GATT (TX|RX)/.test(entry.text || '')) return false;
  return !entry.debug;
}

export function redactLogText(text = '', sensitiveValues = []) {
  let result = String(text);
  if (/^(AES key: Bluetooth name|AES-ключ: имя Bluetooth)/.test(result)) return 'AES: Bluetooth name selected';
  if (/^(Serial number:|Серийный номер:)/.test(result)) return 'Serial number received';
  if (/^(Scooter selected:|Выбран самокат:)/.test(result)) return 'Scooter selected';
  if (/^(Remembered scooter found:|Сохранённый самокат доступен:)/.test(result)) return 'Remembered scooter found; select it to renew browser access';
  result = result.replace(/\bserial=\S*/gi, 'serial=[redacted]');
  const values = [...new Set(sensitiveValues.filter(v => typeof v === 'string' && v.length))]
    .sort((a, b) => b.length - a.length);
  for (const value of values) result = result.split(value).join('[redacted]');
  return result
    .replace(/\b\d{5}\/\d{8}\b/g, '[serial redacted]')
    .replace(/\b[0-9a-f]{32,}\b/gi, '[data redacted]')
    .replace(/\b(?:[0-9a-f]{2}[ :\-]){15,}[0-9a-f]{2}\b/gi, '[data redacted]');
}

export function formatLog(entries, { detailed = false, encrypted = false, time = (date) => date.toISOString() } = {}) {
  const lines = [];
  for (const e of entries) {
    if (!visibleLogEntry(e, detailed)) continue;
    const stamp = time(e.time);
    if (e.kind === 'in' || e.kind === 'out') {
      lines.push(`[${stamp}] ${e.kind === 'out' ? '→' : '←'} ${e.label || 'frame'}`);
      if (e.plain?.length) lines.push(`  ${bytesToHex(e.plain)}`);
      if (encrypted && e.encrypted?.length) lines.push(`  enc: ${bytesToHex(e.encrypted)}`);
      const note = [e.details, e.note].filter(Boolean).join(' · ');
      if (note) lines.push(`  ${note}`);
    } else lines.push(`[${stamp}] ${detailed ? e.text || '' : e.publicText ?? redactLogText(e.text)}`);
  }
  return lines.join('\n');
}
