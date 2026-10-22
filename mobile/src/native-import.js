/**
 * Ride import from Android (the native side is ApexImportPlugin.kt):
 *   - nativeSource(): a File-like source ({ name, size, stream() }) over a content URI, read in chunks through
 *     the plugin, so js/velo-bulk-import.js streams a watched-folder file or a shared multi-GB export the
 *     same way it streams a picked File, with its caps (64 MB per ride file, 20 GB per archive, depth 4).
 *   - SqliteImportJobs: the VeloImportJobs interface (js/velo-import-jobs.js) on the phone's import_jobs /
 *     import_files tables, swapped in for the settings-key log.
 *   - NativeImport: the watched folder (scanned at app start, on resume, and when the daily worker finds new
 *     files) and the share inbox. Folder files are tracked by name+size+mtime in import_files (job
 *     WATCH_JOB), so nothing is read twice; shared files wait in the app's inbox until they are imported.
 *     Both survive the app being killed: a file whose import never finished is tried once more, then
 *     recorded as interrupted so a file that crashes the app cannot do it on every start.
 */
import { fromBase64 } from './native-store.js';

export const WATCH_JOB = 'watch_folder';
export const SHARE_JOB = 'share_inbox';
const INTERNAL = new Set([WATCH_JOB, SHARE_JOB]);
/** Bytes per plugin read: about 1.3 MB of base64 over the bridge, small next to the 64 MB entry cap. */
export const CHUNK = 1024 * 1024;

/** The key a watched-folder file is tracked by; the same formula as ImportFiles.stamp in Kotlin. */
export const stamp = (f) => `${f.path}|${f.size}|${f.mtime}`;

/**
 * A File-like source the bulk importer reads with stream(). The file is opened on the first read and
 * closed at its end or when the reader cancels; one chunk is read ahead.
 */
export function nativeSource(plugin, { uri, name, size = -1 }, chunk = CHUNK) {
  return {
    name, size, uri,
    stream() {
      let handle = null, done = false;
      return new ReadableStream({
        async pull(ctrl) {
          if (handle === null) handle = (await plugin.open({ uri })).handle;
          const r = await plugin.read({ handle, length: chunk });
          const bytes = r.data ? fromBase64(r.data) : new Uint8Array(0);
          if (bytes.length) ctrl.enqueue(bytes);
          if (r.eof) { done = true; ctrl.close(); }
        },
        async cancel() {
          if (handle !== null && !done) { done = true; await plugin.close({ handle }).catch(() => {}); }
        }
      }, { highWaterMark: 1 });
    }
  };
}

const iso = (ms) => new Date(ms).toISOString();
const toRow = (j) => j && { id: j.id, source: j.source, status: j.status, total: j.total, done: j.done, skipped: j.skipped, errors: j.errors,
  created_at: j.createdAt, updated_at: j.updatedAt, cursor: j.cursor === null || j.cursor === undefined ? null : JSON.stringify(j.cursor) };
const parseCursor = (c) => { if (typeof c !== 'string') return c ?? null; try { return JSON.parse(c); } catch { return { text: c }; } };

/**
 * VeloImportJobs on the phone database. Rows come back in VeloImportJobs' shape (snake_case, cursor as JSON
 * text). A cursor update is merged into the stored one, so what the native import keeps there (which kind of
 * source, which job resumed it) survives the bulk importer writing its counts. Without the database
 * (it failed to open) every call goes to `fallback`.
 */
export class SqliteImportJobs {
  static KEEP = 20;
  static seq = 0;

  /** fallback: a VeloImportJobs, or a function making one (js/ loads after this module). */
  constructor(store, fallback) { this.store = store; this.makeFallback = fallback; }

  get fallback() {
    if (!this._fallback) this._fallback = typeof this.makeFallback === 'function' ? this.makeFallback() : this.makeFallback;
    return this._fallback;
  }

  async db() { try { return (await this.store) || null; } catch { return null; } }

  async create({ source = 'files', total = 0, cursor = null } = {}) {
    const s = await this.db();
    if (!s) return this.fallback.create({ source, total, cursor });
    // Sorts in creation order also within one millisecond (the store lists by created_at, then id).
    const id = `job_${Date.now().toString(36)}_${(SqliteImportJobs.seq++).toString(36).padStart(4, '0')}${Math.random().toString(36).slice(2, 6)}`;
    const job = await s.putImportJob({ id, source, status: 'running', total, done: 0, skipped: 0, errors: 0, cursor: parseCursor(cursor) });
    const old = (await s.listImportJobs()).filter((j) => !INTERNAL.has(j.id));
    for (const j of old.slice(0, Math.max(0, old.length - SqliteImportJobs.KEEP))) await s.deleteImportJob(j.id);
    return toRow(job);
  }

