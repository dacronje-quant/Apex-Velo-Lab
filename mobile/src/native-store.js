/**
 * Saved data on the phone: the desktop store (scripts/sqlite-store.cjs, served by server.js) ported to an
 * async SQLite driver, so js/velo-storage.js runs unchanged and SQLite owns saved data here as on the PC.
 *
 * `route()` answers the same /api/storage/* requests with the same response shapes as server.js. Every
 * request and every table API call runs one at a time: the phone has a single connection, and a read
 * between two statements of a write would otherwise see (and return) half-applied changes.
 *
 * Differences from the desktop store:
 *   - Ride samples are kept gzipped (base64 text) in their own column; a summary-only save reuses the
 *     stored column without unpacking it.
 *   - Recovery snapshots go to `files` (app-private storage on the phone) in the desktop format, so a
 *     phone snapshot restores on the PC and back. They are written and checked a ride at a time
 *     (src/native-snapshot.js), never as one string. There is no legacy folder or second copy.
 *   - Moving earlier data in is staged (migration_rides) so it survives the app being killed half-way
 *     (src/native-migrate.js drives it from the WebView storage); /migrate uses the same steps.
 *   - GET /api/storage answers the rides without samples (the app loads them per ride when a view needs
 *     them) and with `sampleSummary` (js/velo-ride-summary.js), made when a ride is written, or later in the
 *     background for rides saved before; the analytics across rides read that. GET /rides still answers
 *     every ride with its samples. Both come back as UTF-8 pieces, one per ride.
 *   - What each snapshot holds is remembered in the snapshots table, so a restart does not read and verify
 *     every snapshot again (the PC does that once per server start; the phone would on every app start).
 *   - The workstream tables import_jobs, import_files, sync_ledger and wellness_days, with a small API.
 *
 * db driver (all async): exec(sql) for statements without results, run(sql, params), all(sql, params) -> rows,
 * begin(), commit(), rollback(), close(). files: write(name, bytes), read(name) -> bytes, list() -> names,
 * append(name, bytes), stat(name) -> { size, mtimeMs } | null, rename(from, to), remove(name).
 */

import { Sha256, writeGzipFile, hashGzipFile } from './native-snapshot.js';

export const MAX_BYTES = 200 * 1024 * 1024;
/** What the snapshots may take together on the phone before the oldest kept copies go. */
export const BACKUP_BUDGET = 512 * 1024 * 1024;
export const SCHEMA_VERSION = 2; // 2: rides and migration_rides keep the ride's sample summary
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
export const settingKey = (k) => typeof k === 'string' && /^apex_[a-zA-Z0-9_:-]{1,180}$/.test(k) && !['apex_velo_history', 'apex_auto_backup', 'apex_sqlite_migration'].includes(k);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const SNAPSHOT_NAME = /^apex_\d{4}-\d{2}-\d{2}T[\w-]+\.json\.gz$/;

function validateRide(r, ids) {
  if (!r || typeof r !== 'object' || !['string', 'number'].includes(typeof r.id) || !String(r.id).length || !r.date || !Number.isFinite(Date.parse(r.date))) fail('A ride has no valid ID or date.');
  if (ids.has(String(r.id))) fail('Duplicate ride ID.');
  ids.add(String(r.id));
  if (own(r, 'samples') && r.samples !== null && !Array.isArray(r.samples)) fail('Ride samples must be a list.');
}
function validateRides(rides) {
  if (!Array.isArray(rides)) fail('Rides must be a list.');
  const ids = new Set();
  for (const r of rides) validateRide(r, ids);
}
function validateSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) fail('Settings must be an object.');
  for (const [k, v] of Object.entries(settings)) if (!settingKey(k) || (v !== null && typeof v !== 'string')) fail('Invalid setting.');
}
function validateDbSettings(settings) {
  if (!Array.isArray(settings) || settings.some((s) => !s || typeof s.key !== 'string' || !s.key.length || s.key.length > 250)) fail('Invalid restore points.');
}

// ------------------------------------------------------------------------------ bytes --
const encoder = new TextEncoder(), decoder = new TextDecoder();
export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(text) {
  const s = atob(text), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
async function pipe(bytes, transform, max = Infinity) {
  const reader = new Blob([bytes]).stream().pipeThrough(transform).getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { reader.cancel().catch(() => {}); fail('Backup is too large.'); }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
export const gzip = (bytes) => pipe(bytes, new CompressionStream('gzip'));
export const gunzip = (bytes, max) => pipe(bytes, new DecompressionStream('gzip'), max);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (text) => hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));

export const packSamples = async (samples) => toBase64(await gzip(encoder.encode(JSON.stringify(samples))));
export const unpackSamples = async (text) => JSON.parse(decoder.decode(await gunzip(fromBase64(text))));
/** A ride as the app holds it on the phone, without the summary the store adds (it is kept in its own column). */
const withoutSummary = (ride) => {
  if (!ride || typeof ride !== 'object' || !own(ride, 'sampleSummary')) return ride;
  const { sampleSummary: _, ...rest } = ride;
  return rest;
};
/** A rides row: the JSON with `samples: null` where the ride had its samples (so a read returns the same JSON), and the samples packed. */
async function encodeRide(ride) {
  if (Array.isArray(ride.samples) && ride.samples.length) return { json: JSON.stringify({ ...ride, samples: null }), packed: await packSamples(ride.samples), count: ride.samples.length };
  return { json: JSON.stringify(ride), packed: null, count: 0 };
}
/**
 * Settings with every lone UTF-16 surrogate replaced by U+FFFD. SQLite (and the plugin bridge) store text as
 * UTF-8, which cannot hold half a surrogate pair: the value would come back changed and the move's check
 * would fail on every start. Ride JSON is safe: JSON.stringify writes lone surrogates as \u escapes.
 */
