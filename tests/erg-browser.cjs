// Isolated UI verification: no real rider storage, server or Bluetooth connection.
const { chromium } = require('C:/Users/dacro/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
(async () => {
  let backend, backendUrl;
  if (process.argv.includes('--suite')) {
    backend = require('../server.js').createServer();
    await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
    backendUrl = `http://127.0.0.1:${backend.address().port}`;
  }
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('http://apex-erg.local/**', async route => {
      const url = new URL(route.request().url());
      // The legacy suite checks the phone command endpoint as well as the UI. Use a separate
      // in-process relay; never post test commands to the rider's running server.
      if (backendUrl && url.pathname.startsWith('/api/live')) {
        const request = route.request();
        const response = await fetch(backendUrl + url.pathname + url.search, {
          method: request.method(), headers: { 'Content-Type': 'application/json', Origin: backendUrl },
          body: ['GET', 'HEAD'].includes(request.method()) ? undefined : request.postData() });
        return route.fulfill({ status: response.status, body: await response.text(), contentType: response.headers.get('content-type') || 'application/json' });
      }
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const file = path.resolve(root, relative);
      if (!file.startsWith(root + path.sep) || !/\.(html|js|css|woff2|png|ico|json)$/i.test(file) || !fs.existsSync(file)) {
        return route.fulfill({ status: 404, body: '' });
      }
      const type = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
        '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' }[path.extname(file)];
      await route.fulfill({ body: fs.readFileSync(file), contentType: type });
    });
    await page.goto('http://apex-erg.local/?apexTest=1');
    await page.waitForFunction(() => window.app && document.querySelector('#ergResponseSummary').textContent.length > 0);
    assert.equal(await page.locator('#ergResponse').inputValue(), 'auto');
    assert.match(await page.locator('#ergResponseSummary').textContent(), /Steady/);
    await page.locator('#ergResponse').selectOption('responsive');
    assert.equal(await page.evaluate(() => app.ergResponse), 'responsive');
    assert.equal(await page.evaluate(() => localStorage.getItem('apex_erg_response')), 'responsive');
    await page.locator('#ergResponse').selectOption('auto');
    await page.evaluate(() => {
      app.currentWorkout = { category: 'vo2', intervals: [
        { name: 'Warmup', pctFtp: 50, duration: 300 },
        { name: 'Sprint', pctFtp: 180, duration: 15 },
        { name: 'Recovery', pctFtp: 50, duration: 15 },
        { name: 'VO2', pctFtp: 120, duration: 180 }] };
      app.intervalIndex = 0; app.updateHudTitles();
    });
    assert.match(await page.locator('#ergResponseSummary').textContent(), /Steady/);
    assert.doesNotMatch(await page.locator('#ergResponseSummary').textContent(), /Resistance \/ Level/);
    await page.evaluate(() => { app.intervalIndex = 1; app.updateHudTitles(); });
    assert.match(await page.locator('#ergResponseSummary').textContent(), /Short intervals.*Immediate target changes/);
    assert.equal(await page.evaluate(() => app.ergModeEnabled), true);
    await page.evaluate(() => {
      app.intervalIndex = 3; app.intervalSecondsRemaining = 180;
      app.updateHudTitles(); app.renderIntervalTrack();
    });
    assert.match(await page.locator('#ergResponseSummary').textContent(), /Responsive/);
    await page.screenshot({ path: path.join(root, 'proposals/erg-adaptive-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    const fit = await page.locator('.erg-response-control').evaluate(el => {
      const r = el.getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth;
    });
    assert.ok(fit, 'ERG controls fit the phone viewport');
    await page.locator('.erg-response-control').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, 'proposals/erg-adaptive-mobile.png') });
    assert.deepEqual(errors, []);
    console.log('Passed: Auto and manual choices, preference persistence, every interval stays in ERG, per-step updates, desktop/mobile layout, no runtime errors.');
    if (process.argv.includes('--suite')) {
      await page.goto('http://apex-erg.local/test_suite.html');
      await page.waitForFunction(() => /TEST SUITE CHECKS FAILED|ALL TEST SUITE SUITES COMPLETED|FAIL: Test Suite Execution/.test(document.querySelector('#results').textContent), { timeout: 60000 });
      const result = await page.evaluate(() => ({ passed: document.querySelectorAll('#results .pass').length,
        failed: [...document.querySelectorAll('#results .fail')].map(el => el.textContent) }));
      console.log(JSON.stringify(result, null, 2));
      assert.ok(!result.failed.some(f => /ERG|PowerMatch|Cadence Targets|Ride-Time UX|Test Suite Execution/.test(f)), 'related browser regressions');
    }
  } finally {
    await browser.close();
    if (backend) { backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); }
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
