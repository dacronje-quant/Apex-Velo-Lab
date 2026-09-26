/**
 * APEX VELO // LAB - Progression aggregations over the ride history (pure, no DOM).
 *
 * Feeds the Analytics "Progression" dashboard and the AI Coach's history
 * context. Only recorded ride fields are used; rides missing a metric simply do
 * not contribute to that metric.
 */
class VeloProgress {
  /** Intensity bands by ride Intensity Factor (NP / FTP). */
  static IF_BANDS = [
    { key: 'recovery',  label: 'Recovery',   max: 0.65,     color: '#7c8aa5' },
    { key: 'endurance', label: 'Endurance',  max: 0.75,     color: '#3b82f6' },
    { key: 'tempo',     label: 'Tempo',      max: 0.85,     color: '#22c55e' },
    { key: 'sweetspot', label: 'SweetSpot',  max: 0.95,     color: '#eab308' },
    { key: 'threshold', label: 'Threshold',  max: 1.05,     color: '#f97316' },
    { key: 'vo2',       label: 'VO2+',       max: Infinity, color: '#ef4444' }
  ];

  static rideIf(r) {
    const v = parseFloat(r.if);
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  static ifBand(ifac) {
    if (ifac === null || ifac === undefined) return null;
    return VeloProgress.IF_BANDS.find(b => ifac < b.max) || VeloProgress.IF_BANDS[VeloProgress.IF_BANDS.length - 1];
  }

  /** Monday 00:00 (local) of the week containing `d`. */
  static weekStart(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const dow = (x.getDay() + 6) % 7;
    x.setDate(x.getDate() - dow);
    return x;
  }

  static validRides(rides) {
    return (rides || []).filter(r => r && r.date && !isNaN(new Date(r.date).getTime()));
  }

  /**
   * Weekly buckets (Monday-based) from `weeks` ago through the current week.
   * weeks = 0 -> from the first ride.
   */
  static weekly(rides, weeks = 26, now = new Date()) {
    const list = VeloProgress.validRides(rides);
    const thisWeek = VeloProgress.weekStart(now);
    let first;
    if (weeks > 0) {
      first = new Date(thisWeek);
      first.setDate(first.getDate() - (weeks - 1) * 7);
    } else if (list.length) {
      first = VeloProgress.weekStart(new Date(Math.min(...list.map(r => new Date(r.date).getTime()))));
    } else {
      first = new Date(thisWeek);
    }
    const buckets = [];
    const index = new Map();
    for (let d = new Date(first); d <= thisWeek; d.setDate(d.getDate() + 7)) {
      const key = VeloMetrics.localDateKey(d);
      index.set(key, buckets.length);
      buckets.push({ key, start: new Date(d), label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), tss: 0, hours: 0, kj: 0, rides: 0, rideIds: [] });
    }
    for (const r of list) {
      const k = VeloMetrics.localDateKey(VeloProgress.weekStart(new Date(r.date)));
      const i = index.get(k);
      if (i === undefined) continue;
      const b = buckets[i];
      b.tss += Number(r.tss) || 0;
      b.hours += (Number(r.duration) || 0) / 3600;
      b.kj += Number(r.kj) || 0;
      b.rides += 1;
      b.rideIds.push(r.id);
    }
    buckets.forEach(b => { b.tss = Math.round(b.tss); b.hours = Math.round(b.hours * 10) / 10; b.kj = Math.round(b.kj); });
    return buckets;
  }

  /** Totals for rides in [from, to). */
  static totals(rides, from, to) {
    const list = VeloProgress.validRides(rides).filter(r => {
      const t = new Date(r.date).getTime();
      return t >= from.getTime() && t < to.getTime();
    });
    let tss = 0, sec = 0, kj = 0, npSum = 0, npN = 0, longest = 0;
    for (const r of list) {
      tss += Number(r.tss) || 0;
      sec += Number(r.duration) || 0;
      kj += Number(r.kj) || 0;
      const np = Number(r.np) || Number(r.avgWatts) || 0;
      if (np > 0) { npSum += np; npN++; }
      longest = Math.max(longest, Number(r.duration) || 0);
    }
    return { rides: list.length, tss: Math.round(tss), hours: sec / 3600, kj: Math.round(kj), avgNp: npN ? Math.round(npSum / npN) : 0, longestSec: longest };
  }

