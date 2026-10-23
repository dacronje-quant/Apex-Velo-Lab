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
