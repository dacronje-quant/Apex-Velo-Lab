// The phone store (src/native-store.js) against the cases of tests/sqlite-store.test.js that apply on the
// phone, on node:sqlite, plus compressed samples, interrupted migration, serialized requests and the
// workstream tables.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { NativeStore, SqliteSyncLedger, gunzip, unpackSamples } from '../src/native-store.js';
import { nodeDriver, folderFiles } from './sqlite-node.js';

const ride = { id: 'ride-1', date: '2026-10-01T08:00:00.000Z', title: 'Preserved ride', samples: [{ time: 1, power: 231 }, { time: 2, power: 240 }] };
const settings = { apex_velo_profiles: JSON.stringify([{ id: 'rider', name: 'Fixture', ftp: 230 }]), apex_velo_active_prof_id: 'rider', apex_erg_response: 'responsive', apex_health_v1: '{"days":{}}', apex_velo_block_v1: '{"weeks":4}' };
let op = 0;
const opened = new Set();

async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-native-store-'));
  const s = await open(dir, options);
  t.after(async () => {
    for (const x of opened) if (x.dir === dir) { await x.close().catch(() => {}); opened.delete(x); }
    if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep + 'apex-native-store-')) throw new Error('Unsafe cleanup');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return s;
}
async function open(dir, options = {}) {
  const s = await NativeStore.open({ db: nodeDriver(path.join(dir, 'apex.sqlite')), files: folderFiles(path.join(dir, 'backups')), backupDelayMs: 3600000, ...options });
  s.dir = dir; s.path = path.join(dir, 'apex.sqlite');
  opened.add(s);
  return s;
}
const request = async (s, extra = {}) => ({ revision: await s.revision(), operationId: 'fixture_operation_' + ++op, ...extra });
const migrate = async (s) => s.migrate(await request(s, { rides: [ride], settings, dbSettings: [{ key: 'strava_restore:1', history: [ride] }] }));
const snapshotPath = (s, name) => path.join(s.files.dir, s.snapshotFile(name));

test('migration preserves every sample, preference and restore point; original snapshot is verified', async (t) => {
  const s = await fixture(t); await migrate(s);
  assert.deepEqual(await s.rides(), [ride]); assert.deepEqual(await s.settings(), settings);
  assert.equal((await s.dbSettings())[0].history[0].samples[1].power, 240);
  const b = (await s.backups()).files[0]; assert.equal(b.reason, 'migration'); assert.equal(b.verified, true);
  assert.deepEqual((await s.readSnapshot(s.snapshotFile(b.name))).payload.history, [ride]);
  await assert.rejects(async () => s.migrate(await request(s, { rides: [], settings: {} })), /already has saved data/);
});

test('ride samples are stored gzipped and read back unchanged, key order included', async (t) => {
  const s = await fixture(t);
  const samples = Array.from({ length: 3600 }, (_, i) => ({ time: i, power: 200 + (i % 7), hr: 140, cadence: 90, timestamp: 1759305600000 + i * 1000 }));
  const long = { id: 'long', samples, date: '2026-10-02T08:00:00.000Z', title: 'Hour' };
  await s.migrate(await request(s, { rides: [long, { id: 'summary', date: '2026-10-03T08:00:00.000Z' }], settings: {} }));
  const row = (await s.db.all("SELECT * FROM rides WHERE id='long'"))[0];
  assert.equal(row.sample_count, 3600);
  assert.doesNotMatch(row.json, /"power"/, 'samples are not kept as plain JSON');
  assert.deepEqual(await unpackSamples(row.samples_gz), samples);
  assert.ok(row.samples_gz.length < JSON.stringify(samples).length / 5, `compressed ${row.samples_gz.length} of ${JSON.stringify(samples).length} bytes`);
  const [back, summary] = await s.rides();
  assert.equal(JSON.stringify(back), JSON.stringify(long));
  assert.deepEqual(summary, { id: 'summary', date: '2026-10-03T08:00:00.000Z' });
  assert.equal((await s.db.all("SELECT samples_gz FROM rides WHERE id='summary'"))[0].samples_gz, null);
});

