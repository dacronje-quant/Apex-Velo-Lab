/**
 * Browser-test stand-in for the native side (loaded with page.addInitScript before the app).
 * window.__APEX_NATIVE_FAKE__ gives the Android layer a scripted FTMS trainer and heart-rate strap
 * (BleClient API), a scripted Strava (CapacitorHttp API) and recording plugin stubs.
 * Never part of the app build.
 */
(() => {
  const FTMS = '00001826-0000-1000-8000-00805f9b34fb', HRS = '0000180d-0000-1000-8000-00805f9b34fb';
  const uuid16 = (n) => '0000' + n.toString(16).padStart(4, '0') + '-0000-1000-8000-00805f9b34fb';
  const log = window.__nativeLog = { writes: [], http: [], opened: [], keepAwake: [], shared: [], scans: 0 };
  const listeners = window.__nativeListeners = {};
  const notify = new Map();
  const disconnectCb = new Map();
  const connected = new Set();
  const devices = {
    'AA:00:00:00:00:01': { name: 'KICKR CORE 1A2B', uuids: [FTMS], rssi: -52 },
    'AA:00:00:00:00:02': { name: 'TICKR 77', uuids: [HRS], rssi: -60 }
  };
  const services = {
    'AA:00:00:00:00:01': [
      { uuid: FTMS, characteristics: [
        { uuid: uuid16(0x2ad9), properties: { write: true, indicate: true } },
        { uuid: uuid16(0x2ad2), properties: { notify: true } },
        { uuid: uuid16(0x2ad8), properties: { read: true } }] },
      { uuid: uuid16(0x180f), characteristics: [{ uuid: uuid16(0x2a19), properties: { read: true, notify: true } }] }],
    'AA:00:00:00:00:02': [{ uuid: HRS, characteristics: [{ uuid: uuid16(0x2a37), properties: { notify: true } }] }]
  };
  const dv = (bytes) => new DataView(Uint8Array.from(bytes).buffer);
  const key = (id, s, c) => `${id}|${s}|${c}`.toLowerCase();
  const send = (id, s, c, bytes) => { const cb = notify.get(key(id, s, c)); if (cb) cb(dv(bytes)); };
  let scanCb = null;

  // Trainer data at 1 Hz: speed 32 km/h, cadence 90 rpm, power 200 W (FTMS Indoor Bike Data).
  setInterval(() => {
    if (connected.has('AA:00:00:00:00:01')) send('AA:00:00:00:00:01', FTMS, uuid16(0x2ad2), [0x44, 0x00, 0x80, 0x0c, 180, 0, 200, 0]);
    if (connected.has('AA:00:00:00:00:02')) send('AA:00:00:00:00:02', HRS, uuid16(0x2a37), [0x00, 142]);
  }, 1000);

  const ble = {
    async initialize() {}, async isEnabled() { return true; }, async requestEnable() {},
    async requestLEScan(opts, cb) {
      log.scans++; scanCb = cb;
      setTimeout(() => { for (const [id, d] of Object.entries(devices)) if (scanCb) scanCb({ device: { deviceId: id, name: d.name }, localName: d.name, rssi: d.rssi, uuids: d.uuids }); }, 50);
    },
    async stopLEScan() { scanCb = null; },
    async connect(id, onDisconnect) {
      if (!devices[id]) throw new Error('Device not found');
      if (window.__failConnect) throw new Error('Connection timeout');
      connected.add(id); disconnectCb.set(id, onDisconnect);
    },
    async disconnect(id) { connected.delete(id); },
    async getServices(id) { return services[id]; },
    async read(id, s, c) {
      if (c === uuid16(0x2ad8)) return dv([0, 0, 0xd0, 0x07, 1, 0]); // power range 0..2000 W, 1 W steps
      if (c === uuid16(0x2a19)) return dv([77]);
      throw new Error('not readable');
    },
    async write(id, s, c, value) {
      const bytes = [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)];
      log.writes.push({ id, c, bytes });
      if (c === uuid16(0x2ad9)) setTimeout(() => send(id, s, c, [0x80, bytes[0], 0x01]), 5); // FTMS: success
    },
    async writeWithoutResponse(id, s, c, value) { return this.write(id, s, c, value); },
    async startNotifications(id, s, c, cb) { notify.set(key(id, s, c), cb); },
    async stopNotifications(id, s, c) { notify.delete(key(id, s, c)); }
  };
  /** Drops the trainer link the way Android reports it. */
  window.__dropTrainer = () => { const id = 'AA:00:00:00:00:01'; connected.delete(id); const cb = disconnectCb.get(id); if (cb) cb(id); };

  // ------------------------------------------------------------------------- Strava --
  const strava = { uploadPolls: 0 };
  const http = {
    async request(opts) {
      log.http.push(opts);
      const u = new URL(opts.url);
      const ok = (data, headers = {}) => ({ status: 200, headers: { 'Content-Type': 'application/json', ...headers }, data });
      if (u.pathname === '/oauth/token') {
        if (opts.data.grant_type === 'authorization_code' && opts.data.code === 'good-code') return ok({ access_token: 'acc1', refresh_token: 'ref1', expires_at: Math.floor(Date.now() / 1000) + 3600, athlete: { id: 7, firstname: 'Test', lastname: 'Rider' } });
        if (opts.data.grant_type === 'refresh_token') return ok({ access_token: 'acc2', refresh_token: 'ref2', expires_at: Math.floor(Date.now() / 1000) + 3600 });
        return { status: 400, headers: {}, data: { message: 'Bad Request' } };
      }
      if (u.pathname === '/oauth/deauthorize') return ok({});
      if (opts.headers.Authorization !== 'Bearer acc1' && opts.headers.Authorization !== 'Bearer acc2') return { status: 401, headers: {}, data: { message: 'Authorization Error' } };
      if (u.pathname === '/api/v3/uploads' && opts.method === 'POST') return ok({ id: 991, id_str: '991', status: 'Your activity is still being processed.', error: null, activity_id: null });
      if (u.pathname === '/api/v3/uploads/991') return ok(++strava.uploadPolls < 2 ? { id: 991, status: 'processing', activity_id: null } : { id: 991, status: 'Your activity is ready.', activity_id: 5550001 });
      if (u.pathname === '/api/v3/athlete/activities') return ok([
        { id: 4001, name: 'Morning Ride', sport_type: 'Ride', type: 'Ride', start_date: '2026-10-10T06:00:00Z', start_date_local: '2026-10-10T08:00:00Z', moving_time: 3600, elapsed_time: 3700, distance: 30000, average_watts: 180, trainer: false }
      ], { 'X-ReadRateLimit-Usage': '3,40', 'X-ReadRateLimit-Limit': '100,1000' });
      if (u.pathname === '/api/v3/activities/4001') return ok({ id: 4001, name: 'Morning Ride', sport_type: 'Ride', start_date: '2026-10-10T06:00:00Z', moving_time: 3600, elapsed_time: 3700, description: 'Nice', calories: 700 });
      if (u.pathname === '/api/v3/activities/4001/streams') return ok({ watts: { data: [100, 200] }, time: { data: [0, 1] } });
      return { status: 404, headers: {}, data: { message: 'Record Not Found' } };
    }
  };

  const prefsStore = new Map();
  const plugins = {
    App: {
      addListener(name, cb) { (listeners[name] = listeners[name] || []).push(cb); return Promise.resolve({ remove() {} }); },
      async getLaunchUrl() { return undefined; },
      async minimizeApp() { log.minimized = (log.minimized || 0) + 1; }
    },
    Browser: { async open({ url }) { log.opened.push(url); }, async close() {} },
    KeepAwake: { async keepAwake() { log.keepAwake.push('on'); }, async allowSleep() { log.keepAwake.push('off'); } },
    Filesystem: { async writeFile({ path, data }) { return { uri: 'file:///cache/' + path, size: data.length }; } },
    Share: { async share(o) { log.shared.push(o); } }
  };
  window.__fireNative = (name, data) => Promise.all((listeners[name] || []).map((cb) => cb(data)));
  window.__APEX_NATIVE_FAKE__ = {
    ble, http, plugins,
    prefs: { async get(k) { return prefsStore.has(k) ? prefsStore.get(k) : null; }, async set(k, v) { prefsStore.set(k, v); }, async remove(k) { prefsStore.delete(k); } }
  };
})();
