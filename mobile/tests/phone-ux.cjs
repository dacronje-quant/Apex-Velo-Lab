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
    assert.ok(await page.locator('#avWorkoutList').isVisible()); // the Train tab's library (U2)
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
    await page.locator('.av-sheet #btnChooseImportFiles').scrollIntoViewIfNeeded(); // restoring a backup is shown in the sheet, not folded
    assert.ok(await page.locator('.av-sheet #btnChooseImportFiles').isVisible());
    const s = await sweep(page);
    assert.deepEqual(s.small, []); assert.ok(s.overflowX <= 0);
    await screenshot(page, 'history-import');
    await back(page);
    assert.equal(await page.locator('#view-history #importSyncCard').count(), 1, 'import card restored');
    // Search and filters
    await page.fill('#avHistSearch', 'tempo');
    const titles = await page.locator('.av-ride-row b').allTextContents();
    assert.ok(titles.length && titles.every((t) => /tempo/i.test(t)), 'search filters by title');
    await tap(page, '.av-hist-chips [data-filter="other"]');
    assert.match(await page.locator('#avHistCount').textContent(), / of /);
    await tap(page, '#avHistClear');
    assert.equal(await page.locator('#avHistCount').textContent(), `${await page.evaluate(() => app.completedWorkouts.length)} rides`, 'Clear filters restores every ride');
    // History options: Check Strava, exports, training-load options, clear
    await tap(page, '#avHistMore');
    const rows = (await page.locator('.av-sheet .av-row b').allTextContents()).join('|');
    for (const t of ['Export backup', 'Training-load options', 'Clear all history...']) assert.ok(rows.includes(t), t);
    for (const t of ['Check Strava', 'HealthFit', 'Current session']) assert.ok(!rows.includes(t), `unsupported/inactive action is absent: ${t}`);
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
    await page.waitForFunction(() => /^ride($|\/summary\/)/.test(ApexNative.shell.current.route)); // End opens the ride summary page
    await page.evaluate(() => { app.closeModal('rideSummaryModal'); ApexNative.shell.go('ride'); }); // leave the full-screen summary
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
    assert.equal(await route(page), 'you/connections/strava', 'without a broker, Connect opens explicit account setup');
    c = { taps: 0 };
    await tap(page, '.av-tabbar [data-av-tab="ride"]');
    await tap(page, '.av-tabbar [data-av-tab="you"]', c);
    await tap(page, '#avYou-connections', c);
    await page.locator('#avConnHcConnect').waitFor();
    await tap(page, '#avConnHcConnect', c);
    assert.equal(c.taps, 3);
    assert.equal(await route(page), 'you/connections/healthconnect');
    assert.equal(await page.evaluate(() => __nativeLog.hc.requests.length), 0, 'opening setup does not request the wrong permission');
    await tap(page, '[data-hc-request="recovery"]');
    await page.waitForFunction(() => __nativeLog.hc.requests.length === 1);
    for (const [sec, r] of [['rider', 'you/profile'], ['strava', 'you/connections/strava'], ['health', 'you/connections/icu'], ['ai', 'you/connections/ai'],
      ['files', 'you/data'], ['importfolder', 'you/data'], ['guide', 'you/help/guide'], ['about', 'you/help'], [undefined, 'you']]) {
      await page.evaluate((s) => app.openSettings(s), sec);
      assert.equal(await route(page), r, `openSettings(${sec})`);
      assert.equal(await page.evaluate(() => document.getElementById('settingsModal').classList.contains('open')), false);
    }
    await page.evaluate(() => app.openSettings('ai'));
    await tap(page, '#avAiBox > summary');
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
    await page.evaluate(() => { window.__clicked = []; for (const id of ['btnExportJsonHistory', 'btnImportHistory']) document.getElementById(id).addEventListener('click', (e) => { e.stopImmediatePropagation(); window.__clicked.push(id); }, true); });
    await tap(page, '#avDataBackup');
    await tap(page, '#avDataImportFiles');
    assert.deepEqual(await page.evaluate(() => window.__clicked), ['btnExportJsonHistory', 'btnImportHistory']);
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
// Everything the phone's one ride screen offers, and where. [feature, where, selector]: where is screen (ride/live),
// metrics (the Metrics sheet), controls (the Controls sheet), devices (the devices sheet) or details (the app's
// Devices panel, opened from Controls). The PC's Zen, Focus, Mini-HUD and all-metrics cockpit are not on the phone.
const RIDE_TILES = ['hr', 'cadence', 'p1s', 'p3s', 'p30s', 'avg', 'np', 'wkg', 'wbal', 'lr', 'hrDrift', 'if', 'tss', 'distance', 'speed', 'intensity', 'erg', 'source', 'powermatch'];
const PARITY = [
  ['current power (smoothed)', 'screen', '#avRidePower'], ['target power and % FTP', 'screen', '#avRideTarget'],
  ['power vs target deviation', 'screen', '#avRideDev'], ['step countdown (pulses before a change)', 'screen', '#avRideCountdown'],
  ['step name and number', 'screen', '#avRideStep'], ['total elapsed', 'screen', '#avRideClock'], ['workout time left', 'screen', '#avRideRemain'], ['workout progress', 'screen', '#avRideProgress'],
  ['live graph (power, HR, cadence over the targets)', 'screen', '#avRideGraph'], ['graph zoom', 'screen', '#avGraphZoom [data-zoom="1m"]'], ['up next', 'screen', '#avRideNext'],
  ['coach / pedalling insight', 'screen', '#avRideCoach'], ['End (stop & save)', 'screen', '#avRideEnd'], ['Start / Pause / Resume', 'screen', '#avRidePause'], ['Skip step', 'screen', '#avRideSkip'],
  ...RIDE_TILES.map((t) => [`tile: ${t}`, 'screen', `[data-av-item="tile:${t}"]`]),
  ['panel switches', 'metrics', '#avMetricsSheet [data-item="panel:graph"]'], ['graph line switches', 'metrics', '#avMetricsSheet [data-line="cadence"]'],
  ...RIDE_TILES.map((t) => [`tile switch: ${t}`, 'metrics', `#avMetricsSheet [data-item="tile:${t}"]`]), ['restore the default screen', 'metrics', '#avMetricsReset'],
  ['intensity ±1 / ±5', 'controls', '#avIntensityRow [data-av-press="btnBiasPlus1"]'], ['intensity reset', 'controls', '#avBiasReset'],
  ['ERG on / off', 'controls', '#avErgSwitch'], ['shorten / extend step', 'controls', '[data-av-press="btnExtendInterval"]'], ['stand 30 s', 'controls', '#avStand'],
  ['reset workout', 'controls', '#avResetWorkout'], ['power smoothing 1s-1m', 'controls', '#avControlsSheet .smooth-pill[data-sec="60"]'],
  ['ERG response', 'controls', '#avControlsSheet #ergResponse'], ['audio cues', 'controls', '#avAudioSwitch'], ['simulator', 'controls', '#avSimSwitch'],
  ['devices', 'controls', '#avControlsDevices'], ['rider profile', 'controls', '#avRider'], ['device details', 'controls', '#avDeviceDetails'],
  ['device list, state, connect', 'devices', '#avDevicesSheet'], ['pair a new device', 'devices', '#avPairDevice'],
  ['calibration (zero offset)', 'details', '#btnCalibratePedalsModal'], ['PowerMatch', 'details', '#chkEnablePowerMatch'],
  ['power / cadence source', 'details', '#devicePowerSource'], ['fan (KICKR HEADWIND)', 'details', '#fanModeSelect'],
  ['rename / replace / forget', 'details', '#deviceRename-trainer'], ['connect saved / pair / all Bluetooth', 'details', '#btnPairDeviceBroad']
];

