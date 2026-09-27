/**
 * APEX VELO // LAB - Apple Health recovery data and daily readiness (mixin on VeloApp).
 *
 * Health Auto Export on the iPhone POSTs resting HR, HRV and sleep to the local server, which keeps
 * the payloads in data\health\inbox. This mixin collects them (at start-up, every 10 minutes and
 * when Settings opens), folds them into one record per day (js/velo-health.js - duplicates never
 * count twice), stores that in this browser and in the automatic backups, and then tells the server
 * to delete the processed payloads. Readiness is advisory only - it never blocks a workout.
 */
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STORE_KEY = 'apex_health_v1';
  const PULL_EVERY_MS = 10 * 60 * 1000;

  const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  Object.assign(VeloApp.prototype, {
    initHealth() {
      this.healthStore = this.loadHealthStore();
      this.refreshHealthDerived();
      const on = (id, fn) => this.on(document.getElementById(id), 'click', fn);
      on('btnHealthRefresh', () => this.pullHealthInbox({ force: true, announce: true }).then(() => this.renderHealthSettings()));
      on('btnHealthCopyUrl', () => this.copyText(this._healthStatus && this._healthStatus.urls && this._healthStatus.urls[0], 'URL copied.'));
      on('btnHealthCopyToken', () => this.copyText(this._healthStatus && this._healthStatus.token, 'Token copied.'));
      on('btnHealthNewToken', async () => {
        if (!confirm('Make a new token? Health Auto Export stops working until you paste the new one into its Authorization header.')) return;
        try {
          const r = await fetch('api/health/token', { method: 'POST', cache: 'no-store' });
          if (!r.ok) throw new Error(r.status);
          this._healthStatus = await r.json();
          this.renderHealthSettings(this._healthStatus);
          this.showToast('New token made - update it in Health Auto Export.', 'success');
        } catch (e) { this.showToast('Could not make a new token - is the local server running?', 'error'); }
      });
      on('cockpitReadinessChip', () => this.showReadinessDetail());
      on('coachReadinessChip', () => this.showReadinessDetail());
      on('anaReadinessChip', () => this.showReadinessDetail());
      if (window.__APEX_TEST_MODE__) return;
      setTimeout(() => this.pullHealthInbox().catch(() => {}), 1500);
      const id = setInterval(() => this.pullHealthInbox().catch(() => {}), PULL_EVERY_MS);
      this._disposers.push(() => clearInterval(id));
    },

    loadHealthStore() {
      try {
        const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
        if (s && s.days && typeof s.days === 'object') return s;
      } catch (e) { /* ignore */ }
      return VeloHealth.emptyStore();
    },

    saveHealthStore() {
      VeloHealth.compact(this.healthStore, localDay());
      try { localStorage.setItem(STORE_KEY, JSON.stringify(this.healthStore)); } catch (e) { /* storage full - kept in memory */ }
    },

    /** Recomputes the per-day records and everything that shows them. */
    refreshHealthDerived() {
      this.healthDays = VeloHealth.daily(this.healthStore);
      this.renderReadinessChips();
    },

    healthToday() { return localDay(); },

    healthReadiness() { return VeloHealth.readiness(this.healthDays || [], localDay()); },

    /** Adds the Apple Health data from a restored backup (days already here are kept). */
    restoreHealthStore(h) {
      if (!h || !h.days) return 0;
      let n = 0;
      for (const [day, rec] of Object.entries(h.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !rec || typeof rec !== 'object') continue;
        if (!this.healthStore.days[day]) { this.healthStore.days[day] = rec; n++; }
      }
      if (n) { this.saveHealthStore(); this.refreshHealthDerived(); this.afterHealthChange(); }
      return n;
    },

    /** Applies one Health Auto Export payload. Returns the number of new readings. */
    ingestHealthPayload(body) {
      const parsed = VeloHealth.parsePayload(body);
      const { store, added } = VeloHealth.merge(this.healthStore, parsed);
      this.healthStore = store;
      return { added, ignored: parsed.ignored, found: parsed.rhr.length + parsed.hrv.length + parsed.sleep.length };
    },

    /** Collects the payloads waiting on the server, stores them, then lets the server delete them. */
    async pullHealthInbox({ force = false, announce = false } = {}) {
      if (this._healthBusy || (window.__APEX_TEST_MODE__ && !force)) return { ok: false };
      this._healthBusy = true;
      let added = 0, files = 0;
      try {
        for (let round = 0; round < 50; round++) {
          const r = await fetch('api/health/inbox', { cache: 'no-store' });
          if (!r.ok) throw Object.assign(new Error('inbox ' + r.status), { status: r.status });
          const j = await r.json();
          const list = Array.isArray(j.files) ? j.files : [];
          if (!list.length) break;
          for (const f of list) {
            if (f && f.body) added += this.ingestHealthPayload(f.body).added;
            files++;
          }
          this.saveHealthStore();   // stored before the server deletes anything
          await fetch('api/health/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names: list.map(f => f.name) }), cache: 'no-store' });
          if (!j.remaining) break;
        }
        this._healthError = null;
      } catch (e) {
        this._healthError = e.status === 404 || e.status === 405 ? 'Restart Launch-Apex-Velo.bat to enable Apple Health sync.'
          : e.status === 403 ? 'Apple Health data can only be read by the app on this PC.' : 'Local server not reachable.';
      } finally {
        this._healthBusy = false;
      }
      if (added) {
        this.refreshHealthDerived();
        this.afterHealthChange();
        if (this.scheduleAutoBackup) this.scheduleAutoBackup();
      }
      if (announce) this.showToast(this._healthError || (files ? `Apple Health: ${files} export${files === 1 ? '' : 's'}, ${added} new reading${added === 1 ? '' : 's'}.` : 'Apple Health: nothing new waiting.'), this._healthError ? 'warning' : 'info');
      return { ok: !this._healthError, added, files };
    },

    /** Redraws the views that show recovery data. */
    afterHealthChange() {
      if (this.activeTab === 'calendar' && this.renderCalendarView) this.renderCalendarView();
      if (this.activeTab === 'analytics' && this.refreshAnalytics) this.refreshAnalytics();
      if (this.activeTab === 'ai-coach' && this.updateAiCoachTelemetry) this.updateAiCoachTelemetry();
    },

    readinessText(r) {
      if (r.level === 'baseline') return r.label;
      if (r.level === 'none' || r.level === 'stale') return r.label;
      return `${r.label}${r.stale ? ' (yesterday)' : ''}`;
    },

    renderReadinessChips() {
      const r = this.healthReadiness();
      const text = `Readiness: ${this.readinessText(r)}`;
      const title = r.reasons && r.reasons.length ? `${r.advice}\n- ${r.reasons.join('\n- ')}` : (r.advice || (r.level === 'baseline' ? 'Needs 7 nights of HRV from your Apple Watch.' : 'Set up Apple Health in Settings.'));
      ['cockpitReadinessChip', 'coachReadinessChip', 'anaReadinessChip'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = text;
        el.dataset.level = r.level;
        el.title = title;
      });
      const ck = document.getElementById('cockpitReadinessChip');
      // Shown before a ride only, and only once Apple Health data exists.
      if (ck) ck.hidden = r.level === 'none' || !!this.isPlaying || (this.totalElapsedSeconds || 0) > 0;
    },

    showReadinessDetail() {
      const r = this.healthReadiness();
      if (r.level === 'none') { this.openSettings && this.openSettings('health'); return; }
      const lines = [this.readinessText(r)];
      if (r.advice) lines.push(r.advice);
      if (r.reasons && r.reasons.length) lines.push(r.reasons.join('. ') + '.');
      else if (r.level === 'green') lines.push('HRV, resting HR and sleep are all within your normal range.');
      this.showToast(lines.join(' '), r.level === 'red' ? 'warning' : 'info');
    },

    copyText(text, done) {
      if (!text) { this.showToast('Nothing to copy yet - is the local server running?', 'warning'); return; }
      const ok = () => this.showToast(done, 'success');
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, () => window.prompt('Copy this:', text));
      else window.prompt('Copy this:', text);
    },

    async fetchHealthStatus() {
      try {
        const r = await fetch('api/health/status', { cache: 'no-store' });
        if (!r.ok) throw Object.assign(new Error(String(r.status)), { status: r.status });
        this._healthStatus = await r.json();
        this._healthStatusError = null;
      } catch (e) {
        this._healthStatus = null;
        this._healthStatusError = e.status === 404 || e.status === 405 ? 'Restart Launch-Apex-Velo.bat - this server version does not have Apple Health sync yet.'
          : e.status === 403 ? 'Open the app on this PC (http://localhost) to set up Apple Health.' : 'The local server is not reachable - start Launch-Apex-Velo.bat.';
      }
      return this._healthStatus;
    },

    /** Settings > Apple Health: live status and the setup steps with this PC's real address filled in. */
    async renderHealthSettings(status) {
      const st = status || await this.fetchHealthStatus();
      const box = document.getElementById('healthStatus');
      const steps = document.getElementById('healthSetupSteps');
      if (!box || !steps) return;
      const days = this.healthDays || [];
      const last = days[days.length - 1];
      const r = this.healthReadiness();
      if (!st) {
        box.innerHTML = `<span class="backup-warn">${esc(this._healthStatusError)}</span>`;
        steps.innerHTML = '';
        return;
      }
      const url = (st.urls && st.urls[0]) || `http://<this PC's address>:${st.port}/api/health`;
      const when = st.lastReceived ? new Date(st.lastReceived).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never';
      const kv = (k, v) => `<div><span>${esc(k)}</span><b>${v}</b></div>`;
      box.innerHTML = [
        kv('Last received', esc(when) + (st.received ? ` <small class="dim">(${st.received} exports)</small>` : '')),
        kv('Days stored', `${days.length}${last ? ` <small class="dim">latest ${esc(last.day)}</small>` : ''}`),
        kv('Readiness', esc(this.readinessText(r))),
        kv('Waiting on the server', String(st.inbox || 0)),
        kv('URL', `<code>${esc(url)}</code>`),
        kv('Token', `<code>${esc(st.token)}</code>`)
      ].join('');
      const noLan = !(st.urls && st.urls.length);
      steps.innerHTML = [
        noLan ? '<li class="backup-warn">Phone access is off: run <code>Enable-Phone-View.bat</code> once on this PC, then restart the launcher.</li>' : '',
        '<li>On the iPhone install <b>Health Auto Export</b> and allow it to read <b>Resting Heart Rate</b>, <b>Heart Rate Variability</b> and <b>Sleep Analysis</b>. Automations need its Premium tier.</li>',
        `<li>In Health Auto Export: <b>Automations &rsaquo; New automation &rsaquo; REST API</b>. URL: <code>${esc(url)}</code></li>`,
        `<li>Add a header - key <code>Authorization</code>, value <code>Bearer ${esc(st.token)}</code></li>`,
        '<li>Data type <b>Health Metrics</b>; select Resting Heart Rate, Heart Rate Variability and Sleep Analysis. Export format <b>JSON</b>, version 2. Date range: <b>Since last sync</b> (first time: last 60 days, so readiness has a baseline straight away). Sleep: aggregated is fine.</li>',
        '<li>Sync cadence: <b>every hour</b>, and turn the automation on. If iOS asks to find devices on your local network, tap <b>Allow</b>.</li>',
        '<li>Tap <b>Manual export</b> once, then <b>Check now</b> here - "Last received" should update.</li>'
      ].join('');
    },

    /** Calendar helpers: recovery values and flags for a day, and averages for a period. */
    healthForDay(day) {
      const rec = (this.healthDays || []).find(r => r.day === day);
      if (!rec) return null;
      return { rec, flags: VeloHealth.dayFlags(this.healthDays, day) || {} };
    },

    healthPeriod(from, to) { return VeloHealth.periodAverages(this.healthDays || [], from, to); },

    localDayKey(d) { return localDay(d); }
  });
})();
