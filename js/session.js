/*
 * High-level scooter session: pairing state machine, lock/unlock, status reads.
 * Transport-agnostic: works with BleTransport and with the demo MockTransport.
 */

import { NinebotCrypto, NinebotCryptoError } from './crypto.js';
import { OperationQueue } from './operation-queue.js';
import { DIAGNOSTIC_FIELDS, decodedDiagnostic } from './diagnostics.js';
import {
  ADDR,
  CMD,
  REG,
  STATUS_LOCK_MASK,
  buildFrame,
  describeFrame,
  randomBytes,
  delay,
  cleanAscii,
  u16le,
  versionToString,
} from './protocol.js';

export class SessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SessionError';
    this.code = code;
  }
}

export class ScooterSession {
  constructor(transport, options = {}) {
    this.transport = transport;
    this.name = options.name || 'Mi Scooter 3';
    this.protocol = options.protocol === 'plain' ? 'plain' : 'aes';
    this.onLog = options.onLog || (() => {});
    this.onProgress = options.onProgress || (() => {});
    this.intervalMs = options.intervalMs ?? 500;
    this.buttonTimeoutMs = options.buttonTimeoutMs ?? 120000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 3000;
    this.pairingStore = options.pairingStore || null;
    this.resumeTimeoutMs = options.resumeTimeoutMs ?? 1800;
    this.resuming = false;
    this.deferHelloTimeout = options.deferHelloTimeout ?? false;
    this.legacyWriteAckAllowed = true;
    this.operations = new OperationQueue();
    this.requests = new OperationQueue();
    this.timedOutRequests = new Set();
    this.diagnostics = null;
    this.kers = null;

    this.crypto = this.protocol === 'aes' ? new NinebotCrypto(this.name) : null;
    this.waiters = [];
    this.paired = false;
    this.locked = null;
    this.serial = '';
    this.serialBytes = new Uint8Array(0);
    this.status = {};
    this.stopped = false;
    this.buttonConfirmed = false;
    this.bindConfirmed = false;
    this.stop5C = null;
    this.keyAttempts = 0;
    this.errorEmitted = false;
    this.lastCommand = '';

    this.unsubscribeFrame = this.transport.onFrame((frame) => this.handleFrame(frame));
    this.unsubscribeDisconnect = this.transport.onDisconnect(() => this.handleDisconnect());
  }

  log(entry) {
    try {
      this.onLog(entry);
    } catch (error) {
      console.error('log handler failed', error);
    }
  }

  progress(phase, data = {}) {
    try {
      this.onProgress(phase, data);
    } catch (error) {
      console.error('progress handler failed', error);
    }
  }

  info(text) {
    this.log({ kind: 'info', text });
  }

  error(text) {
    this.log({ kind: 'error', text });
  }

  async start() {
    this.stopped = false;
    this.errorEmitted = false;

    if (this.protocol === 'plain') {
      this.paired = true;
      this.progress('paired', { plain: true });
      return;
    }

    this.progress('handshake');
    this.info(`AES key: Bluetooth name «${this.name}»`);

    try {
      const reply = await this.request(
        { cmd: CMD.PAIR_START, dst: ADDR.BLE, arg: 0, data: new Uint8Array(0) },
        (frame) => frame[3] === ADDR.BLE && frame[5] === CMD.PAIR_START,
        4000,
        '0x5B',
      );

      if (!this.serialBytes || this.serialBytes.length !== 14) {
        throw new SessionError(
          'SERIAL',
          'Hello received, but the serial number is invalid. Check the Bluetooth name used for AES.',
        );
      }

      this.serial = cleanAscii(this.serialBytes).trim();
      const saved = this.pairingStore?.load(this.serial, this.name);
      if (saved) {
        await this.resumePairing(saved);
        this.paired = true;
        this.progress('paired', { serial: this.serial, resumed: true });
        return;
      }
      const alreadyPaired = reply[6] === 1;
      this.info(
        `Serial number: ${this.serial}${alreadyPaired ? ' · previous pairing flag (0x5B 01); continuing key exchange' : ''}`,
      );

      await this.waitForButton({ serial: this.serial, alreadyPaired });

      this.progress('bind');
      await this.bind();

      if (this.pairingStore && !this.pairingStore.save(this.serial, this.name, this.crypto.randomAppData)) {
        this.info('Browser could not save pairing; the next connection may require the power button');
      }

      this.paired = true;
      this.progress('paired', { serial: this.serial });
    } catch (error) {
      if (this.deferHelloTimeout && error.code === 'TIMEOUT' && this.lastCommand === '0x5B') {
        throw new SessionError('HELLO_TIMEOUT', 'No hello response; retrying on a fresh BLE connection');
      }
      if (error.code === 'PAIRING_EXPIRED') throw error;
      this.abort(error);
      throw error;
    }
  }