test('SQLite survives close and reopen independently of any browser', async (t) => {
  const s = await fixture(t); await migrate(s); const id = await s.meta('storeId'), rev = await s.revision(); await s.close(); opened.delete(s);
  const reopened = await open(s.dir);
  assert.deepEqual(await reopened.rides(), [ride]); assert.deepEqual(await reopened.settings(), settings);
  assert.equal(await reopened.revision(), rev); assert.equal(await reopened.meta('storeId'), id);
});

test('metadata-only writes preserve samples; exact restore can intentionally replace them', async (t) => {
  const s = await fixture(t); await migrate(s);
  await s.update(await request(s, { put: [{ ...ride, title: 'Edited', samples: [] }] }));
  assert.deepEqual((await s.rides())[0].samples, ride.samples);
  assert.equal((await s.rides())[0].title, 'Edited');
  const { samples, ...summary } = ride;
  await s.update(await request(s, { put: [{ ...summary, title: 'No samples key' }] }));
  assert.deepEqual((await s.rides())[0], { ...summary, title: 'No samples key', samples: ride.samples }, 'samples are added back after the other fields, as on the PC');
  await s.update(await request(s, { put: [{ ...ride, samples: [] }], exact: true })); assert.deepEqual((await s.rides())[0].samples, []);
});

test('a failing mixed mutation rolls back deletion, preference and restore point changes', async (t) => {
  const s = await fixture(t); await migrate(s); const before = await s.state();
  await assert.rejects(async () => s.update(await request(s, { del: [ride.id], settings: { apex_erg_response: 'steady' }, dbPut: [{}] })), /Invalid restore/);
  assert.deepEqual(await s.state(), before);
});

test('stale tabs cannot overwrite newer data; lost response is idempotently replayed', async (t) => {
  const s = await fixture(t); await migrate(s);
  const first = await request(s, { settings: { apex_erg_response: 'steady' } }), stale = await request(s, { clear: true });
  const result = await s.update(first); assert.deepEqual(await s.update(first), result); assert.equal(await s.revision(), 2);
  await assert.rejects(() => s.update(stale), (e) => e.status === 409); assert.deepEqual(await s.rides(), [ride]);
});

test('requests on the one connection run one at a time, so a read never sees half a write', async (t) => {
  const s = await fixture(t); await migrate(s);
  const rides = Array.from({ length: 30 }, (_, i) => ({ id: 'r' + i, date: ride.date, samples: [{ time: 1, power: i }] }));
  const save = s.route('/api/storage/save', 'POST', JSON.stringify(await request(s, { put: rides, del: [ride.id] })));
  const read = s.route('/api/storage/rides', 'GET');
  const [saved, during] = await Promise.all([save, read]);
  assert.equal(saved.status, 200);
  assert.equal(during.body.rides.length, 30, 'the read waited for the whole save');
  assert.equal(during.body.revision, saved.body.revision);
});

test('restore verifies checksums, replaces data and preserves a before-restore snapshot', async (t) => {
  const s = await fixture(t); await migrate(s); const backup = await s.backup();
  await s.update(await request(s, { clear: true, settings: { apex_erg_response: 'steady' } }));
  await s.restore(await request(s, { name: backup.name })); assert.deepEqual(await s.rides(), [ride]); assert.equal((await s.settings()).apex_erg_response, 'responsive');
  const safe = (await s.backups()).files.find((b) => b.reason === 'before-restore'); assert.ok(safe);
  assert.deepEqual((await s.readSnapshot(s.snapshotFile(safe.name))).payload.history, []);
  await assert.rejects(async () => s.restore(await request(s, { name: '../../.env' })), /Invalid backup/);
  await assert.rejects(async () => s.restore(await request(s, { name: 'legacy:apex_velo_backup_2026-10-01_080000.json.gz' })), /Invalid backup/, 'the phone has no legacy folder');
});