  /** KPI tiles for the selected window with deltas vs the preceding window of equal length. */
  static kpis(rides, weeks = 26, now = new Date()) {
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    let start;
    if (weeks > 0) {
      start = new Date(end);
      start.setDate(start.getDate() - weeks * 7);
    } else {
      const list = VeloProgress.validRides(rides);
      start = list.length ? new Date(Math.min(...list.map(r => new Date(r.date).getTime()))) : new Date(end);
    }
    const span = end - start;
    const prevStart = new Date(start.getTime() - span);
    return { cur: VeloProgress.totals(rides, start, end), prev: weeks > 0 ? VeloProgress.totals(rides, prevStart, start) : null, start, end };
  }

  /** Hours per IF band (rides without a recorded IF are counted separately). */
  static intensityMix(rides, from = null) {
    const out = VeloProgress.IF_BANDS.map(b => ({ ...b, hours: 0, rides: 0 }));
    let unknownHours = 0, unknownRides = 0;
    for (const r of VeloProgress.validRides(rides)) {
      if (from && new Date(r.date) < from) continue;
      const h = (Number(r.duration) || 0) / 3600;
      const band = VeloProgress.ifBand(VeloProgress.rideIf(r));
      if (!band) { unknownHours += h; unknownRides++; continue; }
      const slot = out.find(b => b.key === band.key);
      slot.hours += h;
      slot.rides++;
    }
    return { bands: out, unknownHours, unknownRides };
  }

  /** Scatter points: one per ride with recorded power. */
  static scatter(rides, from = null) {
    return VeloProgress.validRides(rides)
      .filter(r => (Number(r.np) || Number(r.avgWatts)) > 0 && Number(r.duration) > 0 && (!from || new Date(r.date) >= from))
      .map(r => {
        const ifac = VeloProgress.rideIf(r);
        const band = VeloProgress.ifBand(ifac);
        return { x: Math.round((Number(r.duration) / 60) * 10) / 10, y: Number(r.np) || Number(r.avgWatts), id: r.id, title: r.title, date: r.date, tss: Number(r.tss) || 0, ifac, color: band ? band.color : '#94a3b8' };
      });
  }

  /** Personal records across the whole history. */
  static records(rides) {
    const list = VeloProgress.validRides(rides);
    const best = (fn) => list.reduce((acc, r) => { const v = fn(r); return v > (acc ? acc.v : 0) ? { v, r } : acc; }, null);
    const bestNp = best(r => Number(r.np) || 0);
    const longest = best(r => Number(r.duration) || 0);
    const bigTss = best(r => Number(r.tss) || 0);
    const bigKj = best(r => Number(r.kj) || 0);
    const weeks = VeloProgress.weekly(list, 0);
    const bestWeek = weeks.reduce((a, w) => (w.tss > (a ? a.tss : 0) ? w : a), null);

    // Longest streak of consecutive riding days
    const days = [...new Set(list.map(r => VeloMetrics.localDateKey(r.date)))].sort();
    let streak = 0, run = 0, prev = null;
    for (const k of days) {
      const d = new Date(k + 'T00:00:00');
      run = (prev && Math.round((d - prev) / 86400000) === 1) ? run + 1 : 1;
      streak = Math.max(streak, run);
      prev = d;
    }
    return { bestNp, longest, bigTss, bigKj, bestWeek, streak };
  }

