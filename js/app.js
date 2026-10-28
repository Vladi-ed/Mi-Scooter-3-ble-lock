import {
  BleTransport,
  requestScooterDevice,
  isWebBluetoothSupported,
  getKnownBluetoothDevices,
  matchKnownDevice,
} from './ble.js';
import { ScooterSession } from './session.js';
import { MockScooter, MockTransport } from './mock.js';
import { bytesToHex } from './protocol.js';
import { PairingStore } from './pairing-store.js';
import { visibleLogEntry, formatLog, redactLogText } from './log-format.js';
import { SETTINGS_KEY, DEFAULTS, loadSettings } from './settings.js';
import { KERS_NAMES, diagnosticReport } from './diagnostics.js';

const $ = (id) => document.getElementById(id);

const els = {
  statusPill: $('statusPill'),
  statusText: $('statusText'),
  envWarning: $('envWarning'),
  envTitle: $('envTitle'),
  envText: $('envText'),

  deviceName: $('deviceName'),
  deviceSub: $('deviceSub'),
  demoBadge: $('demoBadge'),
  btnSelect: $('btnSelect'),
  btnConnect: $('btnConnect'),
  btnConnectLabel: $('btnConnectLabel'),
  btnDisconnect: $('btnDisconnect'),

  scooterCard: $('scooterCard'),
  scooterTitle: $('scooterTitle'),
  scooterSerial: $('scooterSerial'),
  lockChip: $('lockChip'),
  lockChipText: $('lockChipText'),
  btnLock: $('btnLock'),
  btnUnlock: $('btnUnlock'),
  btnRefresh: $('btnRefresh'),
  statBattery: $('statBattery'),
  statFirmware: $('statFirmware'),
  kersLevel: $('kersLevel'),
  kersCurrent: $('kersCurrent'),
  btnKers: $('btnKers'),
  btnDiagnostics: $('btnDiagnostics'),
  btnDiagnosticReport: $('btnDiagnosticReport'),
  diagnosticValues: $('diagnosticValues'),
  diagnosticTime: $('diagnosticTime'),

  log: $('log'),
  logEmpty: $('logEmpty'),
  showEncrypted: $('showEncrypted'),
  detailedLog: $('detailedLog'),
  btnForgetPairing: $('btnForgetPairing'),
  btnCopyLog: $('btnCopyLog'),
  btnClearLog: $('btnClearLog'),

  cryptoName: $('cryptoName'),
  btnUseDeviceName: $('btnUseDeviceName'),
  btnResetName: $('btnResetName'),
  protocol: $('protocol'),
  gattWrite: $('gattWrite'),
  writeMode: $('writeMode'),
  gapMs: $('gapMs'),
  btnDemo: $('btnDemo'),

  overlay: $('overlay'),
  overlaySteps: $('overlaySteps'),
  overlayTitle: $('overlayTitle'),
  overlayText: $('overlayText'),
  overlaySerial: $('overlaySerial'),
  overlayBar: $('overlayBar'),
  btnOverlayCancel: $('btnOverlayCancel'),
  btnOverlayRetry: $('btnOverlayRetry'),

  toast: $('toast'),
};

const APP_VERSION = '1.5.11';
let settings = { ...DEFAULTS };
try { settings = loadSettings(localStorage); } catch { /* unavailable storage */ }
let pairingStore = null;
try { pairingStore = new PairingStore(localStorage); } catch { /* private browser */ }

let device = null;
let deviceRecovered = false;
let connectionEpoch = 0;
let currentDeviceName = '';
let transport = null;
let session = null;
let demo = false;
let busy = false;
let lockBusy = false;
let featureBusy = false;
let statusBusy = false;
let tearingDown = false;
let logEntries = [];
let logAutoScroll = true;
let toastTimer = null;
let overlayHideTimer = null;

/* ---------- small helpers ---------- */

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // localStorage can be unavailable in private mode
  }
}

function setStatus(text, kind = 'idle') {
  els.statusText.textContent = text;
  els.statusPill.className = `status-pill status-pill--${kind}`;
}

function showToast(message, kind = 'ok') {
  if (toastTimer) clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.className = `toast toast--${kind} show`;
  toastTimer = setTimeout(() => {
    els.toast.className = 'toast';
    toastTimer = null;
  }, 3400);
}

function showBanner(kind, title, text) {
  els.envWarning.classList.remove('hidden', 'banner--warn', 'banner--err');
  els.envWarning.classList.add(kind === 'err' ? 'banner--err' : 'banner--warn');
  els.envTitle.textContent = title;
  els.envText.textContent = text;
}

function hideBanner() {
  els.envWarning.classList.add('hidden');
}

