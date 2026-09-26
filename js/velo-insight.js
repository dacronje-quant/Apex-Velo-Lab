/**
 * APEX VELO // LAB - Post-ride insight (pure maths, no DOM, no storage).
 *
 *  - decoupling():  aerobic decoupling (Pw:HR drift) of a steady ride.
 *  - peaksOf():     best average power for the medal durations.
 *  - medals():      gold = all-time best, silver = best this year, bronze = best in 90 days
 *                   (always against rides BEFORE this one, so a ride's medals never change later).
 *  - ftpEvidence(): what one ride says about FTP (best 20 min x 0.95 or best 60 min, steadiness, HR).
 *  - ftpSuggestion(): whether to suggest a higher FTP - conservative: one ride is enough only when
 *                   it was steady AND heart rate shows a hard effort; otherwise a second ride within
 *                   21 days must confirm it, and the lower of the two is suggested.
 */
class VeloInsight {
  static MEDAL_DURATIONS = [5, 60, 300, 1200, 3600];
  static MEDAL_LABELS = ['5 s', '1 min', '5 min', '20 min', '60 min'];
  static DAY = 86400000;

  static hasSamples(r) { return !!(r && Array.isArray(r.samples) && r.samples.length >= 5); }

  // ------------------------------------------------------------ decoupling --
  /**
   * Pw:HR decoupling: after the warm-up, compares power per heartbeat in the first and second half.
   * Only for steady rides (variability index <= 1.10, both halves within 7.5% power) of at least
   * 20 min with heart rate.
   * Returns { status: 'ok', pct, label, level, minutes } or { status: <reason> }.
   */
  static decoupling(samples) {
    if (!Array.isArray(samples) || samples.length < 1200) return { status: 'too-short' };
    const warm = samples.length >= 2400 ? 600 : 300;
    const win = samples.slice(warm).filter(s => Number(s.power) > 0 && Number(s.hr) > 0);
    if (win.length < 1200) return { status: samples.slice(warm).some(s => Number(s.hr) > 0) ? 'too-short' : 'no-hr' };
    const powers = win.map(s => Number(s.power));
    const avg = powers.reduce((a, b) => a + b, 0) / powers.length;
    const np = VeloMetrics.normalizedPower(powers) || avg;
    const vi = np / avg;
    if (vi > 1.10) return { status: 'not-steady', vi: Math.round(vi * 100) / 100 };
    const half = Math.floor(win.length / 2);
    // Decoupling compares like with like: both halves must be ridden at about the same power.
    const avgP = (arr) => arr.reduce((a, s) => a + Number(s.power), 0) / arr.length;
    const p1 = avgP(win.slice(0, half)), p2 = avgP(win.slice(half));
    if (Math.abs(p1 - p2) / Math.max(p1, p2) > 0.075) return { status: 'not-steady', vi: Math.round(vi * 100) / 100 };
    const ef = (arr) => {
      const p = arr.reduce((a, s) => a + Number(s.power), 0) / arr.length;
      const h = arr.reduce((a, s) => a + Number(s.hr), 0) / arr.length;
      return p / h;
    };
    const ef1 = ef(win.slice(0, half)), ef2 = ef(win.slice(half));
    const pct = Math.round(((ef1 - ef2) / ef1) * 1000) / 10;
    const level = pct < 5 ? 'good' : pct <= 8 ? 'mild' : 'high';
    const label = level === 'good' ? 'aerobically coupled' : level === 'mild' ? 'mild drift' : 'decoupled';
    return { status: 'ok', pct, level, label, minutes: Math.round(win.length / 60), vi: Math.round(vi * 100) / 100 };
  }

  // ---------------------------------------------------------------- medals --
  /** Best average power for each medal duration (null when the ride is shorter). */
  static peaksOf(samples) {
    const p = (samples || []).map(s => Number(s.power) || 0);
    return VeloInsight.MEDAL_DURATIONS.map(d => VeloMetrics.bestRollingAvg(p, d));
  }