  /**
   * Compact history profile used by the AI Coach (both the offline engine and the AI prompt).
   * windowDays is the coach's look-back: the "window" fields (volume, intensity mix, longest ride)
   * cover that many days. The *28 fields always cover 28 days for the fixed UI chips.
   */
  static coachProfile(rides, ftp, now = new Date(), windowDays = 28) {
    const list = VeloProgress.validRides(rides);
    const dayMs = 86400000;
    const win = Math.max(1, Math.round(Number(windowDays) || 28));
    const since = (days) => list.filter(r => now - new Date(r.date) <= days * dayMs);
    const last28 = since(28);
    const last7 = since(7);
    const lastWin = since(win);
    const hours = (arr) => arr.reduce((a, r) => a + (Number(r.duration) || 0), 0) / 3600;
    const mixWin = VeloProgress.intensityMix(lastWin);
    const totalKnown = mixWin.bands.reduce((a, b) => a + b.hours, 0);
    const pct = (keys) => totalKnown > 0 ? Math.round((mixWin.bands.filter(b => keys.includes(b.key)).reduce((a, b) => a + b.hours, 0) / totalKnown) * 100) : null;

    const hard = list.filter(r => (VeloProgress.rideIf(r) || 0) >= 0.85).sort((a, b) => new Date(b.date) - new Date(a.date));
    const daysSinceHard = hard.length ? Math.floor((now - new Date(hard[0].date)) / dayMs) : null;
    const long = list.filter(r => (Number(r.duration) || 0) >= 5400).sort((a, b) => new Date(b.date) - new Date(a.date));
    const daysSinceLong = long.length ? Math.floor((now - new Date(long[0].date)) / dayMs) : null;
    const longest28 = last28.reduce((m, r) => Math.max(m, Number(r.duration) || 0), 0);
    const longestWin = lastWin.reduce((m, r) => Math.max(m, Number(r.duration) || 0), 0);

    // Power profile ratios (from the authentic all-time MMP when available)
    let profileType = null;
    const mmp = (typeof DIVAN_HEALTHFIT_DATA !== 'undefined' && DIVAN_HEALTHFIT_DATA.allTimeMmp) ? DIVAN_HEALTHFIT_DATA.allTimeMmp.watts : null;
    if (mmp && mmp.length === 9 && ftp > 0) {
      const p5s = mmp[0], p1m = mmp[3], p5m = mmp[5], p20 = mmp[7];
      const r5m = p5m / ftp, r1m = p1m / ftp, r5s = p5s / ftp;
      if (r5s < 1.6 && r1m < 1.35) profileType = 'diesel (strong endurance, limited top-end)';
      else if (r5m > 1.18) profileType = 'VO2-strong (high 5-min power relative to FTP)';
      else if (r5s > 2.2) profileType = 'punchy / sprinter';
      else profileType = 'all-rounder';
      profileType += ` [5s ${p5s}W, 1m ${p1m}W, 5m ${p5m}W, 20m ${p20}W]`;
    }

    return {
      windowDays: win,
      ridesWin: lastWin.length,
      hoursPerWeekWin: Math.round((hours(lastWin) / (win / 7)) * 10) / 10,
      tssWin: Math.round(lastWin.reduce((a, r) => a + (Number(r.tss) || 0), 0)),
      longestRideMinWin: Math.round(longestWin / 60),
      rides28: last28.length,
      rides7: last7.length,
      hoursPerWeek4w: Math.round((hours(last28) / 4) * 10) / 10,
      hours7: Math.round(hours(last7) * 10) / 10,
      tss28: Math.round(last28.reduce((a, r) => a + (Number(r.tss) || 0), 0)),
      lowIntensityPct: pct(['recovery', 'endurance']),
      midIntensityPct: pct(['tempo', 'sweetspot']),
      highIntensityPct: pct(['threshold', 'vo2']),
      unknownIntensityRides: mixWin.unknownRides,
      daysSinceHard,
      daysSinceLong,
      longestRideMin28: Math.round(longest28 / 60),
      profileType
    };
  }
}

if (typeof window !== 'undefined') window.VeloProgress = VeloProgress;
