/**
 * APEX VELO // LAB - Power-duration modelling and advanced ride metrics (pure, no DOM).
 *
 * Built on VeloMetrics:
 *  - prepare(samples):   1 Hz power / HR / cadence / target / time arrays plus segment starts (pauses),
 *                        the same view of a ride that NP and the power bests use.
 *  - mmp(prep):          mean-maximal power on a log-spaced grid (1 s to 4 h). Windows never span a
 *                        pause. Identical to VeloMetrics.bestRollingAvg at every grid duration.
 *  - envelope(entries):  best of many curves, remembering the ride and date of every point.
 *  - fitModel(curve):    critical-power model: CP and W' from the work-time fit of the 3-20 min bests
 *                        (upper envelope: submaximal bests are down-weighted), Pmax from Morton's
 *                        3-parameter form on the short end: P(t) = CP + W'/(t + W'/(Pmax - CP)).
 *                        { ok: false, reason } when the curve cannot support a model.
 *  - wbal(prep, cp, w):  W' balance with the Skiba / Froncioni-Clarke differential model; pauses
 *                        recover exponentially. Also work and time above CP and "matches burned".
 *  - rideMetrics(prep):  HR zones, Edwards TRIMP, power histogram.
 *  - quadrants(prep):    quadrant analysis - average effective pedal force vs circumferential pedal
 *                        velocity (Chung), split at CP (or FTP) and the ride's own cadence.
 *  - seiler(zones):      3-zone intensity distribution and polarization index (Treff et al. 2019).
 *  - vo2maxEstimate(p5, kg): 10.8 x W/kg (best 5 min) + 7 ml/kg/min.
 *
 * Everything is deterministic and measured-data-only: a value that cannot be computed is null.
 */
class VeloPower {
  static DAY = 86400000;
  /** Log-spaced mean-maximal grid (s). Contains every VeloMetrics.MMP_DURATIONS and medal duration. */
  static GRID = [1, 2, 3, 5, 8, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 300, 420, 600, 900, 1200, 1800, 2700, 3600, 5400, 7200, 10800, 14400];
  static CRANK_MM = 172.5;
  static MATCH_J = 2000;
  /** Coggan zone upper bounds in % FTP (Z1..Z6; Z7 is everything above). Mirrors VeloMetrics.ZONES. */
  static ZONE_MAX = [55, 75, 90, 105, 120, 150];

  static gridIndex(sec) { return VeloPower.GRID.indexOf(sec); }

