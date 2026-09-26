/**
 * APEX VELO // LAB - Training block planner (periodisation).
 *
 * Builds a multi-week block toward a goal from the rider's real fitness (CTL/ATL/TSB),
 * the weeks available and the days / hours per week, following established training
 * principles:
 *  - Mesocycles of 3 load weeks + 1 recovery week (load cut ~45%, a little intensity kept).
 *  - Progressive overload through a controlled CTL ramp (goal-dependent, 3-4 CTL/week;
 *    no ramp when the rider starts fatigued).
 *  - Phase progression per goal (e.g. SweetSpot base -> threshold build -> peak for FTP).
 *  - At most 2-3 key (hard) sessions a week, never on consecutive days, never the day
 *    after the long ride; the rest easy, so most time stays in Zone 1-2 (polarised/pyramidal).
 *  - The block ends with a lighter week and a ramp test to reset FTP and zones.
 *
 * The AI coach (Claude or Gemini) can decide the periodisation (week types, phases,
 * weekly load, key-session types); this engine always places the sessions on the
 * calendar and enforces the safety rules, so the plan is valid whatever the model says.
 *
 * After every ride, review() compares what was done with the plan and proposes
 * adjustments (move a missed key session, ease off when fatigued or overloaded, a small
 * push when fresh and consistent). Nothing changes until the rider accepts.
 */
class VeloBlockPlanner {
  static STORAGE_KEY = 'apex_training_block';
  static DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  static WEEK_OPTIONS = [4, 6, 8, 10, 12];

  /** Session types: intensity factor used for TSS estimates, duration limits (min) and whether it is a key (hard) session. */
  static FOCUS = {
    recovery:  { label: 'Recovery spin',      if: 0.55, min: 30, max: 60,  hard: false, color: '#7c8aa5' },
    endurance: { label: 'Zone 2 endurance',   if: 0.68, min: 45, max: 150, hard: false, color: '#3b82f6' },
    long:      { label: 'Long Zone 2 ride',   if: 0.70, min: 90, max: 300, hard: false, color: '#2563eb' },
    sweetspot: { label: 'SweetSpot',          if: 0.85, min: 45, max: 120, hard: true,  color: '#eab308' },
    threshold: { label: 'Threshold',          if: 0.90, min: 45, max: 105, hard: true,  color: '#f97316' },
    vo2max:    { label: 'VO2 max',            if: 0.87, min: 45, max: 75,  hard: true,  color: '#ef4444' },
    test:      { label: 'FTP ramp test',      if: 0.98, min: 25, max: 25,  hard: true,  color: '#a78bfa' }
  };

  /** Phase progression per goal: key-session types in order of priority. */
  static PHASES = {
    ftp: [
      { name: 'Base: SweetSpot foundation', keys: ['sweetspot', 'sweetspot', 'threshold'] },
      { name: 'Build: threshold', keys: ['threshold', 'sweetspot', 'vo2max'] },
      { name: 'Peak: threshold + VO2', keys: ['threshold', 'vo2max', 'sweetspot'] }
    ],
    vo2: [
      { name: 'Support: threshold', keys: ['threshold', 'sweetspot', 'vo2max'] },
      { name: 'Build: VO2 max', keys: ['vo2max', 'threshold', 'vo2max'] },
      { name: 'Peak: VO2 density', keys: ['vo2max', 'vo2max', 'threshold'] }
    ],
    longevity: [
      { name: 'Aerobic base', keys: ['sweetspot', 'threshold'] },
      { name: 'Durability', keys: ['sweetspot', 'threshold'] },
      { name: 'Consolidate', keys: ['threshold', 'sweetspot'] }
    ],
    balanced: [
      { name: 'Polarised base', keys: ['vo2max', 'sweetspot', 'threshold'] },
      { name: 'Polarised build', keys: ['vo2max', 'threshold', 'sweetspot'] },
      { name: 'Sharpen', keys: ['vo2max', 'threshold', 'vo2max'] }
    ]
  };

  /** Load weight of each session type when splitting a week's TSS. */
  static WEIGHT = { recovery: 0.35, endurance: 0.75, long: 1.5, sweetspot: 1.0, threshold: 1.0, vo2max: 0.9, test: 0 };
  static K = Math.exp(-1 / 6); // CTL decay over 7 days (42-day time constant)

  constructor(coach) {
    this.coach = coach;
    this.block = VeloBlockPlanner.load();
  }

  // ---------------------------------------------------------------- storage --
  static load() {
    try {
      const b = JSON.parse(localStorage.getItem(VeloBlockPlanner.STORAGE_KEY) || 'null');
      return b && Array.isArray(b.weeks) ? b : null;
    } catch (e) { return null; }
  }
  save() {
    try {
      if (this.block) localStorage.setItem(VeloBlockPlanner.STORAGE_KEY, JSON.stringify(this.block));
      else localStorage.removeItem(VeloBlockPlanner.STORAGE_KEY);
    } catch (e) { /* storage unavailable */ }
  }
  clear() { this.block = null; this.save(); }

