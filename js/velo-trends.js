/**
 * APEX VELO // LAB - Progression trends for the Analytics dashboard (pure, no DOM).
 *
 *  - efOf(ride):          Efficiency Factor (NP / average HR) of a steady aerobic ride, or null.
 *                         Steady = variability index <= 1.06, IF 0.55-0.88, 20 min or more after
 *                         the warm-up. Interval sessions are left out: their EF means nothing.
 *  - efPoints(rides):     EF per qualifying ride, oldest first.
 *  - rollingMean(points, day, days): average of the points in the `days` before `day`.
 *  - rampRate(ctl):       CTL gained over the last 7 days (fitness ramp, TSS/day per week).
 *  - windowBest(rides, peaksOf, i, from, to): best power for one duration in a date window.
 *  - powerProfile(...):   5 s / 1 min / 5 min / 20 min - last 90 days vs the 90 before, and PRs
 *                         (a PR = beat everything before the last 90 days, archive included).
 *  - balancePoints(rides):average left-leg % per ride (only rides where the pedals measured it).
 *  - sparkline(values):   tiny inline SVG path for the dashboard tiles.
 */
class VeloTrends {
  static DAY = 86400000;
  static PROFILE = [{ i: 0, label: '5 s', name: 'Sprint' }, { i: 1, label: '1 min', name: 'Anaerobic' }, { i: 2, label: '5 min', name: 'VO2 max' }, { i: 3, label: '20 min', name: 'Threshold' }];

  static t(r) { const v = new Date(r.date).getTime(); return Number.isFinite(v) ? v : null; }

  static efOf(r) {
    if (!r || (typeof VeloMetrics !== 'undefined' && VeloMetrics.isCycling && !VeloMetrics.isCycling(r))) return null;
    const ftp = Number(r.ftpAtRide) || 0;
    if (Array.isArray(r.samples) && r.samples.length >= 1200) {
      const warm = r.samples.length >= 2400 ? 600 : 300;
      const win = r.samples.slice(warm).filter(s => Number(s.power) > 0 && Number(s.hr) > 0);
      if (win.length < 1200) return null;
      const p = win.map(s => Number(s.power));
      const avg = p.reduce((a, b) => a + b, 0) / p.length;
      const np = VeloMetrics.normalizedPower(p) || avg;
      const hr = win.reduce((a, s) => a + Number(s.hr), 0) / win.length;
      if (np / avg > 1.06) return null;
      if (ftp && (np / ftp < 0.55 || np / ftp > 0.88)) return null;
      return { ef: Math.round((np / hr) * 100) / 100, np: Math.round(np), hr: Math.round(hr) };
    }
    // Summary-only rides (imports): need NP, average power and average HR to judge steadiness.
    const np = Number(r.np) || 0, avgP = Number(r.avgWatts || r.avgPower) || 0, hr = Number(r.avgHr) || 0;
    const dur = Number(r.duration) || 0, ifac = parseFloat(r.if) || (ftp && np ? np / ftp : 0);
    if (!np || !avgP || !hr || dur < 1200 || np / avgP > 1.06 || !ifac || ifac < 0.55 || ifac > 0.88) return null;
    return { ef: Math.round((np / hr) * 100) / 100, np: Math.round(np), hr: Math.round(hr) };
  }

  static efPoints(rides) {
    const out = [];
    (rides || []).forEach(r => {
      const t = VeloTrends.t(r);
      if (t === null) return;
      const e = VeloTrends.efOf(r);
      if (e) out.push({ t, id: r.id, title: r.title, ...e });
    });
    return out.sort((a, b) => a.t - b.t);
  }

  /** Mean of point values (field `key`) with t in (at - days, at]. */
  static rollingMean(points, at, days, key = 'ef') {
    const from = at - days * VeloTrends.DAY;
    const v = points.filter(p => p.t > from && p.t <= at && Number.isFinite(p[key])).map(p => p[key]);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  }

  /** Rolling mean sampled once per step across [from, to] - the trend line for a chart or sparkline. */
  static rollingSeries(points, from, to, days, stepDays = 7, key = 'ef') {
    const out = [];
    for (let t = from; t <= to + 1; t += stepDays * VeloTrends.DAY) out.push({ t, v: VeloTrends.rollingMean(points, t, days, key) });
    return out;
  }