async function openWhere(page, where) {
  await page.evaluate(() => { while (ApexNative.shell.sheets.length) ApexNative.shell.closeSheet(); const m = document.getElementById('hardwareModal'); if (m && !m.hidden) app.closeDevicesFocus(); });
  if (where !== 'devices') await page.evaluate(() => ApexNative.shell.go('ride/live'));
  if (where === 'devices') { await page.evaluate(() => ApexNative.shell.go('ride')); await tap(page, '#avDevicesChip'); }
  if (where === 'metrics') await tap(page, '#avRideMetrics');
  if (where === 'controls' || where === 'details') await tap(page, '#avRideControls');
  if (where === 'details') { await page.locator('#avDeviceDetails').scrollIntoViewIfNeeded(); await tap(page, '#avDeviceDetails'); await page.evaluate(() => document.querySelectorAll('#hardwareModal details').forEach((d) => { d.open = true; })); }
}

/** Switches every panel, tile and graph line of the ride screen on. */
const allMetricsOn = (page) => page.evaluate(() => { const r = ApexNative.rideTab.ride, l = r.layout(); l.items.forEach((x) => { x.on = true; }); Object.keys(l.lines).forEach((k) => { l.lines[k] = true; }); r.saveLayout(l); r.applyLayout(); });

FLOWS.push(['ride parity: every ride feature is on the one ride screen, its Metrics sheet, Controls or Devices (all metrics on)', async (browser) => {
  const page = await openPhone(browser);
  await allMetricsOn(page);
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
  await page.waitForTimeout(300);
  sw = await sweep(page);
  assert.deepEqual(sw.small, [], 'small targets on the ride screen'); assert.ok(sw.overflowX <= 0, `the ride screen scrolls sideways (${sw.overflowX})`);
  assert.ok((await page.evaluate(() => document.documentElement.scrollHeight)) <= 852, 'the default ride screen fits without scrolling');
  await screenshot(page, 'ride-live');
  await allMetricsOn(page);
  await page.waitForTimeout(300);
  sw = await sweep(page);
  assert.deepEqual(sw.small, [], 'small targets with every metric on'); assert.ok(sw.overflowX <= 0, 'every metric on scrolls sideways');
  const ctrl = await page.locator('.av-ride-ctrl').boundingBox();
  assert.ok(ctrl.y + ctrl.height <= 852 + 1, 'End / Pause / Next stay on screen with every metric on');
  await tap(page, '#avRideMetrics');
  sw = await sweep(page); assert.deepEqual(sw.small, [], 'small targets on Metrics'); assert.ok(sw.overflowX <= 0);
  await back(page);
  await tap(page, '#avRideControls');
  sw = await sweep(page); assert.deepEqual(sw.small, [], 'small targets on Controls'); assert.ok(sw.overflowX <= 0);
  await page.context().close();
}]);

