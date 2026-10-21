/**
 * APEX VELO // LAB - History mixin: bulk "Import history" (many files, zip archives, Garmin / Strava
 * exports). Parsing runs in js/velo-import-worker.js; this side dedupes against the history
 * (VeloDedupe.admit), shows the progress panel and saves everything once at the end, so derived
 * analytics (FTP history, PMC, power curve) are recomputed once, not per ride.
 */
(function () {
  const esc = (s) => VeloApp.esc(s);
  const BULK_EXT = /\.(zip|gpx|gz)$/i;

  Object.assign(VeloApp.prototype, {
    initBulkImportDom() {
      const input = document.getElementById('fileInputBulk');
      this.on(input, 'change', (e) => { const files = Array.from(e.target.files || []); e.target.value = ''; if (files.length) this.startBulkImport(files); });
      this.on(document.getElementById('btnImportHistory'), 'click', () => input && input.click());
      this.on(document.getElementById('btnBulkImportCancel'), 'click', () => this.cancelBulkImport());
      this.on(document.getElementById('btnBulkImportClose'), 'click', () => { const p = document.getElementById('bulkImportPanel'); if (p && !this._bulk) p.hidden = true; });
      const mode = document.getElementById('bulkImportMode');
      if (mode) {
        try { const saved = localStorage.getItem('apex_import_mode'); if (saved && VeloBulkImport.MODES[saved]) mode.value = saved; } catch (e) { /* default */ }
        this.on(mode, 'change', () => { try { localStorage.setItem('apex_import_mode', mode.value); } catch (e) { /* optional preference */ } });
      }
    },

    /** Files the single-file importer cannot take (archives, .gz rides, GPX) go to the bulk importer. */
    wantsBulkImport(files) {
      return files.some(f => BULK_EXT.test(f.name) && !/\.json\.gz$/i.test(f.name));
    },

    bulkImportMode() {
      const v = document.getElementById('bulkImportMode')?.value;
      return VeloBulkImport.MODES[v] ? v : 'cycling';
    },

    /**
     * Imports many ride files / archives. Resolves with the final summary
     * { counts, imported, replaced, cancelled }. opts: { mode, inline } (inline = no Web Worker).
     */
    async startBulkImport(files, opts = {}) {
      if (this._bulk) { this.showToast('An import is already running.', 'info'); return null; }
      const mode = opts.mode || this.bulkImportMode();
      const jobs = this.importJobs || (this.importJobs = new VeloImportJobs());
      const job = await jobs.create({ source: files.length === 1 ? files[0].name : `${files.length} files`, total: 0 });
      const index = VeloDedupe.rideIndex(this.completedWorkouts);
      const st = this._bulk = {
        job, mode, cancelled: false, worker: null, index,
        counts: { found: 0, parsed: 0, skipped: 0, errors: 0, duplicates: 0 }, sameRide: 0,
        pending: new Set(), replaceOf: new Map(), rows: [], strava: new Map(), path: '', done: false, touched: new Set()
      };
      this.renderBulkPanel();

      const onRides = (rides) => {
        for (const ride of rides) {
          const v = VeloDedupe.admit(st.index, ride);
          if (v.verdict === 'new') st.pending.add(ride);
          else if (v.verdict === 'duplicate') { st.sameRide++; this.markStravaOrigin(v.with, ride.origin, st); }
          else if (st.pending.has(v.with)) { st.pending.delete(v.with); st.pending.add(ride); st.sameRide++; }
          else if (st.replaceOf.has(v.with)) { st.replaceOf.set(ride, st.replaceOf.get(v.with)); st.replaceOf.delete(v.with); st.sameRide++; }
          else st.replaceOf.set(ride, v.with);
        }
        this.renderBulkPanel();
      };
      const handlers = {
        onProgress: (counts, path) => { st.counts = counts; st.path = path || ''; this.renderBulkPanel(); },
        onRides,
        onIndex: (map) => { for (const [k, v] of map) st.strava.set(k, v); },
        onFile: (row) => st.rows.push(row)
      };
      const runOpts = { mode, profile: { name: this.activeProfile.name, ftp: this.activeProfile.ftp },
        knownHashes: this.completedWorkouts.map(r => r.fileHash).filter(Boolean) };

      let result;
      try {
        result = (!opts.inline && typeof Worker !== 'undefined' && await this.runBulkWorker(files, runOpts, handlers))
          || await VeloBulkImport.run(files, { ...runOpts, isCancelled: () => st.cancelled }, handlers);
      } catch (err) {
        console.error('Bulk import failed', err);
        result = { counts: st.counts, cancelled: st.cancelled, error: err.message || String(err) };
      }
      return this.finishBulkImport(result);
    },

    /** Runs the import in the Web Worker. Resolves null when the worker cannot start (then it runs inline). */
    runBulkWorker(files, runOpts, h) {
      const st = this._bulk;
      return new Promise((resolve) => {
        let worker, started = false;
        try { worker = new Worker('js/velo-import-worker.js'); } catch (e) { resolve(null); return; }
        st.worker = worker;
        const end = (value) => { worker.terminate(); st.worker = null; resolve(value); };
        worker.onerror = (e) => { e.preventDefault?.(); end(started ? { counts: st.counts, cancelled: st.cancelled, error: e.message || 'Import worker failed' } : null); };
        worker.onmessage = (e) => {
          started = true;
          const m = e.data;
          if (m.type === 'progress') h.onProgress(m.counts, m.path);
          else if (m.type === 'rides') h.onRides(m.rides);
          else if (m.type === 'index') h.onIndex(new Map(m.entries));
          else if (m.type === 'files') m.rows.forEach(h.onFile);
          else if (m.type === 'done') { h.onProgress(m.counts, null); end({ counts: m.counts, cancelled: m.cancelled }); }
          else if (m.type === 'error') end({ counts: st.counts, cancelled: st.cancelled, error: m.message });
        };
        worker.postMessage({ type: 'start', files, opts: runOpts });
        if (st.cancelled) worker.postMessage({ type: 'cancel' });
      });
    },

    cancelBulkImport() {
      const st = this._bulk;
      if (!st || st.done) return;
      st.cancelled = true;
      if (st.worker) st.worker.postMessage({ type: 'cancel' });
      this.renderBulkPanel();
    },

    /** Keeps the new rides, swaps in better copies, saves once and recomputes analytics once. */
    async finishBulkImport(result) {
      const st = this._bulk;
      st.done = true;
      st.counts = result.counts || st.counts;
      const added = [...st.pending];
      const replacements = [...st.replaceOf];
      VeloBulkImport.applyIndex(added.concat(replacements.map(([ride]) => ride)), st.strava);
      // Exact copies dropped in the worker: if the copy came from a Strava export, the kept ride is on Strava too.
      st.rows.forEach(r => { if (r.status === 'duplicate' && r.hash) this.markStravaOrigin(st.index.byHash(r.hash), r.origin, st); });

      const status = new Map();
      added.forEach(r => status.set(r.id, 'imported'));
      const byId = new Map(this.completedWorkouts.map((r, i) => [r.id, i]));
      for (const [ride, old] of replacements) {
        const at = byId.get(old.id);
        if (at === undefined) continue;
        // The better copy replaces the stored one under the stored id; its names and Strava link are kept.
        const keep = { id: old.id, title: old.title || ride.title, description: old.description || ride.description,
          strava: old.strava, stravaActivityId: old.stravaActivityId || ride.stravaActivityId, replacedFrom: old.source,
          origin: old.origin === 'strava' || ride.origin === 'strava' ? 'strava' : (old.origin || ride.origin) };
        Object.keys(keep).forEach(k => keep[k] === undefined && delete keep[k]);
        this.completedWorkouts[at] = { ...ride, ...keep };
        status.set(ride.id, 'replaced');
      }
      if (added.length) {
        added.sort((a, b) => String(b.date).localeCompare(String(a.date)));
        this.completedWorkouts.unshift(...added);
      }
      const touched = [...st.touched].filter(r => this.completedWorkouts.includes(r));
      if (status.size || touched.length) {
        await this.saveHistory();
        this.renderHistoryTable();
        this.refreshAnalytics();
      }

      const rows = st.rows.map(r => ({ path: r.path, hash: r.hash, ride_id: r.rideId, error: r.error,
        status: r.status === 'parsed' ? (status.get(r.rideId) || 'duplicate') : r.status }));
      const summary = this.bulkSummary();
      await this.importJobs.putFiles(st.job.id, rows);
      await this.importJobs.update(st.job.id, {
        status: result.error ? 'failed' : result.cancelled ? 'cancelled' : 'done',
        total: summary.found, done: summary.imported, skipped: summary.skipped + summary.duplicates, errors: summary.errors,
        cursor: JSON.stringify({ counts: summary, error: result.error || null })
      });
      st.error = result.error || null;
      st.cancelled = !!result.cancelled;
      this.renderBulkPanel();
      this._bulk = null;
      this._lastBulk = st;
      const msg = result.error ? `Import stopped: ${result.error}`
        : `${result.cancelled ? 'Import cancelled' : 'Import finished'}: ${summary.imported} ride${summary.imported === 1 ? '' : 's'} imported, ${summary.duplicates} duplicate${summary.duplicates === 1 ? '' : 's'}, ${summary.skipped} skipped${summary.errors ? `, ${summary.errors} error${summary.errors === 1 ? '' : 's'}` : ''}.`;
      this.showToast(msg, result.error || summary.errors ? 'warning' : 'success');
      return { ...summary, replaced: replacements.length, cancelled: !!result.cancelled, error: result.error || null, jobId: st.job.id };
    },

    /** A ride that also arrived in a Strava export is on Strava: tag it so it is never uploaded there again. */
    markStravaOrigin(kept, origin, st) {
      if (!kept || origin !== 'strava' || kept.origin === 'strava') return;
      kept.origin = 'strava';
      st.touched.add(kept);
    },

    bulkSummary(st = this._bulk || this._lastBulk) {
      if (!st) return null;
      const c = st.counts;
      return { found: c.found, imported: st.pending.size + st.replaceOf.size, duplicates: c.duplicates + st.sameRide, skipped: c.skipped, errors: c.errors };
    },

    renderBulkPanel() {
      const panel = document.getElementById('bulkImportPanel');
      if (!panel || !this._bulk) return;
      if (this._bulkPaint) return; // coalesce bursts of progress messages into one paint per frame
      this._bulkPaint = (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : setTimeout)(() => {
        this._bulkPaint = null;
        const st = this._bulk || this._lastBulk;
        if (!st) return;
        const s = this.bulkSummary(st);
        panel.hidden = false;
        panel.dataset.state = st.done ? (st.error ? 'failed' : st.cancelled ? 'cancelled' : 'done') : st.cancelled ? 'cancelling' : 'running';
        for (const k of ['found', 'imported', 'duplicates', 'skipped', 'errors']) {
          const el = panel.querySelector(`[data-count="${k}"]`);
          if (el) el.textContent = s[k];
        }
        const label = st.done
          ? (st.error ? `Stopped: ${st.error}` : st.cancelled ? 'Cancelled. Rides read so far were kept.' : 'Done. Training load, FTP history and power curve updated.')
          : st.cancelled ? 'Cancelling...' : (st.path ? `Reading ${st.path.split('/').slice(-2).join('/')}` : 'Reading files...');
        const status = panel.querySelector('.bulk-status');
        if (status) status.innerHTML = esc(label);
        const cancel = document.getElementById('btnBulkImportCancel'), close = document.getElementById('btnBulkImportClose');
        if (cancel) cancel.hidden = st.done;
        if (close) close.hidden = !st.done;
      });
    }
  });
})();
