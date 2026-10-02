const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');

const ctx = vm.createContext({ window: { addEventListener() {} }, navigator: {}, AbortController, setTimeout, clearTimeout });
for (const file of ['velo-metrics', 'velo-export', 'velo-importer', 'app', 'app-remote']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', file + '.js'), 'utf8'), ctx);
}
const App = vm.runInContext('VeloApp', ctx);
const Export = vm.runInContext('VeloExport', ctx);
const Importer = vm.runInContext('VeloRideImporter', ctx);
const samples = Array.from({ length: 60 }, (_, time) => ({ time, timestamp: Date.parse('2026-10-02T08:00:00Z') + time * 1000, power: 200 + time, hr: 140, cadence: 90, speed: 30, dist: time / 120, leftBal: 49, rightBal: 51 }));
const ride = { id: 'ride_phone_test', date: '2026-10-02T08:00:00Z', title: 'Phone ride', duration: 60, samples };
const bytes = Buffer.from(Export.buildFit(ride, samples));
const filename = Export.fileStem(ride) + '.fit';
const freshApp = () => Object.assign(Object.create(App.prototype), { _remoteEnabled: true, publishSoon() {} });

test('finishing a workout publishes the saved ride with its full recorded FIT data', () => {
  const app = freshApp();
  Object.assign(app, {
    recordedSamples: samples, totalElapsedSeconds: 60, totalDistanceMeters: 500,
    currentWorkout: { id: 'test', title: ride.title }, activeProfile: { ftp: 250, name: 'Test' },
    analytics: { totalJoules: 13770 }, completedWorkouts: [], clock: { stop() {} }, ble: { stopTrainerWorkout() {} },
    renderEasySpinOffer() {}, releaseWakeLock() {}, updatePlaybackControlsUi() {}, updatePowerSourceBadge() {},
    saveHistory() {}, renderHistoryTable() {}, recalculatePmc() {}, refreshAnalytics() {}, showToast() {}, showRideSummary() {},
  });
  app.finishWorkout();
  assert.equal(app._remoteFinishedRide.id, app.completedWorkouts[0].id);
  assert.equal(app._remoteFitUpload.filename, filename);
  const encoded = app._remoteFitUpload.bytes;
  assert.equal(Export.fitCrcOf(encoded), 0);
  const parsed = Importer.parseFit(encoded.buffer, 'Phone download', 250);
  assert.equal(parsed.samples.length, 60);
  assert.equal(parsed.samples[59].power, 259);
  assert.equal(parsed.samples[0].hr, 140);
  assert.equal(parsed.samples[0].leftBal, 49);
});

