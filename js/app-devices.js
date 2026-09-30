/** Devices UI: a single setup view over the existing BLE protocol adapters.
 * Internal `pedals` IDs remain compatible with saved devices, rides and phone commands.
 */
(function () {
  const KINDS = ['trainer', 'pedals', 'hr', 'fan'];
  const LABELS = { trainer: 'Trainer / smart bike', pedals: 'Power meter', hr: 'Heart-rate sensor', fan: 'HEADWIND fan' };
  const BUTTONS = { trainer: 'btnConnectTrainerModal', pedals: 'btnConnectPedalsModal', hr: 'btnConnectHrModal', fan: 'btnConnectFanModal' };
  const STATUS = { trainer: 'hwTrainerStatusBadge', pedals: 'hwPedalStatusBadge', hr: 'hwHrStatusBadge', fan: 'hwFanStatusBadge' };
  const readPrefs = () => { try { return JSON.parse(localStorage.getItem('apex_device_sources') || '{}') || {}; } catch (e) { return {}; } };

  Object.assign(VeloApp.prototype, {
    initDevicesUi() {
      const p = readPrefs();
      this.powerSourcePreference = ['auto', 'pedals', 'trainer'].includes(p.power) ? p.power : 'auto';
      this.cadenceSourcePreference = ['auto', 'pedals', 'trainer'].includes(p.cadence) ? p.cadence : 'auto';
      this.fanMode = 'manual'; // automatic airflow is always opt-in for this session
      this.fanStatus = 'Connect HEADWIND to control airflow. Connecting does not change its setting.';
      this._devicesBatchToken = 0;
      this._devicesConnectingAll = false;
      const modal = this.$('hardwareModal');
      if (!modal) return;
      modal.hidden = true;
      this.on(this.$('btnConnectSavedDevices'), 'click', () => this.connectSavedDevices());
      this.on(this.$('btnStopDeviceConnections'), 'click', () => this.stopDeviceConnections());
      this.on(this.$('btnPairDevice'), 'click', () => this.connectDevice(this.$('deviceTypeSelect').value, { replace: true }));
      this.on(this.$('btnPairDeviceBroad'), 'click', () => this.connectDevice(this.$('deviceTypeSelect').value, { acceptAll: true, replace: true }));
      this.on(this.$('btnConnectFanModal'), 'click', () => this.connectSavedDevice('fan'));
      KINDS.forEach(kind => {
        this.on(this.$(`deviceStop-${kind}`), 'click', () => { this.disconnectDeviceKind(kind); this.renderDevicesPanel(); });
        this.on(this.$(`deviceReplace-${kind}`), 'click', () => this.connectDevice(kind, { replace: true }));
        this.on(this.$(`deviceForget-${kind}`), 'click', () => {
          if (!confirm(`Forget ${this.deviceLabel(kind)} in Apex? Browser Bluetooth permission stays unchanged; you can pair it again.`)) return;
          this.ble.forget(kind);
          this.showToast('Device forgotten in Apex. Manage Bluetooth permissions in browser site settings if needed.');
          this.renderDevicesPanel();
          if (this.publishSoon) this.publishSoon();
        });
        this.on(this.$(`deviceRename-${kind}`), 'click', () => {
          const alias = this.$(`deviceAlias-${kind}`).value;
          try { this.ble.rename(kind, alias); this.showToast('Device name saved.'); } catch (e) { this.showToast('Could not save the device name.', 'error'); }
          this.renderDevicesPanel();
        });
      });
      ['Power', 'Cadence'].forEach(name => {
        const select = this.$(`device${name}Source`);
        if (select) select.value = this[`${name.toLowerCase()}SourcePreference`];
        this.on(select, 'change', e => this.setDeviceSource(name.toLowerCase(), e.target.value));
      });
      this.on(this.$('fanSpeedSlider'), 'input', e => this.setText('fanSpeedPreview', `${e.target.value}% requested`));
      this.on(this.$('fanSpeedSlider'), 'change', e => this.setFanAirflow(Number(e.target.value)));
      [0, 25, 50, 75, 100].forEach(speed => this.on(this.$(`fanPreset${speed}`), 'click', () => this.setFanAirflow(speed)));
      this.on(this.$('fanModeSelect'), 'change', e => {
        this.fanMode = e.target.value;
        this.fanStatus = this.fanMode === 'manual' ? 'Manual control. Choose an airflow level.' : 'Apex automatic cooling uses fresh sensor data while riding; otherwise it holds the last setting.';
        this.renderDevicesPanel();
      });
      this._fanAutoTimer = setInterval(() => this.updateFanAutomatic(), 1000);
      this.on(modal, 'keydown', e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeModal('hardwareModal'); return; }
        if (e.key !== 'Tab') return;
        const focusable = [...modal.querySelectorAll('button, input, select, summary, a[href]')].filter(el => !el.disabled && el.getClientRects().length);
        if (!focusable.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      });
      if (this.ble.refreshPermitted) this.ble.refreshPermitted().then(() => this.renderDevicesPanel()).catch(() => {});
      this.renderDevicesPanel();
      if (!Object.keys(this.ble._knownIds()).length) this.$('deviceAddSection').open = true;
    },

    openDevicesFocus() {
      const modal = this.$('hardwareModal');
      if (!modal.hidden) { this.$('btnCloseHardwareModal')?.focus(); return; }
      this._devicesPreviousFocus = document.activeElement;
      modal.hidden = false;
      // Preserve any preexisting inert state while isolating the Devices dialog.
      this._devicesInert = [...document.body.children].filter(el => el !== modal && el.tagName !== 'SCRIPT' && !el.contains(modal)).map(el => [el, el.inert]);
      this._devicesInert.forEach(([el]) => { el.inert = true; });
      this.$('btnCloseHardwareModal')?.focus();
      this.renderDevicesPanel();
    },

    closeDevicesFocus() {
      const modal = this.$('hardwareModal');
      if (modal) modal.hidden = true;
      (this._devicesInert || []).forEach(([el, was]) => { el.inert = was; });
      this._devicesInert = [];
      if (this._devicesPreviousFocus?.isConnected) this._devicesPreviousFocus.focus();
      this._devicesPreviousFocus = null;
    },

    async connectSavedDevice(kind) {
      const state = this.ble.getState(kind);
      if (state === 'connecting' || this.ble.slots[kind].connecting) return;
      if (this.ble.isConnected(kind)) return this.connectDevice(kind); // explicit Disconnect action
      let ok;
      try { ok = await this.ble.reconnect(kind); } catch (e) { this.showToast(e.message || 'Connection failed.', 'error'); return false; }
      if (ok === null || (ok === false && this.ble.slots[kind].lastError?.needsChooser)) {
        // Do not open a chooser after an await: it no longer has the user's gesture.
        this.$('deviceTypeSelect').value = kind;
        this.$('deviceAddSection').open = true;
        this.$('btnPairDevice').focus();
        this.showToast('Choose Pair device to open the browser Bluetooth list.', 'info');
      } else this.onConnectResult(kind, ok);
      this.updatePowerSourceBadge();
      this.renderDevicesPanel();
      if (this.publishSoon) this.publishSoon();
      return ok;
    },

    async connectSavedDevices({ fromPhone = false } = {}) {
      if (this._devicesConnectingAll) return;
      const token = ++this._devicesBatchToken;
      this._devicesConnectingAll = true;
      this.renderDevicesPanel();
      try {
        await this.ble.refreshPermitted();
        for (const kind of KINDS) {
          if (token !== this._devicesBatchToken) break;
          if (this.ble.isConnected(kind) || this.ble.slots[kind].connecting || !this.ble.canReconnect(kind)) continue;
          this._devicesBatchKind = kind;
          this.renderDevicesPanel();
          if (fromPhone) await this.remoteConnectDevice(kind);
          else await this.connectSavedDevice(kind); // Windows GATT setup is deliberately sequential
        }
      } finally {
        this._devicesConnectingAll = false;
        this._devicesBatchKind = null;
        this.renderDevicesPanel();
      }
    },

    stopDeviceConnections() {
      this._devicesBatchToken++;
      KINDS.forEach(kind => { if (['connecting', 'reconnecting'].includes(this.ble.getState(kind))) this.disconnectDeviceKind(kind); });
      this.renderDevicesPanel();
    },

    setDeviceSource(channel, value) {
      if (!['power', 'cadence'].includes(channel) || !['auto', 'pedals', 'trainer'].includes(value)) return;
      this[`${channel}SourcePreference`] = value;
      try { localStorage.setItem('apex_device_sources', JSON.stringify({ power: this.powerSourcePreference, cadence: this.cadenceSourcePreference })); } catch (e) { this.showToast('Source selected for this session; browser could not save the preference.', 'warning'); }
      this.powerBuffer = [];
      this.erg.offset = 0;
      this.erg.pedalBuf = [];
      this.erg.pmSettle = 0;
      this.powerMatchOffset = 0;
      if (this.totalElapsedSeconds > 0 || this.isPlaying) this._deviceSourceChanges = [...(this._deviceSourceChanges || []), { at: Date.now(), seconds: this.totalElapsedSeconds, channel, preference: value }];
      if (this.isPlaying) this.ergApplyNow(false);
      this.updatePowerSourceBadge();
      this.renderDevicesPanel();
      this.showToast(`${channel === 'power' ? 'Power' : 'Cadence'} source changed. The change is recorded with the ride.`);
    },

    devicePowerFresh(now = performance.now()) {
      const pedal = now - this.blePedal.lastTime < 3500 && this.blePedal.watts !== null;
      const trainer = now - this.bleTrainer.lastTime < 3500 && this.bleTrainer.watts !== null;
      const preference = this.powerSourcePreference || 'auto';
      return { pedals: pedal && preference !== 'trainer', trainer: trainer && preference !== 'pedals' };
    },

    deviceCadenceReading(now = performance.now()) {
      const preference = this.cadenceSourcePreference || 'auto';
      for (const kind of preference === 'auto' ? ['pedals', 'trainer'] : [preference]) {
        const cache = kind === 'pedals' ? this.blePedal : this.bleTrainer;
        if (now - cache.lastTime < 3500 && Number.isFinite(cache.cadence)) return cache.cadence;
      }
      return null;
    },

    renderDevicesPanel() {
      if (!this.$('devicesSummary')) return;
      const now = performance.now();
      const known = this.ble._knownIds();
      let connected = 0, receiving = 0, saved = 0, attention = false;
      const unsupported = !navigator.bluetooth;
      const caches = { trainer: this.bleTrainer, pedals: this.blePedal, hr: this.bleHr };
      KINDS.forEach(kind => {
        const s = this.ble.slots[kind], d = this.ble.getDiagnostics(kind);
        const cache = caches[kind];
        const fresh = !!cache && now - cache.lastTime < (kind === 'hr' ? 4000 : 3500);
        const reading = fresh && (kind === 'hr' ? cache.hr !== null : cache.watts !== null);
        const linked = this.ble.isConnected(kind);
        const remembered = !!(known[kind] || s.device);
        if (remembered) saved++;
        if (linked) connected++;
        if (reading) receiving++;
        if (['failed', 'reconnecting'].includes(d.state) || (linked && kind !== 'fan' && !reading)) attention = true;
        if (linked && kind === 'trainer' && d.controlGranted !== true) attention = true;
        const card = this.$(`deviceCard-${kind}`);
        if (card) card.hidden = !remembered && !linked && !fresh && d.state === 'disconnected';
        const name = d.alias || s.device?.name || known[kind]?.alias || known[kind]?.name || LABELS[kind];
        this.setText(`deviceName-${kind}`, name);
        const aliasInput = this.$(`deviceAlias-${kind}`);
        const deviceId = s.device?.id || known[kind]?.id || '';
        if (aliasInput && aliasInput.dataset.deviceId !== deviceId) {
          aliasInput.value = known[kind]?.alias || '';
          aliasInput.dataset.deviceId = deviceId;
        }
        let text = linked ? (kind === 'fan' ? 'Connected' : reading ? 'Receiving data' : 'Connected · waiting for data') : d.state === 'connecting' ? 'Connecting…' : d.state === 'reconnecting' ? 'Reconnecting…' : d.state === 'failed' ? 'Reconnect failed' : remembered ? 'Saved · disconnected' : 'Not paired';
        if (linked && kind === 'trainer') text += d.controlGranted === true ? ' · control granted' : d.controlGranted === false ? ' · control refused' : ' · control pending';
        if (linked && kind === 'hr' && fresh && cache.contact === false) text = 'Connected · no skin contact';
        const badge = this.$(STATUS[kind]);
        if (badge) { badge.textContent = text; badge.dataset.state = d.state; }
        const button = this.$(BUTTONS[kind]);
        if (button) { button.textContent = linked ? 'Disconnect' : ['connecting', 'reconnecting'].includes(d.state) ? (d.state === 'connecting' ? 'Connecting…' : 'Retry now') : remembered ? 'Reconnect' : 'Pair device'; button.disabled = unsupported || d.state === 'connecting' || s.connecting; }
        const stop = this.$(`deviceStop-${kind}`);
        if (stop) stop.hidden = !['connecting', 'reconnecting'].includes(d.state);
        this.setText(`deviceError-${kind}`, !linked && s.lastError ? `${s.lastError.message}. ${this.deviceWakeHint(kind)}` : d.state === 'reconnecting' ? `Retry ${Math.min(d.attempt + 1, VeloBle.RECONNECT_MAX_ATTEMPTS)} of ${VeloBle.RECONNECT_MAX_ATTEMPTS} · next attempt in ${Math.ceil(d.nextRetryMs / 1000)} s` : '');
        this.setText(`deviceCapabilities-${kind}`, kind === 'fan' ? 'Airflow control · firmware compatibility must be checked on your fan' : Object.entries(d.capabilities).filter(([,v]) => v).map(([key]) => ({ watts: 'Power', cadence: 'Cadence', speed: 'Speed', distanceMeters: 'Distance', leftPct: 'L/R balance', rightPct: '', hr: 'Heart rate', trainerControl: 'Resistance control', calibration: 'Offset calibration', torque: 'Torque' }[key] || '')).filter(Boolean).join(' · ') || 'Capabilities verified when connected and receiving data');
      });
      const status = unsupported ? 'Bluetooth unavailable · open this app in Chrome or Edge on localhost' : this._devicesConnectingAll ? `Connecting ${LABELS[this._devicesBatchKind] || 'saved devices'}…` : !saved && !connected ? 'Add your riding devices' : attention ? 'Your setup needs attention' : connected ? `${connected} device${connected === 1 ? '' : 's'} connected` : 'Your saved setup is disconnected';
      this.setText('devicesSummary', status);
      this.setText('devicesSummaryHint', this._devicesConnectingAll ? 'Connecting one at a time. Stop cancels pending connections.' : unsupported ? 'Your history and workouts remain available.' : 'Check each sensor for fresh readings. Trainer connection and control are shown separately.');
      const connectAll = this.$('btnConnectSavedDevices');
      if (connectAll) { connectAll.disabled = unsupported || this._devicesConnectingAll || !KINDS.some(k => this.ble.canReconnect(k) && !this.ble.isConnected(k)); }
      if (this.$('btnStopDeviceConnections')) this.$('btnStopDeviceConnections').hidden = !this._devicesConnectingAll;
      this.setText('devicesHeaderStatus', this._devicesConnectingAll ? 'Connecting' : attention ? 'Check setup' : connected ? `${connected} connected` : saved ? 'Saved setup' : 'Connect');
      this.$('btnOpenHardwareModal')?.setAttribute('aria-label', `Devices: ${status}`);
      if (this.$('btnPairDevice')) this.$('btnPairDevice').disabled = unsupported || this._devicesConnectingAll;
      if (this.$('btnPairDeviceBroad')) this.$('btnPairDeviceBroad').disabled = unsupported || this._devicesConnectingAll;
      const calibrate = this.$('btnCalibratePedalsModal');
      if (calibrate) calibrate.disabled = this.isPlaying || this.calibration.phase !== 'idle' || !this.ble.canCalibrate();
      this.setText('deviceCalibrationHint', this.isPlaying ? 'Pause before calibrating; unclip and hold the cranks still.' : this.ble.isPedalsConnected() && !this.ble.canCalibrate() ? 'This meter does not expose offset calibration. Use its manufacturer app if required.' : 'Unclip, set cranks vertical and keep still.');
      const fan = this.ble.slots.fan;
      const fanConnected = this.ble.isFanConnected();
      this.setText('fanReportedSpeed', fanConnected && fan.fanSpeed !== null ? `${fan.fanSpeed}% confirmed by fan` : fanConnected && fan.requestedSpeed !== null ? `${fan.requestedSpeed}% command sent · awaiting fan confirmation` : 'Airflow not reported yet');
      this.setText('fanControlStatus', this.fanStatus || 'Manual control');
      const slider = this.$('fanSpeedSlider');
      const airflow = fan.requestedSpeed ?? fan.fanSpeed;
      if (airflow !== null && slider && document.activeElement !== slider && !this._fanWriteBusy) {
        slider.value = airflow;
        this.setText('fanSpeedPreview', `${airflow}%${fan.requestedSpeed !== null ? ' requested' : ' reported'}`);
      }
      if (this.$('fanSpeedSlider')) this.$('fanSpeedSlider').disabled = !fanConnected || !!this._fanWriteBusy;
      if (this.$('fanModeSelect')) { this.$('fanModeSelect').disabled = !fanConnected; this.$('fanModeSelect').value = this.fanMode || 'manual'; }
      [0,25,50,75,100].forEach(v => { if (this.$(`fanPreset${v}`)) this.$(`fanPreset${v}`).disabled = !fanConnected || !!this._fanWriteBusy; });
    },

    async setFanAirflow(value, { automatic = false } = {}) {
      if (this._fanWriteBusy) return false;
      if (!automatic) this.fanMode = 'manual';
      this._fanWriteBusy = true;
      this.fanStatus = 'Sending airflow command…';
      this.renderDevicesPanel();
      try {
        const speed = await this.ble.setFanSpeed(value);
        this.fanStatus = `${speed}% command sent. Fan feedback is shown separately.`;
        this.setText('fanSpeedPreview', `${speed}% requested`);
        if (this.$('fanSpeedSlider')) this.$('fanSpeedSlider').value = speed;
        return true;
      } catch (e) {
        if (automatic) this.fanMode = 'manual'; // a failed automatic command must not repeat every second
        this.fanStatus = `Fan command failed: ${e.message}${automatic ? '. Automatic cooling stopped; retry manually.' : ''}`;
        this.showToast(this.fanStatus, 'error'); return false;
      }
      finally { this._fanWriteBusy = false; this.renderDevicesPanel(); if (this.publishSoon) this.publishSoon(); }
    },

    updateFanAutomatic() {
      if (!this.ble.isFanConnected() || !['hr', 'power'].includes(this.fanMode) || this._fanWriteBusy) return;
      if (!this.isPlaying) { this.fanStatus = 'Automatic cooling paused. Holding the last airflow; use Off when finished.'; return; }
      const now = performance.now();
      const fresh = this.devicePowerFresh(now);
      const value = this.fanMode === 'hr' ? (now - this.bleHr.lastTime < 4000 ? this.bleHr.hr : null) : fresh.pedals ? this.blePedal.watts : fresh.trainer ? this.bleTrainer.watts : null;
      if (value === null || !Number.isFinite(value)) { this.fanStatus = 'Waiting for fresh sensor data. Holding the last airflow.'; return; }
      const max = this.fanMode === 'hr' ? this.activeProfile.maxHr : this.activeProfile.ftp;
      if (!(max > 0)) return;
      const lo = this.fanMode === 'hr' ? 0.6 : 0.4;
      const hi = this.fanMode === 'hr' ? 0.95 : 1.2;
      const speed = Math.round(20 + 80 * Math.max(0, Math.min(1, (value / max - lo) / (hi - lo))));
      const last = this.ble.slots.fan.requestedSpeed;
      if (last !== null && Math.abs(speed - last) < 3) return;
      this.setFanAirflow(speed, { automatic: true });
    }
  });
})();