  // ------------------------------------------------------------------ dates --
  static key(d) { return VeloMetrics.localDateKey(d); }
  static parse(k) { return new Date(`${k}T00:00:00`); }
  static addDays(k, n) { const d = VeloBlockPlanner.parse(k); d.setDate(d.getDate() + n); return VeloBlockPlanner.key(d); }
  static dow(k) { return (VeloBlockPlanner.parse(k).getDay() + 6) % 7; } // Mon = 0
  static mondayOf(k) { return VeloBlockPlanner.addDays(k, -VeloBlockPlanner.dow(k)); }
  static today() { return VeloBlockPlanner.key(new Date()); }

  // ------------------------------------------------------------- estimates --
  static tssFor(focus, minutes) {
    const f = VeloBlockPlanner.FOCUS[focus];
    if (!f || !minutes) return 0;
    if (focus === 'test') return 38;
    return Math.round((minutes / 60) * f.if * f.if * 100);
  }
  static minutesFor(focus, tss) {
    const f = VeloBlockPlanner.FOCUS[focus];
    return f ? (tss / (f.if * f.if * 100)) * 60 : 0;
  }
  static round5(x) { return Math.max(5, Math.round(x / 5) * 5); }
  /** Daily TSS that moves CTL from `ctl` by `ramp` over one week. */
  static dailyTssForRamp(ctl, ramp) { return ctl + ramp / (1 - VeloBlockPlanner.K); }
  static nextCtl(ctl, weekTss) { const K = VeloBlockPlanner.K; return ctl * K + (weekTss / 7) * (1 - K); }

  /** Normalises the setup options coming from the UI. */
  static normaliseOptions(o = {}) {
    const goal = VeloAiCoach.GOALS[o.goal] ? o.goal : 'ftp';
    const w = Math.round(Number(o.weeks));
    const weeks = w >= 1 && w <= 16 ? w : 8;
    const hours = Math.min(25, Math.max(2, Number(o.hoursPerWeek) || 6));
    let days = Array.isArray(o.days) ? [...new Set(o.days.map(Number).filter(d => d >= 0 && d <= 6))].sort((a, b) => a - b) : [];
    if (days.length < 2) days = [1, 3, 5, 6];
    const start = /^\d{4}-\d{2}-\d{2}$/.test(o.startDate || '') ? o.startDate : VeloBlockPlanner.today();
    let longDay = o.longDay === '' || o.longDay === null || o.longDay === undefined ? null : Number(o.longDay);
    if (longDay !== null && !days.includes(longDay)) longDay = null;
    if (longDay === null && hours >= 4) longDay = days.includes(6) ? 6 : days.includes(5) ? 5 : null;
    return { goal, weeks, hoursPerWeek: Math.round(hours * 2) / 2, days, startDate: start, longDay };
  }

  // -------------------------------------------------------------- skeleton --
  /**
   * Week types and phases for the block: 3 load weeks + 1 recovery week, last week lighter with a ramp test.
   */
  static skeleton(opts) {
    const n = opts.weeks;
    const types = Array.from({ length: n }, (_, i) => ((i + 1) % 4 === 0 ? 'recovery' : 'build'));
    types[n - 1] = 'test';
    // Group load weeks into mesocycles to assign phases.
    const meso = [];
    let cur = [];
    types.forEach((t, i) => { cur.push(i); if (t !== 'build' || i === n - 1) { meso.push(cur); cur = []; } });
    if (cur.length) meso.push(cur);
    const phases = VeloBlockPlanner.PHASES[opts.goal] || VeloBlockPlanner.PHASES.ftp;
    const usable = n <= 4 ? [phases[1]] : n <= 6 ? [phases[0], phases[1]] : phases;
    const out = new Array(n);
    meso.forEach((weeksIdx, m) => {
      const phase = usable[Math.min(usable.length - 1, Math.floor((m * usable.length) / meso.length))];
      let loadNo = 0;
      const loadCount = weeksIdx.filter(i => types[i] === 'build').length;
      weeksIdx.forEach(i => {
        if (types[i] === 'build') loadNo++;
        out[i] = { type: types[i], phase: phase.name, keys: phase.keys, stage: types[i] === 'build' ? `${loadNo}/${loadCount}` : '' };
      });
    });
    return out;
  }

  /** Key (hard) sessions per week from goal, hours and available days. */
  static keysPerWeek(goal, hours, dayCount) {
    let k = goal === 'longevity' ? (hours >= 10 ? 2 : 1) : (hours >= 9 && dayCount >= 5 ? 3 : 2);
    if (hours < 3.5 && goal !== 'longevity') k = Math.min(k, 2);
    return Math.max(1, Math.min(k, Math.ceil(dayCount / 2)));
  }

  // ---------------------------------------------------------------- placing --
  /**
   * Chooses the hard days of a week: no two hard days in a row (also across the week
   * boundary), not the day after the long ride; spread as evenly as possible.
   */
  static pickHardDays(candidates, k, longIdx, prevHard = [], blocked = []) {
    const combos = [];
    const rec = (start, pick) => {
      if (pick.length === k) { combos.push(pick.slice()); return; }
      for (let i = start; i < candidates.length; i++) { pick.push(candidates[i]); rec(i + 1, pick); pick.pop(); }
    };
    for (let kk = Math.min(k, candidates.length); kk >= 1; kk--) {
      k = kk; combos.length = 0; rec(0, []);
      let best = null, bestScore = -Infinity;
      for (const c of combos) {
        const all = [...prevHard, ...c].sort((a, b) => a - b);
        let ok = true, minGap = 7;
        for (let i = 1; i < all.length; i++) { const g = all[i] - all[i - 1]; if (g < 2) ok = false; minGap = Math.min(minGap, g); }
        if (longIdx !== null && c.includes(longIdx + 1)) ok = false;
        if (c.some(d => blocked.includes(d))) ok = false;
        if (!ok) continue;
        const score = minGap * 10 - c.reduce((a, d) => a + (longIdx !== null && d === longIdx - 1 ? 3 : 0), 0);
        if (score > bestScore) { bestScore = score; best = c; }
      }
      if (best) return best;
    }
    return [];
  }