function timeString(date = new Date()) {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function resolveCryptoName({ liveName = '' } = {}) {
  const typed = els.cryptoName.value.trim();
  const live = String(liveName || '').trim();
  // If the field still contains the name from the device chooser, prefer the
  // name reported by the live GATT connection (it can be empty during scan).
  if (typed && typed !== currentDeviceName) return typed;
  if (live) return live;
  if (typed) return typed;
  if (currentDeviceName) return currentDeviceName;
  return 'Mi Scooter 3';
}

/* ---------- environment ---------- */

function checkEnvironment() {
  if (!window.isSecureContext) {
    showBanner(
      'warn',
      'Нужен HTTPS',
      'Bluefy открывает Web Bluetooth только на HTTPS-странице. Загрузите папку на Netlify/GitHub Pages или включите локальный HTTPS-сервер (см. README).',
    );
    return;
  }
  if (!isWebBluetoothSupported()) {
    showBanner(
      'warn',
      'Web Bluetooth недоступен',
      'На iPhone откройте эту страницу в Bluefy — Safari не поддерживает Web Bluetooth. На компьютере используйте Chrome или Edge.',
    );
    return;
  }
  hideBanner();
}

/* ---------- log ---------- */

function addLog(entry) {
  if (!entry) return;
  entry.time = new Date();
  // Capture a safe summary now, before another device replaces these values.
  entry.publicText = redactLogText(entry.text, [
    currentDeviceName, settings.lastDeviceName, settings.lastDeviceId,
    settings.cryptoName, device?.name, device?.id, session?.name, session?.serial,
    els.cryptoName.value,
  ]);
  logEntries.push(entry);
  if (logEntries.length > 500) logEntries.shift();
  if (visibleLogEntry(entry, settings.detailedLog)) {
    renderLogEntry(entry);
    els.logEmpty.classList.add('hidden');
  }
  while (els.log.children.length > 500) els.log.firstElementChild.remove();
  if (logAutoScroll) els.log.scrollTop = els.log.scrollHeight;
}

function renderLogEntry(entry) {
  const row = document.createElement('div');
  const kind = entry.kind || 'info';
  row.className = `log-entry log-entry--${kind}`;

  const head = document.createElement('div');
  head.className = 'log-head';

  const dir = document.createElement('span');
  dir.className = 'log-dir';
  let direction = '·';
  if (kind === 'out') direction = '→';
  else if (kind === 'in') direction = '←';
  else if (kind === 'error') direction = '!';
  dir.textContent = direction;

  const label = document.createElement('span');
  label.className = 'log-label';
  if (kind === 'out' || kind === 'in') {
    label.textContent = entry.label || 'frame';
  } else {
    label.textContent = entry.text || '';
  }

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = timeString(entry.time);

  head.append(dir, label, time);
  row.append(head);

  if (kind === 'out' || kind === 'in') {
    if (entry.plain && entry.plain.length) {
      const hex = document.createElement('div');
      hex.className = 'log-hex';
      hex.textContent = bytesToHex(entry.plain);
      row.append(hex);
    }
    if (entry.encrypted && entry.encrypted.length) {
      const encrypted = document.createElement('div');
      encrypted.className = 'log-encrypted';
      encrypted.textContent = `🔒 ${bytesToHex(entry.encrypted)}`;
      row.append(encrypted);
    }
    const note = [entry.details, entry.note].filter(Boolean).join(' · ');
    if (note) {
      const noteEl = document.createElement('div');
      noteEl.className = 'log-note';
      noteEl.textContent = note;
      row.append(noteEl);
    }
  }

  els.log.append(row);
}

function clearLog() {
  logEntries = [];
  els.log.replaceChildren();
  els.logEmpty.classList.remove('hidden');
}

function redrawLog() {
  els.log.replaceChildren();
  for (const entry of logEntries) if (visibleLogEntry(entry, settings.detailedLog)) renderLogEntry(entry);
  els.logEmpty.classList.toggle('hidden', els.log.children.length > 0);
}

function logToText() {
  return formatLog(logEntries, { detailed: settings.detailedLog, encrypted: settings.showEncrypted, time: timeString });
}

function updateLogPrivacyUI() {
  $('logPrivacyHint').classList.toggle('hidden', !settings.detailedLog);
  els.btnCopyLog.title = settings.detailedLog
    ? 'Копировать полный журнал с чувствительными данными'
    : 'Копировать краткий журнал без идентификаторов устройства';
}

async function copyLog() {
  if (logEntries.length === 0) {
    showToast('Журнал пуст');
    return;
  }
  const text = (settings.detailedLog
    ? 'Detailed log: contains device identifiers and pairing material. Do not publish it.\n\n'
    : '') + logToText();
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      showToast('Журнал скопирован');
      return;
    }
  } catch {
    // fall through to the textarea method
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    showToast('Журнал скопирован');
  } catch {
    showToast('Не удалось скопировать журнал', 'error');
  }
}

/* ---------- overlay ---------- */

function setOverlayStep(active) {
  const steps = els.overlaySteps.querySelectorAll('.overlay-step');
  steps.forEach((step, index) => {
    step.classList.toggle('is-done', active > index + 1);
    step.classList.toggle('is-active', active === index + 1);
  });
}

function showOverlay() {
  if (overlayHideTimer) {
    clearTimeout(overlayHideTimer);
    overlayHideTimer = null;
  }
  els.overlay.classList.remove('hidden', 'is-error', 'is-success');
  document.body.classList.add('modal-open');
}

function hideOverlay() {
  if (overlayHideTimer) {
    clearTimeout(overlayHideTimer);
    overlayHideTimer = null;
  }
  els.overlay.classList.add('hidden');
  document.body.classList.remove('modal-open');
}

function overlayProgress(percent) {
  els.overlayBar.style.width = `${Math.max(4, Math.min(100, percent))}%`;
}

function showOverlayError(error) {
  showOverlay();
  els.overlay.classList.add('is-error');
  setOverlayStep(0);
  els.overlayTitle.textContent = 'Не удалось';
  const hint = errorHint(error);
  els.overlayText.textContent = [error.message || String(error), hint].filter(Boolean).join('\n');
  els.overlaySerial.textContent = '';
  overlayProgress(100);
  els.btnOverlayRetry.classList.remove('hidden');
  els.btnOverlayCancel.textContent = 'Закрыть';
  els.btnOverlayCancel.classList.remove('hidden');
}

