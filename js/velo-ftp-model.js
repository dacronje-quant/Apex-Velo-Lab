/**
 * APEX VELO // LAB - FTP estimates calculated in the app (pure, no DOM).
 *
 * The same five histories the research export carries (js/velo-ftp-history.js), rebuilt from the rides
 * on this device so they follow every new workout. Transparent stand-ins for the private research
 * models, not copies of them: the numbers will differ, and the card says which source it shows.
 *
 *   A       Power Curve             - critical power of the 90-day power-duration curve (0.95 x best
 *                                     20 min while the curve cannot be modelled), every week.
 *   Aplus   Bayesian Power Curve    - A through a Kalman filter: the estimate drifts at most ~0.5% a week
 *                                     unless the curve proves otherwise, with a 90% range.
 *   B       Power + Heart Rate      - per workout: power against heart rate over steady minutes, read at
 *                                     the threshold heart rate (the workout-implied FTP dot); the line is
 *                                     those readings through a Kalman filter, with its 90% range (band).
 *   Cfloor  Workout Capacity Floor  - what one ride proves: the most of 60 min, 0.97 x 45 min and
 *                                     0.93 x 20 min power (shown when it is at least 90% of FTP in use).
 *   C       Workout Capacity Model  - the strongest recent floor, aged 0.3% a day after two weeks; with
 *                                     no floor in six weeks it leans half-way back to the FTP in use.
 *
 * Every value is a conditional estimate of an uncalibrated model, never a training setting.
 */
