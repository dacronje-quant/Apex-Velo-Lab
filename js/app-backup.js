/**
 * APEX VELO // LAB - Automatic history backup (mixin on VeloApp).
 *
 * The ride history lives in this browser (IndexedDB + localStorage), so clearing browser data
 * would lose it. After every change (ride saved, import, sync, delete) and at least once a day,
 * the app sends the same backup as "Backup JSON" - profiles, workout library and every ride with
 * its per-second samples - gzipped to the local server, which keeps the newest 14 in data\backups.
 * Restore: drop a backup (.json or .json.gz) on the Import zone in History.
 */
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STATE_KEY = 'apex_auto_backup';
  const DEBOUNCE_MS = 15000;          // several changes in a row -> one backup
  const DAILY_MS = 24 * 3600 * 1000;  // unchanged history is still backed up once a day

  Object.assign(VeloApp.prototype, {
    /** The backup object - also what "Backup JSON" downloads (the importer reads it back). */
    backupPayload() {
      return { app: 'APEX VELO LAB', exportedAt: new Date().toISOString(), profiles: this.profiles, activeProfileId: this.activeProfileId, workoutLibrary: this.loadSavedWorkouts(), history: this.completedWorkouts };
    },

    /** Cheap fingerprint of what a backup would contain, to skip identical uploads. */
    backupSignature() {
      let samples = 0, tss = 0;
      this.completedWorkouts.forEach(r => { samples += Array.isArray(r.samples) ? r.samples.length : 0; tss += Number(r.tss) || 0; });
      const ids = this.completedWorkouts.map(r => r.id).sort().join(',');
      let h = 0;
      for (let i = 0; i < ids.length; i++) h = (h * 31 + ids.charCodeAt(i)) | 0;
      return [this.completedWorkouts.length, h, samples, Math.round(tss), JSON.stringify(this.profiles || []).length, this.loadSavedWorkouts().length].join('|');
    },

    backupState() {
      try { return JSON.parse(localStorage.getItem(STATE_KEY) || '{}') || {}; } catch (e) { return {}; }
    },

    /** Called after anything that changes the history; debounced so bursts become one backup. */
    scheduleAutoBackup(delayMs = DEBOUNCE_MS) {
      if (window.__APEX_TEST_MODE__) return;
      clearTimeout(this._backupTimer);
      this._backupTimer = setTimeout(() => { this.runAutoBackup().catch(() => {}); }, delayMs);
    },

    /**
     * Sends a backup unless nothing changed since the last one and it is less than a day old.
     * Returns { ok, skipped?, name?, error? }. Never throws; failures only update the status line.
     */
    async runAutoBackup({ force = false } = {}) {
      if (this._backupBusy) return { ok: false, error: 'busy' };
      const sig = this.backupSignature();
      const st = this.backupState();
      if (!force && st.sig === sig && st.at && Date.now() - st.at < DAILY_MS) return { ok: true, skipped: true };
      if (!this.completedWorkouts.length && !force) return { ok: true, skipped: true };
      this._backupBusy = true;
      this.renderBackupStatus('Backing up...');
      try {
        if (typeof CompressionStream === 'undefined') throw new Error('this browser cannot compress the backup - use Backup JSON');
        const json = JSON.stringify(this.backupPayload());
        const gz = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
        const r = await fetch('api/backup', { method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body: gz, cache: 'no-store' });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw Object.assign(new Error(j.error || `server error ${r.status}`), { status: r.status });
        const next = { sig, at: Date.now(), name: j.name, bytes: j.bytes, dir: j.dir, count: j.count, keep: j.keep, rides: this.completedWorkouts.length };
        try { localStorage.setItem(STATE_KEY, JSON.stringify(next)); } catch (e) { /* ignore */ }
        this._backupError = null;
        this.renderBackupStatus();
        return { ok: true, name: j.name, bytes: j.bytes };
      } catch (e) {
        this._backupError = e.status === 403 ? 'Automatic backup runs only in the app on this PC.'
          : e.status === 404 || e.status === 405 ? 'Restart Launch-Apex-Velo.bat to enable automatic backups.'
            : /Failed to fetch|NetworkError/i.test(e.message) ? 'Local server not reachable - use Backup JSON.' : `Backup failed: ${e.message}`;
        this.renderBackupStatus();
        return { ok: false, error: this._backupError };
      } finally {
        this._backupBusy = false;
      }
    },

    renderBackupStatus(busyText) {
      const el = document.getElementById('autoBackupStatus');
      if (!el) return;
      const st = this.backupState();
      let text;
      if (busyText) text = busyText;
      else if (this._backupError) text = this._backupError;
      else if (st.at) {
        const when = new Date(st.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        const size = !st.bytes ? '' : st.bytes >= 1048576 ? `${(st.bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(st.bytes / 1024))} KB`;
        const rides = st.rides == null ? '' : `${st.rides} ride${st.rides === 1 ? '' : 's'}, `;
        text = `Auto-backup ${when} - ${rides}${size} - ${st.count || 1} of ${st.keep || 14} kept in data\\backups`;
      } else text = 'Auto-backup: not yet - it runs after your next ride (or press Back up now).';
      el.innerHTML = `<span class="${this._backupError ? 'backup-warn' : ''}">${esc(text)}</span>`;
      el.title = st.dir ? `Folder: ${st.dir}. Restore by dropping a backup file on the Import zone.` : 'Restore by dropping a backup file on the Import zone.';
    },

    initAutoBackup() {
      this.on(document.getElementById('btnBackupNow'), 'click', async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        const r = await this.runAutoBackup({ force: true });
        b.disabled = false;
        this.showToast(r.ok ? `Backup saved (${r.name}).` : r.error, r.ok ? 'success' : 'error');
      });
      this.renderBackupStatus();
      // Daily safety net even when nothing changed (the history loads a moment after start).
      this.scheduleAutoBackup(20000);
    }
  });
})();
