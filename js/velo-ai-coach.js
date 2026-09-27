/**
 * APEX VELO // LAB - AI Cycling Coach.
 *
 * Goal-driven prescriptions (Raise FTP, Longevity / aerobic durability, VO2 max,
 * Balanced) built from the rider's real history: Banister PMC (CTL/ATL/TSB),
 * last 7 days plus a chosen look-back window (7-90 days) of load, volume and
 * intensity mix, recency of hard and long rides, and the power-duration profile.
 *
 * When the app is served by the local server and it has an API key for the chosen
 * provider (Claude or Gemini), the context is sent through the local /api/coach
 * endpoint (keys never reach the browser) and the summarized reasoning is shown.
 * Without the server or a key - or if the call fails - the built-in physiology
 * engine produces an equivalent, fully deterministic plan.
 */
class VeloAiCoach {
  static GOALS = {
    ftp:       { label: 'Raise FTP',  ctlRampPerWeek: 4, summary: 'Progressive threshold and SweetSpot overload on an aerobic base.' },
    longevity: { label: 'Longevity',  ctlRampPerWeek: 3, summary: 'Aerobic base, fat oxidation and fatigue resistance (durability) with mostly Zone 2 volume.' },
    vo2:       { label: 'VO2 max',    ctlRampPerWeek: 3, summary: 'Raise the aerobic ceiling with 30/15s and 3-5 min efforts at 106-120% FTP.' },
    balanced:  { label: 'Balanced',   ctlRampPerWeek: 3, summary: 'Polarised mix: ~80% easy, ~20% hard, touching every energy system.' }
  };

  static DEFAULT_MODEL = 'claude-opus-5-5';
  static DEFAULT_EFFORT = 'low';
  static PROVIDERS = {
    claude: { label: 'Claude', keyName: 'ANTHROPIC_API_KEY', defaultModel: 'claude-opus-5-5' },
    gemini: { label: 'Gemini', keyName: 'GEMINI_API_KEY', defaultModel: 'gemini-3.8-flash' }
  };
  static MODEL_LABELS = {
    'claude-opus-5-5': 'Claude Opus 5.5',
    'claude-sonnet-5': 'Claude Sonnet 5',
    'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
    'gemini-3.8-flash': 'Gemini 3.8 Flash',
    'gemini-3.1-pro-preview': 'Gemini 3.1 Pro (preview)',
    'gemini-3.1-flash-lite': 'Gemini 3.1 Flash-Lite'
  };
  /** Look-back choices (days) for the history sent to the coach, and the cap on individually listed rides. */
  static LOOKBACK_OPTIONS = [7, 14, 28, 42, 90];
  static DEFAULT_LOOKBACK = 28;
  static MAX_LISTED_RIDES = 30;
  static STATUS_URL = 'api/coach/status';
  static COACH_URL = 'api/coach';

  constructor(app) {
    this.app = app;
    // Status of the local AI proxy (start_server.ps1 / server.js); filled by detectEngine().
    this.engine = VeloAiCoach.offlineEngine();
    // Per-browser overrides; empty = use the server's default from .env.
    this.providerOverride = '';
    this.modelOverride = '';
    this.effortOverride = '';
    this.lookbackDays = VeloAiCoach.DEFAULT_LOOKBACK;
    try {
      this.providerOverride = localStorage.getItem('apex_coach_provider') || '';
      this.modelOverride = localStorage.getItem('apex_coach_model') || localStorage.getItem('apex_claude_model') || '';
      this.effortOverride = localStorage.getItem('apex_coach_effort') || localStorage.getItem('apex_claude_effort') || '';
      const lb = parseInt(localStorage.getItem('apex_coach_lookback_days') || '', 10);
      if (VeloAiCoach.LOOKBACK_OPTIONS.includes(lb)) this.lookbackDays = lb;
      // Keys are never kept in the browser: remove anything an old version stored.
      localStorage.removeItem('apex_gemini_api_key');
      localStorage.removeItem('apex_gemini_model');
    } catch (e) { /* storage unavailable */ }
    if (!VeloAiCoach.PROVIDERS[this.providerOverride]) this.providerOverride = '';
    if (!VeloAiCoach.MODEL_LABELS[this.modelOverride]) this.modelOverride = '';
    this.currentRecommendation = null;
  }

  static offlineEngine() {
    const providers = {};
    for (const [id, p] of Object.entries(VeloAiCoach.PROVIDERS)) providers[id] = { label: p.label, configured: false, model: p.defaultModel };
    return { reachable: false, provider: 'claude', providers, model: VeloAiCoach.DEFAULT_MODEL, effort: VeloAiCoach.DEFAULT_EFFORT, models: [], efforts: ['low', 'medium', 'high'] };
  }

  static providerOf(model) { return /^gemini/i.test(model || '') ? 'gemini' : 'claude'; }

