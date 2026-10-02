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
 *  - Adaptive profiles: steady riding uses gentler PowerMatch, hard intervals respond faster,
 *    and short bursts hold the learned trim. Configured profiles preserve all recovery time.
 *    The unconfigured legacy governor retains its bounded step lead for existing callers.
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
  // Conservative control presets, not physiological prescriptions. Trainer response still
  // depends on firmware. Auto chooses per step, so a VO2 session's recovery stays gentle.
  static PROFILES = {
    steady: { label: 'Steady', pmSettleSec: 8, pmWindow: 6, pmSlew: 1, pmDeadbandPct: 0.015, pmDeadband: 3 },
    tempo: { label: 'Sustained effort', pmSettleSec: 6, pmWindow: 4, pmSlew: 1.5, pmDeadbandPct: 0.01, pmDeadband: 3 },
    responsive: { label: 'Responsive', pmSettleSec: 5, pmWindow: 3, pmSlew: 2, pmDeadbandPct: 0.01, pmDeadband: 3 },
    burst: { label: 'Short intervals', pmSettleSec: 5, pmWindow: 3, pmSlew: 2, pmFreeze: true },
    torque: { label: 'Low cadence', pmSettleSec: 8, pmWindow: 5, pmSlew: 1, pmDeadbandPct: 0.015, pmDeadband: 3 },
    cadence: { label: 'Cadence drill', pmSettleSec: 6, pmWindow: 4, pmSlew: 1, pmDeadbandPct: 0.015, pmDeadband: 3 },
    paced: { label: 'Targeted test', pmSettleSec: 8, pmWindow: 6, pmSlew: 1, pmDeadbandPct: 0.01, pmDeadband: 3 },
    assessment: { label: 'Ramp test', pmSettleSec: 6, pmWindow: 4, pmSlew: 1, pmDeadband: 3 },
  };

  /** Explicit effort metadata takes priority over names; intensity/duration handle imports. */
  static describe(workout = {}, step = {}, selection = 'auto') {
    const name = String(step.name || '').toLowerCase();
    const pct = Number(step.pctFtp) || 0;
    const duration = Number(step.duration) || Infinity;
    const cadence = Number(step.cadence || step.targetCadence) || 0;
    const explicit = ['ramp', 'all-out', 'test', 'cadence', 'torque', 'steady'].includes(step.effort);
    const recovery = pct <= 75 && /\b(?:recovery|rest|cooldown|warmup|flush)\b/.test(name);
    const rampTest = step.effort === 'ramp' || (!explicit && workout.category === 'assessment' &&
      (workout.id === 'ramp' || /ramp\s*test/i.test(workout.title || '')));
    const allOut = step.effort === 'all-out' || (!explicit && !recovery && /all[ -]?out|\bsprint\b/.test(name));
    const cadenceDrill = step.effort === 'cadence' || (!explicit && !recovery && /\bcadence[ -](?:drill|ladder|pyramid|spin)/.test(name));
    const pacedTest = step.effort === 'test' || (!explicit && !recovery && /(?:ftp|8[ -]?(?:min|minute)|20[ -]?(?:min|minute)).*test|test.*(?:ftp|8[ -]?(?:min|minute)|20[ -]?(?:min|minute))/.test(name));
    const short = pct >= 106 && duration <= 30;
    const torque = step.effort === 'torque' || cadence > 0 && cadence <= 75 ||
      (!explicit && /\b(?:torque|grind|climb|berg|low[ -]cadence)\b/.test(name));
    const easy = pct <= 75 && !allOut && !pacedTest;
    let key = pacedTest ? 'paced' : cadenceDrill ? 'cadence' : easy ? 'steady' : rampTest ? 'assessment' : torque ? 'torque' :
      short || allOut ? 'burst' : pct >= 106 ? 'responsive' : 'tempo';
    if (selection === 'steady' || selection === 'responsive') key = selection;
    const reason = rampTest ? 'ERG follows each ramp-test target. If stall protection triggers on a test step, the test pauses rather than continuing at a reduced load.' :
      pacedTest ? 'ERG holds the prescribed test power with gentle meter corrections. This measures performance at the set target; power remains limited by that target.' :
      cadenceDrill ? 'ERG holds the power target while cadence changes. PowerMatch waits through rapid cadence changes, then resumes gentle corrections once cadence settles.' :
      key === 'torque' ? 'Gentle power corrections and a lower stall threshold respect the prescribed cadence. Stall protection eases the load if you struggle to keep the pedals turning.' :
      key === 'burst' ? 'Immediate target changes, full recoveries and no new PowerMatch corrections during short bursts. A trim learned on steady steps carries across.' :
      key === 'responsive' ? 'Immediate target changes with a shorter PowerMatch settling window for VO2 and hard-start efforts.' :
      key === 'steady' ? 'Longer power averaging and slower corrections reduce resistance hunting during easy, steady riding.' :
      'Stable power control for tempo, SweetSpot, threshold and over-unders.';
    return { key, label: VeloErg.PROFILES[key].label, reason, controlMode: 'erg',
      freeze: short || allOut, test: rampTest && !easy };
  }

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
    pmWindow: 4,
    pmDeadband: 2,
    pmDeadbandPct: 0,
    pmFreeze: false,
    pmCadencePauseSec: 0,  // configured profiles let trainer ERG settle after a cadence change
    pmCadenceChangeRpm: 8,
    standSec: 30,          // "Stand" eases the load for this long...
    standPct: 0.95,        // ...to this share of the target...
    standRampSec: 4,       // ...then ramps back to target over this many seconds
  };

  constructor(opts = {}) {
    this.defaults = { ...VeloErg.DEFAULTS, ...opts };
    this.o = { ...this.defaults };
    this.reset();
  }

  reset() {
    this.profile = null;
    this.o = { ...this.defaults };
    this.ramp = null;         // { from, dur, t, waiting, spinAt, stall }
    this.lowCadSec = 0;
    this.offset = 0;          // PowerMatch trim (W)
    this.pedalBuf = [];
    this.lastBase = null;
    this.lastStepKey = null;
    this.lastCadence = null;
    this.pmSettle = 0;
    this.standLeft = 0;       // seconds of the current stand break
    this.mode = 'normal';     // normal | soft-start | stall | ramp | stand
  }

  configure(workout, step, selection = 'auto') {
    const profile = VeloErg.describe(workout, step, selection);
    const changed = this.profile?.key !== profile.key || this.profile?.freeze !== profile.freeze;
    this.profile = profile;
    if (profile.test) {
      this.standLeft = 0;
      if (this.ramp?.stand) this.ramp = null;
    }
    // Do not raise load before the interval boundary: recovery duration is part of the workout.
    this.o = { ...this.defaults, ...VeloErg.PROFILES[profile.key], leadSec: 0,
      pmCadencePauseSec: 3,
      pmFreeze: profile.freeze || profile.key === 'burst' };
    if (changed) {
      this.pedalBuf = [];
      this.pmSettle = this.o.pmSettleSec;
      this.lowCadSec = 0;
    }
    return profile;
  }

  /** Low-cadence threshold for this step; a low-cadence drill lowers it. */
  stallThreshold(targetCadence) {
    return targetCadence ? Math.min(this.o.stallCadence, targetCadence - 15) : this.o.stallCadence;
  }

  /**
   * Called on Start, Resume, Skip, Jump, ERG on and trainer reconnect. Starts a soft start only
   * from a standstill: if you are spinning, the new target applies at once like any step change.
   */
  softStart({ target, power = 0, cadence = 0, cadenceKnown = false, targetCadence = null }) {
    if (!(target > 0)) { this.ramp = null; return; }
    const spinAt = Math.min(this.o.spinCadence, this.stallThreshold(targetCadence) + 10);
    const spinning = cadenceKnown ? cadence >= spinAt : power >= target * 0.8;
    if (spinning) { this.ramp = null; return; }
    const from = Math.min(target, Math.max(Math.round(target * this.o.softStartPct), Math.round(power || 0)));
    if (target - from < 10) { this.ramp = null; return; }
    this.ramp = { from, dur: this.o.softStartSec, t: 0, waiting: true, spinAt, stall: false };
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

  /** Wattage for events between ticks. Prepares a changed target without advancing timers. */
  now(target, stepKey = null) {
    const base = Math.max(0, target || 0);
    this.prepareTarget(base, stepKey);
    let w = this.ramp ? Math.min(base, this.cap(base)) : base + this.offset;
    if (this.standLeft > 0) w = Math.min(w, base * this.o.standPct);
    return VeloErg.clamp(w);
  }

  prepareTarget(base, stepKey = null) {
    const o = this.o;
    const newStep = stepKey !== null && stepKey !== this.lastStepKey;
    if (newStep) {
      this.lastStepKey = stepKey;
      this.lowCadSec = 0;
      // A previous standstill/stall ramp must not hold down an easy recovery.
      if (this.ramp && base <= this.ramp.from) this.ramp = null;
    }
    if (newStep || this.lastBase === null || Math.abs(base - this.lastBase) >= 5) {
      const share = this.lastBase > 0 ? this.offset / this.lastBase : 0;
      this.offset = Math.max(-o.pmMaxTrim, Math.min(o.pmMaxTrim, Math.round(share * base)));
      this.pedalBuf = [];
      this.pmSettle = o.pmSettleSec;
    }
    this.lastBase = base;
  }

  /**
   * One second of control. Returns { watts, base, mode, event }. 'stall' eases a training
   * step; 'test-stop' asks the caller to pause a failed ramp test instead of easing its load.
   *
   * input: target, nextTarget, secondsLeft and stepDuration (of the current step), cadence,
   *        cadenceKnown, power (measured, any source), targetCadence, ftp,
   *        pedalPower (null unless PowerMatch can run).
   */
  tick(input) {
    const o = this.o;
    const { target = 0, nextTarget = null, secondsLeft = Infinity, stepDuration = Infinity, cadence = 0,
      cadenceKnown = false, power = null, targetCadence = null, ftp = 0, pedalPower = null,
      stepKey = null } = input;

    // Step lead: upward steps only (hard efforts never end early), and never more than 10% of
    // the step being cut short, so HIIT recoveries keep nearly all their rest.
    let base = Math.max(0, target);
    const lead = Math.min(o.leadSec, Math.floor(stepDuration * o.leadMaxShare));
    if (nextTarget != null && nextTarget > base && lead > 0 && secondsLeft <= lead) base = nextTarget;

    // A new target: the PowerMatch trim carries over in proportion (it is a calibration between
    // pedals and trainer), and waits for the trainer to settle before adjusting again.
    this.prepareTarget(base, stepKey);

    // Trainer ERG already responds to cadence. Do not stack a meter correction on its
    // transient response to a spin-up or sudden slowdown. Timers resume at stable cadence.
    if (cadenceKnown && Number.isFinite(cadence)) {
      if (this.lastCadence !== null && Math.abs(cadence - this.lastCadence) >= o.pmCadenceChangeRpm && o.pmCadencePauseSec > 0) {
        this.pedalBuf = [];
        this.pmSettle = Math.max(this.pmSettle, o.pmCadencePauseSec);
      }
      this.lastCadence = cadence;
    } else this.lastCadence = null;

    // Anti-stall guard
    let event = null;
    const stallAt = this.stallThreshold(targetCadence);
    const hard = ftp > 0 ? base >= ftp * o.stallMinPctFtp / 100 : base >= 150;
    const waiting = !!(this.ramp && this.ramp.waiting);
    const failing = cadence < o.stopCadence || power == null || power < base * o.stallPowerPct;
    if (cadenceKnown && hard && !waiting && this.standLeft <= 0 && cadence < stallAt && failing) this.lowCadSec++;
    else this.lowCadSec = 0;
    if (this.lowCadSec >= o.stallSec) {
      if (this.profile?.test) {
        this.lowCadSec = 0;
        this.mode = 'test-stop';
        return { watts: 0, base, mode: this.mode, event: 'test-stop' };
      }
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
        this.ramp = { from: Math.round(base * o.standPct), dur: o.standRampSec, t: 0, waiting: false, spinAt: 0, stall: false, stand: true };
      }
    }

    // PowerMatch: pedals are truth; trim the trainer so pedal power meets the target.
    if (pedalPower != null) {
      this.pedalBuf.push(pedalPower);
      if (this.pedalBuf.length > o.pmWindow) this.pedalBuf.shift();
      if (this.pmSettle > 0) this.pmSettle--;
      else if (!this.ramp && this.mode !== 'stand' && !o.pmFreeze) {
        const avg = this.pedalBuf.reduce((a, b) => a + b, 0) / this.pedalBuf.length;
        const err = base - avg;
        if (avg > 20 && Math.abs(err) > Math.max(o.pmDeadband, base * o.pmDeadbandPct)) {
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