test('damaged or tampered backups leave the live database byte-for-byte equivalent', async (t) => {
  const s = await fixture(t); await migrate(s); const backup = await s.backup(), file = snapshotPath(s, backup.name);
  const value = JSON.parse(zlib.gunzipSync(fs.readFileSync(file))); value.history[0].samples[0].power = 999;
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(value))); const before = await s.state();
  await assert.rejects(async () => s.restore(await request(s, { name: backup.name })), /checksum/); assert.deepEqual(await s.state(), before);
  assert.ok((await s.backups()).files.find((b) => b.name === backup.name).corrupt);
  fs.writeFileSync(file, 'not gzip');
  await assert.rejects(async () => s.restore(await request(s, { name: backup.name }))); assert.deepEqual(await s.state(), before);
});

test('migration and restore abort safely when a recovery snapshot cannot be written', async (t) => {
  const s = await fixture(t); fs.writeFileSync(s.files.dir, 'not a directory');
  await assert.rejects(() => migrate(s)); assert.equal(await s.initialized(), false); assert.deepEqual(await s.rides(), []);
  fs.unlinkSync(s.files.dir); await migrate(s); const b = await s.backup(), before = await s.state();
  const normal = s.writeSnapshot; s.writeSnapshot = async () => { throw new Error('disk full'); };
  await assert.rejects(async () => s.restore(await request(s, { name: b.name })), /disk full/); assert.deepEqual(await s.state(), before); s.writeSnapshot = normal;
});

test('an interrupted migration leaves nothing behind and simply runs again (idempotent, resumable)', async (t) => {
  const s = await fixture(t);
  const rides = Array.from({ length: 12 }, (_, i) => ({ id: 'm' + i, date: ride.date, samples: [{ time: 1, power: i }] }));
  const input = await request(s, { rides, settings, dbSettings: [] });
  // The app is killed (here: the driver fails) after a few ride writes inside the migration transaction.
  const run = s.db.run; let writes = 0;
  s.db.run = async (sql, params) => { if (/INTO rides/.test(sql) && ++writes === 5) throw new Error('process killed'); return run(sql, params); };
  await assert.rejects(() => s.migrate(input), /process killed/);
  s.db.run = run;
  assert.equal(await s.initialized(), false); assert.deepEqual(await s.rides(), []); assert.deepEqual(await s.settings(), {}); assert.equal(await s.revision(), 0);
  // The next start retries with the untouched WebView data; a lost response is replayed with the same ID.
  const first = await s.migrate(input);
  assert.deepEqual(await s.migrate(input), first);
  assert.deepEqual(await s.rides(), rides); assert.deepEqual(await s.settings(), settings);
  assert.equal((await s.backups()).files.filter((f) => f.reason === 'migration').length, 2, 'each attempt kept its own verified copy of the browser data');
});

test('validation rejects malformed records/settings before commit', async (t) => {
  const s = await fixture(t);
  await assert.rejects(async () => s.migrate(await request(s, { rides: [{ id: 'bad', date: 'wrong' }], settings: {} })), /valid ID/);
  await assert.rejects(async () => s.migrate(await request(s, { rides: [], settings: { '__proto__bad': 'no' } })), /Invalid setting/);
  assert.equal(await s.initialized(), false); assert.equal(await s.revision(), 0);
});

test('retention keeps 14 recent snapshots plus daily/weekly/monthly and migration recovery', async (t) => {
  let date = new Date('2025-01-01T08:00:00Z'); const s = await fixture(t, { clock: () => date }); await migrate(s);
  for (let month = 0; month < 16; month++) { date = new Date(Date.UTC(2025, month, 1, 8)); await s.backup('daily'); }
  for (let day = 1; day < 40; day++) { date = new Date(Date.UTC(2026, 4, day, 8)); await s.backup('daily'); }
  for (let i = 0; i < 20; i++) { date = new Date(date.getTime() + 1000); await s.backup(); }
  const files = (await s.backups()).files; assert.ok(files.some((f) => f.reason === 'migration')); assert.ok(files.length > 14); assert.ok(files.length <= 14 + 30 + 12 + 12 + 1);
  assert.equal(files.filter((f) => f.reason === 'manual').length, 14);
  assert.ok(files.filter((f) => f.reason === 'daily').length >= 30);
});

