/**
 * APEX VELO // LAB - "Sync from Hevy" (mixin on VeloApp).
 *
 * Fetches strength workouts from GET /api/hevy/workouts, replaces any matching
 * Strava-imported strength duplicates while preserving heart rate/calories, and writes
 * atomically through VeloDB + VeloStorage.
 */
(function () {
  const H = () => VeloHevySync;
  const readJson = (key, fallback) => {
    try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v === null ? fallback : v; } catch (e) { return fallback; }
  };
  const rawGet = (key) => { try { return localStorage.getItem(key); } catch (e) { return null; } };

  Object.assign(VeloApp.prototype, {
    initHevySyncUi() {
      this._hevySyncChoice = H().normaliseChoice(readJson(H().RANGE_KEY, null));
      this._hevyConfigured = false;
      const sel = document.getElementById('hevySyncRange');
      const from = document.getElementById('hevySyncFrom');
      const to = document.getElementById('hevySyncTo');
      if (sel) {
        sel.value = this._hevySyncChoice.mode === 'custom' ? 'custom' : String(this._hevySyncChoice.weeks);
        this.on(sel, 'change', () => this.onHevyRangeChange());
      }
      if (from && to) {
        const r = H().rangeFor(this._hevySyncChoice);
        const lastDay = new Date(r.beforeMs - 86400000);
        from.value = this._hevySyncChoice.from || H().dayKey(new Date(r.afterMs));
        to.value = this._hevySyncChoice.to || H().dayKey(lastDay);
        this.on(from, 'change', () => this.onHevyRangeChange());
        this.on(to, 'change', () => this.onHevyRangeChange());
      }
      this.on(document.getElementById('btnHevySync'), 'click', () => this.syncFromHevy());
      const skip = document.getElementById('chkHevySkipStravaStrength');
      if (skip) {
        skip.checked = rawGet(H().SKIP_STRAVA_STRENGTH_KEY) !== 'false';
        this.on(skip, 'change', () => this.setHevySkipStravaStrength(skip.checked));
      }
      this.hevyRangeUiState();
      if (!window.__APEX_DEMO_MODE__ && !window.__APEX_TEST_MODE__) {
        this.refreshHevyStatus().catch(() => {});
      }
    },

    onHevyRangeChange() {
      const sel = document.getElementById('hevySyncRange');
      const v = sel ? sel.value : String(H().DEFAULT_WEEKS);
      const choice = v === 'custom'
        ? { mode: 'custom', from: (document.getElementById('hevySyncFrom') || {}).value, to: (document.getElementById('hevySyncTo') || {}).value }
        : { mode: 'preset', weeks: Number(v) };
      this._hevySyncChoice = H().normaliseChoice(choice);
      try { localStorage.setItem(H().RANGE_KEY, JSON.stringify(v === 'custom' ? { mode: 'custom', from: choice.from, to: choice.to } : this._hevySyncChoice)); } catch (e) { /* ignore */ }
      this.hevyRangeUiState();
    },

    hevyRangeUiState() {
      const custom = (document.getElementById('hevySyncRange') || {}).value === 'custom';
      const box = document.getElementById('hevySyncCustom');
      if (box) box.hidden = !custom;
      const lbl = document.getElementById('hevySyncRangeLabel');
      if (lbl) lbl.textContent = H().rangeFor(this._hevySyncChoice).label;
    },

    hevySkipStravaStrength() {
      return !!this._hevyConfigured && rawGet(H().SKIP_STRAVA_STRENGTH_KEY) !== 'false';
    },

    setHevySkipStravaStrength(on) {
      try { localStorage.setItem(H().SKIP_STRAVA_STRENGTH_KEY, on ? 'true' : 'false'); } catch (e) { /* ignore */ }
      this.showToast(
        on
          ? 'Strava sync will skip strength sessions so they only come from Hevy.'
          : 'Strava sync will include strength sessions (still matched against Hevy to avoid duplicates).',
        'info'
      );
    },

    setHevyProgress(text, busy = true) {
      const el = document.getElementById('hevySyncProgress');
      if (el) { el.textContent = text || ''; el.classList.toggle('is-busy', !!busy && !!text); }
      const btn = document.getElementById('btnHevySync');
      if (btn) { btn.disabled = !!busy && !!text; btn.classList.toggle('is-loading', !!busy && !!text); }
    },

    async refreshHevyStatus() {
      const chip = document.getElementById('hevyKeyChip');
      const statusEl = document.getElementById('hevySyncStatus');
      try {
        const r = await fetch('api/hevy/status', { method: 'GET', cache: 'no-store' });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        this._hevyConfigured = !!j.configured;
        if (chip) {
          chip.textContent = j.configured ? 'Key ready' : 'Key not set';
          chip.classList.toggle('chip-cyan', !!j.configured);
          chip.classList.toggle('chip-ghost', !j.configured);
        }
        if (statusEl && !statusEl.dataset.synced) {
          statusEl.textContent = j.configured
            ? 'HEVY_API_KEY loaded from local server.'
            : 'Add HEVY_API_KEY to .env and restart the server.';
        }
        return j;
      } catch (e) {
        this._hevyConfigured = false;
        if (chip) { chip.textContent = 'Server offline'; chip.classList.remove('chip-cyan'); chip.classList.add('chip-ghost'); }
        return null;
      }
    },

    async syncFromHevy(choice) {
      if (this._hevySyncBusy) return { ok: false };
      if (window.__APEX_DEMO_MODE__) {
        this.showToast('Hevy sync is disabled in Demo mode.', 'info');
        return { ok: false };
      }
      this._hevySyncBusy = true;
      const c = H().normaliseChoice(choice || this._hevySyncChoice);
      const range = H().rangeFor(c);
      this.setHevyProgress('Reading workouts from Hevy...');
      const statusEl = document.getElementById('hevySyncStatus');
      try {
        const r = await fetch(`api/hevy/workouts?after=${encodeURIComponent(range.afterIso)}&before=${encodeURIComponent(range.beforeIso)}`, {
          method: 'GET', cache: 'no-store'
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `Hevy sync failed (HTTP ${r.status}).`);
        this._hevyConfigured = true;
        const p = this.activeProfile || {};
        const plan = H().plan({
          workouts: j.workouts || [],
          history: this.completedWorkouts,
          range,
          opts: { profileName: p.name || '' }
        });
        if (!plan.hasChanges) {
          const msg = `Hevy up to date (${plan.fetched} workout${plan.fetched === 1 ? '' : 's'} checked).`;
          if (statusEl) { statusEl.textContent = msg; statusEl.dataset.synced = '1'; }
          this.showToast(msg, 'info');
          return { ok: true, plan };
        }
        const next = H().nextState(this.completedWorkouts, plan);
        const dbOk = await VeloDB.applyRideChanges(next.put, next.del);
        if (!dbOk) throw new Error('Could not save Hevy workouts to the local database.');
        if (this.writeHistoryLocal) this.writeHistoryLocal(next.history);
        if (window.VeloStorage?.enabled) await VeloStorage.flush();
        this.completedWorkouts = next.history;
        if (this.afterHistoryReplaced) this.afterHistoryReplaced();
        if (this.reviewTrainingBlock) this.reviewTrainingBlock({ announce: true });
        const parts = [];
        if (plan.added.length) parts.push(`${plan.added.length} added`);
        if (plan.replaced.length) parts.push(`${plan.replaced.length} replaced Strava duplicate${plan.replaced.length === 1 ? '' : 's'}`);
        if (plan.updated.length) parts.push(`${plan.updated.length} updated`);
        if (plan.removed.length) parts.push(`${plan.removed.length} removed`);
        const summary = `Hevy sync complete: ${parts.join(', ')}.`;
        if (statusEl) { statusEl.textContent = summary; statusEl.dataset.synced = '1'; }
        this.refreshHevyStatus().catch(() => {});
        this.showToast(summary, 'success');
        return { ok: true, plan };
      } catch (e) {
        const msg = e.message || String(e);
        if (statusEl) statusEl.textContent = msg;
        this.showToast(msg, 'error');
        return { ok: false, error: msg };
      } finally {
        this._hevySyncBusy = false;
        this.setHevyProgress('', false);
      }
    }
  });
})();