test('upload retries connection failures and a restarted server; published snapshots carry no sample payload', async () => {
  const app = freshApp();
  app.preparePhoneFit(ride);
  ctx.fetch = async () => { throw new Error('Wi-Fi unavailable'); };
  await app.publishPhoneFit();
  assert.match(app._remoteFinishedRide.fitError, /Retrying/);
  assert.equal(app._remoteFitUpload.ready, false);
  app._remoteFitUpload.retryAt = 0;
  let count = 0;
  ctx.fetch = async (url, options) => {
    count++;
    assert.match(url, /^api\/live\/fit\?id=ride_phone_test/);
    assert.deepEqual(Buffer.from(options.body), bytes);
    return { ok: true };
  };
  await app.publishPhoneFit();
  await app.publishPhoneFit();
  assert.equal(count, 1);
  assert.equal(app._remoteFinishedRide.fitError, null);
  app.buildRemoteSnapshot = () => ({ state: 'finished', completedRide: app._remoteFinishedRide });
  ctx.fetch = async (url, options) => {
    assert.equal(url, 'api/live');
    assert.ok(!options.body.includes('samples'));
    return { ok: true, json: async () => ({ cmds: [], fitId: null }) };
  };
  await app.publishRemoteSnapshot();
  assert.equal(app._remoteFitUpload.ready, false);
});

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const pwsh = [process.env.PWSH, 'pwsh', 'powershell'].filter(Boolean).find(exe => spawnSync(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', windowsHide: true }).status === 0);

for (const kind of ['node', 'powershell']) {
  test(`${kind} server serves the exact completed FIT as a phone download`, { skip: kind === 'powershell' && !pwsh }, async t => {
    const tempRoot = path.resolve(os.tmpdir());
    const dir = fs.mkdtempSync(path.join(tempRoot, 'apex-phone-fit-'));
    const port = await freePort();
    const entry = kind === 'node' ? 'server.js' : 'start_server.ps1';
    fs.copyFileSync(path.join(__dirname, '..', entry), path.join(dir, entry));
    fs.writeFileSync(path.join(dir, '.env'), `APEX_PORT=${port}\n`);
    const child = spawn(kind === 'node' ? process.execPath : pwsh,
      kind === 'node' ? [path.join(dir, entry)] : ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, entry)],
      { cwd: dir, windowsHide: true, env: { ...process.env, APEX_NO_BROWSER: '1', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    t.after(async () => {
      if (child.exitCode === null) {
        const stopped = new Promise(resolve => child.once('exit', resolve));
        child.kill();
        await stopped;
      }
      assert.equal(path.dirname(path.resolve(dir)), tempRoot);
      assert.ok(path.basename(dir).startsWith('apex-phone-fit-'));
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const base = `http://localhost:${port}`;
    let up = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try { if ((await fetch(base + '/api/live')).ok) { up = true; break; } } catch {}
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(up, output);
    const fitUrl = `${base}/api/live/fit?id=${ride.id}&filename=${filename}`;
    const upload = (body = bytes, headers = {}) => fetch(fitUrl, { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream', ...headers } });
    assert.equal((await fetch(fitUrl)).status, 404);
    assert.equal((await upload(Buffer.from('not a fit file'))).status, 400);
    assert.equal((await upload(bytes.subarray(0, bytes.length - 1))).status, 400);
    assert.equal((await upload(Buffer.alloc(16 * 1024 * 1024 + 1))).status, 413);
    assert.equal((await upload(bytes, { Origin: `http://192.168.1.2:${port}` })).status, 403);
    assert.equal((await upload(bytes, { Origin: 'https://other.example' })).status, 403);
    assert.equal((await fetch(`${base}/api/live/fit?id=bad&filename=../bad.fit`, { method: 'POST', body: bytes })).status, 400);
    const before = await (await fetch(base + '/api/live')).json();
    const notified = fetch(`${base}/api/live?after=${before.seq}`).then(r => r.json());
    assert.equal((await upload()).status, 200);
    assert.equal((await notified).fit.id, ride.id);
    const published = await (await fetch(base + '/api/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'finished', completedRide: { id: ride.id }, cmdAck: 0 }) })).json();
    assert.equal(published.fitId, ride.id);
    const live = await (await fetch(base + '/api/live')).json();
    assert.equal(live.fit.id, ride.id);
    assert.equal(live.fit.filename, filename);
    const download = await fetch(base + live.fit.url, { headers: { Origin: `http://192.168.1.2:${port}` } });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.equal(download.headers.get('content-disposition'), `attachment; filename="${filename}"`);
    assert.equal(download.headers.get('cache-control'), 'no-store');
    const downloaded = Buffer.from(await download.arrayBuffer());
    assert.deepEqual(downloaded, bytes);
    assert.equal(Export.fitCrcOf(downloaded), 0);
    const head = await fetch(fitUrl, { method: 'HEAD' });
    assert.equal(Number(head.headers.get('content-length')), bytes.length);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal((await fetch(fitUrl, { headers: { Origin: 'https://other.example' } })).status, 403);
    assert.equal((await fetch(fitUrl, { method: 'DELETE' })).status, 405);
    assert.equal((await fetch(`${base}/api/live/fit?id=next_ride&filename=${filename}`, { method: 'POST', body: bytes })).status, 200);
    assert.equal((await fetch(fitUrl)).status, 404); // old ride URLs never download a different ride
    assert.equal((await fetch(`${base}/api/live/fit?id=next_ride`)).status, 200);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['.env', entry].sort()); // no ride files on disk
  });
}