test('daily safety net runs without a browser request and records backup failures', async (t) => {
  let date = new Date('2026-10-01T08:00:00Z'); const s = await fixture(t, { clock: () => date }); await migrate(s);
  date = new Date('2026-10-03T08:00:00Z'); await s.startDailyBackups(); assert.ok((await s.backups()).files.some((f) => f.reason === 'daily'));
  date = new Date('2026-10-05T08:00:00Z'); s.writeSnapshot = async () => { throw new Error('disk full'); }; await s.startDailyBackups(); assert.equal(s.lastBackupError, 'disk full');
});

test('a save schedules an automatic snapshot after a pause', async (t) => {
  const s = await fixture(t, { backupDelayMs: 20 }); await migrate(s);
  await s.update(await request(s, { settings: { apex_erg_response: 'steady' } }));
  for (let i = 0; i < 100 && !(await s.backups()).files.some((f) => f.reason === 'automatic'); i++) await new Promise((r) => setTimeout(r, 20));
  const auto = (await s.backups()).files.find((f) => f.reason === 'automatic');
  assert.ok(auto, 'automatic snapshot written');
  assert.equal(JSON.parse((await s.readSnapshot(auto.name)).payload.settings.apex_velo_profiles)[0].name, 'Fixture');
});

test('corrupt and future-schema databases are never reset automatically', async (t) => {
  const s = await fixture(t); await migrate(s); s.db.raw.exec('PRAGMA user_version=99'); await s.close(); opened.delete(s); const bytes = fs.readFileSync(s.path);
  await assert.rejects(() => open(s.dir), /newer version/); assert.deepEqual(fs.readFileSync(s.path), bytes);
  const dir = path.join(s.dir, 'corrupt'); fs.mkdirSync(dir); const file = path.join(dir, 'apex.sqlite'); fs.writeFileSync(file, 'damaged database');
  await assert.rejects(() => open(dir)); assert.equal(fs.readFileSync(file, 'utf8'), 'damaged database');
});

test('snapshots match the desktop format both ways', async (t) => {
  const s = await fixture(t); await migrate(s); const b = await s.backup();
  const value = JSON.parse(zlib.gunzipSync(fs.readFileSync(snapshotPath(s, b.name))));
  assert.equal(value.storageBackup.version, 1); assert.deepEqual(value.history, [ride]);
  // The desktop store reads this file as one of its own.
  const { LocalStore } = await import('../../scripts/sqlite-store.cjs');
  const pcDir = path.join(s.dir, 'pc'); const pc = new LocalStore({ dir: pcDir });
  try {
    const name = pc.importSnapshot(value).name;
    assert.equal(pc.backups().files.find((f) => f.name === name).verified, true);
    const pcValue = JSON.parse(zlib.gunzipSync(fs.readFileSync(pc.snapshotFile(name))));
    const imported = await s.importSnapshot(pcValue);
    assert.equal((await s.backups()).files.find((f) => f.name === imported.name).reason, 'imported');
  } finally { pc.close(); }
  value.history[0].title = 'Tampered'; await assert.rejects(() => s.importSnapshot(value), /checksum/); assert.deepEqual(await s.rides(), [ride]);
  assert.ok((await gunzip(new Uint8Array(fs.readFileSync(snapshotPath(s, b.name))))).length > 0);
});

test('process death inside a write transaction cannot expose half-applied changes', { timeout: 10000 }, async (t) => {
  const s = await fixture(t); await migrate(s); await s.close(); opened.delete(s);
  const code = "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec(\"PRAGMA journal_mode=WAL;BEGIN IMMEDIATE;DELETE FROM rides;UPDATE settings SET value='half-applied' WHERE key='apex_erg_response';\");process.stdout.write('ready');setInterval(()=>{},1000);";
  const child = spawn(process.execPath, ['-e', code, s.path], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', (n) => reject(new Error('Crash fixture exited early ' + n))); });
    const exited = new Promise((r) => child.once('exit', r)); child.kill(); await exited;
    const reopened = await open(s.dir);
    assert.deepEqual(await reopened.rides(), [ride]); assert.equal((await reopened.settings()).apex_erg_response, 'responsive');
  } finally { if (child.exitCode === null) child.kill(); }
});

