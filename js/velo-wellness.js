/**
 * APEX VELO // LAB - Health analytics: every daily wellness metric over time (pure, no DOM).
 *
 * Works on js/velo-health.js daily records. Apple Health days carry resting HR, HRV (SDNN) and sleep
 * with stages; intervals.icu days (the Android app) add sleeping HR, both HRV kinds, sleep and
 * readiness scores, Baevsky stress index, SpO2, respiration, weight, body fat, VO2max, steps, blood
 * pressure, glucose and calories. Every function skips a metric a day does not have, never guesses.
 *
 *   METRICS                     -> the catalogue: label, unit, decimals, which direction is better
 *   value(day, key)             -> one day's value or null
 *   points(days, key)           -> [{ t, day, v }] oldest first
 *   stats(days, key, today, n)  -> latest value, n-day average and the n days before, for the tiles
 *   normalBand(days, key)       -> rolling 60-day normal range (log mean +/- 0.5 SD), as readiness uses
 *   trailing(pts, n)            -> n-day trailing average at each point
 *   weekly(pts)                 -> weekly averages (Monday-start), for long ranges
 *   sleepMix(days, from, to)    -> average sleep and its stages over a period
 *   loadResponse(days, rides)   -> next-morning HRV, resting HR and sleep after rest, easy and hard days
 */
