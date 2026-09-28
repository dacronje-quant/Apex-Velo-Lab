/**
 * APEX VELO // LAB - Apple Health recovery data (resting HR, HRV, sleep) and daily readiness.
 *
 * Source: the Health Auto Export iPhone app, which POSTs JSON to the local server (/api/health).
 * The server stores payloads untouched; this module turns them into one record per day:
 *
 *   parsePayload(json)  -> readings found in one payload (heart rate, resting HR, HRV samples, sleep)
 *   merge(store, parsed)-> folds them into the stored days. Every reading is keyed by its own
 *                          timestamp (sleep by stage + start + end), so the same data sent twice,
 *                          or overlapping hourly exports, never counts twice.
 *   daily(store)        -> [{ day, rhr, hrv, sleepH, deepH, remH, coreH, awakeH }] oldest first
 *   readiness(days, day)-> green / amber / red from your own baselines, or "building baseline"
 *   dayFlags(days, day) -> per-metric colour for the calendar (ok / warn / bad vs your normal)
 *
 * Days are the phone's local calendar dates as Health Auto Export writes them. Sleep belongs to the
 * morning you wake up, and so do heart rate and HRV readings taken from 18:00 on.
 * Resting HR is the 5th percentile of heart rate while asleep (Apple's daily value when a night has
 * too few readings); HRV is the average of the readings taken asleep (all of that night's otherwise).
 * HRV is Apple's SDNN in ms (the watch does not record rMSSD).
 * Pure functions, no DOM: used by the app and by the Node tests.
 */