  async get(id) {
    const s = await this.db();
    return s ? toRow(await s.getImportJob(id)) : this.fallback.get(id);
  }

  /** Newest first, without the watched folder's and the inbox's own records. */
  async list() {
    const s = await this.db();
    if (!s) return this.fallback.list();
    return (await s.listImportJobs()).filter((j) => !INTERNAL.has(j.id)).reverse().map(toRow);
  }

  async update(id, patch) {
    const s = await this.db();
    if (!s) return this.fallback.update(id, patch);
    const old = await s.getImportJob(id);
    if (!old) return null;
    const next = { ...patch, id };
    if ('cursor' in patch) {
      const c = parseCursor(patch.cursor);
      next.cursor = c && typeof c === 'object' && old.cursor && typeof old.cursor === 'object' ? { ...old.cursor, ...c } : c;
    }
    return toRow(await s.putImportJob(next));
  }

  async putFiles(jobId, rows) {
    const s = await this.db();
    if (!s) return this.fallback.putFiles(jobId, rows);
    if (rows.length) await s.putImportFiles(jobId, rows.map((r) => ({ path: r.path, hash: r.hash || null, rideId: r.ride_id || r.rideId || null, status: r.status, error: r.error || null })));
  }

  async files(jobId) {
    const s = await this.db();
    if (!s) return this.fallback.files(jobId);
    return (await s.listImportFiles(jobId)).map((r) => ({ job_id: r.jobId, path: r.path, hash: r.hash, ride_id: r.rideId, status: r.status, error: r.error }));
  }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
/**
 * Row states of a file in import_files while it is read: READING on the first try, RETRYING on the second
 * (the app was killed or the import failed during the first), INTERRUPTED once that failed too. QUEUED: the
 * rider cancelled the import, so the file is read again from the start next time.
 */
const READING = 'reading', RETRYING = 'retrying', INTERRUPTED = 'interrupted', QUEUED = 'queued';

export class NativeImport {
  /** Files per bulk job when a scan finds many. */
  static BATCH = 50;

  /**
   * plugin: ApexImport (or a fake); store: promise of the NativeStore (null without one); getApp: () => the
   * VeloApp once it exists; clock: () => ms.
   */
  constructor({ plugin, store, getApp, clock = () => Date.now(), chunk = CHUNK, waitMs = 300 }) {
    this.plugin = plugin;
    this.store = store;
    this.getApp = getApp;
    this.clock = clock;
    this.chunk = chunk;
    this.waitMs = waitMs;
    this.queue = Promise.resolve();
    this.inFlight = new Set();
    this.paused = false; // a watched-folder import the rider cancelled is not started again until the next app start
    this.catching = null;
  }

  async db() { try { return (await this.store) || null; } catch { return null; } }

  /** Runs import work one piece at a time (folder scans and inbox imports never overlap). */
  serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /** The app once no other import is running and no ride is being recorded. */
  async idleApp() {
    for (;;) {
      const app = this.getApp();
      if (app && !app._bulk && !app.isPlaying) return app;
      await new Promise((r) => setTimeout(r, this.waitMs));
    }
  }

  /** One bulk import of native sources; resolves to its summary (null when it could not start). */
  async importSources(list, { label, kind, quiet = false }) {
    const app = await this.idleApp();
    const sources = list.map((f) => nativeSource(this.plugin, f, this.chunk));
    let summary;
    try {
      summary = await app.startBulkImport(sources, { jobSource: label, jobCursor: { native: kind }, quiet });
    } finally {
      if (this.plugin.closeAll) await this.plugin.closeAll().catch(() => {}); // files a stopped import left open
    }
    if (summary && summary.jobId) await this.markResumed(kind, summary.jobId);
    return summary;
  }