FLOWS.push(['ride: back asks before ending, End saves and returns to Today', async (browser) => {
  const page = await openPhone(browser);
  await tap(page, '#avStartRide');
  await page.waitForFunction(() => app.totalElapsedSeconds >= 2, null, { timeout: 15000 });
  await back(page);
  assert.ok(await page.locator('#avEndConfirm').isVisible(), 'back mid-ride asks first');
  await tap(page, '#avEndCancel');
  assert.equal(await route(page), 'ride/live'); assert.ok(await page.evaluate(() => app.isPlaying));
  const before = await page.evaluate(() => app.completedWorkouts.length);
  await tap(page, '#avRideEnd'); await tap(page, '#avEndConfirm');
  await page.waitForFunction((n) => app.completedWorkouts.length === n + 1, before);
  assert.match(await route(page), /^ride\/summary\//, 'End opens the ride summary');
  assert.equal(await page.locator('#rideSummaryModal.open').count(), 0, 'not the desktop dialog');
  await tap(page, '#avSummaryDone');
  assert.equal(await route(page), 'ride');
  await page.context().close();
}]);

FLOWS.push(['ride summary: KPIs and graph, rename saves to history, Strava send, Full analysis, Discard asks then removes; 44 px, no sideways scroll', async (browser) => {
  const page = await openPhone(browser);
  await tap(page, '#avStartRide');
  await page.waitForFunction(() => app.totalElapsedSeconds >= 3, null, { timeout: 15000 });
  await tap(page, '#avRideEnd'); await tap(page, '#avEndConfirm');
  await page.waitForFunction(() => /^ride\/summary\//.test(ApexNative.shell.current.route));
  const id = await page.evaluate(() => ApexNative.shell.current.params.rideId);
  assert.ok(await page.locator('#avSummaryGraph').isVisible());
  assert.equal(await page.locator('.av-kpi').count(), 6);
  assert.ok(await page.locator('#avSummarySync').isVisible(), 'sync rows');
  const sw = await sweep(page); assert.deepEqual(sw.small, [], 'small targets on the summary'); assert.ok(sw.overflowX <= 0);
  await screenshot(page, 'summary');
  await page.locator('#avSummaryName').fill('Morning spin');
  await page.locator('#avSummaryName').blur();
  assert.equal(await page.evaluate((id) => app.completedWorkouts.find((r) => r.id === id).title, id), 'Morning spin');
  await tap(page, '#avSummaryAnalysis');
  assert.equal(await route(page), 'history/' + id);
  await page.evaluate((id) => { app.closeModal('rideSummaryModal'); ApexNative.shell.go('ride/summary/' + id); }, id);
  // Cancelling Discard keeps the ride and the summary.
  page.once('dialog', (d) => d.dismiss());
  await tap(page, '#avSummaryDiscard');
  await page.waitForTimeout(300);
  assert.ok(await page.evaluate((id) => app.completedWorkouts.some((r) => r.id === id), id), 'ride kept');
  assert.equal(await route(page), 'ride/summary/' + id);
  page.once('dialog', (d) => d.accept());
  await tap(page, '#avSummaryDiscard');
  await page.waitForFunction((id) => !app.completedWorkouts.some((r) => r.id === id), id);
  assert.equal(await route(page), 'ride');
  await page.context().close();
}]);

FLOWS.push(['ride summary: ramp-test result, FTP suggestion (Accept updates FTP), "completed & autosaved" after a natural end', async (browser) => {
  const page = await openPhone(browser);
  await tap(page, '#avStartRide');
  await page.waitForFunction(() => app.totalElapsedSeconds >= 6, null, { timeout: 20000 });
  await page.evaluate(() => app.finishWorkout(true, { fanfare: false })); // the workout's natural end
  await page.waitForFunction(() => /^ride\/summary\//.test(ApexNative.shell.current.route));
  assert.match(await page.locator('#avSummaryEyebrow').textContent(), /completed & autosaved/i);
  const ftp = await page.evaluate(() => app.activeProfile.ftp);
  await page.evaluate((ftp) => {
    const ride = app.completedWorkouts.find((r) => r.id === ApexNative.shell.current.params.rideId);
    ride.rampTest = { message: 'Ramp test complete: FTP estimate 214 W.' };
    const real = app.ftpSuggestionFor.bind(app);
    app.ftpSuggestionFor = (r) => (r === ride && app.activeProfile.ftp < ftp + 10 ? { ftp: ftp + 10, gain: 10, method: 'Ramp test', basis: 'one ride' } : real(r));
    ApexNative.shell.go(ApexNative.shell.current.route); // render the summary again
  }, ftp);
  assert.match(await page.locator('#avRampResult').textContent(), /FTP estimate 214 W/);
  assert.ok(await page.locator('#avSummaryInsight [data-ftp="accept"]').isVisible(), 'FTP suggestion shown');
  const sw = await sweep(page); assert.deepEqual(sw.small, [], 'small targets with the insight'); assert.ok(sw.overflowX <= 0);
  await tap(page, '#avSummaryInsight [data-ftp="accept"]');
  assert.equal(await page.evaluate(() => app.activeProfile.ftp), ftp + 10, 'Accept updates FTP');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#avSummaryInsight [data-ftp="accept"]').count(), 0, 'the suggestion is gone');
  await page.context().close();
}]);

FLOWS.push(['ride polish: HR-only hero and banner without a power source; deviation bar; step-change flash; trainer power when the pedals drop; HR drift tile', async (browser) => {
  const page = await openPhone(browser);
  await tap(page, '#avStartRide');
  await page.waitForFunction(() => app.totalElapsedSeconds >= 2, null, { timeout: 15000 });
  assert.ok(await page.locator('#avDevBar').isVisible(), 'deviation bar while riding to a target');
  // No power source: simulator off, no fresh pedal or trainer reading, heart rate present.
  await page.evaluate(() => { app.simulator.enabled = false; app.devicePowerFresh = () => ({ pedals: false, trainer: false }); document.getElementById('valHeartRate').textContent = '142'; });
  await page.waitForTimeout(400);
  assert.ok(await page.locator('#avRide.av-hr-only').count(), 'HR-only mode');
  assert.equal(await page.locator('#avRidePower').textContent(), '142');
  assert.ok(await page.locator('#avHrZones').isVisible());
  assert.ok(await page.locator('#avNoPowerBanner').isVisible(), 'no power source banner');
  assert.equal(await page.locator('#avDevBar').isVisible(), false);
  await tap(page, '#avNoPowerBanner');
  assert.ok(await page.locator('#avDevicesSheet').isVisible(), 'the banner opens the devices sheet');
  await back(page);
  // Pedals reconnecting while the trainer is connected: offer the trainer's power, which sets the source and resumes.
  await page.evaluate(() => {
    const diag = app.ble.getDiagnostics.bind(app.ble), conn = app.ble.isConnected.bind(app.ble);
    app.ble.getDiagnostics = (k) => (k === 'pedals' ? { ...diag(k), state: 'reconnecting' } : diag(k));
    app.ble.isConnected = (k) => (k === 'trainer' ? true : conn(k));
    document.getElementById('btnPlayPause').click(); // paused by the drop
  });
  await page.waitForTimeout(400);
  assert.ok(await page.locator('#avUseTrainerPower').isVisible());
  assert.equal((await page.locator('#avUseTrainerPower').textContent()).trim(), 'Use trainer power and resume', 'paused wording');
  await tap(page, '#avUseTrainerPower');
  assert.equal(await page.evaluate(() => app.powerSourcePreference), 'trainer');
  assert.ok(await page.evaluate(() => app.isPlaying), 'resumed');
  // Step change: the screen flashes.
  await page.evaluate(() => document.getElementById('btnSkipInterval').click());
  await page.waitForFunction(() => document.getElementById('avRide').classList.contains('av-flash'));
  // HR drift tile reads js/velo-insight.js.
  assert.equal(await page.evaluate(() => ApexNative.rideTab.ride.hrDrift()), 'after 20 min');
  await page.context().close();
}]);

FLOWS.push(['ride: one screen only - Controls offers no other view (Detailed, Zen, Focus, Mini-HUD); the retired all-metrics link opens Today', async (browser) => {
  const page = await openPhone(browser);
  await tap(page, '#avStartRide');
  await page.waitForFunction(() => app.isPlaying);
  await tap(page, '#avRideControls');
  for (const id of ['#avToggleFull', '#avZen', '#avFocusSwitch', '#avCustomise', '#avPip']) assert.equal(await page.locator(id).count(), 0, `${id} is gone`);
  await back(page);
  await page.evaluate(() => ApexNative.shell.go('ride/cockpit'));
  assert.equal(await route(page), 'ride');
  assert.equal(await page.locator('#view-cockpit').isVisible(), false, 'the PC cockpit is not shown');
  await tap(page, '#avStartRide'); // "Return to ride"
  assert.equal(await route(page), 'ride/live'); assert.ok(await page.evaluate(() => app.isPlaying), 'the ride went on');
  await page.context().close();
}]);

FLOWS.push(['ride graph: drawn from the ride; All / 10 min / 3 min / 1 min zoom, saved for the rider; a touch on the graph never moves the workout', async (browser) => {
  let page = await openPhone(browser, { demo: false }); // the demo keeps its storage in memory
  await tap(page, '#avStartRide');
  await page.waitForFunction(() => app.totalElapsedSeconds >= 2, null, { timeout: 15000 });
  await page.evaluate(() => { for (let k = 0; k < 400; k++) app.tick1Hz(); }); // some minutes of riding, into the second step
  await tap(page, '#avRidePause');
  await page.waitForTimeout(600);
  const picture = () => page.evaluate(() => { const c = document.getElementById('avRideGraph'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let ink = 0, sum = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) { ink++; sum = (sum + d[i - 3] * 3 + d[i - 2] * 5 + d[i - 1] * 7 + i) % 1000003; } return { ink, sum }; });
  const all = await picture();
  assert.ok(all.ink > 2000, 'the graph is drawn');
  const state = () => page.evaluate(() => ({ step: app.intervalIndex, left: app.intervalSecondsRemaining, elapsed: app.totalElapsedSeconds, playing: app.isPlaying }));
  const before = await state();
  assert.ok(before.step >= 1, 'riding the second step');
  // Touches all over the graph, and a click sent straight to its canvas: the workout stays where it is.
  const box = await page.locator('#avRideGraph').boundingBox();
  for (const fx of [0.04, 0.3, 0.6, 0.95]) for (const fy of [0.2, 0.8]) await page.touchscreen.tap(box.x + box.width * fx, box.y + box.height * fy);
  await page.evaluate(() => { const c = document.getElementById('avRideGraph'); for (const type of ['pointerdown', 'pointerup', 'click', 'dblclick']) c.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: 30, clientY: c.getBoundingClientRect().y + 10 })); });
  assert.deepEqual(await state(), before, 'a touch on the graph does not seek, skip, pause or resume');
  assert.equal(await page.locator('#avRideGraph').evaluate((c) => getComputedStyle(c.parentNode).pointerEvents), 'none', 'the graph takes no touches');
  assert.equal(await page.locator('#avRide #intervalCanvas').count(), 0, 'the tap-to-jump workout profile is not on the ride screen');
  // Zoom: the picture changes, the workout does not, and the choice is kept.
  assert.equal(await page.locator('#avGraphZoom [data-zoom="all"]').getAttribute('aria-pressed'), 'true');
  await tap(page, '#avGraphZoom [data-zoom="1m"]');
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#avGraphZoom [data-zoom="1m"]').getAttribute('aria-pressed'), 'true');
  const zoomed = await picture();
  assert.ok(zoomed.ink > 2000 && zoomed.sum !== all.sum, 'zooming in redraws the graph');
  assert.deepEqual(await state(), before, 'zooming does not move the workout');
  await tap(page, '#avGraphZoom [data-zoom="3m"]');
  assert.equal(await page.evaluate(() => ApexNative.rideTab.ride.layout().zoom), '3m');
  const sw = await sweep(page); assert.deepEqual(sw.small, [], 'small targets with the zoom buttons'); assert.ok(sw.overflowX <= 0);
  await screenshot(page, 'ride-graph-zoom');
  await page.reload();
  await page.waitForFunction(() => window.app && ApexNative.shell.current);
  assert.equal(await page.evaluate(() => ApexNative.rideTab.ride.layout().zoom), '3m', 'zoom kept after a restart');
  assert.equal(await page.evaluate(() => ApexNative.rideTab.ride.layouts.get('someone-else').zoom), 'all', 'per rider');
  await page.context().close();
}]);

