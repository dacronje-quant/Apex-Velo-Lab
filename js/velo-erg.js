/**
 * APEX VELO // LAB - ERG governor (no DOM, no Bluetooth).
 *
 * Decides the wattage sent to the trainer each second. The step target stays the goal; this
 * only shapes how the trainer gets there:
 *
 *  - Soft start: only from a real standstill (Start, Resume, Skip/Jump or a trainer reconnect
 *    while not spinning) the load starts at about half the target and ramps up once you are
 *    spinning. While you are pedalling, every step change - HIIT included - is instant.
 *  - Anti-stall: when cadence sags on a hard step, ERG pushes back harder and harder (the
 *    "death spiral"). Only when cadence is low AND you can no longer hold the watts (or the
 *    cranks have nearly stopped) does the load drop so you can spin back up. Grinding a hard
 *    effort at low cadence while holding power is left alone.
 *  - Step lead: an upward step is sent a moment early so the flywheel's lag lines up with the
 *    real step change - never more than 10% of the step it cuts into, so a 15 s recovery
 *    loses at most 1 s.
 *  - PowerMatch: pedal power (Assioma) trims the trainer target. The trim is a calibration, so
 *    it carries across steps in proportion to the new target (short intervals start already
 *    matched). It waits a few seconds after every target change before adjusting, and never
 *    adds watts while you are grinding, so it can't overshoot a step change or deepen a stall.
 *  - Stand: one tap eases the load a little for a short out-of-the-saddle break (cadence drops
 *    while standing, so the anti-stall guard and PowerMatch pause), then ramps back smoothly.
 *
 * A ramp only ever lowers the load below the target; it never commands more than the target.
 */
class VeloErg {
  static DEFAULTS = {
    softStartPct: 0.5,     // soft start begins at this share of target (or current power, if higher)
    softStartSec: 8,       // seconds to ramp to target once spinning
    spinCadence: 70,       // rpm that counts as "spinning" for a soft start
    stallCadence: 60,      // rpm below which a hard step starts to stall
    stallSec: 3,           // seconds of low cadence (and missing watts) before easing off
    stallPowerPct: 0.85,   // ...where "missing watts" means under this share of target
    stopCadence: 40,       // below this the cranks have nearly stopped: ease regardless of power
    stallLoadPct: 0.6,     // eased load as a share of target
    recoverRpm: 15,        // spin this many rpm above the stall threshold to ramp back
    recoverSec: 6,         // seconds to ramp back to target after a stall
    stallMinPctFtp: 76,    // the anti-stall guard only acts above Z2
    leadSec: 2,            // send an upward step up to this many seconds early...
    leadMaxShare: 0.1,     // ...but never more than this share of the step it cuts into
    pmSettleSec: 6,        // PowerMatch waits this long after a target change
    pmMaxTrim: 45,         // PowerMatch trim cap (W)
    pmSlew: 2,             // PowerMatch max change per second (W)
    standSec: 30,          // "Stand" eases the load for this long...
    standPct: 0.95,        // ...to this share of the target...
    standRampSec: 4,       // ...then ramps back to target over this many seconds
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
    this.standLeft = 0;       // seconds of the current stand break
    this.mode = 'normal';     // normal | soft-start | stall | ramp | stand
  }

  /** Low-cadence threshold for this step; a low-cadence drill lowers it. */
  stallThreshold(targetCadence) {
    return targetCadence ? Math.min(this.o.stallCadence, targetCadence - 15) : this.o.stallCadence;
  }

  /**
   * Called on Start, Resume, Skip, Jump, ERG on and trainer reconnect. Starts a soft start only
   * from a standstill: if you are spinning, the new target applies at once like any step change.
   */
  softStart({ target, power = 0, cadence = 0, cadenceKnown = false }) {
    if (!(target > 0)) { this.ramp = null; return; }
    const spinning = cadenceKnown ? cadence >= this.o.spinCadence : power >= target * 0.8;
    if (spinning) { this.ramp = null; return; }
    const from = Math.min(target, Math.max(Math.round(target * this.o.softStartPct), Math.round(power || 0)));
    if (target - from < 10) { this.ramp = null; return; }
    this.ramp = { from, dur: this.o.softStartSec, t: 0, waiting: true, spinAt: this.o.spinCadence, stall: false };
    this.lowCadSec = 0;
    this.offset = Math.min(this.offset, 0);
  }

