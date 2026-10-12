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
      const settings = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (/^apex_[a-zA-Z0-9_:-]{1,180}$/.test(k) && !['apex_velo_history', 'apex_auto_backup', 'apex_sqlite_migration'].includes(k)) settings[k] = localStorage.getItem(k);
      }
      return { app: 'APEX VELO LAB', exportedAt: new Date().toISOString(), profiles: this.profiles, activeProfileId: this.activeProfileId, workoutLibrary: this.loadSavedWorkouts(), health: this.healthStore || null, history: this.completedWorkouts, settings };
    },

    /** Cheap fingerprint of what a backup would contain, to skip identical uploads. */
    backupSignature() {
      let samples = 0, tss = 0;
      this.completedWorkouts.forEach(r => { samples += Array.isArray(r.samples) ? r.samples.length : 0; tss += Number(r.tss) || 0; });
      const ids = this.completedWorkouts.map(r => r.id).sort().join(',');
      let h = 0;
      for (let i = 0; i < ids.length; i++) h = (h * 31 + ids.charCodeAt(i)) | 0;
      const healthDays = this.healthStore && this.healthStore.days ? Object.keys(this.healthStore.days).length : 0;
      return [this.completedWorkouts.length, h, samples, Math.round(tss), JSON.stringify(this.profiles || []).length, this.loadSavedWorkouts().length, healthDays].join('|');
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
      if (window.VeloStorage?.enabled) {
        try {
          await VeloStorage.flush();
          const saved = force ? await VeloStorage.request('/backup', {}) : null;
          this._localBackupInfo = await VeloStorage.request('/backups');
          this._backupError = this._localBackupInfo.error;
          this.renderBackupStatus();
          return { ok: true, name: saved?.name, skipped: !force };
        } catch (e) { this._backupError = e.message; this.renderBackupStatus(); return { ok: false, error: e.message }; }
      }
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
      if (window.VeloStorage?.enabled) {
        const info = this._localBackupInfo;
        const latest = info?.files.find(f => !f.corrupt && !f.name.startsWith('legacy:'));
        el.textContent = this._backupError ? `Backup needs attention: ${this._backupError}` : latest
          ? `Last backup ${new Date(latest.at).toLocaleString()} · ${latest.rides} rides · ${info.files.filter(f => !f.corrupt).length} copies`
          : 'Automatic backups start after your first save. You can also back up now.';
        el.title = info?.dir || ''; el.classList.toggle('backup-warn', !!this._backupError); return;
      }
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
      this.on(document.getElementById('btnListBackups'), 'click', () => this.showLocalBackups());
      this.on(document.getElementById('btnOpenBackupFile'), 'click', () => document.getElementById('localBackupFile').click());
      this.on(document.getElementById('localBackupFile'), 'change', async e => {
        const file = e.target.files[0]; e.target.value = '';
        if (!file || !window.VeloStorage?.enabled) return;
        try {
          if (file.size > 200 * 1024 * 1024) throw new Error('This backup is too large.');
          const text = file.name.endsWith('.gz') ? await new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).text() : await file.text();
          const imported = await VeloStorage.request('/import-backup', { backup: JSON.parse(text) });
          await this.showLocalBackups();
          const button = [...document.querySelectorAll('[data-restore-backup]')].find(b => b.dataset.restoreBackup === imported.name);
          if (button) await this.restoreLocalBackup(imported.name, button);
        } catch (err) { this.showToast(`Could not open this backup: ${err.message}`, 'error'); }
      });
      this.on(document.getElementById('localBackupList'), 'click', async e => {
        const button = e.target.closest('[data-restore-backup]');
        if (button) await this.restoreLocalBackup(button.dataset.restoreBackup, button);
      });
      if (window.VeloStorage?.enabled) {
        this.runAutoBackup();
        const poll = setInterval(() => this.runAutoBackup(), 30000);
        this._disposers.push(() => clearInterval(poll));
      }
      // Daily safety net even when nothing changed (the history loads a moment after start).
      this.scheduleAutoBackup(20000);
    },

    async showLocalBackups() {
      const el = document.getElementById('localBackupList');
      if (!el) return;
      el.hidden = false;
      if (!window.VeloStorage?.enabled) { el.textContent = 'Start the updated launcher to browse saved backups on this PC.'; return; }
      el.textContent = 'Checking backups...';
      try {
        const info = await VeloStorage.request('/backups');
        el.innerHTML = info.files.length ? info.files.map(f => `<div class="settings-kv"><span>${f.corrupt ? 'Unreadable backup' : esc(new Date(f.at).toLocaleString()) + ' · ' + f.rides + ' rides · ' + esc(f.reason)}${f.name.startsWith('legacy:') ? ' · old app folder' : ''}</span><button type="button" class="btn btn-xs" data-restore-backup="${esc(f.name)}" ${f.corrupt ? 'disabled' : ''}>Preview &amp; restore</button></div>`).join('') : 'No backups yet. Press Back up now.';
      } catch(e) { el.textContent = e.message; }
    },

    async restoreLocalBackup(name, button) {
      if (this.hasUnsavedRide()) { this.showToast('Finish or discard the current ride before restoring a backup.', 'warning'); return; }
      button.disabled = true;
      try {
        await VeloStorage.flush();
        const preview = await VeloStorage.request('/preview', { name });
        const question = `Restore the backup from ${new Date(preview.at).toLocaleString()}?\n\n${preview.rides} rides, ${preview.samples} samples, ${preview.profiles} profiles${preview.verified ? ', with verified checksum' : ' (legacy backup)'}.\n\nThis replaces the current saved history and included settings. A safety backup is made first. The app will reload.`;
        if (!confirm(question)) return;
        await VeloStorage.enqueue({ name }, '/restore');
        location.reload();
      } catch(e) { this.showToast(`Restore stopped: ${e.message}`, 'error'); }
      finally { button.disabled = false; }
    }
  });
})();
