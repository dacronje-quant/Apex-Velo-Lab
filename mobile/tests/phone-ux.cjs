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

/**
 * A phone-sized page on the built app, demo data and the fake native layer; resolves once the shell is up.
 * `onboarding: true` lets a new install open the first-run onboarding (off otherwise, so flows start on Ride).
 */
async function openPhone(browser, { route = '', demo = true, onboarding = false } = {}) {
  const context = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await context.addInitScript({ path: path.join(__dirname, 'fake-native.js') });
  if (!onboarding) await context.addInitScript(() => { window.__apexNoOnboarding = true; });
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
  }],
  ['history: open the last ride in 2 taps; the detail page hosts the ride summary; back returns to the list', async (browser) => {
    const page = await openPhone(browser);
    const c = { taps: 0 };
    await tap(page, '.av-tabbar [data-av-tab="history"]', c);
    assert.ok(await page.locator('.av-month').first().isVisible(), 'month groups');
    assert.equal(await page.locator('#view-history').isVisible(), false, 'the desktop table is not shown');
    let s = await sweep(page);
    assert.deepEqual(s.small, []); assert.ok(s.overflowX <= 0, 'no sideways scroll on history');
    const newest = await page.evaluate(() => [...app.completedWorkouts].sort((a, b) => new Date(b.date) - new Date(a.date))[0].id);
    await tap(page, '.av-ride-row', c);
    assert.equal(c.taps, 2);
    assert.equal(await route(page), `history/${newest}`);
    await page.locator('.av-ride-detail #modalRideDetails .inspector-header-stats').waitFor();
    assert.equal(await page.evaluate(() => document.getElementById('rideSummaryModal').classList.contains('open')), false, 'no modal on the phone');
    assert.ok((await page.locator('.av-ride-detail .inspector-header-stats').boundingBox()).y < 852, 'KPIs above the fold');
    assert.ok(await page.locator('.av-tabbar').isVisible());
    s = await sweep(page);
    assert.deepEqual(s.small, []); assert.ok(s.overflowX <= 0, 'no sideways scroll on the ride');
    await screenshot(page, 'history-ride');
    await tap(page, '#btnRidePrev');
    assert.notEqual(await route(page), `history/${newest}`, 'previous ride opens in place');
    await back(page);
    assert.equal(await route(page), 'history');
    assert.equal(await page.locator('#rideSummaryModal > .modal-content').count(), 1, 'the summary went back to its modal');
    // The app's own "open this ride" (analytics, calendar, Today) opens the page; deep links work.
    await page.evaluate((id) => { ApexNative.shell.go('progress'); app.showRideSummaryById(id); }, newest);
    assert.equal(await route(page), `history/${newest}`);
    assert.equal(page.errors.length, 0, page.errors.join('\n'));
    await page.context().close();
    const deep = await openPhone(browser, { route: `history/${newest}` });
    await deep.locator('.av-ride-detail .inspector-header-stats').waitFor();
    await deep.context().close();
  }],
  ['history: import in 2 taps; the import card comes back after the sheet; search, filters and History options', async (browser) => {
    const page = await openPhone(browser);
    const c = { taps: 0 };
    await tap(page, '.av-tabbar [data-av-tab="history"]', c);
    await screenshot(page, 'history');
    await tap(page, '#avHistAdd', c);
    assert.equal(c.taps, 2);
    const b = await page.locator('.av-sheet #btnImportHistory').boundingBox();
    assert.ok(b && b.y + b.height <= 852, 'Import history above the fold');
    assert.ok(await page.locator('.av-sheet #btnChooseImportFiles').isVisible());
    const s = await sweep(page);
    assert.deepEqual(s.small, []); assert.ok(s.overflowX <= 0);
    await screenshot(page, 'history-import');
    await back(page);
    assert.equal(await page.locator('#view-history #importSyncCard').count(), 1, 'import card restored');
    // Search and filters
    await tap(page, '#avHistSearchBtn');
    await page.fill('#avHistSearch', 'tempo');
    const titles = await page.locator('.av-ride-row b').allTextContents();
    assert.ok(titles.length && titles.every((t) => /tempo/i.test(t)), 'search filters by title');
    await tap(page, '.av-hist-chips [data-filter="other"]');
    assert.match(await page.locator('#avHistCount').textContent(), / of /);
    await tap(page, '#avHistSearchBtn');
    assert.equal(await page.locator('#avHistCount').textContent(), `${await page.evaluate(() => app.completedWorkouts.length)} rides`, 'closing search clears it');
    // History options: Check Strava, exports, training-load options, clear
    await tap(page, '#avHistMore');
    const rows = (await page.locator('.av-sheet .av-row b').allTextContents()).join('|');
    for (const t of ['Check Strava', 'Full backup · JSON', 'Current session · FIT', 'Training-load options', 'Clear all history...']) assert.ok(rows.includes(t), t);
    await tap(page, '.av-sheet .av-row:has-text("Training-load options")');
    assert.match(await route(page), /^you/, 'training-load options open You > Your data');
    assert.equal(page.errors.length, 0, page.errors.join('\n'));
    await page.context().close();
  }],
  ['history: a ride recorded here opens with its ride plot (lanes, scrub), interval diagnosis and AI breakdown', async (browser) => {
    const page = await openPhone(browser);
    await tap(page, '#avStartRide');
    await page.waitForFunction(() => app.totalElapsedSeconds >= 2, null, { timeout: 15000 });
    // Five minutes of 1 Hz data with hard steps (the few real seconds extended), then End.
    const id = await page.evaluate(() => {
      const ftp = app.activeProfile.ftp, last = app.recordedSamples.at(-1), t0 = last.timestamp;
      app.recordedSamples = Array.from({ length: 300 }, (_, i) => {
        const hard = Math.floor(i / 60) % 2 === 1, target = Math.round(ftp * (hard ? 1.05 : 0.55));
        return { ...last, time: i, timestamp: t0 + i * 1000, target, power: target + ((i * 7) % 11) - 5, hr: hard ? 160 : 125, cadence: hard ? 95 : 85 };
      });
      app.totalElapsedSeconds = 300;
      const before = app.completedWorkouts.length;
      app.finishWorkout(false);
      if (app.completedWorkouts.length !== before + 1) throw new Error('ride not saved');
      const ride = [...app.completedWorkouts].sort((a, b) => new Date(b.date) - new Date(a.date))[0];
      ride.aiBreakdown = { text: '**Steady repeats.** Cadence held on both hard steps.', model: 'test', label: 'Test coach', at: Date.now() };
      return ride.id;
    });
    await page.waitForFunction(() => ApexNative.shell.current.route === 'ride');
    await page.evaluate(() => app.closeModal('rideSummaryModal'));
    await tap(page, '.av-tabbar [data-av-tab="history"]');
    await tap(page, `.av-ride-row[data-ride="${id}"]`);
    assert.equal(await route(page), `history/${id}`);
    const canvas = page.locator('.av-ride-detail #rideScrubCanvas');
    await canvas.waitFor();
    await page.waitForFunction(() => window.Chart && Chart.getChart(document.getElementById('rideScrubCanvas')));
    const box = await canvas.boundingBox();
    assert.ok(box.height > 150 && box.width > 250, 'the ride plot has its lanes');
    const readout = await page.locator('#scrubReadout').textContent();
    await canvas.scrollIntoViewIfNeeded();
    const b2 = await canvas.boundingBox();
    await page.mouse.move(b2.x + b2.width * 0.6, b2.y + b2.height * 0.3);
    await page.waitForFunction((t) => document.getElementById('scrubReadout').textContent !== t, readout, { timeout: 3000 }); // the scrub readout follows the pointer
    assert.ok(await page.locator('.av-ride-detail #intervalDiagnosis').isVisible(), 'interval diagnosis');
    assert.match(await page.locator('.av-ride-detail .ai-breakdown').textContent(), /Steady repeats/);
    assert.ok(await page.locator('.av-ride-detail [data-ai-breakdown]').count(), 'Ask again for a new breakdown');
    const s = await sweep(page);
    assert.deepEqual(s.small, []); assert.ok(s.overflowX <= 0);
    await screenshot(page, 'history-recorded');
    await back(page);
    assert.equal(await page.evaluate(() => Chart.getChart(document.getElementById('rideScrubCanvas')) || null), null, 'the chart is destroyed on leaving');
    assert.equal(page.errors.length, 0, page.errors.join('\n'));
    await page.context().close();
  }],
  ['history: ride options edit the title and notes, export and delete', async (browser) => {
    const page = await openPhone(browser, { route: 'history' });
    const id = await page.locator('.av-ride-row').first().getAttribute('data-ride');
    await tap(page, '.av-ride-row');
    await tap(page, '.av-topbar .av-more-btn');
    await tap(page, '.av-sheet .av-row:has-text("Edit title and notes")');
    await page.fill('#avRideTitle', 'Hill repeats');
    await page.fill('#avRideNotes', 'Windy, legs good');
    await tap(page, '.av-sheet button[type=submit]');
    assert.equal(await page.evaluate((id) => app.completedWorkouts.find((r) => r.id === id).title, id), 'Hill repeats');
    assert.equal(await page.locator('.av-topbar .av-title').textContent(), 'Hill repeats');
    assert.equal(await page.locator('.av-ride-notes').textContent(), 'Windy, legs good');
    await tap(page, '.av-topbar .av-more-btn');
    const rows = (await page.locator('.av-sheet .av-row b').allTextContents()).join('|');
    for (const t of ['Export FIT', 'Export TCX', 'Export CSV', 'Delete ride...']) assert.ok(rows.includes(t), t);
    page.once('dialog', (d) => d.accept());
    await tap(page, '.av-sheet .av-row:has-text("Delete ride...")');
    await page.waitForFunction(() => ApexNative.shell.current.route === 'history');
    assert.equal(await page.evaluate((id) => app.completedWorkouts.some((r) => r.id === id), id), false);
    assert.equal(page.errors.length, 0, page.errors.join('\n'));
    await page.context().close();
  }],

  // ------------------------------------------------------------------ U5: You and onboarding --
  ['you: six pages one tap from You; every You route passes the sweep; back follows page > You > Ride', async (browser) => {
    const page = await openPhone(browser);
    await tap(page, '.av-tabbar [data-av-tab="you"]');
    const rows = (await page.locator('#avYouList > .av-row b').allTextContents()).slice(1);
    assert.deepEqual(rows, ['Devices', 'Connections', 'Your data', 'App settings', 'Help & about']);
    for (const r of ['you', 'you/profile', 'you/devices', 'you/connections', 'you/connections/strava', 'you/connections/icu', 'you/connections/healthconnect',
      'you/connections/ai', 'you/data', 'you/data/backups', 'you/app', 'you/help', 'you/help/guide']) {
      await page.evaluate((r) => ApexNative.shell.go(r), r);
      await page.waitForTimeout(150);
      await page.evaluate(() => document.querySelectorAll('#avPages details').forEach((d) => { d.open = true; }));
      const s = await sweep(page);
      assert.equal(s.overflowX, 0, `${r}: no sideways scroll`);
      assert.deepEqual(s.small, [], `${r}: no controls under 44 px`);
      assert.ok(await page.locator('.av-tabbar').isVisible(), `${r}: bottom bar`);
      await screenshot(page, r.replace(/\//g, '-'));
    }
    await page.evaluate(() => ApexNative.shell.go('you/connections/strava'));
    await back(page); assert.equal(await route(page), 'you/connections');
    await back(page); assert.equal(await route(page), 'you');
    await back(page); assert.equal(await route(page), 'ride');
    assert.deepEqual(page.errors, []);
    await page.context().close();
  }],
  ['you: edit FTP or weight in 2 taps, saved and kept ready to edit; the root fits one screen', async (browser) => {
    const page = await openPhone(browser);
    const c = { taps: 0 };
    await tap(page, '.av-tabbar [data-av-tab="you"]', c);
    assert.ok((await page.evaluate(() => document.documentElement.scrollHeight)) <= 852 * 1.5, 'You fits 1.5 screens');
    await tap(page, '#avYouProfile', c);
    assert.equal(c.taps, 2);
    assert.equal(await route(page), 'you/profile');
    const ftp = page.locator('#profInputFtp');
    assert.equal(await ftp.inputValue(), String(await page.evaluate(() => app.activeProfile.ftp)), 'the active rider is ready to edit');
    assert.ok((await ftp.boundingBox()).y + 44 <= 852, 'FTP field above the fold');
    await ftp.fill('263');
    await page.locator('#profInputWeight').fill('71');
    await page.locator('#btnSaveNewProfile').tap();
    assert.deepEqual(await page.evaluate(() => [app.activeProfile.ftp, app.activeProfile.weightKg]), [263, 71]);
    assert.equal(await route(page), 'you/profile');
    assert.equal(await ftp.inputValue(), '263', 'still editing the active rider after saving');
    assert.equal(await page.evaluate(() => document.getElementById('profileManagerModal').classList.contains('open')), false, 'the old profile modal stays shut');
    await page.context().close();
  }],
  ['you: connect Strava or Health Connect in 3 taps; links into Settings land on the new pages', async (browser) => {
    const page = await openPhone(browser);
    let c = { taps: 0 };
    await page.evaluate(() => { window.__stravaConnects = 0; app.connectStrava = async () => { window.__stravaConnects++; }; });
    await tap(page, '.av-tabbar [data-av-tab="you"]', c);
    await tap(page, '#avYou-connections', c);
    await page.locator('#avConnStravaConnect').waitFor();
    await tap(page, '#avConnStravaConnect', c);
    assert.equal(c.taps, 3);
    assert.equal(await page.evaluate(() => window.__stravaConnects), 1);
    c = { taps: 0 };
    await tap(page, '.av-tabbar [data-av-tab="ride"]');
    await tap(page, '.av-tabbar [data-av-tab="you"]', c);
    await tap(page, '#avYou-connections', c);
    await page.locator('#avConnHcConnect').waitFor();
    await tap(page, '#avConnHcConnect', c);
    assert.equal(c.taps, 3);
    await page.waitForFunction(() => __nativeLog.hc.requests.length === 1);
    for (const [sec, r] of [['rider', 'you/profile'], ['strava', 'you/connections/strava'], ['health', 'you/connections/icu'], ['ai', 'you/connections/ai'],
      ['files', 'you/data'], ['importfolder', 'you/data'], ['guide', 'you/help/guide'], ['about', 'you/help'], [undefined, 'you']]) {
      await page.evaluate((s) => app.openSettings(s), sec);
      assert.equal(await route(page), r, `openSettings(${sec})`);
      assert.equal(await page.evaluate(() => document.getElementById('settingsModal').classList.contains('open')), false);
    }
    await page.evaluate(() => app.openSettings('ai'));
    assert.ok(await page.locator('#avAiBox #selectCoachProvider').isVisible());
    assert.ok(await page.locator('#avAiAdvanced #nativeAiKey-claude').isVisible(), 'keys open when none is saved');
    if (await page.evaluate(() => typeof app.settingsLabel === 'function')) {
      assert.equal(await page.evaluate(() => app.settingsLabel('ai')), 'You > Connections > AI coach', 'js/ messages name the You page');
      assert.equal(await page.evaluate(() => app.settingsLabel('health', 'Settings > Health')), 'You > Connections > intervals.icu');
      assert.match(await page.evaluate(() => app.settingsLabel('appleHealth')), /Health Connect or intervals\.icu in You > Connections/, 'no Apple Health on the phone');
    }
    await page.evaluate(() => app.openModal('profileManagerModal'));
    assert.equal(await route(page), 'you/profile');
    await page.context().close();
  }],
  ['you: Your data holds import, backup, folder, ride files and (Advanced) training load; App settings switch audio and the simulator', async (browser) => {
    const page = await openPhone(browser);
    await page.evaluate(() => ApexNative.shell.go('you/data'));
    for (const id of ['#avDataImportFiles', '#avDataImportHistory', '#avDataBackup', '#avDataFolder #nativeImportSettings', '#avDataFiles #nativeAutoFit']) {
      assert.ok(await page.locator(id).isVisible(), id);
    }
    assert.equal(await page.locator('#view-history #stravaSyncCard').count(), 0, 'training load left History');
    assert.equal(await page.locator('#avDataAdvanced #chkStrengthInFatigue').isVisible(), false, 'folded under Advanced');
    await tap(page, '#avDataAdvanced > summary');
    assert.ok(await page.locator('#avDataAdvanced #chkStrengthInFatigue').isVisible());
    await page.evaluate(() => { window.__clicked = []; for (const id of ['btnExportJsonHistory', 'btnChooseImportFiles']) document.getElementById(id).addEventListener('click', (e) => { e.stopImmediatePropagation(); window.__clicked.push(id); }, true); });
    await tap(page, '#avDataBackup');
    await tap(page, '#avDataImportFiles');
    assert.deepEqual(await page.evaluate(() => window.__clicked), ['btnExportJsonHistory', 'btnChooseImportFiles']);
    await page.evaluate(() => ApexNative.shell.go('you/app'));
    const muted = await page.evaluate(() => app.audio.muted);
    await tap(page, '#avAudioCues');
    assert.equal(await page.evaluate(() => app.audio.muted), !muted);
    assert.equal(await page.locator('#avAudioCues').getAttribute('aria-checked'), String(muted));
    await tap(page, '#avAppAdvanced > summary');
    const sim = await page.evaluate(() => app.simulator.enabled);
    await tap(page, '#avSimulator');
    assert.equal(await page.evaluate(() => app.simulator.enabled), !sim);
    await page.context().close();
  }],
  ['onboarding: a new install opens it full screen; steps save the profile, resume after a restart, never show again once done', async (browser) => {
    const page = await openPhone(browser, { demo: false, onboarding: true });
    await page.waitForFunction(() => ApexNative.shell.current.route === 'onboarding/profile');
    assert.equal(await page.locator('.av-tabbar').isVisible(), false, 'no bottom bar during onboarding');
    assert.equal(await page.locator('#firstRunHelp').isVisible(), false, 'the welcome card is replaced');
    assert.equal(await page.locator('#onbDemo').getAttribute('href'), '?apexDemo=1', 'Explore a demo on step 1');
    let s = await sweep(page);
    assert.deepEqual(s.small, []); assert.equal(s.overflowX, 0);
    await page.locator('#onbName').fill('Sam');
    await page.locator('#onbFtp').fill('240');
    await page.locator('#onbWeight').fill('68');
    await tap(page, '[data-onb="next"]');
    assert.equal(await route(page), 'onboarding/devices');
    assert.deepEqual(await page.evaluate(() => [app.activeProfile.name, app.activeProfile.ftp, app.activeProfile.weightKg, !!app.activeProfile.needsSetup]), ['Sam', 240, 68, false]);
    s = await sweep(page);
    assert.deepEqual(s.small, []);
    await tap(page, '#onbPairTrainer');
    await page.locator('.apex-ble-item', { hasText: 'KICKR CORE' }).tap();
    await page.waitForFunction(() => app.ble.isTrainerConnected(), null, { timeout: 15000 });
    await page.waitForFunction(() => !/^\s*$|Disconnected/.test(document.getElementById('onbState-trainer').textContent), null, { timeout: 5000 });
    await page.goto(`${ORIGIN}/index.html`); // cold start: no hash
    await page.waitForFunction(() => window.app && ApexNative.shell.current && ApexNative.shell.current.route === 'onboarding/devices', null, { timeout: 10000 });
    await tap(page, '[data-onb="skip"]');
    assert.equal(await route(page), 'onboarding/connect');
    assert.ok(await page.locator('#onbStrava').isVisible() && await page.locator('#onbImport').isVisible());
    await back(page);
    assert.equal(await route(page), 'onboarding/devices', 'back goes to the previous step');
    await tap(page, '[data-onb="next"]');
    await tap(page, '[data-onb="next"]');
    assert.equal(await route(page), 'ride');
    assert.ok(await page.locator('.av-tabbar').isVisible());
    await page.goto(`${ORIGIN}/index.html`); // cold start: no hash
    await page.waitForFunction(() => window.app && ApexNative.shell.current);
    await page.waitForTimeout(300);
    assert.equal(await route(page), 'ride', 'never again once completed');
    await page.context().close();
  }],
  ['onboarding: Skip setup ends it for good; the demo never shows it', async (browser) => {
    let page = await openPhone(browser, { demo: false, onboarding: true });
    await page.waitForFunction(() => ApexNative.shell.current.route === 'onboarding/profile');
    await tap(page, '[data-onb="skipall"]');
    assert.equal(await route(page), 'ride');
    await page.goto(`${ORIGIN}/index.html`); // cold start: no hash
    await page.waitForFunction(() => window.app && ApexNative.shell.current);
    await page.waitForTimeout(300);
    assert.equal(await route(page), 'ride', 'never again once skipped');
    await page.context().close();
    page = await openPhone(browser);
    await page.waitForTimeout(300);
    assert.equal(await route(page), 'ride', 'demo opens on Ride');
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
  ['in-cockpit Zen / Mini-HUD / Focus buttons', 'full', '#btnToggleFocusMode'], ['fine ERG bias ±1 % and reset (cockpit)', 'full', '#btnBiasReset'],
  ['ERG response (cockpit)', 'full', '#ergResponse'],
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
  ['ERG response', 'controls', '#avControlsSheet #ergResponse'], ['all metrics / simple view', 'controls', '#avToggleFull'], ['Zen cockpit', 'controls', '#avZen'], ['Focus mode', 'controls', '#avFocusSwitch'],
  ['customise screen', 'controls', '#avCustomise'], ['audio cues', 'controls', '#avAudioSwitch'], ['simulator', 'controls', '#avSimSwitch'],
  ['devices', 'controls', '#avControlsDevices'], ['rider profile', 'controls', '#avRider'], ['device details', 'controls', '#avDeviceDetails'],
  ['Zen: power and target', 'zen', '#zenInstantPower'], ['Zen: step countdown', 'zen', '#zenCountdown'], ['Zen: cadence halo toggle', 'zen', '#btnZenCadenceHalo'],
  ['Zen: cadence halo', 'zen', '#zenCadenceHalo'], ['Zen: HR gauge', 'zen', '#zenHrGauge'], ['Zen: bias −1', 'zen', '#btnZenBiasMinus1'], ['Zen: bias +5', 'zen', '#btnZenBiasPlus5'],
  ['Zen: smoothing', 'zen', '.zen-smooth-pills .smooth-pill'], ['Zen: play / skip', 'zen', '#btnZenSkipStep'], ['Zen: up next', 'zen', '#zenUpNextBanner'],
  ['Zen: interval profile', 'zen', '#zenIntervalCanvas'], ['Zen: exit', 'zen', '#btnCloseZenCockpit'],
  ['device list, state, connect', 'devices', '#avDevicesSheet'], ['pair a new device', 'devices', '#avPairDevice'],
  ['calibration (zero offset)', 'details', '#btnCalibratePedalsModal'], ['PowerMatch', 'details', '#chkEnablePowerMatch'],
  ['power / cadence source', 'details', '#devicePowerSource'], ['fan (KICKR HEADWIND)', 'details', '#fanModeSelect'],
  ['rename / replace / forget', 'details', '#deviceRename-trainer'], ['connect saved / pair / all Bluetooth', 'details', '#btnPairDeviceBroad']
];

async function openWhere(page, where) {
  await page.evaluate(() => { if (app.isZenMode) app.toggleZenMode(); while (ApexNative.shell.sheets.length) ApexNative.shell.closeSheet(); const m = document.getElementById('hardwareModal'); if (m && !m.hidden) app.closeDevicesFocus(); });
  if (where === 'simple' || where === 'controls' || where === 'details' || where === 'zen') await page.evaluate(() => ApexNative.shell.go('ride/live'));
  if (where === 'full') await page.evaluate(() => ApexNative.shell.go('ride/cockpit'));
  if (where === 'devices') { await page.evaluate(() => ApexNative.shell.go('ride')); await tap(page, '#avDevicesChip'); }
  if (where === 'controls' || where === 'details' || where === 'zen') await tap(page, '#avRideControls');
  if (where === 'zen') { await page.locator('#avZen').scrollIntoViewIfNeeded(); await tap(page, '#avZen'); await page.waitForTimeout(300); }
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

FLOWS.push(['ride: Zen cockpit and Focus from Controls; Zen sits above the shell, its Exit and Android back return to the ride', async (browser) => {
  const page = await openPhone(browser);
  await tap(page, '#avStartRide');
  await tap(page, '#avRideControls'); await page.locator('#avZen').scrollIntoViewIfNeeded(); await tap(page, '#avZen');
  await page.waitForTimeout(300);
  assert.ok(await page.locator('#zenCockpitOverlay').isVisible());
  const top = await page.evaluate(() => { const r = document.getElementById('btnCloseZenCockpit').getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2).closest('#zenCockpitOverlay') !== null; });
  assert.ok(top, 'Zen is on top');
  const sw = await sweep(page); assert.deepEqual(sw.small, [], 'small targets in Zen'); assert.ok(sw.overflowX <= 0, 'Zen scrolls sideways');
  await screenshot(page, 'zen');
  await back(page);
  assert.equal(await page.locator('#zenCockpitOverlay').isVisible(), false); assert.equal(await route(page), 'ride/live');
  await tap(page, '#avRideControls'); await page.locator('#avZen').scrollIntoViewIfNeeded(); await tap(page, '#avZen'); await tap(page, '#btnCloseZenCockpit');
  assert.equal(await page.locator('#zenCockpitOverlay').isVisible(), false); assert.equal(await route(page), 'ride/live');
  await tap(page, '#avRideControls'); await page.locator('#avFocusSwitch').scrollIntoViewIfNeeded(); await tap(page, '#avFocusSwitch');
  assert.equal(await route(page), 'ride/cockpit'); assert.ok(await page.evaluate(() => document.body.classList.contains('focus-mode')));
  assert.equal(await page.locator('#upcomingIntervalsStrip').isVisible(), false, 'Focus hides the queue');
  await tap(page, '#avFullControls'); await page.locator('#avFocusSwitch').scrollIntoViewIfNeeded(); await tap(page, '#avFocusSwitch');
  assert.equal(await page.evaluate(() => document.body.classList.contains('focus-mode')), false);
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
  for (const id of ['stepControls', 'biasControls', 'views', 'ergResponse']) assert.equal(await page.locator(`[data-av-cust="${id}"] [data-toggle]`).getAttribute('aria-checked'), 'true', `${id} on by default`);
  await tap(page, '[data-av-cust="stepControls"] [data-toggle]');
  await tap(page, '[data-av-cust="stepControls"] [data-move="-1"]');
  await page.evaluate(() => { ApexNative.shell.closeSheet(); ApexNative.shell.go('ride/cockpit'); });
  assert.equal(await page.locator('#btnStand').isVisible(), false, 'step controls switched off');
  await page.evaluate(() => ApexNative.shell.go('ride/live'));
  await tap(page, '#avRideControls'); await page.locator('#avCustomise').scrollIntoViewIfNeeded(); await tap(page, '#avCustomise');
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
