/**
 * APEX VELO // LAB - Phone view publisher (mixin on VeloApp).
 *
 * The PC keeps the Bluetooth sensors and runs the ride. About once a second this posts a
 * small live snapshot to the local server (api/live); live.html on a phone on the same
 * Wi-Fi reads it. Commands tapped on the phone (pause/resume, skip, ERG bias) come back in
 * the reply and are applied here, exactly as if the button on the PC had been clicked.
 *
 * Only the copy of the app opened on the PC itself (localhost) publishes, so opening the full
 * app on another device can never overwrite the live ride.
 */
(function () {
  const PUBLISH_MS = 1000;
  const BACKOFF_MS = 10000;
  const TRACE_LEN = 120; // seconds of power trace shown on the phone

  Object.assign(VeloApp.prototype, {
    initRemoteView() {
      this.remoteTrace = [];
      this.remoteLastTraceSecond = -1;
      const onPc = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(location.hostname);
      if (!onPc || !/^https?:$/.test(location.protocol) || window.__APEX_TEST_MODE__) return;
      // Ticks come from a tiny Worker: Chrome throttles main-thread timers in a minimised
      // window to once a minute, which would freeze the phone view mid-ride.
      let busy = false, failUntil = 0;
      const tick = async () => {
        if (busy || Date.now() < failUntil) return;
        busy = true;
        try { await this.publishRemoteSnapshot(); } catch (e) { failUntil = Date.now() + BACKOFF_MS; }
        busy = false;
      };
      try {
        const src = `setInterval(() => postMessage(0), ${PUBLISH_MS});`;
        this.remoteWorkerUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        this.remoteWorker = new Worker(this.remoteWorkerUrl);
        this.remoteWorker.onmessage = tick;
      } catch (e) {
        this.remoteTimer = setInterval(tick, PUBLISH_MS);
      }
    },

    stopRemoteView() {
      clearInterval(this.remoteTimer);
      clearTimeout(this._remoteSoon);
      if (this.remoteWorker) { this.remoteWorker.terminate(); this.remoteWorker = null; }
      if (this.remoteWorkerUrl) { URL.revokeObjectURL(this.remoteWorkerUrl); this.remoteWorkerUrl = null; }
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
      };
    },

    async publishRemoteSnapshot() {
      const res = await fetch('api/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.buildRemoteSnapshot()),
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('live ' + res.status);
      const data = await res.json();
      (data.cmds || []).forEach((c) => this.applyRemoteCommand(c && c.cmd));
    },

    applyRemoteCommand(cmd) {
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
        case 'bias-reset':
          this.ergBiasMultiplier = 1.0; this.updateBiasUi(); this.updateHudTitles();
          this.ergApplyNow(false);
          break;
        default: return;
      }
      this.publishSoon();
    },

    /** Push the new state right away after a command so the phone reacts quickly. */
    publishSoon() {
      clearTimeout(this._remoteSoon);
      this._remoteSoon = setTimeout(() => { this.publishRemoteSnapshot().catch(() => {}); }, 50);
    },
  });
})();