  /** Starts (or restarts) a short out-of-the-saddle break; a second tap while standing ends it. */
  stand(on = this.standLeft <= 0) {
    if (on) { this.standLeft = this.o.standSec; this.lowCadSec = 0; }
    else if (this.standLeft > 0) { this.standLeft = 1; } // ends on the next second, with the ramp back
    return this.standLeft > 0;
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
    let w = this.ramp ? Math.min(base, this.cap(base)) : base + this.offset;
    if (this.standLeft > 0) w = Math.min(w, base * this.o.standPct);
    return VeloErg.clamp(w);
  }

  /**
   * One second of control. Returns { watts, base, mode, event } where event is 'stall' the
   * second the guard eases the load, else null.
   *
   * input: target, nextTarget, secondsLeft and stepDuration (of the current step), cadence,
   *        cadenceKnown, power (measured, any source), targetCadence, ftp,
   *        pedalPower (null unless PowerMatch can run).
   */
  tick(input) {
    const o = this.o;
    const { target = 0, nextTarget = null, secondsLeft = Infinity, stepDuration = Infinity, cadence = 0,
      cadenceKnown = false, power = null, targetCadence = null, ftp = 0, pedalPower = null } = input;

    // Step lead: upward steps only (hard efforts never end early), and never more than 10% of
    // the step being cut short, so HIIT recoveries keep nearly all their rest.
    let base = Math.max(0, target);
    const lead = Math.min(o.leadSec, Math.floor(stepDuration * o.leadMaxShare));
    if (nextTarget != null && nextTarget > base && lead > 0 && secondsLeft <= lead) base = nextTarget;

    // A new target: the PowerMatch trim carries over in proportion (it is a calibration between
    // pedals and trainer), and waits for the trainer to settle before adjusting again.
    if (this.lastBase === null || Math.abs(base - this.lastBase) >= 5) {
      const share = this.lastBase > 0 ? this.offset / this.lastBase : 0;
      this.offset = Math.max(-o.pmMaxTrim, Math.min(o.pmMaxTrim, Math.round(share * base)));
      this.pedalBuf = [];
      this.pmSettle = o.pmSettleSec;
    }
    this.lastBase = base;

    // Anti-stall guard
    let event = null;
    const stallAt = this.stallThreshold(targetCadence);
    const hard = ftp > 0 ? base >= ftp * o.stallMinPctFtp / 100 : base >= 150;
    const waiting = !!(this.ramp && this.ramp.waiting);
    const failing = cadence < o.stopCadence || power == null || power < base * o.stallPowerPct;
    if (cadenceKnown && hard && !waiting && this.standLeft <= 0 && cadence < stallAt && failing) this.lowCadSec++;
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

    // Stand break: eased load while standing, then a short ramp back (not a jump) to the target.
    if (this.standLeft > 0) {
      this.standLeft--;
      capW = Math.min(capW, base * o.standPct);
      this.mode = 'stand';
      this.pmSettle = Math.max(this.pmSettle, 2);
      if (this.standLeft === 0 && !this.ramp) {
        this.ramp = { from: Math.round(base * o.standPct), dur: o.standRampSec, t: 0, waiting: false, spinAt: 0, stall: false };
      }
    }

    // PowerMatch: pedals are truth; trim the trainer so pedal power meets the target.
    if (pedalPower != null) {
      this.pedalBuf.push(pedalPower);
      if (this.pedalBuf.length > 4) this.pedalBuf.shift();
      if (this.pmSettle > 0) this.pmSettle--;
      else if (!this.ramp && this.mode !== 'stand') {
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