(function (root) {
  'use strict';

  const DAY = 86400000, WEEK = 7 * DAY;
  const Z90 = 1.645;
  const P = () => (typeof VeloPower !== 'undefined' ? VeloPower : root && root.VeloPower) || (typeof require === 'function' ? require('./velo-power.js') : null);
  const r1 = (v) => Math.round(v * 10) / 10;
  const fin = (v) => typeof v === 'number' && Number.isFinite(v);

  /** Threshold heart rate: the profile's LTHR, else 90% of max HR (the usual field estimate). */
  function thresholdHr(profile) {
    const lthr = Number(profile && profile.lthr), max = Number(profile && profile.maxHr);
    if (lthr >= 100 && lthr <= 220) return { hr: lthr, assumed: false };
    if (max >= 120 && max <= 230) return { hr: Math.round(max * 0.9), assumed: true };
    return null;
  }

  /**
   * One workout's power-heart-rate line read at the threshold heart rate.
   * prep is VeloPower.prepare(samples). Minutes after the first five, with power steady inside the minute
   * (CV under 15%), above 40% of FTP and heart rate present; heart rate taken 30 s later (it lags power).
   * Eligible with 12+ such minutes, heart rate spread over 12+ bpm, a rising line with R^2 >= 0.4, and the
   * hardest minute within 20 bpm of threshold (no long extrapolation). Returns
   * { ok, implied, se, n, r2, slope, hrMax, reason }.
   */
  function hrPowerEstimate(prep, thrHr, ftp) {
    if (!prep || !prep.n || !thrHr) return { ok: false, reason: 'no samples' };
    return hrPowerFromBlocks(hrPowerBlocks(prep), thrHr, ftp);
  }

  /**
   * The rider-independent part of hrPowerEstimate: per steady minute (after 5 min, heart rate 30 s later,
   * 80% of it with heart rate, power varying under 15%) the mean power and heart rate. Kept per ride.
   */
  function hrPowerBlocks(prep) {
    if (!prep || !prep.n) return { n: 0, blocks: [] };
    const { power, hr, n } = prep;
    const LAG = 30, BLOCK = 60, SKIP = 300;
    const blocks = [];
    for (let a = SKIP; a + BLOCK + LAG <= n; a += BLOCK) {
      let sp = 0, sp2 = 0, sh = 0, nh = 0;
      for (let i = a; i < a + BLOCK; i++) { sp += power[i]; sp2 += power[i] * power[i]; }
      for (let i = a + LAG; i < a + BLOCK + LAG; i++) if (hr[i] > 40) { sh += hr[i]; nh++; }
      const mp = sp / BLOCK, sd = Math.sqrt(Math.max(0, sp2 / BLOCK - mp * mp));
      if (nh < BLOCK * 0.8 || sd / mp > 0.15) continue;
      blocks.push([mp, sh / nh]);
    }
    return { n, blocks };
  }

  /** hrPowerEstimate from hrPowerBlocks: minutes under 40% FTP are left out, then power is fitted to heart rate. */
  function hrPowerFromBlocks(b, thrHr, ftp) {
    const fail = (reason) => ({ ok: false, reason });
    if (!b || !b.n || !thrHr) return fail('no samples');
    const xs = [], ys = [];
    for (const [mp, h] of b.blocks) {
      if (mp < 0.4 * ftp) continue;
      xs.push(h); ys.push(mp);
    }
    const m = xs.length;
    if (m < 12) return fail(`${m} steady minutes with heart rate (12 needed)`);
    const hrMin = Math.min(...xs), hrMax = Math.max(...xs);
    if (hrMax - hrMin < 12) return fail('heart rate barely changed (needs 12+ bpm spread)');
    if (hrMax < thrHr - 20) return fail('stayed more than 20 bpm under threshold heart rate');
    const mx = xs.reduce((s, v) => s + v, 0) / m, my = ys.reduce((s, v) => s + v, 0) / m;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < m; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
    const slope = sxy / sxx, icpt = my - slope * mx;
    const r2 = syy ? (sxy * sxy) / (sxx * syy) : 0;
    if (!(slope > 0)) return fail('power did not rise with heart rate');
    if (r2 < 0.4) return fail(`loose power-heart-rate relation (R² ${r2.toFixed(2)})`);
    const implied = icpt + slope * thrHr;
    if (!(implied > 0.5 * ftp && implied < 1.5 * ftp)) return fail('reading far from the FTP in use');
    let sse = 0;
    for (let i = 0; i < m; i++) sse += (ys[i] - (icpt + slope * xs[i])) ** 2;
    const s = Math.sqrt(sse / Math.max(1, m - 2));
    const se = s * Math.sqrt(1 / m + (thrHr - mx) ** 2 / sxx);
    return { ok: true, implied: r1(implied), se: r1(se), n: m, r2: Math.round(r2 * 100) / 100, slope: Math.round(slope * 100) / 100, hrMax: Math.round(hrMax) };
  }

  /**
   * Random-walk Kalman filter. obs: [{ t, v, sd }] oldest first; prior { v, sd }; drift = SD growth per
   * week as a share of the estimate. Returns [{ t, v, sd }] after each observation.
   */
  function kalman(obs, prior, driftPerWeek = 0.005) {
    let x = prior.v, p = prior.sd ** 2, last = obs.length ? obs[0].t : 0;
    const out = [];
    for (const o of obs) {
      const weeks = Math.max(0, (o.t - last) / WEEK);
      p += (x * driftPerWeek) ** 2 * weeks;
      const r = o.sd ** 2, k = p / (p + r);
      x += k * (o.v - x);
      p *= 1 - k;
      last = o.t;
      out.push({ t: o.t, v: x, sd: Math.sqrt(p) });
    }
    return out;
  }

  const range = (v, sd) => ({ low: Math.max(1, Math.round(v - Z90 * sd)), high: Math.round(v + Z90 * sd) });
  const point = (x, y, extra = {}) => ({ x, y: y === null ? null : r1(y), low: null, high: null, workoutImplied: null, title: '', reason: '', rangeKind: '', dateOnly: false, order: 0, ...extra });

  /** Best of 60 min, 0.97 x 45 min and 0.93 x 20 min power in one ride's curve. */
  function capacityFloor(curve) {
    const V = P(), g = (s) => curve[V.gridIndex(s)];
    const cands = [[g(3600), 1, '60 min'], [g(2700), 0.97, '45 min'], [g(1200), 0.93, '20 min']].filter(([w]) => w > 0).map(([w, f, d]) => ({ v: w * f, d, w }));
    if (!cands.length) return null;
    return cands.reduce((a, b) => (b.v > a.v ? b : a));
  }

  /**
   * All five histories. rides: [{ id, t, title, curve, hrp }] oldest first (hrp from hrPowerEstimate);
   * ftpAt(t) is the FTP in use at t; now the end. Returns { series: { A, Aplus, B, C, Cfloor }, stats }.
   */
  function build({ rides, ftpAt, now = Date.now(), thr }) {
    const V = P();
    const list = (rides || []).filter(r => r && fin(r.t) && r.t <= now).sort((a, b) => a.t - b.t);
    const series = { A: [], Aplus: [], B: [], C: [], Cfloor: [] };
    if (!list.length) return { series, stats: { rides: 0, hrRides: 0 } };
    const first = list[0].t;

    // A + Aplus: weekly 90-day power curve.
    const weekly = V.modelHistory(list.map(r => ({ t: r.t, curve: r.curve })), { from: first + 14 * DAY, to: now, stepDays: 7, windowDays: 90 });
    const aObs = [];
    for (const h of weekly) {
      let v = null, reason = '', sdPct = 0.07;
      if (h.ok) { v = h.cp; reason = `Critical power of the 90-day power curve (W′ ${(h.w / 1000).toFixed(1)} kJ, fit error ${h.rmsePct != null ? h.rmsePct.toFixed(1) + '%' : 'n/a'})`; sdPct = h.rmsePct != null && h.rmsePct < 3 ? 0.03 : 0.05; }
      else {
        const env = V.envelope(list.filter(r => r.t > h.t - 90 * DAY && r.t <= h.t).map(r => ({ t: r.t, curve: r.curve })));
        const p20 = env.watts[V.gridIndex(1200)];
        if (p20 > 0) { v = p20 * 0.95; reason = '0.95 × best 20 min of the last 90 days (curve could not be modelled)'; }
      }
      series.A.push(point(h.t, v, { reason: v === null ? 'Not enough power data in the 90 days' : reason }));
      if (v !== null) aObs.push({ t: h.t, v, sd: v * sdPct });
    }
    if (aObs.length) {
      const prior = { v: ftpAt(aObs[0].t) || aObs[0].v, sd: (ftpAt(aObs[0].t) || aObs[0].v) * 0.08 };
      kalman(aObs, prior).forEach(k => series.Aplus.push(point(k.t, k.v, { ...range(k.v, k.sd), rangeKind: 'conditional model range (90%)', reason: 'Power curve through a Kalman filter: changes of more than ~0.5% a week need the curve to keep showing them' })));
    }

    // B: workout-implied FTP from power vs heart rate, filtered.
    const bObs = list.filter(r => r.hrp && r.hrp.ok).map(r => ({ t: r.t, v: r.hrp.implied, sd: Math.sqrt(r.hrp.se ** 2 + (r.hrp.implied * 0.04) ** 2), r }));
    if (bObs.length) {
      const f0 = ftpAt(bObs[0].t) || bObs[0].v;
      kalman(bObs, { v: f0, sd: f0 * 0.08 }).forEach((k, i) => {
        const r = bObs[i].r;
        series.B.push(point(k.t, k.v, { ...range(k.v, k.sd), workoutImplied: r.hrp.implied, title: r.title || '',
          rangeKind: 'conditional model range (90%)',
          reason: `This workout: ${r.hrp.implied} W at ${thr.hr} bpm${thr.assumed ? ' (assumed: 90% of max HR)' : ''} from ${r.hrp.n} steady minutes, R² ${r.hrp.r2}` }));
      });
    }

    // Cfloor per ride, C weekly from the floors.
    const floors = [];
    for (const r of list) {
      const f = capacityFloor(r.curve || []);
      if (!f) continue;
      floors.push({ t: r.t, v: f.v, d: f.d, w: f.w, title: r.title });
      if (f.v >= 0.9 * (ftpAt(r.t) || Infinity)) series.Cfloor.push(point(r.t, f.v, { title: r.title || '', reason: `Proven by this ride: ${f.w} W for ${f.d}` }));
    }
    for (let t = first + 14 * DAY; t <= now + 1; t += WEEK) {
      const recent = floors.filter(f => f.t <= t && f.t > t - 120 * DAY);
      const prior = ftpAt(t);
      if (!recent.length) { series.C.push(point(t, prior || null, { reason: prior ? 'No sustained efforts in 120 days: FTP in use (prior)' : '' })); continue; }
      const aged = recent.map(f => ({ ...f, a: f.v * (1 - 0.003 * Math.max(0, (t - f.t) / DAY - 14)) }));
      const best = aged.reduce((a, b) => (b.a > a.a ? b : a));
      const fresh = t - best.t <= 42 * DAY;
      const v = fresh || !prior ? best.a : (best.a + prior) / 2;
      series.C.push(point(t, v, { reason: `${fresh ? 'Strongest' : 'Older'} sustained effort: ${best.w} W for ${best.d} on ${new Date(best.t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}${fresh ? '' : ', half-way back to the FTP in use'}` }));
    }
    return { series, stats: { rides: list.length, hrRides: bObs.length, thr } };
  }

  const VeloFtpModel = { thresholdHr, hrPowerEstimate, hrPowerBlocks, hrPowerFromBlocks, kalman, capacityFloor, build, MODEL_VERSION: 'app-1' };
  if (typeof module !== 'undefined' && module.exports) module.exports = VeloFtpModel;
  if (root) root.VeloFtpModel = VeloFtpModel;
})(typeof window !== 'undefined' ? window : globalThis);
