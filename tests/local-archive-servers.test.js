const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process'), net = require('node:net'), http = require('node:http');
const root = path.resolve(__dirname, '..');
async function freePort() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
const shell = process.env.PWSH || (process.platform === 'win32' ? 'powershell.exe' : 'pwsh');
const hasShell = !spawnSync(shell, ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true }).error;
for (const kind of ['node', ...(hasShell ? ['powershell'] : [])]) test(`${kind}: clean archive, legacy preservation, private file gate and full inbox`, { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-public-check-')), port = await freePort(), base = `http://localhost:${port}`;
  const source = kind === 'node' ? 'server.js' : 'start_server.ps1'; fs.copyFileSync(path.join(root, source), path.join(dir, source));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true }); fs.writeFileSync(path.join(dir, '.env'), `APEX_PORT=${port}\nANTHROPIC_API_KEY=\nGEMINI_API_KEY=\n`);
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Clean fixture</h1>'); fs.writeFileSync(path.join(dir, 'data/sample_sweetspot_ride.tcx'), '<fixture/>');
  const env = { ...process.env, APEX_NO_BROWSER: '1', APEX_PORT: String(port), ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '' };
  const child = kind === 'node' ? spawn(process.execPath, [path.join(dir, source)], { cwd: dir, env, windowsHide: true, stdio: 'ignore' })
    : spawn(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, source)], { cwd: dir, env, windowsHide: true, stdio: 'ignore' });
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) { try { const r = await fetch(base + '/api/local-history'); if (r.ok) { ready = true; break; } } catch (e) { }
      if (child.exitCode !== null) throw new Error(`Fixture server exited ${child.exitCode}`); await new Promise(r => setTimeout(r, 100)); }
    assert.ok(ready, 'fixture server ready'); assert.equal(await (await fetch(base + '/api/local-history')).json(), null);
    const legacy = { riderName: 'Private fixture', allTimeMmp: { watts: [333] }, rides: [{ id: 'retained', samples: [{ power: 123, time: 1 }] }] };
    const archiveFile = path.join(dir, 'data/divan_cycling_history.json'), bytes = JSON.stringify(legacy); fs.writeFileSync(archiveFile, bytes);
    assert.deepEqual(await (await fetch(base + '/api/local-history')).json(), legacy); assert.equal(fs.readFileSync(archiveFile, 'utf8'), bytes);
    const lanStatus = await new Promise((resolve, reject) => { const req = http.get(base + '/api/local-history', { headers: { Host: `192.168.1.1:${port}` } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
    assert.ok([400, 403].includes(lanStatus), 'LAN Host cannot read a PC archive');
    assert.equal((await fetch(base + '/api/local-history', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/data/divan_cycling_history.json')).status, 404);
    assert.equal((await fetch(base + '/%64ata/divan_cycling_history.json')).status, 404);
    assert.equal((await fetch(base + '/data/sample_sweetspot_ride.tcx')).status, 200);
    if (kind === 'node') {
      // Windows short names (ENV~1 = .env) and alternate data streams never reach the file system.
      fs.writeFileSync(path.join(dir, '.env.private'), 'SECRET=1');
      for (const p of ['/ENV~1', '/%45NV~1', '/index.html::$DATA', '/index.html%3A%3A%24DATA']) assert.equal((await fetch(base + p)).status, 404, p);
      // A link inside the app folder to a private file is checked by the file it really opens.
      let linked = false; try { fs.symlinkSync(path.join(dir, '.env.private'), path.join(dir, 'notes.txt')); linked = true; } catch (e) { /* no symlink permission */ }
      if (linked) assert.equal((await fetch(base + '/notes.txt')).status, 404);
      // The AI coach and Strava answer only the app on this PC, not a page claiming a home-network origin.
      const lanOrigin = { Origin: `http://192.168.1.2:${port}` };
      for (const p of ['/api/coach/status', '/api/strava/status']) assert.equal((await fetch(base + p, { headers: lanOrigin })).status, 403, p);
      assert.equal((await fetch(base + '/api/ask', { method: 'POST', headers: { ...lanOrigin, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
      assert.equal((await fetch(base + '/api/coach/status')).status, 200);
      // Another device on the network cannot pass as this PC by sending Host: localhost.
      const ext = Object.values(os.networkInterfaces()).flat().find(n => n && n.family === 'IPv4' && !n.internal);
      if (ext) {
        const viaLan = (p) => new Promise(resolve => { const q = http.request({ host: ext.address, port, path: p, headers: { Host: `localhost:${port}` } }, rs => { rs.resume(); resolve(rs.statusCode); }); q.on('error', () => resolve(null)); q.end(); });
        for (const p of ['/api/coach/status', '/api/strava/status', '/api/strava/sync?after=2020-01-01&before=2020-02-01']) { const st = await viaLan(p); if (st !== null) assert.equal(st, 403, p); }
      }
    }
    fs.writeFileSync(archiveFile, '{broken'); assert.equal((await fetch(base + '/api/local-history')).status, 500); assert.equal(fs.readFileSync(archiveFile, 'utf8'), '{broken');
    fs.unlinkSync(archiveFile); fs.writeFileSync(path.join(dir, 'data/divan_cycling_history.js'), 'window.DIVAN_HEALTHFIT_DATA = ' + bytes + ';');
    assert.deepEqual(await (await fetch(base + '/api/local-history')).json(), legacy);
    const inbox = path.join(dir, 'data/health/inbox'); fs.mkdirSync(inbox, { recursive: true }); const token = 'a'.repeat(48); fs.writeFileSync(path.join(dir, 'data/health/token.txt'), token);
    for (let i = 0; i < 500; i++) fs.writeFileSync(path.join(inbox, `hae_20260101_000000_${i.toString(16).padStart(6, '0')}.json`), '{"data":{"metrics":[]}}');
    const incoming = await fetch(base + '/api/health', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{"data":{"metrics":[]}}' });
    assert.equal(incoming.status, 429); assert.equal(fs.readdirSync(inbox).length, 500);
  } finally {
    child.kill(); if (child.exitCode === null) await new Promise(r => child.once('exit', r));
    // Explicitly confine recursive cleanup to the temporary fixture created above.
    if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep + 'apex-public-check-')) throw new Error('Unsafe cleanup path');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