  /** Earlier jobs of this kind that the app was killed in are marked interrupted and pointed at the job that took over. */
  async markResumed(kind, jobId) {
    const s = await this.db();
    if (!s) return;
    for (const j of await s.listImportJobs()) {
      if (j.id === jobId || !j.cursor || j.cursor.native !== kind || j.cursor.resumedBy) continue;
      if (j.status === 'running' || j.status === 'interrupted') await s.putImportJob({ id: j.id, status: 'interrupted', cursor: { ...j.cursor, resumedBy: jobId } });
    }
  }

  /** Startup and resume: shared files first (the rider just sent them), then the watched folder. */
  catchUp() {
    if (this.catching) return this.catching; // resume while the start-up pass still runs
    this.catching = this.serial(async () => {
      await this.importInboxNow().catch((e) => this.toast(`Shared files could not be imported (${e.message || e}).`, 'warning'));
      await this.scanFolderNow().catch(() => {}); // the result is shown in Settings
    }).finally(() => { this.catching = null; });
    return this.catching;
  }

  toast(msg, kind = 'info') { const app = this.getApp(); if (app && app.showToast) app.showToast(msg, kind); }

  // ------------------------------------------------------------- tracking --
  /**
   * Which of `files` (keyed by keyOf) still need reading: { todo: [{ f, status }], gaveUp: [f] }. A file left
   * READING (the app was killed during its import) is read once more; one left RETRYING is recorded as
   * interrupted and skipped from then on. The todo files are marked by mark() just before their batch runs,
   * so a kill only counts against the batch that was being read.
   */
  async pending(s, job, files, keyOf) {
    const rows = new Map((await s.listImportFiles(job)).map((r) => [r.path, r]));
    const todo = [], gaveUp = [];
    for (const f of files) {
      const row = rows.get(keyOf(f));
      if (!row || row.status === QUEUED) todo.push({ f, status: READING });
      else if (row.status === READING) todo.push({ f, status: RETRYING });
      else if (row.status === RETRYING) gaveUp.push(f);
    }
    if (gaveUp.length) await s.putImportFiles(job, gaveUp.map((f) => ({ path: keyOf(f), status: INTERRUPTED, error: 'the app stopped twice while reading this file' })));
    return { todo, gaveUp };
  }

  mark(s, job, batch, keyOf) { return s.putImportFiles(job, batch.map(({ f, status }) => ({ path: keyOf(f), status, error: null }))); }

  /** The bulk job's per-file errors for these sources (a ride file that could not be read, an empty archive). */
  async outcomes(s, summary, files, nameOf) {
    const out = new Map(files.map((f) => [f, { status: 'imported', error: null }]));
    if (!summary || !summary.jobId) return out;
    const byPath = new Map((await s.listImportFiles(summary.jobId)).map((r) => [r.path, r]));
    for (const f of files) {
      const r = byPath.get(nameOf(f));
      if (r && (r.status === 'error' || r.status === 'skipped')) out.set(f, { status: r.status, error: r.error });
    }
    return out;
  }

  // -------------------------------------------------------- watched folder --
  async folder() { return this.plugin.getFolder(); }

  /** Settings > Import folder: pick a folder, then import what is in it. */
  async pickFolder() {
    const r = await this.plugin.pickFolder();
    if (!r || r.cancelled || !r.uri) return null;
    return this.serial(async () => {
      const s = await this.db();
      if (s) await s.deleteImportJob(WATCH_JOB); // another folder: its files are new
      return this.scanFolderNow({ force: true });
    });
  }

  /** Stops watching at once; the folder's records go once a running import has finished. */
  async removeFolder() {
    await this.plugin.removeFolder();
    return this.serial(async () => { const s = await this.db(); if (s) await s.deleteImportJob(WATCH_JOB); });
  }

  scanFolder(opts) { return this.serial(() => this.scanFolderNow(opts)); }