test('a new backup does not re-read every earlier snapshot to prune them', async (t) => {
  let now = Date.parse('2026-01-01T08:00:00Z');
  const s = await fixture(t, { clock: () => new Date(now) }); await migrate(s);
  for (let i = 0; i < 20; i++) { now += 86400000; await s.backup('manual'); }
  let reads = 0; const read = s.readSnapshot.bind(s); s.readSnapshot = (f) => { reads++; return read(f); };
  now += 86400000; await s.backup('manual');
  assert.equal(reads, 1, 'only the new snapshot is verified');
  assert.equal((await s.backups()).files.length, (await s.backupFiles()).length);
  assert.equal(reads, 1, 'listing backups uses the remembered details too');
  // An app restart remembers them as well: no snapshot is read again to list or prune.
  const count = (await s.backups()).files.length;
  await s.close(); opened.delete(s);
  const reopened = await open(s.dir, { clock: () => new Date(now) });
  let again = 0; const readAgain = reopened.readSnapshot.bind(reopened); reopened.readSnapshot = (f) => { again++; return readAgain(f); };
  assert.equal((await reopened.backups()).files.length, count);
  assert.equal(again, 0);
  now += 86400000; await reopened.backup('manual');
  assert.equal(again, 1, 'after a restart only the new snapshot is verified');
});

test('rides are read in pages, in saved order', async (t) => {
  const s = await fixture(t);
  const rides = Array.from({ length: 123 }, (_, i) => ({ id: 'p' + i, date: ride.date, ...(i % 2 ? { samples: [{ time: 1, power: i }] } : {}) }));
  await s.migrate(await request(s, { rides, settings: {} }));
  const all = s.db.all; let calls = 0; s.db.all = (sql, params) => { if (/FROM rides ORDER BY/.test(sql)) calls++; return all(sql, params); };
  assert.deepEqual(await s.rides(), rides);
  assert.equal(calls, 3);
});

test('routes answer like server.js', async (t) => {
  const s = await fixture(t);
  const get = (p) => s.route(p, 'GET');
  const post = (p, body) => s.route(p, 'POST', JSON.stringify(body));
  let r = await get('/api/storage');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body), ['ok', 'initialized', 'revision', 'storeId', 'dir', 'file', 'rides', 'settings', 'dbSettings', 'migratedAt']);
  assert.equal(r.body.initialized, false);
  assert.equal((await post('/api/storage/save', { revision: 0, operationId: 'fixture_operation_x1' })).status, 409, 'saving before migration');
  r = await post('/api/storage/migrate', { revision: 0, operationId: 'fixture_operation_x2', rides: [ride], settings, dbSettings: [] });
  assert.deepEqual(Object.keys(r.body), ['ok', 'revision', 'storeId']);
  assert.deepEqual((await get('/api/storage/rides')).body, { ok: true, rides: [ride], revision: 1 });
  assert.deepEqual((await get('/api/storage/db-settings')).body, { ok: true, settings: [], revision: 1 });
  const backup = await post('/api/storage/backup', {});
  assert.equal(backup.body.ok, true); assert.equal(backup.body.reason, 'manual');
  const preview = await post('/api/storage/preview', { name: backup.body.name });
  assert.deepEqual({ rides: preview.body.rides, samples: preview.body.samples, profiles: preview.body.profiles, settings: preview.body.settings }, { rides: 1, samples: 2, profiles: 1, settings: 5 });
  assert.equal((await get('/api/storage/backups')).body.files.length, 2);
  assert.deepEqual(await s.route('/api/storage/save', 'POST', '{nope'), { status: 400, body: { error: 'Invalid JSON.' } });
  assert.equal((await post('/api/storage/save', [])).status, 400);
  assert.equal((await get('/api/storage/nothing')).status, 404);
  assert.equal((await s.route('/api/storage', 'DELETE')).status, 405);
});