  /**
   * Medals for one ride against earlier rides.
   *   ride:    { id, date, peaks }       history: [{ id, date, peaks }]  (rides with samples)
   *   archive: all-time bests per MEDAL_DURATIONS from before the app (HealthFit), or null
   * Returns [{ i, label, watts, medal: 'gold'|'silver'|'bronze', prev }] - one per duration at most.
   */
  static medals(ride, history, archive = null) {
    const t = Date.parse(ride.date);
    if (!ride.peaks || !Number.isFinite(t)) return [];
    const year = new Date(t).getFullYear();
    const before = (history || []).filter(r => r.id !== ride.id && r.peaks && Date.parse(r.date) < t);
    const out = [];
    VeloInsight.MEDAL_DURATIONS.forEach((d, i) => {
      const w = ride.peaks[i];
      if (!(w > 0)) return;
      const best = (list) => list.reduce((m, r) => Math.max(m, Number(r.peaks[i]) || 0), 0);
      const allTime = Math.max(best(before), Number(archive && archive[i]) || 0);
      const thisYear = best(before.filter(r => new Date(Date.parse(r.date)).getFullYear() === year));
      const last90 = best(before.filter(r => t - Date.parse(r.date) <= 90 * VeloInsight.DAY));
      let medal = null, prev = 0;
      if (w > allTime) { medal = 'gold'; prev = allTime; }
      else if (w > thisYear) { medal = 'silver'; prev = thisYear; }
      else if (w > last90) { medal = 'bronze'; prev = last90; }
      if (medal) out.push({ i, label: VeloInsight.MEDAL_LABELS[i], watts: w, medal, prev: prev || null });
    });
    return out;
  }

  static medalTitle(m, year) {
    const what = m.medal === 'gold' ? 'All-time best' : m.medal === 'silver' ? `Best of ${year}` : 'Best in 90 days';
    return `${what} ${m.label}: ${m.watts} W${m.prev ? ` (was ${m.prev} W)` : ''}`;
  }