export const wellFormedSettings = (settings) => Object.fromEntries(Object.entries(settings).map(([k, v]) =>
  [k, typeof v === 'string' ? v.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD') : v]));
/** SHA-256 of a ride's JSON, as stored with a staged ride: the WebView move skips rides staged unchanged. */
export const rideHash = (ride) => sha256(JSON.stringify(ride));

/**
 * JSON of `{ ...head, [key]: items, ...tail }` as pieces, one per item, without the closing brace (the
 * caller adds it, or more keys first). `onItem` sees each item before it is written.
 */
async function* jsonPieces(head, key, items, tail, onItem) {
  const open = JSON.stringify(head).slice(0, -1);
  yield `${open === '{' ? '{' : open + ','}${JSON.stringify(key)}:[`;
  let n = 0;
  for await (const item of items) {
    if (onItem) onItem(item);
    yield (n++ ? ',' : '') + JSON.stringify(item);
  }
  let rest = ']';
  for (const [k, v] of Object.entries(tail)) if (v !== undefined) rest += `,${JSON.stringify(k)}:${JSON.stringify(v)}`;
  yield rest;
}
/** An answer already serialized as UTF-8 pieces. */
class Chunks { constructor(list) { this.list = list; } }

const SCHEMA = `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS rides (id TEXT PRIMARY KEY, json TEXT NOT NULL, position INTEGER NOT NULL, samples_gz TEXT, sample_count INTEGER NOT NULL DEFAULT 0, summary TEXT, summary_v INTEGER);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS db_settings (key TEXT PRIMARY KEY, json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, result TEXT NOT NULL, at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS snapshots (name TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime REAL NOT NULL, info TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS migration_rides (id TEXT PRIMARY KEY, json TEXT NOT NULL, samples_gz TEXT, sample_count INTEGER NOT NULL DEFAULT 0, hash TEXT NOT NULL, summary TEXT, summary_v INTEGER);
  CREATE TABLE IF NOT EXISTS import_jobs (id TEXT PRIMARY KEY, source TEXT, status TEXT, total INT, done INT, skipped INT, errors INT, created_at TEXT, updated_at TEXT, cursor TEXT);
  CREATE TABLE IF NOT EXISTS import_files (job_id TEXT, path TEXT, hash TEXT, ride_id TEXT, status TEXT, error TEXT, PRIMARY KEY(job_id, path));
  CREATE INDEX IF NOT EXISTS import_files_hash ON import_files(hash);
  CREATE TABLE IF NOT EXISTS sync_ledger (ride_id TEXT, destination TEXT, external_id TEXT, content_hash TEXT, status TEXT, attempts INT, last_error TEXT, updated_at TEXT, PRIMARY KEY(ride_id, destination));
  CREATE TABLE IF NOT EXISTS wellness_days (day TEXT, source TEXT, json TEXT, PRIMARY KEY(day, source));`;

const str = (v) => (v === undefined || v === null ? null : String(v));
const int = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.trunc(Number(v)) : 0);
const needText = (v, what) => { if (typeof v !== 'string' || !v.length || v.length > 1000) fail(`Invalid ${what}.`); return v; };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const jobFromRow = (r) => r && { id: r.id, source: r.source, status: r.status, total: r.total, done: r.done, skipped: r.skipped, errors: r.errors,
  createdAt: r.created_at, updatedAt: r.updated_at, cursor: r.cursor === null ? null : JSON.parse(r.cursor) };
const fileFromRow = (r) => r && { jobId: r.job_id, path: r.path, hash: r.hash, rideId: r.ride_id, status: r.status, error: r.error };
const syncFromRow = (r) => r && { rideId: r.ride_id, destination: r.destination, externalId: r.external_id, contentHash: r.content_hash,
  status: r.status, attempts: r.attempts, lastError: r.last_error, updatedAt: r.updated_at };

export class NativeStore {
  /**
   * Use `await NativeStore.open({ db, files })`. `dir` and `file` are only shown to the rider (the
   * state response carries them, as on the PC). `backupDelayMs` is the pause after a save before the
   * automatic snapshot, and `backupBudgetBytes` bounds what the snapshots may take together (the newest three
   * and the migration copy are always kept). `summarize(ride)` makes a ride's sample summary (VeloRideSummary.of, from the page)
   * and `summaryVersion` is its version, or a function giving it (the page's scripts load after the store
   * opens); without them rides are kept without summaries.
   */
  constructor({ db, files, clock = () => new Date(), dir = 'app storage', file = 'apex.sqlite', backupDelayMs = 60000, backupBudgetBytes = BACKUP_BUDGET, summarize = null, summaryVersion = 0 } = {}) {
    this.db = db; this.files = files; this.clock = clock; this.dir = dir; this.file = file; this.backupDelayMs = backupDelayMs; this.backupBudgetBytes = backupBudgetBytes;
    this.summarize = summarize; this.summaryVersion = summaryVersion;
    this.backupDir = 'backups';
    this.snapshotCache = new Map();
    this.lastBackupError = null;
    this.queue = Promise.resolve();
  }
  get summaryVersion() { return this.versionOf(); }
  set summaryVersion(v) { this.versionOf = typeof v === 'function' ? v : () => v; }
  static async open(options) {
    const store = new NativeStore(options);
    await store.init();
    return store;
  }
  async init() {
    const d = this.db;
    try {
      // Android System WebView 80+ (any updated phone); older ones keep the WebView storage.
      if (typeof CompressionStream !== 'function' || typeof DecompressionStream !== 'function') fail('Update Android System WebView from Google Play to save rides in the phone database.', 503);
      try { await d.all('PRAGMA journal_mode=WAL'); } catch { /* not every driver can change it; FULL sync still applies */ }
      await d.exec('PRAGMA synchronous=FULL');
      const check = (await d.all('PRAGMA quick_check'))[0];
      if (!check || check.quick_check !== 'ok') fail('The local database failed its integrity check. It has been left untouched.', 503);
      const version = Number((await d.all('PRAGMA user_version'))[0]?.user_version || 0);
      if (version > SCHEMA_VERSION) fail('This database needs a newer version of Apex. It has been left untouched.', 503);
      await d.exec(SCHEMA);
      // Version 1 databases get the summary columns; their rides are summarized in the background.
      for (const table of ['rides', 'migration_rides']) {
        const columns = (await d.all(`PRAGMA table_info(${table})`)).map((c) => c.name);
        if (!columns.includes('summary')) await d.exec(`ALTER TABLE ${table} ADD COLUMN summary TEXT`);
        if (!columns.includes('summary_v')) await d.exec(`ALTER TABLE ${table} ADD COLUMN summary_v INTEGER`);
      }
      await d.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
      if (!await this.meta('storeId')) await this.setMeta('storeId', crypto.randomUUID());
      // A snapshot the app was killed while writing never got its name: remove the leftover.
      for (const name of await this.files.list().catch(() => [])) if (/\.json\.gz\.tmp$/.test(name)) await this.files.remove(name).catch(() => {});
    } catch (e) { try { await d.close(); } catch { /* already closed */ } throw e; }
  }
  /** Runs `fn` after every earlier request has finished; the only way in for other modules. */
  exclusive(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  // ------------------------------------------------------------------- reads --
  async meta(key) { return (await this.db.all('SELECT value FROM meta WHERE key=?', [key]))[0]?.value; }
  setMeta(key, value) { return this.db.run('INSERT OR REPLACE INTO meta VALUES (?,?)', [key, String(value)]); }
  async revision() { return Number(await this.meta('revision') || 0); }
  async initialized() { return await this.meta('initialized') === '1'; }
  async decodeRide(row) {
    const ride = JSON.parse(row.json);
    if (row.samples_gz !== null && row.samples_gz !== undefined) ride.samples = await unpackSamples(row.samples_gz);
    return ride;
  }
  /** Every ride in saved order with its samples, read 50 at a time so no plugin answer carries the whole history. */
  async *eachRide() {
    for (let offset = 0; ; offset += 50) {
      const rows = await this.db.all('SELECT json, samples_gz FROM rides ORDER BY position, id LIMIT 50 OFFSET ?', [offset]);
      for (const row of rows) yield this.decodeRide(row);
      if (rows.length < 50) return;
    }
  }
  async rides() {
    const out = [];
    for await (const ride of this.eachRide()) out.push(ride);
    return out;
  }
  async settings() { return Object.fromEntries((await this.db.all('SELECT key,value FROM settings ORDER BY key')).map((r) => [r.key, r.value])); }
  async dbSettings() { return (await this.db.all('SELECT json FROM db_settings ORDER BY key')).map((r) => JSON.parse(r.json)); }
  /**
   * Every ride in saved order as the app starts with it on the phone: without samples (loaded per ride when a
   * view needs them), with `sampleSummary` for the analytics across rides when it has been made.
   */
  async *eachRideSummary() {
    for (let offset = 0; ; offset += 200) {
      const rows = await this.db.all('SELECT json, sample_count, summary, summary_v FROM rides ORDER BY position, id LIMIT 200 OFFSET ?', [offset]);
      for (const row of rows) {
        const ride = JSON.parse(row.json);
        if (row.sample_count > 0 && ride.samples === null) delete ride.samples;
        if (row.summary && row.summary_v === this.summaryVersion) ride.sampleSummary = JSON.parse(row.summary);
        yield ride;
      }
      if (rows.length < 200) return;
    }
  }
  /** The summary column of a ride with samples (JSON text or null), from `summarize`; a failure leaves it to the backfill. */
  summaryOf(ride) {
    if (!this.summarize || !(Array.isArray(ride.samples) && ride.samples.length)) return { summary: null, v: null };
    try { const value = this.summarize(ride); return { summary: value ? JSON.stringify(value) : null, v: this.summaryVersion }; } catch { return { summary: null, v: null }; }
  }
  async stateParts() {
    return { head: { ok: true, initialized: await this.initialized(), revision: await this.revision(), storeId: await this.meta('storeId'), dir: this.dir, file: this.file },
      tail: { settings: await this.settings(), dbSettings: await this.dbSettings(), migratedAt: await this.meta('migratedAt') || null } };
  }
  /** One ride with its samples, or null (for the upload queue, which needs a single ride's samples). */
  ride(id) {
    return this.exclusive(async () => {
      const row = (await this.db.all('SELECT json, samples_gz FROM rides WHERE id=?', [String(id)]))[0];
      return row ? this.decodeRide(row) : null;
    });
  }
  /** What GET /api/storage answers: the rides without samples (see eachRideSummary). */
  async state() {
    const { head, tail } = await this.stateParts();
    const rides = [];
    for await (const ride of this.eachRideSummary()) rides.push(ride);
    return { ...head, rides, ...tail };
  }

  // -------------------------------------------------------- sample summaries --
  /** Rides with samples whose summary is missing or older than summaryVersion: [id], up to `limit`. */
  summariesNeeded(limit = 1000) {
    return this.exclusive(async () => (!this.summarize ? [] : (await this.db.all('SELECT id FROM rides WHERE sample_count > 0 AND (summary_v IS NULL OR summary_v <> ?) ORDER BY position, id LIMIT ?',
      [this.summaryVersion, limit])).map((r) => r.id)));
  }
  /** Makes and keeps one ride's summary (the background backfill); resolves to it, or null. Not a revision. */
  summarizeRide(id) {
    return this.exclusive(async () => {
      const row = (await this.db.all('SELECT json, samples_gz FROM rides WHERE id=?', [String(id)]))[0];
      if (!row || !this.summarize) return null;
      const { summary, v } = this.summaryOf(await this.decodeRide(row));
      await this.db.run('UPDATE rides SET summary=?, summary_v=? WHERE id=?', [summary, v ?? this.summaryVersion, String(id)]);
      return summary ? JSON.parse(summary) : null;
    });
  }
  /** The current summaries of these rides: { id: summary } (rides without one are left out). */
  summaries(ids) {
    return this.exclusive(async () => {
      const out = {};
      for (let i = 0; i < ids.length; i += 200) {
        const part = ids.slice(i, i + 200).map(String);
        for (const r of await this.db.all(`SELECT id, summary FROM rides WHERE summary_v=? AND summary IS NOT NULL AND id IN (${part.map(() => '?').join(',')})`, [this.summaryVersion, ...part])) out[r.id] = JSON.parse(r.summary);
      }
      return out;
    });
  }
  /**
   * The app's JSON backup (History > Export) with every ride's samples, as UTF-8 pieces: `head` and `tail` are
   * the backup's other keys, before and after `history`. The app holds its rides without samples on the phone.
   */
  exportChunks(head, tail) {
    return this.exclusive(async () => {
      const list = [];
      for await (const piece of jsonPieces(head, 'history', this.eachRide(), tail)) list.push(encoder.encode(piece));
      list.push(encoder.encode('}'));
      return list;
    });
  }

  // ------------------------------------------------------------------ writes --
  async checkRevision(input) {
    if (!Number.isSafeInteger(input.revision) || input.revision !== await this.revision()) fail('Another tab changed the saved data. Reload this tab before saving again; its recovery copy is retained.', 409);
  }
  async replayed(operationId) {
    const previous = (await this.db.all('SELECT result FROM operations WHERE id=?', [operationId]))[0];
    return previous ? JSON.parse(previous.result) : null;
  }
  async mutate(input, fn) {
    if (!input || !/^[a-zA-Z0-9_-]{12,100}$/.test(input.operationId || '')) fail('Missing save operation ID.');
    const previous = await this.replayed(input.operationId);
    if (previous) return previous;
    const d = this.db;
    await d.begin();
    let result;
    try {
      await this.checkRevision(input); await fn();
      const revision = await this.revision() + 1;
      await this.setMeta('revision', revision);
      result = { ok: true, revision, storeId: await this.meta('storeId') };
      await d.run('INSERT INTO operations VALUES (?,?,?)', [input.operationId, JSON.stringify(result), this.clock().getTime()]);
      await d.run('DELETE FROM operations WHERE rowid NOT IN (SELECT rowid FROM operations ORDER BY rowid DESC LIMIT 1000)');
      await d.commit();
    } catch (e) { await d.rollback().catch(() => {}); throw e; }
    this.scheduleBackup();
    return result;
  }
  async applySettings(settings) {
    validateSettings(settings);
    for (const [k, v] of Object.entries(settings)) {
      if (v === null) await this.db.run('DELETE FROM settings WHERE key=?', [k]);
      else await this.db.run('INSERT OR REPLACE INTO settings VALUES (?,?)', [k, v]);
    }
  }
  async putDbSettings(list) {
    for (const s of list) await this.db.run('INSERT OR REPLACE INTO db_settings VALUES (?,?)', [s.key, JSON.stringify(s)]);
  }
  async applyRides(put, del = [], { exact = false, replace = false } = {}) {
    put = Array.isArray(put) ? put.map(withoutSummary) : put;
    validateRides(put);
    if (!Array.isArray(del) || del.some((id) => !['number', 'string'].includes(typeof id))) fail('Invalid deleted IDs.');
    const d = this.db;
    if (replace) await d.run('DELETE FROM rides');
    for (const id of del) await d.run('DELETE FROM rides WHERE id=?', [String(id)]);
    let position = Number((await d.all('SELECT COALESCE(MAX(position),-1) AS n FROM rides'))[0].n) + 1;
    for (const ride of put) {
      const previous = (await d.all('SELECT position, samples_gz, sample_count, summary, summary_v FROM rides WHERE id=?', [String(ride.id)]))[0];
      // A summary-only save keeps the stored samples (as the desktop store does), still packed, and their summary.
      const keep = !exact && !(ride.samples?.length) && previous?.sample_count > 0;
      const { json, packed, count } = keep ? { json: JSON.stringify({ ...ride, samples: null }), packed: previous.samples_gz, count: previous.sample_count } : await encodeRide(ride);
      const { summary, v } = keep ? { summary: previous.summary, v: previous.summary_v } : this.summaryOf(ride);
      await d.run('INSERT OR REPLACE INTO rides (id, json, position, samples_gz, sample_count, summary, summary_v) VALUES (?,?,?,?,?,?,?)',
        [String(ride.id), json, previous ? previous.position : position++, packed, count, summary, v]);
    }
  }
  /** The desktop /migrate request: staged a few rides at a time, then committed as one change. */
  async migrate(input) {
    validateRides(input.rides); validateSettings(input.settings); validateDbSettings(input.dbSettings || []);
    const replay = await this.replayed(input.operationId);
    if (replay) return replay;
    await this.checkRevision(input);
    if (await this.initialized()) fail('This phone already has saved data. Reload to use it.', 409);
    for (let i = 0; i < input.rides.length; i += 20) await this.stageRides(input.rides.slice(i, i + 20));
    return this.completeMigration({ ...input, order: input.rides.map((r) => String(r.id)) });
  }
  /**
   * Moving earlier data in, in steps that survive the app being killed. Rides are staged (migration_rides) a
   * batch per transaction, each one read back, unpacked and compared as soon as it is written, so checking
   * never needs more than one ride in memory. Nothing is visible until completeMigration commits.
   */
  async stageRides(rides) {
    rides = Array.isArray(rides) ? rides.map(withoutSummary) : rides;
    validateRides(rides);
    await this.transaction(async () => {
      for (const ride of rides) {
        const id = String(ride.id), text = JSON.stringify(ride), { json, packed, count } = await encodeRide(ride);
        const { summary, v } = this.summaryOf(ride);
        await this.db.run('INSERT OR REPLACE INTO migration_rides (id, json, samples_gz, sample_count, hash, summary, summary_v) VALUES (?,?,?,?,?,?,?)',
          [id, json, packed, count, await sha256(text), summary, v]);
        const row = (await this.db.all('SELECT json, samples_gz FROM migration_rides WHERE id=?', [id]))[0];
        if (JSON.stringify(await this.decodeRide(row)) !== text) fail('Migration verification failed.', 500);
      }
    });
  }
  async *eachStaged(order) {
    for (const id of order) yield this.decodeRide((await this.db.all('SELECT json, samples_gz FROM migration_rides WHERE id=?', [id]))[0]);
  }
  /**
   * Commits a staged move: `order` lists every ride ID in saved order. A verified snapshot of the moved data
   * is written first (from the staged rides, one at a time); then rides, settings and restore points go live
   * in one transaction, compared again in SQL before COMMIT.
   */
  async completeMigration(input) {
    validateSettings(input.settings); validateDbSettings(input.dbSettings || []);
    input = { ...input, settings: wellFormedSettings(input.settings) };
    const order = input.order;
    if (!Array.isArray(order) || order.some((id) => typeof id !== 'string') || new Set(order).size !== order.length) fail('Invalid ride order.');
    const replay = await this.replayed(input.operationId);
    if (replay) return replay;
    await this.checkRevision(input);
    if (await this.initialized()) fail('This phone already has saved data. Reload to use it.', 409);
    const staged = new Set((await this.db.all('SELECT id FROM migration_rides')).map((r) => r.id));
    if (order.some((id) => !staged.has(id))) fail('Not every ride has been moved yet.', 409);
    await this.writeSnapshot({ head: { app: 'APEX VELO LAB', exportedAt: this.clock().toISOString() }, history: this.eachStaged(order),
      tail: { settings: input.settings, dbSettings: input.dbSettings || [], profiles: JSON.parse(input.settings.apex_velo_profiles || '[]') } }, 'migration');
    return this.mutate(input, async () => {
      await this.db.run('DELETE FROM rides');
      for (const [position, id] of order.entries()) await this.db.run('INSERT INTO rides (id, json, position, samples_gz, sample_count, summary, summary_v) SELECT id, json, ?, samples_gz, sample_count, summary, summary_v FROM migration_rides WHERE id=?', [position, id]);
      await this.applySettings(input.settings); await this.putDbSettings(input.dbSettings || []);
      await this.setMeta('initialized', 1); await this.setMeta('migratedAt', this.clock().toISOString());
      const same = Number((await this.db.all('SELECT COUNT(*) AS n FROM rides r JOIN migration_rides m ON m.id=r.id AND m.json=r.json AND m.samples_gz IS r.samples_gz AND m.sample_count=r.sample_count'))[0].n);
      const total = Number((await this.db.all('SELECT COUNT(*) AS n FROM rides'))[0].n);
      const savedSettings = await this.settings(), wantedSettings = Object.entries(input.settings).filter(([, v]) => v !== null);
      const restorePoints = new Map((await this.dbSettings()).map((s) => [s.key, JSON.stringify(s)]));
      if (same !== order.length || total !== order.length || Object.keys(savedSettings).length !== wantedSettings.length
        || wantedSettings.some(([k, v]) => savedSettings[k] !== v) || restorePoints.size !== (input.dbSettings || []).length
        || (input.dbSettings || []).some((s) => restorePoints.get(s.key) !== JSON.stringify(s))) fail('Migration verification failed.', 500);
      await this.db.run('DELETE FROM migration_rides');
    });
  }
  /** For the WebView move: what is staged already ({ id: SHA-256 of the ride's JSON }), so a restart skips it. */
  migrationStaged() {
    return this.exclusive(async () => Object.fromEntries((await this.db.all('SELECT id, hash FROM migration_rides')).map((r) => [r.id, r.hash])));
  }
  stageMigration(rides) { return this.exclusive(() => this.stageRides(rides)); }
  finishMigration(input) { return this.exclusive(() => this.completeMigration(input)); }
  async update(input) {
    if (!await this.initialized()) fail('Finish migration before saving.', 409);
    return this.mutate(input, async () => {
      if (input.put !== undefined || input.del !== undefined || input.clear) await this.applyRides(input.put || [], input.del || [], { exact: !!input.exact, replace: !!input.clear });
      if (input.order) {
        if (!Array.isArray(input.order) || input.order.some((id) => !['number', 'string'].includes(typeof id))) fail('Invalid ride order.');
        for (const [position, id] of input.order.entries()) await this.db.run('UPDATE rides SET position=? WHERE id=?', [position, String(id)]);
      }
      if (input.settings) await this.applySettings(input.settings);
      if (input.dbPut) { validateDbSettings(input.dbPut); await this.putDbSettings(input.dbPut); }
      if (input.dbDelete) {
        if (!Array.isArray(input.dbDelete) || input.dbDelete.some((k) => typeof k !== 'string')) fail('Invalid restore point deletion.');
        for (const k of input.dbDelete) await this.db.run('DELETE FROM db_settings WHERE key=?', [k]);
      }
    });
  }

  // ------------------------------------------------------------- snapshots --
  /** The desktop backup payload as the keys before history, the rides (read as they are written) and the keys after. */
  async payloadParts() {
    const s = await this.settings();
    const parse = (k, fallback) => { try { return JSON.parse(s[k] || 'null') ?? fallback; } catch { return fallback; } };
    return { head: { app: 'APEX VELO LAB', exportedAt: this.clock().toISOString(), profiles: parse('apex_velo_profiles', []),
      activeProfileId: s.apex_velo_active_prof_id || null, workoutLibrary: parse('apex_velo_saved_workouts', []), health: parse('apex_health_v1', null) },
    history: this.eachRide(), tail: { settings: s, dbSettings: await this.dbSettings() } };
  }
  /**
   * Writes a snapshot in the desktop format (gzip of the payload plus storageBackup with its SHA-256) from
   * { head, history, tail }, one ride at a time. The file is checked by decompressing it again and comparing
   * hashes before it gets its final name.
   */
  async writeSnapshot({ head, history, tail = {} }, reason = 'automatic') {
    const all = { ...head, ...tail };
    validateSettings(all.settings || {}); validateDbSettings(all.dbSettings || []);
    const name = `apex_${this.clock().toISOString().replace(/[:.]/g, '-')}_${randomHex(4)}.json.gz`, tmp = name + '.tmp';
    const ids = new Set(), checksum = new Sha256();
    let rides = 0;
    try {
      const written = await writeGzipFile(this.files, tmp, async (write) => {
        for await (const piece of jsonPieces(head, 'history', history, tail, (r) => { validateRide(r, ids); rides++; })) {
          const bytes = encoder.encode(piece);
          checksum.update(bytes); await write(bytes);
        }
        // The checksum covers the payload, closed here; the file goes on with storageBackup.
        const sum = checksum.update(encoder.encode('}')).hex();
        await write(encoder.encode(`,"storageBackup":${JSON.stringify({ version: 1, checksum: sum, reason })}}`));
      });
      if (await hashGzipFile(this.files, tmp, MAX_BYTES * 3) !== written.hash) fail('The backup could not be read back. It was not kept.', 500);
      await this.files.rename(tmp, name);
      await this.rememberSnapshot(name, { at: all.exportedAt, rides, profiles: all.profiles?.length || 0, reason, verified: true });
      await this.pruneBackups();
      this.lastBackupError = null;
      return { name, at: all.exportedAt, rides, reason, bytes: written.bytes };
    } catch (e) { try { await this.files.remove(tmp); } catch { /* never written */ } throw e; }
  }
  async readSnapshot(name) {
    const bytes = await this.files.read(name);
    if (bytes.length > MAX_BYTES) fail('Backup is too large.');
    const value = JSON.parse(decoder.decode(await gunzip(bytes, MAX_BYTES * 3)));
    return this.verifySnapshot(value);
  }
  async verifySnapshot(value) {
    if (!value || value.app !== 'APEX VELO LAB') fail('Not an Apex backup.');
    const { storageBackup, ...payload } = value;
    if (storageBackup && (storageBackup.version !== 1 || await sha256(JSON.stringify(payload)) !== storageBackup.checksum)) fail('Backup checksum failed. Nothing was restored.');
    validateRides(payload.history); validateSettings(payload.settings || {}); validateDbSettings(payload.dbSettings || []);
    if (payload.exportedAt && !Number.isFinite(Date.parse(payload.exportedAt))) fail('Invalid backup date.');
    return { payload, reason: storageBackup?.reason || 'legacy', verified: !!storageBackup };
  }
  /** A snapshot never changes once written: read and verify it once, then remember it by name, size and time. */
  async snapshotInfo(name) {
    const st = await this.files.stat(name).catch(() => null);
    if (!st) return { corrupt: true };
    let hit = this.snapshotCache.get(name);
    if (!hit) {
      const row = (await this.db.all('SELECT size, mtime, info FROM snapshots WHERE name=?', [name]))[0];
      if (row) this.snapshotCache.set(name, hit = { size: row.size, mtimeMs: row.mtime, info: JSON.parse(row.info) });
    }
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.info;
    try {
      const { payload, reason, verified } = await this.readSnapshot(name);
      return await this.rememberSnapshot(name, { at: payload.exportedAt, rides: payload.history.length, profiles: payload.profiles?.length || 0, reason, verified }, st);
    } catch { return { corrupt: true }; }
  }
  async rememberSnapshot(name, { at, rides, profiles, reason, verified }, st) {
    st = st || await this.files.stat(name);
    const info = { at: at || new Date(st.mtimeMs).toISOString(), rides, profiles, reason, verified, bytes: st.size };
    this.snapshotCache.set(name, { size: st.size, mtimeMs: st.mtimeMs, info });
    await this.db.run('INSERT OR REPLACE INTO snapshots VALUES (?,?,?,?)', [name, st.size, st.mtimeMs, JSON.stringify(info)]);
    return info;
  }
  async importSnapshot(value) {
    const { payload } = await this.verifySnapshot(value);
    const head = {}, tail = {};
    let after = false;
    for (const [k, v] of Object.entries({ ...payload, exportedAt: payload.exportedAt || this.clock().toISOString() })) {
      if (k === 'history') after = true;
      else (after ? tail : head)[k] = v;
    }
    return this.writeSnapshot({ head, history: payload.history, tail }, 'imported');
  }
  async backupFiles() {
    try { return (await this.files.list()).filter((n) => SNAPSHOT_NAME.test(n)).sort().reverse(); } catch { return []; }
  }
  async backups() {
    const list = [];
    for (const name of await this.backupFiles()) {
      const info = await this.snapshotInfo(name);
      list.push(info.corrupt ? { name, corrupt: true, reason: 'Unreadable backup' } : { name, ...info });
    }
    return { ok: true, dir: this.backupDir, error: this.lastBackupError, files: list.sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))) };
  }
  snapshotFile(name) {
    if (typeof name !== 'string') fail('Select a backup.');
    if (!SNAPSHOT_NAME.test(name)) fail('Invalid backup name.');
    return name;
  }
  async restore(input) {
    const replay = await this.replayed(input.operationId);
    if (replay) return replay;
    await this.checkRevision(input);
    const { payload } = await this.readSnapshot(this.snapshotFile(input.name));
    // A failed safety backup aborts the restore before any live data is changed.
    await this.writeSnapshot(await this.payloadParts(), 'before-restore');
    return this.mutate(input, async () => {
      await this.applyRides(payload.history, [], { exact: true, replace: true });
      if (payload.settings) { await this.db.run('DELETE FROM settings'); await this.applySettings(payload.settings); }
      else {
        const s = {};
        if (payload.profiles?.length) s.apex_velo_profiles = JSON.stringify(payload.profiles);
        if (payload.activeProfileId) s.apex_velo_active_prof_id = payload.activeProfileId;
        if (payload.workoutLibrary) s.apex_velo_saved_workouts = JSON.stringify(payload.workoutLibrary);
        if (payload.health) s.apex_health_v1 = JSON.stringify(payload.health);
        await this.applySettings(s);
      }
      await this.db.run('DELETE FROM db_settings');
      await this.putDbSettings(payload.dbSettings || []);
      await this.setMeta('initialized', 1);
    });
  }
  /**
   * Keeps the 14 newest snapshots, one a day for 30 days, a week for 12 weeks and a month for 12 months, the
   * migration copy and the last 5 before-restore copies; then, past `backupBudgetBytes`, drops the oldest of
   * those first, never the newest three readable copies or the migration copy. Files are newest first by name.
   */
  async pruneBackups() {
    const files = await this.backupFiles(), keep = new Set(files.slice(0, 14)), days = new Set(), weeks = new Set(), months = new Set();
    const infos = new Map();
    let migration = null, restoreCount = 0;
    for (const n of files) {
      const snap = await this.snapshotInfo(n);
      infos.set(n, snap);
      if (snap.corrupt) { keep.add(n); continue; }
      const d = new Date(snap.at), day = d.toISOString().slice(0, 10), month = day.slice(0, 7);
      const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); const week = monday.toISOString().slice(0, 10);
      if (!days.has(day) && days.size < 30) { days.add(day); keep.add(n); }
      if (!weeks.has(week) && weeks.size < 12) { weeks.add(week); keep.add(n); }
      if (!months.has(month) && months.size < 12) { months.add(month); keep.add(n); }
      if (snap.reason === 'migration' && !migration) { migration = n; keep.add(n); }
      if (snap.reason === 'before-restore' && restoreCount++ < 5) keep.add(n);
    }
    const protect = new Set(files.filter((n) => !infos.get(n).corrupt).slice(0, 3));
    if (migration) protect.add(migration);
    const size = async (n) => infos.get(n).bytes ?? ((await this.files.stat(n).catch(() => null))?.size || 0);
    let total = 0;
    for (const n of keep) total += await size(n);
    for (const n of [...files].reverse()) {
      if (total <= this.backupBudgetBytes) break;
      if (keep.has(n) && !protect.has(n)) { keep.delete(n); total -= await size(n); }
    }
    for (const n of files) {
      if (keep.has(n)) continue;
      await this.files.remove(n); this.snapshotCache.delete(n);
      await this.db.run('DELETE FROM snapshots WHERE name=?', [n]);
    }
    // Pieces of a snapshot the app was closed while writing (writes run one at a time, so none is in progress).
    for (const n of await this.files.list().catch(() => [])) if (/\.json\.gz\.tmp$/.test(n)) await this.files.remove(n).catch(() => {});
  }
  /** Writes a snapshot of the live data and remembers the revision it holds (checkDailyBackup compares it). */
  async backup(reason = 'manual') {
    if (!await this.initialized()) fail('Open Apex to migrate your browser data first.', 409);
    const revision = await this.revision();
    const result = await this.writeSnapshot(await this.payloadParts(), reason);
    await this.setMeta('backupRevision', revision);
    return result;
  }
  /** An automatic snapshot `backupDelayMs` after the last save (saves in a burst make one). */
  scheduleBackup() {
    clearTimeout(this.backupTimer);
    this.backupPending = true;
    this.backupTimer = setTimeout(() => { this.runScheduledBackup(); }, this.backupDelayMs);
    this.backupTimer?.unref?.();
  }
  runScheduledBackup() {
    clearTimeout(this.backupTimer);
    this.backupPending = false;
    return this.exclusive(() => this.backup('automatic')).catch((e) => { this.lastBackupError = e.message; this.scheduleBackup(); });
  }
  /** Writes the pending automatic snapshot now (the app is going to the background, where Android may close it). */
  flushBackup() { return this.backupPending ? this.runScheduledBackup() : Promise.resolve(); }
  /**
   * A snapshot when there is no readable one, the newest is a day old, or the data changed since the last one
   * (an automatic snapshot the app was closed before), so every saved ride reaches a backup.
   */
  async checkDailyBackup() {
    if (!await this.initialized()) return;
    const newest = (await this.backups()).files.find((f) => !f.corrupt);
    const old = !newest || this.clock().getTime() - Date.parse(newest.at) >= 86400000;
    // A change the pending automatic snapshot will cover is left to it (a closed app has none pending).
    const changed = !this.backupPending && Number(await this.meta('backupRevision') ?? -1) !== await this.revision();
    if (old || changed) {
      try { await this.backup(old ? 'daily' : 'automatic'); } catch (e) { this.lastBackupError = e.message; }
    }
  }
  checkBackup() { return this.exclusive(() => this.checkDailyBackup()); }
  /** Checks now (or after `firstCheckMs`, to keep the app start quick) and then every hour. */
  startDailyBackups(firstCheckMs = 0) {
    const check = () => this.checkBackup();
    clearInterval(this.dailyTimer); clearTimeout(this.firstDailyTimer);
    this.dailyTimer = setInterval(check, 3600000);
    this.dailyTimer?.unref?.();
    if (!firstCheckMs) return check();
    this.firstDailyTimer = setTimeout(() => check().catch(() => {}), firstCheckMs);
    this.firstDailyTimer?.unref?.();
    return Promise.resolve();
  }
  async close() {
    clearTimeout(this.backupTimer); clearInterval(this.dailyTimer); clearTimeout(this.firstDailyTimer);
    await this.exclusive(() => this.db.close());
  }

  // ------------------------------------------------------------------ routes --
  /**
   * Answers /api/storage/* like server.js: resolves to { status, body }, or { status, chunks } (UTF-8 pieces of
   * the JSON, one per ride) for the two answers that carry every ride, so the whole history is never one string.
   */
  route(pathname, method, bodyText = '') {
    return this.exclusive(async () => {
      try {
        const answer = await this.answer(pathname, method, bodyText);
        return answer instanceof Chunks ? { status: 200, chunks: answer.list } : { status: 200, body: answer };
      } catch (e) { return { status: e.status || 503, body: { error: e.message } }; }
    });
  }
  async chunks(head, items, tail) {
    const list = [];
    for await (const piece of jsonPieces(head, 'rides', items, tail)) list.push(encoder.encode(piece));
    list.push(encoder.encode('}'));
    return new Chunks(list);
  }
  async answer(pathname, method, bodyText) {
    if (method === 'GET') {
      if (pathname === '/api/storage') { const { head, tail } = await this.stateParts(); return this.chunks(head, this.eachRideSummary(), tail); }
      if (pathname === '/api/storage/rides') return this.chunks({ ok: true }, this.eachRide(), { revision: await this.revision() });
      if (pathname === '/api/storage/db-settings') return { ok: true, settings: await this.dbSettings(), revision: await this.revision() };
      if (pathname === '/api/storage/backups') return this.backups();
      fail('Not found', 404);
    }
    if (method !== 'POST') fail('Method not allowed', 405);
    let input;
    try { input = JSON.parse(bodyText); } catch { fail('Invalid JSON.'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Invalid request.');
    if (pathname === '/api/storage/migrate') return this.migrate(input);
    if (pathname === '/api/storage/save') return this.update(input);
    if (pathname === '/api/storage/backup') return { ok: true, ...await this.backup() };
    if (pathname === '/api/storage/import-backup') return { ok: true, ...await this.importSnapshot(input.backup) };
    if (pathname === '/api/storage/preview') {
      const { payload, reason, verified } = await this.readSnapshot(this.snapshotFile(input.name));
      return { ok: true, name: input.name, at: payload.exportedAt, rides: payload.history.length,
        samples: payload.history.reduce((n, r) => n + (r.samples?.length || 0), 0), profiles: payload.profiles?.length || 0,
        reason, verified, settings: Object.keys(payload.settings || {}).length };
    }
    if (pathname === '/api/storage/restore') return this.restore(input);
    fail('Not found', 404);
  }


  // ------------------------------------------------------ workstream tables --
  // Import jobs, the files of each job, the outbound sync ledger and wellness days. They are not part of
  // the ride revision (a job's progress never makes another tab reload) and not in snapshots yet.
  async transaction(fn) {
    await this.db.begin();
    try { const r = await fn(); await this.db.commit(); return r; } catch (e) { await this.db.rollback().catch(() => {}); throw e; }
  }
  /** Creates or updates an import job; fields left out keep their stored value. Resolves to the saved job. */
  putImportJob(job) {
    return this.exclusive(() => this.transaction(async () => {
      const id = needText(job && job.id, 'import job ID');
      const old = jobFromRow((await this.db.all('SELECT * FROM import_jobs WHERE id=?', [id]))[0]) || {};
      const now = this.clock().toISOString();
      const v = { ...old, ...job, id, createdAt: old.createdAt || job.createdAt || now, updatedAt: now };
      await this.db.run('INSERT OR REPLACE INTO import_jobs VALUES (?,?,?,?,?,?,?,?,?,?)', [id, str(v.source), str(v.status), int(v.total), int(v.done),
        int(v.skipped), int(v.errors), v.createdAt, v.updatedAt, v.cursor === undefined || v.cursor === null ? null : JSON.stringify(v.cursor)]);
      return jobFromRow((await this.db.all('SELECT * FROM import_jobs WHERE id=?', [id]))[0]);
    }));
  }
  getImportJob(id) {
    return this.exclusive(async () => jobFromRow((await this.db.all('SELECT * FROM import_jobs WHERE id=?', [String(id)]))[0]) || null);
  }
  listImportJobs({ status } = {}) {
    return this.exclusive(async () => (status ? await this.db.all('SELECT * FROM import_jobs WHERE status=? ORDER BY created_at, id', [status])
      : await this.db.all('SELECT * FROM import_jobs ORDER BY created_at, id')).map(jobFromRow));
  }
  /** Deletes a job and its file list. */
  deleteImportJob(id) {
    return this.exclusive(() => this.transaction(async () => {
      await this.db.run('DELETE FROM import_files WHERE job_id=?', [String(id)]);
      await this.db.run('DELETE FROM import_jobs WHERE id=?', [String(id)]);
    }));
  }
  /** Adds or updates files of a job ({ path, hash, rideId, status, error }), all or none. */
  putImportFiles(jobId, list) {
    return this.exclusive(() => this.transaction(async () => {
      needText(jobId, 'import job ID');
      if (!Array.isArray(list)) fail('Import files must be a list.');
      for (const f of list) {
        const path = needText(f && f.path, 'import file path');
        const old = fileFromRow((await this.db.all('SELECT * FROM import_files WHERE job_id=? AND path=?', [jobId, path]))[0]) || {};
        const v = { ...old, ...f };
        await this.db.run('INSERT OR REPLACE INTO import_files VALUES (?,?,?,?,?,?)', [jobId, path, str(v.hash), str(v.rideId), str(v.status), str(v.error)]);
      }
    }));
  }
  /** Deletes files of a job by path (rows of files that are gone), all or none. */
  deleteImportFiles(jobId, paths) {
    return this.exclusive(() => this.transaction(async () => {
      for (const p of paths) await this.db.run('DELETE FROM import_files WHERE job_id=? AND path=?', [String(jobId), String(p)]);
    }));
  }
  listImportFiles(jobId, { status } = {}) {
    return this.exclusive(async () => (status ? await this.db.all('SELECT * FROM import_files WHERE job_id=? AND status=? ORDER BY path', [String(jobId), status])
      : await this.db.all('SELECT * FROM import_files WHERE job_id=? ORDER BY path', [String(jobId)])).map(fileFromRow));
  }
  /** The file already imported with this SHA-256 (any job), for dedupe; null if none. */
  findImportFileByHash(hash) {
    return this.exclusive(async () => fileFromRow((await this.db.all('SELECT * FROM import_files WHERE hash=? AND ride_id IS NOT NULL ORDER BY job_id, path LIMIT 1', [String(hash)]))[0]) || null);
  }
  /**
   * Records an upload result ({ rideId, destination, externalId, contentHash, status, attempts, lastError }); fields
   * left out keep their stored value, or take `defaults` when the entry is new.
   */
  putSyncEntry(entry, defaults = {}) {
    return this.exclusive(() => this.transaction(async () => {
      if (!entry || typeof entry !== 'object') fail('Invalid sync entry.');
      const rideId = needText(entry.rideId === undefined || entry.rideId === null ? undefined : String(entry.rideId), 'ride ID');
      const destination = needText(entry.destination, 'destination');
      const old = syncFromRow((await this.db.all('SELECT * FROM sync_ledger WHERE ride_id=? AND destination=?', [rideId, destination]))[0]) || {};
      const v = { ...defaults, ...old, ...entry, rideId, destination, updatedAt: this.clock().toISOString() };
      await this.db.run('INSERT OR REPLACE INTO sync_ledger VALUES (?,?,?,?,?,?,?,?)', [rideId, destination, str(v.externalId), str(v.contentHash), str(v.status),
        int(v.attempts), str(v.lastError), v.updatedAt]);
      return syncFromRow((await this.db.all('SELECT * FROM sync_ledger WHERE ride_id=? AND destination=?', [rideId, destination]))[0]);
    }));
  }
  deleteSyncEntry(rideId, destination) {
    return this.exclusive(() => this.db.run('DELETE FROM sync_ledger WHERE ride_id=? AND destination=?', [String(rideId), String(destination)]));
  }
  /** Small upload options (e.g. auto-upload per destination), kept with the ledger. */
  async getSyncOption(name) { return (await this.exclusive(() => this.meta('sync_opt:' + name))) ?? null; }
  setSyncOption(name, value) { return this.exclusive(() => this.setMeta('sync_opt:' + name, value)); }
  getSyncEntry(rideId, destination) {
    return this.exclusive(async () => syncFromRow((await this.db.all('SELECT * FROM sync_ledger WHERE ride_id=? AND destination=?', [String(rideId), String(destination)]))[0]) || null);
  }
  listSyncEntries({ rideId, destination, status } = {}) {
    const where = [], params = [];
    if (rideId !== undefined) { where.push('ride_id=?'); params.push(String(rideId)); }
    if (destination !== undefined) { where.push('destination=?'); params.push(String(destination)); }
    if (status !== undefined) { where.push('status=?'); params.push(String(status)); }
    return this.exclusive(async () => (await this.db.all(`SELECT * FROM sync_ledger${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY ride_id, destination`, params)).map(syncFromRow));
  }
  /** Saves wellness days of one source: { 'YYYY-MM-DD': data } (data null deletes that day). All or none. */
  putWellnessDays(source, days) {
    return this.exclusive(() => this.transaction(async () => {
      needText(source, 'wellness source');
      if (!days || typeof days !== 'object' || Array.isArray(days)) fail('Wellness days must be an object.');
      for (const [day, data] of Object.entries(days)) {
        if (!DAY.test(day)) fail('Invalid wellness day.');
        if (data === null) await this.db.run('DELETE FROM wellness_days WHERE day=? AND source=?', [day, source]);
        else await this.db.run('INSERT OR REPLACE INTO wellness_days VALUES (?,?,?)', [day, source, JSON.stringify(data)]);
      }
    }));
  }
  /** Wellness days in date order, optionally from/to (inclusive, YYYY-MM-DD) and of one source: [{ day, source, data }]. */
  listWellnessDays({ from, to, source } = {}) {
    const where = [], params = [];
    if (from !== undefined) { where.push('day>=?'); params.push(String(from)); }
    if (to !== undefined) { where.push('day<=?'); params.push(String(to)); }
    if (source !== undefined) { where.push('source=?'); params.push(String(source)); }
    return this.exclusive(async () => (await this.db.all(`SELECT * FROM wellness_days${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY day, source`, params))
      .map((r) => ({ day: r.day, source: r.source, data: JSON.parse(r.json) })));
  }
}

/**
 * The upload queue's ledger (PR #17, src/native-outbox.js) on the sync_ledger table: the same methods and
 * snake_case rows as PrefsSyncLedger, so the queue can swap to it unchanged.
 */
const SNAKE = { externalId: 'external_id', contentHash: 'content_hash', lastError: 'last_error', updatedAt: 'updated_at', rideId: 'ride_id' };
const toSnake = (e) => e && { ride_id: e.rideId, destination: e.destination, external_id: e.externalId, content_hash: e.contentHash,
  status: e.status, attempts: e.attempts, last_error: e.lastError, updated_at: e.updatedAt };
const toCamel = (patch) => Object.fromEntries(Object.entries(patch || {}).map(([k, v]) => [Object.keys(SNAKE).find((c) => SNAKE[c] === k) || k, v]));
const NEW_ROW = { status: 'queued', attempts: 0 };

export class SqliteSyncLedger {
  constructor({ store }) { this.store = store; }
  async get(rideId, destination) { return toSnake(await this.store.getSyncEntry(rideId, destination)); }
  async list(destination) { return (await this.store.listSyncEntries({ destination })).map(toSnake); }
  /** Merges `patch` (snake_case columns) into the row, created as queued if missing, and stamps updated_at. */
  async update(rideId, destination, patch) {
    const { rideId: _r, destination: _d, updatedAt: _u, ...fields } = toCamel(patch);
    return toSnake(await this.store.putSyncEntry({ ...fields, rideId: String(rideId), destination }, NEW_ROW));
  }
  remove(rideId, destination) { return this.store.deleteSyncEntry(rideId, destination); }
  getOption(name) { return this.store.getSyncOption(name); }
  setOption(name, value) { return this.store.setSyncOption(name, String(value)); }

  /**
   * Moves PrefsSyncLedger data (Preferences keys apex_sync_ledger_<destination> and apex_sync_opt_<name>) in,
   * once: rows the table already has win, and each Preferences key is removed only after its rows are saved,
   * so an interrupted move just runs again.
   */
  async importPrefs(prefs, { destinations = [], options = [] } = {}) {
    let moved = 0;
    for (const destination of destinations) {
      const key = `apex_sync_ledger_${destination}`;
      const text = await prefs.get(key); // a failed read fails the move, which is tried again later
      let map;
      try { map = JSON.parse(text || 'null'); } catch { map = null; }
      if (!map || typeof map !== 'object') continue; // nothing there, or unreadable: left as it is
      for (const row of Object.values(map)) {
        if (!row || row.ride_id === undefined || await this.store.getSyncEntry(row.ride_id, destination)) continue;
        const { ride_id: rideId, destination: _d, updated_at: _u, ...fields } = row;
        await this.store.putSyncEntry({ ...toCamel(fields), rideId: String(rideId), destination }, NEW_ROW);
        moved++;
      }
      await prefs.remove(key);
    }
    for (const name of options) {
      const key = `apex_sync_opt_${name}`, value = await prefs.get(key);
      if (value === null || value === undefined) continue;
      if (await this.getOption(name) === null) await this.setOption(name, value);
      await prefs.remove(key);
    }
    return moved;
  }
}

/**
 * The upload queue's ledger while the store is still opening (the queue is made before it is open): each
 * call waits for the store and for the one-time move of the Preferences rows. A failed move is tried again
 * on the next call, so the queue never works from a ledger that is missing rows. If the store cannot be
 * opened, calls go to `fallback` (the Preferences ledger).
 */
export function openingLedger(storePromise, { prefs, destinations, options, fallback }) {
  let ledger = null, moved = null;
  const ready = async () => {
    if (!ledger) {
      // No phone database (it could not be opened): the Preferences ledger keeps uploads working.
      try { ledger = new SqliteSyncLedger({ store: await storePromise }); } catch (e) { if (!fallback) throw e; return fallback; }
    }
    if (!moved) moved = ledger.importPrefs(prefs, { destinations, options }).catch((e) => { moved = null; throw e; });
    await moved;
    return ledger;
  };
  const call = (name) => async (...args) => (await ready())[name](...args);
  return { get: call('get'), list: call('list'), update: call('update'), remove: call('remove'), getOption: call('getOption'), setOption: call('setOption') };
}