test('import jobs and their files: partial updates, progress, dedupe by hash', async (t) => {
  let now = new Date('2026-10-01T08:00:00Z'); const s = await fixture(t, { clock: () => now });
  const job = await s.putImportJob({ id: 'job1', source: 'zip', status: 'running', total: 3, cursor: { entry: 0 } });
  assert.deepEqual(job, { id: 'job1', source: 'zip', status: 'running', total: 3, done: 0, skipped: 0, errors: 0, createdAt: now.toISOString(), updatedAt: now.toISOString(), cursor: { entry: 0 } });
  now = new Date('2026-10-01T08:05:00Z');
  const moved = await s.putImportJob({ id: 'job1', done: 2, cursor: { entry: 2 } });
  assert.equal(moved.total, 3); assert.equal(moved.done, 2); assert.equal(moved.createdAt, '2026-10-01T08:00:00.000Z'); assert.equal(moved.updatedAt, now.toISOString());
  await s.putImportFiles('job1', [{ path: 'a.fit', hash: 'h1', status: 'pending' }, { path: 'b.fit', hash: 'h2', status: 'pending' }]);
  await s.putImportFiles('job1', [{ path: 'a.fit', rideId: 'ride-a', status: 'done' }]);
  assert.deepEqual(await s.listImportFiles('job1'), [
    { jobId: 'job1', path: 'a.fit', hash: 'h1', rideId: 'ride-a', status: 'done', error: null },
    { jobId: 'job1', path: 'b.fit', hash: 'h2', rideId: null, status: 'pending', error: null }]);
  assert.equal((await s.listImportFiles('job1', { status: 'pending' })).length, 1);
  assert.equal((await s.findImportFileByHash('h1')).rideId, 'ride-a');
  assert.equal(await s.findImportFileByHash('h2'), null, 'a file not imported yet is no duplicate');
  await assert.rejects(() => s.putImportFiles('job1', [{ path: 'c.fit' }, { path: '' }]), /import file path/);
  assert.equal((await s.listImportFiles('job1')).length, 2, 'a bad batch writes nothing');
  assert.deepEqual((await s.listImportJobs({ status: 'running' })).map((j) => j.id), ['job1']);
  await s.deleteImportJob('job1');
  assert.equal(await s.getImportJob('job1'), null); assert.deepEqual(await s.listImportFiles('job1'), []);
  assert.equal(await s.revision(), 0, 'job progress never makes another tab reload');
});

test('sync ledger: one entry per ride and destination, attempts and errors kept', async (t) => {
  const s = await fixture(t);
  await s.putSyncEntry({ rideId: 42, destination: 'strava', status: 'failed', attempts: 1, lastError: 'timeout', contentHash: 'c1' });
  const sent = await s.putSyncEntry({ rideId: '42', destination: 'strava', status: 'sent', attempts: 2, lastError: null, externalId: '555' });
  assert.deepEqual({ ...sent, updatedAt: undefined }, { rideId: '42', destination: 'strava', externalId: '555', contentHash: 'c1', status: 'sent', attempts: 2, lastError: null, updatedAt: undefined });
  await s.putSyncEntry({ rideId: '42', destination: 'icu', status: 'pending' });
  assert.deepEqual((await s.listSyncEntries({ rideId: 42 })).map((e) => e.destination), ['icu', 'strava']);
  assert.equal((await s.getSyncEntry(42, 'strava')).externalId, '555');
  assert.equal(await s.getSyncEntry(42, 'healthconnect'), null);
  await assert.rejects(() => s.putSyncEntry({ rideId: '42' }), /destination/);
});

test('wellness days per source, by date range, with deletes', async (t) => {
  const s = await fixture(t);
  await s.putWellnessDays('icu', { '2026-10-01': { rhr: 48 }, '2026-10-02': { rhr: 49 }, '2026-10-03': { rhr: 50 } });
  await s.putWellnessDays('healthconnect', { '2026-10-02': { steps: 9000 } });
  await s.putWellnessDays('icu', { '2026-10-03': null });
  assert.deepEqual(await s.listWellnessDays({ from: '2026-10-02' }), [
    { day: '2026-10-02', source: 'healthconnect', data: { steps: 9000 } }, { day: '2026-10-02', source: 'icu', data: { rhr: 49 } }]);
  assert.equal((await s.listWellnessDays({ source: 'icu', to: '2026-10-01' })).length, 1);
  await assert.rejects(() => s.putWellnessDays('icu', { '1 Oct': {} }), /wellness day/);
});