function showOverlaySuccess() {
  showOverlay();
  els.overlay.classList.add('is-success');
  setOverlayStep(4);
  els.overlayTitle.textContent = 'Готово';
  els.overlayText.textContent = demo
    ? 'Демо-самокат привязан. Попробуйте заблокировать и разблокировать.'
    : 'Самокат привязан. Теперь можно блокировать и разблокировать.';
  els.overlaySerial.textContent = session?.serial ? `S/N ${session.serial}` : '';
  overlayProgress(100);
  els.btnOverlayRetry.classList.add('hidden');
  els.btnOverlayCancel.textContent = 'Закрыть';
  if (overlayHideTimer) clearTimeout(overlayHideTimer);
  overlayHideTimer = setTimeout(() => {
    if (els.overlay.classList.contains('is-success')) hideOverlay();
  }, 1200);
}

function errorHint(error) {
  const code = error && error.code;
  if (code === 'TIMEOUT') {
    return 'Проверьте, что самокат включён, Mi Home закрыт и имя Bluetooth в «Дополнительно» совпадает с самокатом.';
  }
  if (code === 'CRYPTO') {
    return 'Имя Bluetooth для AES-ключа не совпало. Нажмите «Взять из Bluetooth» или впишите имя вручную в «Дополнительно».';
  }
  if (code === 'BIND') {
    return 'Нажмите кнопку питания на самокате ещё раз и повторите привязку.';
  }
  if (code === 'DISCONNECTED') {
    return error.command === '0x5C'
      ? 'Ответ 0x5B получен. Подтверждение ключа 0x5C не получено. Сохраните журнал со строками GATT TX и настройками записи; по одному обрыву нельзя определить причину.'
      : 'Bluetooth-соединение разорвано. Подключитесь снова; подробности последнего обмена есть в журнале.';
  }
  if (code === 'SERIAL') {
    return 'Ответ 0x5B пришёл, но серийный номер не распознан. Попробуйте переподключиться.';
  }
  return 'Откройте журнал команд: в нём видно, на каком кадре произошла ошибка.';
}

/* ---------- buttons / state ---------- */

function refreshButtons() {
  const connected = !!transport && transport.connected !== false;
  const paired = !!session && session.paired;
  const operate = connected && paired && !busy && !lockBusy && !featureBusy && !statusBusy;
  const targetName = (device?.name || currentDeviceName || settings.lastDeviceName || '').trim();
  const hasTarget = !!device || !!settings.lastDeviceName;

  els.btnConnectLabel.textContent = targetName
    ? `Подключиться к ${targetName}`
    : 'Выбрать самокат';
  els.btnConnect.disabled = busy;
  els.btnConnect.classList.toggle('hidden', connected);

  els.btnSelect.disabled = busy;
  els.btnSelect.classList.toggle('hidden', connected || !hasTarget);

  els.btnDisconnect.classList.toggle('hidden', !connected);
  els.btnDisconnect.classList.toggle('btn--grow', connected);
  els.btnDisconnect.disabled = false;

  els.btnLock.disabled = !operate;
  els.btnUnlock.disabled = !operate;
  els.btnRefresh.disabled = !operate;
  els.btnDiagnostics.disabled = !operate;
  els.btnDiagnosticReport.disabled = !session?.diagnostics || featureBusy;
  els.kersLevel.disabled = !operate || !Number.isInteger(session?.kers);
  els.btnKers.disabled = els.kersLevel.disabled || els.kersLevel.value === '';
  els.btnDemo.disabled = busy;
}

function setBusy(value) {
  busy = value;
  refreshButtons();
}

function setLockUI(locked) {
  els.lockChip.classList.remove('chip--unknown', 'chip--locked', 'chip--unlocked');
  if (locked === true) {
    els.lockChip.classList.add('chip--locked');
    els.lockChipText.textContent = 'Замок: заблокирован';
  } else if (locked === false) {
    els.lockChip.classList.add('chip--unlocked');
    els.lockChipText.textContent = 'Замок: разблокирован';
  } else {
    els.lockChip.classList.add('chip--unknown');
    els.lockChipText.textContent = 'Замок: —';
  }
}

function updateStats(status = {}) {
  els.statBattery.textContent =
    status.battery !== undefined && status.battery !== null ? `${status.battery}%` : '—';
  els.statFirmware.textContent = status.firmware || '—';
  els.scooterSerial.textContent = `S/N ${status.serial || session?.serial || '—'}`;
  let locked = status.locked;
  if (locked === undefined) {
    locked = session && typeof session.locked === 'boolean' ? session.locked : null;
  }
  setLockUI(locked);
}

/* ---------- session lifecycle ---------- */

async function teardown() {
  tearingDown = true;
  connectionEpoch += 1;
  featureBusy = false;
  statusBusy = false;
  lockBusy = false;
  els.diagnosticValues.replaceChildren();
  els.diagnosticTime.textContent = 'Показатели ещё не прочитаны.';
  els.kersCurrent.textContent = 'Текущий уровень не прочитан. Нажмите «Диагностика».';
  els.kersLevel.value = '';
  if (session) {
    session.destroy();
    session = null;
  }
  const oldTransport = transport;
  transport = null;
  if (oldTransport) {
    try {
      await oldTransport.disconnect();
    } catch {
      // ignore
    }
  }

  demo = false;
  els.demoBadge.classList.add('hidden');
  hideOverlay();
  els.scooterCard.classList.add('hidden');
  currentDeviceName = (settings.lastDeviceName || '').trim();
  if (currentDeviceName) {
    updateDeviceUI(currentDeviceName, settings.lastDeviceId || '', 'Последний самокат');
  }
  els.cryptoName.value = settings.cryptoName || currentDeviceName || '';
  els.scooterTitle.textContent = 'Mi Scooter 3';
  els.scooterSerial.textContent = 'S/N —';
  els.statBattery.textContent = '—';
  els.statFirmware.textContent = '—';
  setLockUI(null);

  els.btnDisconnect.classList.add('hidden');
  els.btnConnect.classList.remove('hidden');
  els.btnConnect.disabled = false;
  els.btnSelect.disabled = false;
  els.btnLock.disabled = true;
  els.btnUnlock.disabled = true;
  els.btnRefresh.disabled = true;

  setStatus('Не подключено', 'idle');
  setBusy(false);
  tearingDown = false;
}