FLOWS.push(['ride metrics: one tap shows or hides a tile, a panel or a graph line; saved per rider, kept after a restart; restore defaults; an earlier layout keeps its tiles', async (browser) => {
  let page = await openPhone(browser, { demo: false }); // the demo keeps its storage in memory
  await tap(page, '#avStartRide');
  const shown = async (item) => !(await page.locator(`#avRide [data-av-item="${item}"]`).isHidden());
  assert.deepEqual([await shown('panel:graph'), await shown('panel:next'), await shown('tile:hr'), await shown('tile:cadence'), await shown('tile:np'), await shown('panel:coach')], [true, true, true, true, false, false], 'the default screen');
  await tap(page, '#avRideMetrics');
  await tap(page, '#avMetricsSheet [data-item="tile:np"]');
  assert.equal(await page.locator('#avMetricsSheet [data-item="tile:np"]').getAttribute('aria-checked'), 'true');
  assert.ok(await shown('tile:np'), 'NP shows at once');
  assert.ok(await page.locator('#avMetricsSheet').isVisible(), 'the sheet stays open for the next switch');
  await tap(page, '#avMetricsSheet [data-item="tile:hr"]');
  assert.equal(await shown('tile:hr'), false, 'heart rate switched off');
  await tap(page, '#avMetricsSheet [data-item="panel:graph"]');
  assert.equal(await shown('panel:graph'), false, 'graph switched off');
  await tap(page, '#avMetricsSheet [data-line="cadence"]');
  assert.equal(await page.locator('#avMetricsSheet [data-line="cadence"]').getAttribute('aria-checked'), 'true');
  assert.match(await page.locator('#avMetricsSheet [data-item="tile:cadence"] .av-mchip-val').textContent(), /rpm|--/, 'switches show their live value');
  await page.reload();
  await page.waitForFunction(() => window.app && ApexNative.shell.current);
  const on = (l, id) => l.items.find((x) => x.id === id).on;
  let l = await page.evaluate(() => ApexNative.rideTab.ride.layout());
  assert.deepEqual([on(l, 'tile:np'), on(l, 'tile:hr'), on(l, 'panel:graph'), l.lines.cadence], [true, false, false, true], 'kept after a restart');
  const other = await page.evaluate(() => ApexNative.rideTab.ride.layouts.get('someone-else'));
  assert.deepEqual([on(other, 'tile:np'), on(other, 'tile:hr'), on(other, 'panel:graph'), other.lines.cadence], [false, true, true, false], 'per rider');
  await page.evaluate(() => ApexNative.shell.go('ride/live'));
  await tap(page, '#avRideMetrics');
  await page.locator('#avMetricsReset').scrollIntoViewIfNeeded(); await tap(page, '#avMetricsReset');
  assert.deepEqual([await shown('panel:graph'), await shown('tile:hr'), await shown('tile:np')], [true, true, false], 'Restore is the default screen');
  assert.equal(await page.locator('#avMetricsSheet [data-item="tile:np"]').getAttribute('aria-checked'), 'false');
  // More tiles: three to a row, and a tighter hero.
  await back(page);
  await allMetricsOn(page);
  assert.equal(await page.locator('#avRide').getAttribute('data-cols'), '3');
  assert.equal(await page.locator('#avRide').getAttribute('data-density'), 'packed');
  // A layout saved by the earlier two-view screen: its tiles stay, its workout profile becomes the live graph.
  l = await page.evaluate(() => {
    localStorage.setItem('apex_ride_layout_v1', JSON.stringify({ [app.activeProfileId]: {
      simple: [{ id: 'panel:hero', on: true }, { id: 'panel:profile', on: true }, { id: 'panel:next', on: false }, { id: 'tile:tss', on: true }, { id: 'tile:power', on: true }, { id: 'tile:hr', on: false }],
      full: [{ id: 'rideGraph', on: true }], lines: { power: true, target: true, cadence: true, hr: false }
    } }));
    ApexNative.rideTab.ride.applyLayout();
    return ApexNative.rideTab.ride.layout();
  });
  assert.deepEqual(l.items.filter((x) => x.on).map((x) => x.id), ['panel:graph', 'tile:tss'], 'earlier layout carried over');
  assert.deepEqual([l.lines.hr, l.lines.cadence, l.zoom], [false, true, 'all']);
  assert.deepEqual([await shown('panel:graph'), await shown('panel:next'), await shown('tile:tss'), await shown('tile:hr')], [true, false, true, false]);
  await page.context().close();
}]);


