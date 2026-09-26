/**
 * APEX VELO // LAB - ERG governor (no DOM, no Bluetooth).
 *
 * Decides the wattage sent to the trainer each second. The step target stays the goal; this
 * only shapes how the trainer gets there:
 *
 *  - Soft start: from a standstill (Start, Resume, Skip/Jump while barely pedalling, trainer
 *    reconnect) the load starts at about half the target and ramps up once you are spinning.
 *  - Anti-stall: when cadence sags on a hard step, ERG pushes back harder and harder (the
 *    "death spiral"). After a few seconds of low cadence the load drops so you can spin back
 *    up, then ramps back to target.
 *  - Step lead: an upward step is sent a moment early so the flywheel's lag lines up with the
 *    real step change.
 *  - PowerMatch: pedal power (Assioma) trims the trainer target. It settles for a few seconds
 *    after every target change and never adds watts while you are grinding, so it can no
 *    longer overshoot a step change or deepen a stall.
 *
 * A ramp only ever lowers the load below the target; it never commands more than the target.
 */
class VeloErg {
  static DEFAULTS = {
    softStartPct: 0.5,     // soft start begins at this share of target (or current power, if higher)
    softStartSec: 8,       // seconds to ramp to target once spinning
    spinCadence: 70,       // rpm that counts as "spinning" for a soft start
    stallCadence: 60,      // rpm below which a hard step starts to stall
    stallSec: 3,           // seconds of low cadence before easing off
    stallLoadPct: 0.6,     // eased load as a share of target
    recoverRpm: 15,        // spin this many rpm above the stall threshold to ramp back
    recoverSec: 6,         // seconds to ramp back to target after a stall
    stallMinPctFtp: 76,    // the anti-stall guard only acts above Z2
    leadSec: 2,            // send an upward step this many seconds early
    pmSettleSec: 6,        // PowerMatch waits this long after a target change
    pmMaxTrim: 45,         // PowerMatch trim cap (W)
    pmSlew: 2,             // PowerMatch max change per second (W)
  };

  constructor(opts = {}) {
    this.o = { ...VeloErg.DEFAULTS, ...opts };
    this.reset();
  }

  reset() {
    this.ramp = null;         // { from, dur, t, waiting, spinAt, stall }
    this.lowCadSec = 0;
    this.offset = 0;          // PowerMatch trim (W)
    this.pedalBuf = [];
    this.lastBase = null;
    this.pmSettle = 0;
    this.mode = 'normal';     // normal | soft-start | stall | ramp
  }

  /** Low-cadence threshold for this step; a low-cadence drill lowers it. */
  stallThreshold(targetCadence) {
    return targetCadence ? Math.min(this.o.stallCadence, targetCadence - 15) : this.o.stallCadence;
  }

  /**
   * Called on Start, Resume, Skip, Jump, ERG on and trainer reconnect. Starts a soft start unless
   * you are already spinning near the target.
   */
  softStart({ target, power = 0, cadence = 0, cadenceKnown = false }) {
    if (!(target > 0)) { this.ramp = null; return; }
    if (cadenceKnown && cadence >= this.o.spinCadence && power >= target * 0.8) { this.ramp = null; return; }
    const from = Math.min(target, Math.max(Math.round(target * this.o.softStartPct), Math.round(power || 0)));
    if (target - from < 10) { this.ramp = null; return; }
    this.ramp = { from, dur: this.o.softStartSec, t: 0, waiting: true, spinAt: this.o.spinCadence, stall: false };
    this.lowCadSec = 0;
    this.offset = Math.min(this.offset, 0);
  }

  /** Current load cap from an active ramp (Infinity when none). Does not advance the ramp. */
  cap(base) {
    const r = this.ramp;
    if (!r) return Infinity;
    return r.from + (base - r.from) * Math.min(1, r.t / r.dur);
  }

  /** Wattage to send right now (for events between ticks). Does not advance any state. */
  now(target) {
    const base = Math.max(0, target || 0);
    const w = this.ramp ? Math.min(base, this.cap(base)) : base + this.offset;
    return VeloErg.clamp(w);
  }