  /** Provider, model and effort that will be used for the next request. */
  get provider() {
    if (this.providerOverride) return this.providerOverride;
    if (this.modelOverride) return VeloAiCoach.providerOf(this.modelOverride);
    return VeloAiCoach.PROVIDERS[this.engine.provider] ? this.engine.provider : 'claude';
  }
  get model() {
    const p = this.provider;
    if (this.modelOverride && VeloAiCoach.providerOf(this.modelOverride) === p) return this.modelOverride;
    const ep = this.engine.providers && this.engine.providers[p];
    return (ep && ep.model) || VeloAiCoach.PROVIDERS[p].defaultModel;
  }
  get effort() { return this.effortOverride || this.engine.effort || VeloAiCoach.DEFAULT_EFFORT; }
  get providerLabel() { return VeloAiCoach.PROVIDERS[this.provider].label; }
  /** True when the server is up and has a key for the chosen provider. */
  get isLive() {
    const ep = this.engine.providers && this.engine.providers[this.provider];
    return !!(this.engine.reachable && ep && ep.configured);
  }
  static labelFor(model) { return VeloAiCoach.MODEL_LABELS[model] || model; }
  static supportsEffort(model) { return !/haiku/i.test(model); }
  static modelsFor(provider) { return Object.keys(VeloAiCoach.MODEL_LABELS).filter(m => VeloAiCoach.providerOf(m) === provider); }

  /** Asks the local server which providers have keys. Never throws. */
  async detectEngine(timeoutMs = 3000) {
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
    try {
      const resp = await fetch(VeloAiCoach.STATUS_URL, { cache: 'no-store', signal: ac ? ac.signal : undefined });
      const json = resp.ok ? await resp.json() : null;
      if (json && (json.providers || json.provider === 'claude')) {
        const providers = VeloAiCoach.offlineEngine().providers;
        if (json.providers) {
          for (const id of Object.keys(providers)) {
            const sp = json.providers[id];
            if (sp) providers[id] = { label: sp.label || providers[id].label, configured: !!sp.configured, model: sp.model || providers[id].model };
          }
        } else {
          // Older server (Claude only).
          providers.claude = { ...providers.claude, configured: !!json.configured, model: json.model || providers.claude.model };
        }
        this.engine = {
          reachable: true,
          provider: VeloAiCoach.PROVIDERS[json.provider] ? json.provider : 'claude',
          providers,
          model: json.model || VeloAiCoach.DEFAULT_MODEL,
          effort: json.effort || VeloAiCoach.DEFAULT_EFFORT,
          models: Array.isArray(json.models) ? json.models : [],
          efforts: Array.isArray(json.efforts) ? json.efforts : ['low', 'medium', 'high']
        };
      } else {
        this.engine = { ...VeloAiCoach.offlineEngine(), reachable: false };
      }
    } catch (e) {
      this.engine = { ...VeloAiCoach.offlineEngine(), reachable: false };
    } finally {
      if (timer) clearTimeout(timer);
    }
    return this.engine;
  }

  /** Saves the per-browser engine choice. Empty strings mean "server default". */
  saveConfig({ provider = this.providerOverride, model = this.modelOverride, effort = this.effortOverride } = {}) {
    this.providerOverride = VeloAiCoach.PROVIDERS[provider] ? provider : '';
    this.modelOverride = VeloAiCoach.MODEL_LABELS[model] ? model : '';
    // A model from the other provider makes no sense: drop it.
    if (this.providerOverride && this.modelOverride && VeloAiCoach.providerOf(this.modelOverride) !== this.providerOverride) this.modelOverride = '';
    this.effortOverride = ['low', 'medium', 'high'].includes(effort) ? effort : '';
    try {
      localStorage.setItem('apex_coach_provider', this.providerOverride);
      localStorage.setItem('apex_coach_model', this.modelOverride);
      localStorage.setItem('apex_coach_effort', this.effortOverride);
      localStorage.removeItem('apex_claude_model');
      localStorage.removeItem('apex_claude_effort');
    } catch (e) { /* ignore */ }
  }

  setLookback(days) {
    const d = parseInt(days, 10);
    this.lookbackDays = VeloAiCoach.LOOKBACK_OPTIONS.includes(d) ? d : VeloAiCoach.DEFAULT_LOOKBACK;
    try { localStorage.setItem('apex_coach_lookback_days', String(this.lookbackDays)); } catch (e) { /* ignore */ }
    return this.lookbackDays;
  }

  clearRecommendation() {
    this.currentRecommendation = null;
  }

