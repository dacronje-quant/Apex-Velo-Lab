// End-to-end check of the Android layer in Chromium: the built www/ served at https://localhost (the
// origin Capacitor uses), with tests/fake-native.js standing in for the BLE plugin, native HTTP and
// the other plugins. Covers pairing, ERG control, recording and saving a ride, auto-reconnect,
// Strava sign-in and upload-only (ledger, auto-upload, offline retry queue), the on-phone AI engine (API key, Ask, coach),
// intervals.icu health, bulk history import and the phone's SQLite store (node:sqlite stands in for the plugin), including
// the move of earlier WebView data into it and the upload ledger in SQLite. Run `npm run build` first.
const { chromium } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const www = path.resolve(__dirname, '..', 'www');
const ORIGIN = 'https://localhost';
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const executablePath = process.env.APEX_CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const step = (name) => console.log('  ok -', name);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-native-browser-'));

/**
 * The phone database and snapshot folder of one browser context: tests/fake-native.js calls these through
 * exposed functions. `hooks.failRideWrite = n` makes the n-th ride write fail once (the app being killed).
 */
async function phoneStorage(context, name) {
  const dir = path.join(tmpRoot, name), backups = path.join(dir, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'apex.sqlite'));
  const hooks = { failRideWrite: 0 };
  await context.exposeFunction('__sqlite', (op, sql, params = []) => {
    if (op === 'exec') db.exec(sql);
    else if (op === 'run') {
      if (hooks.failRideWrite && /INTO rides/.test(sql) && --hooks.failRideWrite === 0) throw new Error('app killed during the move');
      db.prepare(sql).run(...params);
    } else if (op === 'all') return db.prepare(sql).all(...params).map((r) => ({ ...r }));
    else if (op === 'begin') db.exec('BEGIN IMMEDIATE');
    else if (op === 'commit') db.exec('COMMIT');
    else if (op === 'rollback') { if (db.isTransaction) db.exec('ROLLBACK'); }
    return null;
  });
  const at = (n) => path.join(backups, path.basename(n));
  await context.exposeFunction('__backupFiles', (op, a, b) => {
    if (op === 'write') fs.writeFileSync(at(a), Buffer.from(b, 'base64'));
    else if (op === 'append') fs.appendFileSync(at(a), Buffer.from(b, 'base64'));
    else if (op === 'read') return fs.readFileSync(at(a)).toString('base64');
    else if (op === 'list') return fs.readdirSync(backups);
    else if (op === 'stat') { try { const st = fs.statSync(at(a)); return { size: st.size, mtimeMs: st.mtimeMs }; } catch { return null; } }
    else if (op === 'rename') fs.renameSync(at(a), at(b));
    else if (op === 'remove') fs.unlinkSync(at(a));
    return null;
  });
  return { db, hooks, backups };
}

async function newContext(browser) {
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  await context.addInitScript({ path: path.join(__dirname, 'fake-native.js') });
  await context.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    const file = path.resolve(www, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)));
    if (!file.startsWith(www + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(file)] || 'application/octet-stream' });
  });
  return context;
}

