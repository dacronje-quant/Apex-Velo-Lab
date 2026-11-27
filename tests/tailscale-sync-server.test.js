'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');

async function freePort() {
  const sock = net.createServer();
  await new Promise((r) => sock.listen(0, '127.0.0.1', r));
  const port = sock.address().port;
  await new Promise((r) => sock.close(r));
  return port;
}

async function startFixture({ envExtra = {}, dotEnvExtra = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-tailscale-sync-'));
  const appDir = path.join(dir, 'app');
  fs.mkdirSync(appDir);
  for (const name of ['index.html', 'live.html', 'sw.js', 'manifest.json', 'server.js', 'js', 'css', 'vendor', 'scripts']) {
    fs.cpSync(path.join(root, name), path.join(appDir, name), { recursive: true });
  }
  fs.mkdirSync(path.join(appDir, 'data'));
  const port = await freePort();
  fs.writeFileSync(path.join(appDir, '.env'), `APEX_PORT=${port}\nANTHROPIC_API_KEY=\nGEMINI_API_KEY=\nOPENAI_API_KEY=\n${dotEnvExtra}`);
  const env = { ...process.env, APEX_DATA_DIR: path.join(dir, 'saved'), APEX_NO_BROWSER: '1', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', OPENAI_API_KEY: '', ...envExtra };
  const child = spawn(process.execPath, ['server.js'], { cwd: appDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (b) => { output += b; });
  child.stderr.on('data', (b) => { output += b; });
  const base = `http://localhost:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${base}/api/storage`); if (r.ok) { ready = true; break; } } catch {}
    if (child.exitCode !== null) throw new Error(output);
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw new Error('Server did not start: ' + output);
  return {
    dir, appDir, base, port,
    async close() {
      if (child.exitCode === null) { child.kill(); await new Promise((r) => child.once('exit', r)); }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function rawHttpGet(port, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('default mode rejects .ts.net hosts while Tailscale mode allows HTTPS MagicDNS origins', { timeout: 30000 }, async (t) => {
  const def = await startFixture();
  t.after(() => def.close());
  const blocked = await rawHttpGet(def.port, '/api/storage', { Host: 'mac-mini.tailnet.ts.net', Origin: 'https://mac-mini.tailnet.ts.net' });
  assert.equal(blocked.status, 403);

  const ts = await startFixture({ dotEnvExtra: 'APEX_ALLOW_TAILSCALE=1\nAPEX_TAILSCALE_HOST=mac-mini.tailnet.ts.net\n' });
  t.after(() => ts.close());
  const ok = await rawHttpGet(ts.port, '/api/storage', { Host: 'mac-mini.tailnet.ts.net', Origin: 'https://mac-mini.tailnet.ts.net' });
  assert.equal(ok.status, 200);
  const evil = await rawHttpGet(ts.port, '/api/storage', { Host: 'mac-mini.tailnet.ts.net', Origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
});

test('two-way sync merges rides, Apple Health priority, AI chat, deletions, SSE, and paired AI proxy', { timeout: 30000 }, async (t) => {
  const aiPort = await freePort();
  const mockAi = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.startsWith('/v1/models')) return res.end(JSON.stringify({ data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }] }));
      res.end(JSON.stringify({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Synced host AI answer.' }], usage: { input_tokens: 5, output_tokens: 4 } }));
    });
  });
  await new Promise((r) => mockAi.listen(aiPort, '127.0.0.1', r));
  t.after(() => new Promise((r) => mockAi.close(r)));

  const f = await startFixture({
    dotEnvExtra: `APEX_ALLOW_TAILSCALE=1\nAPEX_TAILSCALE_HOST=mac-mini.tailnet.ts.net\nANTHROPIC_API_KEY=sk-ant-api03-${'a'.repeat(40)}\nAPEX_ANTHROPIC_BASE_URL=http://127.0.0.1:${aiPort}\n`
  });
  t.after(() => f.close());

  // Desktop migrates initial ride, Apple Health day, and chat message
  const desktopRide = { id: 'desk_1', date: '2026-10-10T07:00:00.000Z', title: 'Desktop SweetSpot', duration: 1800, avgWatts: 220, samples: [{ time: 0, power: 220 }] };
  const toDelete = { id: 'desk_del', date: '2026-10-09T07:00:00.000Z', title: 'Old ride' };
  const initChat = JSON.stringify({ period: '6w', clearedAt: 0, messages: [{ id: 'c1', role: 'user', content: 'How is my CTL?', at: 1000 }] });
  let r = await fetch(`${f.base}/api/storage/migrate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: f.base },
    body: JSON.stringify({ revision: 0, operationId: 'op_mig_123456', rides: [desktopRide, toDelete], settings: { apex_ask_v1: initChat }, dbSettings: [] })
  });
  assert.equal(r.status, 200);

  r = await fetch(`${f.base}/api/storage/wellness`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: f.base },
    body: JSON.stringify({ source: 'apple', days: { '2026-10-10': { summary: { rhr: 47, hrv: 64, hrvKind: 'sdnn', sleepH: 7.5 }, src: 'apple' } } })
  });
  assert.equal(r.status, 200);

  // Grab sync status & token from PC
  const statusRes = await (await fetch(`${f.base}/api/sync/status`)).json();
  assert.equal(statusRes.tailscaleEnabled, true);
  assert.ok(statusRes.urls.includes('https://mac-mini.tailnet.ts.net'));
  const token = statusRes.token;
  assert.ok(token.length >= 32);

  // Unauthenticated sync & AI proxy fail when not a local PC browser request
  assert.equal((await rawHttpGet(f.port, '/api/sync/ping', { Host: '192.168.1.5:' + f.port })).status, 401);
  assert.equal((await rawHttpGet(f.port, '/api/sync/manifest', { Host: '192.168.1.5:' + f.port })).status, 401);
  const badRot = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: f.port, path: '/api/sync/token', method: 'POST', headers: { Authorization: `Bearer ${token}`, Host: '192.168.1.5:' + f.port } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(badRot, 403);

  // Connect SSE listener before push
  const sseAc = new AbortController();
  const sseChunks = [];
  const sseDone = (async () => {
    const resp = await fetch(`${f.base}/api/sync/events`, { signal: sseAc.signal });
    const reader = resp.body.getReader();
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      sseChunks.push(Buffer.from(value).toString('utf8'));
      if (sseChunks.join('').includes('event: sync')) break;
    }
  })();

  // Android NativeStore + NativeSync pushes phone ride, Health Connect day, tombstone, and chat turn
  const { NativeStore } = await import('../mobile/src/native-store.js');
  const { NativeSync } = await import('../mobile/src/native-sync.js');
  const { nodeDriver, folderFiles } = await import('../mobile/tests/sqlite-node.js');
  const mDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-mobile-sync-'));
  const mStore = await NativeStore.open({ db: nodeDriver(path.join(mDir, 'apex.sqlite')), files: folderFiles(path.join(mDir, 'backups')), backupDelayMs: 3600000 });
  t.after(async () => {
    await mStore.close().catch(() => {});
    fs.rmSync(mDir, { recursive: true, force: true });
  });

  const phoneRide = { id: 'phone_1', date: '2026-10-11T08:00:00.000Z', title: 'Phone Ride', duration: 2400, avgWatts: 240, source: 'APEX VELO Cockpit', samples: [{ time: 0, power: 240 }] };
  const phoneChat = JSON.stringify({ period: '6w', clearedAt: 0, messages: [{ id: 'c2', role: 'assistant', content: 'Rising steadily.', at: 2000 }] });
  await mStore.migrate({ revision: 0, operationId: 'mob_mig_123456', rides: [phoneRide], settings: { apex_ask_v1: phoneChat }, dbSettings: [] });
  await mStore.putWellnessDays('healthconnect', {
    '2026-10-10': { summary: { rhr: 53, hrv: 90, hrvKind: 'rmssd', sleepH: 8.1, spo2: 97 }, src: 'healthconnect' }
  });
  await mStore.applySyncBatch({ tombstones: [{ kind: 'ride', id: 'desk_del', deletedAt: Date.now() + 5000 }] });

  const capHttp = {
    async request(opts) {
      const resp = await fetch(opts.url, {
        method: opts.method || 'GET',
        headers: opts.headers || {},
        ...(opts.data !== undefined ? { body: typeof opts.data === 'string' ? opts.data : JSON.stringify(opts.data) } : {})
      });
      const text = await resp.text();
      let data = text;
      try { data = JSON.parse(text); } catch {}
      return { status: resp.status, headers: {}, data };
    }
  };
  const prefsMap = new Map();
  const prefs = { get: async (k) => prefsMap.get(k) ?? null, set: async (k, v) => prefsMap.set(k, v), remove: async (k) => prefsMap.delete(k) };
  const nSync = new NativeSync({ http: capHttp, prefs, store: Promise.resolve(mStore) });
  await nSync.setConfig({ url: f.base, token, useHostAi: true });
  const syncResult = await nSync.sync({ reason: 'test' });
  assert.equal(syncResult.ok, true);
  assert.equal(syncResult.changed, true);

  // Subsequent sync with no changes must be a clean no-op
  const second = await nSync.sync({ reason: 'steady' });
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);

  // Verify Desktop has both rides (and NOT desk_del), merged chat, and Apple Health priority + HC spo2
  const deskState = await (await fetch(`${f.base}/api/storage`)).json();
  assert.deepEqual(deskState.rides.map((x) => x.id).sort(), ['desk_1', 'phone_1']);
  const deskChat = JSON.parse(deskState.settings.apex_ask_v1);
  assert.deepEqual(deskChat.messages.map((m) => m.id), ['c1', 'c2']);
  const deskHealth = JSON.parse(deskState.settings.apex_health_v1);
  assert.equal(deskHealth.days['2026-10-10'].summary.rhr, 47);
  assert.equal(deskHealth.days['2026-10-10'].summary.hrv, 64);
  assert.equal(deskHealth.days['2026-10-10'].summary.spo2, 97);

  // Verify Android has both rides and merged chat too
  const mobRides = await mStore.rides();
  assert.deepEqual(mobRides.map((x) => x.id).sort(), ['desk_1', 'phone_1']);
  const mobChat = JSON.parse((await mStore.settings()).apex_ask_v1);
  assert.deepEqual(mobChat.messages.map((m) => m.id), ['c1', 'c2']);

  // Verify SSE event arrived
  await Promise.race([sseDone, new Promise((_, rej) => setTimeout(() => rej(new Error('SSE timeout')), 3000))]);
  sseAc.abort();
  assert.match(sseChunks.join(''), /event: sync/);

  // Verify paired sync client can query host AI routes using server's .env key
  const aiStatus = await (await fetch(`${f.base}/api/coach/status`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(aiStatus.configured, true);
  const askRes = await fetch(`${f.base}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'How did today go?' }], context: '' })
  });
  assert.equal(askRes.status, 200);
  assert.equal((await askRes.json()).text, 'Synced host AI answer.');
});