  // --------------------------------------------------- interval breakdown --
  /**
   * One row per step (split where the recorded target changes): duration, target, average power,
   * execution %, and - for steps of 60 s or more - cadence fade and heart-rate rise between the
   * first and last third of the step. `work` = a step at or above 88% FTP.
   */
  static intervalRows(samples, ftp) {
    const segs = [];
    let cur = null;
    (samples || []).forEach(s => {
      if (!cur || s.target !== cur.target) { cur = { target: s.target, samples: [] }; segs.push(cur); }
      cur.samples.push(s);
    });
    const mean = (arr) => { const v = arr.filter(x => x > 0); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    return segs.filter(g => g.samples.length >= 5).map((g, i) => {
      const n = g.samples.length, third = Math.floor(n / 3);
      const avgP = Math.round(g.samples.reduce((a, s) => a + (Number(s.power) || 0), 0) / n);
      const cad = (arr) => mean(arr.map(s => Number(s.cadence) || 0));
      const hr = (arr) => mean(arr.map(s => Number(s.hr) || 0));
      const long = n >= 60;
      const first = g.samples.slice(0, third), last = g.samples.slice(n - third);
      const cadFade = long && cad(first) && cad(last) ? Math.round(cad(last) - cad(first)) : null;
      const hrRise = long && hr(first) && hr(last) ? Math.round(hr(last) - hr(first)) : null;
      const target = Number(g.target) || 0;
      return {
        n: i + 1, sec: n, target, avgP, pctOfTarget: target ? Math.round((avgP / target) * 100) : null,
        execution: VeloMetrics.complianceScore(g.samples),
        cadence: cad(g.samples) ? Math.round(cad(g.samples)) : null, cadFade,
        hr: hr(g.samples) ? Math.round(hr(g.samples)) : null, hrRise,
        work: ftp > 0 && target >= ftp * 0.88
      };
    }).map((r, _, all) => ({ ...r, iv: r.work ? all.filter(x => x.work && x.n <= r.n).length : null }));
  }

  /** Free, deterministic breakdown (always shown); the AI coach can add a richer one. */
  static offlineBreakdown(rows) {
    const work = rows.filter(r => r.work);
    if (!work.length) return ['No hard steps (88% FTP or more) in this ride - nothing to break down.'];
    const lines = [];
    const locked = work.filter(r => r.pctOfTarget !== null && Math.abs(r.pctOfTarget - 100) <= 2);
    // Hard steps are named "Interval k" (k-th hard effort) with the step number of the workout in brackets.
    const name = (r) => `Interval ${r.iv} (step ${r.n})`;
    if (locked.length === work.length) lines.push(`All ${work.length} intervals were within 2% of target.`);
    else if (locked.length) lines.push(`Intervals ${locked.map(r => r.iv).join(', ')} were within 2% of target.`);
    work.filter(r => r.pctOfTarget !== null && r.pctOfTarget < 97).forEach(r => lines.push(`${name(r)} came in under target: ${r.avgP} W of ${r.target} W (${r.pctOfTarget}%).`));
    work.filter(r => r.cadFade !== null && r.cadFade <= -5).forEach(r => lines.push(`${name(r)}: cadence faded ${-r.cadFade} rpm from the first to the last third - a sign of muscular fatigue.`));
    work.filter(r => r.hrRise !== null && r.hrRise >= 8 && r.sec >= 180).forEach(r => lines.push(`${name(r)}: heart rate rose ${r.hrRise} bpm at steady power (cardiac drift) - think fuelling, fluids and cooling.`));
    const hrs = work.filter(r => r.hr);
    if (hrs.length >= 3 && hrs[hrs.length - 1].hr - hrs[0].hr >= 8) lines.push(`Heart rate on the hard steps climbed from ${hrs[0].hr} to ${hrs[hrs.length - 1].hr} bpm across the session.`);
    if (lines.length === 1 && locked.length === work.length) lines.push('No cadence fade or heart-rate drift worth noting - well paced.');
    return lines;
  }

  /** Compact prompt for the AI coach: the step table only (no raw samples), plain-text answer. */
  static breakdownPrompt(rows, meta = {}) {
    const head = 'step | interval | secs | target W | avg W | % of target | execution % | cadence | cadence fade (last-first third) | HR | HR rise';
    const table = rows.map(r => [r.n, r.iv ?? 'recovery/easy', r.sec, r.target || '-', r.avgP, r.pctOfTarget ?? '-', r.execution ?? '-', r.cadence ?? '-', r.cadFade ?? '-', r.hr ?? '-', r.hrRise ?? '-'].join(' | ')).join('\n');
    return [
      'You are a cycling coach reviewing an indoor ERG workout from its per-step data.',
      `Workout: ${meta.title || 'workout'}; FTP ${meta.ftp || '?'} W; duration ${meta.minutes || '?'} min${meta.avgHr ? `; avg HR ${meta.avgHr}` : ''}${meta.maxHr ? `; rider max HR ${meta.maxHr}` : ''}.`,
      'Per-step data (cadence fade and HR rise compare the first and last third of each step; "-" = not recorded):',
      head, table,
      'Write 3 to 6 short markdown bullet points: how the intervals (the hard steps, numbered in the interval column) were executed (group those on target),',
      'where cadence faded or heart rate drifted and what it likely means (fatigue, fuelling, heat, pacing),',
      'and one concrete suggestion for the next session. Only use the numbers above - never invent data. No preamble.'
    ].join('\n');
  }

  // ------------------------------------------------------------------- FTP --
  /**
   * What one ride says about FTP. Uses the best 20 min x 0.95 and the best 60 min x 1.00 (the
   * higher one). The 20 min effort must be steady (VI <= 1.05) to count. `hard` = heart rate shows
   * a near-maximal effort in that window (>= 90% of threshold HR, or >= 85% of max HR).
   */
  static ftpEvidence(samples, { maxHr = 0, lthr = 0 } = {}) {
    if (!Array.isArray(samples) || samples.length < 1200) return null;
    const p = samples.map(s => Number(s.power) || 0);
    const bestWindow = (len) => {
      let sum = 0, best = -1, at = 0;
      for (let i = 0; i < p.length; i++) {
        sum += p[i];
        if (i >= len) sum -= p[i - len];
        if (i >= len - 1 && sum > best) { best = sum; at = i - len + 1; }
      }
      return best < 0 ? null : { avg: best / len, at };
    };
    const w20 = bestWindow(1200);
    const seg = p.slice(w20.at, w20.at + 1200);
    const vi20 = (VeloMetrics.normalizedPower(seg) || w20.avg) / Math.max(1, w20.avg);
    const steady = vi20 <= 1.05;
    const hrs = samples.slice(w20.at, w20.at + 1200).map(s => Number(s.hr) || 0).filter(h => h > 0);
    const hrAvg = hrs.length >= 600 ? hrs.reduce((a, b) => a + b, 0) / hrs.length : 0;
    const hard = hrAvg > 0 && ((lthr > 0 && hrAvg >= 0.9 * lthr) || (maxHr > 0 && hrAvg >= 0.85 * maxHr));
    const from20 = steady ? Math.round(w20.avg * 0.95) : 0;
    const w60 = p.length >= 3600 ? bestWindow(3600) : null;
    const from60 = w60 ? Math.round(w60.avg) : 0;
    const estimate = Math.max(from20, from60);
    if (!estimate) return { estimate: 0, steady, hard, reason: 'not-steady', vi20: Math.round(vi20 * 100) / 100 };
    return {
      estimate, steady, hard,
      p20: Math.round(w20.avg), p60: w60 ? Math.round(w60.avg) : null,
      method: from60 >= from20 ? '60 min best' : '20 min best x 0.95',
      hrPct: hrAvg && maxHr ? Math.round((hrAvg / maxHr) * 100) : null,
      vi20: Math.round(vi20 * 100) / 100
    };
  }

  /**
   * Suggest a higher FTP? `rides`: [{ id, date, evidence }] newest last (rides with power samples).
   * The newest ride must show an estimate >= current FTP + 2% (and + 3 W). It is enough on its own
   * when the effort was steady AND heart rate shows it was hard; otherwise another ride in the
   * previous 21 days must also be above FTP + 1.5%, and the LOWER of the two is suggested.
   * A value the rider dismissed (or lower) is not suggested again.
   */
  static ftpSuggestion(rides, currentFtp, { dismissed = 0 } = {}) {
    const ftp = Number(currentFtp) || 0;
    if (!ftp || !rides || !rides.length) return null;
    const latest = rides[rides.length - 1];
    const ev = latest.evidence;
    const need = Math.max(ftp * 1.02, ftp + 3);
    if (!ev || !(ev.estimate >= need)) return null;
    let value = ev.estimate, confirmedBy = null, basis;
    if (ev.steady && ev.hard) {
      basis = 'one steady, hard effort (heart rate confirms it)';
    } else {
      const t = Date.parse(latest.date);
      const support = rides.slice(0, -1).filter(r => r.evidence && r.evidence.estimate >= ftp * 1.015 && t - Date.parse(r.date) <= 21 * VeloInsight.DAY && t > Date.parse(r.date));
      if (!support.length) return null;
      const best = support.reduce((a, b) => (b.evidence.estimate > a.evidence.estimate ? b : a));
      value = Math.min(value, best.evidence.estimate);
      confirmedBy = best.id;
      basis = 'two rides within 21 days agree';
    }
    value = Math.round(value);
    if (value < need || value <= (Number(dismissed) || 0)) return null;
    return { ftp: value, from: ftp, gain: value - ftp, method: ev.method, basis, rideId: latest.id, confirmedBy, p20: ev.p20, p60: ev.p60, hrPct: ev.hrPct };
  }
}

if (typeof window !== 'undefined') window.VeloInsight = VeloInsight;
