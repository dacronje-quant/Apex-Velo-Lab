/**
 * Test stand-in for the native ride recorder (com.apexvelo.lab.ride.RideRecorder + the ApexRide plugin),
 * with the same calls and answers. It runs in Node, so it keeps recording while the browser test freezes
 * the page. Readings are a steady trainer (200 W, 90 rpm, 32 km/h) and strap (142 bpm). Never in the app.
 */
const LEASE_MS = { visible: 10000, hidden: 3000 };

class FakeRideNative {
  constructor({ now = () => Date.now(), lease = LEASE_MS } = {}) {
    this.now = now;
    this.leaseMs = lease;
    this.visible = true;
    this.commands = [];  // FTMS writes the native side made: { op: 'target', watts } | { op: 'pause' } ...
    this.journal = null; // { header, samples: [json], state }
    this.active = false;
    this.listeners = {};
    this.readings = { power: 200, cadence: 90, speed: 32, hr: 142 };
  }

  _target() {
    const st = this.plan.steps[this.step];
    if (!st) return 0;
    return Math.max(this.plan.powerMin || 0, Math.min(this.plan.powerMax || 2000, Math.round(st.watts * (1 + (this.trim || 0)))));
  }
  _lease() { return this.visible ? this.leaseMs.visible : this.leaseMs.hidden; }
  _state() {
    return { step: this.step, remaining: this.remaining, distanceM: this.distanceM, maxSpeed: this.maxSpeed, trim: this.trim || 0, extraSteps: [] };
  }

  async start({ header, plan, state, samples = [] }) {
    this.visible = true;
    Object.assign(this, { active: true, owner: 'js', paused: false, ended: false, event: null, plan, native: [],
      elapsed: state.time, jsTime: state.time, step: state.step, remaining: state.remaining, distanceM: state.distanceM,
      maxSpeed: state.maxSpeed, trim: state.trim, lastJsAt: this.now(), lease: this.now() + this._lease() });
    this.journal = { header, samples: [...samples], state: JSON.stringify(this._state()) };
    return {};
  }

  async sample({ sample, state, plan }) {
    if (plan) this.plan = plan;
    if (!this.active || this.owner !== 'js' || this.paused || this.ended || state.time <= this.elapsed) return { accepted: false };
    Object.assign(this, { elapsed: state.time, jsTime: state.time, step: state.step, remaining: state.remaining,
      distanceM: state.distanceM, maxSpeed: state.maxSpeed, trim: state.trim, lastJsAt: this.now(), lease: this.now() + this._lease() });
    this.journal.samples.push(sample);
    this.journal.state = JSON.stringify(this._state());
    return { accepted: true };
  }

  /** One second of the native ticker. */
  tick() {
    if (!this.active || this.paused || this.ended) return;
    if (this.owner === 'js') {
      if (this.now() < this.lease) return;
      this.owner = 'native';
      if (this.plan.ergOn) this.commands.push({ op: 'control' }, { op: 'target', watts: this._target() });
    }
    this.elapsed++;
    this.remaining--;
    const r = this.readings, st = this.plan.steps[this.step];
    this.distanceM += r.speed / 3.6;
    this.maxSpeed = Math.max(this.maxSpeed, r.speed);
    const s = { time: this.elapsed, timestamp: Date.now(), segmentStart: !!this.nextSegment, target: st.watts, workoutStep: this.step,
      stepTime: st.duration - this.remaining, power: r.power, cadence: r.cadence, hr: r.hr, speed: r.speed,
      dist: Math.round(this.distanceM / 10) / 100, leftBal: null, rightBal: null, src: 'TRAINER', bg: 1 };
    this.nextSegment = false;
    this.native.push(JSON.stringify(s));
    this.journal.samples.push(JSON.stringify(s));
    if (this.remaining <= 0) {
      this.step++;
      if (this.step >= this.plan.steps.length) {
        this.ended = true;
        this.event = { type: 'end' };
        this.step = this.plan.steps.length - 1;
        this.remaining = 0;
      } else {
        this.remaining = this.plan.steps[this.step].duration;
        if (this.plan.ergOn) this.commands.push({ op: 'target', watts: this._target() });
      }
    }
    this.journal.state = JSON.stringify(this._state());
  }

  async setPaused({ paused }) {
    this.paused = paused;
    if (!paused) { this.lease = this.now() + this._lease(); this.nextSegment = true; }
    return {};
  }

  /** Pause/Resume from the notification. */
  notificationPause(paused) {
    this.paused = paused;
    if (this.owner === 'native') this.commands.push({ op: paused ? 'pause' : 'resume' });
    if (!paused) { this.lease = this.now() + this._lease(); this.nextSegment = true; }
    for (const cb of this.listeners.control || []) cb({ paused });
  }

  async handBack() {
    if (!this.active) return null;
    const snap = { samples: this.native, elapsed: this.elapsed, ...this._state(), paused: this.paused, event: this.event };
    this.native = [];
    this.event = null;
    this.owner = 'js';
    this.jsTime = this.elapsed;
    this.lease = this.now() + this._lease();
    return snap;
  }

  async visibility({ visible }) {
    this.visible = visible;
    if (this.owner === 'js') this.lease = Math.max(this.lastJsAt || 0, this.now() - this._lease()) + this._lease();
    return {};
  }

  /** The app process dies: the recorder stops, the journal stays. */
  kill() { this.active = false; }

  async stop() { this.active = false; this.journal = null; return {}; }
  /** At app start: the live ride (the page was reloaded) or an unfinished journal (the app was killed). */
  async recovery() { this.recovered = this.journal ? this.journal.samples.length : 0; return this.journal ? { ...this.journal, live: this.active, paused: !!this.paused } : {}; }
  async discardRecovery() { if (!this.active) this.journal = null; return {}; }
  async batteryStatus() { return { ignoring: false }; }
  async openBatterySettings() { this.batterySettingsOpened = true; return {}; }
  async askNotifications() { this.notificationsAsked = (this.notificationsAsked || 0) + 1; return {}; }
  addListener(name, cb) { (this.listeners[name] = this.listeners[name] || []).push(cb); return Promise.resolve({ remove() {} }); }
}

module.exports = { FakeRideNative, LEASE_MS };
