// End-to-end check of the Android layer in Chromium: the built www/ served at https://localhost (the
// origin Capacitor uses), with tests/fake-native.js standing in for the BLE plugin, native HTTP and
// the other plugins. Covers pairing, ERG control, recording and saving a ride, auto-reconnect,
// Strava sign-in, upload and sync. Run `npm run build` first.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const www = path.resolve(__dirname, '..', 'www');
const ORIGIN = 'https://localhost';
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const executablePath = process.env.APEX_CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const step = (name) => console.log('  ok -', name);

(async () => {
  if (!fs.existsSync(path.join(www, 'mobile', 'apex-native.js'))) throw new Error('Run npm run build first');
  const browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  await context.addInitScript({ path: path.join(__dirname, 'fake-native.js') });
  await context.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    const file = path.resolve(www, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)));
    if (!file.startsWith(www + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(file)] || 'application/octet-stream' });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  let failed = false;
  try {
    await page.goto(`${ORIGIN}/index.html`);
    await page.waitForFunction(() => window.app && window.ApexNative);
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('apex-native')), true);
    assert.equal(await page.evaluate(() => typeof navigator.bluetooth.requestDevice), 'function');
    assert.equal(await page.evaluate(() => VeloStorage.enabled), false);
    assert.equal(await page.evaluate(() => app._remoteEnabled), false, 'phone remote must stay off at https://localhost');
    assert.equal(await page.locator('.nav-btn[data-tab="ask"]').isVisible(), false);
    step('app boots in native mode (Web Bluetooth shim, phone storage, PC-only features off)');

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
    step('ride recorded at 200 W and saved on the phone (IndexedDB)');

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
    assert.match(auth.searchParams.get('scope'), /activity:write/);
    await page.evaluate((s) => __fireNative('appUrlOpen', { url: 'apexvelo://localhost/strava?state=wrong&code=good-code&scope=read,activity:write,activity:read_all' }), null);
    assert.equal(await page.evaluate(() => app.strava.connected), false, 'a redirect with the wrong state is refused');
    await page.evaluate(() => app.connectStrava());
    const state = new URL(await page.evaluate(() => __nativeLog.opened.at(-1))).searchParams.get('state');
    await page.evaluate((s) => __fireNative('appUrlOpen', { url: `apexvelo://localhost/strava?state=${s}&code=good-code&scope=read,activity:write,activity:read_all` }), state);
    await page.waitForFunction(() => app.strava.connected && app.strava.canUpload && app.strava.canSync);
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
    step('ride uploaded to Strava as a FIT file and linked to activity 5550001');

    const list = await page.evaluate(() => app.stravaSyncFetch(`api/strava/sync?after=${encodeURIComponent('2026-10-01T00:00:00Z')}&before=${encodeURIComponent('2026-10-17T00:00:00Z')}`));
    assert.equal(list.activities.length, 1);
    assert.equal(list.activities[0].id, '4001');
    assert.equal(list.rate.used15, 3);
    const details = await page.evaluate(() => app.stravaSyncFetch('api/strava/sync?ids=4001'));
    assert.equal(details.activities[0].description, 'Nice');
    const streams = await page.evaluate(() => app.stravaSyncFetch('api/strava/sync?streams=4001'));
    assert.deepEqual(streams.streams.watts.data, [100, 200]);
    step('Strava sync reads activities, details and streams');

    // ------------------------------------------------------------------ exports, back key --
    await page.evaluate((id) => app.downloadFile('ride.fit', new Uint8Array([1, 2, 3]), 'application/octet-stream'), rideId);
    await page.waitForFunction(() => __nativeLog.shared.length === 1);
    assert.match(await page.evaluate(() => __nativeLog.shared[0].files[0]), /ride\.fit$/);
    await page.evaluate(() => app.openSettings('rider'));
    await page.evaluate(() => __fireNative('backButton'));
    assert.equal(await page.evaluate(() => document.getElementById('settingsModal').classList.contains('open')), false);
    step('exports go to the Android share sheet; back closes the open dialog');

    // -------------------------------------------------------------------- persistence --
    await page.reload();
    await page.waitForFunction(() => window.app && app.completedWorkouts);
    await page.waitForFunction((id) => app.completedWorkouts.some((r) => r.id === id && r.strava?.state === 'sent'), rideId, { timeout: 10000 });
    step('after an app restart the ride and its Strava link are still there');

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
  }
  if (failed) process.exit(1);
  console.log('native-browser: all checks passed');
})();