// ------------------------------------------------------------------------------------------ train parity --
// Every feature of today's Workouts, Coach, Calendar and Ask views, and where the Train tab has it.
// [feature, route, selector, setup?]: setup runs on the route before the check (opens a sheet or a mode).
const sheetOf = (id) => async (page) => { await page.evaluate((id) => ApexNative.trainTab.openWorkout(id), id); };
const TRAIN_PARITY = [
  ['week strip with planned and ridden days', 'train/plan', '.av-week-strip [data-av-day]'],
  ['the day\'s session: find a workout', 'train/plan', '#avPlanAskCoach'],
  ['training block: build, re-plan, open', 'train/plan', '#avPlanBuild'],
  ['coach and calendar', 'train/plan', '#avOpenCalendar'],
  ['library list (name, duration, TSS)', 'train/workouts', '#avWorkoutList [data-av-workout]'],
  ...['all', 'endurance', 'sweetspot', 'threshold', 'vo2', 'hardstart', 'custom', 'assessment'].map((c) => [`filter: ${c}`, 'train/workouts', `[data-av-cat="${c}"]`]),
  ['search', 'train/workouts', '#avWorkoutSearch'],
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
  ['coach: insights', 'train/coach', '#aiCoachInsights'], // shown open below the builder
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
  ['plan: quick AI workout (length, note, generate)', 'train/plan', '#avQuickGo'],
  ['plan: quick AI workout engine switcher', 'train/plan', '#avQuickAi .ai-pick'],
  ['coach: AI engine switcher', 'train/coach', '#view-ai-coach .ai-pick-row .ai-pick'],
  ['describe: AI engine switcher', 'train/workouts', '.av-sheet #describeBox .ai-pick', async (page) => { await tap(page, '#avDescribe'); }],
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
    if (['train/plan', 'train/ask'].includes(r)) assert.ok((await page.evaluate(() => document.documentElement.scrollHeight)) <= 852 * 1.5 + 80, `${r} fits 1.5 screens`);
    if (r === 'train/workouts') assert.ok(await page.locator('.av-workout-card svg.av-workout-profile').first().isVisible(), 'workout browsing uses visual cards');
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
  // Mid-ride, Plan's button only goes back to the ride: the planned session never replaces it.
  await page.waitForFunction(() => app.isPlaying);
  const riding = await page.evaluate(() => app.currentWorkout.id);
  await page.evaluate(() => ApexNative.shell.go('train/plan'));
  await tap(page, `[data-av-day="${day}"]`);
  assert.match(await page.locator('#avPlanRide').textContent(), /Return to ride/);
  await tap(page, '#avPlanRide');
  assert.equal(await route(page), 'ride/live');
  assert.equal(await page.evaluate(() => app.currentWorkout.id), riding, 'the ride kept its workout');
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

FLOWS.push(['train: a ride in progress is never swapped from Train (Fine-tune off, Ride it asks first)', async (browser) => {
  const page = await openPhone(browser);
  await tap(page, '#avStartRide');
  await page.waitForFunction(() => app.isPlaying && app.totalElapsedSeconds >= 1);
  const riding = await page.evaluate(() => app.currentWorkout.id);
  await page.evaluate(() => ApexNative.shell.go('train/workouts'));
  await page.evaluate(() => ApexNative.trainTab.openWorkout('carson'));
  assert.equal(await page.locator('#avWorkoutEdit').isDisabled(), true, 'Fine-tune is off during a ride');
  let asked = 0;
  page.once('dialog', (d) => { asked++; d.dismiss(); });
  await tap(page, '#avWorkoutRide');
  assert.equal(asked, 1, 'Ride it asks before replacing the ride');
  assert.equal(await page.evaluate(() => app.currentWorkout.id), riding);
  assert.ok(await page.evaluate(() => app.isPlaying), 'still riding');
  assert.deepEqual(page.errors, []);
  await page.context().close();
}]);

module.exports.TRAIN_PARITY = TRAIN_PARITY;

module.exports.PARITY = PARITY;

// ------------------------------------------------------------------------------------------ progress (U4) --
// Every Analytics card (Overview, Fitness & load, Power & CP, FTP incl. FTP over time, Intensity, Aerobic, Health,
// and the Analytics+ / studio parts) and the Progress topic that shows it. [feature, topic, selector]
const PROGRESS_PARITY = [
  ['readiness ring (tap a day)', 'health', '#anaCardReady'], ['your week (AI story)', 'fitness', '#anaCardStory'],
  ['today strip: form, fitness, ramp, FTP', 'fitness', '#anaTodayStrip'], ['progression tiles (drill down)', 'fitness', '#anaTiles'],
  ['pinned charts', 'fitness', '#anaPinned'], ['what changed (insights)', 'fitness', '#anaCardInsights'], ['records', 'records', '#anaCardRecords'],
  ['performance management chart', 'fitness', '#anaCardPmc'], ['weekly load, KPIs, week rides', 'fitness', '#anaCardWeekly'], ['training year heatmap', 'fitness', '#anaCardYear'],
  ['power duration curve, scrubber, table', 'power', '#anaCardPdc'], ['critical power model', 'power', '#cpModelCard'], ['power profile', 'power', '#anaCardProfile'],
  ['power profile (PRs)', 'records', '#anaCardProfile'], ['CP & W′ over time', 'power', '#anaCardCpHistory'], ['left / right balance', 'power', '#anaCardBalance'],
  ['FTP history & monthly peak NP, implied FTP', 'power', '#anaCardFtpHistory'], ['FTP over time (estimates, import, table)', 'power', '#ftpMetricsHistoryCard'],
  ['time in zones, polarisation', 'intensity', '#anaCardZones'], ['intensity mix', 'intensity', '#anaCardMix'], ['every ride: duration vs NP', 'intensity', '#anaCardScatter'],
  ['efficiency factor', 'intensity', '#anaCardEf'], ['aerobic decoupling', 'intensity', '#anaCardDrift'],
  ['health: no-data note', 'health', '#anaHealthEmpty'], ['health tiles', 'health', '#anaHealthTiles'], ['resting & sleeping HR', 'health', '#anaCardHealthHr'],
  ['HRV and normal range', 'health', '#anaCardHealthHrv'], ['rMSSD and SDNN', 'health', '#anaCardHealthHrvBoth'], ['sleep stages', 'health', '#anaCardHealthSleep'],
  ['sleep timeline', 'health', '#anaCardSleepTimeline'], ['sleep & readiness scores', 'health', '#anaCardHealthScores'], ['stress index', 'health', '#anaCardHealthStress'],
  ['breathing & SpO2', 'health', '#anaCardHealthBreath'], ['weight', 'health', '#anaCardHealthBody'], ['blood pressure, glucose, food', 'health', '#anaCardHealthVitals'],
  ['training vs next morning', 'health', '#anaCardHealthLoad'], ['correlation explorer', 'health', '#anaCardCorr']
];

/** 60 days of health values (the demo has none), as js/velo-health.js daily() gives them. */
async function seedHealth(page) {
  await page.evaluate(() => {
    const days = [];
    for (let i = 59; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000); const day = app.localDayKey(d);
      days.push({ day, rhr: 50 + (i % 5), hrv: 60 + ((i * 7) % 11), sleepH: 7 + (i % 3) / 4, deepH: 1.2, remH: 1.5, coreH: 4, awakeH: 0.3 });
    }
    app.healthDays = days;
  });
}

