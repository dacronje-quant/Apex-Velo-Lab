/**
 * APEX VELO // LAB - Web Bluetooth hardware layer.
 *
 *  - Wahoo KICKR SHIFT  : Fitness Machine Service (0x1826) - ERG control point + Indoor Bike Data
 *  - Favero Assioma DUO : Cycling Power Service   (0x1818) - power, L/R balance, crank revs, calibration
 *  - Heart-rate strap   : Heart Rate Service      (0x180D)
 *
 * Every device runs a small connection state machine:
 *     disconnected -> connecting -> connected -> (link lost) -> reconnecting -> connected | failed
 * An unexpected GATT drop triggers an exponential-backoff reconnect (1 s, 2 s, 4 s ... capped at 30 s).
 * A user-initiated disconnect never auto-reconnects. A reconnect without the chooser first scans for
 * the device when Chrome has forgotten it ("no longer in range" - see _gattConnect).
 *
 * All GATT writes go through a per-device promise queue so overlapping writes never raise
 * "GATT operation already in progress".
 *
 * Events emitted through `onData(evt)`:
 *   { type: 'pedals' | 'trainer' | 'hr', ...telemetry }
 *   { type: 'state', device, state, attempt, nextRetryMs }
 *   { type: 'disconnect', device, willReconnect }
 *   { type: 'reconnected', device }
 *   { type: 'battery', device, level }
 *   { type: 'calibration_response', success, offset, code }
 *   { type: 'ftms_response', ok, requestOpCode, result }
 */
class VeloBle {
  static UUID = {
    FTMS: '00001826-0000-1000-8000-00805f9b34fb',
    FTMS_CONTROL: '00002ad9-0000-1000-8000-00805f9b34fb',
    FTMS_BIKE_DATA: '00002ad2-0000-1000-8000-00805f9b34fb',
    FTMS_POWER_RANGE: '00002ad8-0000-1000-8000-00805f9b34fb',
    CPS: '00001818-0000-1000-8000-00805f9b34fb',
    CPS_MEASUREMENT: '00002a63-0000-1000-8000-00805f9b34fb',
    CPS_CONTROL: '00002a66-0000-1000-8000-00805f9b34fb',
    HRS: '0000180d-0000-1000-8000-00805f9b34fb',
    HRS_MEASUREMENT: '00002a37-0000-1000-8000-00805f9b34fb',
    BATTERY: '0000180f-0000-1000-8000-00805f9b34fb',
    BATTERY_LEVEL: '00002a19-0000-1000-8000-00805f9b34fb'
  };

  /** CPS Control Point op codes (Bluetooth SIG Cycling Power Service spec). */
  static CPS_OP = { START_OFFSET_COMPENSATION: 0x0C, START_ENHANCED_OFFSET_COMPENSATION: 0x10, RESPONSE: 0x20 };
  /** FTMS Control Point op codes. */
  static FTMS_OP = { REQUEST_CONTROL: 0x00, SET_TARGET_POWER: 0x05, START_RESUME: 0x07, STOP_PAUSE: 0x08, RESPONSE: 0x80 };

  static RECONNECT_MAX_ATTEMPTS = 8;
  static FIRST_CONNECT_ATTEMPTS = 3;
  static CONNECT_TIMEOUT_MS = 15000;
  static SCAN_TIMEOUT_MS = 12000; // how long a reconnect waits for a forgotten device to advertise
  static RECONNECT_BASE_MS = 1000;
  static RECONNECT_CAP_MS = 30000;

