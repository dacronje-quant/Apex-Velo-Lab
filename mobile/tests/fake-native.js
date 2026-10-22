/**
 * Browser-test stand-in for the native side (loaded with page.addInitScript before the app).
 * window.__APEX_NATIVE_FAKE__ gives the Android layer a scripted FTMS trainer and heart-rate strap
 * (BleClient API), a scripted Strava (uploads only), Claude and intervals.icu API (CapacitorHttp API) and recording plugin stubs.
 * Never part of the app build.
 */
(() => {
  const FTMS = '00001826-0000-1000-8000-00805f9b34fb', HRS = '0000180d-0000-1000-8000-00805f9b34fb';
  const uuid16 = (n) => '0000' + n.toString(16).padStart(4, '0') + '-0000-1000-8000-00805f9b34fb';
  const log = window.__nativeLog = { writes: [], http: [], opened: [], keepAwake: [], shared: [], files: [], scans: 0 };
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
      // ------------------------------------------------------------ AI (Claude) --
      if (u.host === 'api.anthropic.com') {
        if (opts.headers['x-api-key'] !== window.__aiKey) return { status: 401, headers: {}, data: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } };
        if (u.pathname === '/v1/models') return ok({ data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }, { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' }] });
        if (u.pathname === '/v1/messages') {
          if (/DIRECT WORKOUT REQUEST/.test(opts.data.messages[0].content)) {
            const iv = [{ name: 'Warmup', duration: 600, pctFtp: 55 }];
            for (let i = 1; i <= 5; i++) iv.push({ name: `VO2 ${i}`, duration: 180, pctFtp: 115, cadence: 105 }, ...(i < 5 ? [{ name: `Easy ${i}`, duration: 180, pctFtp: 50 }] : []));
            iv.push({ name: 'Cooldown', duration: 300, pctFtp: 45 });
            return ok({ model: opts.data.model, stop_reason: 'end_turn', usage: { input_tokens: 400, output_tokens: 300 },
              content: [{ type: 'text', text: JSON.stringify({ title: 'Five by Three at 115%', category: 'vo2', desc: 'Five 3-minute efforts at 115% FTP.', intervals: iv }) }] });
          }
          const ask = Array.isArray(opts.data.system);
          return ok({ model: opts.data.model, stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 60 },
            content: [{ type: 'thinking', thinking: 'Looking at the data.' }, { type: 'text', text: ask ? 'You rode **1 ride** this week (test answer).' : 'Steps held well (test breakdown).' }] });
        }
      }
      // ------------------------------------------------------------ intervals.icu --
      if (u.host === 'intervals.icu') {
        if (opts.headers.Authorization !== 'Basic ' + btoa('API_KEY:' + window.__icuKey)) return { status: 401, headers: {}, data: { status: 401, error: 'Access denied' } };
        if (u.pathname === '/api/v1/athlete/0') return ok({ id: 'i4242', name: 'Test Rider' });
        if (u.pathname === '/api/v1/athlete/0/wellness') {
          // 30 days of Apple Watch data (SDNN, as HealthFit sends it), steady so readiness is green.
          const newest = u.searchParams.get('newest'), rows = [];
          for (let i = 29; i >= 0; i--) {
            const d = new Date(newest + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - i);
            rows.push({ id: d.toISOString().slice(0, 10), restingHR: 48 + (i % 3), hrvSDNN: 62 + (i % 3), hrv: i < 3 ? 70 : null, sleepSecs: 27000 + (i % 4) * 600, DeepSleep: 3600, LightSleep: 18000, REMSleep: 5400, weight: 72,
              avgSleepingHR: 52 + (i % 3), sleepScore: 80 + (i % 5), readiness: 70 + (i % 7), baevskySI: 110.5, respiration: 14.6, spO2: 96.8, steps: 8000 + i * 10, vo2max: 54 });
          }
          rows.push({ id: '2020-01-01', weight: 70 }); // a day without recovery data
          return ok(rows.filter((r) => r.id >= u.searchParams.get('oldest') || r.id === '2020-01-01'));
        }
      }
      if (window.__stravaOffline && u.host === 'www.strava.com') throw new Error('Unable to resolve host "www.strava.com"');
      if (opts.headers.Authorization !== 'Bearer acc1' && opts.headers.Authorization !== 'Bearer acc2') return { status: 401, headers: {}, data: { message: 'Authorization Error' } };
      if (u.pathname === '/api/v3/uploads' && opts.method === 'POST') return ok({ id: 991, id_str: '991', status: 'Your activity is still being processed.', error: null, activity_id: null });
      if (u.pathname === '/api/v3/uploads/991') return ok(++strava.uploadPolls < 2 ? { id: 991, status: 'processing', activity_id: null } : { id: 991, status: 'Your activity is ready.', activity_id: 5550001 });
      // No activity reads: the phone is upload-only (the browser test checks none are made).
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
    Filesystem: {
      async requestPermissions() { return { publicStorage: 'granted' }; },
      async mkdir() { if (log.files.length) throw new Error('Directory exists'); },
      async writeFile({ path, data, directory }) {
        // A file left by an earlier install cannot be replaced on Android 11+.
        if (directory === 'DOCUMENTS' && (window.__takenFiles || []).includes(path)) throw new Error('EACCES (Permission denied)');
        log.files.push({ path, data, directory });
        return { uri: 'file:///' + directory.toLowerCase() + '/' + path };
      }
    },
    Share: { async share(o) { log.shared.push(o); } }
  };
  // ------------------------------------------------------------------------- SQLite --
  // The runner exposes __sqlite(op, sql, params) and __backupFiles(op, ...) over node:sqlite and a folder.
  // window.__noSqlite = true starts the app as it was before the phone database (WebView storage only).
  const sqlite = {
    exec: (sql) => window.__sqlite('exec', sql),
    run: (sql, params = []) => window.__sqlite('run', sql, params),
    all: (sql, params = []) => window.__sqlite('all', sql, params),
    begin: () => window.__sqlite('begin'), commit: () => window.__sqlite('commit'), rollback: () => window.__sqlite('rollback'),
    async close() {}
  };
  const b64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
  const backupFiles = {
    write: (name, bytes) => window.__backupFiles('write', name, b64(bytes)),
    append: (name, bytes) => window.__backupFiles('append', name, b64(bytes)),
    read: async (name) => Uint8Array.from(atob(await window.__backupFiles('read', name)), (c) => c.charCodeAt(0)),
    list: () => window.__backupFiles('list'), stat: (name) => window.__backupFiles('stat', name),
    rename: (from, to) => window.__backupFiles('rename', from, to), remove: (name) => window.__backupFiles('remove', name)
  };
  // ---------------------------------------------------------------- ApexImport --
  // The native import plugin. Its folder, inbox and file reads are served by window.__importFs (exposed by
  // tests/native-browser.cjs from a real folder); without it there is no folder and the inbox is empty.
  const importLog = log.import = { opened: 0, reads: 0, closed: 0, seen: null, maxRead: 0 };
  const importListeners = {};
  const importFs = (...a) => (window.__importFs ? window.__importFs(...a) : Promise.resolve(null));
  const importPlugin = {
    async getFolder() { return (await importFs('getFolder')) || { uri: null }; },
    async pickFolder() { return importFs('pickFolder'); },
    async removeFolder() { await importFs('removeFolder'); },
    async listFolder() { const r = await importFs('listFolder'); if (!r) throw new Error('No folder is watched.'); return r; },
    async setSeen({ stamps }) { importLog.seen = stamps; },
    async listInbox() { return (await importFs('listInbox')) || { files: [] }; },
    async removeInbox({ uri }) { await importFs('removeInbox', uri); },
    async open({ uri }) { const r = await importFs('open', uri); if (!r) throw new Error('Could not open the file.'); importLog.opened++; return r; },
    async read({ handle, length }) { importLog.reads++; importLog.maxRead = Math.max(importLog.maxRead, length); return importFs('read', handle, length); },
    async close({ handle }) { importLog.closed++; await importFs('close', handle); },
    async closeAll() { await importFs('closeAll'); },
    addListener(name, cb) { (importListeners[name] = importListeners[name] || []).push(cb); return Promise.resolve({ remove() {} }); }
  };
  window.__fireImport = (name, data) => Promise.all((importListeners[name] || []).map((cb) => cb(data)));

  window.__fireNative = (name, data) => Promise.all((listeners[name] || []).map((cb) => cb(data)));
  window.__APEX_NATIVE_FAKE__ = {
    ble, http, plugins, importPlugin,
    get sqlite() { return window.__noSqlite || !window.__sqlite ? undefined : sqlite; },
    backupFiles,
    prefs: { async get(k) { return prefsStore.has(k) ? prefsStore.get(k) : null; }, async set(k, v) { prefsStore.set(k, v); }, async remove(k) { prefsStore.delete(k); } }
  };
})();
