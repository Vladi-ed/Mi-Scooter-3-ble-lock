// Local to this browser/origin. Store only a successfully confirmed app key;
// BLE random, derived session key and counters must be fresh on each connection.
export class PairingStore {
  constructor(storage) { this.storage = storage; }
  key(serial) { return `mi3ble.pairing.v1.${encodeURIComponent(serial)}`; }
  load(serial, name) {
    try {
      const r = JSON.parse(this.storage.getItem(this.key(serial)));
      if (r?.version !== 1 || r.serial !== serial || r.name !== name ||
          typeof r.appRandom !== 'string' || !/^[0-9a-f]{32}$/.test(r.appRandom)) return null;
      return Uint8Array.from(r.appRandom.match(/../g), (v) => parseInt(v, 16));
    } catch { return null; }
  }
  save(serial, name, bytes) {
    if (!serial || !(bytes instanceof Uint8Array) || bytes.length !== 16) return false;
    try {
      this.storage.setItem(this.key(serial), JSON.stringify({ version: 1, serial, name,
        appRandom: Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join('') }));
      return true;
    } catch { return false; }
  }
  remove(serial) {
    try { this.storage.removeItem(this.key(serial)); } catch { /* unavailable storage */ }
  }
}