FLOWS.push(['progress: taps from launch (FTP 1, HRV trend 2, no scroll), sweep of every route, root ≤ 1.5 screens, back', async (browser) => {
  const page = await openPhone(browser);
  await seedHealth(page);
  const c = { taps: 0 };
  await tap(page, '.av-tabbar [data-av-tab="progress"]', c);
  assert.equal(await route(page), 'progress');
  assert.match(await page.locator('#avProgFtpVal').innerText(), /\d+ W/, 'FTP on the answer card');
  assert.ok(await page.locator('#avProgFtpVal').isVisible()); assert.equal(c.taps, 1);
  assert.ok((await page.evaluate(() => document.documentElement.scrollHeight)) <= 852 * 1.5, 'Progress fits 1.5 screens');
  await tap(page, '#avProgRow-health', c);
  assert.equal(c.taps, 2); assert.equal(await route(page), 'progress/health');
  await page.waitForTimeout(400);
  assert.ok(await page.locator('#anaCardReady').isVisible(), 'today’s recovery is shown before historical charts');
  await page.locator('#anaCardHealthHrv').scrollIntoViewIfNeeded();
  assert.ok(await page.locator('#anaCardHealthHrv canvas').isVisible(), 'HRV trend remains accessible');
  for (const r of ['progress', 'progress/fitness', 'progress/power', 'progress/intensity', 'progress/health', 'progress/records']) {
    await page.evaluate((r) => ApexNative.shell.go(r), r);
    await page.waitForTimeout(500);
    assert.ok(await page.locator('.av-tabbar').isVisible(), `bottom bar on ${r}`);
    // Training-year day squares (13 px heatmap cells) are exempt: every day also opens from a tap on any time chart.
    const sw = await sweep(page, { ignore: '.yc' });
    assert.deepEqual(sw.small, [], `small targets on ${r}`); assert.ok(sw.overflowX <= 0, `${r} scrolls sideways (${sw.overflowX})`);
    if (r !== 'progress') assert.equal(await page.locator('#anaSectionNav').isVisible(), false, 'no desktop module dock');
  }
  await back(page); assert.equal(await route(page), 'progress', 'back from a topic goes to Progress');
  await back(page); assert.equal(await route(page), 'ride');
  assert.deepEqual(page.errors, []);
  await page.context().close();
}]);