  /** Settling pause between GATT steps (Windows needs these). Tests set DELAY_SCALE = 0. */
  static DELAY_SCALE = 1;
  static delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms * VeloBle.DELAY_SCALE));
  }

  /**
   * Resilient primary service discovery with retries and fallback identifiers.
   * Prevents Windows BLE "Unreachable" / "Operation in progress" errors during link parameter negotiation.
   */
  static async getServiceWithRetry(server, primaryUuid, fallbackName = null, retries = 3, delayMs = 400) {
    let lastErr = null;
    for (let i = 0; i < retries; i++) {
      try {
        return await server.getPrimaryService(primaryUuid);
      } catch (err) {
        lastErr = err;
        if (fallbackName) {
          try {
            return await server.getPrimaryService(fallbackName);
          } catch (e) {
            lastErr = e;
          }
        }
        if (i < retries - 1) await VeloBle.delay(delayMs);
      }
    }
    throw lastErr;
  }

  constructor(onData) {
    this.onData = onData;
    this.slots = {
      trainer: this._newSlot('Wahoo KICKR SHIFT'),
      pedals: this._newSlot('Assioma DUO-Shi'),
      hr: this._newSlot('Heart Rate Monitor')
    };
    // FTMS ERG write throttling & keepalive state
    this.lastTargetPowerSent = null;
    this.lastTargetSendTime = 0;
    this.powerRange = { min: 0, max: 2000, inc: 1 };
    // CPS crank-revolution cadence state
    this.lastCrankRevs = null;
    this.lastCrankTime = null;
    this.lastCrankChangeMs = 0;
    this.lastCadence = null;
    this.permitted = {}; // devices Chrome still has permission for (refreshPermitted), by kind
  }

  _newSlot(defaultName) {
    return {
      name: defaultName, device: null, chars: {}, listeners: [], state: 'disconnected',
      manualDisconnect: false, inRetry: false, attempt: 0, retryTimer: null, nextRetryAt: 0,
      battery: null, rssi: null, lastPacket: 0, connectedSince: 0,
      pktWindowStart: 0, pktCount: 0, packetRate: 0, writeChain: Promise.resolve(), onGattDisconnected: null,
      connecting: false, lastError: null, stopScan: null
    };
  }

  _emit(evt) { if (this.onData) this.onData(evt); }

  _setState(kind, state, extra = {}) {
    const slot = this.slots[kind];
    slot.state = state;
    this._emit({ type: 'state', device: kind, state, attempt: slot.attempt, ...extra });
  }

  _markPacket(kind) {
    const slot = this.slots[kind];
    const now = performance.now();
    slot.lastPacket = now;
    if (!slot.pktWindowStart) slot.pktWindowStart = now;
    slot.pktCount++;
    const elapsed = now - slot.pktWindowStart;
    if (elapsed >= 5000) {
      slot.packetRate = slot.pktCount / (elapsed / 1000);
      slot.pktCount = 0;
      slot.pktWindowStart = now;
    }
  }

  /** Adds an event listener and remembers it so a reconnect never stacks duplicate handlers. */
  _listen(kind, target, event, handler) {
    target.addEventListener(event, handler);
    this.slots[kind].listeners.push({ target, event, handler });
  }

  _teardown(kind) {
    const slot = this.slots[kind];
    slot.listeners.forEach(({ target, event, handler }) => {
      try { target.removeEventListener(event, handler); } catch (e) { /* ignore */ }
    });
    slot.listeners = [];
    slot.chars = {};
    slot.connectedSince = 0;
    if (kind === 'pedals') {
      this.lastCrankRevs = null;
      this.lastCrankTime = null;
      this.lastCadence = null;
    }
    if (kind === 'trainer') this.lastTargetPowerSent = null;
  }

  /** Serialises GATT writes for one device. */
  _write(kind, char, bytes) {
    const slot = this.slots[kind];
    const run = () => (char.writeValueWithResponse ? char.writeValueWithResponse(bytes) : char.writeValue(bytes));
    const p = slot.writeChain.then(run, run);
    slot.writeChain = p.catch(() => {});
    return p;
  }

  // ------------------------------------------------------------ status API --
  isTrainerConnected() {
    const s = this.slots.trainer;
    return !!(s.device && s.device.gatt && s.device.gatt.connected && s.chars.control);
  }
  isPedalsConnected() {
    const s = this.slots.pedals;
    return !!(s.device && s.device.gatt && s.device.gatt.connected && s.chars.measurement);
  }
  isHrConnected() {
    const s = this.slots.hr;
    return !!(s.device && s.device.gatt && s.device.gatt.connected && s.chars.measurement);
  }

  getState(kind) { return this.slots[kind] ? this.slots[kind].state : 'disconnected'; }

  /** Snapshot for the Hardware Diagnostics drawer. Values that the browser does not expose are null. */
  getDiagnostics(kind) {
    const s = this.slots[kind];
    const now = performance.now();
    return {
      name: s.device && s.device.name ? s.device.name : s.name,
      state: s.state,
      attempt: s.attempt,
      nextRetryMs: s.nextRetryAt ? Math.max(0, s.nextRetryAt - now) : 0,
      battery: s.battery,
      rssi: s.rssi,
      lastPacketAgeMs: s.lastPacket ? now - s.lastPacket : null,
      packetRate: s.packetRate || (s.pktCount && s.pktWindowStart ? s.pktCount / Math.max(1, (now - s.pktWindowStart) / 1000) : 0),
      connectedForMs: s.connectedSince ? now - s.connectedSince : 0
    };
  }

  async _request(kind, filters, optionalServices, acceptAll = false) {
    const opts = acceptAll ? { acceptAllDevices: true, optionalServices } : { filters, optionalServices };
    const device = await navigator.bluetooth.requestDevice(opts);
    this._adopt(kind, device);
    return device;
  }

  /** Makes `device` the one this slot drives (from the chooser, or a reconnect without it). */
  _adopt(kind, device) {
    const slot = this.slots[kind];
    if (slot.device && slot.device !== device && slot.onGattDisconnected) {
      slot.device.removeEventListener('gattserverdisconnected', slot.onGattDisconnected);
    }
    if (slot.device !== device) {
      slot.device = device;
      slot.onGattDisconnected = () => this._handleLinkLoss(kind);
      device.addEventListener('gattserverdisconnected', slot.onGattDisconnected);
    }
    slot.name = device.name || slot.name;
    slot.battery = null;
    slot.rssi = null;
    slot.lastError = null;
  }

  // ------------------------------------------------ reconnect without chooser --
  // requestDevice() needs a click on the PC (browser security), so the phone view cannot open
  // the chooser. It can reconnect a device that was already chosen: the BluetoothDevice kept from
  // this session, or - after a reload - one Chrome still has permission for (getDevices()),
  // matched by the id remembered at its last connection.
  static KNOWN_KEY = 'apex_ble_known_v1';

  _knownIds() {
    try { return JSON.parse(localStorage.getItem(VeloBle.KNOWN_KEY) || '{}') || {}; } catch (e) { return {}; }
  }

  _remember(kind, device) {
    if (!device || !device.id) return;
    const known = this._knownIds();
    known[kind] = { id: device.id, name: device.name || null };
    try { localStorage.setItem(VeloBle.KNOWN_KEY, JSON.stringify(known)); } catch (e) { /* storage blocked */ }
    this.permitted = { ...(this.permitted || {}), [kind]: device };
  }

  /** Looks up the devices Chrome still has permission for; resolves to { kind: BluetoothDevice }. */
  async refreshPermitted() {
    const found = {};
    const bt = typeof navigator !== 'undefined' ? navigator.bluetooth : null;
    if (bt && typeof bt.getDevices === 'function') {
      try {
        const known = this._knownIds();
        const devices = await bt.getDevices();
        Object.keys(this.slots).forEach((kind) => {
          const k = known[kind];
          const d = k && devices.find((x) => x.id === k.id);
          if (d) found[kind] = d;
        });
      } catch (e) { /* permissions backend unavailable - only this session's devices can reconnect */ }
    }
    this.permitted = found;
    return found;
  }

  /** True when `reconnect(kind)` can connect without the chooser. */
  canReconnect(kind) {
    return !!(this.slots[kind].device || (this.permitted && this.permitted[kind]));
  }

  /**
   * Connects the already-chosen device for `kind` without the chooser. Resolves to true / false
   * (connected / failed after the usual 3 tries), or null when no known device exists and it has
   * to be paired once on the PC.
   */
  async reconnect(kind) {
    const slot = this.slots[kind];
    if (slot.state === 'connecting' || slot.connecting) return false;
    if (slot.device && slot.device.gatt && slot.device.gatt.connected && slot.state === 'connected') return true;
    let device = slot.device || (this.permitted && this.permitted[kind]);
    if (!device) device = (await this.refreshPermitted())[kind];
    if (!device) return null;
    clearTimeout(slot.retryTimer);
    slot.retryTimer = null;
    slot.attempt = 0;
    slot.nextRetryAt = 0;
    this._adopt(kind, device);
    return this._connect(kind, this._setupFor(kind));
  }

  /** gatt.connect() can hang on Windows when the device went out of range; give up after timeoutMs. */
  static connectWithTimeout(device, timeoutMs = 15000) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { device.gatt.disconnect(); } catch (e) { /* ignore */ }
        reject(Object.assign(new Error('Connection timed out - is the device awake and in range?'), { name: 'TimeoutError' }));
      }, timeoutMs);
    });
    return Promise.race([device.gatt.connect(), timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * Chrome's answer when it has no record of the device, however close it is: it forgets a device
   * it has not seen in a Bluetooth scan for a few minutes, and every device when it restarts.
   */
  static isForgotten(err) {
    return !!err && /no longer in range/i.test(String(err.message || ''));
  }

  /**
   * gatt.connect(), with a short scan first when Chrome has forgotten the device. The chooser on
   * the PC scans, which is why connecting there always worked; a connect from the phone (or an
   * auto-reconnect) has no chooser, so it watches the device's advertisements until Chrome has
   * seen it again - that puts it back on Chrome's list - and then connects.
   */
  async _gattConnect(kind) {
    const slot = this.slots[kind];
    try {
      return await VeloBle.connectWithTimeout(slot.device, VeloBle.CONNECT_TIMEOUT_MS);
    } catch (err) {
      if (!VeloBle.isForgotten(err) || slot.manualDisconnect) throw err;
      const seen = await this._scanFor(kind, VeloBle.SCAN_TIMEOUT_MS);
      if (slot.manualDisconnect) throw err; // stopped by the user while scanning
      if (!seen) {
        const msg = seen === null
          ? 'Chrome has lost track of it and cannot scan for it here - pick it once on the PC'
          : `no signal from it in a ${Math.round(VeloBle.SCAN_TIMEOUT_MS / 1000)} s Bluetooth scan`;
        throw Object.assign(new Error(msg), { name: 'NotFoundError', needsChooser: seen === null });
      }
    }
    return VeloBle.connectWithTimeout(slot.device, VeloBle.CONNECT_TIMEOUT_MS);
  }

  /**
   * Watches the device's advertisements until one arrives. Resolves true once Chrome has seen it,
   * false when timeoutMs passes (asleep, off or out of range) or the user disconnects, and null
   * when this browser cannot watch advertisements.
   */
  _scanFor(kind, timeoutMs) {
    const slot = this.slots[kind];
    const device = slot.device;
    if (!device || typeof device.watchAdvertisements !== 'function' || typeof AbortController !== 'function') return Promise.resolve(null);
    // Chrome silently drops a watch when its window loses focus or is minimised, yet the page still
    // counts it as running, and watchAdvertisements() on a running watch does nothing. So end any
    // earlier watch (the RSSI one) first: aborting a signal passed to watchAdvertisements() resets it.
    if (device.watchingAdvertisements) {
      const old = new AbortController();
      device.watchAdvertisements({ signal: old.signal }).catch(() => { /* aborted just below */ });
      old.abort();
    }
    return new Promise((resolve) => {
      const ctl = new AbortController();
      let done = false;
      const finish = (seen) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        device.removeEventListener('advertisementreceived', onAdvert);
        if (slot.stopScan === stop) slot.stopScan = null;
        ctl.abort(); // stop scanning before connecting
        resolve(seen);
      };
      const onAdvert = (e) => {
        if (typeof e.rssi === 'number') slot.rssi = e.rssi;
        finish(true);
      };
      const stop = () => finish(false);
      const timer = setTimeout(stop, timeoutMs);
      slot.stopScan = stop;
      device.addEventListener('advertisementreceived', onAdvert);
      device.watchAdvertisements({ signal: ctl.signal }).catch(() => finish(null)); // cannot scan here
    });
  }

  /**
   * Connects and runs the device setup. A first (user-initiated) connection is tried up to
   * FIRST_CONNECT_ATTEMPTS times, because Windows often rejects the very first GATT connection
   * to a strap or power meter ("Connection attempt failed") and succeeds a moment later.
   * A device that a scan could not find is not tried again: it is not advertising.
   */
  async _connect(kind, setupFn, isRetry = false) {
    const slot = this.slots[kind];
    slot.manualDisconnect = false;
    slot.connecting = true;
    this._setState(kind, 'connecting');
    const attempts = isRetry ? 1 : VeloBle.FIRST_CONNECT_ATTEMPTS;
    try {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (slot.manualDisconnect && attempt > 1) break; // user cancelled while we were retrying
        try {
          const server = await this._gattConnect(kind);
          this._teardown(kind);
          // Wait for Windows BLE connection parameter update & MTU negotiation to settle
          await VeloBle.delay(600);
          await setupFn(server);
          await VeloBle.delay(200);
          await this._setupBattery(kind, server);
          if (slot.manualDisconnect) { // disconnected by the user while setup was still running
            try { slot.device.gatt.disconnect(); } catch (e) { /* ignore */ }
            this._teardown(kind);
            this._setState(kind, 'disconnected');
            return false;
          }
          slot.connectedSince = performance.now();
          slot.attempt = 0;
          slot.nextRetryAt = 0;
          slot.lastError = null;
          slot.connecting = false;
          this._remember(kind, slot.device);
          this._setState(kind, 'connected');
          this._watchRssi(kind);
          return true;
        } catch (err) {
          slot.lastError = err;
          console.warn(`[VeloBle] ${kind} connect attempt ${attempt}/${attempts} failed:`, err);
          this._teardown(kind);
          try { if (slot.device && slot.device.gatt.connected) slot.device.gatt.disconnect(); } catch (e) { /* ignore */ }
          if (err && err.name === 'NotFoundError') break; // not advertising: another try cannot reach it
          if (attempt < attempts) await VeloBle.delay(700 * attempt);
        }
      }
      if (!isRetry) {
        slot.manualDisconnect = true; // a failed first connect must not start the reconnect loop
        this._setState(kind, 'disconnected');
      }
      return false;
    } finally {
      slot.connecting = false;
    }
  }

  _handleLinkLoss(kind) {
    const slot = this.slots[kind];
    this._teardown(kind);
    if (slot.manualDisconnect || !slot.device) {
      if (slot.state !== 'disconnected') {
        this._setState(kind, 'disconnected');
        this._emit({ type: 'disconnect', device: kind, willReconnect: false });
      }
      return;
    }
    if (slot.inRetry || slot.connecting || slot.state === 'reconnecting') return; // the connect loop / reconnect scheduler owns this link
    this._emit({ type: 'disconnect', device: kind, willReconnect: true });
    this._scheduleReconnect(kind);
  }

  _scheduleReconnect(kind) {
    const slot = this.slots[kind];
    clearTimeout(slot.retryTimer);
    if (slot.attempt >= VeloBle.RECONNECT_MAX_ATTEMPTS) {
      slot.nextRetryAt = 0;
      this._setState(kind, 'failed');
      return;
    }
    const base = VeloMetrics.backoffDelay(slot.attempt, VeloBle.RECONNECT_BASE_MS, VeloBle.RECONNECT_CAP_MS);
    const delay = Math.round(base * (0.85 + Math.random() * 0.3)); // +/-15% jitter
    slot.nextRetryAt = performance.now() + delay;
    this._setState(kind, 'reconnecting', { nextRetryMs: delay });
    slot.retryTimer = setTimeout(async () => {
      if (slot.manualDisconnect || !slot.device) return;
      slot.attempt++;
      slot.inRetry = true;
      const ok = await this._connect(kind, this._setupFor(kind), true);
      slot.inRetry = false;
      if (ok) {
        this._emit({ type: 'reconnected', device: kind });
      } else if (!slot.manualDisconnect) {
        slot.state = 'reconnecting';
        this._scheduleReconnect(kind);
      }
    }, delay);
  }

  _setupFor(kind) {
    if (kind === 'trainer') return (server) => this._setupTrainer(server);
    if (kind === 'pedals') return (server) => this._setupPedals(server);
    return (server) => this._setupHr(server);
  }

  _disconnect(kind) {
    const slot = this.slots[kind];
    slot.manualDisconnect = true;
    clearTimeout(slot.retryTimer);
    slot.retryTimer = null;
    if (slot.stopScan) slot.stopScan();
    slot.attempt = 0;
    slot.nextRetryAt = 0;
    const wasActive = slot.state !== 'disconnected';
    try {
      if (slot.device && slot.device.gatt && slot.device.gatt.connected) slot.device.gatt.disconnect();
    } catch (e) { /* ignore */ }
    this._teardown(kind);
    if (wasActive) {
      this._setState(kind, 'disconnected');
      this._emit({ type: 'disconnect', device: kind, willReconnect: false });
    }
  }

  /** Stops an in-flight reconnect loop and forgets the device. */
  cancelReconnect(kind) { this._disconnect(kind); }

  async _setupBattery(kind, server) {
    const slot = this.slots[kind];
    try {
      const svc = await VeloBle.getServiceWithRetry(server, VeloBle.UUID.BATTERY, 'battery_service', 2, 250);
      await VeloBle.delay(100);
      const ch = await svc.getCharacteristic(VeloBle.UUID.BATTERY_LEVEL);
      const v = await ch.readValue();
      slot.battery = v.getUint8(0);
      this._emit({ type: 'battery', device: kind, level: slot.battery });
      if (ch.properties && ch.properties.notify) {
        try {
          await ch.startNotifications();
          this._listen(kind, ch, 'characteristicvaluechanged', (e) => {
            slot.battery = e.target.value.getUint8(0);
            this._emit({ type: 'battery', device: kind, level: slot.battery });
          });
        } catch (e) { /* battery notifications are optional */ }
      }
    } catch (e) {
      slot.battery = null; // device does not expose the Battery Service or read timed out
    }
  }

  /** RSSI is only exposed through advertisement watching (Chrome experimental); otherwise it stays null. */
  _watchRssi(kind) {
    const slot = this.slots[kind];
    const device = slot.device;
    if (!device || typeof device.watchAdvertisements !== 'function') return;
    if (slot.rssiDevice !== device) {
      slot.rssiDevice = device;
      device.addEventListener('advertisementreceived', (e) => {
        if (typeof e.rssi === 'number') slot.rssi = e.rssi;
      });
    }
    // Started on every connection: a scan for a forgotten device (_scanFor) ends the previous one.
    device.watchAdvertisements().catch(() => { /* not permitted - leave RSSI unavailable */ });
  }

  // ---------------------------------------------------------------- trainer --
  async connectTrainer(options = {}) {
    try {
      const filters = options.acceptAll ? undefined : [
        { services: [VeloBle.UUID.FTMS] },
        { services: ['fitness_machine'] },
        { namePrefix: 'KICKR' },
        { namePrefix: 'CORE' },
        { namePrefix: 'SHIFT' },
        { namePrefix: 'Trainer' },
        { namePrefix: 'Bike' }
      ];
      await this._request('trainer', filters,
        [VeloBle.UUID.FTMS, 'fitness_machine', 'cycling_speed_and_cadence', 'battery_service', 'device_information', VeloBle.UUID.CPS, 'cycling_power'],
        !!options.acceptAll);
      return await this._connect('trainer', (server) => this._setupTrainer(server));
    } catch (err) {
      console.error('FTMS Trainer connection failed:', err);
      this._setState('trainer', 'disconnected');
      throw err;
    }
  }

  async _setupTrainer(server) {
    const slot = this.slots.trainer;
    const service = await VeloBle.getServiceWithRetry(server, VeloBle.UUID.FTMS, 'fitness_machine', 3, 500);
    await VeloBle.delay(150);

    // Control Point (0x2AD9) MUST have indications enabled before any write (FTMS spec 4.16).
    const control = await service.getCharacteristic(VeloBle.UUID.FTMS_CONTROL);
    await VeloBle.delay(100);
    await control.startNotifications();
    this._listen('trainer', control, 'characteristicvaluechanged', (e) => this._onFtmsControlResponse(e.target.value));
    slot.chars.control = control;

    await VeloBle.delay(150);
    try {
      const range = await service.getCharacteristic(VeloBle.UUID.FTMS_POWER_RANGE);
      const rv = await range.readValue();
      this.powerRange = { min: rv.getInt16(0, true), max: rv.getInt16(2, true), inc: rv.getUint16(4, true) || 1 };
    } catch (e) { /* Supported Power Range is optional */ }

    await VeloBle.delay(150);
    await this._write('trainer', control, new Uint8Array([VeloBle.FTMS_OP.REQUEST_CONTROL]));

    await VeloBle.delay(150);
    try {
      const data = await service.getCharacteristic(VeloBle.UUID.FTMS_BIKE_DATA);
      await data.startNotifications();
      this._listen('trainer', data, 'characteristicvaluechanged', (e) => {
        this._markPacket('trainer');
        const parsed = VeloBle.parseIndoorBikeData(e.target.value);
        this._emit({ type: 'trainer', name: slot.device ? slot.device.name : slot.name, ...parsed });
      });
      slot.chars.data = data;
    } catch (dataErr) {
      console.warn('FTMS Indoor Bike Data unavailable:', dataErr);
    }
    this.lastTargetPowerSent = null;
    this.lastTargetSendTime = 0;
  }

  _onFtmsControlResponse(dv) {
    if (dv.byteLength < 3 || dv.getUint8(0) !== VeloBle.FTMS_OP.RESPONSE) return;
    const requestOpCode = dv.getUint8(1);
    const result = dv.getUint8(2);
    const ok = result === 0x01;
    this._emit({ type: 'ftms_response', ok, requestOpCode, result });
    // 0x05 = Control Not Permitted: another app grabbed control or the trainer rebooted - request it again.
    if (result === 0x05 && this.slots.trainer.chars.control) {
      this._write('trainer', this.slots.trainer.chars.control, new Uint8Array([VeloBle.FTMS_OP.REQUEST_CONTROL])).catch(() => {});
      this.lastTargetPowerSent = null;
    }
  }

  /** Parses FTMS Indoor Bike Data (0x2AD2). Absent fields are null. */
  static parseIndoorBikeData(dv) {
    const flags = dv.getUint16(0, true);
    let o = 2;
    const out = { watts: null, cadence: null, speed: null, distanceMeters: null };
    const has = (bytes) => o + bytes <= dv.byteLength;
    if ((flags & 0x0001) === 0 && has(2)) { out.speed = dv.getUint16(o, true) * 0.01; o += 2; } // bit0 More Data = 0 -> speed present
    if (flags & 0x0002) o += 2;                                                                   // average speed
    if ((flags & 0x0004) && has(2)) { out.cadence = Math.round(dv.getUint16(o, true) * 0.5); o += 2; }
    if (flags & 0x0008) o += 2;                                                                   // average cadence
    if ((flags & 0x0010) && has(3)) { out.distanceMeters = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16); o += 3; }
    if (flags & 0x0020) o += 2;                                                                   // resistance level
    if ((flags & 0x0040) && has(2)) { out.watts = dv.getInt16(o, true); o += 2; }
    return out;
  }

  disconnectTrainer() { this._disconnect('trainer'); }

  async startTrainerWorkout() {
    const c = this.slots.trainer.chars.control;
    if (!c) return;
    try { await this._write('trainer', c, new Uint8Array([VeloBle.FTMS_OP.START_RESUME])); } catch (e) { /* ignore */ }
  }

  async pauseTrainerWorkout() {
    const c = this.slots.trainer.chars.control;
    if (!c) return;
    try { await this._write('trainer', c, new Uint8Array([VeloBle.FTMS_OP.STOP_PAUSE, 0x02])); } catch (e) { /* ignore */ }
  }

  async stopTrainerWorkout() {
    const c = this.slots.trainer.chars.control;
    if (!c) return;
    try { await this._write('trainer', c, new Uint8Array([VeloBle.FTMS_OP.STOP_PAUSE, 0x01])); } catch (e) { /* ignore */ }
  }

  /** Sends an ERG target. Throttled: only on change, plus a 4 s keep-alive. */
  async setTrainerErgPower(watts, force = false) {
    const c = this.slots.trainer.chars.control;
    if (!c) return;
    const lo = Math.max(0, this.powerRange.min || 0);
    const hi = Math.min(2000, this.powerRange.max || 2000);
    const clampedWatts = Math.max(lo, Math.min(hi, Math.round(watts)));
    const now = performance.now();
    if (!force && this.lastTargetPowerSent === clampedWatts && (now - this.lastTargetSendTime) < 4000) return;
    this.lastTargetPowerSent = clampedWatts;
    this.lastTargetSendTime = now;
    const buf = new Uint8Array(3);
    new DataView(buf.buffer).setUint8(0, VeloBle.FTMS_OP.SET_TARGET_POWER);
    new DataView(buf.buffer).setInt16(1, clampedWatts, true);
    try {
      await this._write('trainer', c, buf);
    } catch (e) {
      this.lastTargetPowerSent = null; // retry on next tick
      console.warn('FTMS setTrainerErgPower write failed:', e);
    }
  }

  // ----------------------------------------------------------------- pedals --
  async connectPedals(options = {}) {
    try {
      const filters = options.acceptAll ? undefined : [
        { services: [VeloBle.UUID.CPS] },
        { services: ['cycling_power'] },
        { namePrefix: 'Assioma' },
        { namePrefix: 'ASSIOMA' },
        { namePrefix: 'Favero' },
        { namePrefix: 'DUO' },
        { namePrefix: 'Duo' },
        { namePrefix: 'Pedal' }
      ];
      await this._request('pedals', filters,
        [VeloBle.UUID.CPS, 'cycling_power', 'battery_service', 'device_information', VeloBle.UUID.FTMS, 'fitness_machine'],
        !!options.acceptAll);
      return await this._connect('pedals', (server) => this._setupPedals(server));
    } catch (err) {
      console.error('CPS Pedal connection failed:', err);
      this._setState('pedals', 'disconnected');
      throw err;
    }
  }

  async _setupPedals(server) {
    const slot = this.slots.pedals;
    const service = await VeloBle.getServiceWithRetry(server, VeloBle.UUID.CPS, 'cycling_power', 3, 500);
    await VeloBle.delay(150);
    const meas = await service.getCharacteristic(VeloBle.UUID.CPS_MEASUREMENT);
    await VeloBle.delay(100);
    await meas.startNotifications();
    this._listen('pedals', meas, 'characteristicvaluechanged', (e) => {
      this._markPacket('pedals');
      const parsed = this._parseCpsMeasurement(e.target.value);
      this._emit({ type: 'pedals', name: slot.device ? slot.device.name : slot.name, ...parsed });
    });
    slot.chars.measurement = meas;

    await VeloBle.delay(150);
    try {
      const ctrl = await service.getCharacteristic(VeloBle.UUID.CPS_CONTROL);
      await VeloBle.delay(100);
      await ctrl.startNotifications(); // indications required before writing the control point
      this._listen('pedals', ctrl, 'characteristicvaluechanged', (e) => {
        const r = VeloBle.parseCpsControlResponse(e.target.value);
        if (r) this._emit({ type: 'calibration_response', ...r });
      });
      slot.chars.control = ctrl;
    } catch (ctrlErr) {
      console.warn('CPS Control Point (0x2A66) unavailable:', ctrlErr);
    }
  }

  /** Parses a CPS Control Point response to an offset-compensation request. */
  static parseCpsControlResponse(dv) {
    if (dv.byteLength < 3 || dv.getUint8(0) !== VeloBle.CPS_OP.RESPONSE) return null;
    const req = dv.getUint8(1);
    if (req !== VeloBle.CPS_OP.START_OFFSET_COMPENSATION && req !== VeloBle.CPS_OP.START_ENHANCED_OFFSET_COMPENSATION) return null;
    const code = dv.getUint8(2);
    const success = code === 0x01;
    const offset = (success && dv.byteLength >= 5) ? dv.getInt16(3, true) : null;
    return { success, offset, code };
  }

  /** Parses CPS Measurement (0x2A63). Cadence is derived from crank revolution events. */
  _parseCpsMeasurement(dv) {
    const flags = dv.getUint16(0, true);
    const watts = dv.getInt16(2, true);
    let o = 4;
    let leftPct = null;
    if (flags & 0x0001) {                           // bit0: pedal power balance present (0.5 % units)
      const bal = dv.getUint8(o) * 0.5;
      const refIsLeft = (flags & 0x0002) !== 0;      // bit1: balance reference = left
      leftPct = Math.max(0, Math.min(100, Math.round((refIsLeft ? bal : 100 - bal) * 10) / 10));
      o += 1;
    }
    let torqueNm = null;
    if (flags & 0x0004) { torqueNm = Math.round((dv.getUint16(o, true) / 32) * 10) / 10; o += 2; } // accumulated torque
    if (flags & 0x0010) o += 6;                      // wheel revolution data

    let cadence = null;
    if ((flags & 0x0020) && o + 4 <= dv.byteLength) {
      const revs = dv.getUint16(o, true);
      const evtTime = dv.getUint16(o + 2, true);
      const now = performance.now();
      if (this.lastCrankRevs !== null && this.lastCrankTime !== null) {
        const dRevs = (revs - this.lastCrankRevs) & 0xFFFF;
        const dTime = ((evtTime - this.lastCrankTime) & 0xFFFF) / 1024;
        if (dRevs > 0 && dTime > 0) {
          const c = Math.round((dRevs / dTime) * 60);
          if (c >= 15 && c <= 220) { cadence = c; this.lastCadence = c; }
          this.lastCrankChangeMs = now;
        } else if (now - this.lastCrankChangeMs > 3000) {
          cadence = 0;                                 // no crank event for 3 s: rider stopped pedalling
          this.lastCadence = 0;
        } else {
          cadence = this.lastCadence;                  // between crank events: hold the last true value
        }
      } else {
        this.lastCrankChangeMs = now;
      }
      this.lastCrankRevs = revs;
      this.lastCrankTime = evtTime;
    }
    return {
      watts,
      leftPct,
      rightPct: leftPct === null ? null : Math.round((100 - leftPct) * 10) / 10,
      cadence,
      torque: torqueNm
    };
  }

  disconnectPedals() { this._disconnect('pedals'); }

  /** Starts CPS Offset Compensation (op code 0x0C). Pedals must be unloaded and static. */
  async calibratePedals() {
    const ctrl = this.slots.pedals.chars.control;
    if (!ctrl) throw new Error('Assioma control point not available or pedals disconnected');
    await this._write('pedals', ctrl, new Uint8Array([VeloBle.CPS_OP.START_OFFSET_COMPENSATION]));
    return true;
  }

  // --------------------------------------------------------------------- HR --
  async connectHr(options = {}) {
    try {
      const filters = options.acceptAll ? undefined : [
        { services: ['heart_rate'] },
        { services: [VeloBle.UUID.HRS] },
        { namePrefix: 'WHOOP' },
        { namePrefix: 'Whoop' },
        { namePrefix: 'whoop' },
        { namePrefix: 'Polar' },
        { namePrefix: 'Garmin' },
        { namePrefix: 'Wahoo' },
        { namePrefix: 'TICKR' },
        { namePrefix: 'HR' },
        { namePrefix: 'Heart' }
      ];
      await this._request('hr', filters,
        [VeloBle.UUID.HRS, 'heart_rate', 'battery_service', 'device_information'],
        !!options.acceptAll);
      return await this._connect('hr', (server) => this._setupHr(server));
    } catch (err) {
      console.error('HRS Heart Rate connection failed:', err);
      this._setState('hr', 'disconnected');
      throw err;
    }
  }

  async _setupHr(server) {
    const slot = this.slots.hr;
    const service = await VeloBle.getServiceWithRetry(server, VeloBle.UUID.HRS, 'heart_rate', 3, 500);
    await VeloBle.delay(150);
    const ch = await service.getCharacteristic(VeloBle.UUID.HRS_MEASUREMENT);
    await VeloBle.delay(100);
    await ch.startNotifications();
    this._listen('hr', ch, 'characteristicvaluechanged', (e) => {
      this._markPacket('hr');
      const parsed = VeloBle.parseHeartRate(e.target.value);
      this._emit({ type: 'hr', ...parsed });
    });
    slot.chars.measurement = ch;
  }

  /**
   * Parses Heart Rate Measurement (0x2A37). Returns hr = null when the strap reports no skin
   * contact or a 0 bpm value (a Polar H10 keeps notifying 0 while the electrodes are dry or off).
   */
  static parseHeartRate(dv) {
    if (!dv || dv.byteLength < 2) return { hr: null, contact: null };
    const flags = dv.getUint8(0);
    const wide = (flags & 0x01) !== 0;
    if (wide && dv.byteLength < 3) return { hr: null, contact: null };
    const raw = wide ? dv.getUint16(1, true) : dv.getUint8(1);
    const contactSupported = (flags & 0x04) !== 0;
    const contact = contactSupported ? (flags & 0x02) !== 0 : null;
    const hr = (raw > 0 && raw < 255 && contact !== false) ? raw : null;
    return { hr, contact };
  }

  disconnectHr() { this._disconnect('hr'); }
}

if (typeof window !== 'undefined') window.VeloBle = VeloBle;
