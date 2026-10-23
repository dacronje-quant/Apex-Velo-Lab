// Phone UX checks (docs/ANDROID-UX.md, acceptance criteria) at 393x852 with touch, demo data and the fake native
// layer: tap counts from launch, no sideways page scroll, 44 px touch targets, the bottom bar and Android back.
// The helpers are exported for the screen workstreams (U2-U5): require('./phone-ux.cjs') and add flows, or
// add them to FLOWS below. Run `npm run build` first (npm run test:phone does).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const www = path.resolve(__dirname, '..', 'www');
const ORIGIN = 'https://localhost';
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const executablePath = process.env.APEX_CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const PHONE = { width: 393, height: 852 };
const out = path.join(__dirname, '..', 'test-output');

/** A phone-sized page on the built app, demo data and the fake native layer; resolves once the shell is up. */
async function openPhone(browser, { route = '', demo = true } = {}) {
  const context = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await context.addInitScript({ path: path.join(__dirname, 'fake-native.js') });
  await context.route(`${ORIGIN}/**`, (r) => {
    const url = new URL(r.request().url());
    const file = path.resolve(www, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)));
    if (!file.startsWith(www + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return r.fulfill({ status: 404, body: '' });
    return r.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(file)] || 'application/octet-stream' });
  });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  await page.goto(`${ORIGIN}/index.html${demo ? '?apexDemo=1' : ''}${route ? `#/${route}` : ''}`);
  await page.waitForFunction(() => window.app && window.ApexNative && ApexNative.shell && ApexNative.shell.current);
  return page;
}

/** Taps a visible element (counted) and waits a frame. */
async function tap(page, selector, counter) {
  await page.locator(selector).first().tap();
  if (counter) counter.taps++;
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
}

const route = (page) => page.evaluate(() => ApexNative.shell.current.route);
const back = (page) => page.evaluate(() => window.__nativeListeners && window.__nativeListeners.backButton ? window.__nativeListeners.backButton.forEach((f) => f()) : ApexNative.shell.back());

/**
 * Visible controls under 44x44 px (counting a ::after hit area) and the page's sideways overflow, for what is
 * on screen now. Inline links in prose are exempt; `ignore` is a selector of controls to skip.
 */
async function sweep(page, { ignore = '' } = {}) {
  return page.evaluate((ignore) => {
    const px = (v) => parseFloat(v) || 0;
    const small = [];
    const sel = 'button, a[href], input:not([type=hidden]), select, summary, [role=button], [role=switch], [tabindex]:not([tabindex="-1"])';
    for (const el of document.querySelectorAll(sel)) {
      if (ignore && el.matches(ignore)) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || el.closest('[hidden], [inert]')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.pointerEvents === 'none' || px(cs.opacity) === 0) continue;
      if (r.bottom < 0 || r.top > innerHeight * 4) continue;
      if (el.tagName === 'A' && cs.display === 'inline' && el.parentElement.closest('p, li, small, span.av-note')) continue;
      let w = r.width, h = r.height;
      const a = getComputedStyle(el, '::after');
      if (a.content && a.content !== 'none' && a.position === 'absolute') {
        w = Math.max(w, r.width - px(a.left) - px(a.right));
        h = Math.max(h, r.height - px(a.top) - px(a.bottom));
      }
      if (w < 43.5 || h < 43.5) small.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 24)}" ${Math.round(w)}x${Math.round(h)}`);
    }
    return { small, overflowX: document.documentElement.scrollWidth - innerWidth };
  }, ignore);
}

async function screenshot(page, name) {
  fs.mkdirSync(out, { recursive: true });
  await page.screenshot({ path: path.join(out, `phone-${name}.png`) }).catch(() => {});
}

module.exports = { openPhone, tap, route, back, sweep, screenshot, PHONE };

// ---------------------------------------------------------------------------------------------------- flows --

const step = (name) => console.log('  ok -', name);