  /**
   * One second of control. Returns { watts, base, mode, event } where event is 'stall' the
   * second the guard eases the load, else null.
   *
   * input: target, nextTarget, secondsLeft (in the current step), cadence, cadenceKnown,
   *        targetCadence, ftp, pedalPower (null unless PowerMatch can run).
   */
  tick(input) {
    const o = this.o;
    const { target = 0, nextTarget = null, secondsLeft = Infinity, cadence = 0, cadenceKnown = false,
      targetCadence = null, ftp = 0, pedalPower = null } = input;

    // Step lead: upward steps only, so hard efforts never end early.
    let base = Math.max(0, target);
    if (nextTarget != null && nextTarget > base && secondsLeft <= o.leadSec) base = nextTarget;

    // A new target: PowerMatch restarts and waits for the trainer to settle.
    if (this.lastBase === null || Math.abs(base - this.lastBase) >= 5) {
      this.offset = 0;
      this.pedalBuf = [];
      this.pmSettle = o.pmSettleSec;
    }
    this.lastBase = base;

    // Anti-stall guard
    let event = null;
    const stallAt = this.stallThreshold(targetCadence);
    const hard = ftp > 0 ? base >= ftp * o.stallMinPctFtp / 100 : base >= 150;
    const waiting = !!(this.ramp && this.ramp.waiting);
    if (cadenceKnown && hard && !waiting && cadence < stallAt) this.lowCadSec++;
    else this.lowCadSec = 0;
    if (this.lowCadSec >= o.stallSec) {
      this.ramp = { from: Math.round(base * o.stallLoadPct), dur: o.recoverSec, t: 0, waiting: true, spinAt: stallAt + o.recoverRpm, stall: true };
      this.lowCadSec = 0;
      this.offset = Math.min(this.offset, 0);
      event = 'stall';
    }

    // Ramp: hold until spinning (or cadence is unknown), then climb to the target.
    let capW = Infinity;
    if (this.ramp) {
      const r = this.ramp;
      const spinAt = r.stall ? r.spinAt : Math.min(r.spinAt, stallAt + 10); // low-cadence drills spin slower
      if (r.waiting && (!cadenceKnown || cadence >= spinAt)) r.waiting = false;
      if (!r.waiting && event !== 'stall') r.t++;
      capW = this.cap(base);
      this.mode = r.waiting ? (r.stall ? 'stall' : 'soft-start') : 'ramp';
      if (r.t >= r.dur) { this.ramp = null; this.mode = 'normal'; capW = Infinity; }
    } else {
      this.mode = 'normal';
    }

    // PowerMatch: pedals are truth; trim the trainer so pedal power meets the target.
    if (pedalPower != null) {
      this.pedalBuf.push(pedalPower);
      if (this.pedalBuf.length > 4) this.pedalBuf.shift();
      if (this.pmSettle > 0) this.pmSettle--;
      else if (!this.ramp) {
        const avg = this.pedalBuf.reduce((a, b) => a + b, 0) / this.pedalBuf.length;
        const err = base - avg;
        if (avg > 20 && Math.abs(err) > 2) {
          let step = Math.sign(err) * Math.min(o.pmSlew, Math.abs(err) * 0.35);
          if (step > 0 && cadenceKnown && cadence < stallAt + 10) step = 0; // never deepen a stall
          this.offset = Math.max(-o.pmMaxTrim, Math.min(o.pmMaxTrim, this.offset + step));
        }
      }
    } else {
      this.offset = 0;
      this.pedalBuf = [];
    }

    const watts = capW !== Infinity ? Math.min(base, capW) : base + this.offset;
    return { watts: VeloErg.clamp(watts), base, mode: this.mode, event };
  }

  static clamp(w) {
    return Math.max(0, Math.min(2000, Math.round(w)));
  }
}

if (typeof window !== 'undefined') window.VeloErg = VeloErg;