FLOWS.push(['progress parity: every Analytics, Analytics+, Studio, Health and FTP-history card is on its topic page', async (browser) => {
  const page = await openPhone(browser);
  await seedHealth(page);
  const missing = [];
  for (const [feature, topic, sel] of PROGRESS_PARITY) {
    await page.evaluate((t) => ApexNative.shell.go('progress/' + t), topic);
    // Cards without data hide themselves ([hidden]); the check is that the topic page shows the card when it has data.
    const ok = await page.evaluate((sel) => {
      const el = document.querySelector(sel); if (!el) return false;
      const was = el.hidden; el.hidden = false;
      const r = el.getBoundingClientRect(); const vis = r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      el.hidden = was; return vis;
    }, sel);
    if (!ok) missing.push(`${feature} (${topic}: ${sel})`);
  }
  assert.deepEqual(missing, [], 'Analytics cards missing from Progress');
  // Studio: expand a chart, pin one (it shows on Fitness), legend chips; Analytics+: tap a day.
  await page.evaluate(() => ApexNative.shell.go('progress/power'));
  await tap(page, '#anaCardPdc .ana-expand-btn');
  assert.ok(await page.locator('#anaZoomDialog').isVisible(), 'expanded chart');
  await back(page);
  assert.equal(await page.locator('#anaZoomDialog').isVisible(), false, 'back closes the expanded chart');
  assert.equal(await route(page), 'progress/power');
  await tap(page, '#anaCardPdc .ana-pin-btn');
  await page.evaluate(() => ApexNative.shell.go('progress/fitness'));
  assert.ok(await page.locator('#anaPinned').isVisible(), 'pinned chart on Fitness');
  await page.evaluate(() => ApexNative.shell.go('progress/health'));
  await tap(page, '#anaReadyRing');
  assert.ok(await page.locator('#anaDayModal').isVisible(), 'tap a day');
  await back(page);
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => document.getElementById('anaDayModal').classList.contains('open')), false, 'back closes the day');
  assert.equal(await route(page), 'progress/health');
  assert.deepEqual(page.errors, []);
  await page.context().close();
}]);