const FLOWS = [
  ['shell: five bottom tabs, each opens its root; the open tab scrolls to top; back goes to Ride, then leaves', async (browser) => {
    const page = await openPhone(browser);
    assert.equal(await route(page), 'ride');
    const tabs = await page.locator('.av-tabbar [data-av-tab]').allTextContents();
    assert.deepEqual(tabs.map((t) => t.trim()), ['Ride', 'Train', 'History', 'Progress', 'You']);
    for (const [tab, root] of [['train', 'train/plan'], ['history', 'history'], ['progress', 'progress'], ['you', 'you']]) {
      await tap(page, `.av-tabbar [data-av-tab="${tab}"]`);
      assert.equal(await route(page), root);
      assert.ok(await page.locator('.av-tabbar').isVisible(), `bottom bar on ${root}`);
    }
    await back(page);
    assert.equal(await route(page), 'ride', 'back from a tab root goes to Ride');
    await page.evaluate(() => { window.__exited = false; ApexNative.shell.exit = () => { window.__exited = true; }; });
    await back(page);
    assert.equal(await page.evaluate(() => window.__exited), true, 'back on Ride leaves the app');
    await page.context().close();
  }],
  ['shell: deep links open their screen; the app\'s own tab switches follow the routes; sheets close on back', async (browser) => {
    const page = await openPhone(browser, { route: 'train/workouts' });
    assert.equal(await route(page), 'train/workouts');
    assert.ok(await page.locator('#view-workouts').isVisible());
    await tap(page, '.av-subnav [data-av-seg="train/ask"]');
    assert.equal(await route(page), 'train/ask');
    assert.ok(await page.locator('#view-ask').isVisible());
    await page.evaluate(() => app.switchTab('history'));
    assert.equal(await route(page), 'history');
    await page.evaluate(() => { const d = document.createElement('div'); d.id = 'sheetProbe'; d.textContent = 'probe'; ApexNative.shell.openSheet(d, { title: 'Probe' }); });
    assert.ok(await page.locator('.av-sheet #sheetProbe').isVisible());
    await back(page);
    assert.equal(await page.locator('#sheetProbe').count(), 0);
    assert.equal(await route(page), 'history', 'back closed the sheet only');
    await page.context().close();
  }]
];


