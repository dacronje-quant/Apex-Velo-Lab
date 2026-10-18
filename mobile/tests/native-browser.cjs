// End-to-end check of the Android layer in Chromium: the built www/ served at https://localhost (the
// origin Capacitor uses), with tests/fake-native.js standing in for the BLE plugin, native HTTP and
// the other plugins. Covers pairing, ERG control, recording and saving a ride, auto-reconnect,
// Strava sign-in, upload and sync, the on-phone AI engine (API key, Ask, coach) and intervals.icu health. Run `npm run build` first.
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
    assert.equal(await page.locator('#settingsNav [data-sec="backups"]').isVisible(), false);
    assert.equal(await page.evaluate(() => app.healthDays.length), 0);
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
    const stem = await page.evaluate((id) => VeloExport.fileStem(app.completedWorkouts.find((r) => r.id === id)), rideId);
    await page.waitForFunction((p) => __nativeLog.files.some((f) => f.path === p && f.directory === 'DOCUMENTS'), `ApexVelo/${stem}.fit`);
    const autoFit = await page.evaluate((p) => __nativeLog.files.find((f) => f.path === p).data, `ApexVelo/${stem}.fit`);
    assert.equal(Buffer.from(autoFit, 'base64').subarray(8, 12).toString(), '.FIT');
    step(`ride recorded at 200 W, saved on the phone (IndexedDB) and as Documents/ApexVelo/${stem}.fit`);

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
    step('Analytics > Health: tiles, heart rate, HRV with its normal range, both HRV kinds, sleep stages, scores, stress, breathing and weight; cards without data stay hidden');
    step('health: intervals.icu key checked, all history backfilled into readiness with sleep stages, HRV kind switchable (never mixed), later syncs read the last week at most hourly');

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
    await page.evaluate(() => app.openSettings('rider'));
    await page.evaluate(() => __fireNative('backButton'));
    assert.equal(await page.evaluate(() => document.getElementById('settingsModal').classList.contains('open')), false);
    step('exports save to Documents/ApexVelo (a name an old install left gets _2), the image goes to the share sheet, auto-save can be turned off; back closes the open dialog');

    // -------------------------------------------------------------------- persistence --
    await page.reload();
    await page.waitForFunction(() => window.app && app.completedWorkouts);
    await page.waitForFunction((id) => app.completedWorkouts.some((r) => r.id === id && r.strava?.state === 'sent'), rideId, { timeout: 10000 });
    assert.equal(await page.evaluate(() => app.healthDays.length), 30);
    step('after an app restart the ride, its Strava link and the health days are still there');

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
