/*
 * Web Bluetooth transport for Ninebot/Xiaomi scooters.
 *
 * The scooter exposes the Nordic UART service (NUS):
 *   RX 6e400002-...  write
 *   TX 6e400003-...  notify
 * Some boards use the older FFE0/FFE1 pair instead.
 *
 * iOS/Bluefy notes:
 *  - split long frames into 20-byte chunks by default;
 *  - choose a write method supported by the characteristic;
 *  - notifications can also arrive in chunks, so frames are reassembled
 *    from the 5A A5 LEN header.
 */

import {
  NUS_SERVICE,
  NUS_RX,
  NUS_TX,
  FFE0_SERVICE,
  FFE1_CHAR,
  delay,
  bytesToHex,
} from './protocol.js';

export function isWebBluetoothSupported() {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

/**
 * Open the Web Bluetooth chooser.
 *
 * `allDevices: false` uses an exact-name filter for the remembered scooter,
 * which keeps the chooser to one entry. If the name is empty (first run), it
 * falls back to a short list of NUS/Mi devices.
 */
export async function requestScooterDevice({ allDevices = true, name = '' } = {}) {
  if (!isWebBluetoothSupported()) {
    throw new Error('Web Bluetooth is not supported by this browser');
  }
  const optionalServices = [NUS_SERVICE, FFE0_SERVICE];

  if (allDevices) {
    return navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices });
  }

  const trimmed = String(name || '').trim();
  const filters = trimmed
    ? [{ name: trimmed }]
    : [
        { services: [NUS_SERVICE] },
        { namePrefix: 'Mi Scooter' },
        { namePrefix: 'MIScooter' },
        { namePrefix: 'NBSc' },
      ];

  try {
    return await navigator.bluetooth.requestDevice({ filters, optionalServices });
  } catch (error) {
    // Some older Web Bluetooth implementations reject `filters`; only then
    // fall back to the full chooser. A user cancellation (NotFoundError) must
    // not reopen the chooser.
    if (error?.name === 'TypeError') {
      return navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices });
    }
    throw error;
  }
}

/**
 * Devices for which this origin already has permission. Supported by Chrome
 * and some Web Bluetooth browsers; Bluefy may return an empty list or not
 * implement getDevices at all. Never throws.
 */
export async function getKnownBluetoothDevices() {
  if (!isWebBluetoothSupported() || typeof navigator.bluetooth.getDevices !== 'function') {
    return [];
  }
  try {
    return await navigator.bluetooth.getDevices();
  } catch {
    return [];
  }
}

export function matchKnownDevice(devices, name, id) {
  if (!Array.isArray(devices) || devices.length === 0) return null;
  const wantedName = String(name || '').trim();
  const wantedId = String(id || '').trim();
  return (
    devices.find(
      (device) =>
        (wantedId && device.id === wantedId) ||
        (wantedName && device.name === wantedName),
    ) || null
  );
}

const SERVICE_CANDIDATES = [
  { name: 'Nordic UART (NUS)', service: NUS_SERVICE, rx: NUS_RX, tx: NUS_TX },
  { name: 'FFE0/FFE1', service: FFE0_SERVICE, rx: FFE1_CHAR, tx: FFE1_CHAR },
];

export class BleTransport {
  constructor({
    cryptoMode = true,
    writeMode = 'auto',
    writeMethodPreference = 'auto',
    gapMs = 0,
    onLog = () => {},
  } = {}) {
    this.cryptoMode = cryptoMode;
    this.writeMode = writeMode;
    this.writeMethodPreference = writeMethodPreference;
    this.gapMs = gapMs;
    this.onLog = onLog;

    this.connection = null;
    this.device = null;
    this.server = null;
    this.service = null;
    this.rx = null;
    this.tx = null;
    this.writeMethod = null;
    this.buffer = new Uint8Array(0);
    this.frameHandlers = new Set();
    this.disconnectHandlers = new Set();
    this.disconnectNotified = false;
    this.writeChain = Promise.resolve();
    this.connected = false;
    this.info = null;
    this.chunkNoticeShown = false;
  }