FLOWS.push(['progress: range chip changes the page range; tiles drill down to their topic; Update FTP on Power & FTP', async (browser) => {
  const page = await openPhone(browser, { route: 'progress/fitness' });
  await page.waitForTimeout(400);
  await tap(page, '#avProgRange');
  assert.ok(await page.locator('.av-sheet #anaRangePills').isVisible());
  const sw = await sweep(page, { ignore: '.yc' }); assert.deepEqual(sw.small, [], 'small targets in the range sheet');
  await tap(page, '.av-sheet .ana-range[data-range="1y"]');
  assert.equal(await page.locator('.av-sheet').count(), 0, 'sheet closed');
  assert.equal(await page.locator('#avProgRange').innerText(), '1 year');
  assert.equal(await page.evaluate(() => document.querySelector('#anaRangePills .ana-range.active').dataset.range), '1y');
  assert.equal(await page.locator('#view-analytics > .ana-head #anaRangePills').count(), 1, 'pills put back');
  await page.evaluate(() => app.showAnalyticsPanel('ftp', { spot: 'anaCardFtpHistory' }));
  assert.equal(await route(page), 'progress/power', 'drill-down opens the topic');
  await page.evaluate(() => { app.ftpSuggestionFor = () => ({ ftp: 260, from: 185, gain: 75, method: 'Best 20 min', basis: 'one ride' }); ApexNative.shell.go('progress'); ApexNative.shell.go('progress/power'); });
  assert.ok(await page.locator('#avProgFtpAccept').isVisible(), 'Update FTP above the fold');
  await tap(page, '#avProgFtpAccept');
  assert.equal(await page.evaluate(() => app.activeProfile.ftp), 260);
  assert.deepEqual(page.errors, []);
  await page.context().close();
}]);

module.exports.PROGRESS_PARITY = PROGRESS_PARITY;

FLOWS.push(['UI polish: visual workouts, explicit actions, form validation and responsive text fields', async (browser) => {
  const page = await openPhone(browser, { route: 'train/workouts' });
  const card = page.locator('.av-workout-card').first();
  assert.ok(await card.locator('.av-workout-profile rect').count() > 0, 'the preview uses real interval steps');
  assert.match(await card.innerText(), /View workout/);
  await page.selectOption('#avWorkoutDuration', '30');
  assert.ok(await page.locator('.av-workout-card').count() > 0);
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('[data-av-workout]')].every((el) => {
    const w = app.workoutLibrary.find((w) => w.id === el.dataset.avWorkout);
    return Number(w.durationMin) <= 30;
  })), 'duration filtering changes the visible workouts');
  await page.locator('.av-workout-card').first().click();
  assert.equal(await page.locator('#avWorkoutRide').innerText(), 'Start ride');
  assert.ok(await page.locator('.av-sheet').evaluate((el) => el.contains(document.activeElement)), 'focus moves into a sheet');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.av-sheet').count(), 0);
  assert.ok(await page.locator('.av-workout-card').first().evaluate((el) => el === document.activeElement), 'focus returns to the opener');

  await page.evaluate(() => ApexNative.shell.go('you/connections'));
  await page.locator('#avConnAiRow').waitFor();
  assert.equal(await page.locator('#avConnOut b').filter({hasText:/^Health Connect$/}).count(), 1);
  await page.locator('#avConnHcConnect').click();
  assert.equal(await route(page), 'you/connections/healthconnect');
  assert.equal(await page.evaluate(() => __nativeLog.hc.requests.length), 0);
  assert.equal(await page.locator('button button').count(), 0, 'no nested action buttons');

  await page.evaluate(() => ApexNative.shell.go('you/profile'));
  const original = await page.evaluate(() => app.activeProfile.ftp);
  await page.fill('#profInputFtp', '999');
  await page.locator('#btnSaveNewProfile').click();
  assert.equal(await page.evaluate(() => app.activeProfile.ftp), original);
  assert.equal(await page.locator('#profInputFtp').getAttribute('aria-invalid'), 'true');
  assert.ok(await page.locator('#profInputFtpError').isVisible());
  await page.fill('#profInputFtp', '240');
  await page.locator('#btnSaveNewProfile').click();
  assert.equal(await page.evaluate(() => app.activeProfile.ftp), 240);

  for (const width of [360, 393, 412]) {
    await page.setViewportSize({width, height:852});
    for (const r of ['ride','train/workouts','train/builder','progress','you/connections','you/profile','you/connections/ai']) {
      await page.evaluate((r) => ApexNative.shell.go(r), r);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth-innerWidth);
      assert.ok(overflow <= 0, `${r} at ${width}px: no sideways scroll`);
      const clipped = await page.locator('input:not([type=hidden]),textarea,select').evaluateAll((nodes) => nodes.filter((n) => n.getClientRects().length && !n.closest('[hidden],details:not([open])')).filter((n) => n.getBoundingClientRect().right>innerWidth+1).map((n) => n.id));
      assert.deepEqual(clipped, [], `${r} at ${width}px: inputs stay in the viewport`);
    }
  }
  await page.setViewportSize({width:393, height:500});
  await page.evaluate(() => ApexNative.shell.go('history'));
  await page.fill('#avHistSearch', 'Tempo');
  assert.ok(await page.locator('.av-ride-row').count()>0, 'search works in a keyboard-sized viewport');
  assert.deepEqual(page.errors, []);
  await page.context().close();

  const setup = await openPhone(browser, {demo:false, onboarding:true});
  await setup.waitForFunction(() => ApexNative.shell.current.route === 'onboarding/profile');
  await setup.fill('#onbWeight','10');
  await tap(setup,'[data-onb="next"]');
  assert.equal(await route(setup),'onboarding/profile','invalid values cannot silently advance');
  assert.ok(await setup.locator('#onbWeightError').isVisible());
  await setup.fill('#onbWeight','72.3');
  await setup.locator('[data-onb="unknownftp"]').click();
  assert.ok(await setup.locator('#onbFtp').isDisabled());
  assert.ok(await setup.locator('#onbFtpHelp').isVisible());
  await tap(setup,'[data-onb="next"]');
  assert.equal(await route(setup),'onboarding/devices');
  assert.match(await setup.locator('#onbPairTrainer').innerText(),/Pair/);
  await setup.context().close();
}]);

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