  /** CTL now minus CTL 7 days ago (from a daily CTL series, oldest first). */
  static rampRate(ctl) {
    if (!Array.isArray(ctl) || ctl.length < 8) return null;
    return Math.round((ctl[ctl.length - 1] - ctl[ctl.length - 8]) * 10) / 10;
  }

  /** Ramp-rate verdict: sustainable build, aggressive, or losing fitness. */
  static rampVerdict(r) {
    if (r === null) return { key: 'none', label: '--' };
    if (r > 7) return { key: 'high', label: 'Too steep - injury and illness risk' };
    if (r > 5) return { key: 'warn', label: 'Aggressive build' };
    if (r >= 1) return { key: 'ok', label: 'Building' };
    if (r > -2) return { key: 'flat', label: 'Holding' };
    return { key: 'down', label: 'Losing fitness (or tapering)' };
  }

  static windowBest(rides, peaksOf, i, from, to) {
    let best = null;
    (rides || []).forEach(r => {
      const t = VeloTrends.t(r);
      if (t === null || t <= from || t > to) return;
      const pk = peaksOf(r);
      const v = pk && Number(pk[i]);
      if (v > 0 && (best === null || v > best)) best = v;
    });
    return best;
  }

  /**
   * Power profile rows: best of the last 90 days, of the 90 days before, and all-time (rides plus the
   * archive bests). pr = the all-time best was set in the last 90 days.
   */
  static powerProfile(rides, peaksOf, now, archive = null, weightKg = 0) {
    const D = VeloTrends.DAY;
    return VeloTrends.PROFILE.map(({ i, label, name }) => {
      const last = VeloTrends.windowBest(rides, peaksOf, i, now - 90 * D, now);
      const prev = VeloTrends.windowBest(rides, peaksOf, i, now - 180 * D, now - 90 * D);
      const ridesBest = VeloTrends.windowBest(rides, peaksOf, i, -Infinity, now);
      const olderBest = VeloTrends.windowBest(rides, peaksOf, i, -Infinity, now - 90 * D);
      const arch = archive && Number(archive[i]) > 0 ? Number(archive[i]) : null;
      const allTime = Math.max(ridesBest || 0, arch || 0) || null;
      const before = Math.max(olderBest || 0, arch || 0) || null;
      return {
        label, name, last, prev, allTime,
        delta: last !== null && prev !== null ? last - prev : null,
        wkg: last !== null && weightKg > 0 ? Math.round((last / weightKg) * 100) / 100 : null,
        pr: last !== null && allTime !== null && last >= allTime && (before === null || last > before)
      };
    });
  }

  static balancePoints(rides) {
    return (rides || []).map(r => ({ t: VeloTrends.t(r), id: r.id, title: r.title, v: Number(r.leftBal) }))
      .filter(p => p.t !== null && Number.isFinite(p.v) && p.v > 20 && p.v < 80)
      .sort((a, b) => a.t - b.t);
  }

  /** Inline SVG sparkline (nulls are gaps). */
  static sparkline(values, { w = 120, h = 30, color = 'currentColor' } = {}) {
    const v = (values || []).map(x => (Number.isFinite(x) ? x : null));
    const nums = v.filter(x => x !== null);
    if (nums.length < 2) return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"></svg>`;
    const lo = Math.min(...nums), hi = Math.max(...nums), span = hi - lo || 1;
    const x = (i) => (v.length === 1 ? w / 2 : (i / (v.length - 1)) * (w - 4) + 2);
    const y = (val) => h - 3 - ((val - lo) / span) * (h - 6);
    let d = '', pen = false, lastPt = null;
    v.forEach((val, i) => {
      if (val === null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(val).toFixed(1)}`;
      pen = true; lastPt = [x(i), y(val)];
    });
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${d}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>${lastPt ? `<circle cx="${lastPt[0].toFixed(1)}" cy="${lastPt[1].toFixed(1)}" r="2.4" fill="${color}"/>` : ''}</svg>`;
  }
}

if (typeof window !== 'undefined') window.VeloTrends = VeloTrends;
if (typeof module !== 'undefined' && module.exports) module.exports = VeloTrends;