  async resumePairing(appRandom) {
    this.info('Connecting with saved pairing');
    this.resuming = true;
    this.crypto.randomAppData = appRandom.slice();
    this.crypto.calcKey(appRandom, this.crypto.randomBleData);
    try {
      const reply = await this.request(
        { cmd: CMD.PAIR_BIND, dst: ADDR.BLE, arg: 0, data: this.serialBytes },
        (f) => f[3] === ADDR.BLE && f[4] === ADDR.APP && f[5] === CMD.PAIR_BIND,
        this.resumeTimeoutMs, 'saved pairing',
      );
      if (reply[6] !== 1) throw new SessionError('REJECTED', 'Pairing rejected');
      this.crypto.cryptoReady = true;
      this.info('Saved pairing confirmed; no power-button press required');
    } catch (error) {
      if (error.code === 'DISCONNECTED' || error.code === 'CANCELLED' || error.code === 'TRANSPORT') throw error;
      this.pairingStore?.remove(this.serial);
      throw new SessionError('PAIRING_EXPIRED', 'Saved pairing was not accepted; reconnecting for power-button confirmation');
    } finally { this.resuming = false; }
  }

  addWaiter(predicate, timeoutMs, label) {
    const waiter = {
      predicate,
      label,
      timer: null,
      resolve: null,
      reject: null,
    };
    waiter.promise = new Promise((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
    });
    waiter.timer = setTimeout(() => {
      this.removeWaiter(waiter);
      waiter.reject(new SessionError('TIMEOUT', `No response to ${label} (${timeoutMs} ms)`));
    }, timeoutMs);
    this.waiters.push(waiter);
    return waiter;
  }

  removeWaiter(waiter) {
    if (waiter.timer) clearTimeout(waiter.timer);
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
  }

  rejectAll(error) {
    for (const waiter of [...this.waiters]) {
      this.removeWaiter(waiter);
      waiter.reject(error);
    }
  }

  resolveWaiters(frame) {
    for (const waiter of [...this.waiters]) {
      let matched = false;
      try {
        matched = waiter.predicate(frame);
      } catch (error) {
        this.error(`Reply matching failed: ${error.message}`);
      }
      if (matched) {
        this.removeWaiter(waiter);
        waiter.resolve(frame);
      }
    }
  }

  async request(params, predicate, timeoutMs, label) {
    return this.requests.run(() => this.requestNow(params, predicate, timeoutMs, label));
  }

