'use strict';
// Private local persistence. No browser, network, npm package or cloud service owns this file.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const MAX_BYTES = 200 * 1024 * 1024;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const settingKey = k => typeof k === 'string' && /^apex_[a-zA-Z0-9_:-]{1,180}$/.test(k) && !['apex_velo_history', 'apex_auto_backup', 'apex_sqlite_migration'].includes(k);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
function dataDirectory() {
  if (process.env.APEX_DATA_DIR) return path.resolve(process.env.APEX_DATA_DIR);
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ApexVeloLab');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'ApexVeloLab');
}
function validateRides(rides) {
  if (!Array.isArray(rides)) fail('Rides must be a list.');
  const ids = new Set();
  for (const r of rides) {
    if (!r || typeof r !== 'object' || !['string', 'number'].includes(typeof r.id) || !String(r.id).length || !r.date || !Number.isFinite(Date.parse(r.date))) fail('A ride has no valid ID or date.');
    if (ids.has(String(r.id))) fail('Duplicate ride ID.');
    ids.add(String(r.id));
    if (own(r, 'samples') && r.samples !== null && !Array.isArray(r.samples)) fail('Ride samples must be a list.');
  }
}
function validateSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) fail('Settings must be an object.');
  for (const [k, v] of Object.entries(settings)) if (!settingKey(k) || (v !== null && typeof v !== 'string')) fail('Invalid setting.');
}
function validateDbSettings(settings) {
  if (!Array.isArray(settings) || settings.some(s => !s || typeof s.key !== 'string' || !s.key.length || s.key.length > 250)) fail('Invalid restore points.');
}
class LocalStore {
  constructor({ dir = dataDirectory(), legacyDir = null, mirrorDir = process.env.APEX_BACKUP_MIRROR_DIR || null, clock = () => new Date() } = {}) {
    this.dir = path.resolve(dir); this.legacyDir = legacyDir; this.clock = clock;
    this.backupDir = path.join(this.dir, 'backups'); this.file = path.join(this.dir, 'apex.sqlite');
    this.mirrorDir = mirrorDir ? path.resolve(mirrorDir) : null;
    this.snapshotCache = new Map();
    fs.mkdirSync(this.dir, { recursive: true });
    this.db = new DatabaseSync(this.file);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      if (this.db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('The local database failed its integrity check. It has been left untouched.', 503);
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > 1) fail('This database needs a newer version of Apex. It has been left untouched.', 503);
      this.db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS rides (id TEXT PRIMARY KEY, json TEXT NOT NULL, position INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS db_settings (key TEXT PRIMARY KEY, json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, result TEXT NOT NULL, at INTEGER NOT NULL);
        PRAGMA user_version=1;`);
      if (!this.meta('storeId')) this.setMeta('storeId', crypto.randomUUID());
    } catch (e) { this.db.close(); throw e; }
    this.lastBackupError = null;
  }
  meta(key) { return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value; }
  setMeta(key, value) { this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, String(value)); }
  get revision() { return Number(this.meta('revision') || 0); }
  get initialized() { return this.meta('initialized') === '1'; }
  rides() { return this.db.prepare('SELECT json FROM rides ORDER BY position, id').all().map(r => JSON.parse(r.json)); }
  settings() { return Object.fromEntries(this.db.prepare('SELECT key,value FROM settings ORDER BY key').all().map(r => [r.key, r.value])); }
  dbSettings() { return this.db.prepare('SELECT json FROM db_settings ORDER BY key').all().map(r => JSON.parse(r.json)); }
  state() { return { ok: true, initialized: this.initialized, revision: this.revision, storeId: this.meta('storeId'), dir: this.dir, file: this.file,
    rides: this.rides(), settings: this.settings(), dbSettings: this.dbSettings(), migratedAt: this.meta('migratedAt') || null }; }
  checkRevision(input) {
    if (!Number.isSafeInteger(input.revision) || input.revision !== this.revision) fail('Another tab changed the saved data. Reload this tab before saving again; its recovery copy is retained.', 409);
  }
  mutate(input, fn) {
    if (!input || !/^[a-zA-Z0-9_-]{12,100}$/.test(input.operationId || '')) fail('Missing save operation ID.');
    const previous = this.db.prepare('SELECT result FROM operations WHERE id=?').get(input.operationId);
    if (previous) return JSON.parse(previous.result);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.checkRevision(input); fn();
      this.setMeta('revision', this.revision + 1);
      const result = { ok: true, revision: this.revision, storeId: this.meta('storeId') };
      this.db.prepare('INSERT INTO operations VALUES (?,?,?)').run(input.operationId, JSON.stringify(result), this.clock().getTime());
      this.db.exec('DELETE FROM operations WHERE rowid NOT IN (SELECT rowid FROM operations ORDER BY rowid DESC LIMIT 1000); COMMIT;');
      this.scheduleBackup(); return result;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  applySettings(settings) {
    validateSettings(settings);
    for (const [k, v] of Object.entries(settings)) {
      if (v === null) this.db.prepare('DELETE FROM settings WHERE key=?').run(k);
      else this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(k, v);
    }
  }
  applyRides(put, del = [], { exact = false, replace = false } = {}) {
    validateRides(put);
    if (!Array.isArray(del) || del.some(id => !['number', 'string'].includes(typeof id))) fail('Invalid deleted IDs.');
    if (replace) this.db.exec('DELETE FROM rides');
    for (const id of del) this.db.prepare('DELETE FROM rides WHERE id=?').run(String(id));
    let position = Number(this.db.prepare('SELECT COALESCE(MAX(position),-1) AS n FROM rides').get().n) + 1;
    for (const ride of put) {
      const previous = this.db.prepare('SELECT json,position FROM rides WHERE id=?').get(String(ride.id));
      const old = previous ? JSON.parse(previous.json) : null;
      const value = !exact && !(ride.samples?.length) && old?.samples?.length ? { ...ride, samples: old.samples } : ride;
      this.db.prepare('INSERT OR REPLACE INTO rides VALUES (?,?,?)').run(String(ride.id), JSON.stringify(value), previous?.position ?? position++);
    }
  }
  migrate(input) {
    validateRides(input.rides); validateSettings(input.settings); validateDbSettings(input.dbSettings || []);
    const replay = this.db.prepare('SELECT result FROM operations WHERE id=?').get(input.operationId);
    if (replay) return JSON.parse(replay.result);
    this.checkRevision(input);
    if (this.initialized) fail('This PC already has saved data. Reload to use it.', 409);
    // Verify a recovery snapshot of the complete browser export BEFORE committing migration.
    this.writeSnapshot({ app: 'APEX VELO LAB', exportedAt: this.clock().toISOString(), history: input.rides,
      settings: input.settings, dbSettings: input.dbSettings || [], profiles: JSON.parse(input.settings.apex_velo_profiles || '[]') }, 'migration');
    return this.mutate(input, () => {
      this.applyRides(input.rides, [], { exact: true }); this.applySettings(input.settings);
      for (const s of input.dbSettings || []) this.db.prepare('INSERT OR REPLACE INTO db_settings VALUES (?,?)').run(s.key, JSON.stringify(s));
      this.setMeta('initialized', 1); this.setMeta('migratedAt', this.clock().toISOString());
      // Verify the complete serialized content before COMMIT, not just record counts.
      const actual = this.rides(), savedSettings = this.settings(), wantedSettings = Object.entries(input.settings).filter(([,v]) => v !== null);
      const restorePoints = new Map(this.dbSettings().map(s => [s.key, JSON.stringify(s)]));
      if (JSON.stringify(actual) !== JSON.stringify(input.rides) || Object.keys(savedSettings).length !== wantedSettings.length
        || wantedSettings.some(([k,v]) => savedSettings[k] !== v) || restorePoints.size !== (input.dbSettings || []).length
        || (input.dbSettings || []).some(s => restorePoints.get(s.key) !== JSON.stringify(s))) fail('Migration verification failed.', 500);
    });
  }
  update(input) {
    if (!this.initialized) fail('Finish migration before saving.', 409);
    return this.mutate(input, () => {
      if (input.put !== undefined || input.del !== undefined || input.clear) this.applyRides(input.put || [], input.del || [], { exact: !!input.exact, replace: !!input.clear });
      if (input.order) {
        if (!Array.isArray(input.order) || input.order.some(id => !['number','string'].includes(typeof id))) fail('Invalid ride order.');
        input.order.forEach((id, position) => this.db.prepare('UPDATE rides SET position=? WHERE id=?').run(position, String(id)));
      }
      if (input.settings) this.applySettings(input.settings);
      if (input.dbPut) {
        validateDbSettings(input.dbPut);
        for (const s of input.dbPut) this.db.prepare('INSERT OR REPLACE INTO db_settings VALUES (?,?)').run(s.key, JSON.stringify(s));
      }
      if (input.dbDelete) {
        if (!Array.isArray(input.dbDelete) || input.dbDelete.some(k => typeof k !== 'string')) fail('Invalid restore point deletion.');
        for (const k of input.dbDelete) this.db.prepare('DELETE FROM db_settings WHERE key=?').run(k);
      }
    });
  }
  payload() {
    const s = this.settings();
    const parse = (k, fallback) => { try { return JSON.parse(s[k] || 'null') ?? fallback; } catch { return fallback; } };
    return { app: 'APEX VELO LAB', exportedAt: this.clock().toISOString(), profiles: parse('apex_velo_profiles', []),
      activeProfileId: s.apex_velo_active_prof_id || null, workoutLibrary: parse('apex_velo_saved_workouts', []),
      health: parse('apex_health_v1', null), history: this.rides(), settings: s, dbSettings: this.dbSettings() };
  }
  writeSnapshot(payload, reason = 'automatic') {
    validateRides(payload.history); validateSettings(payload.settings || {}); validateDbSettings(payload.dbSettings || []);
    const checksum = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const value = { ...payload, storageBackup: { version: 1, checksum, reason } };
    const name = `apex_${this.clock().toISOString().replace(/[:.]/g, '-')}_${crypto.randomBytes(4).toString('hex')}.json.gz`;
    fs.mkdirSync(this.backupDir, { recursive: true });
    const target = path.join(this.backupDir, name), tmp = target + '.tmp';
    try {
      fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify(value)), { flush: true });
      const written = this.readSnapshot(tmp); fs.renameSync(tmp, target);
      this.rememberSnapshot(target, written);
      this.pruneBackups();
      this.lastBackupError = null;
      if (this.mirrorDir && this.mirrorDir !== this.backupDir) {
        let mirrorTmp;
        try {
          fs.mkdirSync(this.mirrorDir, { recursive: true });
          mirrorTmp = path.join(this.mirrorDir, name + '.tmp');
          fs.writeFileSync(mirrorTmp, fs.readFileSync(target), { flush: true });
          this.readSnapshot(mirrorTmp); fs.renameSync(mirrorTmp, path.join(this.mirrorDir, name));
        } catch (e) {
          if (mirrorTmp) try { fs.unlinkSync(mirrorTmp); } catch {}
          this.lastBackupError = `The local backup was saved, but its second copy failed: ${e.message}`;
        }
      }
      return { name, at: payload.exportedAt, rides: payload.history.length, reason, bytes: fs.statSync(target).size };
    } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  }
  readSnapshot(file) {
    const bytes = fs.readFileSync(file);
    if (bytes.length > MAX_BYTES) fail('Backup is too large.');
    const value = JSON.parse(zlib.gunzipSync(bytes, { maxOutputLength: MAX_BYTES * 3 }).toString('utf8'));
    return this.verifySnapshot(value);
  }
  verifySnapshot(value) {
    if (!value || value.app !== 'APEX VELO LAB') fail('Not an Apex backup.');
    const { storageBackup, ...payload } = value;
    if (storageBackup && (storageBackup.version !== 1 || crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex') !== storageBackup.checksum)) fail('Backup checksum failed. Nothing was restored.');
    validateRides(payload.history); validateSettings(payload.settings || {}); validateDbSettings(payload.dbSettings || []);
    if (payload.exportedAt && !Number.isFinite(Date.parse(payload.exportedAt))) fail('Invalid backup date.');
    return { payload, reason: storageBackup?.reason || 'legacy', verified: !!storageBackup };
  }
  /**
   * What the backup list and pruning need from a snapshot (date, counts, reason). A snapshot never changes
   * once written, so it is read and verified once and remembered by name, size and time - not gunzipped
   * and re-hashed on every save, which stalled the server (and the phone remote) on long histories.
   */
  snapshotInfo(file) {
    let st; try { st = fs.statSync(file); } catch { return { corrupt: true }; }
    const hit = this.snapshotCache.get(file);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.info;
    try { return this.rememberSnapshot(file, this.readSnapshot(file), st); }
    catch { return { corrupt: true }; }
  }
  rememberSnapshot(file, { payload, reason, verified }, st = fs.statSync(file)) {
    const info = { at: payload.exportedAt || st.mtime.toISOString(), rides: payload.history.length, profiles: payload.profiles?.length || 0,
      reason, verified, bytes: st.size };
    this.snapshotCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, info });
    return info;
  }
  importSnapshot(value) {
    const { payload } = this.verifySnapshot(value);
    return this.writeSnapshot({ ...payload, exportedAt: payload.exportedAt || this.clock().toISOString() }, 'imported');
  }
  backupFiles() {
    try { return fs.readdirSync(this.backupDir).filter(n => /^apex_\d{4}-\d{2}-\d{2}T[\w-]+\.json\.gz$/.test(n)).sort().reverse(); } catch { return []; }
  }
  backups() {
    const list = [];
    const add = (dir, name, legacy) => {
      const info = this.snapshotInfo(path.join(dir, name));
      list.push(info.corrupt ? { name: legacy ? 'legacy:' + name : name, corrupt: true, reason: 'Unreadable backup' } : { name: legacy ? 'legacy:' + name : name, ...info });
    };
    for (const n of this.backupFiles()) add(this.backupDir, n, false);
    if (this.legacyDir && fs.existsSync(this.legacyDir)) for (const n of fs.readdirSync(this.legacyDir).filter(n => /^apex_velo_backup_\d{4}-\d{2}-\d{2}_\d{6}\.json\.gz$/.test(n))) add(this.legacyDir, n, true);
    return { ok: true, dir: this.backupDir, error: this.lastBackupError, files: list.sort((a,b) => String(b.at || '').localeCompare(String(a.at || ''))) };
  }
  snapshotFile(name) {
    if (typeof name !== 'string') fail('Select a backup.');
    const legacy = name.startsWith('legacy:'); const raw = legacy ? name.slice(7) : name;
    const valid = legacy ? /^apex_velo_backup_\d{4}-\d{2}-\d{2}_\d{6}\.json\.gz$/ : /^apex_\d{4}-\d{2}-\d{2}T[\w-]+\.json\.gz$/;
    if (!valid.test(raw) || (legacy && !this.legacyDir)) fail('Invalid backup name.');
    return path.join(legacy ? this.legacyDir : this.backupDir, raw);
  }
  restore(input) {
    const replay = this.db.prepare('SELECT result FROM operations WHERE id=?').get(input.operationId);
    if (replay) return JSON.parse(replay.result);
    this.checkRevision(input);
    const { payload } = this.readSnapshot(this.snapshotFile(input.name));
    // A failed safety backup aborts the restore before any live data is changed.
    this.writeSnapshot(this.payload(), 'before-restore');
    return this.mutate(input, () => {
      this.applyRides(payload.history, [], { exact: true, replace: true });
      if (payload.settings) { this.db.exec('DELETE FROM settings'); this.applySettings(payload.settings); }
      else {
        const s = {};
        if (payload.profiles?.length) s.apex_velo_profiles = JSON.stringify(payload.profiles);
        if (payload.activeProfileId) s.apex_velo_active_prof_id = payload.activeProfileId;
        if (payload.workoutLibrary) s.apex_velo_saved_workouts = JSON.stringify(payload.workoutLibrary);
        if (payload.health) s.apex_health_v1 = JSON.stringify(payload.health);
        this.applySettings(s);
      }
      this.db.exec('DELETE FROM db_settings');
      for (const s of payload.dbSettings || []) this.db.prepare('INSERT INTO db_settings VALUES (?,?)').run(s.key, JSON.stringify(s));
      this.setMeta('initialized', 1);
    });
  }
  pruneBackups() {
    const files = this.backupFiles(), keep = new Set(files.slice(0, 14)), days = new Set(), weeks = new Set(), months = new Set();
    let migration = false, restoreCount = 0;
    for (const n of files) {
      const snap = this.snapshotInfo(path.join(this.backupDir, n));
      if (snap.corrupt) { keep.add(n); continue; }
      const d = new Date(snap.at), day = d.toISOString().slice(0,10), month = day.slice(0,7);
      const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); const week = monday.toISOString().slice(0,10);
      if (!days.has(day) && days.size < 30) { days.add(day); keep.add(n); }
      if (!weeks.has(week) && weeks.size < 12) { weeks.add(week); keep.add(n); }
      if (!months.has(month) && months.size < 12) { months.add(month); keep.add(n); }
      if (snap.reason === 'migration' && !migration) { migration = true; keep.add(n); }
      if (snap.reason === 'before-restore' && restoreCount++ < 5) keep.add(n);
    }
    for (const n of files) if (!keep.has(n)) { fs.unlinkSync(path.join(this.backupDir,n)); this.snapshotCache.delete(path.join(this.backupDir,n)); }
  }
  backup(reason = 'manual') { if (!this.initialized) fail('Open Apex to migrate your browser data first.', 409); return this.writeSnapshot(this.payload(), reason); }
  scheduleBackup() {
    clearTimeout(this.backupTimer);
    this.backupTimer = setTimeout(() => { try { this.backup('automatic'); } catch (e) { this.lastBackupError = e.message; this.scheduleBackup(); } }, 15000);
    this.backupTimer.unref();
  }
  startDailyBackups() {
    const check = () => { if (!this.initialized) return;
      const newest = this.backups().files.find(f => !f.corrupt && !f.name.startsWith('legacy:'));
      if (!newest || this.clock().getTime() - Date.parse(newest.at) >= 86400000) {
        try { this.backup('daily'); } catch(e) { this.lastBackupError = e.message; }
      }
    };
    check(); this.dailyTimer = setInterval(check, 3600000); this.dailyTimer.unref();
  }
  close() { clearTimeout(this.backupTimer); clearInterval(this.dailyTimer); this.db.close(); }
}
module.exports = { LocalStore, settingKey, dataDirectory, MAX_BYTES };
