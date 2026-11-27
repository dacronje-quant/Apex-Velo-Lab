/**
 * APEX VELO // LAB - Desktop Home Server Sync UI + Live Auto-Refresh (mixin on VeloApp).
 *
 * Listens for server-sent sync events (/api/sync/events) when Android syncs a ride, health day,
 * training plan or AI coach message, and refreshes the open Desktop tab smoothly without 409 reloads
 * (deferring automatically while a ride is actively recording).
 */
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  Object.assign(VeloApp.prototype, {
    initHomeSync() {
      if (window.__APEX_TEST_MODE__ || window.__APEX_DEMO_MODE__ || document.documentElement.classList.contains('apex-native')) return;
      const on = (id, fn) => this.on(document.getElementById(id), 'click', fn);
      on('btnSyncCopyLink', () => this.copyText && this.copyText(this._syncStatus?.pairingUris?.[0], 'Pairing link copied.'));
      on('btnSyncCopyUrl', () => this.copyText && this.copyText(this._syncStatus?.urls?.[0], 'Server URL copied.'));
      on('btnSyncCopyToken', () => this.copyText && this.copyText(this._syncStatus?.token, 'Sync token copied.'));
      on('btnSyncNewToken', async () => {
        if (!confirm('Rotate the sync token? Paired Android devices will need to re-pair using the new link or QR code.')) return;
        try {
          const r = await fetch('api/sync/token', { method: 'POST', cache: 'no-store' });
          if (!r.ok) throw new Error(r.status);
          this._syncStatus = await r.json();
          this.renderSyncSettings(this._syncStatus);
          this.showToast('New sync token created.', 'success');
        } catch (e) {
          this.showToast('Could not rotate sync token.', 'error');
        }
      });

      if (typeof EventSource === 'function' && window.VeloStorage?.enabled) {
        const es = new EventSource('api/sync/events');
        es.addEventListener('sync', (ev) => {
          let data = null;
          try { data = JSON.parse(ev.data || 'null'); } catch { /* ignore */ }
          if (!data || (Number.isSafeInteger(data.revision) && data.revision <= VeloStorage.revision)) return;
          this.scheduleLiveServerSync();
        });
        this._disposers.push(() => { try { es.close(); } catch { /* ignore */ } });
      }
    },

    scheduleLiveServerSync() {
      clearTimeout(this._liveSyncTimer);
      this._liveSyncTimer = setTimeout(() => {
        if (this.isPlaying || (this.hasUnsavedRide && this.hasUnsavedRide()) || (window.VeloStorage?.pending?.length)) {
          this.scheduleLiveServerSync();
          return;
        }
        this.applyLiveServerSync().catch(() => {});
      }, 400);
    },

    async applyLiveServerSync() {
      if (!window.VeloStorage?.reloadFromServer || this._liveSyncBusy) return;
      this._liveSyncBusy = true;
      try {
        const state = await VeloStorage.reloadFromServer();
        if (!state || !Array.isArray(state.rides)) return;
        this.completedWorkouts = structuredClone(state.rides);
        this.profiles = this.loadProfiles ? this.loadProfiles() : this.profiles;
        if (this.setActiveProfile && state.settings?.apex_velo_active_prof_id) {
          const id = state.settings.apex_velo_active_prof_id;
          if (this.profiles.some((p) => p.id === id)) this.setActiveProfile(id, false);
        }
        if (this.loadHealthStore && this.refreshHealthDerived) {
          this.healthStore = this.loadHealthStore();
          this.refreshHealthDerived();
        }
        if (this.blockPlanner && window.VeloBlockPlanner) {
          this.blockPlanner.block = VeloBlockPlanner.load();
          if (this.renderTrainingBlock) this.renderTrainingBlock();
        }
        if (this._coachReady) {
          try {
            const s = JSON.parse(localStorage.getItem('apex_ask_v1') || 'null');
            if (s && Array.isArray(s.messages)) {
              this.askMessages = s.messages;
              this.askClearedAt = Number(s.clearedAt) || 0;
              if (s.period) this.askPeriod = s.period;
              if (s.from !== undefined) this.askFrom = s.from;
              if (s.to !== undefined) this.askTo = s.to;
              this._coachShown = this.askMessages.length;
              if (this.renderAskThread) this.renderAskThread();
            }
          } catch { /* ignore */ }
        }
        this.renderHistoryTable && this.renderHistoryTable();
        this.recalculatePmc && this.recalculatePmc();
        this.refreshAnalytics && this.refreshAnalytics();
        this.renderCalendarView && this.renderCalendarView();
        this.renderRiderSummary && this.renderRiderSummary();
        this.updateHeroStats && this.updateHeroStats();
        this.showToast && this.showToast('Synced updates from your phone.', 'info');
      } finally {
        this._liveSyncBusy = false;
      }
    },

    async renderSyncSettings(status) {
      const box = document.getElementById('syncStatusBox');
      const qrWrap = document.getElementById('syncQrWrap');
      if (!box) return;
      let st = status;
      if (!st) {
        try {
          const r = await fetch('api/sync/status', { cache: 'no-store' });
          if (!r.ok) throw new Error(r.status);
          st = await r.json();
          this._syncStatus = st;
        } catch (e) {
          box.innerHTML = '<span class="backup-warn">Home server sync status is unavailable on this view.</span>';
          if (qrWrap) qrWrap.innerHTML = '';
          return;
        }
      }
      const when = st.lastSyncAt ? new Date(st.lastSyncAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never';
      const kv = (k, v) => `<div><span>${esc(k)}</span><b>${v}</b></div>`;
      box.innerHTML = [
        kv('Tailscale mode', st.tailscaleEnabled ? 'Enabled' : 'Local Wi-Fi only (set <code>APEX_ALLOW_TAILSCALE=1</code> in <code>.env</code>)'),
        kv('Primary URL', `<code>${esc((st.urls && st.urls[0]) || '')}</code>`),
        kv('Rides / Wellness', `${st.ridesCount} rides &middot; ${st.wellnessDaysCount} wellness entries`),
        kv('Last sync', `${esc(when)}${st.lastClient ? ` <small class="dim">(${esc(st.lastClient)})</small>` : ''}`),
        kv('Sync token', `<code>${esc(st.token || '')}</code>`)
      ].join('');
      if (qrWrap) {
        const uri = st.pairingUris && st.pairingUris[0];
        if (uri && typeof window.qrcode === 'function') {
          try {
            const q = window.qrcode(0, 'M');
            q.addData(uri);
            q.make();
            qrWrap.innerHTML = `<img class="phone-qr" alt="QR code to pair Android APK" src="${q.createDataURL(4, 2)}"><p class="field-help">Open this link or scan on Android to pair Home Server Sync.</p>`;
          } catch { qrWrap.innerHTML = ''; }
        } else {
          qrWrap.innerHTML = '';
        }
      }
    }
  });
})();