// ------------------------------------------------------------------------------------------ ride parity --
// Every control and output of today's cockpit, Zen view and Devices panel, and where the phone ride screen has it.
// [feature, where, selector]: where is simple (ride/live), full (ride/cockpit, all metrics), controls (the Controls
// sheet), devices (the devices sheet) or details (the app's Devices panel, opened from Controls).
const PARITY = [
  ['current power (smoothed)', 'simple', '#avRidePower'], ['target power and % FTP', 'simple', '#avRideTarget'],
  ['power vs target deviation', 'simple', '#avRideDev'], ['step countdown (pulses before a change)', 'simple', '#avRideCountdown'],
  ['step name, number, zone', 'simple', '#avRideStep'], ['total elapsed', 'simple', '#avRideClock'], ['workout progress', 'simple', '#avRideProgress'],
  ['workout profile with position', 'simple', '.av-ride-profile #intervalCanvas'], ['up next (Zen)', 'simple', '#avRideNext'],
  ['coach / pedalling insight', 'simple', '#avRideCoach'], ['End (stop & save)', 'simple', '#avRideEnd'], ['Start / Pause / Resume', 'simple', '#avRidePause'], ['Skip step', 'simple', '#avRideSkip'],
  ...['power', 'p1s', 'p3s', 'p30s', 'target', 'wkg', 'hr', 'cadence', 'wbal', 'lr', 'speed', 'distance', 'avg', 'np', 'if', 'tss', 'elapsed', 'stepLeft', 'zone', 'deviation', 'intensity', 'erg', 'source', 'powermatch', 'readiness', 'zoneTime']
    .map((t) => [`tile: ${t}`, 'simple', `[data-av-item="tile:${t}"]`]),
  ['interval name and countdown', 'full', '#hudIntervalName'], ['status pill', 'full', '#hudWorkoutStatusPill'], ['target and cadence target tags', 'full', '#hudCadenceTargetTag'],
  ['compliance pill', 'full', '#hudCompliancePill'], ['rider badge', 'full', '#cockpitRiderBadge'], ['power ring', 'full', '#valInstantPower'],
  ['power source badge', 'full', '#hudPowerSourceBadge'], ['ERG status pill (toggles ERG)', 'full', '#hudErgStatusPill'],
  ['1s / 3s / 30s / target / W/kg', 'full', '#valWkg'], ['intensity ±5 (dock)', 'full', '#btnBiasPlus5'], ['heart rate + zone', 'full', '#valHrZone'],
  ['cadence + target', 'full', '#valCadenceSub'], ['W′ balance card', 'full', '#wbalCard'], ['workout title, duration, expected avg', 'full', '#hudWorkoutAvgPower'],
  ['distance, speed', 'full', '#valDistance'], ['avg power, NP, IF, TSS, kJ', 'full', '#valTotalKj'], ['interval queue (tap to jump)', 'full', '#upcomingIntervalsStrip .upcoming-card'],
  ['live graph (power, target, cadence, HR)', 'full', '#liveTelemetryChart'], ['left / right balance and leg power', 'full', '#valLeftWatts'],
  ['time in zone', 'full', '#zTime4'], ['in-cockpit step controls (reset, stand, ±30 s, ±1 %)', 'full', '#btnStand'],
  ['intensity ±1 / ±5', 'controls', '#avIntensityRow [data-av-press="btnBiasPlus1"]'], ['intensity reset', 'controls', '#avBiasReset'],
  ['ERG on / off', 'controls', '#avErgSwitch'], ['shorten / extend step', 'controls', '[data-av-press="btnExtendInterval"]'], ['stand 30 s', 'controls', '#avStand'],
  ['reset workout', 'controls', '#avResetWorkout'], ['power smoothing 1s-1m', 'controls', '#avControlsSheet .smooth-pill[data-sec="60"]'],
  ['ERG response', 'controls', '#avControlsSheet #ergResponse'], ['all metrics / simple view (Zen, Focus)', 'controls', '#avToggleFull'],
  ['customise screen', 'controls', '#avCustomise'], ['audio cues', 'controls', '#avAudioSwitch'], ['simulator', 'controls', '#avSimSwitch'],
  ['devices', 'controls', '#avControlsDevices'], ['rider profile', 'controls', '#avRider'], ['device details', 'controls', '#avDeviceDetails'],
  ['device list, state, connect', 'devices', '#avDevicesSheet'], ['pair a new device', 'devices', '#avPairDevice'],
  ['calibration (zero offset)', 'details', '#btnCalibratePedalsModal'], ['PowerMatch', 'details', '#chkEnablePowerMatch'],
  ['power / cadence source', 'details', '#devicePowerSource'], ['fan (KICKR HEADWIND)', 'details', '#fanModeSelect'],
  ['rename / replace / forget', 'details', '#deviceRename-trainer'], ['connect saved / pair / all Bluetooth', 'details', '#btnPairDeviceBroad']
];

async function openWhere(page, where) {
  await page.evaluate(() => { while (ApexNative.shell.sheets.length) ApexNative.shell.closeSheet(); const m = document.getElementById('hardwareModal'); if (m && !m.hidden) app.closeDevicesFocus(); });
  if (where === 'simple' || where === 'controls' || where === 'details') await page.evaluate(() => ApexNative.shell.go('ride/live'));
  if (where === 'full') await page.evaluate(() => ApexNative.shell.go('ride/cockpit'));
  if (where === 'devices') { await page.evaluate(() => ApexNative.shell.go('ride')); await tap(page, '#avDevicesChip'); }
  if (where === 'controls' || where === 'details') await tap(page, '#avRideControls');
  if (where === 'details') { await page.locator('#avDeviceDetails').scrollIntoViewIfNeeded(); await tap(page, '#avDeviceDetails'); await page.evaluate(() => document.querySelectorAll('#hardwareModal details').forEach((d) => { d.open = true; })); }
}

