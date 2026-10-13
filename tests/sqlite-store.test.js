'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), zlib = require('node:zlib');
const { LocalStore } = require('../scripts/sqlite-store.cjs');
const ride = { id: 'ride-1', date: '2026-10-01T08:00:00.000Z', title: 'Preserved ride', samples: [{ time: 1, power: 231 }, { time: 2, power: 240 }] };
const settings = { apex_velo_profiles: JSON.stringify([{ id: 'rider', name: 'Fixture', ftp: 230 }]), apex_velo_active_prof_id: 'rider', apex_erg_response: 'responsive', apex_health_v1: '{"days":{}}', apex_velo_block_v1: '{"weeks":4}' };
let op = 0;
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-sqlite-test-'));
  const s = new LocalStore({ dir, ...options });
  t.after(() => { try { s.close(); } catch {} if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep + 'apex-sqlite-test-')) throw new Error('Unsafe cleanup'); fs.rmSync(dir, { recursive: true, force: true }); });
  return s;
}
const request = (s, extra = {}) => ({ revision: s.revision, operationId: 'fixture_operation_' + ++op, ...extra });
const migrate = s => s.migrate(request(s, { rides: [ride], settings, dbSettings: [{ key: 'strava_restore:1', history: [ride] }] }));
test('migration preserves every sample, preference and restore point; original snapshot is verified', t => {
  const s = fixture(t); migrate(s);
  assert.deepEqual(s.rides(), [ride]); assert.deepEqual(s.settings(), settings);
  assert.equal(s.dbSettings()[0].history[0].samples[1].power, 240);
  const b = s.backups().files[0]; assert.equal(b.reason, 'migration'); assert.equal(b.verified, true);
  assert.deepEqual(s.readSnapshot(s.snapshotFile(b.name)).payload.history, [ride]);
  assert.throws(() => s.migrate(request(s, { rides: [], settings: {} })), /already has saved data/);
});
test('SQLite survives close and reopen independently of any browser', t => {
  const s = fixture(t); migrate(s); const id = s.meta('storeId'), rev = s.revision; s.close();
  const reopened = new LocalStore({ dir: s.dir });
  assert.deepEqual(reopened.rides(), [ride]); assert.deepEqual(reopened.settings(), settings); assert.equal(reopened.revision, rev); assert.equal(reopened.meta('storeId'), id);
  reopened.close();
});
test('metadata-only writes preserve samples; exact restore can intentionally replace them', t => {
  const s = fixture(t); migrate(s);
  s.update(request(s, { put: [{ ...ride, title: 'Edited', samples: [] }] }));
  assert.deepEqual(s.rides()[0].samples, ride.samples);
  s.update(request(s, { put: [{ ...ride, samples: [] }], exact: true })); assert.deepEqual(s.rides()[0].samples, []);
});
test('a failing mixed mutation rolls back deletion, preference and restore point changes', t => {
  const s = fixture(t); migrate(s); const before = s.state();
  assert.throws(() => s.update(request(s, { del: [ride.id], settings: { apex_erg_response: 'steady' }, dbPut: [{}] })), /Invalid restore/);
  assert.deepEqual(s.state(), before);
});
test('stale tabs cannot overwrite newer data; lost response is idempotently replayed', t => {
  const s = fixture(t); migrate(s);
  const first = request(s, { settings: { apex_erg_response: 'steady' } }), stale = request(s, { clear: true });
  const result = s.update(first); assert.deepEqual(s.update(first), result); assert.equal(s.revision, 2);
  assert.throws(() => s.update(stale), e => e.status === 409); assert.deepEqual(s.rides(), [ride]);
});
test('concurrent database connections serialize commits and reject stale revisions', t => {
  const s = fixture(t); migrate(s); const other = new LocalStore({ dir: s.dir });
  try { const stale = request(other, { clear: true }); s.update(request(s, { settings: { apex_sound_muted: 'true' } }));
    assert.throws(() => other.update(stale), e => e.status === 409); assert.deepEqual(other.rides(), [ride]);
  } finally { other.close(); }
});
test('restore verifies checksums, replaces data and preserves a before-restore snapshot', t => {
  const s = fixture(t); migrate(s); const backup = s.backup();
  s.update(request(s, { clear: true, settings: { apex_erg_response: 'steady' } }));
  s.restore(request(s, { name: backup.name })); assert.deepEqual(s.rides(), [ride]); assert.equal(s.settings().apex_erg_response, 'responsive');
  const safe = s.backups().files.find(b => b.reason === 'before-restore'); assert.ok(safe);
  assert.deepEqual(s.readSnapshot(s.snapshotFile(safe.name)).payload.history, []);
  assert.throws(() => s.restore(request(s, { name: '../../.env' })), /Invalid backup/);
});
test('damaged or tampered backups leave the live database byte-for-byte equivalent', t => {
  const s = fixture(t); migrate(s); const backup = s.backup(), file = s.snapshotFile(backup.name);
  const value = JSON.parse(zlib.gunzipSync(fs.readFileSync(file))); value.history[0].samples[0].power = 999;
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(value))); const before = s.state();
  assert.throws(() => s.restore(request(s, { name: backup.name })), /checksum/); assert.deepEqual(s.state(), before);
  assert.ok(s.backups().files.find(b => b.name === backup.name).corrupt);
});
test('migration and restore abort safely when a recovery snapshot cannot be written', t => {
  const s = fixture(t); fs.writeFileSync(s.backupDir, 'not a directory');
  assert.throws(() => migrate(s)); assert.equal(s.initialized, false); assert.deepEqual(s.rides(), []);
  fs.unlinkSync(s.backupDir); migrate(s); const b = s.backup(), before = s.state();
  const normal = s.writeSnapshot; s.writeSnapshot = () => { throw new Error('disk full'); };
  assert.throws(() => s.restore(request(s, { name: b.name })), /disk full/); assert.deepEqual(s.state(), before); s.writeSnapshot = normal;
});
test('validation rejects malformed records/settings before commit', t => {
  const s = fixture(t);
  assert.throws(() => s.migrate(request(s, { rides: [{ id: 'bad', date: 'wrong' }], settings: {} })), /valid ID/);
  assert.throws(() => s.migrate(request(s, { rides: [], settings: { '__proto__bad': 'no' } })), /Invalid setting/);
  assert.equal(s.initialized, false); assert.equal(s.revision, 0);
});
test('legacy compressed backups are readable without being changed or pruned', t => {
  const s = fixture(t); migrate(s); const legacy = path.join(s.dir, 'legacy'); fs.mkdirSync(legacy); s.legacyDir = legacy;
  const name = 'apex_velo_backup_2026-10-01_080000.json.gz'; const payload = { app: 'APEX VELO LAB', history: [ride], profiles: [{ id:'old', name:'Old', ftp:200 }], exportedAt: ride.date };
  const bytes = zlib.gzipSync(JSON.stringify(payload)); fs.writeFileSync(path.join(legacy, name), bytes);
  assert.equal(s.backups().files.find(b => b.name === 'legacy:' + name).verified, false);
  s.restore(request(s, { name: 'legacy:' + name })); assert.deepEqual(s.rides(), [ride]);
  assert.equal(JSON.parse(s.settings().apex_velo_profiles)[0].name, 'Old'); assert.deepEqual(fs.readFileSync(path.join(legacy,name)), bytes);
});
test('retention keeps 14 recent snapshots plus daily/weekly/monthly and migration recovery', t => {
  let date = new Date('2025-01-01T08:00:00Z'); const s = fixture(t, { clock: () => date }); migrate(s);
  for (let month = 0; month < 16; month++) { date = new Date(Date.UTC(2025,month,1,8)); s.backup('daily'); }
  for (let day = 1; day < 40; day++) { date = new Date(Date.UTC(2026,4,day,8)); s.backup('daily'); }
  for (let i=0;i<20;i++) { date = new Date(date.getTime()+1000); s.backup(); }
  const files = s.backups().files; assert.ok(files.some(f=>f.reason==='migration')); assert.ok(files.length > 14); assert.ok(files.length <= 14+30+12+12+1);
  assert.equal(files.filter(f=>f.reason==='manual').length,14);
  assert.ok(files.filter(f=>f.reason==='daily').length >= 30);
});
test('daily safety net runs from the server without a browser and records backup failures', t => {
  let date = new Date('2026-10-01T08:00:00Z'); const s = fixture(t, { clock: () => date }); migrate(s);
  date = new Date('2026-10-03T08:00:00Z'); s.startDailyBackups(); assert.ok(s.backups().files.some(f=>f.reason==='daily'));
  clearInterval(s.dailyTimer); date = new Date('2026-10-05T08:00:00Z'); s.writeSnapshot=()=>{throw new Error('disk full');}; s.startDailyBackups(); assert.equal(s.lastBackupError,'disk full');
});
test('optional second-copy destination receives verified snapshots; failure preserves local backups', t => {
  const s=fixture(t);s.mirrorDir=path.join(s.dir,'second-copy');migrate(s);const b=s.backup();
  assert.deepEqual(fs.readFileSync(path.join(s.mirrorDir,b.name)),fs.readFileSync(s.snapshotFile(b.name)));
  const blocked=path.join(s.dir,'blocked');fs.writeFileSync(blocked,'not a folder');s.mirrorDir=blocked;
  const local=s.backup();assert.ok(fs.existsSync(s.snapshotFile(local.name)));assert.match(s.lastBackupError,/second copy failed/);
});
test('corrupt and future-schema databases are never reset automatically', t => {
  const s=fixture(t);migrate(s);s.db.exec('PRAGMA user_version=99');s.close();const bytes=fs.readFileSync(s.file);
  assert.throws(()=>new LocalStore({dir:s.dir}),/newer version/);assert.deepEqual(fs.readFileSync(s.file),bytes);
  const dir=path.join(s.dir,'corrupt');fs.mkdirSync(dir);const file=path.join(dir,'apex.sqlite');fs.writeFileSync(file,'damaged database');
  assert.throws(()=>new LocalStore({dir}));assert.equal(fs.readFileSync(file,'utf8'),'damaged database');
});
test('a backup from another PC can be validated and imported before a reviewed restore', t => {
  const s=fixture(t);migrate(s);const b=s.backup();const value=JSON.parse(zlib.gunzipSync(fs.readFileSync(s.snapshotFile(b.name))));
  const imported=s.importSnapshot(value);assert.equal(s.backups().files.find(f=>f.name===imported.name).reason,'imported');
  value.history[0].title='Tampered';assert.throws(()=>s.importSnapshot(value),/checksum/);assert.deepEqual(s.rides(),[ride]);
});
test('process death inside a write transaction cannot expose half-applied changes', {timeout:10000}, async t => {
  const {spawn}=require('node:child_process');const s=fixture(t);migrate(s);s.close();
  const code="const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec(\"PRAGMA journal_mode=WAL;BEGIN IMMEDIATE;DELETE FROM rides;UPDATE settings SET value='half-applied' WHERE key='apex_erg_response';\");process.stdout.write('ready');setInterval(()=>{},1000);";
  const child=spawn(process.execPath,['-e',code,s.file],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  try {
    await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',n=>reject(new Error('Crash fixture exited early '+n)));});
    const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;
    const reopened=new LocalStore({dir:s.dir});try{assert.deepEqual(reopened.rides(),[ride]);assert.equal(reopened.settings().apex_erg_response,'responsive');}finally{reopened.close();}
  }finally{if(child.exitCode===null)child.kill();}
});
