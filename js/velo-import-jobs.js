/**
 * APEX VELO // LAB - import job log behind a small adapter (docs/ANDROID-CONTRACTS.md).
 *
 * Rows have the shape of the SQLite tables import_jobs / import_files, but until the native store
 * (workstream B) exposes them they live in settings keys:
 *   apex_import_jobs            JSON list of job ids, newest last (the last KEEP jobs are kept)
 *   apex_import_job_<id>        one import_jobs row
 *   apex_import_files_<id>      that job's import_files rows
 * Every method is async so a store backed by /api/storage can replace this one without touching callers.
 * A job's detailed counts (found / imported / duplicates / skipped / errors) are kept as JSON in `cursor`.
 */
class VeloImportJobs {
  static KEEP = 5;

  /** store: anything with getItem / setItem / removeItem (localStorage by default). */
  constructor(store) {
    this.store = store || (typeof localStorage !== 'undefined' ? localStorage : null);
  }

  _get(key, fallback) {
    try { const raw = this.store && this.store.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; }
  }

  _set(key, value) {
    try { if (this.store) this.store.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; } // quota: the log is best-effort
  }

  async create({ source = 'files', total = 0 } = {}) {
    const now = new Date().toISOString();
    const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const job = { id, source, status: 'running', total, done: 0, skipped: 0, errors: 0, created_at: now, updated_at: now, cursor: null };
    this._set(`apex_import_job_${id}`, job);
    const ids = this._get('apex_import_jobs', []).concat(id);
    for (const old of ids.splice(0, Math.max(0, ids.length - VeloImportJobs.KEEP))) {
      try { this.store.removeItem(`apex_import_job_${old}`); this.store.removeItem(`apex_import_files_${old}`); } catch (e) { /* ignore */ }
    }
    this._set('apex_import_jobs', ids);
    return job;
  }

  async get(id) { return this._get(`apex_import_job_${id}`, null); }

  async list() {
    return this._get('apex_import_jobs', []).map(id => this._get(`apex_import_job_${id}`, null)).filter(Boolean).reverse();
  }

  async update(id, patch) {
    const job = await this.get(id);
    if (!job) return null;
    Object.assign(job, patch, { updated_at: new Date().toISOString() });
    this._set(`apex_import_job_${id}`, job);
    return job;
  }

  /** Adds or updates import_files rows ({ path, hash, ride_id, status, error }), keyed by (job_id, path). */
  async putFiles(jobId, rows) {
    const list = this._get(`apex_import_files_${jobId}`, []);
    const at = new Map(list.map((r, i) => [r.path, i]));
    for (const r of rows) {
      const row = { job_id: jobId, path: r.path, hash: r.hash || null, ride_id: r.ride_id || null, status: r.status, error: r.error || null };
      if (at.has(r.path)) list[at.get(r.path)] = row; else { at.set(r.path, list.length); list.push(row); }
    }
    this._set(`apex_import_files_${jobId}`, list);
  }

  async files(jobId) { return this._get(`apex_import_files_${jobId}`, []); }
}

if (typeof window !== 'undefined') window.VeloImportJobs = VeloImportJobs;
if (typeof module !== 'undefined') module.exports = VeloImportJobs;