  /** Short label for a duration in seconds: 5s, 1m, 1m30, 20m, 1h, 1h30. */
  static durLabel(sec) {
    const s = Math.round(Number(sec) || 0);
    if (s < 60) return `${s}s`;
    if (s < 3600) return s % 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}` : `${s / 60}m`;
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
  }

  // ------------------------------------------------------------------ prep --
  /**
   * 1 Hz arrays for a ride. starts[k] is the first index of segment k; gaps[k] the seconds of pause
   * before it (wall clock when known, else the gap in the time channel), used for W' recovery.
   */
  static prepare(samples) {
    const s = VeloMetrics.toOneHz(Array.isArray(samples) ? samples : []);
    const n = s.length;
    const power = new Float64Array(n), hr = new Float32Array(n), cad = new Float32Array(n);
    const time = new Float64Array(n), target = new Float32Array(n);
    const starts = [], gaps = [];
    for (let i = 0; i < n; i++) {
      const x = s[i];
      power[i] = Number(x.power) || 0;
      hr[i] = Number(x.hr) || 0;
      cad[i] = Number(x.cadence) || 0;
      target[i] = Number(x.target) || 0;
      time[i] = Number.isFinite(Number(x.time)) && x.time !== null && x.time !== '' ? Number(x.time) : i;
      if (i === 0 || VeloMetrics.isSampleBreak(s[i - 1], x)) {
        starts.push(i);
        let gap = 0;
        if (i) {
          const a = Number(s[i - 1].timestamp), b = Number(x.timestamp);
          const ta = Number(s[i - 1].time), tb = Number(x.time);
          if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b - a > 1000) gap = (b - a) / 1000 - 1;
          else if (Number.isFinite(ta) && Number.isFinite(tb) && tb - ta > 1) gap = tb - ta - 1;
        }
        gaps.push(gap);
      }
    }
    return { n, power, hr, cad, time, target, starts, gaps };
  }

  // ------------------------------------------------------------------- MMP --
  /** Mean-maximal power at each grid duration (rounded W, null when no uninterrupted window fits). */
  static mmp(prep, grid = VeloPower.GRID) {
    const out = new Array(grid.length).fill(null);
    if (!prep || !prep.n) return out;
    const { power, starts, n } = prep;
    for (let k = 0; k < starts.length; k++) {
      const a = starts[k], b = k + 1 < starts.length ? starts[k + 1] : n, len = b - a;
      if (len <= 0) continue;
      const pre = new Float64Array(len + 1);
      for (let i = 0; i < len; i++) pre[i + 1] = pre[i] + power[a + i];
      for (let g = 0; g < grid.length; g++) {
        const d = grid[g];
        if (d > len) continue;
        let best = -Infinity;
        for (let i = d; i <= len; i++) { const v = pre[i] - pre[i - d]; if (v > best) best = v; }
        const avg = Math.round(best / d);
        if (out[g] === null || avg > out[g]) out[g] = avg;
      }
    }
    return out;
  }

  /** Seconds in each Coggan zone (Z1..Z7) for a 1 Hz power array. */
  static zoneSeconds(power, ftp) {
    const z = [0, 0, 0, 0, 0, 0, 0];
    if (!(ftp > 0) || !power) return z;
    const lim = VeloPower.ZONE_MAX;
    for (let i = 0; i < power.length; i++) {
      const pct = (power[i] / ftp) * 100; // same expression as VeloMetrics.zoneForPct callers
      if (pct < lim[0]) { z[0]++; continue; }
      let k = 1;
      while (k < 6 && pct > lim[k]) k++;
      z[k]++;
    }
    return z;
  }

  /**
   * Best of many curves. entries: [{ id, t, curve }] (curve aligned to the grid).
   * Returns { watts, ids, times } - the ride and time that set each point.
   */
  static envelope(entries, len = VeloPower.GRID.length) {
    const watts = new Array(len).fill(null), ids = new Array(len).fill(null), times = new Array(len).fill(null);
    for (const e of entries || []) {
      const c = e && e.curve;
      if (!c) continue;
      for (let g = 0; g < len; g++) {
        const v = c[g];
        if (v > 0 && (watts[g] === null || v > watts[g])) { watts[g] = v; ids[g] = e.id ?? null; times[g] = e.t ?? null; }
      }
    }
    return { watts, ids, times };
  }

  // ------------------------------------------------------------- CP model --
  static model(t, m) { return m.cp + m.w / (t + m.w / (m.pmax - m.cp)); }

  static modelCurve(m, durations) { return durations.map(t => Math.round(VeloPower.model(t, m))); }

  /**
   * 2-parameter work-time fit: work = CP x t + W' over the 3-20 min bests (weighted linear
   * regression). With envelope = true, bests more than 5% under the fitted line are treated as
   * submaximal (weight 0.02) and the fit repeated until the set is stable.
   * Returns { cp, w, r2, used, points } or null.
   */
  static fitCp2(curve, grid = VeloPower.GRID, { from = 180, to = 1200, envelope = false } = {}) {
    const pts = [];
    grid.forEach((t, i) => { const v = curve && curve[i]; if (t >= from && t <= to && v > 0) pts.push({ t, p: v, work: v * t }); });
    if (pts.length < 3) return null;
    let wts = pts.map(() => 1), res = null;
    for (let pass = 0; pass < 6; pass++) {
      let S = 0, Sx = 0, Sy = 0;
      pts.forEach((q, i) => { S += wts[i]; Sx += wts[i] * q.t; Sy += wts[i] * q.work; });
      const mx = Sx / S, my = Sy / S;
      let sxy = 0, sxx = 0, syy = 0;
      pts.forEach((q, i) => { sxy += wts[i] * (q.t - mx) * (q.work - my); sxx += wts[i] * (q.t - mx) ** 2; syy += wts[i] * (q.work - my) ** 2; });
      if (!sxx) return null;
      const cp = sxy / sxx, w = my - cp * mx;
      res = { cp, w, r2: syy ? (sxy * sxy) / (sxx * syy) : 1 };
      if (!envelope) break;
      const next = pts.map(q => ((q.p - (cp + w / q.t)) / q.p < -0.05 ? 0.02 : 1));
      if (next.every((v, i) => v === wts[i])) break;
      wts = next;
    }
    if (!(res.cp > 0) || !(res.w > 0)) return null;
    return { ...res, used: wts.filter(v => v === 1).length, points: pts.length };
  }

  /** Small Nelder-Mead minimiser (no dependencies). */
  static nelderMead(f, x0, steps, { maxIter = 400, tol = 1e-12 } = {}) {
    const n = x0.length;
    let pts = [x0.slice()];
    for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] += steps[i]; pts.push(x); }
    let vals = pts.map(f);
    const sort = () => {
      const order = vals.map((_, i) => i).sort((a, b) => vals[a] - vals[b]);
      pts = order.map(i => pts[i]); vals = order.map(i => vals[i]);
    };
    for (let it = 0; it < maxIter; it++) {
      sort();
      if (Math.abs(vals[n] - vals[0]) <= tol) break;
      const c = new Array(n).fill(0);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += pts[i][j] / n;
      const worst = pts[n];
      const xr = c.map((v, j) => v + (v - worst[j]));
      const fr = f(xr);
      if (fr < vals[0]) {
        const xe = c.map((v, j) => v + 2 * (v - worst[j]));
        const fe = f(xe);
        if (fe < fr) { pts[n] = xe; vals[n] = fe; } else { pts[n] = xr; vals[n] = fr; }
      } else if (fr < vals[n - 1]) {
        pts[n] = xr; vals[n] = fr;
      } else {
        const outside = fr < vals[n];
        const xc = c.map((v, j) => v + 0.5 * ((outside ? xr[j] : worst[j]) - v));
        const fc = f(xc);
        if (fc < (outside ? fr : vals[n])) { pts[n] = xc; vals[n] = fc; }
        else for (let i = 1; i <= n; i++) { pts[i] = pts[i].map((v, j) => pts[0][j] + 0.5 * (v - pts[0][j])); vals[i] = f(pts[i]); }
      }
    }
    sort();
    return { x: pts[0], f: vals[0] };
  }

  /**
   * Critical-power model of a mean-maximal curve.
   *  - CP and W' come from the 2-parameter work-time fit of the 3-20 min bests, fitted to their
   *    upper envelope (fitCp2 with envelope): the standard field method, and it keeps CP at or
   *    under the 20-min best on real curves, where a free 3-parameter fit overshoots.
   *  - Pmax is then fitted (Morton's 3-parameter form, CP and W' fixed) to the bests up to 2 min,
   *    so the model curve P(t) = CP + W'/(t + W'/(Pmax - CP)) also follows the short end.
   * Returns { ok: true, cp, w (J), pmax, rmsePct, points, used, lowW } or { ok: false, reason }:
   *   'no-data' - no curve; 'coverage' - no effort of 12 min or more, or nothing of 1 min or less;
   *   'fit' - the curve does not look like a power-duration curve (implausible parameters or error).
   */
  static fitModel(curve, { grid = VeloPower.GRID } = {}) {
    if (!curve || !curve.some(v => v > 0)) return { ok: false, reason: 'no-data' };
    const val = (sec) => { const i = grid.indexOf(sec); return i >= 0 && curve[i] > 0 ? curve[i] : null; };
    const mid = grid.filter(t => t >= 180 && t <= 1200 && val(t) !== null);
    const short = grid.filter(t => t <= 120 && val(t) !== null);
    if (mid.length < 4 || !mid.some(t => t >= 720) || !short.some(t => t <= 60)) {
      return { ok: false, reason: 'coverage', points: mid.length };
    }
    const lin = VeloPower.fitCp2(curve, grid, { envelope: true });
    if (!lin) return { ok: false, reason: 'fit', points: mid.length };
    const { cp, w } = lin;
    const f = ([pmax]) => {
      if (!(pmax > cp * 1.2 && pmax < 5000)) return 1e9;
      let s = 0;
      short.forEach(t => { const p = val(t), r = (VeloPower.model(t, { cp, w, pmax }) - p) / p; s += r * r; });
      return s;
    };
    const top = val(short[0]);
    const pmax = VeloPower.nelderMead(f, [Math.max(top, cp * 1.5)], [top * 0.1], { maxIter: 200 }).x[0];
    // Goodness of fit of CP and W': relative error of the work-time fit over the maximal 3-20 min bests.
    const used = mid.filter(t => (val(t) - (cp + w / t)) / val(t) >= -0.05);
    const rmse = Math.sqrt(used.reduce((a, t) => a + ((cp + w / t - val(t)) / val(t)) ** 2, 0) / Math.max(1, used.length));
    const p20 = val(1200);
    const plausible = cp >= 40 && cp <= 700 && w >= 1000 && w <= 80000 && pmax > cp * 1.2 && (p20 === null || cp <= p20 * 1.02);
    if (!plausible || rmse > 0.08 || used.length < 3) return { ok: false, reason: 'fit', points: mid.length, rmsePct: Math.round(rmse * 1000) / 10 };
    const p5 = val(300);
    return {
      ok: true, cp: Math.round(cp), w: Math.round(w), pmax: Math.round(pmax),
      rmsePct: Math.round(rmse * 1000) / 10, points: mid.length, used: used.length,
      // A tiny W' usually means the window had no all-out short efforts, not a real W' that small.
      lowW: w < 6000 || (p5 !== null && p5 < cp * 1.08)
    };
  }

  /** Estimated VO2max (ml/kg/min) from the best 5-min power: 10.8 x W/kg + 7. */
  static vo2maxEstimate(p5, kg) {
    return p5 > 0 && kg > 0 ? Math.round((10.8 * (p5 / kg) + 7) * 10) / 10 : null;
  }

  // ------------------------------------------------------------------ W'bal --
  static wbalStep(bal, p, cp, w, dt = 1) {
    return p > cp ? bal - (p - cp) * dt : bal + ((cp - p) * (w - bal) / w) * dt;
  }

  /** W' recovered while stopped (P = 0) for `sec` seconds. */
  static wbalRecover(bal, cp, w, sec) {
    return sec > 0 ? w - (w - bal) * Math.exp((-cp * sec) / w) : bal;
  }

  /** Seconds until W' is empty at power p (Infinity at or under CP). */
  static timeToEmpty(bal, p, cp) { return p > cp ? Math.max(0, bal) / (p - cp) : Infinity; }

  /**
   * W' balance over a ride. Returns { bal: Float32Array (J), min, minAt, maxDepletion (J),
   * maxDepletionPct, matches, aboveSec, aboveKj, lowSec, end } or null without a model.
   * A match = W' falling by >= 2 kJ from its last high point; it ends once 1 kJ is won back.
   */
  static wbal(prep, cp, w, { matchJ = VeloPower.MATCH_J } = {}) {
    if (!prep || !prep.n || !(cp > 0) || !(w > 0)) return null;
    const { n, power, starts, gaps } = prep;
    const bal = new Float32Array(n);
    let b = w, min = w, minAt = 0, si = 0, matches = 0, burning = false, peak = w, trough = w;
    let aboveSec = 0, aboveJ = 0, lowSec = 0;
    for (let i = 0; i < n; i++) {
      if (si < starts.length && starts[si] === i) { b = VeloPower.wbalRecover(b, cp, w, gaps[si] || 0); si++; }
      const p = power[i];
      b = VeloPower.wbalStep(b, p, cp, w);
      if (p > cp) { aboveSec++; aboveJ += p - cp; }
      if (b < min) { min = b; minAt = i; }
      if (b < 0.25 * w) lowSec++;
      if (!burning) {
        if (b > peak) peak = b;
        if (peak - b >= matchJ) { matches++; burning = true; trough = b; }
      } else {
        if (b < trough) trough = b;
        if (b - trough >= matchJ / 2) { burning = false; peak = b; }
      }
      bal[i] = b;
    }
    return {
      bal, min: Math.round(min), minAt, maxDepletion: Math.round(w - min), maxDepletionPct: Math.round(((w - min) / w) * 100),
      matches, aboveSec, aboveKj: Math.round(aboveJ / 100) / 10, lowSec, end: Math.round(b)
    };
  }

  // ---------------------------------------------------------- ride metrics --
  /**
   * HR zones (the app's 5 zones of max HR), Edwards TRIMP (minutes x 1-5 by 50-60-70-80-90 % max HR)
   * and a power histogram (25 W bins). Zones and TRIMP need max HR; null otherwise.
   */
  static rideMetrics(prep, { maxHr = 0, bin = 25 } = {}) {
    if (!prep || !prep.n) return null;
    const { n, power, hr } = prep;
    let hrSum = 0, hrN = 0, trimp = 0, maxP = 0;
    const hrZones = [0, 0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      const p = power[i];
      if (p > maxP) maxP = p;
      const h = hr[i];
      if (h > 0) {
        hrSum += h; hrN++;
        if (maxHr > 0) {
          const pct = (h / maxHr) * 100;
          hrZones[pct > 89 ? 4 : pct > 82 ? 3 : pct > 72 ? 2 : pct > 60 ? 1 : 0]++;
          trimp += (pct >= 90 ? 5 : pct >= 80 ? 4 : pct >= 70 ? 3 : pct >= 60 ? 2 : pct >= 50 ? 1 : 0) / 60;
        }
      }
    }
    const bins = Math.min(80, Math.floor(maxP / bin) + 1);
    const counts = new Array(bins).fill(0);
    for (let i = 0; i < n; i++) counts[Math.min(bins - 1, Math.floor(Math.max(0, power[i]) / bin))]++;
    return {
      hrAvg: hrN ? Math.round(hrSum / hrN) : null,
      hrSeconds: hrN,
      hrZones: maxHr > 0 && hrN ? hrZones : null,
      trimp: maxHr > 0 && hrN >= 60 ? Math.round(trimp) : null,
      hist: { bin, counts }
    };
  }

  /**
   * Quadrant analysis. Each pedalling second (power > 0, cadence >= 20 rpm) becomes a point of
   * circumferential pedal velocity (m/s) and average effective pedal force (N = P / CPV). The lines
   * split at the force needed for refPower (CP or FTP) at the ride's average cadence.
   * pct = [QI high force + high speed, QII high force + low speed, QIII low + low, QIV low force + high speed].
   */
  static quadrants(prep, refPower, crankMm = VeloPower.CRANK_MM, maxPoints = 1500) {
    if (!prep || !prep.n || !(refPower > 0)) return null;
    const { n, power, cad } = prep;
    const L = (Number(crankMm) > 100 && Number(crankMm) < 220 ? Number(crankMm) : VeloPower.CRANK_MM) / 1000;
    const k = (L * 2 * Math.PI) / 60;
    let cadSum = 0, m = 0;
    for (let i = 0; i < n; i++) if (power[i] > 0 && cad[i] >= 20) { cadSum += cad[i]; m++; }
    if (m < 60) return null;
    const refCad = cadSum / m, refCpv = refCad * k, refAepf = refPower / refCpv;
    const q = [0, 0, 0, 0], points = [];
    const stride = Math.max(1, Math.ceil(m / maxPoints));
    let j = 0;
    for (let i = 0; i < n; i++) {
      const p = power[i], c = cad[i];
      if (!(p > 0 && c >= 20)) continue;
      const cpv = c * k, aepf = p / cpv;
      const hiF = aepf >= refAepf, hiV = cpv >= refCpv;
      q[hiF ? (hiV ? 0 : 1) : (hiV ? 3 : 2)]++;
      if (j++ % stride === 0) points.push({ x: Math.round(cpv * 1000) / 1000, y: Math.round(aepf * 10) / 10 });
    }
    return {
      refCad: Math.round(refCad), refCpv: Math.round(refCpv * 1000) / 1000, refAepf: Math.round(refAepf * 10) / 10,
      crankMm: Math.round(L * 10000) / 10, seconds: m, pct: q.map(v => Math.round((v / m) * 1000) / 10), points
    };
  }

  // ---------------------------------------------------- intensity balance --
  /**
   * 3-zone distribution from Coggan zone seconds: low = Z1-Z2 (< 75% FTP), moderate = Z3-Z4
   * (75-105%), high = Z5+ (> 105%). PI = log10(low/moderate x high x 100) with fractions;
   * polarized needs low > high > moderate and PI > 2.
   */
  static seiler(z7) {
    const z = (z7 || []).map(v => Number(v) || 0);
    const tot = z.reduce((a, b) => a + b, 0);
    if (!tot) return null;
    const f = [z[0] + z[1], z[2] + z[3], z[4] + z[5] + z[6]].map(v => v / tot);
    const pi = f[1] > 0 && f[2] > 0 ? Math.log10((f[0] / f[1]) * f[2] * 100) : null;
    let type;
    if (f[0] > f[2] && f[2] > f[1]) type = pi !== null && pi > 2 ? 'polarized' : 'mixed';
    else if (f[0] >= f[1] && f[1] >= f[2]) type = 'pyramidal';
    else if (f[1] > f[0] && f[1] >= f[2]) type = 'threshold';
    else if (f[2] > f[0] && f[2] > f[1]) type = 'high';
    else type = 'mixed';
    const label = { polarized: 'Polarized', pyramidal: 'Pyramidal', threshold: 'Threshold-heavy', high: 'High-intensity heavy', mixed: 'Mixed' }[type];
    return { pct: f.map(v => Math.round(v * 1000) / 10), pi: pi === null ? null : Math.round(pi * 100) / 100, type, label };
  }

  // ------------------------------------------------------ model over time --
  /**
   * Rolling model history: at each time t in [from, to] (every `stepDays`), the model fitted to the
   * envelope of entries with t - windowDays < entry.t <= t. entries: [{ t, curve, id }].
   */
  static modelHistory(entries, { from, to, stepDays = 14, windowDays = 90 } = {}) {
    const D = VeloPower.DAY, out = [];
    const list = (entries || []).filter(e => e && Number.isFinite(e.t)).sort((a, b) => a.t - b.t);
    if (!list.length || !(to >= from)) return out;
    for (let t = to; t >= from - 1; t -= stepDays * D) {
      const env = VeloPower.envelope(list.filter(e => e.t > t - windowDays * D && e.t <= t));
      const m = VeloPower.fitModel(env.watts);
      out.push({ t, ...(m.ok ? { cp: m.cp, w: m.w, pmax: m.pmax, rmsePct: m.rmsePct } : { cp: null, w: null, pmax: null }), ok: !!m.ok });
    }
    return out.reverse();
  }
}

if (typeof window !== 'undefined') window.VeloPower = VeloPower;
if (typeof module !== 'undefined' && module.exports) module.exports = VeloPower;