  /**
   * Lists the folder, imports the files not in import_files yet (one bulk job), records them and tells the
   * daily worker what is known. Resolves to { files, fresh, summary } or null without a folder.
   */
  async scanFolderNow({ force = false } = {}) {
    const f = await this.plugin.getFolder();
    if (!f || !f.uri) return null;
    const s = await this.db();
    if (!s) return { error: 'The phone database is not open, so the folder cannot be tracked.' };
    const job = (await s.getImportJob(WATCH_JOB)) || {};
    const state = { uri: f.uri, name: f.name, lastScan: iso(this.clock()) };
    const save = (patch) => s.putImportJob({ id: WATCH_JOB, source: f.name, status: 'watching', cursor: { ...(job.cursor || {}), ...state, ...patch } });
    if (!f.permission) { await save({ lastError: 'The app no longer has access to this folder. Choose it again.' }); return { error: 'permission' }; }
    if (this.paused && !force) return null;
    this.paused = false;
    let files;
    try { files = (await this.plugin.listFolder()).files || []; } catch (e) { await save({ lastError: e.message || String(e) }); return { error: e.message || String(e) }; }
    const { todo } = await this.pending(s, WATCH_JOB, files, stamp);
    // A first scan of a big folder runs in batches: each is recorded when it is done, so the app being killed
    // costs only the batch it was reading. One toast for the whole scan.
    const batches = [];
    for (let i = 0; i < todo.length; i += NativeImport.BATCH) batches.push(todo.slice(i, i + NativeImport.BATCH));
    const quiet = batches.length > 1;
    let summary = null, imported = 0, failed = 0, duplicates = 0, stopped = null;
    for (const [i, batch] of batches.entries()) {
      const list = batch.map((t) => t.f);
      await this.mark(s, WATCH_JOB, batch, stamp);
      summary = await this.importSources(list.map((x) => ({ uri: x.uri, name: x.path, size: x.size })),
        { label: `${f.name}: ${plural(todo.length, 'new file')}${quiet ? ` (part ${i + 1} of ${batches.length})` : ''}`, kind: 'folder', quiet });
      if (!summary || summary.error) { stopped = summary ? summary.error : 'the import could not start'; break; } // marked: tried again next time
      if (summary.cancelled) {
        this.paused = true; // rides read so far are kept; the rest waits for the next app start or Scan now
        await s.putImportFiles(WATCH_JOB, list.map((x) => ({ path: stamp(x), status: QUEUED })));
        stopped = 'cancelled';
        break;
      }
      const out = await this.outcomes(s, summary, list, (x) => x.path);
      await s.putImportFiles(WATCH_JOB, list.map((x) => ({ path: stamp(x), ...out.get(x) })));
      imported += summary.imported; duplicates += summary.duplicates;
      failed += [...out.values()].filter((o) => o.status === 'error').length;
    }
    if (quiet && stopped !== 'cancelled') {
      this.toast(`${f.name}: ${plural(imported, 'ride')} imported from ${plural(todo.length, 'new file')}, ${plural(duplicates, 'duplicate')}${failed ? `, ${plural(failed, 'file')} could not be read` : ''}${stopped ? `. Stopped: ${stopped}` : ''}.`,
        stopped || failed ? 'warning' : 'success');
    }
    const rows = await s.listImportFiles(WATCH_JOB);
    const done = new Set(rows.filter((r) => ![READING, RETRYING, QUEUED].includes(r.status)).map((r) => r.path));
    const present = files.map(stamp).filter((k) => done.has(k));
    await s.putImportJob({ id: WATCH_JOB, source: f.name, status: 'watching', total: files.length, done: present.length, errors: rows.filter((r) => r.status === 'error').length,
      cursor: { ...(job.cursor || {}), ...state, lastNew: todo.length, lastImported: imported, lastFailed: failed,
        lastError: stopped && stopped !== 'cancelled' ? stopped : null, lastCancelled: stopped === 'cancelled' } });
    await this.plugin.setSeen({ stamps: present }).catch(() => {});
    return { files: files.length, fresh: todo.length, summary };
  }

  /** What Settings shows: the folder, its last scan and the counts. */
  async folderStatus() {
    const f = await this.plugin.getFolder().catch(() => null);
    if (!f || !f.uri) return { folder: null };
    const s = await this.db();
    const job = s ? await s.getImportJob(WATCH_JOB) : null;
    const c = (job && job.cursor) || {};
    return { folder: f.name, permission: f.permission, database: !!s, tracked: job ? job.done : 0, files: job ? job.total : 0, errors: job ? job.errors : 0,
      lastScan: c.lastScan || null, lastNew: c.lastNew || 0, lastImported: c.lastImported || 0, lastError: c.lastError || null,
      pendingNew: f.pendingNew || 0, workerCheckedAt: f.workerCheckedAt || 0 };
  }

  // ------------------------------------------------------------------ share --
  importInbox() { return this.serial(() => this.importInboxNow()); }

