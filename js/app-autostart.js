/**
 * APEX VELO // LAB - Pedal to start & auto-pause (mixin on VeloApp).
 *
 * Modelled on TrainerRoad / Zwift / Wahoo SYSTM:
 *  - Start arms the workout ("PEDAL TO START"); it begins once you have pedalled for ~1 s.
 *    Pressing Start again while armed starts immediately.
 *  - Stop pedalling for N seconds (default 3, adjustable - TrainerRoad's fixed ~1 s is a
 *    common complaint) and the ride auto-pauses; pedal again and it resumes by itself.
 *  - A pause you make with the button stays paused until you press Resume.
 *  - Only active when the pedals or the trainer are connected. Without a power/cadence
 *    sensor there is nothing to detect, so Start behaves exactly as before.
 *
 * "Pedalling" = cadence >= 15 rpm or power >= 25 W from a fresh (< 2 s) pedal or trainer
 * reading, so a heart-rate strap alone or a stale value never starts the clock.
 */
(function () {
  const KEY = 'apex_autostart_v1';
  const DEFAULTS = { pedalToStart: true, autoPause: true, pauseAfterSec: 3 };
  const PAUSE_CHOICES = [2, 3, 5, 8, 10];
  const PEDAL_RPM = 15;
  const PEDAL_WATTS = 25;
  const FRESH_MS = 2000;
  const CONFIRM_MS = 800; // pedalling must last this long to (re)start - ignores a knock of the crank

  Object.assign(VeloApp.prototype, {
    initAutoStart() {
      this.autoStartSettings = this.loadAutoStartSettings();
      this.pedalSince = null;
      this.autoWatch = setInterval(() => { if (this.autoState) this.onPedalTelemetry(); }, 500);

      const s = this.autoStartSettings;
      const chkStart = this.$('chkPedalToStart'), chkPause = this.$('chkAutoPause'), sel = this.$('selAutoPauseSec');
      if (chkStart) chkStart.checked = s.pedalToStart;
      if (chkPause) chkPause.checked = s.autoPause;
      if (sel) {
        sel.innerHTML = PAUSE_CHOICES.map((n) => `<option value="${n}">${n} s</option>`).join('');
        sel.value = String(s.pauseAfterSec);
      }
      this.on(chkStart, 'change', (e) => {
        this.saveAutoStartSettings({ pedalToStart: e.target.checked });
        if (!e.target.checked && this.autoState === 'armed') this.cancelArm();
        this.showToast(e.target.checked ? 'Pedal to start: on' : 'Pedal to start: off - Start begins immediately.');
      });
      this.on(chkPause, 'change', (e) => {
        this.saveAutoStartSettings({ autoPause: e.target.checked });
        this.idleSeconds = 0;
        this.showToast(e.target.checked ? `Auto-pause: on (${this.autoStartSettings.pauseAfterSec} s)` : 'Auto-pause: off');
      });
      this.on(sel, 'change', (e) => {
        this.saveAutoStartSettings({ pauseAfterSec: parseInt(e.target.value, 10) });
        this.showToast(`Auto-pause after ${this.autoStartSettings.pauseAfterSec} s without pedalling.`);
      });
      this.on(this.$('btnAutoStartChip'), 'click', () => this.openHardwareLab());
      this.updateAutoStartChip();
      this.updateAutoStartBanner();
    },

    stopAutoStart() { clearInterval(this.autoWatch); },

    loadAutoStartSettings() {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { saved = {}; }
      const s = { ...DEFAULTS, ...saved };
      if (!PAUSE_CHOICES.includes(s.pauseAfterSec)) s.pauseAfterSec = DEFAULTS.pauseAfterSec;
      s.pedalToStart = !!s.pedalToStart;
      s.autoPause = !!s.autoPause;
      return s;
    },

    saveAutoStartSettings(patch) {
      this.autoStartSettings = { ...this.autoStartSettings, ...patch };
      try { localStorage.setItem(KEY, JSON.stringify(this.autoStartSettings)); } catch (e) { /* storage full/blocked - keep in memory */ }
      this.updateAutoStartChip();
    },

    /** True when a power/cadence source is connected, so pedalling can be detected. */
    hasPedalSensor() {
      return !!(this.ble && (this.ble.isPedalsConnected() || this.ble.isTrainerConnected()));
    },

    shouldArmForPedaling() {
      return !!(this.autoStartSettings && this.autoStartSettings.pedalToStart && this.hasPedalSensor());
    },

    /** Live "is the rider pedalling?" from the freshest pedal or trainer reading. */
    pedalingNow() {
      const now = performance.now();
      const moving = (src) => src && (now - src.lastTime) < FRESH_MS &&
        ((src.cadence !== null && src.cadence >= PEDAL_RPM) || (src.watts !== null && src.watts >= PEDAL_WATTS));
      return moving(this.blePedal) || moving(this.bleTrainer);
    },

    armPedalToStart() {
      this.autoState = 'armed';
      this.pedalSince = null;
      this.acquireWakeLock();
      this.updatePlaybackControlsUi();
      this.showToast('Ready - start pedalling to begin the workout.', 'info');
      if (this.publishSoon) this.publishSoon();
      this.onPedalTelemetry(); // already spinning? start on the next reading
    },

    cancelArm() {
      if (this.autoState !== 'armed') return;
      this.autoState = null;
      this.pedalSince = null;
      this.releaseWakeLock();
      this.updatePlaybackControlsUi();
    },

    /** Called on every pedal/trainer reading (and every 0.5 s) while armed or auto-paused. */
    onPedalTelemetry() {
      if (!this.autoState || this.isPlaying) return;
      if (!this.pedalingNow()) { this.pedalSince = null; return; }
      const now = performance.now();
      if (this.pedalSince === null) { this.pedalSince = now; return; }
      if (now - this.pedalSince >= CONFIRM_MS) {
        this.pedalSince = null;
        this.startRide('pedal');
      }
    },

    /** Called once per ride second from tick1Hz. Returns true when the ride should auto-pause now. */
    checkAutoPause(power, cadence) {
      const s = this.autoStartSettings;
      if (!s || !s.autoPause || !this.hasPedalSensor()) { this.idleSeconds = 0; return false; }
      const pedaling = (cadence || 0) >= PEDAL_RPM || (power || 0) >= PEDAL_WATTS;
      this.idleSeconds = pedaling ? 0 : (this.idleSeconds || 0) + 1;
      return this.idleSeconds >= s.pauseAfterSec;
    },

    onRideStarted(reason) {
      this.pedalSince = null;
      if (reason === 'pedal') {
        const resumed = this.totalElapsedSeconds > 0;
        this.showToast(resumed ? 'Pedalling detected - resumed.' : 'Pedalling detected - workout started. Go!', 'success');
        try { this.audio.playTone(660, 0.09, 'sine', 0.12); setTimeout(() => this.audio.playTone(990, 0.14, 'sine', 0.12), 110); } catch (e) { /* audio optional */ }
      }
      if (this.publishSoon) this.publishSoon();
    },

    onRidePaused(reason) {
      this.pedalSince = null;
      if (reason === 'auto') {
        this.showToast('Auto-paused - start pedalling to resume.', 'warning');
        try { this.audio.playTone(520, 0.12, 'sine', 0.12); setTimeout(() => this.audio.playTone(390, 0.18, 'sine', 0.12), 140); } catch (e) { /* audio optional */ }
      }
      if (this.publishSoon) this.publishSoon();
    },

    updateAutoStartChip() {
      const s = this.autoStartSettings;
      const chip = this.$('btnAutoStartChip');
      if (!chip || !s) return;
      const parts = [s.pedalToStart ? 'Pedal-to-start' : null, s.autoPause ? `Auto-pause ${s.pauseAfterSec}s` : null].filter(Boolean);
      chip.textContent = parts.length ? parts.join(' · ') : 'Auto start/pause off';
      chip.classList.toggle('is-off', !parts.length);
    },

    updateAutoStartBanner() {
      const b = this.$('autoStartBanner');
      if (!b) return;
      const st = this.autoState;
      b.hidden = !st;
      document.body.classList.toggle('auto-armed', !!st);
      if (!st) return;
      this.setText('autoStartBannerTitle', st === 'armed' ? 'Pedal to start' : 'Auto-paused');
      this.setText('autoStartBannerSub', st === 'armed'
        ? 'The workout begins as soon as you start pedalling.'
        : 'Start pedalling to resume - or press Resume now.');
    },
  });
})();
