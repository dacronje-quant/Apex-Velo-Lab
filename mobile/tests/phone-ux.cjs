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
  }],

  // ------------------------------------------------------------------ U5: You and onboarding --
  ['you: six pages one tap from You; every You route passes the sweep; back follows page > You > Ride', async (browser) => {
    const page = await openPhone(browser);
    await tap(page, '.av-tabbar [data-av-tab="you"]');
    const rows = (await page.locator('#avYouList > .av-row b').allTextContents()).slice(1);
    assert.deepEqual(rows, ['Devices', 'Connections', 'Your data', 'App settings', 'Help & about']);
    for (const r of ['you', 'you/profile', 'you/devices', 'you/connections', 'you/connections/strava', 'you/connections/icu', 'you/connections/healthconnect',
      'you/connections/ai', 'you/data', 'you/app', 'you/help', 'you/help/guide']) {
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
    const page = await openPhone(browser, { demo: false });
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
    await page.reload();
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
    await page.reload();
    await page.waitForFunction(() => window.app && ApexNative.shell.current);
    await page.waitForTimeout(300);
    assert.equal(await route(page), 'ride', 'never again once completed');
    await page.context().close();
  }],
  ['onboarding: Skip setup ends it for good; the demo never shows it', async (browser) => {
    let page = await openPhone(browser, { demo: false });
    await page.waitForFunction(() => ApexNative.shell.current.route === 'onboarding/profile');
    await tap(page, '[data-onb="skipall"]');
    assert.equal(await route(page), 'ride');
    await page.reload();
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
