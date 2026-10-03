/**
 * APEX VELO // LAB - Settings screen (mixin on VeloApp).
 *
 * One place for everything that is set up once: rider profile, AI engine, Apple Health,
 * automatic backups and the phone-view address. Opened with the gear in the header.
 */
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  Object.assign(VeloApp.prototype, {
    initSettings() {
      const on = (id, fn) => this.on(document.getElementById(id), 'click', fn);
      const welcome = document.getElementById('firstRunHelp');
      if (welcome) welcome.hidden = !(window.__APEX_DEMO_MODE__ || (this.isNewInstallation && !window.__APEX_TEST_MODE__ && !localStorage.getItem('apex_setup_dismissed')));
      on('btnSetupProfile', () => { this.openModal('profileManagerModal'); this.populateEditProfile(this.activeProfileId); });
      on('btnDismissSetup', () => { localStorage.setItem('apex_setup_dismissed', '1'); welcome.hidden = true; });
      if (window.__APEX_DEMO_MODE__) {
        document.getElementById('firstRunTitle').textContent = 'Demo playground';
        document.getElementById('firstRunText').textContent = 'These rides are synthetic. Demo storage is separate from your real rides; server connections and Bluetooth pairing are disabled.';
        const link = document.getElementById('btnOpenDemo'); link.href = location.pathname; link.removeAttribute('target'); link.textContent = 'Return to my app';
        const hardware = document.getElementById('btnOpenHardwareModal'); if (hardware) hardware.disabled = true;
      }
      on('btnOpenSettings', () => this.openSettings());
      document.querySelectorAll('[data-training-guide]').forEach(b => this.on(b, 'click', () => this.openSettings('guide')));
      on('btnCloseSettings', () => this.closeModal('settingsModal'));
      on('btnSettingsEditRider', () => { this.closeModal('settingsModal'); this.openModal('profileManagerModal'); });
      document.querySelectorAll('#settingsNav [data-sec]').forEach(b => this.on(b, 'click', () => this.showSettingsSection(b.dataset.sec)));
      const modal = document.getElementById('settingsModal');
      if (modal) this.on(modal, 'click', (e) => { if (e.target === modal) this.closeModal('settingsModal'); });
    },

    openSettings(section) {
      this.openModal('settingsModal');
      this.showSettingsSection(section || this._settingsSection || 'rider');
    },

    showSettingsSection(sec) {
      this._settingsSection = sec;
      document.querySelectorAll('#settingsNav [data-sec]').forEach(b => b.classList.toggle('active', b.dataset.sec === sec));
      document.querySelectorAll('#settingsModal .settings-section').forEach(s => s.classList.toggle('active', s.dataset.sec === sec));
      if (sec === 'rider') this.renderRiderSummary();
      else if (sec === 'health') {
        this.renderHealthSettings();
        if (this.pullHealthInbox) this.pullHealthInbox().then((r) => { if (r && r.added) this.renderHealthSettings(this._healthStatus); }).catch(() => {});
      } else if (sec === 'backups' && this.renderBackupStatus) this.renderBackupStatus();
      else if (sec === 'phone') this.renderPhoneAddress();
    },

    renderRiderSummary() {
      const el = document.getElementById('settingsRiderSummary');
      if (!el) return;
      const p = this.activeProfile || {};
      const kv = (k, v) => `<div><span>${esc(k)}</span><b class="num">${esc(v)}</b></div>`;
      el.innerHTML = [
        kv('Rider', p.name || '--'),
        kv('FTP', p.ftp ? `${p.ftp} W` : '--'),
        kv('Weight', p.weightKg ? `${p.weightKg} kg` : '--'),
        kv('W/kg', p.ftp && p.weightKg ? (p.ftp / p.weightKg).toFixed(2) : '--'),
        kv('Max HR', p.maxHr ? `${p.maxHr} bpm` : '--'),
        kv('Threshold HR', p.lthr ? `${p.lthr} bpm` : 'not set')
      ].join('');
    },

    async renderPhoneAddress() {
      const el = document.getElementById('phoneViewAddress');
      if (!el) return;
      const st = this.fetchHealthStatus ? await this.fetchHealthStatus() : null;
      if (!st) { el.innerHTML = `<span class="backup-warn">${esc(this._healthStatusError || 'The local server is not reachable.')}</span>`; return; }
      const urls = st.phoneUrls || [];
      el.innerHTML = urls.length
        ? urls.map(u => `<div><span>On your phone</span><b><code>${esc(u)}</code></b></div>`).join('')
        : '<span class="backup-warn">Phone access is off - run Enable-Phone-View.bat once on this PC, then restart the launcher.</span>';
    }
  });
})();