async function connectSelected() {
  if (!device || busy) return;
  await teardown();
  const epoch = connectionEpoch;
  demo = false;
  setBusy(true);
  setStatus('Подключение…', 'busy');

  const protocol = settings.protocol;
  const candidate = new BleTransport({
    cryptoMode: protocol === 'aes',
    writeMode: settings.writeMode,
    writeMethodPreference: settings.gattWrite,
    gapMs: settings.gapMs,
    onLog: addLog,
  });

  let gattReady = false;
  transport = candidate;
  try {
    await candidate.connect(device);
    if (epoch !== connectionEpoch) return;
    gattReady = true;

    const liveName = (device.name || '').trim();
    const effectiveName = resolveCryptoName({ liveName });
    if (
      liveName &&
      (!els.cryptoName.value.trim() || els.cryptoName.value.trim() === currentDeviceName)
    ) {
      els.cryptoName.value = liveName;
      settings.cryptoName = liveName;
      saveSettings();
    }
    currentDeviceName = liveName || currentDeviceName;
    settings.lastDeviceName = currentDeviceName;
    settings.lastDeviceId = device.id || settings.lastDeviceId || '';
    saveSettings();
    updateDeviceUI(currentDeviceName, device.id);

    await startSession(candidate, effectiveName, protocol, false, false, false, epoch);
  } catch (error) {
    if (epoch !== connectionEpoch) return;
    if (!gattReady) { device = null; deviceRecovered = true; }
    addLog({ kind: 'error', text: `Connection failed: ${error?.message || error?.name || (typeof error === 'string' ? error : 'browser returned no error details')}` });
    setStatus('Ошибка', 'err');
    showToast(!gattReady ? 'Нажмите «Подключиться» ещё раз и выберите самокат в списке браузера.' : error?.message || 'Не удалось подключиться', 'error');
    try {
      await candidate.disconnect();
    } catch {
      // ignore
    }
    if (transport === candidate) transport = null;
    refreshButtons();
  } finally {
    if (epoch === connectionEpoch) setBusy(false);
  }
}

async function startSession(activeTransport, name, protocol, isDemo, forceNewPairing = false, helloRetried = false, epoch = connectionEpoch) {
  let activePairingStore = pairingStore;
  if (isDemo) activePairingStore = null;
  else if (forceNewPairing) {
    activePairingStore = {
      load: () => null,
      save: (...args) => pairingStore?.save(...args) ?? false,
      remove: (...args) => pairingStore?.remove(...args),
    };
  }
  const nextSession = new ScooterSession(activeTransport, {
    name,
    protocol,
    pairingStore: activePairingStore,
    onLog: addLog,
    onProgress: (phase, data) => {
      if (session === nextSession && epoch === connectionEpoch) handleProgress(phase, data);
    },
    intervalMs: isDemo ? 700 : 500,
    deferHelloTimeout: !helloRetried && !isDemo,
  });
  session = nextSession;

  els.scooterCard.classList.remove('hidden');
  els.scooterTitle.textContent = isDemo ? 'Mi Scooter 3 · демо' : currentDeviceName || 'Mi Scooter 3';
  els.scooterSerial.textContent = 'S/N —';
  updateStats({});
  refreshButtons();

  try {
    await session.start();
  } catch (error) {
    if (epoch !== connectionEpoch) return;
    const retryHello = error.code === 'HELLO_TIMEOUT' && !helloRetried;
    const retryPairing = error.code === 'PAIRING_EXPIRED' && !forceNewPairing;
    if (!isDemo && (retryHello || retryPairing)) {
      addLog({ kind: 'info', text: error.message });
      session.destroy();
      await activeTransport.disconnect();
      await new Promise(resolve => setTimeout(resolve, 350));
      if (epoch !== connectionEpoch) return;
      await activeTransport.connect(device);
      if (epoch !== connectionEpoch) return;
      transport = activeTransport;
      return startSession(activeTransport, name, protocol, false, forceNewPairing || retryPairing, helloRetried || retryHello, epoch);
    }
    // handleProgress already presented the error. Keep the connection so the
    // user can read the log or retry, unless the transport died.
    console.warn('session start failed', error);
  }
  refreshButtons();
}

