#!/usr/bin/env node
/**
 * Runs BOTH local servers (server.js and start_server.ps1) against a mock Strava API and checks
 * GET /api/strava/sync: paging, detail batches, power streams, scope check, errors - and that the sync path only
 * ever sends GET requests to Strava (the test fails on any other method).
 *
 * Nothing leaves this machine: each server runs from a temporary copy with its own .env and a
 * fake token file, so your real .env and .strava-tokens.json are never read or touched.
 *
 * Usage:  node tests/strava-sync-servers.test.js            (PowerShell server too if pwsh/powershell is found)
 *         PWSH=/path/to/pwsh node tests/strava-sync-servers.test.js
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};
const stable = (v) => Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',')}}` : JSON.stringify(v);

// ------------------------------------------------------------ mock Strava --
const T0 = Date.parse('2026-08-01T06:00:00Z');
const ACTIVITIES = Array.from({ length: 250 }, (_, i) => ({
  id: 5000 + i,
  name: i === 3 ? 'Leg day' : `Ride ${i}`,
  type: i === 3 ? 'WeightTraining' : 'VirtualRide',
  sport_type: i === 3 ? 'WeightTraining' : 'VirtualRide',
  start_date: new Date(T0 + i * 3 * 3600000).toISOString().replace('.000Z', 'Z'),
  start_date_local: new Date(T0 + i * 3 * 3600000 + 2 * 3600000).toISOString().replace('.000Z', 'Z'),
  timezone: '(GMT+01:00) Europe/Stockholm',
  moving_time: 3600, elapsed_time: 3700, distance: 30123.4,
  average_watts: 180.5, weighted_average_watts: 190, kilojoules: 640.2, device_watts: true,
  average_heartrate: 140.1, max_heartrate: 171, suffer_score: i === 3 ? 42 : 55, trainer: i !== 3,
  description: 'list endpoint never has this', map: { summary_polyline: 'xyz' }, athlete: { id: 1 }
}));
const detailOf = (a) => ({ ...a, description: a.id === 5003 ? 'Back Squat 4x8\nDeadlift 3x5' : `Details ${a.id}`, calories: 612 });

function startMockStrava() {
  const log = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    log.push({ method: req.method, path: u.pathname, query: u.search });
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'X-ReadRateLimit-Usage': '12,40', 'X-ReadRateLimit-Limit': '100,1000' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return send(405, { message: 'mock: only GET is expected' });
    if (u.pathname === '/api/v3/athlete/activities') {
      const after = Number(u.searchParams.get('after')), before = Number(u.searchParams.get('before'));
      const page = Number(u.searchParams.get('page')), per = Number(u.searchParams.get('per_page'));
      const inRange = ACTIVITIES.filter(a => Date.parse(a.start_date) / 1000 > after && Date.parse(a.start_date) / 1000 < before);
      return send(200, inRange.slice((page - 1) * per, page * per));
    }
    const st = u.pathname.match(/^\/api\/v3\/activities\/(\d+)\/streams$/);
    if (st) {
      if (st[1] === '5002') return send(429, { message: 'Rate Limit Exceeded' });
      if (st[1] !== '5000') return send(404, { message: 'Record Not Found' });
      const n = 5;
      return send(200, {
        time: { data: [0, 1, 2, 5, 6], series_type: 'distance', original_size: n, resolution: 'high' },
        watts: { data: [180, 190, 200, 210, 220], series_type: 'distance', original_size: n, resolution: 'high' },
        heartrate: { data: [120, 121, 122, 123, 124], series_type: 'distance', original_size: n, resolution: 'high' },
        keys: u.searchParams.get('keys'), key_by_type: u.searchParams.get('key_by_type')
      });
    }
    const m = u.pathname.match(/^\/api\/v3\/activities\/(\d+)$/);
    if (m) {
      const a = ACTIVITIES.find(x => String(x.id) === m[1]);
      return a ? send(200, detailOf(a)) : send(404, { message: 'Record Not Found' });
    }
    return send(404, { message: 'not mocked' });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, log, port: srv.address().port })));
}

// ------------------------------------------------------------ app servers --
function tempAppDir(kind, mockPort, appPort) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `apex-sync-${kind}-`));
  fs.copyFileSync(path.join(ROOT, kind === 'node' ? 'server.js' : 'start_server.ps1'), path.join(dir, kind === 'node' ? 'server.js' : 'start_server.ps1'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>test</title>');
  fs.writeFileSync(path.join(dir, '.env'), [
    'STRAVA_CLIENT_ID=12345', 'STRAVA_CLIENT_SECRET=test-secret', `APEX_STRAVA_BASE_URL=http://127.0.0.1:${mockPort}`, `APEX_PORT=${appPort}`, ''
  ].join('\n'));
  writeTokens(dir, 'read,activity:read_all,activity:write');
  return dir;
}
function writeTokens(dir, scope) {
  fs.writeFileSync(path.join(dir, '.strava-tokens.json'), JSON.stringify({
    access_token: 'test-access', refresh_token: 'test-refresh', expires_at: Math.floor(Date.now() / 1000) + 6 * 3600, scope,
    athlete: { id: 1, firstname: 'Test', lastname: 'Rider' }
  }));
}
function findPwsh() {
  const c = [process.env.PWSH, 'pwsh', 'powershell'].filter(Boolean);
  for (const x of c) { const r = spawnSync(x, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }); if (r.status === 0) return x; }
  return null;
}
async function waitUp(port, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://localhost:${port}/api/strava/status`); if (r.ok) return true; } catch (e) { /* not yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}
function launch(kind, dir, pwsh) {
  const env = { ...process.env, APEX_NO_BROWSER: '1' };
  const p = kind === 'node'
    ? spawn(process.execPath, [path.join(dir, 'server.js')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(pwsh, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'start_server.ps1')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
  p.output = () => out;
  return p;
}

async function runAgainst(kind, pwsh, mock, appPort) {
  const dir = tempAppDir(kind, mock.port, appPort);
  const proc = launch(kind, dir, pwsh);
  const base = `http://localhost:${appPort}`;
  const tag = kind === 'node' ? 'server.js' : 'start_server.ps1';
  const results = {};
  try {
    if (!(await waitUp(appPort))) { check(`${tag}: starts`, false, proc.output().slice(-800)); return null; }
    mock.log.length = 0;
    const get = async (q, opts) => { const r = await fetch(`${base}/api/strava/sync${q}`, opts); return { status: r.status, body: await r.json().catch(() => null) }; };

    // 1. Range listing with paging (250 activities = 2 pages of 200)
    const after = new Date(T0 - 3600000).toISOString(), before = new Date(T0 + 251 * 3 * 3600000).toISOString();
    const list = await get(`?after=${encodeURIComponent(after)}&before=${encodeURIComponent(before)}`);
    const acts = (list.body && list.body.activities) || [];
    const pages = mock.log.filter(l => l.path === '/api/v3/athlete/activities');
    const a0 = acts.find(a => a.id === '5003') || {};
    check(`${tag}: lists the range, paging per_page=200`, list.status === 200 && acts.length === 250 && pages.length === 2 && pages.every(p => /per_page=200/.test(p.query)), `status ${list.status}, ${acts.length} activities, ${pages.length} pages`);
    check(`${tag}: returns the agreed fields, list items without description/calories`,
      a0.id === '5003' && a0.sport_type === 'WeightTraining' && a0.start_date === '2026-08-01T15:00:00Z' && a0.start_date_local === '2026-08-01T17:00:00Z' &&
      a0.moving_time === 3600 && a0.elapsed_time === 3700 && a0.weighted_average_watts === 190 && a0.suffer_score === 42 && a0.trainer === false &&
      a0.detailed === false && a0.description === undefined && a0.calories === undefined && a0.map === undefined && a0.athlete === undefined,
      JSON.stringify(a0).slice(0, 300));
    check(`${tag}: reports Strava read rate usage`, list.body && list.body.rate && list.body.rate.used15 === 12 && list.body.rate.limit15 === 100);
    results.list = list.body;

    // 2. Detail batch (description, calories; 404 -> missing)
    const det = await get('?ids=5003,5004,999999');
    const d3 = det.body && det.body.activities && det.body.activities.find(a => a.id === '5003');
    check(`${tag}: detail batch gives description + calories, deleted ids as missing`,
      det.status === 200 && det.body.activities.length === 2 && d3 && d3.detailed === true && d3.description === 'Back Squat 4x8\nDeadlift 3x5' && d3.calories === 612 && stable(det.body.missing) === stable(['999999']),
      `status ${det.status}`);
    results.detail = det.body;
    const tooMany = await get(`?ids=${Array.from({ length: 11 }, (_, i) => 5000 + i).join(',')}`);
    check(`${tag}: at most 10 ids per detail request`, tooMany.status === 400);

    // 2b. Power streams of one activity, passed through; 404 -> missing, 429 -> rateLimited
    const sm = await get('?streams=5000');
    const sb = sm.body || {};
    check(`${tag}: streams of one activity are passed through (time, watts, heart rate; key_by_type)`,
      sm.status === 200 && sb.id === '5000' && sb.streams && stable(sb.streams.watts.data) === stable([180, 190, 200, 210, 220]) &&
      stable(sb.streams.time.data) === stable([0, 1, 2, 5, 6]) && sb.streams.key_by_type === 'true' && /watts/.test(sb.streams.keys) && sb.rate && sb.rate.used15 === 12,
      JSON.stringify(sb).slice(0, 200));
    const sGone = await get('?streams=5001');
    const sLimit = await get('?streams=5002');
    check(`${tag}: deleted activity -> missing, Strava 429 -> rateLimited (both HTTP 200)`,
      sGone.status === 200 && sGone.body.missing === true && sGone.body.id === '5001' && sLimit.status === 200 && sLimit.body.rateLimited === true);
    const sBad = await get('?streams=5000,5001');
    const sBad2 = await get('?streams=abc');
    check(`${tag}: streams take exactly one numeric id`, sBad.status === 400 && sBad2.status === 400);
    results.streams = { ok: sm.body, gone: sGone.body, limit: { id: sLimit.body.id, rateLimited: sLimit.body.rateLimited } };

    // 3. Bad input and wrong method
    const bad = await get('?after=yesterday&before=today');
    check(`${tag}: rejects bad dates`, bad.status === 400);
    const before405 = mock.log.length;
    const post = await get(`?after=${encodeURIComponent(after)}&before=${encodeURIComponent(before)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    check(`${tag}: POST to the sync endpoint is refused without contacting Strava`, post.status === 405 && mock.log.length === before405);
    const evil = await get(`?after=${encodeURIComponent(after)}&before=${encodeURIComponent(before)}`, { headers: { Origin: 'https://evil.example' } });
    check(`${tag}: other websites cannot call it`, evil.status === 403);

    // 4. Missing activity:read_all -> clear reconnect error, nothing sent to Strava
    writeTokens(dir, 'read,activity:write');
    const n0 = mock.log.length;
    const scope = await get(`?after=${encodeURIComponent(after)}&before=${encodeURIComponent(before)}`);
    check(`${tag}: without activity:read_all asks to reconnect Strava`, scope.status === 403 && scope.body.needsReconnect === true && /Reconnect Strava/.test(scope.body.error) && mock.log.length === n0);
    writeTokens(dir, 'read,activity:read_all,activity:write');
    const status = await (await fetch(`${base}/api/strava/status`)).json();
    check(`${tag}: status reports canSync`, status.canSync === true);

    // 4b. Automatic backups: PC only, gzip Apex backups only, never served, newest 14 kept
    const zlib = require('zlib');
    const gz = (o) => zlib.gzipSync(Buffer.from(JSON.stringify(o)));
    const postBackup = (body, headers = {}) => fetch(`${base}/api/backup`, { method: 'POST', headers: { 'Content-Type': 'application/gzip', ...headers }, body });
    const logBeforeBackups = mock.log.length;
    const ok1 = await postBackup(gz({ app: 'APEX VELO LAB', exportedAt: 'x', history: [{ id: 'r1', samples: [{ power: 200 }] }] }));
    const b1 = await ok1.json();
    const stored = b1.name ? zlib.gunzipSync(fs.readFileSync(path.join(dir, 'data', 'backups', b1.name))).toString() : '';
    check(`${tag}: backup is written to data/backups and reads back identical`, ok1.status === 200 && /^apex_velo_backup_\d{4}-\d{2}-\d{2}_\d{6}\.json\.gz$/.test(b1.name) && JSON.parse(stored).history[0].samples[0].power === 200 && b1.count === 1 && b1.keep === 14);
    const junk = await postBackup(gz({ hello: 1 }));
    const notGz = await postBackup(Buffer.from('{"app":"APEX VELO LAB"}'));
    const wrongType = await fetch(`${base}/api/backup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const evilOrigin = await postBackup(gz({ app: 'APEX VELO LAB' }), { Origin: 'https://evil.example' });
    check(`${tag}: backup rejects non-Apex data, non-gzip, wrong type and other websites`, junk.status === 400 && notGz.status === 400 && wrongType.status === 415 && evilOrigin.status === 403);
    const dl = await fetch(`${base}/data/backups/${b1.name}`);
    check(`${tag}: backups are never served`, dl.status === 404);
    for (let i = 0; i < 15; i++) { await postBackup(gz({ app: 'APEX VELO LAB', i })); await new Promise(r => setTimeout(r, 1010)); }
    const names = fs.readdirSync(path.join(dir, 'data', 'backups'));
    const st = await (await fetch(`${base}/api/backup`)).json();
    check(`${tag}: keeps the newest 14 backups, no temp files left`, names.filter(n => /\.json\.gz$/.test(n)).length === 14 && !names.some(n => /\.tmp$/.test(n)) && st.count === 14 && st.latest && st.latest.name === names.filter(n => /\.json\.gz$/.test(n)).sort().pop(), `${names.length} files`);
    check(`${tag}: backups never contact Strava`, mock.log.length === logBeforeBackups);
    results.backupStatusKeys = Object.keys(st).sort().join(',');

    // 4d. Apple Health (Health Auto Export): token-gated ingest, PC-only read / ack / token, never served
    const hs = await fetch(`${base}/api/health/status`);
    const h0 = await hs.json();
    check(`${tag}: health status (PC) returns a token and the port`, hs.status === 200 && /^[0-9a-f]{48}$/.test(h0.token) && Number(h0.port) === appPort && Array.isArray(h0.urls) && Array.isArray(h0.phoneUrls) && h0.inbox === 0, JSON.stringify(h0).slice(0, 160));
    const hae = { data: { metrics: [{ name: 'resting_heart_rate', units: 'count/min', data: [{ date: '2026-09-27 00:00:00 +0200', qty: 52 }] }, { name: 'sleep_analysis', units: 'hr', data: [{ date: '2026-09-27 00:00:00 +0200', totalSleep: 7.2 }] }] } };
    const postHealth = (body, headers = {}, qs = '') => fetch(`${base}/api/health${qs}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const noTok = await postHealth(hae);
    const badTok = await postHealth(hae, { Authorization: 'Bearer ' + 'f'.repeat(48) });
    const okTok = await postHealth(hae, { Authorization: 'Bearer ' + h0.token });
    const okQs = await postHealth(hae, {}, `?token=${h0.token}`);
    const notHae = await postHealth({ hello: 1 }, { Authorization: 'Bearer ' + h0.token });
    const badJson = await postHealth('{nope', { Authorization: 'Bearer ' + h0.token });
    check(`${tag}: health ingest needs the token (header or ?token=) and a Health Auto Export payload`, noTok.status === 401 && badTok.status === 401 && okTok.status === 200 && okQs.status === 200 && notHae.status === 400 && badJson.status === 400,
      `${noTok.status}/${badTok.status}/${okTok.status}/${okQs.status}/${notHae.status}/${badJson.status}`);
    const inboxNames = fs.readdirSync(path.join(dir, 'data', 'health', 'inbox'));
    const inbox = await (await fetch(`${base}/api/health/inbox`)).json();
    check(`${tag}: payloads land in data/health/inbox and read back unchanged`, inboxNames.filter(n => /^hae_\d{8}_\d{6}_[0-9a-f]{6}\.json$/.test(n)).length === 2 && inbox.files.length === 2 && stable(inbox.files[0].body) === stable(hae) && inbox.remaining === 0);
    const tokenFile = await fetch(`${base}/data/health/token.txt`);
    const inboxFile = await fetch(`${base}/data/health/inbox/${inboxNames[0]}`);
    const lanRead = await new Promise(r => { const q = http.request({ host: '127.0.0.1', port: appPort, path: '/api/health/status', headers: { Host: `192.168.1.50:${appPort}` } }, rs => { rs.resume(); r({ status: rs.statusCode }); }); q.on('error', () => r(null)); q.end(); });
    const evilRead = await fetch(`${base}/api/health/inbox`, { headers: { Origin: 'https://evil.example' } });
    check(`${tag}: the token and health data are never served, and only the app on this PC can read them`, tokenFile.status === 404 && inboxFile.status === 404 && lanRead && lanRead.status === 403 && evilRead.status === 403,
      `file ${tokenFile.status}/${inboxFile.status} lan ${lanRead && lanRead.status} evil ${evilRead.status}`);
    const ack = await (await fetch(`${base}/api/health/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names: inbox.files.map(f => f.name).concat(['../server.js', 'hae_x.json']) }) })).json();
    const hAfter = await (await fetch(`${base}/api/health/status`)).json();
    check(`${tag}: ack deletes only processed inbox files (names checked)`, ack.removed === 2 && hAfter.inbox === 0 && hAfter.received === 2 && !!hAfter.lastReceived && fs.existsSync(path.join(dir, kind === 'node' ? 'server.js' : 'start_server.ps1')));
    const renewed = await (await fetch(`${base}/api/health/token`, { method: 'POST' })).json();
    const oldTok = await postHealth(hae, { Authorization: 'Bearer ' + h0.token });
    const newTok = await postHealth(hae, { Authorization: 'Bearer ' + renewed.token });
    check(`${tag}: a new token replaces the old one`, renewed.token !== h0.token && /^[0-9a-f]{48}$/.test(renewed.token) && oldTok.status === 401 && newTok.status === 200);
    check(`${tag}: health never contacts Strava`, mock.log.length === logBeforeBackups);
    results.healthStatusKeys = Object.keys(hAfter).sort().join(',');

    // 4c. Who may connect: this PC and the private home network only (real client address, not a
    // header), and pages / data files are protected from other websites (DNS rebinding) too.
    const home = await fetch(`${base}/index.html`);
    // fetch() drops a custom Host header, so this request goes through http.request.
    const rebinding = await new Promise(r => { const q = http.request({ host: '127.0.0.1', port: appPort, path: '/index.html', headers: { Host: 'evil.example' } }, rs => { rs.resume(); r({ status: rs.statusCode }); }); q.on('error', () => r(null)); q.end(); });
    check(`${tag}: pages load on localhost; another site's Host header is refused (403)`, home.status === 200 && rebinding && rebinding.status === 403, `home ${home.status}, rebinding ${rebinding && rebinding.status}`);
    const ext = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal);
    const isPrivate = (ip) => /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
    if (ext && !isPrivate(ext.address)) {
      const outside = await fetch(`http://${ext.address}:${appPort}/api/strava/status`, { headers: { Host: `localhost:${appPort}` } }).catch(() => null);
      if (outside) check(`${tag}: a client outside the home network is refused even with Host: localhost`, outside.status === 403, `status ${outside.status} from ${ext.address}`);
      else console.log(`SKIP: ${tag} does not listen on ${ext.address} (localhost only) - nothing outside can connect`);
    } else console.log('SKIP: no non-private network address on this machine to test the client check from');

    // 5. READ ONLY: every request the sync path sent to Strava was a GET to the three allowed endpoints
    const nonGet = mock.log.filter(l => l.method !== 'GET');
    const allowed = mock.log.every(l => l.path === '/api/v3/athlete/activities' || /^\/api\/v3\/activities\/\d+(\/streams)?$/.test(l.path));
    check(`${tag}: sync path sends ONLY GET requests to Strava (activities list / activity detail / streams)`, nonGet.length === 0 && allowed && mock.log.length > 0,
      `${mock.log.length} requests, non-GET: ${nonGet.map(l => l.method + ' ' + l.path).join(', ') || 'none'}`);
    return results;
  } finally {
    proc.kill();
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  const mock = await startMockStrava();
  const nodeRes = await runAgainst('node', null, mock, 18611);
  const pwsh = findPwsh();
  if (!pwsh) {
    console.log('SKIP: PowerShell not found - start_server.ps1 not tested (set PWSH=/path/to/pwsh)');
  } else {
    const psRes = await runAgainst('ps', pwsh, mock, 18612);
    if (nodeRes && psRes) {
      check('server.js and start_server.ps1 return identical sync data (list, details, streams), backup and health status', stable(nodeRes.list.activities) === stable(psRes.list.activities) && stable(nodeRes.detail) === stable(psRes.detail) && stable(nodeRes.streams) === stable(psRes.streams) && nodeRes.backupStatusKeys === psRes.backupStatusKeys && nodeRes.healthStatusKeys === psRes.healthStatusKeys);
    }
  }
  mock.srv.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll server sync checks passed');
  process.exit(failures ? 1 : 0);
})();
