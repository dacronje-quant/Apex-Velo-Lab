/**
 * APEX VELO // LAB - Phone view publisher (mixin on VeloApp).
 *
 * The PC keeps the Bluetooth sensors and runs the ride. Right after every 1 Hz ride tick (and
 * every device-preview update) this posts a small live snapshot to the local server (api/live);
 * live.html on a phone on the same Wi-Fi holds a long-poll open and gets it within a few ms.
 * Commands tapped on the phone (pause/resume, skip, ERG bias) reach the PC through a request it
 * keeps open (api/live/cmds), and also ride back in the reply to each publish as a fallback.
 * They are applied here exactly as if the button on the PC had been clicked.
 *
 * Only the copy of the app opened on the PC itself (localhost) publishes, so opening the full
 * app on another device can never overwrite the live ride.
 *
 * Devices from the phone: the snapshot carries each sensor's link state, battery and live reading
 * (hw), and the phone can connect / disconnect / zero-offset them. Bluetooth itself stays on the
 * PC. A device chosen before reconnects without the browser's chooser; a brand-new one needs a
 * single click on the PC (browsers only open the chooser after a real click), so the phone asks
 * for it and the PC shows a "Pair now" banner.
 */
(function () {
  const HEARTBEAT_MS = 1000; // fallback publish when no tick has published recently
  const BACKOFF_MS = 5000;
  const TRACE_LEN = 120; // seconds of power trace shown on the phone
  const PHONE_POWER_SEC = 5; // the phone's big power number is a 5 s average
  const PAIR_REQUEST_MS = 120000; // a "pair on the PC" request from the phone waits this long
  const KINDS = ['trainer', 'pedals', 'hr'];

  Object.assign(VeloApp.prototype, {
    initRemoteView() {
      this.remoteTrace = [];
      this.remoteLastTraceSecond = -1;
      const onPc = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(location.hostname);
      if (!onPc || !/^https?:$/.test(location.protocol) || window.__APEX_TEST_MODE__) return;
      this._remoteEnabled = true;
      this._remoteBusy = false;
      this._remoteDirty = false;
      this._remoteFailUntil = 0;
      this._remoteLastAt = 0;
      this._remoteCmdUntil = 0;
      this._remoteCmdSeen = 0; // id of the last phone command applied (confirmed to the server in each publish)
      if (this.ble && this.ble.refreshPermitted) this.ble.refreshPermitted().then(() => this.publishSoon()); // which devices the phone can reconnect
      if (navigator.bluetooth && !VeloBle.remembersDevices()) {
        console.warn('[Apex] Chrome forgets Bluetooth devices when it closes. Start the app with Launch-Apex-Velo.bat, or enable chrome://flags/#enable-web-bluetooth-new-permissions-backend');
        setTimeout(() => this.showToast('Chrome will forget your sensors when it closes. Close all Chrome windows and start with Launch-Apex-Velo.bat, or enable the flag in chrome://flags (see README).', 'warning'), 2500);
      }
      // Heartbeat from a tiny Worker: Chrome throttles main-thread timers in a minimised window
      // to once a minute, which would freeze the phone view mid-ride. Normal updates are pushed
      // by the ride tick itself (see publishSoon); this only covers idle moments.
      const beat = () => {
        if (Date.now() - this._remoteLastAt >= HEARTBEAT_MS - 100) this.publishSoon();
        if (!this._remoteCmdLoop && Date.now() >= this._remoteCmdUntil) this.remoteCmdLoop();
      };
      try {
        const src = `setInterval(() => postMessage(0), ${HEARTBEAT_MS});`;
        this.remoteWorkerUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        this.remoteWorker = new Worker(this.remoteWorkerUrl);
        this.remoteWorker.onmessage = beat;
      } catch (e) {
        this.remoteTimer = setInterval(beat, HEARTBEAT_MS);
      }
      this.remoteCmdLoop();
    },

    stopRemoteView() {
      this._remoteEnabled = false;
      clearInterval(this.remoteTimer);
      if (this._remoteCmdAbort) { try { this._remoteCmdAbort.abort(); } catch (e) { /* ignore */ } }
      if (this.remoteWorker) { this.remoteWorker.terminate(); this.remoteWorker = null; }
      if (this.remoteWorkerUrl) { URL.revokeObjectURL(this.remoteWorkerUrl); this.remoteWorkerUrl = null; }
    },

    /**
     * Commands from the phone arrive the moment they are tapped: this request stays open on the
     * server until a command comes in (or ~20 s pass), then it is re-opened straight away.
     * On an error (server restarting, older server without it) the heartbeat retries later.
     */
    async remoteCmdLoop() {
      if (!this._remoteEnabled || this._remoteCmdLoop) return;
      this._remoteCmdLoop = true;
      try {
        while (this._remoteEnabled) {
          const ctl = new AbortController();
          this._remoteCmdAbort = ctl;
          const res = await fetch('api/live/cmds?after=' + (this._remoteCmdSeen || 0), { cache: 'no-store', signal: ctl.signal });
          if (!res.ok) throw new Error('cmds ' + res.status);
          this.takeRemoteCommands(await res.json());
        }
      } catch (e) {
        this._remoteCmdUntil = Date.now() + BACKOFF_MS;
      } finally {
        this._remoteCmdLoop = false;
      }
    },

    buildRemoteSnapshot() {
      const w = this.currentWorkout || { intervals: [] };
      const ivs = w.intervals || [];
      const iv = ivs[this.intervalIndex] || null;
      const next = ivs[this.intervalIndex + 1] || null;
      const finished = this.isWorkoutCompleted || this.intervalIndex >= ivs.length;
      const state = this.isPlaying ? 'running' : finished ? 'finished' : this.totalElapsedSeconds > 0 ? 'paused' : 'ready';
      const p = this.activeProfile || {};
      const power = Number(this.lastInstantPower) || 0;
      // 5 s average while riding (one buffer entry per ride second); before Start / while paused the
      // buffer is not fed, so the live device reading is shown as is.
      const power5 = this.isPlaying && this.powerBuffer && this.powerBuffer.length ? this.getSmoothedPower(PHONE_POWER_SEC) : power;
      const zone5 = VeloMetrics.zoneForPct(p.ftp ? (power5 / p.ftp) * 100 : 0);
      const hr = Number(this.lastHr) || 0;
      const target = iv ? this.getCurrentTargetWatts() : 0;
      const zone = VeloMetrics.zoneForPct(p.ftp ? (power / p.ftp) * 100 : 0);
      const tZone = iv ? VeloMetrics.zoneForPct(iv.pctFtp * this.ergBiasMultiplier) : null;
      const hrz = hr > 0 ? VeloMetrics.hrZone(hr, p.maxHr) : null;
      const a = this.analytics || {};
      const lBal = Number.isFinite(this.currentLeftBal) ? Math.round(this.currentLeftBal * 10) / 10 : null;

      // Power trace: one point per ride second while riding.
      const sec = this.totalElapsedSeconds || 0;
      if (this.isPlaying && sec !== this.remoteLastTraceSecond) {
        this.remoteLastTraceSecond = sec;
        this.remoteTrace.push(power);
        if (this.remoteTrace.length > TRACE_LEN) this.remoteTrace.shift();
      }
      if (state === 'ready') { this.remoteTrace = []; this.remoteLastTraceSecond = -1; }

      let totalDur = 0, doneDur = 0;
      ivs.forEach((x, i) => {
        totalDur += x.duration || 0;
        if (i < this.intervalIndex) doneDur += x.duration || 0;
      });
      if (iv) doneDur += Math.max(0, (iv.duration || 0) - (this.intervalSecondsRemaining || 0));

      return {
        v: 1,
        sentAt: Date.now(),
        cmdAck: this._remoteCmdSeen || 0,
        state,
        title: w.title || 'Workout',
        ftp: p.ftp || null,
        rider: p.name || null,
        step: iv ? { index: this.intervalIndex + 1, count: ivs.length, name: iv.name, remaining: this.intervalSecondsRemaining, duration: iv.duration } : null,
        next: next ? { name: next.name, duration: next.duration, watts: Math.round((p.ftp || 0) * (next.pctFtp / 100) * this.ergBiasMultiplier), cadence: this.getCurrentTargetCadence(this.intervalIndex + 1) } : null,
        elapsed: sec,
        progress: totalDur ? Math.min(1, doneDur / totalDur) : 0,
        totalDuration: totalDur,
        profile: ivs.map((x) => [x.duration || 0, x.pctFtp || 0]),
        power,
        target,
        targetPct: iv ? Math.round(iv.pctFtp * this.ergBiasMultiplier) : null,
        zone: { name: zone.name, short: zone.short, color: zone.color },
        power5,
        powerAvgSec: PHONE_POWER_SEC,
        zone5: { name: zone5.name, short: zone5.short, color: zone5.color },
        targetZone: tZone ? { name: tZone.name, short: tZone.short, color: tZone.color } : null,
        cadence: Number(this.lastCadence) || 0,
        targetCadence: iv ? this.getCurrentTargetCadence() : null,
        hr: hr > 0 ? hr : null,
        hrZone: hrz ? hrz.label : null,
        balanceLeft: lBal,
        avgPower: a.totalSeconds ? Math.round(a.totalJoules / a.totalSeconds) : 0,
        np: a.normalizedPower || 0,
        tss: a.tss || 0,
        kj: a.totalJoules ? Math.round(a.totalJoules / 1000) : 0,
        distanceKm: Number(this.totalDistanceKm) || 0,
        bias: Math.round((this.ergBiasMultiplier || 1) * 100),
        baseTarget: iv ? Math.round((p.ftp || 0) * (iv.pctFtp / 100)) : null,
        standLeft: this.erg ? this.erg.standLeft : 0,
        easySpinOffer: this._easySpinOffer ? Math.max(0, Math.ceil((this._easySpinOffer.until - Date.now()) / 1000)) : null,
        ergMode: this.erg ? this.erg.mode : 'normal',
        erg: !!this.ergModeEnabled,
        source: this.activePowerSource || null,
        devices: {
          trainer: !!(this.ble && this.ble.isTrainerConnected()),
          pedals: !!(this.ble && this.ble.isPedalsConnected()),
          hr: !!(this.ble && this.ble.isHrConnected()),
        },
        trace: this.remoteTrace.slice(),
        hw: this.buildRemoteHardware(),
      };
    },

    /** Per-device link state for the phone's Devices screen. */
    buildRemoteHardware() {
      if (!this.ble || !this.ble.getDiagnostics) return null;
      const now = performance.now();
      const round1 = (v) => Math.round(v * 10) / 10;
      const src = { trainer: this.bleTrainer, pedals: this.blePedal, hr: this.bleHr };
      const list = KINDS.map((kind) => {
        const d = this.ble.getDiagnostics(kind);
        const s = src[kind] || {};
        const fresh = !!s.lastTime && now - s.lastTime < 3500;
        const reading = !fresh ? null
          : kind === 'hr' ? { hr: s.hr != null ? s.hr : null, contact: s.contact != null ? s.contact : null }
          : kind === 'pedals' ? { watts: s.watts, cadence: s.cadence, left: s.leftPct != null ? s.leftPct : null }
          : { watts: s.watts, cadence: s.cadence, speed: s.speed != null ? round1(s.speed) : null };
        const slot = this.ble.slots && this.ble.slots[kind];
        return {
          kind,
          label: this.deviceLabel(kind),
          name: d.name,
          state: d.state,
          known: !!(this.ble.canReconnect && this.ble.canReconnect(kind)),
          battery: this.bleBattery ? this.bleBattery[kind] : null,
          attempt: d.attempt,
          maxAttempts: VeloBle.RECONNECT_MAX_ATTEMPTS,
          retryInSec: d.nextRetryMs ? round1(d.nextRetryMs / 1000) : 0,
          connectedSec: Math.round((d.connectedForMs || 0) / 1000),
          packetRate: round1(d.packetRate || 0),
          lastPacketMs: d.lastPacketAgeMs == null ? null : Math.round(d.lastPacketAgeMs),
          reading,
          error: slot && slot.lastError && slot.lastError.message ? String(slot.lastError.message).slice(0, 140) : null,
        };
      });
      const pr = this._pairRequest && Date.now() < this._pairRequest.until ? this._pairRequest : null;
      const cv = this.calibrationView;
      return {
        bluetooth: typeof navigator !== 'undefined' && !!navigator.bluetooth,
        remembers: VeloBle.remembersDevices(), // false: Chrome forgets paired sensors when it closes
        list,
        pairRequest: pr ? pr.kind : null,
        calibration: {
          phase: this.calibration ? this.calibration.phase : 'idle',
          // the last result stays on the phone for a minute
          view: cv && (cv.phase === 'countdown' || cv.phase === 'sending' || Date.now() - cv.at < 60000) ? { phase: cv.phase, title: cv.title, status: cv.status, count: cv.count } : null,
        },
      };
    },

    /** Connect from the phone: reconnects a known device, or asks for one click on the PC. */
    async remoteConnectDevice(kind) {
      if (!this.ble || typeof navigator === 'undefined' || !navigator.bluetooth) {
        this.showToast('Web Bluetooth is not available in this browser.', 'error');
        return false;
      }
      const slot = this.ble.slots[kind];
      const state = this.ble.getState(kind);
      if (state === 'connected' || state === 'connecting' || (slot && slot.connecting)) return true;
      this.updateDeviceBadge(kind, 'connecting');
      this.publishSoon();
      let ok;
      try { ok = await this.ble.reconnect(kind); } catch (e) { ok = false; }
      if (ok === null) {
        this.updateDeviceBadge(kind, 'disconnected');
        this.requestPairOnPc(kind);
        return null;
      }
      this.onConnectResult(kind, ok);
      if (ok && this._pairRequest && this._pairRequest.kind === kind) this.clearPairRequest();
      this.updatePowerSourceBadge();
      this.publishSoon();
      return ok;
    },

    /** One tap before a ride: every known device that is not connected, one after another (Windows BLE dislikes parallel connects). New ones keep their own Pair button. */
    async remoteConnectAll() {
      if (this._remoteConnectingAll) return;
      this._remoteConnectingAll = true;
      try {
        const known = KINDS.filter((k) => this.ble && this.ble.getState(k) !== 'connected' && this.ble.canReconnect(k));
        for (const k of known) await this.remoteConnectDevice(k);
      } finally {
        this._remoteConnectingAll = false;
      }
    },

    /**
     * The phone asked for a device that has never been chosen on this PC. The browser only opens
     * its Bluetooth chooser after a click here, so show a banner with one big "Pair now" button.
     */
    requestPairOnPc(kind) {
      this._pairRequest = { kind, until: Date.now() + PAIR_REQUEST_MS };
      clearTimeout(this._pairTimer);
      this._pairTimer = setTimeout(() => this.clearPairRequest(), PAIR_REQUEST_MS);
      let el = document.getElementById('pairBanner');
      if (!el) {
        el = document.createElement('div');
        el.id = 'pairBanner';
        el.className = 'pair-banner';
        el.setAttribute('role', 'alertdialog');
        el.setAttribute('aria-labelledby', 'pairBannerTitle');
        el.innerHTML = `
          <div class="pair-banner-icon"><svg class="ic ic-lg"><use href="#i-bluetooth"/></svg></div>
          <div class="pair-banner-text">
            <b id="pairBannerTitle"></b>
            <span>Browsers only open the Bluetooth list after a click on this PC. One click, once - after that the phone can connect it by itself.</span>
          </div>
          <button type="button" class="btn btn-primary" data-act="pair">Pair now</button>
          <button type="button" class="btn btn-ghost" data-act="dismiss" aria-label="Not now"><svg class="ic"><use href="#i-x"/></svg></button>`;
        el.addEventListener('click', (e) => {
          const b = e.target.closest('button');
          if (!b) return;
          const k = this._pairRequest ? this._pairRequest.kind : null;
          this.clearPairRequest();
          if (b.dataset.act === 'pair' && k) this.connectDevice(k); // this click opens the chooser
        });
        document.body.appendChild(el);
      }
      el.querySelector('#pairBannerTitle').textContent = `Your phone wants to connect the ${this.deviceLabel(kind)}`;
      el.classList.add('show');
      try { el.querySelector('[data-act="pair"]').focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      try { this.audio.playTone(740, 0.1, 'sine', 0.12); setTimeout(() => this.audio.playTone(988, 0.16, 'sine', 0.12), 120); } catch (e) { /* audio optional */ }
      this.publishSoon();
    },

    clearPairRequest() {
      this._pairRequest = null;
      clearTimeout(this._pairTimer);
      const el = document.getElementById('pairBanner');
      if (el) el.classList.remove('show');
      this.publishSoon();
    },

    async publishRemoteSnapshot() {
      const res = await fetch('api/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.buildRemoteSnapshot()),
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('live ' + res.status);
      this.takeRemoteCommands(await res.json());
    },

    /** Applies each phone command once: ids already applied (repeated until confirmed) are skipped. */
    takeRemoteCommands(data) {
      (data && data.cmds || []).forEach((c) => {
        if (!c) return;
        if (typeof c.id === 'number') {
          if (c.id <= (this._remoteCmdSeen || 0)) return;
          this._remoteCmdSeen = c.id;
        }
        this.applyRemoteCommand(c.cmd);
      });
    },

    applyRemoteCommand(cmd) {
      const dev = /^(connect|disconnect)-(trainer|pedals|hr)$/.exec(cmd || '');
      if (dev) {
        const kind = dev[2];
        if (dev[1] === 'connect') { this.remoteConnectDevice(kind); return; }
        if (this.ble && this.ble.getState(kind) !== 'disconnected') {
          this.disconnectDeviceKind(kind);
          this.showToast(`${this.deviceLabel(kind)} disconnected from phone`, 'info');
        }
        this.publishSoon();
        return;
      }
      const ivs = (this.currentWorkout && this.currentWorkout.intervals) || [];
      const finished = this.isWorkoutCompleted || this.intervalIndex >= ivs.length;
      switch (cmd) {
        case 'toggle':
          if (finished) return; // never restart a finished ride from the phone
          this.togglePlayPause();
          this.showToast(this.isPlaying ? 'Resumed from phone' : 'Paused from phone', 'info');
          break;
        case 'skip':
          if (!this.isPlaying) return;
          this.skipInterval();
          this.showToast('Skipped step from phone', 'info');
          break;
        case 'bias-up': this.setErgBias(0.01); break;
        case 'bias-down': this.setErgBias(-0.01); break;
        case 'watts-up': this.setErgBiasWatts(5); break;
        case 'watts-down': this.setErgBiasWatts(-5); break;
        case 'spin-more': this.acceptEasySpin(); break;
        case 'spin-finish': this.declineEasySpin(); break;
        case 'stand':
          if (!this.isPlaying) return;
          this.toggleStand();
          break;
        case 'connect-all': this.remoteConnectAll(); return;
        case 'pair-cancel': this.clearPairRequest(); return;
        case 'calibrate-pedals':
          if (this.isPlaying) return; // zero-offset needs the cranks still and unloaded
          this.calibrateAssiomaPedals();
          break;
        case 'bias-reset':
          this.ergBiasMultiplier = 1.0; this.updateBiasUi(); this.updateHudTitles();
          this.ergApplyNow(false);
          break;
        default: return;
      }
      this.publishSoon();
    },

    /**
     * Publish now: runs as soon as the current tick / command handler has finished (a microtask,
     * so it is never delayed by background-tab timer throttling). Calls that arrive while a
     * publish is in flight are folded into one follow-up publish with the newest state.
     */
    publishSoon() {
      if (!this._remoteEnabled || this._remoteQueued) return;
      this._remoteQueued = true;
      Promise.resolve().then(() => { this._remoteQueued = false; this._remotePublish(); });
    },

    async _remotePublish() {
      if (!this._remoteEnabled || Date.now() < this._remoteFailUntil) return;
      if (this._remoteBusy) { this._remoteDirty = true; return; }
      this._remoteBusy = true;
      this._remoteLastAt = Date.now();
      try { await this.publishRemoteSnapshot(); } catch (e) { this._remoteFailUntil = Date.now() + BACKOFF_MS; }
      this._remoteBusy = false;
      if (this._remoteDirty) { this._remoteDirty = false; this._remotePublish(); }
    },
  });
})();