function handleProgress(phase, data = {}) {
  if (tearingDown && phase !== 'disconnected') return;
  switch (phase) {
    case 'handshake': {
      showOverlay();
      setOverlayStep(1);
      els.overlayTitle.textContent = 'Обмен ключами';
      els.overlayText.textContent =
        'Ожидаем ответ самоката и проверяем сохранённую привязку. Сейчас кнопку питания нажимать не нужно.';
      els.overlaySerial.textContent = '';
      overlayProgress(12);
      els.btnOverlayRetry.classList.add('hidden');
      els.btnOverlayCancel.textContent = 'Отмена';
      setStatus('Обмен ключами', 'busy');
      break;
    }
    case 'button': {
      showOverlay();
      setOverlayStep(2);
      els.overlayTitle.textContent = 'Нажмите кнопку питания';
      els.overlayText.textContent = data.alreadyPaired
        ? 'Самокат сообщил о предыдущей привязке. Это не ошибка. Ключ отправлен — коротко нажмите кнопку питания на руле.'
        : 'Нажмите кнопку питания на руле СРАЗУ, как только появилось это окно. Ключ уже отправлен.';
      els.overlaySerial.textContent = data.serial ? `S/N ${data.serial}` : '';
      overlayProgress(48);
      els.btnOverlayRetry.classList.add('hidden');
      els.btnOverlayCancel.textContent = 'Отмена';
      setStatus('Ждём кнопку', 'busy');
      break;
    }
    case 'bind': {
      showOverlay();
      setOverlayStep(3);
      els.overlayTitle.textContent = 'Привязка';
      els.overlayText.textContent = 'Подтверждаем серийный номер и сохраняем ключ…';
      overlayProgress(82);
      els.btnOverlayRetry.classList.add('hidden');
      els.btnOverlayCancel.textContent = 'Отмена';
      setStatus('Привязка', 'busy');
      break;
    }
    case 'paired': {
      updateStats(session?.status || {});
      els.scooterSerial.textContent = `S/N ${session?.serial || '—'}`;
      showOverlaySuccess();
      setStatus('Готово', 'ok');
      refreshButtons();
      setTimeout(() => {
        if (session?.paired && transport?.connected) refreshStatus(true);
      }, 900);
      break;
    }
    case 'error': {
      showOverlayError(data.error || new Error('Неизвестная ошибка'));
      setStatus('Ошибка', 'err');
      refreshButtons();
      break;
    }
    case 'disconnected': {
      if (tearingDown) return;
      const wasDemo = demo;
      demo = false;
      els.demoBadge.classList.add('hidden');
      if (wasDemo) {
        currentDeviceName = (settings.lastDeviceName || '').trim();
        if (currentDeviceName) {
          updateDeviceUI(currentDeviceName, settings.lastDeviceId || '', 'Последний самокат');
        }
        els.cryptoName.value = settings.cryptoName || currentDeviceName || '';
      }
      setStatus('Отключено', 'warn');
      els.btnDisconnect.classList.add('hidden');
      els.btnConnect.classList.remove('hidden');
      els.btnConnect.disabled = false;
      els.btnSelect.disabled = false;
      els.btnLock.disabled = true;
      els.btnUnlock.disabled = true;
      els.btnRefresh.disabled = true;
      if (!els.overlay.classList.contains('hidden') && !session?.paired) {
        showOverlayError(data.error || {
          code: 'DISCONNECTED',
          message: 'Связь с самокатом прервалась во время привязки.',
        });
      } else {
        hideOverlay();
      }
      refreshButtons();
      break;
    }
    case 'cancelled': {
      hideOverlay();
      break;
    }
    default:
      break;
  }
}

/* ---------- status ---------- */

async function refreshStatus(silent = false) {
  if (!session || !session.paired || !transport?.connected || lockBusy || featureBusy || statusBusy) return;
  const active = session;
  statusBusy = true;
  refreshButtons();
  if (!silent) setStatus('Читаю статус…', 'busy');
  els.btnRefresh.disabled = true;
  try {
    const status = await active.readStatus();
    if (session !== active || !active.paired) return;
    updateStats(status);
    if (transport?.connected && session?.paired) setStatus('Готово', 'ok');
  } catch (error) {
    if (session !== active) return;
    addLog({ kind: 'error', text: `Status read failed: ${error.message}` });
    if (!silent) showToast(error.message || 'Не удалось прочитать статус', 'error');
    if (error.code === 'DISCONNECTED') setStatus('Отключено', 'warn');
    else if (!silent) setStatus('Ошибка', 'err');
  } finally {
    if (session === active) statusBusy = false;
    refreshButtons();
  }
}

async function doLock(lock) {
  if (!session || !session.paired) {
    showToast('Сначала выполните привязку', 'error');
    return;
  }
  if (lockBusy || featureBusy || statusBusy) return;
  const active = session;
  lockBusy = true;
  refreshButtons();
  setStatus(lock ? 'Блокирую…' : 'Разблокирую…', 'busy');
  try {
    await active.setLock(lock);
    if (session !== active || !active.paired) return;
    updateStats(session.status || {});
    setStatus('Готово', 'ok');
    let message = lock ? 'Самокат заблокирован' : 'Самокат разблокирован';
    if (session.status.lockConfirmed === false) {
      message = lock ? 'Команда блокировки принята' : 'Команда разблокировки принята';
    }
    showToast(message, 'ok');
  } catch (error) {
    if (session !== active) return;
    addLog({ kind: 'error', text: error.message });
    if (error.code === 'DISCONNECTED') {
      setStatus('Отключено', 'warn');
      showToast('Связь прервалась. Самокат мог перезагрузиться — подключитесь снова.', 'error');
    } else {
      updateStats(session.status || {});
      setStatus('Ошибка', 'err');
      showToast(error.message || 'Команда не выполнена', 'error');
    }
  } finally {
    if (session === active) lockBusy = false;
    refreshButtons();
  }
}

