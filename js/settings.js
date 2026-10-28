export const SETTINGS_KEY = 'mi3ble.settings.v1';

export const DEFAULTS = Object.freeze({
  protocol: 'aes',
  gattWrite: 'auto',
  writeMode: 'auto',
  gapMs: 0,
  transportProfile: 2,
  cryptoName: '',
  lastDeviceName: '',
  lastDeviceId: '',
  showEncrypted: false,
  detailedLog: false,
});

export function normalizeSettings(value) {
  const restored = { ...DEFAULTS };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return restored;
  for (const field of ['cryptoName', 'lastDeviceName', 'lastDeviceId']) {
    if (typeof value[field] === 'string') restored[field] = value[field].trim();
  }
  for (const field of ['showEncrypted', 'detailedLog']) {
    if (typeof value[field] === 'boolean') restored[field] = value[field];
  }
  if (['aes', 'plain'].includes(value.protocol)) restored.protocol = value.protocol;
  // Migrate the transport profile once; preserve deliberate settings afterwards.
  if (value.transportProfile === DEFAULTS.transportProfile) {
    if (['auto', 'with', 'without'].includes(value.gattWrite)) restored.gattWrite = value.gattWrite;
    if (['auto', 'whole', 'chunk20'].includes(value.writeMode)) restored.writeMode = value.writeMode;
    if (typeof value.gapMs === 'number' && Number.isFinite(value.gapMs)) {
      restored.gapMs = Math.round(Math.max(0, Math.min(200, value.gapMs)));
    }
  }
  return restored;
}

export function loadSettings(storage) {
  try {
    return normalizeSettings(JSON.parse(storage.getItem(SETTINGS_KEY)));
  } catch {
    return { ...DEFAULTS };
  }
}