/** An earlier install kept its rides in WebView storage; the first start after the update moves them into SQLite. */
async function migrationFlow(browser, errors) {
  const context = await newContext(browser);
  const phone = await phoneStorage(context, 'migration');
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  // sessionStorage survives reloads: until the test sets it, the app starts as the version before the update.
  await page.addInitScript(() => { if (!sessionStorage.getItem('apexTestSqlite')) window.__noSqlite = true; });
  // Records what the "moving your rides" overlay says while it is up.
  await page.addInitScript(() => {
    window.__migrationSeen = [];
    new MutationObserver(() => { const el = document.getElementById('nativeMigration'); if (el) window.__migrationSeen.push(el.textContent); })
      .observe(document, { childList: true, subtree: true, characterData: true });
  });
  await page.goto(`${ORIGIN}/index.html`);
  await page.waitForFunction(() => window.app && window.ApexNative);
  assert.equal(await page.evaluate(() => VeloStorage.enabled), false);
  const samples = Array.from({ length: 600 }, (_, i) => ({ time: i + 1, power: 180 + (i % 40), hr: 130 + (i % 9), cadence: 88, timestamp: Date.parse('2026-10-05T07:00:00Z') + i * 1000 }));
  await page.evaluate(async (s) => {
    localStorage.setItem('apex_erg_response', 'steady');
    app.completedWorkouts.push({ id: 'ride_before_update', date: '2026-10-05T07:00:00.000Z', profileName: app.activeProfile.name, title: 'Ridden before the update',
      duration: 600, durationMin: 10, avgWatts: 199, np: 201, tss: 9, samplesCount: s.length, source: 'APEX VELO Cockpit', samples: s });
    for (let i = 1; i <= 5; i++) app.completedWorkouts.push({ id: 'ride_earlier_' + i, date: `2026-09-0${i}T07:00:00.000Z`, profileName: app.activeProfile.name, title: 'Earlier ride ' + i,
      duration: 60, durationMin: 1, avgWatts: 150, samplesCount: 2, source: 'APEX VELO Cockpit', samples: [{ time: 1, power: 150 }, { time: 2, power: 151 }] });
    if ((await app.saveHistory()) === false) throw new Error('the old app could not save');
  }, samples);
  assert.equal((await page.evaluate(() => VeloDB.getAllRides())).find((r) => r.id === 'ride_before_update').samples.length, 600);

  // First start after the update is killed half-way through the move: nothing is half-written, the app keeps the WebView data.
  await page.evaluate(() => sessionStorage.setItem('apexTestSqlite', '1'));
  phone.hooks.failRideWrite = 1;
  await page.reload();
  await page.waitForFunction(() => window.app && window.ApexNative);
  assert.equal(await page.evaluate(() => VeloStorage.enabled), false);
  assert.match(await page.evaluate(() => VeloStorage.error), /app killed during the move/);
  assert.match(await page.locator('#localStorageStatus').textContent(), /^Not saved on this phone: /);
  assert.equal(phone.db.prepare("SELECT value FROM meta WHERE key='initialized'").get(), undefined);
  assert.equal(phone.db.prepare('SELECT COUNT(*) AS n FROM rides').get().n, 0);
  assert.equal(await page.evaluate(() => document.getElementById('nativeMigration')), null, 'the overlay is gone after a stopped move');
  assert.ok(await page.evaluate(() => app.completedWorkouts.some((r) => r.id === 'ride_before_update' && r.samples.length === 600)));

  // The next start moves everything, verified, and keeps a snapshot of the WebView data.
  await page.reload();
  await page.waitForFunction(() => window.app && window.ApexNative);
  assert.equal(await page.evaluate(() => VeloStorage.enabled), true);
  assert.equal(await page.locator('#localStorageStatus').textContent(), 'Saved on this phone. Use History > Export to keep a copy elsewhere.');
  const row = phone.db.prepare("SELECT json, samples_gz, sample_count FROM rides WHERE id='ride_before_update'").get();
  assert.equal(row.sample_count, 600);
  assert.doesNotMatch(row.json, /"hr"/, 'samples are stored compressed');
  assert.equal(phone.db.prepare("SELECT value FROM settings WHERE key='apex_erg_response'").get().value, 'steady');
  assert.ok(fs.readdirSync(phone.backups).some((n) => /^apex_.*\.json\.gz$/.test(n)), 'migration snapshot kept');
  const moved = await page.evaluate(() => app.completedWorkouts.find((r) => r.id === 'ride_before_update'));
  assert.deepEqual(moved.samples, samples);
  assert.equal(phone.db.prepare('SELECT COUNT(*) AS n FROM rides').get().n, 6);
  const seen = await page.evaluate(() => window.__migrationSeen);
  assert.ok(seen.some((t) => /Moving your rides into the phone database/.test(t) && /Don't close the app/.test(t)), 'the rider is told to keep the app open');
  assert.ok(seen.some((t) => /6 of 6 rides/.test(t)), 'with progress');
  assert.equal(await page.evaluate(() => document.getElementById('nativeMigration')), null, 'and the overlay goes away');
  assert.equal(await page.evaluate(() => localStorage.getItem('apex_sqlite_migration')), phone.db.prepare("SELECT value FROM meta WHERE key='storeId'").get().value,
    'velo-storage does not copy the earlier data again (the migration snapshot keeps it)');
  const revision = phone.db.prepare("SELECT value FROM meta WHERE key='revision'").get().value;

  // Later starts read SQLite and never move the WebView data again, nor let velo-storage copy the whole
  // history into IndexedDB as an "earlier browser original", even when the flag that prevents it went missing.
  await page.evaluate(() => localStorage.removeItem('apex_sqlite_migration'));
  await page.reload();
  await page.waitForFunction(() => window.app && window.ApexNative);
  assert.equal(await page.evaluate(() => VeloStorage.enabled), true);
  assert.equal(phone.db.prepare("SELECT value FROM meta WHERE key='revision'").get().value, revision);
  assert.equal(await page.evaluate(() => app.completedWorkouts.filter((r) => r.id === 'ride_before_update').length), 1);
  assert.equal(phone.db.prepare('SELECT COUNT(*) AS n FROM migration_rides').get().n, 0);
  const storeId = phone.db.prepare("SELECT value FROM meta WHERE key='storeId'").get().value;
  assert.equal(await page.evaluate(() => localStorage.getItem('apex_sqlite_migration')), storeId, 'the flag is set again');
  const original = await page.evaluate((id) => new Promise((resolve, reject) => {
    const open = indexedDB.open('ApexVeloDB');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { const get = open.result.transaction('settings').objectStore('settings').get('sqlite_browser_original:' + id); get.onsuccess = () => resolve(get.result || null); get.onerror = () => reject(get.error); };
  }), storeId);
  assert.equal(original, null, 'no whole-history copy in IndexedDB');
  await page.evaluate(() => localStorage.setItem('apex_erg_response', 'responsive'));
  await page.evaluate(() => VeloStorage.flush());
  assert.equal(phone.db.prepare("SELECT value FROM settings WHERE key='apex_erg_response'").get().value, 'responsive');
  await context.close();
  phone.db.close();
}

(async () => {
  if (!fs.existsSync(path.join(www, 'mobile', 'apex-native.js'))) throw new Error('Run npm run build first');
  const browser = await chromium.launch({ headless: true, executablePath });
  const context = await newContext(browser);
  const phone = await phoneStorage(context, 'main');
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  let failed = false;
  try {
    await migrationFlow(browser, errors);
    step('earlier WebView rides and settings move into SQLite on the first start, a ride at a time with a progress overlay: an interrupted move leaves nothing half-written and goes on, samples are compressed, later starts never move again');

    await page.goto(`${ORIGIN}/index.html`);
    await page.waitForFunction(() => window.app && window.ApexNative);
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('apex-native')), true);
    assert.equal(await page.evaluate(() => typeof navigator.bluetooth.requestDevice), 'function');
    assert.equal(await page.evaluate(() => VeloStorage.enabled), true, 'SQLite owns saved data');
    assert.equal(await page.evaluate(() => app._remoteEnabled), false, 'phone remote must stay off at https://localhost');
    assert.equal(await page.locator('#settingsNav [data-sec="backups"]').isVisible(), false);
    assert.equal(await page.evaluate(() => app.healthDays.length), 0);
    step('app boots in native mode (Web Bluetooth shim, SQLite storage, PC-only features off)');

    // ------------------------------------------------------------------ pair the trainer --
    await page.evaluate(() => { window.__pair = app.connectDevice('trainer'); });
    await page.locator('.apex-ble-item', { hasText: 'KICKR CORE' }).waitFor();
    assert.equal(await page.locator('.apex-ble-item', { hasText: 'TICKR' }).count(), 0, 'heart-rate strap must not be offered as a trainer');
    await page.locator('.apex-ble-item', { hasText: 'KICKR CORE' }).click();
    await page.waitForFunction(() => app.ble.isTrainerConnected(), null, { timeout: 15000 });
    await page.evaluate(() => window.__pair);
    assert.equal(await page.locator('.apex-ble-chooser').count(), 0);
    await page.waitForFunction(() => __nativeLog.writes.some((w) => w.bytes[0] === 0x00)); // FTMS request control
    step('trainer paired through the in-app chooser (filters applied) and FTMS control requested');

    await page.evaluate(() => { window.__pairHr = app.connectDevice('hr'); });
    await page.locator('.apex-ble-item', { hasText: 'TICKR' }).click();
    await page.waitForFunction(() => app.ble.isHrConnected(), null, { timeout: 15000 });
    await page.waitForFunction(() => app.bleHr && app.bleHr.hr === 142, null, { timeout: 5000 });
    step('heart-rate strap paired and streaming');

    // -------------------------------------------------------------- ride an ERG workout --
    await page.evaluate(() => {
      app.currentWorkout = { id: 'native-test', title: 'Native ERG test', category: 'endurance', intervals: [
        { name: 'Warmup', pctFtp: 50, duration: 120 }, { name: 'Steady', pctFtp: 75, duration: 120 }] };
      app.resetWorkout(false); app.renderIntervalTrack(); app.updateHudTitles();
    });
    await page.evaluate(() => app.togglePlayPause());
    await page.waitForFunction(() => __nativeLog.writes.some((w) => w.bytes[0] === 0x05), null, { timeout: 10000 });
    const target = await page.evaluate(() => { const w = __nativeLog.writes.filter((x) => x.bytes[0] === 0x05).pop(); return w.bytes[1] | (w.bytes[2] << 8); });
    const ftp = await page.evaluate(() => app.activeProfile.ftp);
    assert.ok(Math.abs(target - Math.round(ftp * 0.5)) <= 3, `ERG target ${target} W should be 50% of FTP ${ftp}`);
    assert.ok(await page.evaluate(() => __nativeLog.keepAwake.includes('on')), 'screen kept on while riding');
    step(`ERG target ${target} W sent to the trainer; screen kept awake`);

    await page.waitForFunction(() => app.recordedSamples.length >= 3 && app.recordedSamples.at(-1).power === 200, null, { timeout: 10000 });
    await page.evaluate(() => window.__dropTrainer());
    await page.waitForFunction(() => !app.ble.isTrainerConnected());
    await page.waitForFunction(() => app.ble.isTrainerConnected(), null, { timeout: 20000 });
    step('trainer link drop is detected and the trainer reconnects by itself');

    // Strava only takes rides with 60+ s of data: extend the few real seconds with copies of the last one.
    await page.evaluate(() => {
      const last = app.recordedSamples.at(-1);
      while (app.recordedSamples.length < 65) {
        const n = app.recordedSamples.length;
        app.recordedSamples.push({ ...last, time: last.time + (n - app.recordedSamples.indexOf(last)), timestamp: last.timestamp + (n - app.recordedSamples.indexOf(last)) * 1000 });
      }
      app.totalElapsedSeconds = app.recordedSamples.length;
      app.finishWorkout(false);
    });
    await page.waitForFunction(() => app.completedWorkouts.some((r) => r.workoutId === 'native-test'));
    const rideId = await page.evaluate(() => app.completedWorkouts.find((r) => r.workoutId === 'native-test').id);
    assert.ok(await page.evaluate(() => __nativeLog.keepAwake.at(-1) === 'off'), 'screen may sleep again after the ride');
    await page.waitForFunction(async (id) => ((await VeloDB.getAllRides()) || []).some((r) => r.id === id), rideId, { timeout: 10000 });
    const stem = await page.evaluate((id) => VeloExport.fileStem(app.completedWorkouts.find((r) => r.id === id)), rideId);
    await page.waitForFunction((p) => __nativeLog.files.some((f) => f.path === p && f.directory === 'DOCUMENTS'), `ApexVelo/${stem}.fit`);
    const autoFit = await page.evaluate((p) => __nativeLog.files.find((f) => f.path === p).data, `ApexVelo/${stem}.fit`);
    assert.equal(Buffer.from(autoFit, 'base64').subarray(8, 12).toString(), '.FIT');
    await page.evaluate(() => VeloStorage.flush());
    const saved = phone.db.prepare('SELECT sample_count FROM rides WHERE id=?').get(rideId);
    assert.ok(saved && saved.sample_count >= 65, 'the ride and its samples are in SQLite');
    step(`ride recorded at 200 W, saved on the phone (SQLite) and as Documents/ApexVelo/${stem}.fit`);

    // ------------------------------------------------------------------------- Strava --
    await page.evaluate(() => app.closeModal('rideSummaryModal'));
    await page.evaluate(() => app.openSettings('strava'));
    await page.locator('#nativeStravaClientId').fill('123456');
    await page.locator('#nativeStravaSecret').fill('0123456789abcdef0123456789abcdef01234567');
    await page.locator('#btnNativeStravaSave').click();
    await page.waitForFunction(() => app.strava.configured === true);
    await page.locator('#btnNativeStravaConnect').click();
    await page.waitForFunction(() => __nativeLog.opened.length === 1);
    const auth = new URL(await page.evaluate(() => __nativeLog.opened[0]));
    assert.equal(auth.pathname, '/oauth/mobile/authorize');
    assert.equal(auth.searchParams.get('redirect_uri'), 'apexvelo://localhost/strava');
    assert.equal(auth.searchParams.get('scope'), 'activity:write', 'upload permission only');
    await page.evaluate((s) => __fireNative('appUrlOpen', { url: 'apexvelo://localhost/strava?state=wrong&code=good-code&scope=read,activity:write' }), null);
    assert.equal(await page.evaluate(() => app.strava.connected), false, 'a redirect with the wrong state is refused');
    await page.evaluate(() => app.connectStrava());
    const state = new URL(await page.evaluate(() => __nativeLog.opened.at(-1))).searchParams.get('state');
    await page.evaluate((s) => __fireNative('appUrlOpen', { url: `apexvelo://localhost/strava?state=${s}&code=good-code&scope=read,activity:write` }), state);
    await page.waitForFunction(() => app.strava.connected && app.strava.canUpload);
    assert.equal(await page.evaluate(() => app.strava.canSync), false, 'the phone never syncs from Strava');
    assert.equal(await page.evaluate(() => app.strava.athlete), 'Test Rider');
    assert.equal(await page.evaluate(() => Object.keys(localStorage).some((k) => /strava_(tokens|credentials)/.test(k) || /0123456789abcdef/.test(localStorage.getItem(k)))), false, 'secrets stay out of WebView storage');
    step('Strava sign-in: settings saved, mobile OAuth opened, state checked, tokens exchanged');

    await page.evaluate((id) => app.sendRideToStrava(id), rideId);
    await page.waitForFunction((id) => app.completedWorkouts.find((r) => r.id === id).strava?.state === 'sent', rideId, { timeout: 20000 });
    const upload = await page.evaluate(() => __nativeLog.http.find((r) => r.url.endsWith('/api/v3/uploads')));
    assert.equal(upload.dataType, 'formData');
    const file = upload.data.find((p) => p.key === 'file');
    assert.equal(Buffer.from(file.value, 'base64').subarray(8, 12).toString(), '.FIT');
    assert.equal(upload.data.find((p) => p.key === 'external_id').value, `apexvelo-${rideId}`);
    assert.equal(await page.evaluate((id) => app.completedWorkouts.find((r) => r.id === id).strava.activityId, rideId), '5550001');
    assert.equal(await page.evaluate(() => __nativeLog.shared.length), 0, 'sending does not pop a share sheet');

    const row = await page.evaluate((id) => ApexNative.uploads.state(id, 'strava'), rideId);
    assert.deepEqual([row.status, row.external_id], ['sent', '5550001'], 'the ledger records the activity id the upload returned');
    assert.match(row.content_hash, /^[0-9a-f]{64}$/);
    await page.evaluate((id) => app.sendRideToStrava(id), rideId);
    assert.equal(await page.evaluate(() => __nativeLog.http.filter((r) => r.url.endsWith('/api/v3/uploads')).length), 1, 'an uploaded ride is not sent twice');
    step('ride uploaded to Strava as a FIT file, linked to activity 5550001 and recorded in the sync ledger');

    // Upload-only: no sync UI, no activity reads, the read routes are gone.
    assert.equal(await page.locator('#btnStravaSync').isVisible(), false);
    assert.equal(await page.evaluate(() => document.getElementById('btnStravaSync').closest('.strava-sync-row').hidden), true);
    assert.equal(await page.evaluate(() => document.getElementById('btnStravaCheckAll').hidden), true);
    assert.equal(await page.evaluate(() => document.getElementById('chkStrengthInFatigue').closest('label').hidden), false, 'strength-load switches stay');
    assert.equal(await page.evaluate(() => fetch('api/strava/sync?after=2026-10-01T00:00:00Z&before=2026-10-17T00:00:00Z').then((r) => r.status)), 503);
    assert.equal(await page.evaluate(() => fetch('api/strava/activities?after=1&before=2').then((r) => r.status)), 503);

    // Auto-upload while offline: the ride waits in the queue and goes out on resume.
    await page.evaluate(() => app.openSettings('strava'));
    await page.locator('#nativeStravaAuto').check();
    await page.waitForFunction(() => ApexNative.uploads.autoUpload('strava'));
    const ride2 = await page.evaluate((id) => {
      const src = app.completedWorkouts.find((r) => r.id === id);
      const r = { ...structuredClone(src), id: src.id + '-b', title: 'Second ride', strava: undefined };
      app.completedWorkouts.unshift(r);
      app._reviewRideId = r.id;
      app.renderStravaPanel(r);
      window.__idlePanel = document.getElementById('rideStravaPanel').textContent;
      window.__stravaOffline = true;
      app.preparePhoneFit(r); // finishWorkout's hook for a new ride
      return r.id;
    }, rideId);
    await page.waitForFunction((id) => app.completedWorkouts.find((r) => r.id === id).strava?.state === 'queued' && app.completedWorkouts.find((r) => r.id === id).strava.attempts === 1, ride2, { timeout: 10000 });
    assert.match(await page.evaluate((id) => app.stravaChip(app.completedWorkouts.find((r) => r.id === id)), ride2), /Strava queued/);
    assert.match(await page.evaluate(() => window.__idlePanel), /Not sent from this phone yet[\s\S]*Send to Strava/, 'per-ride Send to Strava');
    assert.equal(await page.locator('#rideStravaState').textContent(), 'Waiting to send to Strava');
    assert.equal((await page.locator('#rideStravaPanel [data-strava="send"]').textContent()).trim(), 'Send now');
    await page.waitForFunction(() => /1 ride waiting to upload/.test(document.getElementById('nativeStravaQueue').textContent));
    await page.evaluate(() => window.__fireNative('resume'));
    assert.equal((await page.evaluate((id) => ApexNative.uploads.state(id, 'strava'), ride2)).attempts, 1, 'resuming before the backoff ends does not retry');
    // A minute and more later, back online.
    // The ledger is the phone database's sync_ledger table, not Preferences.
    assert.equal(phone.db.prepare("SELECT status FROM sync_ledger WHERE ride_id=? AND destination='strava'").get(ride2).status, 'queued');
    assert.equal(await page.evaluate(() => __APEX_NATIVE_FAKE__.prefs.get('apex_sync_ledger_strava')), null);
    phone.db.prepare("UPDATE sync_ledger SET updated_at=? WHERE status='queued'").run(new Date(Date.now() - 3600e3).toISOString());
    await page.evaluate(async () => {
      window.__stravaOffline = false;
      await window.__fireNative('resume');
    });
    await page.waitForFunction((id) => app.completedWorkouts.find((r) => r.id === id).strava?.state === 'sent', ride2, { timeout: 20000 });
    assert.equal((await page.evaluate((id) => ApexNative.uploads.state(id, 'strava'), ride2)).status, 'sent');

    // A ride that came from Strava is never sent back, even through the queue.
    const before = await page.evaluate(() => __nativeLog.http.filter((r) => r.url.endsWith('/api/v3/uploads')).length);
    const skipped = await page.evaluate(async (id) => {
      const r = { ...structuredClone(app.completedWorkouts.find((x) => x.id === id)), id: 'from-strava', source: 'Strava', strava: { state: 'imported', activityId: '4001' } };
      app.completedWorkouts.push(r);
      await app.sendRideToStrava(r.id);
      app.preparePhoneFit(r);
      return (await ApexNative.uploads.sendNow(r, 'strava')).status;
    }, rideId);
    assert.equal(skipped, 'skipped');
    assert.equal(await page.evaluate((id) => app.canSendToStrava({ ...app.completedWorkouts.find((r) => r.id === id), origin: 'strava' }), rideId), false, 'rides from Strava export files are not offered');
    // A ride restored with its Strava link is recorded in the ledger, not uploaded again.
    const restored = await page.evaluate(async (id) => {
      const r = { ...structuredClone(app.completedWorkouts.find((x) => x.id === id)), id: 'restored', strava: { state: 'sent', activityId: '6660001', sentAt: 1 } };
      app.completedWorkouts.push(r);
      await app.sendRideToStrava(r.id);
      return ApexNative.uploads.state(r.id, 'strava');
    }, rideId);
    assert.deepEqual([restored.status, restored.external_id], ['sent', '6660001']);
    assert.equal(await page.evaluate(() => __nativeLog.http.filter((r) => r.url.endsWith('/api/v3/uploads')).length), before);
    await page.evaluate(() => { app.completedWorkouts = app.completedWorkouts.filter((r) => r.id !== 'from-strava' && r.id !== 'restored'); });
    assert.equal(await page.evaluate(() => __nativeLog.http.some((r) => /\/api\/v3\/(athlete\/)?activities/.test(r.url))), false, 'Strava activities are never read');
    step('upload-only: sync hidden, auto-upload queued offline and sent on resume after backoff, Strava rides never sent back, no activity reads');

    // ---------------------------------------------------------------------- AI engine --
    await page.evaluate(() => app.closeModal('settingsModal'));
    await page.evaluate(() => app.openSettings('ai'));
    assert.equal(await page.locator('#settingsNav [data-sec="ai"]').isVisible(), true, 'Settings > AI engine is offered');
    assert.equal(await page.locator('#aiCoachConfigCard').isVisible(), true);
    assert.match(await page.locator('#aiCoachEngineDetail').innerText(), /No Claude API key/);
    assert.doesNotMatch(await page.locator('#aiCoachConfigCard').innerText(), /\.env|Launch-Apex-Velo|local server/);
    await page.locator('#nativeAiKey-claude').fill('not a key');
    await page.locator('#btnNativeAiSaveKeys').click();
    await page.locator('.toast-msg', { hasText: 'paste the whole key' }).first().waitFor();
    const aiKey = 'sk-ant-api03-' + 'k'.repeat(48);
    await page.evaluate((k) => { window.__aiKey = k; }, aiKey);
    await page.locator('#nativeAiKey-claude').fill(aiKey);
    await page.locator('#btnNativeAiSaveKeys').click();
    await page.waitForFunction(() => app.aiCoach.isLive);
    assert.match(await page.locator('#aiCoachEngineDetail').innerText(), /Ready\. Requests go from this phone to Claude Opus 5\.5/);
    assert.equal(await page.locator('#nativeAiKey-claude').inputValue(), '');
    await fs.promises.mkdir(path.join(__dirname, '..', 'test-output'), { recursive: true });
    await page.screenshot({ path: path.join(__dirname, '..', 'test-output', 'native-ai-settings.png') }).catch(() => {});
    assert.match(await page.locator('#nativeAiKey-claude').getAttribute('placeholder'), /Saved \(\.\.\.kkkk\)/);
    assert.ok(await page.evaluate(() => [...document.querySelectorAll('#selectCoachModel option')].some((o) => o.value === 'claude-haiku-5-5')), 'live model list from the key');
    assert.equal(await page.evaluate((k) => Object.keys(localStorage).some((x) => (localStorage.getItem(x) || '').includes(k)), aiKey), false, 'the key stays out of WebView storage');
    step('Settings > AI engine: a bad key is refused, a good one is saved on the phone, and the live model list loads');

    await page.evaluate(() => app.closeModal('settingsModal'));
    await page.locator('.nav-btn[data-tab="ask"]').first().click();
    assert.equal(await page.locator('#askEngineWarn').isVisible(), false);
    await page.locator('#askInput').fill('How many rides did I do this week?');
    await page.locator('#askForm').evaluate((f) => f.requestSubmit());
    await page.locator('#askThread', { hasText: 'You rode 1 ride this week' }).waitFor({ timeout: 15000 });
    const askCall = await page.evaluate(() => __nativeLog.http.filter((r) => r.url === 'https://api.anthropic.com/v1/messages').at(-1));
    assert.equal(askCall.headers['x-api-key'], aiKey);
    assert.equal(askCall.data.model, 'claude-opus-5-5');
    assert.equal(askCall.data.messages.at(-1).content, 'How many rides did I do this week?');
    assert.match(askCall.data.system[1].text, /^TRAINING DATA\n/);
    await page.screenshot({ path: path.join(__dirname, '..', 'test-output', 'native-ask.png') }).catch(() => {});
    step('Ask: the question and the period summary go from the phone to Claude, and the answer shows in the thread');
    assert.equal(await page.locator('#btnAskClear').isVisible(), true, 'Clear sits next to the question box once there is a chat');
    await page.locator('#btnAskClear').click();
    await page.locator('#askThread .ask-empty').waitFor();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('apex_ask_v1')).messages.length), 0, 'the cleared chat is not kept');
    assert.equal(await page.locator('#btnAskClear').isVisible(), false);
    step('Ask: Clear empties the chat on the phone');

    const breakdown = await page.evaluate((id) => app.requestAiBreakdown(id), rideId);
    assert.ok(breakdown && /test breakdown/.test(breakdown.text), 'the coach answered the interval breakdown');
    const coachCall = await page.evaluate(() => __nativeLog.http.filter((r) => r.url === 'https://api.anthropic.com/v1/messages').at(-1));
    assert.equal(typeof coachCall.data.system, 'string');
    assert.deepEqual(coachCall.data.output_config, { effort: 'low' });
    step('AI coach: the ride breakdown goes through /api/coach on the phone');

    await page.locator('.nav-btn[data-tab="workouts"]').first().click();
    assert.match(await page.locator('#describeEngine').innerText(), /Claude Opus 5\.5 · only your request and FTP/);
    await page.locator('#describeExamples [data-example]').first().click();
    assert.equal(await page.locator('#describeInput').inputValue(), '45 min sweet spot');
    await page.locator('#describeInput').fill('50 min, 5x3 min at 115% with 3 min easy, high cadence');
    await page.locator('#btnDescribeCreate').click();
    await page.locator('#describeResult .describe-card', { hasText: 'Five by Three at 115%' }).waitFor({ timeout: 15000 });
    const describeCall = await page.evaluate(() => __nativeLog.http.filter((r) => r.url === 'https://api.anthropic.com/v1/messages').at(-1));
    const sent = describeCall.data.messages[0].content;
    assert.match(sent, /5x3 min at 115% with 3 min easy/);
    assert.doesNotMatch(sent, /RIDES IN THE LAST|Native ERG test/, 'no ride history is sent');
    assert.deepEqual(describeCall.data.output_config, { effort: 'low' });
    assert.match(await page.locator('#describeResult .w-card-meta').innerText(), /42\s*m/, 'duration computed from the steps (10 + 15 + 12 + 5 min)');
    await page.locator('#describeResult [data-describe="save"]').click();
    assert.ok(await page.evaluate(() => app.loadSavedWorkouts().some((w) => w.title === 'Five by Three at 115%')), 'saved to the library');
    await page.locator('#describeResult [data-describe="ride"]').click();
    await page.waitForFunction(() => app.activeTab === 'cockpit' && app.currentWorkout.title === 'Five by Three at 115%');
    assert.equal(await page.evaluate(() => app.currentWorkout.intervals.filter((i) => i.pctFtp === 115).length), 5);
    step('Describe a workout: built from the request only (no history sent), saved to the library and loaded into the cockpit');

    // ------------------------------------------------------------- health (intervals.icu) --
    const icuKey = 'abc123def456ghi789jkl0';
    await page.evaluate((k) => { window.__icuKey = k; }, icuKey);
    await page.evaluate(() => app.openSettings('health'));
    assert.equal(await page.locator('#settingsNav [data-sec="health"]').innerText(), 'Health');
    await page.locator('#nativeIcuKey').fill('wrongkey00000000');
    await page.locator('#btnNativeIcuSave').click();
    await page.waitForFunction(() => /did not accept the API key/.test(document.body.innerText));
    await page.locator('#nativeIcuKey').fill(icuKey);
    await page.locator('#btnNativeIcuSave').click();
    await page.waitForFunction(() => app.healthDays.length === 30, null, { timeout: 10000 });
    const today = await page.evaluate(() => app.localDayKey(new Date()));
    const backfill = await page.evaluate(() => __nativeLog.http.filter((r) => r.url.includes('/wellness')).at(-1).url);
    assert.equal(new URL(backfill).searchParams.get('newest'), today);
    assert.equal(new URL(backfill).searchParams.get('oldest'), await page.evaluate((d) => VeloHealth.addDays(d, -799), today), 'the backfill reads all the history the app keeps');
    const latest = await page.evaluate(() => app.healthDays.at(-1));
    assert.equal(latest.day, today);
    assert.equal(latest.hrv, 62, 'SDNN is used for every day: most days only have SDNN');
    assert.equal(latest.rhr, 48);
    assert.equal(latest.sleepH, 7.5);
    assert.deepEqual([latest.deepH, latest.coreH, latest.remH], [1, 5, 1.5], 'sleep stages from the DeepSleep / LightSleep / REMSleep custom fields');
    assert.equal(await page.evaluate(() => app.healthReadiness().level), 'green');
    await page.locator('#healthStatus', { hasText: 'Test Rider' }).waitFor();
    assert.match(await page.locator('#healthStatus').innerText(), /SDNN/);
    assert.match(await page.locator('#coachReadinessChip').innerText(), /Ready/);
    assert.equal(await page.evaluate((k) => Object.keys(localStorage).some((x) => (localStorage.getItem(x) || '').includes(k)), icuKey), false, 'the key stays out of WebView storage');
    assert.match(await page.locator('#healthStatus').innerText(), /deep, light \(core\) and REM/);
    await page.locator('#nativeIcuHrv').selectOption('hrv');
    await page.waitForFunction(() => app.healthDays.at(-1).hrv === 70, null, { timeout: 10000 });
    assert.equal(await page.evaluate(() => app.healthDays.filter((d) => d.hrv !== null).length), 3, 'rMSSD days only: no SDNN mixed in');
    await page.locator('#healthStatus', { hasText: 'Overnight rMSSD' }).waitFor();
    await page.locator('#nativeIcuHrv').selectOption('auto');
    await page.waitForFunction(() => app.healthDays.at(-1).hrv === 62, null, { timeout: 10000 });
    await page.locator('#btnHealthRefresh').click();
    await page.waitForFunction(() => __nativeLog.http.filter((r) => r.url.includes('/wellness')).length === 4);
    const recent = await page.evaluate(() => __nativeLog.http.filter((r) => r.url.includes('/wellness')).at(-1).url);
    assert.equal(new URL(recent).searchParams.get('oldest'), await page.evaluate((d) => VeloHealth.addDays(d, -7), today), 'later syncs read the last week');
    await page.evaluate(() => app.pullHealthInbox());
    assert.equal(await page.evaluate(() => __nativeLog.http.filter((r) => r.url.includes('/wellness')).length), 4, 'automatic syncs wait an hour');
    await page.evaluate(() => app.closeModal('settingsModal'));
    await page.locator('.nav-btn[data-tab="analytics"]').first().click();
    await page.evaluate(() => app.showAnalyticsPanel('health', { instant: true }));
    await page.locator('#anaHealthTiles .tile', { hasText: 'Sleeping HR' }).waitFor();
    assert.equal(await page.locator('#anaHealthTiles .tile').count(), 14, 'a tile for every metric with data');
    assert.equal(await page.locator('#anaHealthTiles .tile', { hasText: /Steps|VO2max|Body fat/ }).count(), 0, 'steps, body fat and VO2max are not shown');
    for (const id of ['anaCardHealthHr', 'anaCardHealthHrv', 'anaCardHealthHrvBoth', 'anaCardHealthSleep', 'anaCardHealthScores', 'anaCardHealthStress', 'anaCardHealthBreath', 'anaCardHealthBody']) {
      assert.equal(await page.locator('#' + id).isVisible(), true, id + ' shows');
    }
    assert.equal(await page.locator('#anaCardHealthVitals').isVisible(), false, 'no blood pressure, glucose or food data: the card stays hidden');
    assert.equal(await page.locator('.hl-legend[data-hl="healthSleepCanvas"] .lg-toggle').count(), 3, 'deep, light and REM');
    assert.match(await page.locator('#healthSleepMix').innerText(), /DEEP\s*1:00/i);
    assert.match(await page.locator('#anaModStat-health').innerText(), /\d+ ms/);
    await page.locator('.hl-legend[data-hl="healthHrCanvas"] .lg-toggle', { hasText: 'Sleeping HR' }).click();
    assert.equal(await page.evaluate(() => { const c = app._healthCharts.healthHrCanvas; return c.data.datasets.filter((d, i) => d.hlKey === 'sleepHr' && c.isDatasetVisible(i)).length; }), 0, 'the legend hides a metric');
    // Linked crosshair: hovering one date chart marks the same day on the others.
    await page.locator('#healthHrCanvas').scrollIntoViewIfNeeded();
    const hrBox = await page.locator('#healthHrCanvas').boundingBox();
    await page.mouse.move(hrBox.x + hrBox.width * 0.85, hrBox.y + hrBox.height * 0.5);
    await page.waitForFunction(() => { const c = app._healthCharts.healthHrvCanvas; return !!c; });
    // Tap a day on a chart opens that day.
    await page.locator('#healthHrCanvas').click({ position: { x: hrBox.width * 0.85, y: hrBox.height * 0.6 } });
    await page.locator('#anaDayModal.open #anaDayBody .day-health').waitFor();
    assert.match(await page.locator('#anaDayBody').innerText(), /RESTING HR/i);
    await page.locator('#btnAnaDayPrev').click();
    await page.locator('#btnAnaDayClose').click();
    // Sleep timeline (intervals.icu: how each night was split) and the correlation explorer.
    assert.equal(await page.locator('#anaCardSleepTimeline').isVisible(), true);
    assert.equal(await page.locator('#sleepBars .sb-row').count(), 14);
    await page.locator('#corrVerdict', { hasText: /link|Too few|Not enough/ }).waitFor();
    assert.equal(await page.locator('#corrX').inputValue(), 't:tss');
    assert.equal(await page.locator('#corrY').inputValue(), 'h:hrv');
    step('Analytics: tap a day on a chart opens it (prev / next), sleep timeline of 14 nights, correlation explorer');

    await page.evaluate(() => app.showAnalyticsPanel('overview', { instant: true }));
    await page.locator('#anaReadyRing svg').waitFor();
    assert.match(await page.locator('#anaReadyRing').getAttribute('data-level'), /green|amber|red/);
    assert.equal(await page.locator('#anaReadyParts .ready-part').count(), 3, 'HRV, resting HR and sleep');
    assert.match(await page.locator('#anaStoryText').innerText(), /Next:/, 'the week from the numbers, without AI');
    await page.locator('#btnAnaStory').click();
    await page.locator('#anaStoryText', { hasText: 'test breakdown' }).waitFor({ timeout: 10000 });
    assert.match(await page.locator('#anaStoryNote').innerText(), /Written by Claude Opus 5\.5/);
    const storyCall = await page.evaluate(() => __nativeLog.http.filter((r) => r.url === 'https://api.anthropic.com/v1/messages').at(-1));
    assert.match(storyCall.data.messages[0].content, /WEEKLY STORY/);
    assert.equal(await page.locator('#anaSectionNav .ana-mod-stat.skel').count(), 0, 'skeletons are gone once the numbers are in');
    // Pin the heart-rate chart to Overview.
    await page.evaluate(() => app.showAnalyticsPanel('health', { instant: true }));
    await page.locator('#anaCardHealthHr .ana-pin-btn').click();
    assert.equal(await page.evaluate(() => !!document.querySelector('#anaPinnedGrid #anaCardHealthHr')), true);
    // Training year heatmap: today's cell opens the day with the ride.
    await page.evaluate(() => app.showAnalyticsPanel('load', { instant: true }));
    const todayKey = await page.evaluate(() => app.localDayKey(new Date()));
    await page.locator(`#anaYearGrid [data-day="${todayKey}"]`).click();
    await page.locator('#anaDayBody .ride-chip', { hasText: 'Native ERG test' }).waitFor();
    await page.locator('#btnAnaDayClose').click();
    // FTP over time is calculated on the phone (no imported research history needed).
    await page.evaluate(() => app.showAnalyticsPanel('ftp', { instant: true }));
    await page.locator('#ftpMetricsStatus', { hasText: 'Calculated in the app from' }).waitFor();
    assert.equal(await page.locator('#ftpMetricsSourceWrap').isVisible(), false);
    step('Analytics: readiness ring, the week in three sentences (offline, then by Claude), skeletons cleared, pin to Overview, training year heatmap opens a day, FTP over time calculated on the phone');

    step('Analytics > Health: tiles, heart rate, HRV with its normal range, both HRV kinds, sleep stages, scores, stress, breathing and weight; cards without data stay hidden');
    step('health: intervals.icu key checked, all history backfilled into readiness with sleep stages, HRV kind switchable (never mixed), later syncs read the last week at most hourly');

    // ------------------------------------------------------------------ Health Connect --
    await page.evaluate(() => app.openSettings('health'));
    await page.locator('#nativeHcStatus', { hasText: 'Available' }).waitFor();
    assert.match(await page.locator('[data-hc-type="read:HeartRateVariabilityRmssd"]').innerText(), /readiness score/, 'each type says what it is for');
    const icuToday = await page.evaluate(() => app.healthDays.at(-1));
    assert.equal(icuToday.rhr, 48);
    await page.locator('[data-hc-group="recovery"] [data-hc-request]').click();
    await page.waitForFunction(() => app.healthDays.at(-1).rhr === 45, null, { timeout: 15000 });
    const hcReq = await page.evaluate(() => __nativeLog.hc.requests[0]);
    assert.deepEqual(hcReq.read, ['HeartRateVariabilityRmssd', 'RestingHeartRate', 'SleepSession', 'Weight', 'OxygenSaturation', 'RespiratoryRate']);
    assert.equal(hcReq.history, true, 'history permission asked for the two-year backfill');
    const merged = await page.evaluate(() => app.healthDays.at(-1));
    assert.deepEqual([merged.rhr, merged.hrv, merged.sleepH, merged.deepH, merged.remH], [45, 75, 8, 2, 2], 'Health Connect first: resting HR, rMSSD and staged sleep');
    assert.equal(await page.evaluate(() => app.healthDays.filter((d) => d.hrvSrc === 'hc').length), 30, 'one HRV kind on every day');
    assert.equal(merged.sleepScore, await page.evaluate(() => app.healthStore.days[app.healthDays.at(-1).day].summary.sleepScore), 'intervals.icu-only values stay');
    assert.equal(phone.db.prepare("SELECT COUNT(*) AS n FROM wellness_days WHERE source='healthconnect'").get().n, 30);
    assert.ok(phone.db.prepare("SELECT COUNT(*) AS n FROM wellness_days WHERE source='icu'").get().n >= 30, 'intervals.icu days are kept beside them');
    assert.equal(await page.evaluate(() => app.healthReadiness().level !== undefined), true);
    await page.locator('#nativeHcPref-rhr').selectOption('icu');
    await page.waitForFunction(() => app.healthDays.at(-1).rhr === 48, null, { timeout: 10000 });
    await page.locator('#nativeHcPref-rhr').selectOption('healthconnect');
    await page.waitForFunction(() => app.healthDays.at(-1).rhr === 45, null, { timeout: 10000 });
    step('Health Connect: availability shown, recovery types asked for with a plain-language reason, two years backfilled into wellness_days and merged with intervals.icu per field (Health Connect first, switchable)');

    await page.locator('[data-hc-group="rides"] [data-hc-request]').click();
    await page.waitForFunction(() => app.completedWorkouts.some((r) => r.id === 'hc_zwift1'), null, { timeout: 15000 });
    const zw = await page.evaluate(() => { const r = app.completedWorkouts.find((x) => x.id === 'hc_zwift1'); return { source: r.source, origin: r.origin, avgWatts: r.avgWatts, avgHr: r.avgHr, n: r.samples.length, title: r.title }; });
    assert.deepEqual(zw, { source: 'healthconnect', origin: 'com.zwift.android.prod', avgWatts: 200, avgHr: 140, n: 1200, title: 'Zwift - Volcano Circuit' });
    assert.equal(await page.evaluate(() => app.completedWorkouts.some((r) => r.hc && r.hc.id === 'self1')), false, "the app's own sessions are not read back");
    await page.waitForFunction(() => app.completedWorkouts.find((r) => r.id === 'hc_zwift1') && VeloDB.getAllRides().then((all) => (all || []).some((r) => r.id === 'hc_zwift1')), null, { timeout: 10000 });
    await page.evaluate(() => app.syncHealthConnect({ force: true }));
    assert.equal(await page.evaluate(() => app.completedWorkouts.filter((r) => r.hc && r.hc.id === 'zwift1').length), 1, 'a second sync adds no copy');
    step('Health Connect: cycling sessions from other apps imported as rides with their power and heart rate, never twice and never the app\'s own');

    await page.locator('[data-hc-group="write"] [data-hc-request]').click();
    await page.waitForFunction(() => document.getElementById('nativeHcAutoWrite').checked, null, { timeout: 10000 });
    const hcRow = await page.evaluate((id) => ApexNative.uploads.sendNow(app.completedWorkouts.find((r) => r.id === id), 'healthconnect'), rideId);
    assert.equal(hcRow.status, 'sent');
    const written = await page.evaluate(() => __nativeLog.hc.writes[0]);
    assert.equal(written.clientId, `apexvelo-${rideId}`);
    assert.equal(written.exerciseType, 9, 'an indoor ride is stationary biking');
    assert.ok(written.power.length > 0 && written.hr.length > 0 && written.cadence.length > 0);
    assert.equal(phone.db.prepare("SELECT status FROM sync_ledger WHERE ride_id=? AND destination='healthconnect'").get(rideId).status, 'sent');
    const back = await page.evaluate(() => ApexNative.uploads.sendNow(app.completedWorkouts.find((r) => r.id === 'hc_zwift1'), 'healthconnect'));
    assert.equal(back.status, 'skipped', 'a ride from Health Connect is never written back');
    assert.equal(await page.evaluate(() => __nativeLog.hc.writes.length), 1);
    step('Health Connect: a ride recorded here is written as a stationary-biking session with its series through the sync ledger; Health Connect rides are skipped');

    await page.evaluate(() => {
      const t = new Date(); t.setHours(4, 0, 0, 0);
      window.__hcRecordsExtra = true;
      const orig = window.__hcRecords;
      window.__APEX_NATIVE_FAKE__.plugins.HealthConnect.readRecords = async ({ type, start, end, origin }) => ({
        records: orig().concat([{ type: 'HeartRateVariabilityRmssd', id: 'hrv-new', origin: 'com.ouraring.oura', time: t.getTime(), offset: null, value: 95 }])
          .filter((r) => r.type === type && (r.time ?? r.start) >= start && (r.time ?? r.start) < end && (!origin || r.origin === origin)), pageToken: null });
      window.__hcChanges = [{ seq: 1, op: 'upsert', type: 'HeartRateVariabilityRmssd', id: 'hrv-new', time: t.getTime(), offset: null }];
    });
    await page.evaluate(() => app.syncHealthConnect({ force: true }));
    assert.equal(await page.evaluate(() => app.healthDays.at(-1).hrv), 85, 'a new reading changes only its day (average of the night)');
    assert.deepEqual(await page.evaluate(() => window.__hcChanges), [], 'changes are acknowledged once stored');
    await page.locator('#nativeHcBackground').check();
    await page.waitForFunction(() => __nativeLog.hc.background.at(-1) === true);
    step('Health Connect: changes from the token update only the days they touch and are acknowledged; the daily background check asks for its permission');

    // ------------------------------------------------------------------ exports, back key --
    await page.evaluate(() => { window.__takenFiles = ['ApexVelo/old.fit']; return app.downloadFile('old.fit', new Uint8Array([1, 2, 3]), 'application/octet-stream'); });
    await page.waitForFunction(() => __nativeLog.files.some((f) => f.path === 'ApexVelo/old_2.fit'));
    await page.evaluate((id) => app.exportFitForRide(id), rideId);
    await page.waitForFunction(() => __nativeLog.files.filter((f) => /\.fit$/.test(f.path)).length >= 3);
    assert.equal(await page.evaluate(() => __nativeLog.shared.length), 0, 'ride files are saved, not shared');
    await page.evaluate((id) => app.saveStravaImage(id), rideId);
    await page.waitForFunction(() => __nativeLog.shared.length === 1);
    assert.match(await page.evaluate(() => __nativeLog.shared[0].files[0]), /_workout\.png$/);
    await page.evaluate(() => app.openSettings('files'));
    assert.equal(await page.locator('#nativeAutoFit').isChecked(), true);
    await page.locator('#nativeAutoFit').uncheck();
    assert.equal(await page.evaluate(() => localStorage.getItem('apex_native_autosave_fit')), '0');
    await page.evaluate(() => app.openSettings('about'));
    assert.equal(await page.locator('#nativeAboutSettings').isVisible(), true);
    await page.locator('#nativeAboutSettings summary', { hasText: 'SQLCipher for Android' }).click();
    assert.match(await page.locator('#nativeAboutSettings').innerText(), /ZETETIC LLC[\s\S]*Redistributions in binary form must reproduce/);
    await page.evaluate(() => app.openSettings('rider'));
    await page.evaluate(() => __fireNative('backButton'));
    assert.equal(await page.evaluate(() => document.getElementById('settingsModal').classList.contains('open')), false);
    step('exports save to Documents/ApexVelo (a name an old install left gets _2), the image goes to the share sheet, auto-save can be turned off; Settings > About shows the open-source licences (SQLCipher in full); back closes the open dialog');

    // ------------------------------------------------------------------ bulk history import --
    const workerRequests = [];
    context.on('request', (r) => { if (r.url().endsWith('/js/velo-import-worker.js')) workerRequests.push(r.url()); });
    const ridesBefore = await page.evaluate(() => { app.switchTab('history'); return app.completedWorkouts.length; });
    assert.equal(await page.locator('#bulkImportMode').inputValue(), 'cycling', 'all cycling (incl. indoor/virtual) is the default');
    await page.locator('#bulkImportMode').selectOption('outdoor');
    const strava = path.resolve(__dirname, '..', '..', 'tests', 'fixtures', 'bulk-import', 'strava-export.zip');
    await page.locator('#fileInputBulk').setInputFiles(strava);
    await page.waitForFunction(() => document.getElementById('bulkImportPanel').dataset.state === 'done', null, { timeout: 20000 });
    const bulk = await page.evaluate(() => app.bulkSummary());
    assert.deepEqual(bulk, { found: 4, imported: 2, duplicates: 0, skipped: 2, errors: 0 }, 'outdoor only: the run and the Zwift ride are skipped');
    assert.equal(workerRequests.length, 1, 'parsed in the Web Worker');
    assert.equal(await page.evaluate(() => app.completedWorkouts.length), ridesBefore + 2);
    assert.ok(await page.evaluate(() => app.completedWorkouts.some((r) => r.title === 'Morning ride, hills' && r.source === 'import:fit' && r.origin === 'strava')));
    assert.ok(!(await page.evaluate(() => app.completedWorkouts.some((r) => r.title === 'Zwift - Watopia'))));
    assert.equal(await page.evaluate(() => localStorage.getItem('apex_import_mode')), 'outdoor');
    await page.evaluate(() => VeloStorage.flush());
    const importedIds = await page.evaluate(() => app.completedWorkouts.filter((r) => r.source?.startsWith('import:')).map((r) => r.id));
    for (const id of importedIds) {
      const row = phone.db.prepare('SELECT sample_count, json FROM rides WHERE id=?').get(id);
      assert.ok(row && row.sample_count >= 60, `imported ride ${id} and its samples are in the phone's SQLite`);
      assert.equal(JSON.parse(row.json).origin, 'strava');
    }
    assert.ok(await page.evaluate(() => app.completedWorkouts.filter((r) => r.source?.startsWith('import:')).every((r) => r.samples?.length >= 60)),
      'samples are back in memory for the analytics after the batch commits');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'import panel fits the phone');
    // A Garmin export saved one ride per batch: each batch lands in SQLite and its samples leave memory until the end.
    const garminZip = [...fs.readFileSync(path.resolve(__dirname, '..', '..', 'tests', 'fixtures', 'bulk-import', 'garmin-export.zip'))];
    const garmin = await page.evaluate(async (bytes) => {
      const r = await app.startBulkImport([new File([new Uint8Array(bytes)], 'garmin-export.zip')], { commitEvery: 1, mode: 'cycling' });
      await VeloStorage.flush();
      return r;
    }, garminZip);
    assert.deepEqual([garmin.imported, garmin.duplicates, garmin.errors, garmin.error], [1, 2, 1, null], JSON.stringify(garmin));
    const edge = await page.evaluate(() => app.completedWorkouts.find((r) => r.origin === 'garmin'));
    assert.ok(edge && edge.samples.length >= 60 && edge.avgWatts > 0, 'the Garmin copy with power, samples restored');
    assert.ok(phone.db.prepare('SELECT sample_count FROM rides WHERE id=?').get(edge.id).sample_count >= 60, 'batch-saved ride and samples in SQLite');
    step('Import history: a Strava export zip parsed in a worker on the phone, sport filter applied, ride names restored; a Garmin export saved in batches to the phone\'s SQLite');

    // -------------------------------------------------------------------- persistence --
    await page.reload();
    await page.waitForFunction(() => window.app && app.completedWorkouts);
    await page.waitForFunction((id) => app.completedWorkouts.some((r) => r.id === id && r.strava?.state === 'sent'), rideId, { timeout: 10000 });
    assert.equal(await page.evaluate(() => app.healthDays.length), 30);
    assert.equal(await page.evaluate(() => !!document.querySelector('#anaPinnedGrid #anaCardHealthHr')), true, 'pins are kept');
    assert.equal(await page.evaluate(() => app.completedWorkouts.filter((r) => r.source?.startsWith('import:') && r.origin === 'strava').length), 2, 'imported rides and their Strava origin are kept');
    step('after an app restart the ride, its Strava link, the imported rides, the health days and the pinned chart are still there');

    const unexpected = errors.filter((e) => !/ResizeObserver/.test(e));
    assert.deepEqual(unexpected, [], 'no uncaught page errors');
    await page.screenshot({ path: path.join(__dirname, '..', 'test-output', 'native-cockpit.png') }).catch(() => {});
  } catch (e) {
    failed = true;
    console.error(e);
    if (errors.length) console.error('page errors:', errors);
    await fs.promises.mkdir(path.join(__dirname, '..', 'test-output'), { recursive: true });
    await page.screenshot({ path: path.join(__dirname, '..', 'test-output', 'native-failure.png'), fullPage: false }).catch(() => {});
  } finally {
    await browser.close();
    phone.db.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  if (failed) process.exit(1);
  console.log('native-browser: all checks passed');
})();
