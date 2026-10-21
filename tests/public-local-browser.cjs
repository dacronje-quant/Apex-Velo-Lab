// The app runs normally in disposable browser contexts. Every request is intercepted; no rider server is contacted.
const { chromium } = require('playwright'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), origin = 'http://apex-public.local';
const out = path.join(root, 'test-output/public-local'); fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch(require('./browser-options.cjs'));
  let archive = null; const errors = [], apiCalls = [], served = new Set();
  async function setup(context) {
    await context.route(origin + '/**', async route => {
      const u = new URL(route.request().url());
      if (u.pathname.startsWith('/api/')) {
        apiCalls.push({ path: u.pathname, page: route.request().frame().url() });
        const data = u.pathname === '/api/local-history' ? archive : u.pathname === '/api/health/inbox' ? { files: [] }
          : u.pathname === '/api/health/status' ? { token: 'fixture-token', urls: [], phoneUrls: [], port: 8080 }
          : u.pathname === '/api/strava/status' ? { configured: false, connected: false }
          : u.pathname === '/api/coach/status' ? { configured: false, provider: 'claude', models: [], providers: [] } : { ok: true };
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
      }
      const rel = u.pathname === '/' ? 'index.html' : u.pathname.slice(1), file = path.resolve(root, rel); served.add(rel);
      if (!file.startsWith(root + path.sep) || rel.startsWith('.') || rel.startsWith('data/') && rel !== 'data/sample_sweetspot_ride.tcx' || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon' };
      return route.fulfill({ body: fs.readFileSync(file), contentType: types[path.extname(file)] || 'text/plain' });
    });
    context.on('page', page => page.on('pageerror', e => errors.push(e.message)));
  }
  try {
    const fresh = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); await setup(fresh);
    const page = await fresh.newPage(); await page.goto(origin); await page.waitForFunction(() => window.app && window.app.completedWorkouts);
    assert.equal(await page.evaluate(() => app.completedWorkouts.length), 0); assert.equal(await page.evaluate(() => app.profiles.length), 1);
    assert.equal(await page.evaluate(() => app.activeProfile.name), 'Rider'); assert.ok(await page.locator('#firstRunHelp').isVisible());
    await page.screenshot({ path: path.join(out, 'first-run-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(out, 'first-run-mobile.png') });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#btnSetupProfile').click(); await page.locator('#profInputName').fill('My rider'); await page.locator('#profInputFtp').fill('220');
    assert.equal(await page.locator('#profInputName').getAttribute('data-edit-id'), 'prof_rider');
    await page.evaluate(() => app.saveProfileFromInputs()); assert.equal(await page.evaluate(() => app.profiles.length), 1);
    await page.reload(); await page.waitForFunction(() => window.app); assert.equal(await page.evaluate(() => app.activeProfile.name), 'My rider');
    await page.screenshot({ path: path.join(out, 'clean-desktop.png') }); await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'clean-mobile.png') });
    const overflow = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
      elements: [...document.querySelectorAll('body *')].filter(el => { const r = el.getBoundingClientRect(); return r.width && r.right > innerWidth + 1 && !el.closest('.modal-overlay:not(.open)'); }).slice(0, 10).map(el => ({ id: el.id, cls: el.className, right: el.getBoundingClientRect().right })) }));
    assert.ok(overflow.scroll <= overflow.width + 1, JSON.stringify(overflow));

    // Bulk "Import history": a Strava export and a Garmin export (nested zip) at once, parsed in the worker.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => { app.switchTab('history'); window.__refreshes = 0; const orig = app.refreshAnalytics; app.refreshAnalytics = function () { window.__refreshes++; return orig.apply(this, arguments); }; });
    const fixtures = path.join(root, 'tests/fixtures/bulk-import');
    const zips = ['strava-export.zip', 'garmin-export.zip'].map(name => ({ name, mimeType: 'application/zip', buffer: fs.readFileSync(path.join(fixtures, name)) }));
    await page.locator('#fileInputBulk').setInputFiles(zips);
    await page.waitForFunction(() => document.getElementById('bulkImportPanel').dataset.state === 'done', null, { timeout: 20000 });
    const counts = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#bulkImportPanel [data-count]')].map(el => [el.dataset.count, +el.textContent])));
    assert.deepEqual(counts, { found: 9, imported: 3, duplicates: 2, skipped: 3, errors: 1 });
    assert.ok(served.has('js/velo-import-worker.js'), 'parsed in the Web Worker');
    assert.equal(await page.evaluate(() => window.__refreshes), 1, 'analytics recomputed once, not per ride');
    const imported = await page.evaluate(() => app.completedWorkouts.map(r => ({ title: r.title, source: r.source, watts: r.avgWatts, hash: !!r.fileHash, samples: r.samples.length })));
    assert.equal(imported.length, 3);
    assert.ok(imported.some(r => r.title === 'Morning ride, hills'), 'Strava names restored from activities.csv');
    assert.ok(imported.every(r => r.hash && r.samples > 0 && r.source.startsWith('import:')));
    assert.ok(imported.find(r => r.source === 'import:fit' && r.title !== 'Morning ride, hills').watts > 0, 'the copy with power was kept');
    assert.equal(await page.locator('#historyTableBody tr[data-id]').count(), 3);
    const job = await page.evaluate(() => { const ids = JSON.parse(localStorage.getItem('apex_import_jobs')); return JSON.parse(localStorage.getItem('apex_import_job_' + ids.at(-1))); });
    assert.equal(job.status, 'done'); assert.equal(job.done, 3); assert.equal(job.errors, 1);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#bulkImportPanel').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(out, 'bulk-import-mobile.png') });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'import panel fits a phone screen');
    await page.setViewportSize({ width: 1440, height: 1000 });
    // The same exports again: nothing is added twice. Then a GPX through the drop-zone path goes to the bulk importer.
    await page.locator('#fileInputBulk').setInputFiles(zips);
    await page.waitForFunction(() => document.getElementById('bulkImportPanel').dataset.state === 'done' && !app._bulk, null, { timeout: 20000 });
    assert.equal(await page.evaluate(() => app.completedWorkouts.length), 3);
    assert.equal(await page.evaluate(() => app.bulkSummary().imported), 0);
    await page.evaluate(gpx => app.handleIncomingFiles([new File([gpx], 'ride.gpx')]), fs.readFileSync(path.join(fixtures, 'ride.gpx'), 'utf8'));
    await page.waitForFunction(() => app.completedWorkouts.length === 4 && !app._bulk, null, { timeout: 20000 });
    assert.equal(await page.evaluate(() => app.completedWorkouts.find(r => r.source === 'import:gpx').title), 'Lunch loop');
    await page.evaluate(async () => { app.completedWorkouts = []; await app.saveHistory(); });
    await fresh.close();

    const saved = [{ id: 'prof_divan', name: 'Existing rider', ftp: 213, weightKg: 72, maxHr: 181, ftpHistory: [{ from: 200, to: 213 }] }, { id: 'prof_1', name: 'Other rider', ftp: 150, weightKg: 65, maxHr: 170 }];
    const ride = { id: 'retained', date: new Date().toISOString(), title: 'Private fixture', duration: 60, np: 123, tss: 1, samples: [{ time: 1, power: 123 }] };
    const health = { days: { '2026-10-03': { rhr: { '2026-10-03 08:00:00 +0200': 52 } } } };
    const existing = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); await setup(existing);
    await existing.addInitScript(({ saved, ride, health }) => {
      if (location.origin !== 'http://apex-public.local') return;
      if (location.search.includes('apexDemo=1') || localStorage.getItem('fixtureSeeded')) return;
      localStorage.setItem('apex_velo_profiles', JSON.stringify(saved)); localStorage.setItem('apex_velo_active_prof_id', 'prof_divan');
      localStorage.setItem('apex_velo_history', JSON.stringify([ride])); localStorage.setItem('apex_health_v1', JSON.stringify(health)); localStorage.setItem('fixtureSeeded', '1');
    }, { saved, ride, health });
    const old = await existing.newPage(); await old.goto(origin); await old.waitForFunction(() => window.app);
    assert.equal(await old.evaluate(() => JSON.stringify(app.profiles)), JSON.stringify(saved)); assert.equal(await old.evaluate(() => app.activeProfileId), 'prof_divan');
    assert.equal(await old.evaluate(() => JSON.stringify(app.completedWorkouts)), JSON.stringify([ride]));
    assert.equal(await old.evaluate(() => localStorage.getItem('apex_health_v1')), JSON.stringify(health));
    assert.equal(await old.evaluate(() => app.resyncHealthFitHistory(true)), false); assert.equal(await old.evaluate(() => app.completedWorkouts.length), 1);
    await old.evaluate(async () => { await VeloDB.saveRidesBatch(app.completedWorkouts); localStorage.removeItem('apex_velo_history'); });
    await old.reload(); await old.waitForFunction(() => window.app && app.completedWorkouts.length === 1);
    assert.equal(await old.evaluate(() => app.completedWorkouts[0].samples[0].power), 123);
    archive = { riderName: 'Local archive rider', rides: [{ ...ride, id: 'archive' }] };
    await old.reload(); await old.waitForFunction(() => window.app); await old.evaluate(() => app.resyncHealthFitHistory(true));
    assert.equal(await old.evaluate(() => app.completedWorkouts.length), 2); assert.equal(await old.evaluate(() => app.activeProfile.ftp), 213);
    const before = await old.evaluate(() => JSON.stringify({ profiles: localStorage.getItem('apex_velo_profiles'), health: localStorage.getItem('apex_health_v1'), rides: localStorage.getItem('apex_velo_history') }));
    const demo = await existing.newPage(); await demo.goto(origin + '/?apexDemo=1'); await demo.waitForFunction(() => window.app);
    assert.equal(await demo.evaluate(() => app.completedWorkouts.length), 104); assert.equal(await demo.evaluate(() => VeloDB.dbName), 'ApexVeloDB_demo');
    assert.equal(await demo.evaluate(() => app.simulator.enabled), true);
    assert.ok(await demo.locator('#firstRunHelp').isVisible());
    assert.equal(await demo.evaluate(async () => (await fetch('api/health/token', { method: 'POST' })).status), 403);
    assert.equal(await demo.evaluate(async () => { try { await app.ble.reconnect('trainer'); return false; } catch (e) { return /demo/.test(e.message); } }), true);
    assert.equal(apiCalls.filter(c => c.page.includes('apexDemo=1')).length, 0); await demo.screenshot({ path: path.join(out, 'demo-desktop.png') });
    const after = await old.evaluate(() => JSON.stringify({ profiles: localStorage.getItem('apex_velo_profiles'), health: localStorage.getItem('apex_health_v1'), rides: localStorage.getItem('apex_velo_history') }));
    assert.equal(after, before); await demo.close(); await existing.close();
    assert.deepEqual(errors, []); console.log('Passed: clean startup, profile editing, mobile fit, bulk history import (worker, dedupe, Strava names), legacy profiles/rides/health preservation, IndexedDB-only history, additive archive, demo isolation, blocked connections, no page errors.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