  // ---------------------------------------------------------------- context --
  getPhysiologicalContext(targetFocus = 'auto', durationMin = 45, goal = 'ftp', notes = '', lookbackDays = this.lookbackDays) {
    const profile = this.app.activeProfile || { name: 'Rider', ftp: 185, weightKg: 75, maxHr: 175 };
    const all = this.app.completedWorkouts || [];
    // Strength sessions add fatigue (per the app's toggle) but are not rides.
    const pmc = this.app.analytics.calculatePmcHistory(all, 0, this.app.pmcOpts ? this.app.pmcOpts() : {});
    const workouts = all.filter(w => VeloMetrics.isCycling(w));
    const ctl = pmc.currentCtl || 0;
    const atl = pmc.currentAtl || 0;
    const tsb = pmc.currentTsb || 0;

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
    const recentWorkouts = workouts
      .filter(w => new Date(w.date) >= sevenDaysAgo)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    const sevenDayTss = Math.round(recentWorkouts.reduce((s, w) => s + (Number(w.tss) || 0), 0));
    const sevenDayHours = recentWorkouts.reduce((s, w) => s + (Number(w.duration) || 0), 0) / 3600;

    // Consecutive riding days leading into today (local calendar days)
    const rideDays = new Set(workouts.map(w => VeloMetrics.localDateKey(w.date)));
    let consecutiveDays = 0;
    for (let d = 1; d <= 14; d++) {
      const k = VeloMetrics.localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - d));
      if (rideDays.has(k)) consecutiveDays++; else break;
    }

    const form = VeloMetrics.formZone(tsb);
    const lookback = VeloAiCoach.LOOKBACK_OPTIONS.includes(Number(lookbackDays)) ? Number(lookbackDays) : VeloAiCoach.DEFAULT_LOOKBACK;
    const history = VeloProgress.coachProfile(workouts, profile.ftp, now, lookback);

    // Rides listed one by one in the prompt: the look-back window, newest first, capped so it stays lean.
    const windowRides = workouts
      .filter(w => now - new Date(w.date) <= lookback * 86400000)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    const listedRides = windowRides.slice(0, VeloAiCoach.MAX_LISTED_RIDES);
    const strength = typeof VeloStravaSync !== 'undefined'
      ? VeloStravaSync.strengthSummary(all, lookback, now)
      : { count: 0, sessions: [], line: '' };
    const yesterday = VeloMetrics.localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
    const today = VeloMetrics.localDateKey(now);
    const heavyLegsRecent = strength.sessions.some(s => s.heavyLegs && (s.date === yesterday || s.date === today));
    const recentList = listedRides.map(w => {
      return `- ${VeloMetrics.localDateKey(w.date)}: "${w.title}" (${Math.round((w.duration || 0) / 60)} min, TSS ${w.tss || 0}, NP ${w.np || 0}W, IF ${w.if || 0})`;
    }).join('\n') || `- No rides logged in the past ${lookback} days.`;

    // Post-ride insight (interval diagnosis, drift, PR medals, FTP) from rides with recorded power.
    let insight = { lines: [] };
    try { if (this.app.coachInsight) insight = this.app.coachInsight(lookback, now); } catch (e) { /* insight is optional */ }

    // Daily readiness from Apple Health (resting HR, HRV, sleep) - advisory, only when there is a verdict.
    let readiness = null;
    try {
      const r = this.app.healthReadiness ? this.app.healthReadiness() : null;
      if (r && ['green', 'amber', 'red'].includes(r.level)) readiness = r;
    } catch (e) { /* optional */ }

    return {
      profile, ctl, atl, tsb, insight, readiness,
      formZone: form.label, formKey: form.key, formDesc: form.desc,
      sevenDayTss, sevenDayHours, recentWorkouts, recentList, consecutiveDays,
      lookbackDays: lookback, windowRideCount: windowRides.length, listedRideCount: listedRides.length,
      history, strength, heavyLegsRecent,
      goal: VeloAiCoach.GOALS[goal] ? goal : 'ftp',
      notes: String(notes || '').slice(0, 280),
      targetFocus,
      autoDuration: String(durationMin).toLowerCase() === 'auto',
      durationMin: parseInt(durationMin, 10) || 60
    };
  }

  // ----------------------------------------------------------- focus logic --
  decideFocus(ctx) {
    if (ctx.targetFocus && ctx.targetFocus !== 'auto') return ctx.targetFocus;
    const h = ctx.history || {};
    // A heavy leg strength day yesterday (or today) counts like a hard ride: no key session now.
    const hardRecently = (h.daysSinceHard !== null && h.daysSinceHard !== undefined && h.daysSinceHard <= 1) || !!ctx.heavyLegsRecent;
    if (ctx.tsb < -25 || (ctx.consecutiveDays >= 3 && ctx.tsb < -10)) return 'recovery';
    // Poor recovery (Apple Health): red = recovery spin, amber = no key session today.
    if (ctx.readiness && ctx.readiness.level === 'red') return 'recovery';
    if (ctx.readiness && ctx.readiness.level === 'amber') return 'endurance';
    if (ctx.tsb < -12 || hardRecently) return 'endurance';
    switch (ctx.goal) {
      case 'longevity':
        return (h.daysSinceHard === null || h.daysSinceHard >= 5) && ctx.tsb > -5 ? 'sweetspot' : 'endurance';
      case 'vo2':
        return ctx.tsb > -8 ? 'vo2max' : 'endurance';
      case 'balanced':
        return (h.lowIntensityPct !== null && h.lowIntensityPct < 70) ? 'endurance' : (ctx.tsb > 5 ? 'vo2max' : 'threshold');
      case 'ftp':
      default:
        if (ctx.tsb > 5) return 'threshold';
        return (h.highIntensityPct !== null && h.highIntensityPct < 15) ? 'threshold' : 'sweetspot';
    }
  }

  // --------------------------------------------------------- workout maths --
  /** IF and TSS computed from the prescribed intervals (not guessed multipliers). */
  /**
   * Most effective session length for a focus, from form, fitness (CTL), goal and the rider's usual ride length.
   * Quality sessions are capped by what the rider can execute well; easy rides grow with training age.
   */
  optimalDuration(focus, ctx) {
    const h = ctx.history || {};
    const ctl = ctx.ctl || 0;
    const tired = ctx.tsb < -15;
    const fresh = ctx.tsb > 5;
    const r5 = (m) => Math.round(m / 5) * 5;
    const usual = h.ridesWin ? (h.hoursPerWeekWin * 60 * (ctx.lookbackDays / 7)) / h.ridesWin : 60;
    let min;
    switch (focus) {
      case 'recovery': min = tired ? 30 : 40; break;
      case 'endurance':
        // Aerobic durability: a bit longer than usual, longer still for the longevity goal.
        min = Math.max(60, usual * 1.15) + (ctx.goal === 'longevity' ? 20 : 0);
        if (tired) min = Math.min(min, 60);
        min = Math.min(min, 150);
        break;
      case 'sweetspot': min = ctl >= 40 ? 90 : ctl >= 25 ? 75 : 60; break;
      case 'threshold': min = ctl >= 40 ? 75 : 60; break;
      case 'vo2max': min = ctl >= 30 && fresh ? 60 : 50; break;
      default: min = 60;
    }
    if (tired && focus !== 'recovery') min -= 10;
    return Math.max(30, Math.min(150, r5(min)));
  }

  static estimateLoad(intervals) {
    const totalSec = intervals.reduce((a, iv) => a + (iv.duration || 0), 0) || 1;
    const p4 = intervals.reduce((a, iv) => a + Math.pow((iv.pctFtp || 0) / 100, 4) * (iv.duration || 0), 0) / totalSec;
    const ifac = Math.pow(p4, 0.25);
    return { durationMin: Math.round(totalSec / 60), if: ifac.toFixed(2), tss: Math.round((totalSec / 3600) * ifac * ifac * 100) };
  }

  static fill(mainSec, blockSec, restSec, maxReps = 12) {
    return Math.max(1, Math.min(maxReps, Math.floor((mainSec + restSec) / (blockSec + restSec))));
  }

  buildWorkout(focus, ctx) {
    const ftp = ctx.profile.ftp || 185;
    const dur = Math.max(30, ctx.durationMin);
    const wuSec = dur >= 60 ? 600 : 480;
    const cdSec = 300;
    const main = dur * 60 - wuSec - cdSec;
    const ctlLevel = ctx.ctl;
    const iv = [];
    const W = (pct) => Math.round(ftp * pct / 100);
    let title = '', desc = '', notes = '';

    const warmup = (openers) => {
      iv.push({ name: 'Warmup', duration: wuSec - (openers ? 180 : 0), pctFtp: 55, cadence: 88 });
      if (openers) {
        iv.push({ name: 'Opener', duration: 60, pctFtp: 95, cadence: 95 });
        iv.push({ name: 'Opener Recovery', duration: 120, pctFtp: 50, cadence: 85 });
      }
    };
    const cooldown = () => iv.push({ name: 'Cooldown', duration: cdSec, pctFtp: 45, cadence: 85 });

    if (focus === 'recovery') {
      warmup(false);
      iv.push({ name: 'Recovery Spin (high cadence)', duration: main, pctFtp: 50, cadence: 95 });
      cooldown();
      title = `Active Recovery Flush (${dur}m)`;
      desc = 'Low-stress circulation ride to clear fatigue without adding training load.';
      notes = `Stay under ${W(55)}W. Light, fast pedalling (90-100 rpm). If legs still feel heavy, stop early - recovery is the goal.`;
    } else if (focus === 'endurance') {
      warmup(false);
      const cadenceDrills = main >= 1800;
      if (cadenceDrills) {
        const chunk = Math.floor(main / 3);
        iv.push({ name: 'Zone 2 Aerobic', duration: chunk, pctFtp: 68, cadence: 88 });
        iv.push({ name: 'Zone 2 Low-Cadence Torque', duration: chunk, pctFtp: 70, cadence: 72 });
        const finish = ctx.goal === 'longevity' && ctx.tsb > -5 && main >= 2700;
        iv.push({ name: finish ? 'Durability Tempo Finish' : 'Zone 2 Aerobic', duration: main - 2 * chunk, pctFtp: finish ? 80 : 68, cadence: 90 });
      } else {
        iv.push({ name: 'Zone 2 Aerobic', duration: main, pctFtp: 68, cadence: 88 });
      }
      cooldown();
      title = `Zone 2 Durability Builder (${dur}m)`;
      desc = 'Steady aerobic work (65-72% FTP) that builds mitochondrial density, fat oxidation and fatigue resistance.';
      notes = `Hold ${W(65)}-${W(72)}W with conversational breathing. The low-cadence block (~72 rpm) adds muscular endurance without raising intensity.`;
    } else if (focus === 'sweetspot') {
      warmup(true);
      let block = ctlLevel >= 45 ? 1200 : ctlLevel >= 30 ? 900 : ctlLevel >= 18 ? 600 : 480;
      const rest = block >= 900 ? 300 : 180;
      const avail = main;
      const reps = VeloAiCoach.fill(avail, block, rest, 4);
      // Stretch the blocks (up to +50%) so the main set fills the available time.
      block = Math.min(Math.round(block * 1.5), Math.floor((avail - (reps - 1) * rest) / reps / 30) * 30);
      for (let r = 1; r <= reps; r++) {
        iv.push({ name: `SweetSpot ${r}`, duration: block, pctFtp: 88 + Math.min(4, r - 1) * 1, cadence: 92 });
        if (r < reps) iv.push({ name: `Recovery ${r}`, duration: rest, pctFtp: 50, cadence: 85 });
      }
      const used = reps * block + (reps - 1) * rest;
      if (avail - used >= 120) iv.push({ name: 'Endurance Top-up', duration: avail - used, pctFtp: 65, cadence: 90 });
      cooldown();
      title = `Progressive SweetSpot ${reps}x${Math.round(block / 60)} (${dur}m)`;
      desc = 'Sub-threshold time-in-zone (88-92% FTP): the most time-efficient stimulus for lifting FTP and muscular endurance. Block length is scaled to your current CTL.';
      notes = `Target ${W(88)}-${W(92)}W, rising 1% per block. Seated, 90-95 rpm, steady breathing - it should feel "comfortably hard".`;
    } else if (focus === 'threshold') {
      warmup(true);
      const rest = 240;
      const avail = main;
      const reps = VeloAiCoach.fill(avail, 540, rest, 4);
      // 3-5 under/over cycles (2 min @95% + 1 min @106%) per set, sized to the time available.
      const cycles = Math.max(3, Math.min(5, Math.floor((avail - (reps - 1) * rest) / reps / 180)));
      const set = cycles * 180;
      for (let r = 1; r <= reps; r++) {
        for (let c = 1; c <= cycles; c++) {
          iv.push({ name: `Set ${r} Under ${c}`, duration: 120, pctFtp: 95, cadence: 92 });
          iv.push({ name: `Set ${r} Over ${c}`, duration: 60, pctFtp: 106, cadence: 98 });
        }
        if (r < reps) iv.push({ name: `Recovery ${r}`, duration: rest, pctFtp: 50, cadence: 85 });
      }
      const used = reps * set + (reps - 1) * rest;
      if (avail - used >= 120) iv.push({ name: 'Endurance Top-up', duration: avail - used, pctFtp: 65, cadence: 90 });
      cooldown();
      title = `Threshold Over-Unders ${reps}x${cycles * 3} (${dur}m)`;
      desc = 'Alternating 95% and 106% FTP teaches the body to clear lactate while working at threshold - direct FTP stimulus.';
      notes = `Unders at ${W(95)}W, overs at ${W(106)}W. Don't surge the overs - smooth the transition and keep cadence up.`;
    } else {
      // VO2 max
      warmup(true);
      const avail = main;
      if (dur >= 60 && ctlLevel >= 25) {
        const block = 240, rest = 240;
        const reps = VeloAiCoach.fill(avail, block, rest, 6);
        for (let r = 1; r <= reps; r++) {
          iv.push({ name: `VO2 Effort ${r}`, duration: block, pctFtp: 112, cadence: 100 });
          if (r < reps) iv.push({ name: `Recovery ${r}`, duration: rest, pctFtp: 50, cadence: 85 });
        }
        const used = reps * block + (reps - 1) * rest;
        if (avail - used >= 120) iv.push({ name: 'Endurance Top-up', duration: avail - used, pctFtp: 62, cadence: 90 });
        title = `VO2 Max ${reps}x4 min (${dur}m)`;
        desc = 'Classic 4-minute efforts at ~112% FTP to raise maximal aerobic power.';
      } else {
        const setSec = 13 * 45 - 15, setRest = 300;
        const sets = VeloAiCoach.fill(avail, setSec, setRest, 3);
        for (let s = 1; s <= sets; s++) {
          for (let r = 1; r <= 13; r++) {
            iv.push({ name: `Set ${s} On ${r}`, duration: 30, pctFtp: 120, cadence: 105 });
            if (r < 13) iv.push({ name: `Set ${s} Off ${r}`, duration: 15, pctFtp: 50, cadence: 90 });
          }
          if (s < sets) iv.push({ name: `Set Recovery ${s}`, duration: setRest, pctFtp: 50, cadence: 85 });
        }
        const used = sets * setSec + (sets - 1) * setRest;
        if (avail - used >= 120) iv.push({ name: 'Endurance Top-up', duration: avail - used, pctFtp: 62, cadence: 90 });
        title = `Ronnestad 30/15 x ${sets} (${dur}m)`;
        desc = '30 s on / 15 s off keeps VO2 elevated for long periods with less lactate than continuous efforts (Ronnestad et al.).';
      }
      cooldown();
      notes = `Hit ${W(112)}-${W(120)}W on the efforts at 100-105 rpm. Recover fully on the floats. Quality over quantity - stop a set if power fades >5%.`;
    }

    const load = VeloAiCoach.estimateLoad(iv);
    const category = focus === 'vo2max' ? 'vo2' : (focus === 'recovery' ? 'endurance' : focus);
    return {
      workout: { id: `ai_coach_${focus}_${Date.now()}`, title: `AI Coach: ${title}`, category, desc, durationMin: load.durationMin, tss: load.tss, if: load.if, intervals: iv },
      notes
    };
  }

  /** 7-day outlook sized to a CTL ramp appropriate for the goal and current form. */
  buildWeekPlan(ctx, todayFocus, todayWorkout) {
    const goal = VeloAiCoach.GOALS[ctx.goal] || VeloAiCoach.GOALS.ftp;
    let ramp = goal.ctlRampPerWeek;
    if (ctx.formKey === 'fatigue' || ctx.formKey === 'overtraining') ramp = 0;
    else if (ctx.formKey === 'optimal') ramp = Math.min(ramp, 2);
    // Daily TSS that lifts CTL by `ramp` per week: dCTL/day ~= (TSS - CTL) / 42  ->  TSS = CTL + 6 * ramp
    const dailyTarget = Math.max(20, ctx.ctl + 6 * ramp);
    const weekTarget = Math.round(dailyTarget * 7);

    const templates = {
      ftp:       ['endurance', 'threshold', 'recovery', 'sweetspot', 'off', 'endurance-long'],
      longevity: ['endurance', 'endurance', 'recovery', 'sweetspot', 'off', 'endurance-long'],
      vo2:       ['endurance', 'vo2max', 'recovery', 'threshold', 'off', 'endurance-long'],
      balanced:  ['endurance', 'vo2max', 'recovery', 'endurance', 'off', 'sweetspot']
    };
    const weights = { recovery: 0.35, endurance: 0.75, 'endurance-long': 1.5, sweetspot: 1.0, threshold: 1.05, vo2max: 0.95, off: 0 };
    const seq = [todayFocus, ...(templates[ctx.goal] || templates.ftp)];
    // Never stack the same hard stimulus within 48 h of today's session.
    const hard = ['threshold', 'vo2max', 'sweetspot'];
    for (let i = 1; i <= 2; i++) if (hard.includes(todayFocus) && hard.includes(seq[i])) seq[i] = 'endurance';
    if (ctx.formKey === 'fatigue' || ctx.formKey === 'overtraining') { seq[1] = 'recovery'; seq[2] = 'off'; }
    const remaining = Math.max(0, weekTarget - (todayWorkout.tss || 0));
    const restWeight = seq.slice(1).reduce((a, f) => a + (weights[f] || 0), 0) || 1;
    const labels = { recovery: 'Recovery spin', endurance: 'Zone 2 endurance', 'endurance-long': 'Long Zone 2 ride', sweetspot: 'SweetSpot', threshold: 'Threshold over-unders', vo2max: 'VO2 max', off: 'Rest day' };
    const ifFor = { recovery: 0.5, endurance: 0.68, 'endurance-long': 0.68, sweetspot: 0.86, threshold: 0.9, vo2max: 0.88, off: 0 };

    const now = new Date();
    return {
      weekTargetTss: weekTarget,
      ramp,
      days: seq.map((f, i) => {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
        const tss = i === 0 ? todayWorkout.tss : Math.round(remaining * (weights[f] || 0) / restWeight);
        const ifac = ifFor[f] || 0;
        const minutes = f === 'off' || !ifac ? 0 : Math.round((tss / (ifac * ifac * 100)) * 60 / 5) * 5;
        return {
          date: VeloMetrics.localDateKey(d),
          dayLabel: i === 0 ? 'Today' : d.toLocaleDateString('en-US', { weekday: 'short' }),
          focus: f,
          title: i === 0 ? todayWorkout.title.replace(/^AI Coach: /, '') : labels[f],
          durationMin: i === 0 ? todayWorkout.durationMin : minutes,
          tss
        };
      })
    };
  }

  /** One or two sentences for the offline engine's advice, from the recent-ride insight. */
  insightAdvice(ctx, focus) {
    const ins = ctx.insight || {};
    const out = [];
    const faded = ins.lastHard && ins.lastHard.diag.some(l => /faded|under target|drift/.test(l));
    if (faded && ['vo2max', 'threshold', 'sweetspot'].includes(focus)) out.push(`Your last hard session (${ins.lastHard.date}) faded late - start today's intervals at the low end of the targets and fuel early.`);
    const d = ins.drift || [];
    if (d.length >= 2) {
      const avg = d.reduce((a, x) => a + x.pct, 0) / d.length;
      if (avg > 8) out.push(`Pw:HR drift on your steady rides averages ${avg.toFixed(1)}% - more steady Zone 2 volume will help your aerobic base.`);
      else if (avg < 5) out.push(`Pw:HR drift averages ${avg.toFixed(1)}% - your aerobic base is solid.`);
    }
    if (ins.ftp) out.push(`Your recent rides suggest an FTP of about ${ins.ftp.ftp} W - update it in the ride review to scale the targets.`);
    return out.join(' ');
  }

  generateOfflineHeuristic(ctx) {
    const focus = this.decideFocus(ctx);
    if (ctx.autoDuration) ctx.durationMin = this.optimalDuration(focus, ctx);
    const { workout, notes } = this.buildWorkout(focus, ctx);
    const h = ctx.history || {};
    const goal = VeloAiCoach.GOALS[ctx.goal] || VeloAiCoach.GOALS.ftp;
    const weekPlan = this.buildWeekPlan(ctx, focus, workout);

    const win = h.windowDays || 28;
    const mixText = h.lowIntensityPct !== null && h.lowIntensityPct !== undefined
      ? `Last ${win} days: ${h.lowIntensityPct}% easy / ${h.midIntensityPct}% SweetSpot-tempo / ${h.highIntensityPct}% threshold+ (by ride IF).`
      : `Not enough rides with recorded power in the last ${win} days to judge the intensity mix.`;
    const why = {
      recovery: 'Form and recent load say absorb, not add.',
      endurance: h.daysSinceHard !== null && h.daysSinceHard <= 1 ? 'You went hard in the last 48 h, so today builds aerobic volume instead.' : 'Aerobic volume is the foundation for both FTP and longevity.',
      sweetspot: 'You are fresh enough for productive sub-threshold overload.',
      threshold: 'Your form supports direct threshold work, the fastest route to FTP gains.',
      vo2max: 'Freshness allows a high-quality VO2 session.'
    }[focus] || '';

    return {
      source: 'offline_heuristic',
      goal: ctx.goal,
      lookbackDays: ctx.lookbackDays,
      focus,
      coachAssessment: {
        formZone: ctx.formZone,
        fitnessDiagnosis: `CTL ${ctx.ctl.toFixed(1)} / ATL ${ctx.atl.toFixed(1)} / TSB ${ctx.tsb >= 0 ? '+' : ''}${ctx.tsb.toFixed(1)} (${ctx.formZone}). ${ctx.formDesc} ${h.hoursPerWeek4w !== undefined ? `You have averaged ${h.hoursPerWeek4w} h/week over the last 4 weeks.` : ''}`,
        fatigueStatus: `${ctx.readiness ? `Readiness ${ctx.readiness.label.toLowerCase()} (${ctx.readiness.level})${ctx.readiness.reasons.length ? ': ' + ctx.readiness.reasons.join('; ') : ''}. ` : ''}${ctx.sevenDayTss} TSS in 7 days (${ctx.sevenDayHours.toFixed(1)} h). ${ctx.consecutiveDays >= 2 ? `${ctx.consecutiveDays} riding days in a row.` : ''} ${h.daysSinceHard !== null && h.daysSinceHard !== undefined ? `Last hard ride (IF >= 0.85) ${h.daysSinceHard} day(s) ago.` : ''} ${mixText}`.replace(/\s+/g, ' ').trim(),
        trainingAdvice: `Goal: ${goal.label} - ${goal.summary} ${why} ${this.insightAdvice(ctx, focus)} ${ctx.autoDuration ? `Auto duration: ${ctx.durationMin} min - ${{ recovery: 'short enough to aid recovery', endurance: 'a little longer than your usual ride to build durability', vo2max: 'enough work at VO2 without sacrificing quality', threshold: 'enough time at threshold for your current fitness', sweetspot: 'the time-in-zone your fitness can absorb' }[focus] || 'matched to your form'}.` : ''} ${notes}`.replace(/\s+/g, ' ').trim()
      },
      workout,
      weekPlan
    };
  }

  // ------------------------------------------------------------ Claude / Gemini --
  buildPrompt(ctx) {
    const h = ctx.history || {};
    const goal = VeloAiCoach.GOALS[ctx.goal] || VeloAiCoach.GOALS.ftp;
    return `You are an elite cycling coach and exercise physiologist. Prescribe today's indoor ERG session and a 7-day outlook for rider "${ctx.profile.name}".

RIDER: FTP ${ctx.profile.ftp} W, weight ${ctx.profile.weightKg} kg, max HR ${ctx.profile.maxHr} bpm.
PRIMARY GOAL: ${goal.label} - ${goal.summary}
TODAY'S FOCUS REQUEST: ${ctx.targetFocus} (auto = decide). ${ctx.autoDuration ? 'Duration: YOU choose the most effective length (30-150 min) for this session given its focus, the goal, current form/fatigue and the rider\'s usual ride length - long enough for a real stimulus, short enough to execute with quality; explain the choice in trainingAdvice.' : `Time available: ${ctx.durationMin} minutes.`}
${ctx.notes ? `RIDER NOTES: ${ctx.notes}\n` : ''}
PERFORMANCE MANAGEMENT (Banister model):
- CTL (fitness) ${ctx.ctl.toFixed(1)}, ATL (fatigue) ${ctx.atl.toFixed(1)}, TSB (form) ${ctx.tsb.toFixed(1)} -> ${ctx.formZone}
- Last 7 days: ${ctx.sevenDayTss} TSS, ${ctx.sevenDayHours.toFixed(1)} h, ${ctx.recentWorkouts.length} rides; consecutive riding days: ${ctx.consecutiveDays}
- Last ${ctx.lookbackDays} days (look-back window): ${h.ridesWin} rides, ${h.tssWin} TSS, ${h.hoursPerWeekWin} h/week, longest ride ${h.longestRideMinWin} min
- Intensity mix (${ctx.lookbackDays} d, by ride IF): easy ${h.lowIntensityPct ?? 'n/a'}%, tempo/SweetSpot ${h.midIntensityPct ?? 'n/a'}%, threshold+ ${h.highIntensityPct ?? 'n/a'}%
- Days since last hard ride (IF>=0.85): ${h.daysSinceHard ?? 'none on record'}; days since last ride >= 90 min: ${h.daysSinceLong ?? 'none on record'}
- Power profile: ${h.profileType || 'n/a'}
- Strength training: ${ctx.strength && ctx.strength.line ? ctx.strength.line : 'none recorded'}
${ctx.readiness ? `DAILY READINESS (Apple Watch, vs the rider's own baselines): ${ctx.readiness.level.toUpperCase()} - ${ctx.readiness.label}.${ctx.readiness.hrv ? ` HRV 7-day ${ctx.readiness.hrv.avg7} ms (normal ${ctx.readiness.hrv.normalLow}-${ctx.readiness.hrv.normalHigh}).` : ''}${ctx.readiness.rhr ? ` Resting HR ${ctx.readiness.rhr.today} bpm (baseline ${ctx.readiness.rhr.base}).` : ''}${ctx.readiness.sleep ? ` Sleep ${ctx.readiness.sleep.last} h.` : ''}${ctx.readiness.reasons.length ? ' Flags: ' + ctx.readiness.reasons.join('; ') + '.' : ''} Amber = no key session today (endurance or shortened sets); red = Z1-Z2 recovery spin. Say so in fatigueStatus.
` : ''}${ctx.insight && ctx.insight.lines.length ? `RECENT RIDE INSIGHT (computed from recorded power and heart rate - use it, e.g. ease or re-pace a session type that faded, keep aerobic work steady while drift is high, build on new bests):
${ctx.insight.lines.map(l => `- ${l}`).join('\n')}
` : ''}RIDES IN THE LAST ${ctx.lookbackDays} DAYS (newest first${ctx.windowRideCount > ctx.listedRideCount ? `, ${ctx.listedRideCount} most recent of ${ctx.windowRideCount}` : ''}):
${ctx.recentList}

RULES: scale all targets as % of FTP; include warmup and cooldown; interval durations in seconds; every interval needs a cadence target (rpm); ${ctx.autoDuration ? 'total duration 30-150 min as you judge optimal' : `total duration must be within 3 minutes of ${ctx.durationMin} min`}; respect fatigue (TSB < -25 -> recovery). The weekPlan must contain 7 days starting today; use focus "off" for rest days.

Return ONLY JSON matching:
{
  "coachAssessment": { "formZone": "Fresh" | "Productive" | "Optimal" | "High Fatigue" | "Overtraining", "fitnessDiagnosis": "...", "fatigueStatus": "...", "trainingAdvice": "..." },
  "workout": { "title": "...", "category": "sweetspot" | "vo2" | "threshold" | "endurance", "desc": "...", "intervals": [ { "name": "Warmup", "duration": 600, "pctFtp": 55, "cadence": 88 } ] },
  "weekPlan": { "days": [ { "dayLabel": "Today", "focus": "sweetspot", "title": "...", "durationMin": 45, "tss": 50 } ] }
}`;
  }

  async generateRecommendation(targetFocus = 'auto', durationMin = 45, goal = 'ftp', notes = '') {
    const ctx = this.getPhysiologicalContext(targetFocus, durationMin, goal, notes);
    const t0 = performance.now();
    const finish = (rec) => {
      rec.elapsedMs = Math.round(performance.now() - t0);
      rec.generatedAt = new Date().toISOString();
      this.currentRecommendation = rec;
      return rec;
    };

    // The server may have been started (or the key added) after the page loaded.
    if (!this.isLive) await this.detectEngine();
    if (!this.isLive) return finish(this.generateOfflineHeuristic(ctx));

    const provider = this.provider;
    const model = this.model;
    const effort = VeloAiCoach.supportsEffort(model) ? this.effort : null;
    const label = VeloAiCoach.labelFor(model);
    try {
      const resp = await fetch(VeloAiCoach.COACH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: this.buildPrompt(ctx), provider, model, effort })
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        console.warn(`${this.providerLabel} coach call failed:`, resp.status, json.error);
        const fb = this.generateOfflineHeuristic(ctx);
        fb.apiError = `${json.error || `${label} error (${resp.status})`} Used the built-in physiology engine instead.`;
        return finish(fb);
      }
      if (json.stopReason === 'max_tokens') throw new Error('the answer was cut off (max tokens)');
      const thoughtText = json.thinking || '';
      const rawText = json.text || '';
      if (!rawText) throw new Error(`empty response from ${label}`);

      let parsed;
      try {
        parsed = JSON.parse(rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim());
      } catch (pe) {
        const m = rawText.match(/\{[\s\S]*\}/);
        if (!m) throw pe;
        parsed = JSON.parse(m[0]);
      }
      const ivs = parsed.workout && Array.isArray(parsed.workout.intervals) ? parsed.workout.intervals : [];
      const clean = ivs
        .map(iv => ({ name: String(iv.name || 'Step').slice(0, 60), duration: Math.max(5, Math.round(Number(iv.duration) || 0)), pctFtp: Math.max(30, Math.min(250, Math.round(Number(iv.pctFtp) || 0))), cadence: Math.max(50, Math.min(130, Math.round(Number(iv.cadence) || 0))) || undefined }))
        .filter(iv => iv.duration > 0 && iv.pctFtp > 0);
      if (clean.length < 3) throw new Error('the response did not contain a valid interval list');

      const load = VeloAiCoach.estimateLoad(clean);
      parsed.workout = {
        id: 'ai_rec_' + Date.now(),
        title: String(parsed.workout.title || 'AI Coach Session'),
        category: parsed.workout.category || 'custom',
        desc: String(parsed.workout.desc || ''),
        durationMin: load.durationMin,
        tss: load.tss,
        if: load.if,
        intervals: clean
      };
      if (!parsed.weekPlan || !Array.isArray(parsed.weekPlan.days) || !parsed.weekPlan.days.length) {
        parsed.weekPlan = this.buildWeekPlan(ctx, this.decideFocus(ctx), parsed.workout);
      }
      parsed.coachAssessment = parsed.coachAssessment || {};
      parsed.coachAssessment.formZone = parsed.coachAssessment.formZone || ctx.formZone;
      parsed.source = json.provider || provider;
      parsed.model = json.model || model;
      parsed.modelLabel = label;
      parsed.goal = ctx.goal;
      parsed.lookbackDays = ctx.lookbackDays;
      parsed.thinkingLevel = effort ? `${effort} effort` : 'thinking';
      parsed.usage = json.usage || null;
      if (thoughtText.trim()) parsed.coachThoughts = thoughtText.trim();
      return finish(parsed);
    } catch (err) {
      console.warn('VeloAiCoach: falling back to the offline engine:', err);
      const fb = this.generateOfflineHeuristic(ctx);
      fb.apiError = `${label} unavailable (${err.message}). Used the built-in physiology engine instead.`;
      return finish(fb);
    }
  }
}

if (typeof window !== 'undefined') window.VeloAiCoach = VeloAiCoach;