(function (root) {
  'use strict';

  const DAY_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/;
  const round1 = (v) => Math.round(v * 10) / 10;
  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  const sd = (a) => {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1));
  };

  /** "2026-09-27 06:41:00 +0200" or ISO -> { day, hour, key } using the phone's local date. */
  function stamp(v) {
    const m = DAY_RE.exec(String(v || '').trim());
    if (!m) return null;
    return { day: m[1], hour: Number(m[2]), key: String(v).trim() };
  }

  /** A date string one day later ("2026-09-30" -> "2026-10-01"). */
  function nextDay(day) {
    const d = new Date(day + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  function addDays(day, n) {
    const d = new Date(day + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  /** Sleep that ends in the evening (a nap before midnight) still belongs to that date; morning sleep to its date. */
  function nightOf(endStamp) {
    return endStamp.hour >= 18 ? nextDay(endStamp.day) : endStamp.day;
  }

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null));
  const hoursOf = (v, units) => {
    const n = num(v);
    if (n === null) return null;
    return /^min/i.test(units || '') ? n / 60 : /^s(ec)?$/i.test(units || '') ? n / 3600 : n;
  };

  /** Wall-clock minutes of a timestamp (the phone's local time; the offset is ignored so nights compare simply). */
  function wallMin(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(v || '').trim());
    return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) / 60000 : null;
  }

  // Resting HR is the night's floor: the 5th percentile of heart rate while asleep. One bad low
  // optical reading cannot set it (the minimum could), and REM / restless spells do not lift it
  // (the average would). Needs this many readings in the night, else Apple's daily value is used.
  const MIN_SLEEP_HR = 20;
  function percentile(a, p) {
    const s = a.slice().sort((x, y) => x - y);
    const i = (s.length - 1) * p, lo = Math.floor(i);
    return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo);
  }

  const METRIC = {
    heart_rate: 'hr',
    resting_heart_rate: 'rhr',
    heart_rate_variability: 'hrv',
    heart_rate_variability_sdnn: 'hrv',
    sleep_analysis: 'sleep'
  };

  /**
   * Reads one Health Auto Export payload ({ data: { metrics: [...] } }, older exports put metrics at the top).
   * Unknown metrics are listed in `ignored`, never guessed at.
   */
  function parsePayload(json) {
    const out = { rhr: [], hrv: [], hr: [], sleep: [], ignored: [] };
    const metrics = (json && json.data && Array.isArray(json.data.metrics) ? json.data.metrics : null) ||
      (json && Array.isArray(json.metrics) ? json.metrics : null) || [];
    for (const m of metrics) {
      const name = String((m && m.name) || '').toLowerCase();
      const kind = METRIC[name];
      const rows = Array.isArray(m && m.data) ? m.data : [];
      if (!kind) { if (name && out.ignored.indexOf(name) < 0) out.ignored.push(name); continue; }
      if (kind === 'rhr' || kind === 'hrv' || kind === 'hr') {
        for (const r of rows) {
          const st = stamp(r.date || r.startDate);
          const v = num(r.qty !== undefined ? r.qty : (r.Avg !== undefined ? r.Avg : r.avg));
          if (!st || v === null) continue;
          if (kind === 'rhr' && (v < 25 || v > 130)) continue;   // not a resting heart rate
          if (kind === 'hrv' && (v <= 0 || v > 300)) continue;   // not a plausible SDNN
          if (kind === 'hr' && (v < 25 || v > 230)) continue;    // not a heart rate
          // Heart rate is only needed overnight: 18:00-12:00, filed (like HRV) under the morning you wake up.
          if (kind === 'hr' && st.hour >= 12 && st.hour < 18) continue;
          out[kind].push({ day: kind === 'rhr' ? st.day : nightOf(st), key: st.key, v });
        }
      } else {
        for (const r of rows) {
          if (r.value !== undefined && (r.startDate || r.endDate)) {
            // Unaggregated: one row per sleep stage segment.
            const s0 = stamp(r.startDate), s1 = stamp(r.endDate);
            const h = hoursOf(r.qty, m.units);
            if (!s1 || h === null || h <= 0) continue;
            const stage = String(r.value).toLowerCase().replace(/\s+/g, '');
            out.sleep.push({ day: nightOf(s1), key: `seg|${stage}|${s0 ? s0.key : ''}|${s1.key}`, seg: { stage, h } });
          } else {
            // Aggregated: one row per night.
            const end = stamp(r.sleepEnd || r.inBedEnd) || stamp(r.date);
            if (!end) continue;
            const day = r.sleepEnd || r.inBedEnd ? nightOf(end) : end.day;
            const part = (k) => hoursOf(r[k], m.units);
            const core = part('core'), deep = part('deep'), rem = part('rem');
            const staged = [core, deep, rem].some(x => x !== null) ? (core || 0) + (deep || 0) + (rem || 0) : null;
            const total = part('totalSleep') !== null ? part('totalSleep') : part('asleep') !== null && part('asleep') > 0 ? part('asleep') : staged;
            if (total === null || total <= 0 || total > 20) continue;
            const endKey = r.sleepEnd || r.inBedEnd || null;
            const startKey = r.sleepStart || r.inBedStart || null;
            out.sleep.push({ day, key: `night|${day}|${r.source || r.sleepSource || ''}`, night: { total, deep, rem, core, awake: part('awake'), inBed: part('inBed'), start: startKey, end: endKey } });
          }
        }
      }
    }
    return out;
  }

  function emptyStore() { return { v: 1, days: {} }; }

  /** Folds parsed readings into the store. Returns how many new or changed readings it took. */
  function merge(store, parsed) {
    const st = store && store.days ? store : emptyStore();
    let added = 0;
    const dayRec = (d) => (st.days[d] = st.days[d] || {});
    const put = (bucket, key, val) => {
      const same = JSON.stringify(bucket[key]) === JSON.stringify(val);
      if (!same) { bucket[key] = val; added++; }
    };
    for (const r of parsed.rhr || []) { const d = dayRec(r.day); d.rhr = d.rhr || {}; put(d.rhr, r.key, r.v); }
    for (const r of parsed.hrv || []) { const d = dayRec(r.day); d.hrv = d.hrv || {}; put(d.hrv, r.key, r.v); }
    for (const r of parsed.hr || []) { const d = dayRec(r.day); d.hr = d.hr || {}; put(d.hr, r.key, r.v); }
    for (const r of parsed.sleep || []) {
      const d = dayRec(r.day);
      d.sleep = d.sleep || {};
      put(d.sleep, r.key, r.night ? { night: r.night } : { seg: r.seg });
    }
    return { store: st, added };
  }

  /** One derived record for a stored day. */
  function summarizeDay(day, rec) {
    const out = { day, rhr: null, hrv: null, sleepH: null, deepH: null, remH: null, coreH: null, awakeH: null };
    if (!rec) return out;
    if (rec.summary) return Object.assign(out, rec.summary, { day });
    const items = rec.sleep ? Object.values(rec.sleep) : [];
    const windows = sleepWindows(rec.sleep);
    const asleep = (key) => { const t = wallMin(key); return t !== null && windows.some(w => t >= w[0] && t <= w[1]); };
    const during = (bucket) => Object.entries(bucket || {}).filter(([k, v]) => Number.isFinite(v) && asleep(k)).map(([, v]) => v);

    // Resting HR: the floor of the night's heart rate; Apple's daily resting HR when the night has too few readings.
    const sleepHr = during(rec.hr);
    const rhr = rec.rhr ? Object.values(rec.rhr).filter(Number.isFinite) : [];
    if (sleepHr.length >= MIN_SLEEP_HR) { out.rhr = Math.round(percentile(sleepHr, 0.05)); out.rhrSrc = 'sleep'; }
    // Apple writes one resting HR per day; if an export holds a few, the lowest is the resting one.
    else if (rhr.length) { out.rhr = Math.round(Math.min.apply(null, rhr)); out.rhrSrc = 'apple'; }

    // HRV: the average of the readings taken asleep; every reading filed to that night when none were.
    const sleepHrv = during(rec.hrv);
    const hrv = sleepHrv.length ? sleepHrv : (rec.hrv ? Object.values(rec.hrv).filter(Number.isFinite) : []);
    if (hrv.length) { out.hrv = Math.round(mean(hrv)); out.hrvSrc = sleepHrv.length ? 'sleep' : 'day'; }

    const nights = items.filter(x => x.night).map(x => x.night);
    if (nights.length) {
      // Several sources for the same night (watch + phone): keep the longest, never add them up.
      const n = nights.reduce((a, b) => (b.total > a.total ? b : a));
      out.sleepH = round1(n.total);
      out.deepH = n.deep !== null && n.deep !== undefined ? round1(n.deep) : null;
      out.remH = n.rem !== null && n.rem !== undefined ? round1(n.rem) : null;
      out.coreH = n.core !== null && n.core !== undefined ? round1(n.core) : null;
      out.awakeH = n.awake !== null && n.awake !== undefined ? round1(n.awake) : null;
    } else {
      const segs = items.filter(x => x.seg).map(x => x.seg);
      if (segs.length) {
        const by = {};
        segs.forEach(s => { by[s.stage] = (by[s.stage] || 0) + s.h; });
        const staged = (by.core || 0) + (by.deep || 0) + (by.rem || 0);
        const asleep = staged > 0 ? staged : (by.asleep || by.asleepunspecified || 0);
        if (asleep > 0) out.sleepH = round1(asleep);
        if (by.deep) out.deepH = round1(by.deep);
        if (by.rem) out.remH = round1(by.rem);
        if (by.core) out.coreH = round1(by.core);
        if (by.awake) out.awakeH = round1(by.awake);
      }
    }
    return out;
  }

  /**
   * The night's asleep periods as [startMin, endMin] wall-clock minutes: the stage segments
   * (core / deep / REM / asleep; in-bed only when nothing else), else the per-night start-end.
   */
  function sleepWindows(bucket) {
    const segs = [], inBed = [], nights = [];
    for (const [k, x] of Object.entries(bucket || {})) {
      if (x && x.seg) {
        const p = k.split('|');   // seg|stage|start|end
        const a = wallMin(p[2]), b = wallMin(p[3]);
        if (b === null) continue;
        const w = [a !== null ? a : b - x.seg.h * 60, b];
        if (x.seg.stage === 'inbed') inBed.push(w); else if (x.seg.stage !== 'awake') segs.push(w);
      } else if (x && x.night && x.night.end) {
        const b = wallMin(x.night.end), a = wallMin(x.night.start);
        const len = x.night.inBed || (x.night.total || 0) + (x.night.awake || 0);
        if (b !== null) nights.push([a !== null ? a : b - len * 60, b]);
      }
    }
    return segs.length ? segs : inBed.length ? inBed : nights;
  }

  /** Every stored day with at least one value, oldest first. */
  function daily(store) {
    const days = store && store.days ? store.days : {};
    return Object.keys(days).sort().map(d => summarizeDay(d, days[d]))
      .filter(r => r.rhr !== null || r.hrv !== null || r.sleepH !== null);
  }

  /**
   * Keeps the store small: days older than `keepRawDays` keep only their derived values
   * (no more readings arrive for them in practice), and days older than `maxDays` are dropped.
   */
  function compact(store, today, keepRawDays = 7, maxDays = 800) {
    if (!store || !store.days) return store;
    const rawCut = addDays(today, -keepRawDays), dropCut = addDays(today, -maxDays);
    for (const d of Object.keys(store.days)) {
      if (d < dropCut) { delete store.days[d]; continue; }
      if (d < rawCut && !store.days[d].summary) {
        const s = summarizeDay(d, store.days[d]);
        delete s.day;
        store.days[d] = { summary: s };
      }
    }
    return store;
  }

  function byDay(days) { const m = {}; (days || []).forEach(r => { m[r.day] = r; }); return m; }

  /** Values of `field` on the days in [from, to] (inclusive). */
  function inRange(map, from, to, field) {
    const out = [];
    for (let d = from; d <= to; d = nextDay(d)) { const r = map[d]; if (r && r[field] !== null && r[field] !== undefined) out.push(r[field]); }
    return out;
  }

  /** Personal baselines ending the day before `day`. */
  function baselines(days, day) {
    const map = byDay(days);
    const prev = addDays(day, -1);
    const hrv60 = inRange(map, addDays(day, -60), prev, 'hrv').map(Math.log);
    const rhr30 = inRange(map, addDays(day, -30), prev, 'rhr');
    const sleep30 = inRange(map, addDays(day, -30), prev, 'sleepH');
    return {
      hrvLnMean: mean(hrv60), hrvLnSd: sd(hrv60), hrvN: hrv60.length,
      rhrMean: mean(rhr30), rhrN: rhr30.length,
      sleepMean: mean(sleep30), sleepN: sleep30.length
    };
  }

  const MIN_NIGHTS = 7;

  /**
   * Daily readiness from your own normal:
   *  - HRV: the 7-day average (log scale) against your 60-day normal range (mean +/- 0.5 SD);
   *         last night far below normal (more than 1.5 SD) counts too.
   *  - Resting HR: today against your 30-day average; +5 bpm is a flag, +8 a strong one.
   *  - Sleep: under 6 h (or 1.5 h under your average) is a flag, under 5 h a strong one.
   * 0 flags = green, 1-2 = amber, 3+ = red. Needs 7 nights of HRV first.
   */
  function readiness(days, today) {
    const map = byDay(days);
    let day = today;
    if (!map[day] || (map[day].hrv === null && map[day].rhr === null && map[day].sleepH === null)) day = addDays(today, -1);
    const rec = map[day];
    const b = baselines(days, day);
    const hrvNights = inRange(map, addDays(day, -60), day, 'hrv').length;
    const base = { day, nights: hrvNights, needed: MIN_NIGHTS, reasons: [], flags: 0, hrv: null, rhr: null, sleep: null };
    if (!rec) return Object.assign(base, { level: days && days.length ? 'stale' : 'none', label: days && days.length ? 'No recent data' : 'No Apple Health data' });
    if (hrvNights < MIN_NIGHTS || b.hrvN < MIN_NIGHTS - 1) {
      return Object.assign(base, { level: 'baseline', label: `Building baseline (${Math.min(hrvNights, MIN_NIGHTS)}/${MIN_NIGHTS} nights)` });
    }
    let flags = 0;
    const reasons = [];
    const hrv7 = inRange(map, addDays(day, -6), day, 'hrv').map(Math.log);
    if (hrv7.length && b.hrvLnMean !== null) {
      const avg7 = mean(hrv7);
      const low = b.hrvLnMean - 0.5 * b.hrvLnSd, high = b.hrvLnMean + 0.5 * b.hrvLnSd;
      base.hrv = { today: rec.hrv, avg7: Math.round(Math.exp(avg7)), normalLow: Math.round(Math.exp(low)), normalHigh: Math.round(Math.exp(high)), base: Math.round(Math.exp(b.hrvLnMean)) };
      if (avg7 < low) { flags++; reasons.push(`HRV 7-day average ${base.hrv.avg7} ms is below your normal (${base.hrv.normalLow}-${base.hrv.normalHigh} ms)`); }
      if (rec.hrv !== null && b.hrvLnSd > 0 && Math.log(rec.hrv) < b.hrvLnMean - 1.5 * b.hrvLnSd) { flags++; reasons.push(`Last night's HRV ${rec.hrv} ms is well below normal`); }
    }
    if (rec.rhr !== null && b.rhrMean !== null && b.rhrN >= 5) {
      const d = Math.round(rec.rhr - b.rhrMean);
      base.rhr = { today: rec.rhr, base: Math.round(b.rhrMean), delta: d };
      if (d >= 8) { flags += 2; reasons.push(`Resting HR ${rec.rhr} bpm is ${d} above your ${Math.round(b.rhrMean)} bpm average`); }
      else if (d >= 5) { flags++; reasons.push(`Resting HR ${rec.rhr} bpm is ${d} above your ${Math.round(b.rhrMean)} bpm average`); }
    }
    if (rec.sleepH !== null) {
      base.sleep = { last: rec.sleepH, avg: b.sleepMean !== null ? round1(b.sleepMean) : null };
      if (rec.sleepH < 5) { flags += 2; reasons.push(`Only ${fmtH(rec.sleepH)} of sleep`); }
      else if (rec.sleepH < 6 || (b.sleepMean !== null && b.sleepN >= 5 && rec.sleepH < b.sleepMean - 1.5)) { flags++; reasons.push(`Short sleep: ${fmtH(rec.sleepH)}${b.sleepMean !== null ? ` (average ${fmtH(b.sleepMean)})` : ''}`); }
    }
    const level = flags === 0 ? 'green' : flags <= 2 ? 'amber' : 'red';
    const label = level === 'green' ? 'Ready' : level === 'amber' ? 'Go easier' : 'Recover';
    const advice = level === 'green' ? 'Ready for threshold or VO2 work.'
      : level === 'amber' ? 'Keep it to tempo or endurance, or shorten the hard sets.'
        : 'Recovery spin in Z1-Z2 today.';
    return Object.assign(base, { level, label, advice, flags, reasons, stale: day !== today });
  }

  /** Calendar colours: each metric against your own normal on that day ('ok' | 'warn' | 'bad' | null). */
  function dayFlags(days, day) {
    const map = byDay(days);
    const rec = map[day];
    if (!rec) return null;
    const b = baselines(days, day);
    const out = { rhr: null, hrv: null, sleep: null };
    if (rec.rhr !== null && b.rhrN >= 5) { const d = rec.rhr - b.rhrMean; out.rhr = d >= 8 ? 'bad' : d >= 5 ? 'warn' : 'ok'; }
    if (rec.hrv !== null && b.hrvN >= 6 && b.hrvLnSd > 0) {
      const z = (Math.log(rec.hrv) - b.hrvLnMean) / b.hrvLnSd;
      out.hrv = z < -1.5 ? 'bad' : z < -0.5 ? 'warn' : 'ok';
    }
    if (rec.sleepH !== null) out.sleep = rec.sleepH < 5 ? 'bad' : (rec.sleepH < 6 || (b.sleepN >= 5 && rec.sleepH < b.sleepMean - 1.5)) ? 'warn' : 'ok';
    return out;
  }

  /** Averages over [from, to] for the calendar period summary. */
  function periodAverages(days, from, to) {
    const map = byDay(days);
    const avg = (f) => { const v = inRange(map, from, to, f); return v.length ? mean(v) : null; };
    const r = avg('rhr'), h = avg('hrv'), s = avg('sleepH');
    return { rhr: r !== null ? Math.round(r) : null, hrv: h !== null ? Math.round(h) : null, sleepH: s !== null ? round1(s) : null };
  }

  function fmtH(h) {
    if (h === null || h === undefined || !Number.isFinite(h)) return '--';
    const m = Math.round(h * 60);
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
  }

  const VeloHealth = { parsePayload, merge, daily, compact, readiness, dayFlags, periodAverages, baselines, emptyStore, fmtH, addDays, MIN_NIGHTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = VeloHealth;
  if (root) root.VeloHealth = VeloHealth;
})(typeof window !== 'undefined' ? window : null);
