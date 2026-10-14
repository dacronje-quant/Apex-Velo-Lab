// Real app, disposable browser storage and local request fixtures. No rider server or BLE device.
const { chromium } = require('playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), origin = 'http://apex-ramp.local';
const out = path.join(root, 'test-output/ramp-test'); fs.mkdirSync(out, { recursive: true });

(async () => {
  const browser = await chromium.launch(require('./browser-options.cjs'));
  const errors = []; let snapshot = null, fit = null;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    context.on('page', page => page.on('pageerror', e => errors.push(e.message)));
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname.startsWith('/api/')) {
        const data = url.pathname === '/api/live' ? { snapshot, fit, ageMs: 0 }
          : url.pathname === '/api/health/inbox' ? { files: [] }
          : url.pathname === '/api/health/status' ? { token: 'fixture', urls: [], phoneUrls: [] }
          : url.pathname === '/api/strava/status' ? { configured: false, connected: false }
          : url.pathname === '/api/local-history' ? null : { ok: true };
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
      }
      const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.resolve(root, relative);
      if (!file.startsWith(root + path.sep) || relative.startsWith('.') || relative.startsWith('data/') || !fs.existsSync(file)) {
        return route.fulfill({ status: 404, body: '' });
      }
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
      return route.fulfill({ contentType: types[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
    });
    const page = await context.newPage();
    await page.goto(origin + '/?apexTest=1');
    await page.waitForFunction(() => window.app && app.workoutLibrary);
    await page.locator('.nav-btn[data-tab="workouts"]').click();
    const card = page.locator('.workout-preset-card[data-id="ramp"]');
    assert.match(await card.textContent(), /Until your limit/);
    assert.doesNotMatch(await card.locator('.w-card-meta').textContent(), /18m|25m|peak/);
    await card.locator('[data-act="load"]').click();
    assert.equal(await page.locator('#hudWorkoutDuration').textContent(), 'At your limit');
    assert.equal(await page.locator('#hudWorkoutDurationLabel').textContent(), 'Finishes');
    await page.evaluate(() => {
      app.simulator.enabled = false;
      app.clock.start = () => {}; app.acquireWakeLock = () => {};
      app._rampCommands = []; app._rampStops = 0;
      app.ble.setTrainerErgPower = watts => app._rampCommands.push(watts);
      app.ble.stopTrainerWorkout = () => { app._rampStops++; };
      app.ble.startTrainerWorkout = () => {}; app.ble.pauseTrainerWorkout = () => {};
      app.ble.isTrainerConnected = () => true;
      app._remoteEnabled = true; app.publishSoon = () => {};
      // Accelerated ride seconds need distinct wall timestamps for the real FIT encoder.
      window._rampWallClock = Date.now(); Date.now = () => window._rampWallClock;
      window.rampTicks = (count, power = null, cadence = 90) => {
        for (let i = 0; i < count && app.isPlaying; i++) {
          window._rampWallClock += 1000;
          const watts = power ?? app.getCurrentTargetWatts();
          app.handleBleTelemetry({ type: 'pedals', watts, cadence });
          app.handleBleTelemetry({ type: 'trainer', watts, cadence });
          app.tick1Hz();
        }
      };
    });
    await page.locator('#btnPlayPause').click();
    await page.evaluate(() => rampTicks(1080)); // Entire old plan including the warmup, at target.
    const extended = await page.evaluate(() => ({ playing: app.isPlaying, complete: app.isWorkoutCompleted,
      target: app.getCurrentTargetWatts(), ftp: app.activeProfile.ftp, count: app.currentWorkout.intervals.length,
      libraryCount: app.workoutLibrary.find(w => w.id === 'ramp').intervals.length, remaining: app.intervalSecondsRemaining }));
    assert.equal(extended.playing, true); assert.equal(extended.complete, false);
    assert.equal(extended.count, extended.libraryCount + 1);
    assert.equal(extended.target, Math.round(extended.ftp * 1.41)); assert.equal(extended.remaining, 60);
    await page.screenshot({ path: path.join(out, 'desktop-continuing.png'), animations: 'disabled' });

    await page.evaluate(() => rampTicks(9)); // Let the new target settle.
    await page.evaluate(() => rampTicks(5, Math.round(app.getCurrentTargetWatts() * 0.6)));
    assert.equal(await page.evaluate(() => app.isWorkoutCompleted), false, 'a short dip does not end the test');
    assert.match(await page.locator('#hudCompliancePill').textContent(), /TARGET LOW/);
    snapshot = await page.evaluate(() => app.buildRemoteSnapshot());
    const phone = await context.newPage(); await phone.setViewportSize({ width: 390, height: 844 });
    await phone.goto(origin + '/live.html');
    await phone.waitForFunction(() => document.getElementById('trLeft').textContent === 'LIMIT');
    assert.match(await phone.locator('#trIntSub').textContent(), /until your limit/);
    assert.match(await phone.locator('#trPowerSub').textContent(), /Target low/);
    await phone.screenshot({ path: path.join(out, 'phone-target-low.png'), animations: 'disabled' });
    await page.evaluate(() => rampTicks(12, Math.round(app.getCurrentTargetWatts() * 0.6)));
    await page.waitForFunction(() => app.isWorkoutCompleted && app.completedWorkouts.length === 1);
    await page.waitForFunction(() => document.getElementById('rideSummaryModal').classList.contains('open'));
    assert.match(await page.locator('#modalRideDetails').textContent(), /target could no longer be held/);
    const completed = await page.evaluate(() => {
      const r = app.completedWorkouts[0];
      const parsed = VeloRideImporter.parseFit(app._remoteFitUpload.bytes.buffer, 'Fixture', app.activeProfile.ftp);
      return { reason: r.rampTest.reason, last: r.samples.at(-1).power, samples: r.samples.length,
        fitSamples: parsed.samples.length, fitLast: parsed.samples.at(-1).power,
        stops: app._rampStops, spin: app._easySpinOffer, ftp: app.activeProfile.ftp,
        stored: JSON.parse(localStorage.getItem('apex_velo_history') || '[]').length };
    });
    assert.equal(completed.reason, 'target-missed'); assert.equal(completed.stops, 1);
    assert.equal(completed.spin, null); assert.equal(completed.fitSamples, completed.samples);
    assert.equal(completed.fitLast, completed.last); assert.equal(completed.ftp, extended.ftp);
    assert.equal(completed.stored, 1);
    await page.screenshot({ path: path.join(out, 'desktop-complete.png'), animations: 'disabled' });
    snapshot = await page.evaluate(() => app.buildRemoteSnapshot());
    fit = { id: snapshot.completedRide.id, filename: 'fixture-ramp.fit' };
    await phone.waitForFunction(() => document.getElementById('rideSavedTitle').textContent === 'Ramp test complete');
    assert.equal(await phone.locator('#trIntLeft').textContent(), 'DONE');
    assert.match(await phone.locator('#trNext').textContent(), /target could no longer be held/);
    assert.match(await phone.locator('#rampTestResult').textContent(), /target could no longer be held/);
    assert.equal(await phone.locator('#btnDownloadFit').isVisible(), true);
    for (const size of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await phone.setViewportSize(size);
      const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      assert.equal(overflow, false, 'phone layout fits ' + JSON.stringify(size));
    }
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.screenshot({ path: path.join(out, 'phone-complete.png'), animations: 'disabled' });
    await page.locator('#btnCloseModal').click();
    await page.locator('#btnPlayPause').click(); // Restart clears generated ramp steps and pending failure.
    assert.equal(await page.evaluate(() => app.currentWorkout.intervals.length), extended.libraryCount);
    assert.equal(await page.evaluate(() => app.erg.testMonitor.under), 0);
    assert.equal(await page.evaluate(() => app.completedWorkouts.length), 1);
    await page.evaluate(() => app.togglePlayPause());
    assert.deepEqual(errors, []);
    console.log('Passed: real ramp selection/start, complete old-plan replay, continuing ramp, brief-dip tolerance, desktop/phone target-low feedback, auto finish/save, trainer stop, final-second FIT export, unchanged FTP, reset cleanup, phone portrait/landscape fit and no runtime errors.');
    console.log('Screenshots: test-output/ramp-test/');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