function renderKers() {
  const level = session?.kers;
  els.kersCurrent.textContent = Number.isInteger(level) ? `Прочитано: ${KERS_NAMES[level].toLowerCase()}` : 'Текущий уровень не подтверждён. Прочитайте диагностику.';
  els.kersLevel.value = Number.isInteger(level) ? String(level) : '';
}

function renderDiagnostics(report) {
  els.diagnosticValues.replaceChildren();
  for (const field of report.fields) {
    if (['error', 'warning'].includes(field.id) && field.state === 'ok' && Number(field.value) === 0) continue;
    const term = document.createElement('dt');
    term.textContent = field.label;
    const value = document.createElement('dd');
    value.textContent = field.value;
    const raw = document.createElement('small');
    const rawDetails = field.raw ? ' · ' + field.raw : '';
    raw.textContent = `0x${field.reg.toString(16)}${rawDetails}`;
    value.append(raw);
    els.diagnosticValues.append(term, value);
  }
  els.diagnosticTime.textContent = `Снимок: ${new Date(report.capturedAt).toLocaleTimeString()}`;
}

async function runFeature(kind) {
  if (!session?.paired || featureBusy || lockBusy || statusBusy) return;
  const active = session;
  featureBusy = true;
  refreshButtons();
  setStatus(kind === 'kers' ? 'Изменяю KERS…' : 'Читаю диагностику…', 'busy');
  try {
    if (kind === 'kers') {
      if (els.kersLevel.value === '') return;
      const result = await active.setKers(Number(els.kersLevel.value));
      if (session !== active || !active.paired) return;
      // A previous diagnostic snapshot must not masquerade as a new readback.
      if (active.diagnostics) {
        active.diagnostics = null;
        els.diagnosticValues.replaceChildren();
        els.diagnosticTime.textContent = 'Настройка изменена. Обновите снимок диагностики.';
      }
      const currentLevel = KERS_NAMES[result.level] || 'неизвестен';
      const unconfirmedMessage = `Изменение не подтверждено. Текущий уровень: ${currentLevel}`;
      showToast(result.confirmed ? 'Уровень KERS подтверждён' : unconfirmedMessage, result.confirmed ? 'ok' : 'error');
    } else {
      els.diagnosticValues.replaceChildren();
      els.diagnosticTime.textContent = 'Читаем показатели…';
      const report = await active.readDiagnostics();
      if (session !== active || !active.paired) return;
      renderDiagnostics(report);
    }
    renderKers();
    setStatus('Готово', 'ok');
  } catch (error) {
    if (session !== active) return;
    renderKers();
    if (kind === 'diagnostics') els.diagnosticTime.textContent = 'Чтение прервано. Переподключитесь и повторите.';
    addLog({ kind: 'error', text: error.message });
    showToast(error.message, 'error');
    setStatus(active.paired ? 'Готово' : 'Переподключитесь', 'warn');
  } finally {
    if (session === active) featureBusy = false;
    refreshButtons();
  }
}

function downloadDiagnostics() {
  if (!session?.diagnostics) return;
  const text = diagnosticReport(session.diagnostics, APP_VERSION, {
    gattWrite: settings.gattWrite, frames: settings.writeMode, gapMs: settings.gapMs,
  });
  document.getElementById('diagnosticExport')?.remove();
  const dialog = document.createElement('dialog');
  dialog.id = 'diagnosticExport';
  dialog.style.cssText = 'width:min(90vw,680px);max-height:85vh;background:#102330;color:#fff;border:1px solid #537080;border-radius:18px;padding:20px';
  const title = document.createElement('h3');
  title.textContent = 'Отчёт JSON';
  const hint = document.createElement('p');
  hint.textContent = 'Скопируйте текст и отправьте его в чат. Если скачивание не работает, отчёт доступен здесь.';
  const area = document.createElement('textarea');
  area.readOnly = true; area.value = text; area.setAttribute('aria-label', 'Отчёт JSON');
  area.style.cssText = 'width:100%;height:40vh;background:#07151e;color:white;font:12px monospace';
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap;margin-top:12px';
  const button = (label, action) => {
    const b = document.createElement('button'); b.type = 'button';
    b.textContent = label; b.onclick = action; actions.append(b);
  };
  button('Копировать', async () => {
    try { await navigator.clipboard.writeText(text); hint.textContent = 'Отчёт скопирован.'; }
    catch { area.focus(); area.select(); area.setSelectionRange(0, text.length); hint.textContent = 'Текст выделен — выберите «Копировать» в меню браузера.'; }
  });
  button('Скачать JSON', () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'mi3-diagnostics.json';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });
  button('Закрыть', () => dialog.remove());
  dialog.append(title, hint, area, actions); document.body.append(dialog);
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

/* ---------- demo ---------- */

async function startDemo() {
  if (busy) return;
  try {
    await runDemo();
  } catch (error) {
    await teardown();
    addLog({ kind: 'error', text: error.message || 'Could not start demo' });
    setStatus('Ошибка', 'err');
    showToast(error.message || 'Не удалось запустить демо', 'error');
  }
}

async function runDemo() {
  await teardown();
  demo = true;
  els.demoBadge.classList.remove('hidden');
  els.scooterCard.classList.remove('hidden');
  els.scooterTitle.textContent = 'Mi Scooter 3 · демо';
  els.deviceName.textContent = 'Mi Scooter 3 · демо';
  els.deviceSub.textContent = 'Виртуальный самокат · настоящий протокол';
  els.cryptoName.value = 'Mi Scooter 3';
  currentDeviceName = 'Mi Scooter 3';
  els.btnSelect.disabled = true;
  els.btnConnect.classList.add('hidden');
  els.btnDisconnect.classList.remove('hidden');
  setStatus('Демо', 'warn');

  const scooter = new MockScooter({
    name: 'Mi Scooter 3',
    serial: 'MISCOOTER3DEMO',
    buttonDelay: 1700,
    onLog: addLog,
  });
  const mockTransport = new MockTransport(scooter, { latency: 25, onLog: addLog });
  await mockTransport.connect();
  transport = mockTransport;
  await startSession(mockTransport, 'Mi Scooter 3', 'aes', true);
  setBusy(false);
}