  async requestNow(params, predicate, timeoutMs, label) {
    if (this.stopped) throw new SessionError('CANCELLED', 'Session stopped');
    const signature = `${params.dst}:${params.cmd}:${params.arg ?? 0}`;
    const readbackWrite = params.cmd === CMD.WRITE && params.arg === REG.KERS && params.verifyByReadback === true;
    if (this.timedOutRequests.has(signature) && !readbackWrite) {
      throw new SessionError('RECONNECT', 'Previous request timed out; reconnect before reading this register again');
    }
    const waiter = this.addWaiter(predicate, timeoutMs, label);
    let sent = false, deadline;
    const timeout = new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new SessionError('TIMEOUT', `No response to ${label} (${timeoutMs} ms)`)), timeoutMs);
    });
    try {
      const write = (async () => {
        await this.sendFrame(params);
        sent = true;
        // Bounded idempotent retries share one waiter and deadline. Never retry writes.
        if (params.cmd === CMD.READ) {
          for (let attempt = 2; attempt <= 3; attempt++) {
            const received = await Promise.race([waiter.promise.then(() => true), delay(700).then(() => false)]);
            if (received || this.stopped) return;
            this.info(`Read retry ${attempt}/3: ${label}`);
            sent = false;
            await this.sendFrame(params);
            sent = true;
          }
        }
      })();
      const [, reply] = await Promise.race([Promise.all([write, waiter.promise]), timeout]);
      return reply;
    } catch (error) {
      if (error.code === 'TRANSPORT') this.abort(error);
      if (error.code === 'TIMEOUT') {
        // Late replies have no transaction id. Never let one satisfy another
        // request for the same register. KERS has a readback-only recovery path.
        this.timedOutRequests.add(signature);
        if (sent && readbackWrite) {
          // A missing ACK is not a rejected write. Keep the session usable for
          // a different, correlated READ. Never resend the write automatically.
          // Generic legacy ACKs have no register: ignore them from now on.
          this.legacyWriteAckAllowed = false;
        } else if (!sent || params.cmd === CMD.WRITE) this.abort(error);
      }
      throw error;
    } finally {
      clearTimeout(deadline);
      this.removeWaiter(waiter);
    }
  }

  async sendFrame(params) {
    const plain = buildFrame({
      src: ADDR.APP,
      dst: params.dst,
      cmd: params.cmd,
      arg: params.arg ?? 0,
      data: params.data ?? new Uint8Array(0),
      checksum: !this.crypto,
    });
    await this.sendPlain(plain, params.note);
    return plain;
  }

  async sendPlain(plain, note = '') {
    if (this.stopped) throw new SessionError('CANCELLED', 'Session stopped');
    this.lastCommand = `0x${plain[5].toString(16).toUpperCase().padStart(2, '0')}`;
    let encrypted = null;
    if (this.crypto) {
      encrypted = this.crypto.encrypt(plain);
    }
    const description = describeFrame(plain);
    this.log({
      kind: 'out',
      plain,
      encrypted,
      label: description.label,
      details: description.details,
      note,
    });
    try {
      await this.transport.write(encrypted || plain);
    } catch (error) {
      const reason = error?.message || error?.name || String(error);
      throw new SessionError('TRANSPORT', `Frame write failed: ${reason}`);
    }
  }

  handleFrame(encryptedFrame) {
    if (this.stopped) return;

    let plain;
    if (this.crypto) {
      try {
        plain = this.crypto.decrypt(encryptedFrame);
      } catch (error) {
        // An expired saved key may produce undecipherable replies. Let the
        // bounded resume request fail, then restart on a fresh GATT session.
        if (this.resuming) return;
        this.error(error.message);
        if (!this.paired) {
          const wrapped =
            error instanceof NinebotCryptoError
              ? new SessionError('CRYPTO', error.message)
              : new SessionError('CRYPTO', error.message);
          this.abort(wrapped);
        }
        return;
      }
    } else {
      plain = encryptedFrame;
    }

    const description = describeFrame(plain);
    this.log({
      kind: 'in',
      plain,
      encrypted: this.crypto ? encryptedFrame : null,
      label: description.label,
      details: description.details,
    });

    if (plain[3] === ADDR.BLE && plain[5] === CMD.PAIR_START && plain[2] === 0x1e) {
      this.serialBytes = plain.slice(7 + 16, 7 + 30);
      this.serial = cleanAscii(this.serialBytes).trim();
    }

    if (plain[3] === ADDR.BLE && plain[5] === CMD.PAIR_KEY && plain[6] === 0x01) {
      this.buttonConfirmed = true;
      if (this.stop5C) this.stop5C();
      this.info('Power button confirmed; scooter accepted the key');
    }

    if (plain[3] === ADDR.BLE && plain[5] === CMD.PAIR_KEY && plain[6] === 0x00 && this.stop5C) {
      // SHU stops proposing the same random once it is acknowledged, while
      // continuing to wait for the separate power-button confirmation.
      this.stop5C();
      this.info('Key accepted (0x5C 00); retries stopped, waiting for the power button');
      this.progress('button', { serial: this.serial });
    }

    if (plain[3] === ADDR.BLE && plain[5] === CMD.PAIR_BIND && plain[6] === 0x01) {
      this.bindConfirmed = true;
    }

    if (this.legacyWriteAckAllowed && plain[3] === ADDR.ESC && plain[5] === CMD.WRITE_RESP && plain[6] !== 0) {
      this.error(`Scooter rejected write, code ${plain[6]}`);
    }

    this.resolveWaiters(plain);
  }

  async waitForButton({ serial = '', alreadyPaired = false } = {}) {
    this.buttonConfirmed = false;
    this.keyAttempts = 0;
    const random = randomBytes(16);

    const ack = this.addWaiter(
      (frame) => frame[3] === ADDR.BLE && frame[5] === CMD.PAIR_KEY && frame[6] === 0x01,
      this.buttonTimeoutMs,
      '0x5C 01 (power button)',
    );

    let stopped = false;
    let sending = false;
    let timer = null;
    this.stop5C = () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      this.stop5C = null;
    };

    const tick = async () => {
      if (stopped || sending || this.buttonConfirmed) return;
      sending = true;
      this.keyAttempts += 1;
      try {
        await this.sendFrame({
          cmd: CMD.PAIR_KEY,
          dst: ADDR.BLE,
          arg: 0,
          data: random,
          note: this.keyAttempts === 1 ? '' : `retry ${this.keyAttempts}`,
        });
      } catch (error) {
        if (!stopped) this.abort(error);
      } finally {
        sending = false;
      }
    };

    // Send the key as soon as the hello is received, as SHU Web does.
    // Observe the waiter independently of a possibly pending GATT write.
    const begin = async () => {
      if (stopped || this.stopped) return;
      await tick();
      if (stopped || this.stopped || this.buttonConfirmed) return;
      this.progress('button', { serial, alreadyPaired });
      timer = setInterval(tick, this.intervalMs);
    };
    begin().catch((error) => { if (!stopped) this.abort(error); });

    try {
      await ack.promise;
    } finally {
      if (this.stop5C) this.stop5C();
    }
  }

  async bind() {
    const serial = this.serialBytes;
    if (!serial || serial.length !== 14) {
      throw new SessionError('SERIAL', 'No serial number available for 0x5D');
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.request(
          { cmd: CMD.PAIR_BIND, dst: ADDR.BLE, arg: 0, data: serial },
          (frame) => frame[3] === ADDR.BLE && frame[5] === CMD.PAIR_BIND && frame[6] === 1,
          3000,
          `0x5D (attempt ${attempt})`,
        );
        this.info('Pairing confirmed (0x5D 01)');
        return;
      } catch (error) {
        if (error.code === 'DISCONNECTED') throw error;
        this.error(`0x5D, attempt ${attempt}: ${error.message}`);
        if (attempt < 3) await delay(300);
      }
    }

    throw new SessionError(
      'BIND',
      'Pairing confirmation (0x5D) failed. Reconnect and retry.',
    );
  }

  setLock(lock) { return this.operations.run(() => this.setLockNow(lock)); }

  async setLockNow(lock) {
    if (!this.paired) {
      throw new SessionError('NOT_PAIRED', 'Pair with the scooter first');
    }
    const register = lock ? REG.LOCK : REG.UNLOCK;
    const label = lock ? '0x70 · lock' : '0x71 · unlock';

    const reply = await this.request(
      {
        cmd: CMD.WRITE,
        dst: ADDR.ESC,
        arg: register,
        data: Uint8Array.of(0x01, 0x00),
        note: label,
      },
      (frame) => frame[4] === ADDR.APP && (
        (this.legacyWriteAckAllowed && frame[3] === ADDR.ESC && frame[5] === CMD.WRITE_RESP) ||
        (this.crypto && frame[3] === ADDR.MI3_REPLY && frame[5] === CMD.WRITE &&
          frame[6] === register && frame[2] === 1 && frame.length === 8)
      ),
      this.commandTimeoutMs,
      label,
    );

    if (reply[5] === CMD.WRITE_RESP && reply[6] !== 0) {
      throw new SessionError('WRITE', `Scooter rejected command, code ${reply[6]}`);
    }

    if (reply[5] === CMD.WRITE) {
      if (reply[7] !== 1) throw new SessionError('WRITE', `Unknown write acknowledgement: ${reply[7]}`);
      // 0x70 is a command, not persistent state. Firmware resets it to zero.
      // Read NB_INF_BOOL and allow the mechanical/UI state time to settle.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await delay(200);
        try {
          const actual = await this.readLockState();
          if (actual === lock) {
            this.locked = actual;
            this.status.locked = actual;
            this.status.lockConfirmed = true;
            this.info(lock ? 'Scooter locked' : 'Scooter unlocked');
            return true;
          }
        } catch (error) {
          if (error.code === 'DISCONNECTED' || error.code === 'CANCELLED') throw error;
          break;
        }
      }
      this.locked = null;
      this.status.locked = null;
      this.status.lockConfirmed = false;
      this.info('Lock command acknowledged; current state is unconfirmed');
      return true;
    }

    this.locked = lock;
    this.status.locked = lock;
    this.status.lockConfirmed = true;
    this.info(lock ? 'Scooter locked' : 'Scooter unlocked');
    return true;
  }

  async readLockState() {
    const flags = u16le(await this.readRegister(REG.STATUS, 2));
    return (flags & STATUS_LOCK_MASK) !== 0;
  }

  readDiagnostics() { return this.operations.run(() => this.readDiagnosticsNow()); }

  async readDiagnosticsNow() {
    if (!this.paired || this.stopped) throw new SessionError('NOT_PAIRED', 'Connect first');
    this.diagnostics = null;
    this.kers = null;
    const fields = [];
    for (const field of DIAGNOSTIC_FIELDS) {
      try {
        const bytes = await this.readRegister(field.reg, field.size);
        fields.push(decodedDiagnostic(field, bytes));
        if (field.id === 'kers' && u16le(bytes) <= 2) this.kers = u16le(bytes);
      } catch (error) {
        if (this.stopped || ['DISCONNECTED', 'CANCELLED', 'TRANSPORT'].includes(error.code)) throw error;
        fields.push({ id: field.id, label: field.label, reg: field.reg,
          state: 'unavailable', value: error.code === 'RECONNECT' ? 'Переподключитесь для повторного чтения' : 'Нет ответа', code: error.code });
      }
    }
    this.diagnostics = { capturedAt: new Date().toISOString(), protocol: this.protocol, fields };
    this.info(`Diagnostics: ${fields.filter(f => f.state === 'ok').length}/${fields.length} fields read`);
    return this.diagnostics;
  }

  setKers(level) { return this.operations.run(() => this.setKersNow(level)); }

  async setKersNow(level) {
    if (!Number.isInteger(level) || level < 0 || level > 2) throw new SessionError('KERS', 'Valid KERS levels are 0, 1 and 2');
    if (!this.paired || this.stopped) throw new SessionError('NOT_PAIRED', 'Connect first');
    // Discover support before writing. Unknown values never become a default.
    const before = u16le(await this.readRegister(REG.KERS, 2));
    if (before > 2) { this.kers = null; throw new SessionError('KERS', `Unknown KERS level: ${before}`); }
    this.kers = before;
    if (before === level) return { confirmed: true, level };
    this.kers = null;
    let acknowledged = false;
    try {
      const reply = await this.request(
      { cmd: CMD.WRITE, dst: ADDR.ESC, arg: REG.KERS, data: Uint8Array.of(level, 0), verifyByReadback: true },
      f => f[4] === ADDR.APP && ((this.legacyWriteAckAllowed && f[3] === ADDR.ESC && f[5] === CMD.WRITE_RESP) ||
        (this.crypto && f[3] === ADDR.MI3_REPLY && f[5] === CMD.WRITE && f[6] === REG.KERS && f[2] === 1)),
      this.commandTimeoutMs, 'KERS change',
    );
    if ((reply[5] === CMD.WRITE_RESP && reply[6] !== 0) || (reply[5] === CMD.WRITE && reply[7] !== 1)) {
      throw new SessionError('WRITE', 'Scooter rejected the KERS change');
    }
      acknowledged = true;
    } catch (error) {
      if (error.code !== 'TIMEOUT' || this.stopped) throw error;
      this.info('KERS write sent without ACK; checking the actual level (no write retry)');
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      await delay(200);
      try {
        const actual = u16le(await this.readRegister(REG.KERS, 2));
        this.kers = actual <= 2 ? actual : null;
        if (actual === level) {
          this.info(`KERS: ${['weak', 'medium', 'strong'][level]} — verified by readback`);
          return { confirmed: true, level, acknowledged };
        }
      } catch (error) {
        if (this.stopped) throw error;
        this.kers = null;
        break;
      }
    }
    this.info(`KERS change unconfirmed; requested=${level}, actual=${this.kers ?? 'unknown'}, acknowledged=${acknowledged}`);
    return { confirmed: false, level: this.kers, acknowledged };
  }

  async readRegister(register, length) {
    const reply = await this.request(
      {
        cmd: CMD.READ,
        dst: ADDR.ESC,
        arg: register,
        data: Uint8Array.of(length),
      },
      (frame) => frame[4] === ADDR.APP && frame[6] === register &&
        frame[2] === length && frame.length >= 7 + length && (
          (frame[3] === ADDR.ESC && frame[5] === CMD.READ_RESP) ||
          (this.crypto && frame[3] === ADDR.MI3_REPLY && frame[5] === CMD.READ)
        ),
      2500,
      `read 0x${register.toString(16).padStart(2, '0')}`,
    );
    return reply.slice(7, 7 + length);
  }

  readStatus() { return this.operations.run(() => this.readStatusNow()); }

  async readStatusNow() {
    if (!this.paired) throw new SessionError('NOT_PAIRED', 'Not paired');
    await delay(250);
    if (this.stopped || !this.paired) throw new SessionError('CANCELLED', 'Session stopped');
    // A failed optional read must not present an old value as a fresh one.
    const status = { battery: null, firmware: null, serial: this.serial || null,
      locked: null, lockConfirmed: false };
    const checkLifecycle = (error) => {
      if (this.stopped || !this.paired || ['CANCELLED', 'DISCONNECTED', 'TRANSPORT'].includes(error?.code)) {
        throw error;
      }
    };

    try {
      const battery = await this.readRegister(REG.BATTERY, 2);
      if (battery.length >= 2) status.battery = u16le(battery);
    } catch (error) {
      checkLifecycle(error);
      this.info(`Battery: ${error.message}`);
    }

    try {
      status.locked = await this.readLockState();
      status.lockConfirmed = true;
      this.locked = status.locked;
    } catch (error) {
      checkLifecycle(error);
      this.locked = null;
      this.info(`Lock state: ${error.message}`);
    }

    try {
      const firmware = await this.readRegister(REG.FW_VERSION, 2);
      if (firmware.length >= 2) status.firmware = versionToString(u16le(firmware));
    } catch (error) {
      checkLifecycle(error);
      // optional
    }

    try {
      const serial = await this.readRegister(REG.SERIAL, 14);
      if (serial.length >= 14) {
        const value = cleanAscii(serial).trim();
        if (value) status.serial = value;
      }
    } catch (error) {
      checkLifecycle(error);
      // optional
    }

    if (this.stopped || !this.paired) throw new SessionError('CANCELLED', 'Session stopped');
    this.status = status;
    this.info(`Status: battery ${status.battery ?? '—'}% · lock ${status.locked === true ? 'on' : status.locked === false ? 'off' : 'unknown'}`);
    return status;
  }

  handleDisconnect() {
    this.stopped = true;
    if (this.stop5C) this.stop5C();
    const stage = !this.paired && this.lastCommand ? ` during pairing, after ${this.lastCommand}` : '';
    const error = new SessionError('DISCONNECTED', `Scooter disconnected${stage}`);
    error.command = this.lastCommand;
    this.paired = false;
    this.operations.cancel(error);
    this.requests.cancel(error);
    this.rejectAll(error);
    this.progress('disconnected', { error });
  }

  abort(error) {
    this.stopped = true;
    this.paired = false;
    this.operations.cancel(error);
    this.requests.cancel(error);
    if (this.stop5C) this.stop5C();
    this.rejectAll(error);
    if (!this.errorEmitted) {
      this.errorEmitted = true;
      this.error(error.message || String(error));
      this.progress('error', { error });
    }
  }

  cancel() {
    this.abort(new SessionError('CANCELLED', 'Pairing cancelled'));
  }

  destroy() {
    this.stopped = true;
    this.paired = false;
    const error = new SessionError('CANCELLED', 'Session closed');
    this.operations.cancel(error);
    this.requests.cancel(error);
    if (this.stop5C) this.stop5C();
    this.rejectAll(error);
    if (this.unsubscribeFrame) this.unsubscribeFrame();
    if (this.unsubscribeDisconnect) this.unsubscribeDisconnect();
  }
}