  /**
   * Places one week's sessions.
   * @returns {Array} sessions sorted by date
   */
  static placeWeek({ weekStart, available, info, targetTss, opts, prevHard, keyFoci, prevLongDow = null, ctl = 0 }) {
    const F = VeloBlockPlanner.FOCUS;
    const idxs = available.map(a => a.dow);
    const recoveryLike = info.type !== 'build';
    const hoursCap = opts.hoursPerWeek * 60 * (info.type === 'build' ? 1 : 0.65) * (available.length / opts.days.length);
    let maxSessions = Math.max(2, Math.floor((opts.hoursPerWeek * 60) / 45));
    // Recovery / test weeks: fewer, shorter rides (volume down ~40-50%, a little intensity kept).
    if (recoveryLike) maxSessions = Math.min(maxSessions, Math.max(3, Math.round(idxs.length * 0.6)));
    const easyCap = info.type === 'test' ? 60 : 75;

    // Long ride
    let longIdx = opts.longDay !== null && idxs.includes(opts.longDay) && opts.hoursPerWeek >= 4 ? opts.longDay : null;
    // Key sessions
    let keysWanted = info.type === 'build' ? VeloBlockPlanner.keysPerWeek(opts.goal, opts.hoursPerWeek, opts.days.length) : 1;
    // A low training load (CTL < 30) supports at most 2 hard sessions a week.
    if (ctl < 30) keysWanted = Math.min(keysWanted, 2);
    if (info.type === 'test') keysWanted = 0; // the test is the key session
    const plan = new Map(); // dow -> focus
    let testIdx = null;
    if (info.type === 'test') {
      // Test late in the week, with an easier day before it.
      const late = idxs.filter(d => d >= 3);
      testIdx = late.length ? (late.length > 1 && late[late.length - 1] === longIdx ? late[late.length - 2] : late[late.length - 1]) : idxs[idxs.length - 1];
      if (testIdx === longIdx) longIdx = null;
      plan.set(testIdx, 'test');
    }
    const candidates = idxs.filter(d => d !== longIdx && d !== testIdx);
    const foci = (keyFoci && keyFoci.length ? keyFoci : info.keys) || ['sweetspot'];
    // Never hard the day after last week's Sunday long ride.
    const blocked = prevLongDow === 6 ? [0] : [];
    const hardDays = keysWanted ? VeloBlockPlanner.pickHardDays(candidates, keysWanted, longIdx, prevHard, blocked) : [];
    hardDays.forEach((d, i) => plan.set(d, recoveryLike ? (foci[i % foci.length] === 'vo2max' ? 'vo2max' : 'sweetspot') : foci[i % foci.length]));
    if (longIdx !== null) plan.set(longIdx, recoveryLike ? 'endurance' : 'long');
    // Remaining days: easy. The day after a hard day (or before the test) is a recovery spin.
    const hardSet = new Set([...hardDays, ...(testIdx !== null ? [testIdx] : [])]);
    idxs.forEach(d => {
      if (plan.has(d)) return;
      plan.set(d, hardSet.has(d - 1) || (testIdx !== null && d === testIdx - 1) ? 'recovery' : 'endurance');
    });
    // In lighter weeks keep the rides next to the key session / test and drop the rest first.
    // Too many sessions for the hours: drop easy days (recovery first).
    let order = [...plan.entries()];
    const droppable = () => order.filter(([, f]) => f === 'recovery').concat(order.filter(([, f]) => f === 'endurance'));
    while (order.length > maxSessions) {
      const d = droppable()[0];
      if (!d) break;
      order = order.filter(e => e !== d);
    }

    // Split the weekly TSS by weight, then convert to minutes within each type's limits.
    const W = VeloBlockPlanner.WEIGHT;
    const fixedTss = order.reduce((a, [, f]) => a + (f === 'test' ? 38 : 0), 0);
    const totalW = order.reduce((a, [, f]) => a + (W[f] || 0), 0) || 1;
    let items = order.map(([d, f]) => {
      const tssShare = f === 'test' ? 38 : Math.max(0, targetTss - fixedTss) * (W[f] || 0) / totalW;
      let min = f === 'test' ? 25 : VeloBlockPlanner.minutesFor(f, tssShare);
      const lim = F[f];
      if (recoveryLike && lim.hard && f !== 'test') min = Math.min(min, 50);
      if (recoveryLike && !lim.hard) min = Math.min(min, easyCap);
      min = Math.min(lim.max, Math.max(lim.min, min));
      return { dow: d, focus: f, min };
    });
    // Respect the hours available: trim easy sessions first, then key sessions (never below their minimum).
    const total = () => items.reduce((a, it) => a + it.min, 0);
    for (const pass of [['recovery', 'endurance', 'long'], ['sweetspot', 'threshold', 'vo2max']]) {
      const over = total() - hoursCap;
      if (over <= 0) break;
      const pool = items.filter(it => pass.includes(it.focus));
      const slack = pool.reduce((a, it) => a + (it.min - F[it.focus].min), 0);
      if (slack <= 0) continue;
      const cut = Math.min(1, over / slack);
      pool.forEach(it => { it.min -= (it.min - F[it.focus].min) * cut; });
    }
    while (total() > hoursCap + 20 && items.some(it => it.focus === 'recovery' || it.focus === 'endurance')) {
      const drop = items.find(it => it.focus === 'recovery') || items.find(it => it.focus === 'endurance');
      items = items.filter(it => it !== drop);
    }
    const labelFor = (f) => {
      if (f === 'long') return F.long.label;
      if (f === 'test') return F.test.label;
      if (recoveryLike && F[f].hard) return `${F[f].label} (short, keep sharp)`;
      return F[f].label;
    };
    return items
      .map(it => {
        const date = VeloBlockPlanner.addDays(weekStart, it.dow);
        const minutes = it.focus === 'test' ? 25 : VeloBlockPlanner.round5(it.min);
        return {
          id: `bs_${date}_${it.focus}`,
          date,
          focus: it.focus,
          key: !!F[it.focus].hard,
          title: labelFor(it.focus),
          durationMin: minutes,
          tss: VeloBlockPlanner.tssFor(it.focus, minutes),
          status: 'planned'
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  // ------------------------------------------------------------------ build --
  /**
   * Builds the whole block. `design` (optional, from the AI) may override per week:
   * { type, phase, targetTss, keySessions: [...], notes }.
   */
  static assemble(opts, ctx, design = null) {
    const n = opts.weeks;
    const skel = VeloBlockPlanner.skeleton(opts);
    const goal = VeloAiCoach.GOALS[opts.goal] || VeloAiCoach.GOALS.ftp;
    let ctl = Math.max(0, ctx.ctl || 0);
    const startCtl = ctl;
    const fatiguedStart = (ctx.tsb || 0) < -15;
    const firstMonday = VeloBlockPlanner.mondayOf(opts.startDate);
    const weeks = [];
    let lastBuildTss = null;
    let prevHard = [];
    let prevLongDow = null;
    for (let w = 0; w < n; w++) {
      const d = design && Array.isArray(design.weeks) ? (design.weeks.find(x => x && Number(x.week) === w + 1) || design.weeks[w] || null) : null;
      const info = { ...skel[w] };
      if (d && ['build', 'recovery', 'test'].includes(d.type) && (w === n - 1 ? d.type === 'test' || d.type === 'recovery' : d.type !== 'test')) info.type = d.type;
      if (w === n - 1) info.type = 'test';
      if (d && typeof d.phase === 'string' && d.phase.trim()) info.phase = d.phase.trim().slice(0, 60);

      const weekStart = VeloBlockPlanner.addDays(firstMonday, w * 7);
      const available = opts.days
        .map(dow => ({ dow, date: VeloBlockPlanner.addDays(weekStart, dow) }))
        .filter(a => a.date >= opts.startDate);
      const frac = available.length / opts.days.length;

      // Physiology-based weekly load.
      const ramp = info.type !== 'build' ? 0 : (w === 0 && fatiguedStart ? 0 : goal.ctlRampPerWeek);
      let safeTss;
      if (info.type === 'build') safeTss = VeloBlockPlanner.dailyTssForRamp(ctl, ramp) * 7;
      else safeTss = (lastBuildTss || VeloBlockPlanner.dailyTssForRamp(ctl, 0) * 7) * (info.type === 'test' ? 0.6 : 0.55);
      safeTss = Math.max(90, safeTss);
      let targetTss = safeTss;
      if (d && Number(d.targetTss) > 0) {
        // Accept the model's number within a physiologically safe band (max ramp ~8 CTL/week).
        const hi = info.type === 'build' ? VeloBlockPlanner.dailyTssForRamp(ctl, 8) * 7 : safeTss * 1.2;
        targetTss = Math.min(hi, Math.max(safeTss * 0.6, Number(d.targetTss)));
      }
      targetTss *= frac;
      const keyFoci = d && Array.isArray(d.keySessions) ? d.keySessions.filter(f => ['sweetspot', 'threshold', 'vo2max'].includes(f)) : null;
      const sessions = available.length
        ? VeloBlockPlanner.placeWeek({ weekStart, available, info, targetTss, opts, prevHard, keyFoci, prevLongDow, ctl })
        : [];
      const lastLong = sessions.filter(s => s.focus === 'long').pop();
      prevLongDow = lastLong ? VeloBlockPlanner.dow(lastLong.date) : null;
      const planned = sessions.reduce((a, s) => a + s.tss, 0);
      if (info.type === 'build') lastBuildTss = planned / (frac || 1);
      // Carry this week's hard days into the next week's spacing check (Sun hard -> Mon can't be hard).
      prevHard = sessions.filter(s => s.key).map(s => VeloBlockPlanner.dow(s.date) - 7);
      ctl = VeloBlockPlanner.nextCtl(ctl, planned);
      weeks.push({
        index: w + 1,
        start: weekStart,
        type: info.type,
        phase: info.type === 'recovery' ? 'Recovery week' : info.type === 'test' ? 'Recovery + FTP test' : info.phase,
        stage: info.stage,
        plannedTss: Math.round(planned),
        plannedMin: sessions.reduce((a, s) => a + s.durationMin, 0),
        projectedCtl: Math.round(ctl * 10) / 10,
        targetTss: Math.round(targetTss),
        cappedByHours: info.type === 'build' && planned < targetTss * 0.85,
        notes: d && typeof d.notes === 'string' ? d.notes.slice(0, 280) : '',
        sessions
      });
    }
    const allSessions = weeks.flatMap(x => x.sessions);
    const easyMin = allSessions.filter(s => !s.key).reduce((a, s) => a + s.durationMin, 0);
    const totalMin = allSessions.reduce((a, s) => a + s.durationMin, 0) || 1;
    return {
      weeks,
      stats: {
        startCtl: Math.round(startCtl * 10) / 10,
        endCtl: weeks.length ? weeks[weeks.length - 1].projectedCtl : startCtl,
        peakCtl: Math.max(startCtl, ...weeks.map(x => x.projectedCtl)),
        easyPct: Math.round((easyMin / totalMin) * 100),
        keySessions: allSessions.filter(s => s.key && s.focus !== 'test').length
      }
    };
  }

  static offlineSummary(opts, built, ctx) {
    const goal = VeloAiCoach.GOALS[opts.goal] || VeloAiCoach.GOALS.ftp;
    const recov = built.weeks.filter(w => w.type === 'recovery').length;
    const phases = [...new Set(built.weeks.filter(w => w.type === 'build').map(w => w.phase))];
    return `${opts.weeks}-week ${goal.label} block: ${phases.join(' -> ')}. Load weeks are followed by ${recov ? `${recov} recovery week${recov > 1 ? 's' : ''} (about 45% less load) and ` : ''}a final lighter week with a ramp test to reset your FTP and zones. `
      + `Fitness (CTL) is planned to go from ${built.stats.startCtl} to about ${built.stats.endCtl} (peak ${built.stats.peakCtl}), a ramp of ${goal.ctlRampPerWeek} CTL per load week${(ctx.tsb || 0) < -15 ? ' after an easier first week because you start fatigued' : ''}. `
      + `Key sessions are never on consecutive days or the day after the long ride, and about ${built.stats.easyPct}% of the riding time is easy.`
      + (() => {
        const load = built.weeks.filter(w => w.type === 'build');
        if (!load.length) return '';
        const first = load[0].plannedMin / 60, peak = Math.max(...load.map(w => w.plannedMin)) / 60;
        return peak < opts.hoursPerWeek * 0.8
          ? ` Volume builds from ${first.toFixed(1)} to ${peak.toFixed(1)} h/week rather than your full ${opts.hoursPerWeek} h: a faster jump in load is the classic route to overreaching.`
          : '';
      })();
  }

  // ----------------------------------------------------------------- AI part --
  buildDesignPrompt(opts, ctx) {
    const h = ctx.history || {};
    const goal = VeloAiCoach.GOALS[opts.goal] || VeloAiCoach.GOALS.ftp;
    const skel = VeloBlockPlanner.skeleton(opts);
    const dayNames = opts.days.map(d => VeloBlockPlanner.DAY_NAMES[d]).join(', ');
    return `You are an elite cycling coach and exercise physiologist. Design the periodisation of a ${opts.weeks}-week indoor training block for rider "${ctx.profile.name}".

RIDER: FTP ${ctx.profile.ftp} W, weight ${ctx.profile.weightKg} kg.
GOAL: ${goal.label} - ${goal.summary}
AVAILABILITY: ${opts.hoursPerWeek} h/week on ${dayNames}${opts.longDay !== null ? `; long ride on ${VeloBlockPlanner.DAY_NAMES[opts.longDay]}` : ''}. Block starts ${opts.startDate}.
CURRENT STATE: CTL ${ctx.ctl.toFixed(1)}, ATL ${ctx.atl.toFixed(1)}, TSB ${ctx.tsb.toFixed(1)} (${ctx.formZone}); last 7 days ${ctx.sevenDayTss} TSS.
LAST ${ctx.lookbackDays} DAYS: ${h.ridesWin} rides, ${h.hoursPerWeekWin} h/week, intensity mix easy ${h.lowIntensityPct ?? 'n/a'}% / tempo-SweetSpot ${h.midIntensityPct ?? 'n/a'}% / threshold+ ${h.highIntensityPct ?? 'n/a'}%; days since last hard ride ${h.daysSinceHard ?? 'n/a'}; power profile ${h.profileType || 'n/a'}.
${ctx.notes ? `RIDER NOTES: ${ctx.notes}\n` : ''}DEFAULT STRUCTURE (adjust if the physiology says so): ${skel.map((s, i) => `W${i + 1} ${s.type}`).join(', ')}.

PRINCIPLES TO APPLY: progressive overload with CTL ramp 2-6 per load week (lower if fatigued or low training age); 3:1 or 2:1 load:recovery; recovery weeks ~40-50% less load but keep brief intensity; phase progression toward the goal (general -> specific); 1-3 key sessions per week depending on hours; most time easy (polarised or pyramidal); final week lighter with an FTP ramp test.

Return ONLY JSON:
{
  "summary": "3-5 sentences: the logic of this block for this rider",
  "weeks": [ { "week": 1, "type": "build" | "recovery" | "test", "phase": "short phase name", "targetTss": 350, "keySessions": ["sweetspot" | "threshold" | "vo2max", ...], "notes": "one sentence: the week's intent" } ]
}
Exactly ${opts.weeks} weeks; the last week has type "test". targetTss is the week's total TSS. keySessions lists the hard sessions in order of priority (the app places them on days, spaces them 48 h apart and adds the easy rides and long ride).`;
  }

  /** Asks the selected AI provider for the block design. Returns { design, label } or throws. */
  async requestDesign(opts, ctx) {
    const c = this.coach;
    const model = c.model;
    const effort = VeloAiCoach.supportsEffort(model) ? c.effort : null;
    const resp = await fetch(VeloAiCoach.COACH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: this.buildDesignPrompt(opts, ctx), provider: c.provider, model, effort })
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(json.error || `${VeloAiCoach.labelFor(model)} error (${resp.status})`);
    if (json.stopReason === 'max_tokens') throw new Error('the answer was cut off (max tokens)');
    const raw = String(json.text || '');
    let parsed;
    try { parsed = JSON.parse(raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim()); } catch (e) {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('the response was not JSON');
      parsed = JSON.parse(m[0]);
    }
    if (!parsed || !Array.isArray(parsed.weeks) || parsed.weeks.length < opts.weeks) throw new Error('the response did not contain every week');
    return { design: parsed, model: json.model || model, provider: json.provider || c.provider, thinking: json.thinking || '' };
  }

  /**
   * Creates a new block. Uses the selected AI provider when it is available, otherwise
   * (or if the call fails) the built-in engine. Returns the block.
   */
  async create(options, { useAi = true } = {}) {
    const opts = VeloBlockPlanner.normaliseOptions(options);
    const ctx = this.coach.getPhysiologicalContext('auto', 60, opts.goal, options.notes || '');
    let design = null, source = 'offline_heuristic', model = null, apiError = null, thinking = '';
    if (useAi) {
      if (!this.coach.isLive) await this.coach.detectEngine();
      if (this.coach.isLive) {
        try {
          const r = await this.requestDesign(opts, ctx);
          design = r.design; source = r.provider; model = r.model; thinking = r.thinking;
        } catch (e) {
          apiError = `${VeloAiCoach.labelFor(this.coach.model)} unavailable (${e.message}). Built with the built-in periodisation engine instead.`;
        }
      }
    }
    const built = VeloBlockPlanner.assemble(opts, ctx, design);
    const summary = design && typeof design.summary === 'string' && design.summary.trim()
      ? design.summary.trim().slice(0, 1200)
      : VeloBlockPlanner.offlineSummary(opts, built, ctx);
    const last = built.weeks[built.weeks.length - 1];
    this.block = {
      id: 'blk_' + Date.now(),
      createdAt: new Date().toISOString(),
      options: opts,
      goal: opts.goal,
      startDate: opts.startDate,
      endDate: last ? VeloBlockPlanner.addDays(last.start, 6) : opts.startDate,
      source,
      model,
      modelLabel: model ? VeloAiCoach.labelFor(model) : null,
      summary,
      thinking: thinking ? String(thinking).slice(0, 8000) : '',
      stats: built.stats,
      weeks: built.weeks,
      suggestions: [],
      log: [{ at: new Date().toISOString(), text: `Block created (${source === 'offline_heuristic' ? 'built-in engine' : VeloAiCoach.labelFor(model)}).` }]
    };
    this.save();
    return { block: this.block, apiError };
  }

  /**
   * Re-plans the rest of the block from today with the current fitness, keeping what was already done.
   */
  async replanFromToday({ useAi = true } = {}) {
    const b = this.block;
    if (!b) return { block: null };
    const today = VeloBlockPlanner.today();
    const thisMonday = VeloBlockPlanner.mondayOf(today);
    const endMonday = VeloBlockPlanner.mondayOf(b.endDate);
    const weeksLeft = Math.max(1, Math.round((VeloBlockPlanner.parse(endMonday) - VeloBlockPlanner.parse(thisMonday)) / (7 * 86400000)) + 1);
    const keptWeeks = b.weeks.filter(w => w.start < thisMonday);
    const cur = b.weeks.find(w => w.start === thisMonday);
    const keptThisWeek = cur ? cur.sessions.filter(s => s.date < today) : [];
    const old = { log: b.log || [], startDate: b.startDate };
    const res = await this.create({ ...b.options, weeks: weeksLeft, startDate: today }, { useAi });
    if (res.block) {
      const nb = res.block;
      if (nb.weeks.length && keptThisWeek.length) nb.weeks[0].sessions = [...keptThisWeek, ...nb.weeks[0].sessions];
      nb.weeks = [...keptWeeks, ...nb.weeks].map((w, i) => ({ ...w, index: i + 1 }));
      nb.startDate = old.startDate;
      nb.log = [...old.log, { at: new Date().toISOString(), text: 'Re-planned the remaining weeks from today with current fitness.' }].slice(-30);
      this.save();
    }
    return res;
  }

  // ----------------------------------------------------------------- review --
  allSessions() { return this.block ? this.block.weeks.flatMap(w => w.sessions) : []; }
  findSession(id) { return this.allSessions().find(s => s.id === id) || null; }
  weekOf(date) { return this.block ? this.block.weeks.find(w => date >= w.start && date <= VeloBlockPlanner.addDays(w.start, 6)) || null : null; }

  /** Planned sessions by date key (for the calendar). */
  sessionsByDate() {
    const m = new Map();
    this.allSessions().forEach(s => { if (!m.has(s.date)) m.set(s.date, []); m.get(s.date).push(s); });
    return m;
  }

  /**
   * Compares the plan with the rides and proposes adjustments.
   * @returns {Array} newly created suggestions
   */
  review(rides, ctx, now = new Date()) {
    const b = this.block;
    if (!b) return [];
    const today = VeloBlockPlanner.key(now);
    const byDay = new Map();
    (rides || []).forEach(r => {
      const k = VeloMetrics.localDateKey(r.date);
      if (!k) return;
      byDay.set(k, (byDay.get(k) || 0) + (Number(r.tss) || 0));
    });
    // 1. Mark done / missed.
    this.allSessions().forEach(s => {
      if (s.status === 'skipped') return;
      if (byDay.has(s.date)) { s.status = 'done'; s.actualTss = Math.round(byDay.get(s.date)); }
      else if (s.date < today) s.status = 'missed';
      else s.status = 'planned';
    });
    b.weeks.forEach(w => {
      w.doneTss = Math.round(w.sessions.filter(s => s.status === 'done').reduce((a, s) => a + (s.actualTss || 0), 0));
      // Rides on unplanned days in this week count too.
      const end = VeloBlockPlanner.addDays(w.start, 6);
      let extra = 0;
      byDay.forEach((tss, k) => { if (k >= w.start && k <= end && !w.sessions.some(s => s.date === k)) extra += tss; });
      w.doneTss += Math.round(extra);
    });

    const existing = new Set((b.suggestions || []).map(s => s.key));
    const fresh = [];
    const add = (s) => { if (existing.has(s.key)) return; existing.add(s.key); fresh.push({ ...s, id: 'sg_' + Date.now() + '_' + fresh.length, createdAt: new Date().toISOString(), status: 'pending' }); };
    const upcoming = this.allSessions().filter(s => s.date >= today && s.status === 'planned').sort((a, c) => a.date.localeCompare(c.date));
    const nextKey = upcoming.find(s => s.key && s.focus !== 'test');
    const tsb = ctx ? ctx.tsb : 0;
    const F = VeloBlockPlanner.FOCUS;

    // 2. Fatigue: ease the next key session (or the next two days) when form is deep in the red.
    if (ctx && tsb < -25 && nextKey && VeloBlockPlanner.parse(nextKey.date) - VeloBlockPlanner.parse(today) <= 3 * 86400000) {
      const deep = tsb < -32;
      add({
        key: `fatigue_${nextKey.id}`,
        type: 'ease',
        title: deep ? 'Deep fatigue: swap the next key session for recovery' : 'High fatigue: turn the next key session into endurance',
        reason: `Form (TSB) is ${tsb.toFixed(1)}. Adaptation happens during recovery; another hard day now mostly adds fatigue.`,
        changes: [{ sessionId: nextKey.id, patch: deep
          ? { focus: 'recovery', title: F.recovery.label, durationMin: 40, key: false }
          : { focus: 'endurance', title: `${F.endurance.label} (eased)`, durationMin: Math.max(45, Math.round(nextKey.durationMin * 0.8 / 5) * 5), key: false } }]
      });
    }

    // 3. Overload: last 7 days well above plan -> trim the next session by 20%.
    const weekAgo = VeloBlockPlanner.addDays(today, -7);
    const plannedLast7 = this.allSessions().filter(s => s.date >= weekAgo && s.date < today).reduce((a, s) => a + s.tss, 0);
    let doneLast7 = 0;
    byDay.forEach((tss, k) => { if (k >= weekAgo && k < today) doneLast7 += tss; });
    if (plannedLast7 > 60 && doneLast7 > plannedLast7 * 1.25 && upcoming[0] && !(ctx && tsb < -25)) {
      const s = upcoming[0];
      add({
        key: `overload_${weekAgo}`,
        type: 'ease',
        title: `You rode ${Math.round((doneLast7 / plannedLast7 - 1) * 100)}% more than planned this week: shorten the next session`,
        reason: `${Math.round(doneLast7)} TSS done vs ${Math.round(plannedLast7)} planned in 7 days. Absorbing the extra load protects the rest of the block.`,
        changes: [{ sessionId: s.id, patch: { durationMin: Math.max(F[s.focus].min, Math.round(s.durationMin * 0.8 / 5) * 5) } }]
      });
    }

    // 4. Missed key session in the last 3 days -> move it to a free or easy day this week (48 h from other key days).
    const missedKeys = this.allSessions().filter(s => s.key && s.status === 'missed' && s.focus !== 'test' && s.date >= VeloBlockPlanner.addDays(today, -3));
    missedKeys.forEach(m => {
      const w = this.weekOf(m.date);
      if (!w || w.type !== 'build') return;
      const end = VeloBlockPlanner.addDays(w.start, 6);
      const keyDates = this.allSessions().filter(s => s.key && s !== m && s.status !== 'missed').map(s => s.date);
      const ok = (d) => !keyDates.some(k => Math.abs(VeloBlockPlanner.parse(k) - VeloBlockPlanner.parse(d)) < 2 * 86400000);
      const target = upcoming.find(s => !s.key && s.focus !== 'long' && s.date <= end && ok(s.date));
      if (target) {
        add({
          key: `move_${m.id}`,
          type: 'move',
          title: `Missed ${m.title} on ${VeloBlockPlanner.parse(m.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}: move it to ${VeloBlockPlanner.parse(target.date).toLocaleDateString('en-US', { weekday: 'short' })}`,
          reason: 'Key sessions drive the adaptation of this phase. It replaces an easy ride and still leaves 48 h between hard days.',
          changes: [{ sessionId: target.id, patch: { focus: m.focus, title: m.title, durationMin: Math.min(m.durationMin, F[m.focus].max), key: true } }]
        });
      } else {
        add({
          key: `drop_${m.id}`,
          type: 'info',
          title: `Missed ${m.title} - no safe day left this week`,
          reason: 'Do not squeeze it in back-to-back with another hard day; the plan continues as scheduled.',
          changes: []
        });
      }
    });

    // 5. Low consistency over 14 days -> scale the rest of this week down.
    const twoWeeksAgo = VeloBlockPlanner.addDays(today, -14);
    const past14 = this.allSessions().filter(s => s.date >= twoWeeksAgo && s.date < today);
    if (past14.length >= 4) {
      const done = past14.filter(s => s.status === 'done').length;
      const w = this.weekOf(today);
      if (done / past14.length < 0.5 && w && w.type === 'build') {
        const rest = w.sessions.filter(s => s.date >= today && s.status === 'planned');
        if (rest.length) add({
          key: `consistency_${w.start}`,
          type: 'ease',
          title: `Only ${done} of ${past14.length} planned rides done in 2 weeks: lighten the rest of this week`,
          reason: 'Jumping back to full load after missed training raises injury and burnout risk. Reduce ~20% and rebuild consistency.',
          changes: rest.map(s => ({ sessionId: s.id, patch: { durationMin: Math.max(VeloBlockPlanner.FOCUS[s.focus].min, Math.round(s.durationMin * 0.8 / 5) * 5) } }))
        });
      }
    }

    // 6. Fresh and consistent in a load week -> a small push on the next key session.
    const wNow = this.weekOf(today);
    if (ctx && tsb > 12 && nextKey && wNow && wNow.type === 'build' && past14.length >= 3 && past14.filter(s => s.status === 'done').length / past14.length >= 0.8) {
      const lim = F[nextKey.focus];
      const longer = Math.min(lim.max, Math.round(nextKey.durationMin * 1.15 / 5) * 5);
      if (longer > nextKey.durationMin) add({
        key: `push_${nextKey.id}`,
        type: 'push',
        title: `You are fresh (TSB +${tsb.toFixed(1)}) and consistent: extend ${nextKey.title} to ${longer} min`,
        reason: 'Positive form in a load week means the planned stimulus may be too small to keep progressing.',
        changes: [{ sessionId: nextKey.id, patch: { durationMin: longer } }]
      });
    }

    b.suggestions = [...(b.suggestions || []), ...fresh].slice(-40);
    b.lastReview = new Date().toISOString();
    this.save();
    return fresh;
  }

  pendingSuggestions() { return this.block ? (this.block.suggestions || []).filter(s => s.status === 'pending') : []; }

  /** Applies (accept) or dismisses a suggestion. */
  resolveSuggestion(id, accept) {
    const b = this.block;
    if (!b) return false;
    const sg = (b.suggestions || []).find(s => s.id === id);
    if (!sg || sg.status !== 'pending') return false;
    if (accept) {
      sg.changes.forEach(ch => {
        const s = this.findSession(ch.sessionId);
        if (!s) return;
        Object.assign(s, ch.patch);
        s.tss = VeloBlockPlanner.tssFor(s.focus, s.durationMin);
        s.adjusted = true;
      });
      b.weeks.forEach(w => { w.plannedTss = Math.round(w.sessions.reduce((a, s) => a + s.tss, 0)); w.plannedMin = w.sessions.reduce((a, s) => a + s.durationMin, 0); });
    }
    sg.status = accept ? 'accepted' : 'dismissed';
    b.log = [...(b.log || []), { at: new Date().toISOString(), text: `${accept ? 'Accepted' : 'Dismissed'}: ${sg.title}` }].slice(-30);
    this.save();
    return true;
  }

  /** Workout object for a planned session, ready for the cockpit. */
  workoutFor(sessionId) {
    const s = this.findSession(sessionId);
    if (!s) return null;
    if (s.focus === 'test') {
      const lib = (typeof DEFAULT_WORKOUT_LIBRARY !== 'undefined' ? DEFAULT_WORKOUT_LIBRARY : []).find(w => w.id === 'ramp');
      if (lib) return { ...lib, id: 'blk_' + s.id, title: `Block test: ${lib.title}` };
    }
    const focus = s.focus === 'long' ? 'endurance' : s.focus;
    const ctx = this.coach.getPhysiologicalContext(focus, s.durationMin, this.block.goal);
    const { workout } = this.coach.buildWorkout(focus, ctx);
    return { ...workout, id: 'blk_' + s.id + '_' + Date.now(), title: `${s.title} (${s.durationMin}m)`, category: workout.category };
  }
}

if (typeof window !== 'undefined') window.VeloBlockPlanner = VeloBlockPlanner;
