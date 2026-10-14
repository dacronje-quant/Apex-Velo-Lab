// Isolated real-server pairing checks. Synthetic LAN requests never reach a rider's app or trainer.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { chromium } = require('playwright');
const { fixture } = require('./sqlite-fixture.cjs');

(async () => {
  const f = await fixture();
  let browser;
  try {
    browser = await chromium.launch(require('./browser-options.cjs'));
    const pc = await browser.newPage(), errors = [];
    pc.on('pageerror', e => errors.push(e.message));
    const origin = 'http://192.168.1.2:' + new URL(f.base).port;
    const readKey = () => fs.readFileSync(path.join(f.appDir, 'data/phone-token.txt'), 'utf8').trim();
    // Show a synthetic phone address even on CI hosts with no private network adapter.
    await pc.route('**/api/health/status', async route => {
      const status = await (await fetch(f.base + '/api/health/status')).json();
      await route.fulfill({ json: { ...status, phoneUrls: [origin + '/live.html#pair=' + readKey()] } });
    });
    await pc.goto(f.base);
    await pc.waitForFunction(() => window.app && VeloStorage.enabled);
    await pc.evaluate(() => app.openSettings('phone'));
    await pc.waitForFunction(() => document.querySelector('#phoneViewAddress img.phone-qr'));
    const key = readKey();
    const snapshot = await pc.evaluate(() => {
      app._remoteEnabled = false;
      return { ...app.buildRemoteSnapshot(), state: 'running', power: 178, target: 185 };
    });
    const publish = () => fetch(f.base + '/api/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot) });
    await publish();
    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const commands = [];
    // The LAN Origin forces the same authentication path as a phone on Wi-Fi. All traffic goes
    // to this disposable fixture, including live reads, commands and key rotation.
    await phoneContext.route(origin + '/**', async route => {
      const req = route.request(), url = new URL(req.url()), headers = { ...req.headers(), origin };
      delete headers.host; delete headers['content-length'];
      if (url.pathname === '/api/live/cmd') commands.push(headers['x-apex-phone']);
      try {
        const r = await fetch(f.base + url.pathname + url.search, { method: req.method(), headers,
          signal: AbortSignal.timeout(5000), body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postDataBuffer() });
        await route.fulfill({ status: r.status, body: Buffer.from(await r.arrayBuffer()), headers: Object.fromEntries(r.headers) });
      } catch { await route.abort(); }
    });
    const phone = await phoneContext.newPage();
    phone.on('pageerror', e => errors.push(e.message));
    await phone.goto(origin + '/live.html');
    await phone.waitForFunction(() => document.getElementById('ovTitle').textContent === 'Pair this phone');
    await phone.evaluate(() => { window.pairingPage = true; });
    await phone.goto(origin + '/live.html#pair=' + key);
    await phone.waitForFunction(() => document.getElementById('trPower').textContent === '178');
    assert.equal(await phone.evaluate(() => window.pairingPage), true, 'pairing works without reloading');
    assert.equal(await phone.evaluate(() => localStorage.getItem('apexPhoneKey')), key);
    let response = phone.waitForResponse(r => r.url().includes('/api/live/cmd'));
    await phone.locator('#btnUp').click();
    assert.equal((await response).status(), 200); assert.equal(commands.at(-1), key);

    pc.once('dialog', d => d.accept());
    await pc.locator('#btnPhoneNewKey').click();
    await phone.waitForFunction(() => document.getElementById('ovTitle').textContent === 'Pair this phone');
    assert.equal((await fetch(f.base + '/api/live', { headers: { Origin: origin, 'X-Apex-Phone': key } })).status, 401);
    const nextKey = readKey(); assert.notEqual(nextKey, key);
    await publish();
    await phone.goto(origin + '/live.html#pair=' + nextKey);
    await phone.waitForFunction(() => document.getElementById('trPower').textContent === '178' && !document.getElementById('overlay').classList.contains('show'));
    assert.equal(await phone.evaluate(() => window.pairingPage), true, 're-pairing keeps the existing page');
    assert.equal(await phone.evaluate(() => localStorage.getItem('apexPhoneKey')), nextKey);
    response = phone.waitForResponse(r => r.url().includes('/api/live/cmd'));
    await phone.locator('#btnDown').click();
    assert.equal((await response).status(), 200); assert.equal(commands.at(-1), nextKey);
    await phone.reload();
    await phone.waitForFunction(() => document.getElementById('trPower').textContent === '178');
    assert.deepEqual(errors, []);
    console.log('Passed: Settings QR; unpaired phone blocked; pairing and re-pairing in the same tab; authenticated commands; old key revoked; reload persistence; no page errors.');
    await phoneContext.close();
  } finally { if (browser) await browser.close(); await f.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