test('SqliteSyncLedger has the PrefsSyncLedger methods and rows, so the upload queue can swap to it', async (t) => {
  let now = new Date('2026-10-01T08:00:00Z'); const s = await fixture(t, { clock: () => now });
  const ledger = new SqliteSyncLedger({ store: s });
  assert.equal(await ledger.get('r1', 'strava'), null);
  const queued = await ledger.update('r1', 'strava', {});
  assert.deepEqual(queued, { ride_id: 'r1', destination: 'strava', external_id: null, content_hash: null, status: 'queued', attempts: 0, last_error: null, updated_at: now.toISOString() });
  now = new Date('2026-10-01T08:01:00Z');
  await ledger.update('r1', 'strava', { attempts: 1, last_error: 'timeout' });
  const sent = await ledger.update('r1', 'strava', { status: 'sent', external_id: '5550001', last_error: null });
  assert.deepEqual({ ...sent }, { ride_id: 'r1', destination: 'strava', external_id: '5550001', content_hash: null, status: 'sent', attempts: 1, last_error: null, updated_at: now.toISOString() });
  await Promise.all([ledger.update('r2', 'strava', { attempts: 1 }), ledger.update('r2', 'strava', { content_hash: 'abc' })]);
  assert.deepEqual([(await ledger.get('r2', 'strava')).attempts, (await ledger.get('r2', 'strava')).content_hash], [1, 'abc'], 'concurrent updates both land');
  await ledger.update('r1', 'icu', { status: 'skipped' });
  assert.deepEqual((await ledger.list('strava')).map((r) => r.ride_id), ['r1', 'r2']);
  await ledger.remove('r2', 'strava');
  assert.equal(await ledger.get('r2', 'strava'), null);
  assert.equal(await ledger.getOption('auto_strava'), null);
  await ledger.setOption('auto_strava', 1);
  assert.equal(await ledger.getOption('auto_strava'), '1');
});

test('SqliteSyncLedger moves PrefsSyncLedger data in once, keeping what the table already has', async (t) => {
  const s = await fixture(t); const ledger = new SqliteSyncLedger({ store: s });
  const prefs = new Map([
    ['apex_sync_ledger_strava', JSON.stringify({ a: { ride_id: 'a', destination: 'strava', external_id: '9', content_hash: 'h', status: 'sent', attempts: 2, last_error: null, updated_at: '2026-09-01T00:00:00.000Z' },
      b: { ride_id: 'b', destination: 'strava', external_id: null, content_hash: null, status: 'queued', attempts: 3, last_error: 'offline', updated_at: '2026-09-01T00:00:00.000Z' } })],
    ['apex_sync_ledger_icu', '{broken'], ['apex_sync_opt_auto_strava', '1']]);
  const api = { get: async (k) => prefs.get(k) ?? null, set: async (k, v) => prefs.set(k, v), remove: async (k) => prefs.delete(k) };
  await ledger.update('b', 'strava', { status: 'sent', external_id: '10' });
  assert.equal(await ledger.importPrefs(api, { destinations: ['strava', 'icu'], options: ['auto_strava'] }), 1);
  assert.deepEqual([(await ledger.get('a', 'strava')).external_id, (await ledger.get('a', 'strava')).attempts], ['9', 2]);
  assert.equal((await ledger.get('b', 'strava')).external_id, '10', 'the table already had b');
  assert.equal(await ledger.getOption('auto_strava'), '1');
  assert.deepEqual([...prefs.keys()], ['apex_sync_ledger_icu'], 'moved keys removed; an unreadable one is left alone');
  assert.equal(await ledger.importPrefs(api, { destinations: ['strava'], options: ['auto_strava'] }), 0, 'running again moves nothing');
});