  /**
   * Imports the files waiting in the share inbox in one bulk job and removes them once read. A file whose
   * import the app was killed in stays in the inbox and is tried once more (then dropped).
   */
  async importInboxNow() {
    const all = ((await this.plugin.listInbox()).files || []).filter((f) => !this.inFlight.has(f.uri));
    if (!all.length) return null;
    const s = await this.db();
    let todo = all;
    if (s) {
      const p = await this.pending(s, SHARE_JOB, all, (f) => f.uri);
      await this.mark(s, SHARE_JOB, p.todo, (f) => f.uri);
      todo = p.todo.map((t) => t.f);
      if (p.gaveUp.length) this.toast(`${p.gaveUp.map((f) => f.name).join(', ')}: the import stopped twice, so ${p.gaveUp.length === 1 ? 'it was' : 'they were'} not imported.`, 'warning');
      // Given up on, or already imported (the app stopped before the inbox was emptied): only removed.
      for (const f of all) if (!todo.includes(f)) await this.plugin.removeInbox({ uri: f.uri }).catch(() => {});
    }
    if (!todo.length) return null;
    todo.forEach((f) => this.inFlight.add(f.uri));
    try {
      this.toast(`Importing ${todo.length === 1 ? todo[0].name : plural(todo.length, 'shared file')}...`);
      const summary = await this.importSources(todo, { label: todo.length === 1 ? todo[0].name : plural(todo.length, 'shared file'), kind: 'share' });
      if (!summary || summary.error) return summary; // kept in the inbox (marked read once): tried again at the next start
      if (s) {
        const out = await this.outcomes(s, summary, todo, (f) => f.name);
        await s.putImportFiles(SHARE_JOB, todo.map((f) => ({ path: f.uri, ...out.get(f) })));
      }
      for (const f of todo) await this.plugin.removeInbox({ uri: f.uri }).catch(() => {});
      return summary;
    } finally {
      todo.forEach((f) => this.inFlight.delete(f.uri));
    }
  }

  /** The plugin copied shared files into the inbox (or turned some down). */
  onShared({ accepted = 0, rejected = [] } = {}) {
    if (rejected.length) this.toast(`${rejected.join(', ')}: not a ride file. Share .fit, .tcx, .gpx, .zip or .gz files.`, 'warning');
    if (accepted) return this.importInbox().catch((e) => this.toast(`Shared files could not be imported (${e.message || e}).`, 'warning'));
    return null;
  }