/* ---------- settings bindings ---------- */

function applySettingsToUI() {
  els.protocol.value = settings.protocol;
  els.gattWrite.value = settings.gattWrite;
  els.writeMode.value = settings.writeMode;
  els.gapMs.value = String(settings.gapMs);
  els.cryptoName.value = settings.cryptoName || '';
  els.cryptoName.placeholder = currentDeviceName || 'Mi Scooter 3';
  els.showEncrypted.checked = !!settings.showEncrypted;
  els.detailedLog.checked = !!settings.detailedLog;
  updateLogPrivacyUI();
  els.showEncrypted.disabled = !settings.detailedLog;
  els.log.classList.toggle('show-encrypted', !!settings.showEncrypted);
}

function updateDeviceUI(name, id, sub = '') {
  els.deviceName.textContent = name || 'Самокат без имени';
  els.deviceSub.textContent = sub || id || 'Нажмите «Подключиться»';
  if (name) {
    els.cryptoName.placeholder = name;
    if (!els.cryptoName.value.trim()) els.cryptoName.value = name;
  }
}

/* ---------- device selection / quick connect ---------- */

async function selectDevice({ allDevices = true, autoConnect = false } = {}) {
  if (busy || transport?.connected) return;
  if (!isWebBluetoothSupported()) {
    showToast('Web Bluetooth недоступен. На iPhone нужен Bluefy.', 'error');
    return;
  }

  setBusy(true);
  setStatus('Поиск…', 'busy');
  const filtered = !allDevices;
  try {
    const selected = await requestScooterDevice({
      allDevices,
      name: allDevices ? '' : settings.lastDeviceName || currentDeviceName || '',
    });

    device = selected;
    deviceRecovered = false;
    currentDeviceName =
      (selected.name || '').trim() || settings.lastDeviceName || currentDeviceName;
    settings.lastDeviceName = currentDeviceName;
    settings.lastDeviceId = selected.id || settings.lastDeviceId || '';
    if (currentDeviceName) {
      settings.cryptoName = currentDeviceName;
      els.cryptoName.value = currentDeviceName;
    }
    saveSettings();

    updateDeviceUI(currentDeviceName, selected.id);
    addLog({
      kind: 'info',
      text: `Scooter selected: ${currentDeviceName || selected.id || 'unnamed'}`,
    });
    setStatus('Выбран', 'idle');
    setBusy(false);

    if (autoConnect) {
      await connectSelected();
    } else {
      showToast('Самокат выбран. Нажмите «Подключиться».');
    }
  } catch (error) {
    if (error?.name === 'NotFoundError') {
      setStatus('Не подключено', 'idle');
      if (filtered) {
        showToast(
          'Сохранённый самокат не найден. Нажмите «Другое устройство».',
          'error',
        );
      }
      return;
    }
    if (error?.name === 'SecurityError') {
      showBanner(
        'err',
        'Нет доступа к Bluetooth',
        'Разрешите Bluetooth для Bluefy в настройках iOS и попробуйте снова.',
      );
    } else {
      showToast(error?.message || 'Не удалось выбрать самокат', 'error');
    }
    addLog({ kind: 'error', text: `Device selection failed: ${error?.message || error?.name || 'browser returned no error details'}` });
    setStatus('Ошибка', 'err');
  } finally {
    setBusy(false);
  }
}

async function quickConnect() {
  if (busy) return;
  if (device && !deviceRecovered) {
    await connectSelected();
    return;
  }
  // The saved device was not recovered by getDevices on startup. Open the
  // chooser with an exact-name filter. requestDevice() is called directly from
  // the click gesture (selectDevice does not await before it).
  await selectDevice({ allDevices: false, autoConnect: true });
}

async function mainConnect() {
  if (busy || transport?.connected) return;
  if (device && !deviceRecovered) {
    await connectSelected();
    return;
  }
  if (!settings.lastDeviceName && !settings.lastDeviceId) {
    await selectDevice({ allDevices: true, autoConnect: true });
    return;
  }
  await quickConnect();
}

async function recoverKnownDevice() {
  if (!settings.lastDeviceName && !settings.lastDeviceId) return;
  const known = await getKnownBluetoothDevices();
  const found = matchKnownDevice(known, settings.lastDeviceName, settings.lastDeviceId);
  if (!found || device || busy || transport?.connected) return;
  device = found;
  deviceRecovered = true;
  currentDeviceName = (found.name || settings.lastDeviceName || '').trim();
  updateDeviceUI(
    currentDeviceName,
    found.id || settings.lastDeviceId,
    'Последний самокат',
  );
  refreshButtons();
  addLog({
    kind: 'info',
    text: `Remembered scooter found: ${currentDeviceName || found.id}; select it to renew browser access`,
  });
}

/* ---------- bindings ---------- */