FLOWS.push(['ride parity: every cockpit, Zen and Devices feature is reachable from the ride screen (Everything preset)', async (browser) => {
  const page = await openPhone(browser);
  await page.evaluate(() => { const r = ApexNative.rideTab.ride; r.layouts.preset(app.activeProfileId, 'everything'); });
  await tap(page, '#avStartRide');
  await page.waitForTimeout(2500);
  const missing = [];
  let at = '';
  for (const [feature, where, sel] of PARITY) {
    if (where !== at) { await openWhere(page, where); at = where; }
    const loc = page.locator(sel).first();
    // The Devices panel is the app's own, unchanged: a device's card shows once a device of that kind is saved.
    const ok = where === 'details' ? (await loc.count()) > 0 && (await page.locator('#hardwareModal').isVisible()) : (await loc.count()) > 0 && (await loc.isVisible());
    if (!ok) missing.push(`${feature} (${where}: ${sel})`);
  }
  assert.deepEqual(missing, [], 'features missing from the ride screen');
  assert.deepEqual(page.errors, []);
  await page.context().close();
}]);

FLOWS.push(['ride: taps from launch (start 1, devices sheet 1, last ride 2), no sideways scroll, 44 px targets, Today ≤ 1.5 screens', async (browser) => {
  let page = await openPhone(browser);
  const c = { taps: 0 };
  assert.ok((await page.evaluate(() => document.documentElement.scrollHeight)) <= 852 * 1.5 + 80, 'Today fits 1.5 screens');
  let sw = await sweep(page);
  assert.deepEqual(sw.small, [], 'small targets on Today'); assert.ok(sw.overflowX <= 0, 'Today scrolls sideways');
  await tap(page, '#avDevicesChip', c);
  assert.equal(c.taps, 1); assert.ok(await page.locator('#avDevicesSheet').isVisible());
  sw = await sweep(page); assert.deepEqual(sw.small, [], 'small targets on the devices sheet');
  await back(page);
  c.taps = 0; await tap(page, '#avLastRide', c); assert.equal(c.taps, 1); // Today shows the last ride: 1 tap (budget 2)
  assert.match(await route(page), /^history\//);
  await page.context().close();
  page = await openPhone(browser);
  c.taps = 0; await tap(page, '#avStartRide', c);
  assert.equal(c.taps, 1); assert.equal(await route(page), 'ride/live');
  await page.waitForFunction(() => app.isPlaying);
  assert.equal(await page.locator('.av-tabbar').isVisible(), false, 'no tab bar while riding');
  for (const r of ['ride/live', 'ride/cockpit']) {
    await page.evaluate((r) => ApexNative.shell.go(r), r);
    await page.waitForTimeout(300);
    sw = await sweep(page);
    assert.deepEqual(sw.small, [], `small targets on ${r}`); assert.ok(sw.overflowX <= 0, `${r} scrolls sideways (${sw.overflowX})`);
  }
  await screenshot(page, 'ride-cockpit');
  await page.evaluate(() => ApexNative.shell.go('ride/live'));
  await tap(page, '#avRideControls');
  sw = await sweep(page); assert.deepEqual(sw.small, [], 'small targets on Controls'); assert.ok(sw.overflowX <= 0);
  await page.context().close();
}]);

FLOWS.push(['ride: back asks before ending, End saves and returns to Today, all metrics back to simple', async (browser) => {
  const page = await openPhone(browser);
  await tap(page, '#avStartRide');
  await page.waitForFunction(() => app.totalElapsedSeconds >= 2, null, { timeout: 15000 });
  await page.evaluate(() => ApexNative.shell.go('ride/cockpit'));
  await back(page);
  assert.equal(await route(page), 'ride/live');
  await back(page);
  assert.ok(await page.locator('#avEndConfirm').isVisible(), 'back mid-ride asks first');
  await tap(page, '#avEndCancel');
  assert.equal(await route(page), 'ride/live'); assert.ok(await page.evaluate(() => app.isPlaying));
  const before = await page.evaluate(() => app.completedWorkouts.length);
  await tap(page, '#avRideEnd'); await tap(page, '#avEndConfirm');
  await page.waitForFunction((n) => app.completedWorkouts.length === n + 1, before);
  assert.equal(await route(page), 'ride');
  await page.context().close();
}]);

FLOWS.push(['ride: customise tiles, panels and graph lines per rider, presets and reset; kept after a restart', async (browser) => {
  let page = await openPhone(browser, { demo: false }); // the demo keeps its storage in memory
  await tap(page, '#avStartRide');
  await tap(page, '#avRideControls'); await page.locator('#avCustomise').scrollIntoViewIfNeeded(); await tap(page, '#avCustomise');
  await tap(page, '[data-av-cust="tile:hr"] [data-toggle]');
  assert.equal(await page.locator('#avRide [data-av-item="tile:hr"]').isHidden(), true, 'tile switched off');
  await tap(page, '[data-av-cust="panel:next"] [data-move="-1"]');
  const order = await page.evaluate(() => [...document.querySelectorAll('[data-av-cust]')].map((n) => n.dataset.avCust).slice(0, 3));
  assert.deepEqual(order, ['panel:hero', 'panel:next', 'panel:profile']);
  await tap(page, '.av-customise [data-which="full"]');
  await tap(page, '[data-av-cust="graph"] [data-toggle]');
  await tap(page, '[data-line="hr"]');
  assert.equal(await page.evaluate(() => app.telemetryChart.data.datasets.find((d) => /^Heart rate/.test(d.label)).hidden), true, 'HR line hidden');
  await page.reload();
  await page.waitForFunction(() => window.app && ApexNative.shell.current);
  const l = await page.evaluate(() => ApexNative.rideTab.ride.layout());
  assert.equal(l.simple.find((x) => x.id === 'tile:hr').on, false);
  assert.equal(l.full.find((x) => x.id === 'graph').on, false);
  assert.equal(l.lines.hr, false);
  const other = await page.evaluate(() => ApexNative.rideTab.ride.layouts.get('someone-else'));
  assert.equal(other.simple.find((x) => x.id === 'tile:hr').on, true, 'per rider');
  await page.evaluate(() => ApexNative.shell.go('ride/live'));
  await tap(page, '#avRideControls'); await page.locator('#avCustomise').scrollIntoViewIfNeeded(); await tap(page, '#avCustomise');
  await tap(page, '[data-preset="minimal"]');
  assert.equal(await page.locator('#avRide [data-av-item="panel:profile"]').isHidden(), true, 'Minimal hides the profile');
  await tap(page, '[data-preset="everything"]');
  assert.equal(await page.locator('#avRide [data-av-item="tile:np"]').isHidden(), false, 'Everything shows NP');
  await tap(page, '[data-preset="reset"]');
  assert.equal(await page.locator('#avRide [data-av-item="tile:np"]').isHidden(), true, 'Reset is Standard');
  assert.equal(await page.locator('#avRide [data-av-item="tile:hr"]').isHidden(), false);
  await page.context().close();
}]);


// ------------------------------------------------------------------------------------------ train parity --
// Every feature of today's Workouts, Coach, Calendar and Ask views, and where the Train tab has it.
// [feature, route, selector, setup?]: setup runs on the route before the check (opens a sheet or a mode).
const sheetOf = (id) => async (page) => { await page.evaluate((id) => ApexNative.trainTab.openWorkout(id), id); };
const TRAIN_PARITY = [
  ['week strip with planned and ridden days', 'train/plan', '.av-week-strip [data-av-day]'],
  ['the day\'s session: ride it / swap', 'train/plan', '#avPlanSwap'],
  ['training block: build, re-plan, open', 'train/plan', '#avPlanBuild'],
  ['coach and calendar', 'train/plan', '#avOpenCalendar'],
  ['library list (name, duration, TSS)', 'train/workouts', '#avWorkoutList [data-av-workout]'],
  ...['all', 'endurance', 'sweetspot', 'threshold', 'vo2', 'hardstart', 'custom', 'assessment'].map((c) => [`filter: ${c}`, 'train/workouts', `[data-av-cat="${c}"]`]),
  ['search', 'train/workouts', '#avWorkoutSearch', async (page) => { await tap(page, '#avWorkoutSearchBtn'); }],
  ['show the whole library', 'train/workouts', '#avWorkoutsAll'],
  ['workout sheet: profile, ride it', 'train/workouts', '#avWorkoutSheet #avWorkoutRide', sheetOf('carson')],
  ['workout sheet: fine-tune', 'train/workouts', '#avWorkoutSheet #avWorkoutEdit', sheetOf('carson')],
  ['ramp test (Tests)', 'train/workouts', '#avWorkoutList [data-av-workout]', async (page) => { await tap(page, '[data-av-cat="assessment"]'); }],
  ['Describe a workout (examples, create)', 'train/workouts', '.av-sheet #describeInput', async (page) => { await tap(page, '#avDescribe'); }],
  ['describe: create', 'train/workouts', '.av-sheet #btnDescribeCreate', async (page) => { await tap(page, '#avDescribe'); }],
  ['custom interval builder: steps table', 'train/builder', '#customIntervalTableBody tr'],
  ['custom interval builder: add step', 'train/builder', '#btnAddIntervalRow'],
  ['save as preset (saved workouts)', 'train/builder', '#btnSaveCustomAsPreset'],
  ['ride the fine-tuned workout', 'train/builder', '#avBuilderRide'],
  ['coach: one workout or plan', 'train/coach', '#coachModePills [data-coach-mode="plan"]'],
  ['coach: goal', 'train/coach', '#aiCoachGoalPills [data-goal="vo2"]'],
  ['coach: focus, time available', 'train/coach', '#selectAiCoachFocus'],
  ['coach: notes, look-back', 'train/coach', '#inputAiCoachNotes'],
  ['coach: form, fitness, fatigue, readiness', 'train/coach', '#coachReadinessChip'],
  ['coach: insights', 'train/coach', '#aiCoachInsights', async (page) => { await tap(page, '.av-coach-insights > summary'); }],
  ['coach: prescribe / build (top bar too)', 'train/coach', '#btnGenerateAiCoachRecommendation'],
  ['coach: training terms explained', 'train/coach', '#view-ai-coach [data-training-guide]'],
  ['plan: weeks, days, long day, start, hours', 'train/coach', '#blockDays [data-dow="5"]', async (page) => { await page.evaluate(() => ApexNative.trainTab.openCoach('plan')); }],
  ['plan: block weeks', 'train/coach', '#selectBlockWeeks + .chip-select, #selectBlockWeeks', async (page) => { await page.evaluate(() => ApexNative.trainTab.openCoach('plan')); }],
  ['calendar: week / month / year / all time', 'train/calendar', '#calPresetPills [data-preset="ytd"]'],
  ['calendar: prev / next / current', 'train/calendar', '#btnCalNextWeek'],
  ['calendar: load rollup', 'train/calendar', '#calWeeklyTss'],
  ['calendar: days', 'train/calendar', '#calendarContentArea > *'],
  ['ask: question box and send', 'train/ask', '#askInput'],
  ['ask: period', 'train/ask', '#askPeriodPills .ask-period'],
  ['ask: what the AI sees', 'train/ask', '#askDataPeek > summary'],
  ['ask: AI engine', 'train/ask', '#btnAskEngine'],
  ['ask: thread (suggestions, history)', 'train/ask', '#askThread']
];

FLOWS.push(['train parity: every Workouts, Coach, Calendar and Ask feature is reachable from the Train tab', async (browser) => {
  const page = await openPhone(browser);
  const missing = [];
  for (const [feature, r, sel, setup] of TRAIN_PARITY) {
    await page.evaluate((r) => { while (ApexNative.shell.sheets.length) ApexNative.shell.closeSheet(); ApexNative.shell.go(r); }, r);
    if (setup) await setup(page);
    const loc = page.locator(sel).first();
    if (!((await loc.count()) > 0 && (await loc.isVisible()))) missing.push(`${feature} (${r}: ${sel})`);
  }
  assert.deepEqual(missing, [], 'features missing from the Train tab');
  // The recovery strip and rollup are the calendar's own (they show with recovery data); they stay in the hosted view.
  await page.evaluate(() => ApexNative.shell.go('train/calendar'));
  assert.equal(await page.locator('#view-calendar #calRecoveryRollup').count(), 1);
  for (const p of ['1month', 'ytd', '1week']) { await tap(page, `#calPresetPills [data-preset="${p}"]`); assert.ok(await page.locator('#calendarContentArea > *').first().isVisible(), p); }
  assert.deepEqual(page.errors, []);
  await page.context().close();
}]);

FLOWS.push(['train: taps from launch (library workout 4 → ride screen, ask 2), roots ≤ 1.5 screens, no sideways scroll, 44 px targets', async (browser) => {
  let page = await openPhone(browser);
  const c = { taps: 0 };
  await tap(page, '.av-tabbar [data-av-tab="train"]', c);
  assert.equal(await route(page), 'train/plan');
  await tap(page, '.av-subnav [data-av-seg="train/workouts"]', c);
  await tap(page, '#avWorkoutList [data-av-workout]:nth-child(3)', c);
  const id = await page.evaluate(() => document.querySelector('#avWorkoutList [data-av-workout]:nth-child(3)').dataset.avWorkout);
  await tap(page, '#avWorkoutRide', c);
  assert.equal(c.taps, 4, 'pick and start a library workout');
  assert.equal(await route(page), 'ride/live');
  await page.waitForFunction(() => app.isPlaying);
  assert.equal(await page.evaluate(() => app.currentWorkout.id), id);
  await page.context().close();
  page = await openPhone(browser);
  c.taps = 0;
  await tap(page, '.av-tabbar [data-av-tab="train"]', c);
  await tap(page, '.av-subnav [data-av-seg="train/ask"]', c);
  assert.equal(c.taps, 2); assert.equal(await route(page), 'train/ask');
  const box = await page.locator('#askInput').boundingBox();
  assert.ok(box && box.y + box.height <= 852 - 76, 'question box above the fold and the tab bar');
  for (const r of ['train/plan', 'train/workouts', 'train/ask', 'train/coach', 'train/calendar', 'train/builder']) {
    await page.evaluate((r) => ApexNative.shell.go(r), r);
    await page.waitForTimeout(300);
    const sw = await sweep(page, { ignore: '.sr-only' });
    assert.deepEqual(sw.small, [], `small targets on ${r}`); assert.ok(sw.overflowX <= 0, `${r} scrolls sideways (${sw.overflowX})`);
    assert.ok(await page.locator('.av-tabbar').isVisible(), `bottom bar on ${r}`);
    if (['train/plan', 'train/workouts', 'train/ask'].includes(r)) assert.ok((await page.evaluate(() => document.documentElement.scrollHeight)) <= 852 * 1.5 + 80, `${r} fits 1.5 screens`);
    await screenshot(page, r.replace('/', '-'));
  }
  // Detail pages keep their main action above the fold.
  await page.evaluate(() => ApexNative.shell.go('train/coach'));
  assert.ok(await page.locator('#avCoachGo').isVisible());
  await page.evaluate(() => ApexNative.trainTab.openWorkout('carson'));
  const sw = await sweep(page, { ignore: '.sr-only' }); assert.deepEqual(sw.small, [], 'small targets on the workout sheet');
  await page.evaluate(() => ApexNative.shell.closeSheet());
  await page.evaluate(() => ApexNative.shell.go('train/workouts'));
  await tap(page, '#avDescribe');
  const sd = await sweep(page, { ignore: '.sr-only' }); assert.deepEqual(sd.small, [], 'small targets on Describe');
  assert.deepEqual(page.errors, []);
  await page.context().close();
}]);

FLOWS.push(['train: back follows the stack; the app\'s own switches land on Train; ramp test and Fine-tune ride; Ask history kept', async (browser) => {
  let page = await openPhone(browser, { route: 'train/plan' });
  await tap(page, '#avOpenCalendar'); assert.equal(await route(page), 'train/calendar');
  await back(page); assert.equal(await route(page), 'train/plan');
  await tap(page, '#avOpenCoach'); assert.equal(await route(page), 'train/coach');
  await back(page); assert.equal(await route(page), 'train/plan');
  await back(page); assert.equal(await route(page), 'ride', 'a Train root goes back to Ride');
  await page.evaluate(() => app.switchTab('calendar')); assert.equal(await route(page), 'train/calendar');
  await page.evaluate(() => app.switchTab('ai-coach')); assert.equal(await route(page), 'train/coach');
  await page.evaluate(() => app.switchTab('workouts')); assert.equal(await route(page), 'train/workouts');
  // Fine-tune: the builder edits the loaded workout; back returns to Workouts.
  await page.evaluate(() => ApexNative.trainTab.openWorkout('carson'));
  await tap(page, '#avWorkoutEdit'); assert.equal(await route(page), 'train/builder');
  assert.equal(await page.evaluate(() => app.currentWorkout.id), 'carson');
  const rows = await page.locator('#customIntervalTableBody tr').count();
  await tap(page, '#btnAddIntervalRow');
  assert.equal(await page.locator('#customIntervalTableBody tr').count(), rows + 1, 'add step');
  await back(page); assert.equal(await route(page), 'train/workouts');
  assert.equal(await page.locator('#view-workouts #customWorkoutTableSection').count(), 1, 'the table goes back to its view');
  // Ramp test from Tests: the open-ended test is loaded and the ride screen starts.
  await tap(page, '[data-av-cat="assessment"]');
  await tap(page, '#avWorkoutList [data-av-workout]');
  await tap(page, '#avWorkoutRide');
  assert.equal(await route(page), 'ride/live');
  assert.ok(await page.evaluate(() => !!app.rampTestConfig(app.currentWorkout)), 'ramp test loaded');
  await page.context().close();
  // Coach: today's workout from the built-in engine, Load into cockpit opens the Ride tab with it.
  page = await openPhone(browser, { route: 'train/coach' });
  await tap(page, '#avCoachGo');
  await page.waitForSelector('#btnLoadAiCoachWorkout', { state: 'visible', timeout: 30000 });
  const title = (await page.locator('#aiCoachWorkoutTitle').textContent()).trim();
  await page.locator('#btnLoadAiCoachWorkout').scrollIntoViewIfNeeded(); await tap(page, '#btnLoadAiCoachWorkout');
  assert.equal(await route(page), 'ride');
  assert.equal(await page.evaluate(() => app.currentWorkout.title), title);
  // Plan: a block from the built-in engine shows on Plan with Re-plan; a planned day rides from Plan.
  await page.evaluate(() => ApexNative.trainTab.openCoach('plan'));
  await page.evaluate(() => document.querySelectorAll('#blockDays [data-dow]').forEach((b) => { if (!b.classList.contains('active')) b.click(); }));
  await tap(page, '#avCoachGo');
  await page.waitForFunction(() => app.blockPlanner.block, null, { timeout: 30000 });
  await page.evaluate(() => ApexNative.shell.go('train/plan'));
  assert.ok(await page.locator('#avPlanReplan').isVisible(), 'block on Plan');
  const day = await page.evaluate(() => { const m = app.blockPlanner.sessionsByDate(); const d = [...document.querySelectorAll('[data-av-day]')].find((b) => (m.get(b.dataset.avDay) || []).some((s) => s.status === 'planned')); return d && d.dataset.avDay; });
  assert.ok(day, 'a planned day this week');
  await tap(page, `[data-av-day="${day}"]`);
  await screenshot(page, 'train-plan-block');
  await tap(page, '#avPlanRide');
  assert.equal(await route(page), 'ride/live');
  assert.ok(await page.evaluate(() => /^blk_/.test(app.currentWorkout.id)), 'planned session loaded');
  await page.context().close();
  // Ask history: the saved chat comes back after a restart.
  page = await openPhone(browser, { route: 'train/ask', demo: false });
  await page.evaluate(() => { app.askMessages.push({ role: 'user', content: 'Parity probe question' }, { role: 'assistant', content: 'Parity probe answer' }); app.saveAsk(); });
  await page.reload();
  await page.waitForFunction(() => window.app && ApexNative.shell.current);
  assert.equal(await route(page), 'train/ask');
  assert.match(await page.locator('#askThread').textContent(), /Parity probe answer/);
  await page.evaluate(() => app.newAskChat());
  await page.context().close();
}]);

module.exports.TRAIN_PARITY = TRAIN_PARITY;

module.exports.PARITY = PARITY;

if (require.main === module) {
  (async () => {
    const browser = await chromium.launch({ executablePath });
    let failed = false;
    const only = process.argv[2];
    for (const [name, fn] of FLOWS) {
      if (only && !name.includes(only)) continue;
      try { await fn(browser); step(name); } catch (e) { failed = true; console.error('not ok -', name, '\n', e); }
    }
    await browser.close();
    if (failed) process.exit(1);
    console.log('phone-ux: all checks passed');
  })();
} else module.exports.FLOWS = FLOWS;