  /** Starts listening to the plugin and imports what is waiting once the app is up. */
  start() {
    if (this.plugin.addListener) {
      this.plugin.addListener('sharedFiles', (e) => this.onShared(e));
      this.plugin.addListener('folderChanged', () => this.scanFolder().catch(() => {}));
    }
    return this.catchUp();
  }
}

// ---------------------------------------------------------------- Settings --
function folderSection() {
  return `
      <section class="settings-section" data-sec="importfolder" id="nativeImportSettings">
        <p class="field-help">Pick a folder where your ride files arrive, for example a Dropbox or Google Drive folder, or the folder a Garmin, Wahoo or Karoo export is saved to. New .fit, .tcx, .gpx, .zip and .gz files there are imported when the app opens, when it comes back to the screen and once a day. A file is read once: changed files are read again, files already imported are not.</p>
        <div class="settings-kv" id="nativeImportStatus" aria-live="polite"><span class="dim">Checking...</span></div>
        <div class="btn-row">
          <button type="button" class="btn btn-primary" id="btnNativeImportPick">Choose folder</button>
          <button type="button" class="btn" id="btnNativeImportScan">Scan now</button>
          <button type="button" class="btn btn-ghost" id="btnNativeImportRemove">Remove</button>
        </div>
        <p class="field-help">You can also share ride files to Apex Velo from Garmin Connect, the Wahoo app, Files or an email: they are imported straight away. The sport filter of History &gt; Import history applies to both.</p>
      </section>`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const when = (ms) => { if (!ms) return 'never'; const d = new Date(ms); return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`; };

export function renderFolderStatus(st) {
  if (!st.folder) return '<span class="dim">No folder chosen.</span>';
  const kv = (k, v) => `<div><span class="dim">${esc(k)}</span> <b>${v}</b></div>`;
  let html = kv('Folder', esc(st.folder));
  if (!st.permission) return html + '<div class="warn">The app no longer has access to this folder. Choose it again.</div>';
  if (!st.database) return html + '<div class="warn">The phone database is not open, so the folder is not being imported.</div>';
  html += kv('Last scan', st.lastScan ? esc(when(Date.parse(st.lastScan))) : 'not yet');
  html += kv('Ride files', `${st.tracked} imported of ${st.files} in the folder${st.errors ? `, ${plural(st.errors, 'file')} could not be read` : ''}`);
  if (st.lastScan) html += kv('Last scan found', `${plural(st.lastNew, 'new file')}, ${plural(st.lastImported, 'ride')} imported`);
  if (st.pendingNew) html += kv('Waiting', `${plural(st.pendingNew, 'new file')} found by the daily check`);
  if (st.lastError) html += `<div class="warn">${esc(st.lastError)}</div>`;
  return html;
}

/**
 * Settings > Import (folder status, Choose / Scan now / Remove), the SQLite job log behind VeloImportJobs, and
 * the start of watched-folder and share imports once the app exists. Call before DOMContentLoaded.
 */
export function installNativeImportUi({ win = window, nativeImport, jobs, App }) {
  const doc = win.document;
  win.addEventListener('DOMContentLoaded', () => {
    /* global VeloApp */
    const App_ = typeof VeloApp !== 'undefined' ? VeloApp : win.VeloApp;
    const P = App_ && App_.prototype;
    if (!P) return;
    if (jobs) P.importJobs = jobs; // app-bulk-import.js uses this.importJobs when it is set
    if (!nativeImport) return;
    const nav = doc.getElementById('settingsNav');
    if (nav && !nav.querySelector('[data-sec="importfolder"]')) {
      const b = doc.createElement('button');
      b.type = 'button'; b.className = 'cat-pill'; b.dataset.sec = 'importfolder'; b.textContent = 'Import';
      const after = nav.querySelector('[data-sec="files"]') || nav.querySelector('[data-sec="rider"]');
      after ? after.after(b) : nav.append(b);
      const sec = doc.querySelector('#settingsModal .settings-section[data-sec="files"]') || doc.querySelector('#settingsModal .settings-section[data-sec="rider"]');
      if (sec) sec.insertAdjacentHTML('afterend', folderSection());
    }
    const initSettings = P.initSettings;
    P.initSettings = function () {
      initSettings.call(this);
      const app = this;
      const box = doc.getElementById('nativeImportStatus');
      const render = async () => {
        const st = await nativeImport.folderStatus();
        if (box) box.innerHTML = renderFolderStatus(st);
        const has = !!st.folder;
        doc.getElementById('btnNativeImportPick').textContent = has ? 'Choose another folder' : 'Choose folder';
        doc.getElementById('btnNativeImportScan').hidden = !has || !st.permission;
        doc.getElementById('btnNativeImportRemove').hidden = !has;
      };
      app._renderNativeImport = render;
      const busy = async (fn) => { try { await fn(); } catch (e) { app.showToast((e && e.message) || String(e), 'warning'); } await render().catch(() => {}); };
      app.on(doc.getElementById('btnNativeImportPick'), 'click', () => busy(async () => {
        const r = await nativeImport.pickFolder();
        if (r && r.fresh === 0) app.showToast('Folder saved. No new ride files in it yet.', 'info');
      }));
      app.on(doc.getElementById('btnNativeImportScan'), 'click', () => busy(async () => {
        const r = await nativeImport.scanFolder({ force: true });
        if (r && r.fresh === 0) app.showToast('No new ride files in the folder.', 'info');
      }));
      app.on(doc.getElementById('btnNativeImportRemove'), 'click', () => busy(async () => {
        await nativeImport.removeFolder();
        app.showToast('Folder removed. Rides already imported stay in History.', 'success');
      }));
      render().catch(() => {});
    };
    const show = P.showSettingsSection;
    P.showSettingsSection = function (sec) {
      show.call(this, sec);
      if (sec === 'importfolder' && this._renderNativeImport) this._renderNativeImport().catch(() => {});
    };
  });
  if (!nativeImport) return;
  const whenApp = async () => { for (let i = 0; i < 300 && !win.app; i++) await new Promise((r) => setTimeout(r, 100)); return win.app; };
  whenApp().then((app) => {
    if (!app) return;
    nativeImport.start().catch(() => {});
    if (App) App.addListener('resume', () => { nativeImport.catchUp().catch(() => {}); });
  });
}
