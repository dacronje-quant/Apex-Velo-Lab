'use strict';
// Private local persistence. No browser, network, npm package or cloud service owns this file.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const VeloSync = require('../js/velo-sync.js');
const VeloHealth = require('../js/velo-health.js');
const { RideAnalyticsIndex } = require('./sqlite-analytics.cjs');
const RawHealth = require('./raw-health.cjs');
const MAX_BYTES = 200 * 1024 * 1024;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const sha256 = text => crypto.createHash('sha256').update(String(text)).digest('hex');
function computeRideHash(ride) {
  const metaHash = sha256(VeloSync.rideMetaJson(ride));
  const samplesHash = Array.isArray(ride.samples) && ride.samples.length ? sha256(JSON.stringify(ride.samples)) : '0';
  return VeloSync.formatRideHash(metaHash, samplesHash);
}
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
      if (version > 4) fail('This database needs a newer version of Apex. It has been left untouched.', 503);
      this.db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS rides (id TEXT PRIMARY KEY, json TEXT NOT NULL, position INTEGER NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0, content_hash TEXT);
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS db_settings (key TEXT PRIMARY KEY, json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, result TEXT NOT NULL, at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS sync_tombstones (kind TEXT NOT NULL, id TEXT NOT NULL, deleted_at INTEGER NOT NULL, PRIMARY KEY(kind, id));
        CREATE TABLE IF NOT EXISTS wellness_days (day TEXT NOT NULL, source TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day, source));`);
      for (const [table, col, def] of [
        ['rides', 'updated_at', 'INTEGER NOT NULL DEFAULT 0'],
        ['rides', 'content_hash', 'TEXT'],
        ['settings', 'updated_at', 'INTEGER NOT NULL DEFAULT 0'],
        ['wellness_days', 'updated_at', 'INTEGER NOT NULL DEFAULT 0']
      ]) {
        const cols = this.db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
        if (!cols.includes(col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
      }
      this.analytics = new RideAnalyticsIndex(this.db);
      this.analytics.initSchema();
      this.db.exec('PRAGMA user_version=4;');
      this.backfillSyncMetadata();
      this.analytics.syncAll();
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
  backfillSyncMetadata() {
    const now = this.clock().getTime();
    const staleRides = this.db.prepare('SELECT id, json FROM rides WHERE content_hash IS NULL OR updated_at=0').all();
    const staleSettings = this.db.prepare('SELECT key FROM settings WHERE updated_at=0').all();
    const appleCount = this.db.prepare("SELECT COUNT(*) AS n FROM wellness_days WHERE source='apple'").get().n;
    const rawHealth = !appleCount ? this.db.prepare("SELECT value, updated_at FROM settings WHERE key='apex_health_v1'").get() : null;
    if (!staleRides.length && !staleSettings.length && !rawHealth) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of staleRides) {
        const ride = JSON.parse(r.json);
        this.db.prepare('UPDATE rides SET updated_at=?, content_hash=? WHERE id=?').run(now, computeRideHash(ride), r.id);
      }
      for (const s of staleSettings) {
        this.db.prepare('UPDATE settings SET updated_at=? WHERE key=? AND updated_at=0').run(now, s.key);
      }
      if (rawHealth) {
        try {
          const parsed = JSON.parse(rawHealth.value);
          const days = parsed && parsed.days && typeof parsed.days === 'object' ? parsed.days : {};
          const at = rawHealth.updated_at || now;
          for (const [day, rec] of Object.entries(days)) {
            if (!DAY_RE.test(day) || !rec || typeof rec !== 'object') continue;
            const summary = rec.summary ? rec.summary : (() => { const s = VeloHealth.summarizeDay(day, rec); delete s.day; return s; })();
            if (!summary.hrvKind && summary.hrv !== null && summary.hrv !== undefined) summary.hrvKind = 'sdnn';
            this.db.prepare('INSERT OR IGNORE INTO wellness_days (day, source, json, updated_at) VALUES (?,?,?,?)')
              .run(day, 'apple', JSON.stringify({ summary, src: 'apple' }), at);
          }
        } catch { /* ignore unreadable legacy health blob */ }
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  applySettings(settings, { now } = {}) {
    validateSettings(settings);
    const ts = Number.isFinite(now) ? now : this.clock().getTime();
    for (const [k, v] of Object.entries(settings)) {
      if (v === null) {
        this.db.prepare('DELETE FROM settings WHERE key=?').run(k);
        if (VeloSync.isSyncedSetting(k)) this.db.prepare('INSERT OR REPLACE INTO sync_tombstones (kind, id, deleted_at) VALUES (?,?,?)').run('setting', k, ts);
      } else {
        const prev = this.db.prepare('SELECT value, updated_at FROM settings WHERE key=?').get(k);
        const at = prev && prev.value === v && prev.updated_at > 0 ? prev.updated_at : ts;
        this.db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)').run(k, v, at);
        this.db.prepare('DELETE FROM sync_tombstones WHERE kind=? AND id=?').run('setting', k);
      }
    }
    if (own(settings, 'apex_health_v1')) this.analytics.syncWellness();
  }
  applyRides(put, del = [], { exact = false, replace = false, now } = {}) {
    validateRides(put);
    if (!Array.isArray(del) || del.some(id => !['number', 'string'].includes(typeof id))) fail('Invalid deleted IDs.');
    const ts = Number.isFinite(now) ? now : this.clock().getTime();
    if (replace) { this.db.exec('DELETE FROM rides'); this.analytics.clearRides(); }
    for (const id of del) {
      this.db.prepare('DELETE FROM rides WHERE id=?').run(String(id));
      this.db.prepare('INSERT OR REPLACE INTO sync_tombstones (kind, id, deleted_at) VALUES (?,?,?)').run('ride', String(id), ts);
      this.analytics.deleteRide(String(id));
    }
    let position = Number(this.db.prepare('SELECT COALESCE(MAX(position),-1) AS n FROM rides').get().n) + 1;
    for (const ride of put) {
      const previous = this.db.prepare('SELECT json, position, updated_at, content_hash FROM rides WHERE id=?').get(String(ride.id));
      const old = previous ? JSON.parse(previous.json) : null;
      const value = !exact && !(ride.samples?.length) && old?.samples?.length ? { ...ride, samples: old.samples } : ride;
      const hash = computeRideHash(value);
      const at = previous && previous.content_hash === hash && previous.updated_at > 0 ? previous.updated_at : ts;
      this.db.prepare('INSERT OR REPLACE INTO rides (id, json, position, updated_at, content_hash) VALUES (?,?,?,?,?)')
        .run(String(ride.id), JSON.stringify(value), previous?.position ?? position++, at, hash);
      this.db.prepare('DELETE FROM sync_tombstones WHERE kind=? AND id=?').run('ride', String(ride.id));
      this.analytics.indexRide(value, hash);
    }
  }
  putWellnessDays(source, days, { now } = {}) {
    if (typeof source !== 'string' || !source.length || source.length > 100) fail('Invalid wellness source.');
    if (!days || typeof days !== 'object' || Array.isArray(days)) fail('Wellness days must be an object.');
    const ts = Number.isFinite(now) ? now : this.clock().getTime();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [day, data] of Object.entries(days)) {
        if (!DAY_RE.test(day)) fail('Invalid wellness day.');
        if (data === null) {
          this.db.prepare('DELETE FROM wellness_days WHERE day=? AND source=?').run(day, source);
          this.db.prepare('INSERT OR REPLACE INTO sync_tombstones (kind, id, deleted_at) VALUES (?,?,?)').run('wellness', `${source}:${day}`, ts);
        } else {
          const text = JSON.stringify(data);
          const prev = this.db.prepare('SELECT json, updated_at FROM wellness_days WHERE day=? AND source=?').get(day, source);
          const at = prev && prev.json === text && prev.updated_at > 0 ? prev.updated_at : ts;
          this.db.prepare('INSERT OR REPLACE INTO wellness_days (day, source, json, updated_at) VALUES (?,?,?,?)').run(day, source, text, at);
          this.db.prepare('DELETE FROM sync_tombstones WHERE kind=? AND id=?').run('wellness', `${source}:${day}`);
        }
      }
      this.analytics.syncWellness();
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  listWellnessDays({ from, to, source } = {}) {
    const where = [], params = [];
    if (from !== undefined) { where.push('day>=?'); params.push(String(from)); }
    if (to !== undefined) { where.push('day<=?'); params.push(String(to)); }
    if (source !== undefined) { where.push('source=?'); params.push(String(source)); }
    return this.db.prepare(`SELECT day, source, json, updated_at FROM wellness_days${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY day, source`)
      .all(...params).map(r => ({ day: r.day, source: r.source, data: JSON.parse(r.json), updatedAt: r.updated_at || 0 }));
  }
  syncManifest() {
    const rides = this.db.prepare('SELECT id, updated_at, content_hash FROM rides ORDER BY position, id').all()
      .map(r => ({ id: r.id, updatedAt: r.updated_at || 0, contentHash: r.content_hash || '' }));
    const settings = {};
    for (const r of this.db.prepare('SELECT key, value, updated_at FROM settings ORDER BY key').all()) {
      if (VeloSync.isSyncedSetting(r.key)) settings[r.key] = { updatedAt: r.updated_at || 0, hash: sha256(r.value) };
    }
    const wellness = this.db.prepare('SELECT day, source, json, updated_at FROM wellness_days ORDER BY day, source').all()
      .map(r => ({ day: r.day, source: r.source, updatedAt: r.updated_at || 0, hash: sha256(r.json) }));
    const tombstones = this.db.prepare('SELECT kind, id, deleted_at FROM sync_tombstones ORDER BY kind, id').all()
      .map(r => ({ kind: r.kind, id: r.id, deletedAt: r.deleted_at || 0 }));
    return { storeId: this.meta('storeId'), revision: this.revision, rides, settings, wellness, tombstones };
  }
  ridesByIds(ids = []) {
    const out = [];
    for (const id of ids) {
      const r = this.db.prepare('SELECT json, updated_at, content_hash FROM rides WHERE id=?').get(String(id));
      if (r) out.push({ ride: JSON.parse(r.json), updatedAt: r.updated_at || 0, contentHash: r.content_hash || '' });
    }
    return out;
  }
  settingsWithMeta(keys = null) {
    const out = {};
    const want = keys ? new Set(keys) : null;
    for (const r of this.db.prepare('SELECT key, value, updated_at FROM settings ORDER BY key').all()) {
      if (!VeloSync.isSyncedSetting(r.key)) continue;
      if (want && !want.has(r.key)) continue;
      out[r.key] = { value: r.value, updatedAt: r.updated_at || 0 };
    }
    return out;
  }
  wellnessByKeys(keys = []) {
    const out = [];
    for (const k of keys) {
      if (!k || !k.day || !k.source) continue;
      const r = this.db.prepare('SELECT day, source, json, updated_at FROM wellness_days WHERE day=? AND source=?').get(String(k.day), String(k.source));
      if (r) out.push({ day: r.day, source: r.source, data: JSON.parse(r.json), updatedAt: r.updated_at || 0 });
    }
    return out;
  }
  applySyncBatch({ putRides = [], delRideIds = [], putSettings = {}, delSettingKeys = [], putWellness = [], tombstones = [], now } = {}) {
    const ts = Number.isFinite(now) ? now : this.clock().getTime();
    let changed = false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of delRideIds) {
        const res = this.db.prepare('DELETE FROM rides WHERE id=?').run(String(id));
        if (res.changes > 0) changed = true;
        this.analytics.deleteRide(String(id));
      }
      let position = Number(this.db.prepare('SELECT COALESCE(MAX(position),-1) AS n FROM rides').get().n) + 1;
      for (const wrap of putRides) {
        const ride = wrap && wrap.ride ? wrap.ride : wrap;
        if (!ride || !ride.id) continue;
        validateRides([ride]);
        const id = String(ride.id);
        const previous = this.db.prepare('SELECT json, position, updated_at, content_hash FROM rides WHERE id=?').get(id);
        const old = previous ? JSON.parse(previous.json) : null;
        const value = !(ride.samples?.length) && old?.samples?.length ? { ...ride, samples: old.samples } : ride;
        const hash = computeRideHash(value);
        const at = Number(wrap.updatedAt) || ts;
        if (!previous || previous.content_hash !== hash || at > (previous.updated_at || 0)) {
          if (!previous || previous.content_hash !== hash) changed = true;
          this.db.prepare('INSERT OR REPLACE INTO rides (id, json, position, updated_at, content_hash) VALUES (?,?,?,?,?)')
            .run(id, JSON.stringify(value), previous?.position ?? position++, Math.max(at, previous?.updated_at || 0), hash);
          this.analytics.indexRide(value, hash);
        }
        this.db.prepare('DELETE FROM sync_tombstones WHERE kind=? AND id=?').run('ride', id);
      }
      for (const k of delSettingKeys) {
        if (!VeloSync.isSyncedSetting(k)) continue;
        const res = this.db.prepare('DELETE FROM settings WHERE key=?').run(k);
        if (res.changes > 0) changed = true;
      }
      for (const [k, entry] of Object.entries(putSettings)) {
        if (!VeloSync.isSyncedSetting(k) || !entry || entry.value === null || entry.value === undefined) continue;
        const val = String(entry.value), at = Number(entry.updatedAt) || ts;
        const prev = this.db.prepare('SELECT value, updated_at FROM settings WHERE key=?').get(k);
        if (!prev || prev.value !== val || at > (prev.updated_at || 0)) {
          if (!prev || prev.value !== val) changed = true;
          this.db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,?)').run(k, val, Math.max(at, prev?.updated_at || 0));
        }
        this.db.prepare('DELETE FROM sync_tombstones WHERE kind=? AND id=?').run('setting', k);
      }
      for (const w of putWellness) {
        if (!w || !DAY_RE.test(w.day || '') || !w.source || !w.data) continue;
        const json = JSON.stringify(w.data), at = Number(w.updatedAt) || ts;
        const prev = this.db.prepare('SELECT json, updated_at FROM wellness_days WHERE day=? AND source=?').get(w.day, w.source);
        if (!prev || prev.json !== json || at > (prev.updated_at || 0)) {
          if (!prev || prev.json !== json) changed = true;
          this.db.prepare('INSERT OR REPLACE INTO wellness_days (day, source, json, updated_at) VALUES (?,?,?,?)').run(w.day, w.source, json, Math.max(at, prev?.updated_at || 0));
        }
        this.db.prepare('DELETE FROM sync_tombstones WHERE kind=? AND id=?').run('wellness', `${w.source}:${w.day}`);
      }
      for (const t of tombstones) {
        if (!t || !t.kind || t.id === undefined || t.id === null) continue;
        const id = String(t.id), at = Number(t.deletedAt) || ts;
        const prev = this.db.prepare('SELECT deleted_at FROM sync_tombstones WHERE kind=? AND id=?').get(t.kind, id);
        if (!prev || at > prev.deleted_at) {
          this.db.prepare('INSERT OR REPLACE INTO sync_tombstones (kind, id, deleted_at) VALUES (?,?,?)').run(t.kind, id, at);
        }
        if (t.kind === 'wellness') {
          const idx = id.indexOf(':');
          if (idx > 0) {
            const src = id.slice(0, idx), day = id.slice(idx + 1);
            const r = this.db.prepare('DELETE FROM wellness_days WHERE day=? AND source=? AND updated_at<=?').run(day, src, at);
            if (r.changes > 0) changed = true;
          }
        }
      }
      if (!this.initialized && (putRides.length || Object.keys(putSettings).length || putWellness.length)) {
        this.setMeta('initialized', 1);
        changed = true;
      }
      if (changed) this.setMeta('revision', this.revision + 1);
      this.analytics.syncWellness();
      this.db.exec('COMMIT');
      if (changed) this.scheduleBackup();
      return { ok: true, changed, revision: this.revision, storeId: this.meta('storeId') };
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
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
  ingestHealthAutoExport(payload) {
    const parsed = RawHealth.parseHealthAutoExportPayload(payload);
    if (!parsed.readings.length && !parsed.sleepSessions.length) {
      return { readings: 0, sleepSessions: 0, metrics: [], touchedDays: 0 };
    }
    return this.analytics.ingestRawHealth(parsed, { transactional: true });
  }
  analyticsStatus() { return this.analytics.status(); }
  close() { clearTimeout(this.backupTimer); clearInterval(this.dailyTimer); this.db.close(); }
}
module.exports = { LocalStore, settingKey, dataDirectory, MAX_BYTES };