(function (root) {
  'use strict';

  const DAY = 86400000;
  const fin = (v) => typeof v === 'number' && Number.isFinite(v);
  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  const sd = (a) => {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1));
  };
  const tOf = (day) => new Date(day + 'T12:00:00').getTime();
  const addDays = (day, n) => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

  /** good: which direction is better ('up' | 'down' | null when neither is). fmt 'h' = hours as h:mm. */
  const METRICS = [
    { key: 'rhr', label: 'Resting HR', unit: 'bpm', dec: 0, good: 'down' },
    { key: 'sleepHr', label: 'Sleeping HR', unit: 'bpm', dec: 0, good: 'down' },
    { key: 'hrvRmssd', label: 'HRV · rMSSD', unit: 'ms', dec: 0, good: 'up' },
    { key: 'hrvSdnn', label: 'HRV · SDNN', unit: 'ms', dec: 0, good: 'up' },
    { key: 'sleepH', label: 'Sleep', unit: 'h', fmt: 'h', good: 'up' },
    { key: 'deepH', label: 'Deep sleep', unit: 'h', fmt: 'h', good: 'up' },
    { key: 'coreH', label: 'Light sleep', unit: 'h', fmt: 'h', good: null },
    { key: 'remH', label: 'REM sleep', unit: 'h', fmt: 'h', good: 'up' },
    { key: 'awakeH', label: 'Awake', unit: 'h', fmt: 'h', good: 'down' },
    { key: 'sleepScore', label: 'Sleep score', unit: '', dec: 0, good: 'up' },
    { key: 'icuReadiness', label: 'Readiness score', unit: '', dec: 0, good: 'up' },
    { key: 'baevsky', label: 'Stress index', unit: '', dec: 2, good: 'down' },
    { key: 'resp', label: 'Respiratory rate', unit: 'br/min', dec: 1, good: null },
    { key: 'spo2', label: 'Blood oxygen', unit: '%', dec: 1, good: 'up' },
    { key: 'weight', label: 'Weight', unit: 'kg', dec: 1, good: null },
    { key: 'bodyFat', label: 'Body fat', unit: '%', dec: 1, good: 'down' },
    { key: 'vo2max', label: 'VO2max', unit: 'ml/kg/min', dec: 1, good: 'up' },
    { key: 'steps', label: 'Steps', unit: '', dec: 0, good: 'up' },
    { key: 'bpSys', label: 'Systolic BP', unit: 'mmHg', dec: 0, good: 'down' },
    { key: 'bpDia', label: 'Diastolic BP', unit: 'mmHg', dec: 0, good: 'down' },
    { key: 'glucose', label: 'Blood glucose', unit: 'mmol/L', dec: 1, good: null },
    { key: 'kcalIn', label: 'Calories eaten', unit: 'kcal', dec: 0, good: null }
  ];
  const BY_KEY = {};
  METRICS.forEach(m => { BY_KEY[m.key] = m; });

  /**
   * One day's value. HRV: intervals.icu days carry both kinds (hrvRmssd, hrvSdnn); Apple Health days
   * have only `hrv`, which is the watch's SDNN.
   */
  function value(day, key) {
    if (!day) return null;
    let v = day[key];
    if (!fin(v) && key === 'hrvSdnn' && day.hrvSrc !== 'icu') v = day.hrv;
    return fin(v) ? v : null;
  }

  function points(days, key) {
    const out = [];
    for (const d of days || []) {
      const v = value(d, key);
      if (v !== null) out.push({ t: tOf(d.day), day: d.day, v });
    }
    return out;
  }

  /** Metrics with at least one value, in catalogue order. */
  function present(days) {
    return METRICS.filter(m => (days || []).some(d => value(d, m.key) !== null)).map(m => m.key);
  }

  /** For a tile: the latest value, the average of the last n days and of the n days before. */
  function stats(days, key, today, n = 30) {
    const pts = points(days, key);
    if (!pts.length) return null;
    const cut = addDays(today, -n), cut2 = addDays(today, -2 * n);
    const now = pts.filter(p => p.day > cut && p.day <= today).map(p => p.v);
    const prev = pts.filter(p => p.day > cut2 && p.day <= cut).map(p => p.v);
    const last = pts[pts.length - 1];
    return { last: last.v, lastDay: last.day, avg: mean(now), prev: mean(prev), n: now.length, nPrev: prev.length };
  }

  /** n-day trailing average at each point (by calendar days, so gaps do not stretch the window). */
  function trailing(pts, n = 7) {
    const out = [];
    let lo = 0, sum = 0;
    for (let hi = 0; hi < pts.length; hi++) {
      sum += pts[hi].v;
      while (pts[lo].t <= pts[hi].t - n * DAY) { sum -= pts[lo].v; lo++; }
      out.push({ t: pts[hi].t, v: sum / (hi - lo + 1) });
    }
    return out;
  }

  /**
   * Personal normal range at each day: the 60 days before it, on a log scale (HRV is skewed),
   * mean +/- 0.5 SD - the same band the readiness score compares the 7-day average with.
   * Needs 14 values in the window.
   */
  function normalBand(days, key, windowDays = 60, minN = 14) {
    const pts = points(days, key);
    const out = [];
    let lo = 0;
    for (let i = 0; i < pts.length; i++) {
      while (pts[lo].t < pts[i].t - windowDays * DAY) lo++;
      const win = pts.slice(lo, i).map(p => Math.log(p.v));
      if (win.length < minN) continue;
      const m = mean(win), s = sd(win);
      out.push({ t: pts[i].t, lo: Math.exp(m - 0.5 * s), hi: Math.exp(m + 0.5 * s), mid: Math.exp(m) });
    }
    return out;
  }

  /** Monday of the week a day falls in. */
  function weekOf(t) {
    const d = new Date(t);
    const back = (d.getDay() + 6) % 7;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back, 12).getTime();
  }

  /** Weekly averages: [{ t (Monday noon), v, n }]. */
  function weekly(pts) {
    const map = new Map();
    for (const p of pts) {
      const w = weekOf(p.t);
      const e = map.get(w) || { t: w, sum: 0, n: 0 };
      e.sum += p.v; e.n++;
      map.set(w, e);
    }
    return [...map.values()].sort((a, b) => a.t - b.t).map(e => ({ t: e.t, v: e.sum / e.n, n: e.n }));
  }

  /** Average sleep over [from, to] (day keys): total and each stage in hours, stage shares of sleep. */
  function sleepMix(days, from, to) {
    const nights = (days || []).filter(d => d.day >= from && d.day <= to && fin(d.sleepH));
    if (!nights.length) return null;
    const avg = (k) => { const v = nights.map(d => d[k]).filter(fin); return v.length ? mean(v) : null; };
    const staged = nights.filter(d => fin(d.deepH) || fin(d.remH) || fin(d.coreH));
    const out = { nights: nights.length, staged: staged.length, sleepH: avg('sleepH'), deepH: null, coreH: null, remH: null, awakeH: avg('awakeH') };
    if (staged.length) {
      const sAvg = (k) => mean(staged.map(d => (fin(d[k]) ? d[k] : 0)));
      out.deepH = sAvg('deepH'); out.coreH = sAvg('coreH'); out.remH = sAvg('remH');
      const tot = mean(staged.map(d => d.sleepH));
      out.share = tot > 0 ? { deep: out.deepH / tot, core: out.coreH / tot, rem: out.remH / tot } : null;
    }
    const sorted = nights.slice().sort((a, b) => a.sleepH - b.sleepH);
    out.shortest = { day: sorted[0].day, h: sorted[0].sleepH };
    out.longest = { day: sorted[sorted.length - 1].day, h: sorted[sorted.length - 1].sleepH };
    return out;
  }

  /** Training-load buckets for loadResponse: the day's total TSS. */
  const BUCKETS = [
    { key: 'rest', label: 'Rest day', test: (tss) => tss === 0 },
    { key: 'easy', label: 'Easy (under 50 TSS)', test: (tss) => tss > 0 && tss < 50 },
    { key: 'mid', label: 'Moderate (50-99 TSS)', test: (tss) => tss >= 50 && tss < 100 },
    { key: 'hard', label: 'Hard (100+ TSS)', test: (tss) => tss >= 100 }
  ];

  /**
   * How the body answers training: for every health day, the TSS ridden the day before (rides are
   * { day: 'YYYY-MM-DD', tss }), grouped into rest / easy / moderate / hard. Each group gets the average
   * next-morning HRV (`hrvKey`), resting HR and sleep, and its difference from the average of all
   * mornings in the period. Only days after the first ride count, so untracked time is not "rest".
   */
  function loadResponse(days, rides, { from = '0000', to = '9999', hrvKey = 'hrv' } = {}) {
    const tssByDay = new Map();
    let first = null;
    for (const r of rides || []) {
      if (!r || !r.day || !fin(r.tss)) continue;
      tssByDay.set(r.day, (tssByDay.get(r.day) || 0) + r.tss);
      if (!first || r.day < first) first = r.day;
    }
    if (!first) return null;
    const mornings = (days || []).filter(d => d.day >= from && d.day <= to && addDays(d.day, -1) >= first);
    if (!mornings.length) return null;
    const avgOf = (list, k) => { const v = list.map(d => value(d, k)).filter(x => x !== null); return v.length ? mean(v) : null; };
    const all = { hrv: avgOf(mornings, hrvKey), rhr: avgOf(mornings, 'rhr'), sleepH: avgOf(mornings, 'sleepH') };
    const groups = BUCKETS.map(b => {
      const list = mornings.filter(d => b.test(tssByDay.get(addDays(d.day, -1)) || 0));
      const g = { key: b.key, label: b.label, n: list.length, hrv: avgOf(list, hrvKey), rhr: avgOf(list, 'rhr'), sleepH: avgOf(list, 'sleepH') };
      g.dHrv = g.hrv !== null && all.hrv !== null ? g.hrv - all.hrv : null;
      g.dRhr = g.rhr !== null && all.rhr !== null ? g.rhr - all.rhr : null;
      g.dSleep = g.sleepH !== null && all.sleepH !== null ? g.sleepH - all.sleepH : null;
      return g;
    });
    return { all, groups, mornings: mornings.length };
  }

  /** A metric's value as text: hours as h:mm, others with the catalogue's decimals. */
  function fmt(key, v) {
    if (!fin(v)) return '--';
    const m = BY_KEY[key] || {};
    if (m.fmt === 'h') { const mins = Math.round(v * 60); return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`; }
    if (key === 'steps') return Math.round(v).toLocaleString('en-GB');
    return m.dec ? v.toFixed(m.dec) : String(Math.round(v));
  }

  const VeloWellness = { METRICS, BY_KEY, value, points, present, stats, trailing, normalBand, weekly, weekOf, sleepMix, loadResponse, BUCKETS, fmt, addDays };
  if (typeof module !== 'undefined' && module.exports) module.exports = VeloWellness;
  if (root) root.VeloWellness = VeloWellness;
})(typeof window !== 'undefined' ? window : null);