  log(message, extra = {}) {
    this.onLog({ kind: 'transport', text: message, ...extra });
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
        console.error('frame handler failed', error);
      }
    }
  }

  emitDisconnect() {
    if (this.disconnectNotified) return;
    this.disconnectNotified = true;
    this.connected = false;
    for (const handler of this.disconnectHandlers) {
      try {
        handler();
      } catch (error) {
        console.error('disconnect handler failed', error);
      }
    }
  }

  assertConnection(connection) {
    if (!connection || connection !== this.connection || connection.cancelled) {
      throw new Error('BLE connection closed');
    }
  }

  async duringConnection(connection, operation) {
    this.assertConnection(connection);
    const result = await Promise.race([operation, connection.closed]);
    this.assertConnection(connection);
    return result;
  }

  resetConnectionState() {
    this.connected = false;
    this.device = this.server = this.service = this.rx = this.tx = null;
    this.info = this.writeMethod = null;
    this.hasWith = this.hasWithout = false;
    this.buffer = new Uint8Array(0);
    this.writeChain = Promise.resolve();
    this.chunkNoticeShown = false;
  }

  async connect(device) {
    // Keep replacement atomic until the new context is installed. Awaiting
    // synchronous cleanup here would let another connect() be overwritten.
    if (this.connection) this.disconnect();
    this.resetConnectionState();
    let rejectClosed;
    const connection = { device, cancelled: false, tx: null,
      closed: new Promise((_, reject) => { rejectClosed = reject; }) };
    connection.closed.catch(() => {});
    connection.cancel = () => rejectClosed(new Error('BLE connection closed'));
    connection.onDisconnect = () => {
      if (this.connection !== connection) return;
      this.log('GATT: disconnected');
      this.disconnect();
    };
    connection.onNotification = (event) => {
      if (this.connection === connection && !connection.cancelled) this.handleNotification(event);
    };
    this.connection = connection;
    this.device = device;
    this.disconnectNotified = false;
    device.addEventListener('gattserverdisconnected', connection.onDisconnect);

    try {
      const connecting = device.gatt.connect().then((server) => {
        // Some native bridges finish connecting even after disconnect(). Close
        // that orphan, unless a newer context now owns the same GATT device.
        if (connection.cancelled && this.connection?.device !== device) {
          try { server?.disconnect(); } catch { /* already disconnected */ }
        }
        return server;
      });
      const server = await this.duringConnection(connection, connecting);
      this.assertConnection(connection);
      this.server = server;
      if (!this.server) throw new Error('Could not connect to GATT server');

      let lastError = null;
      for (const candidate of SERVICE_CANDIDATES) {
        try {
          const service = await this.duringConnection(connection, this.server.getPrimaryService(candidate.service));
          const rx = await this.duringConnection(connection, service.getCharacteristic(candidate.rx));
          const tx = await this.duringConnection(connection, service.getCharacteristic(candidate.tx));
          this.assertConnection(connection);
          this.service = service;
          this.rx = rx;
          this.tx = connection.tx = tx;
          this.info = { ...candidate, service };
          this.log(`Service found: ${candidate.name}`);
          break;
        } catch (error) {
          this.assertConnection(connection);
          lastError = error;
        }
      }

      if (!this.rx || !this.tx) {
        const available = await this.duringConnection(connection, this.describeServices());
        const reason = lastError ? ' (' + lastError.message + ')' : '';
        throw new Error(
          `NUS service (6E400001...) not found. ${available}${reason}`,
        );
      }

      this.tx.addEventListener('characteristicvaluechanged', connection.onNotification);
      await this.duringConnection(connection, this.tx.startNotifications());
      this.assertConnection(connection);
      this.writeMethod = this.pickWriteMethod();
      this.connected = true;
      // Give iOS/Bluefy a moment to finish the notification setup before the
      // first GATT write; otherwise the first 0x5B can be dropped.
      await this.duringConnection(connection, delay(120));
      this.assertConnection(connection);
      this.log(`Notifications enabled · write mode: ${this.writeMethodLabel()}`);
      this.log(`GATT: frames=${this.writeMode}, gap=${this.gapMs} ms; write=${this.rx.properties?.write ?? '?'}, writeWithoutResponse=${this.rx.properties?.writeWithoutResponse ?? '?'}`);
    } catch (error) {
      if (this.connection === connection) this.disconnect();
      throw error;
    }
  }

  async describeServices() {
    try {
      if (!this.server || typeof this.server.getPrimaryServices !== 'function') return '';
      const services = await this.server.getPrimaryServices();
      const uuids = services.map((service) => service.uuid).filter(Boolean);
      return uuids.length ? `Available services: ${uuids.join(', ')}.` : '';
    } catch {
      return '';
    }
  }

  pickWriteMethod() {
    const characteristic = this.rx;
    const properties = characteristic.properties || {};
    const hasWith = typeof characteristic.writeValueWithResponse === 'function' && properties.write !== false;
    const hasWithout = typeof characteristic.writeValueWithoutResponse === 'function' && properties.writeWithoutResponse !== false;
    this.hasWith = hasWith;
    this.hasWithout = hasWithout;
    const preference = this.writeMethodPreference;

    if (preference === 'with' || preference === 'without') {
      if (preference === 'with' && hasWith) return 'with';
      if (preference === 'without' && hasWithout) return 'without';
      throw new Error(`Selected GATT write mode (${preference === 'with' ? 'with response' : 'without response'}) is unavailable. Select Auto.`);
    }

    // SHU Web uses acknowledged writes for both the hello and key chunks.
    if (hasWith) return 'with';
    if (hasWithout) return 'without';
    if (typeof characteristic.writeValue === 'function') return 'legacy';
    throw new Error('Characteristic does not support writes');
  }

  methodForFrame(frame) {
    const preference = this.writeMethodPreference;
    if (preference === 'with') return this.hasWith ? 'with' : this.writeMethod;
    if (preference === 'without') return this.hasWithout ? 'without' : this.writeMethod;
    if (this.hasWith) return 'with';
    return this.writeMethod;
  }

  writeMethodLabel() {
    if (this.writeMethodPreference === 'auto') {
      if (this.hasWith) return 'auto: with response for all chunks';
    }
    if (this.writeMethod === 'with') return 'with response';
    if (this.writeMethod === 'without') return 'without response';
    return 'legacy writeValue';
  }

  async invokeWrite(method, chunk) {
    // A subarray still exposes the whole frame via .buffer. Supply a fresh,
    // exact-size ArrayBuffer so native bridges cannot serialize bytes outside
    // this chunk even if they ignore a typed view's byteOffset/byteLength.
    const payload = Uint8Array.from(chunk).buffer;
    this.log(`GATT TX call: ${payload.byteLength} bytes · ${method} · ArrayBuffer=${payload.byteLength} · ${bytesToHex(new Uint8Array(payload))}`);
    if (method === 'with') return this.rx.writeValueWithResponse(payload);
    if (method === 'without') return this.rx.writeValueWithoutResponse(payload);
    return this.rx.writeValue(payload);
  }

  async writeChunk(chunk, method = this.writeMethod, connection = this.connection) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      this.assertConnection(connection);
      if (!this.connected || !this.rx) throw new Error('Scooter is not connected');
      try {
        await this.duringConnection(connection, this.invokeWrite(method, chunk));
        this.log(`GATT TX completed: ${chunk.length} bytes · ${method}`);
        return method;
      } catch (error) {
        this.assertConnection(connection);
        lastError = error;
        const text = error?.message || error?.name || String(error);
        if (/in progress|busy/i.test(text) && attempt < 2) {
          await this.duringConnection(connection, delay(80));
          continue;
        }
        if (error?.name === 'NotSupportedError' && this.writeMethodPreference === 'auto' && method !== 'without' && this.hasWithout) {
          // Some Bluefy builds expose only writeValueWithoutResponse.
          method = 'without';
          this.writeMethod = 'without';
          this.hasWith = false;
          this.log('GATT: acknowledged writes unavailable; switching to writes without response');
          continue;
        }
        throw gattError(error);
      }
    }
    throw gattError(lastError);
  }

  async writeWhole(frame, method = this.writeMethod, connection = this.connection) {
    await this.writeChunk(frame, method, connection);
  }

  async writeChunks(frame, size = 20, method = this.writeMethod, connection = this.connection) {
    let activeMethod = method;
    for (let offset = 0; offset < frame.length; offset += size) {
      const chunk = frame.subarray(offset, Math.min(offset + size, frame.length));
      activeMethod = await this.writeChunk(chunk, activeMethod, connection);
      if (offset + size < frame.length && this.gapMs > 0) await this.duringConnection(connection, delay(this.gapMs));
    }
  }

  /**
   * Write a frame. Returns { method, chunks }.
   */
  async write(frame) {
    if (!this.connected || !this.rx) throw new Error('Scooter is not connected');
    const connection = this.connection;
    const task = this.writeChain.then(() => this.writeNow(frame, connection));
    this.writeChain = task.catch(() => {});
    return task;
  }

  async writeNow(frame, connection = this.connection) {
    this.assertConnection(connection);
    if (!this.connected || !this.rx) throw new Error('Scooter is not connected');
    const method = this.methodForFrame(frame);
    const chunked = frame.length > 20 && this.writeMode !== 'whole';
    const sizes = chunked
      ? Array.from({ length: Math.ceil(frame.length / 20) }, (_, i) => Math.min(20, frame.length - i * 20))
      : [frame.length];
    this.log(`GATT TX: ${frame.length} bytes · ${method} · chunks ${sizes.join('+')}`);

    if (frame.length <= 20) {
      await this.writeChunk(frame, method, connection);
      return { method: 'single', chunks: 1 };
    }

    if (this.writeMode === 'chunk20') {
      await this.writeChunks(frame, 20, method, connection);
      return { method: 'chunks', chunks: Math.ceil(frame.length / 20) };
    }

    if (this.writeMode === 'whole') {
      await this.writeWhole(frame, method, connection);
      return { method: 'whole', chunks: 1 };
    }

    // Auto mode. A frame longer than the default ATT payload (20 bytes)
    // triggers a "long write" (prepare/execute) on iOS. The Mi 3 BLE stack
    // disconnects on that, so split long frames into 20-byte writes by
    // default. Short frames (0x5B, 0x70/0x71) still go in one piece.
    if (!this.chunkNoticeShown) {
      this.chunkNoticeShown = true;
      this.log(
        `Long frames use 20-byte chunks (first: ${frame.length} bytes, ${method === 'without' ? 'without response' : 'with response'})`,
      );
    }
    await this.writeChunks(frame, 20, method, connection);
    return { method: 'chunks', chunks: Math.ceil(frame.length / 20) };
  }

  handleNotification = (event) => {
    const value = event.target.value;
    if (!value) return;
    let bytes;
    if (value instanceof ArrayBuffer) {
      bytes = new Uint8Array(value);
    } else {
      bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (bytes.length === 0) return;
    this.log(`GATT RX: ${bytes.length} bytes · ${bytesToHex(bytes)}`);
    this.buffer = concat(this.buffer, bytes);
    this.drainBuffer();
  };

  drainBuffer() {
    let guard = 0;
    while (this.buffer.length >= 3) {
      if (this.buffer[0] !== 0x5a || this.buffer[1] !== 0xa5) {
        this.buffer = this.buffer.subarray(1);
        continue;
      }
      const len = this.buffer[2];
      const total = len + (this.cryptoMode ? 13 : 9);
      if (total > 512) {
        this.log(`Invalid frame length LEN=${len}; discarding one byte`);
        this.buffer = this.buffer.subarray(1);
        continue;
      }
      if (this.buffer.length < total) break;
      const frame = this.buffer.slice(0, total);
      this.buffer = this.buffer.subarray(total);
      this.emitFrame(frame);
      guard++;
      if (guard > 100) break;
    }
    if (this.buffer.length > 1024) {
      this.log('Notification buffer overflow; resetting');
      this.buffer = new Uint8Array(0);
    }
  }

  disconnect() {
    const connection = this.connection;
    if (!connection) return;
    // Invalidate before touching GATT: native callbacks may run immediately.
    this.connection = null;
    connection.cancelled = true;
    connection.cancel();
    connection.device.removeEventListener('gattserverdisconnected', connection.onDisconnect);
    if (connection.tx) {
      connection.tx.removeEventListener('characteristicvaluechanged', connection.onNotification);
    }
    this.resetConnectionState();
    try {
      // Do not await stopNotifications: native promises may remain pending,
      // and late completion could affect a new subscription on this device.
      connection.device.gatt?.disconnect();
    } catch {
      // Native disconnection may already have completed.
    }
    this.emitDisconnect();
  }
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function gattError(error) {
  if (error instanceof Error && error.message) return error;
  const name = error?.name || 'GattError';
  const detail = error?.message || (typeof error === 'string' ? error : '');
  const wrapped = new Error(detail ? `${name}: ${detail}` : name);
  wrapped.name = name;
  return wrapped;
}