function bindEvents() {
  els.btnDiagnostics.addEventListener('click', () => runFeature('diagnostics'));
  els.btnKers.addEventListener('click', () => runFeature('kers'));
  els.kersLevel.addEventListener('change', refreshButtons);
  els.btnDiagnosticReport.addEventListener('click', downloadDiagnostics);
  els.btnSelect.addEventListener('click', () =>
    selectDevice({ allDevices: true, autoConnect: true }),
  );

  els.btnConnect.addEventListener('click', () => mainConnect());

  els.btnDisconnect.addEventListener('click', async () => {
    await teardown();
  });

  els.btnLock.addEventListener('click', () => doLock(true));
  els.btnUnlock.addEventListener('click', () => doLock(false));
  els.btnRefresh.addEventListener('click', () => refreshStatus(false));

  els.btnCopyLog.addEventListener('click', copyLog);
  els.btnClearLog.addEventListener('click', clearLog);
  els.detailedLog.addEventListener('change', () => {
    settings.detailedLog = els.detailedLog.checked;
    updateLogPrivacyUI();
    els.showEncrypted.disabled = !settings.detailedLog;
    saveSettings();
    redrawLog();
  });
  els.btnForgetPairing.addEventListener('click', () => {
    if (!session?.serial || demo) { showToast('Сначала подключитесь к самокату', 'error'); return; }
    pairingStore?.remove(session.serial);
    showToast('Привязка забыта. При следующем подключении понадобится кнопка');
  });
  els.showEncrypted.addEventListener('change', () => {
    settings.showEncrypted = els.showEncrypted.checked;
    saveSettings();
    els.log.classList.toggle('show-encrypted', settings.showEncrypted);
  });

  els.log.addEventListener('scroll', () => {
    const nearBottom =
      els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 48;
    logAutoScroll = nearBottom;
  });

  els.protocol.addEventListener('change', () => {
    settings.protocol = els.protocol.value;
    saveSettings();
    if (transport?.connected) {
      showToast('Протокол изменится после переподключения');
    }
  });

  els.gattWrite.addEventListener('change', () => {
    const previous = settings.gattWrite;
    settings.gattWrite = els.gattWrite.value;
    if (transport && typeof transport.pickWriteMethod === 'function') {
      transport.writeMethodPreference = settings.gattWrite;
      try {
        transport.writeMethod = transport.pickWriteMethod();
        showToast(`GATT-запись: ${transport.writeMethodLabel()}`);
      } catch (error) {
        settings.gattWrite = previous;
        els.gattWrite.value = previous;
        transport.writeMethodPreference = previous;
        showToast(error.message, 'error');
        addLog({ kind: 'error', text: error.message });
      }
    }
    saveSettings();
  });

  els.writeMode.addEventListener('change', () => {
    settings.writeMode = els.writeMode.value;
    saveSettings();
    if (transport) transport.writeMode = settings.writeMode;
  });

  els.gapMs.addEventListener('change', () => {
    const value = Math.max(0, Math.min(200, Number(els.gapMs.value) || 0));
    settings.gapMs = value;
    els.gapMs.value = String(value);
    saveSettings();
    if (transport) transport.gapMs = value;
  });

  els.cryptoName.addEventListener('change', () => {
    settings.cryptoName = els.cryptoName.value.trim();
    saveSettings();
    if (transport?.connected) {
      showToast('Имя ключа изменится после переподключения');
    }
  });

  els.btnUseDeviceName.addEventListener('click', () => {
    if (!currentDeviceName) {
      showToast('Сначала выберите самокат', 'error');
      return;
    }
    els.cryptoName.value = currentDeviceName;
    settings.cryptoName = currentDeviceName;
    saveSettings();
    showToast('Имя взято из Bluetooth');
  });

  els.btnResetName.addEventListener('click', () => {
    els.cryptoName.value = currentDeviceName || '';
    settings.cryptoName = '';
    saveSettings();
    showToast('Имя сброшено');
  });

  els.btnDemo.addEventListener('click', () => startDemo());

  els.btnOverlayCancel.addEventListener('click', async () => {
    if (els.overlay.classList.contains('is-success')) {
      hideOverlay();
      return;
    }
    if (session) session.cancel();
    await teardown();
  });

  els.btnOverlayRetry.addEventListener('click', async () => {
    hideOverlay();
    if (demo) {
      await startDemo();
      return;
    }
    if (!device) {
      showToast('Выберите самокат заново', 'error');
      return;
    }
    await connectSelected();
  });

  window.addEventListener('beforeunload', () => {
    try {
      transport?.disconnect();
    } catch {
      // ignore
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !els.overlay.classList.contains('hidden')) {
      els.btnOverlayCancel.click();
    }
  });
}

/* ---------- init ---------- */

function init() {
  currentDeviceName = (settings.lastDeviceName || '').trim();
  applySettingsToUI();
  if (currentDeviceName) {
    updateDeviceUI(
      currentDeviceName,
      settings.lastDeviceId || '',
      'Последний самокат',
    );
  }
  bindEvents();
  checkEnvironment();
  refreshButtons();
  addLog({ kind: 'info', text: `Mi3 BLE v${APP_VERSION} · Ninebot AES` });
  saveSettings();
  addLog({ kind: 'info', debug: true, text: 'Exact ArrayBuffer per chunk; first key counter=3; Mi 3 replies 0x23/0x01/0x02 supported' });
  recoverKnownDevice().catch((error) => {
    addLog({ kind: 'info', text: `getDevices: ${error.message || error.name || error}` });
  });

  if (new URLSearchParams(location.search).get('demo') === '1') {
    setTimeout(() => {
      startDemo().catch((error) => {
        console.error(error);
        showToast(error.message, 'error');
      });
    }, 450);
  }
}

init();
