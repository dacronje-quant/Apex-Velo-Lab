'use strict';
/**
 * Curated read-only SQLite query tools for AI coaching (/api/ask).
 *
 * Exposes 10 bounded, domain-verified tools over the 10 relational analytics tables
 * (ride_metrics, ride_samples, ride_laps, ride_mmp, strength_exercises,
 *  wellness_index, wellness_by_source, health_readings, health_sleep_sessions, health_metric_daily),
 * with adapters for Claude, Gemini, and OpenAI Responses API.
 */
const { DatabaseSync } = require('node:sqlite');
const VeloMetrics = require('../js/velo-metrics.js');
if (!globalThis.VeloMetrics) globalThis.VeloMetrics = VeloMetrics;
const VeloPower = require('../js/velo-power.js');
const RawHealth = require('./raw-health.cjs');

const MAX_RESULT_CHARS = 20000;
const SQL_MAX_ROWS = 100;
const SQL_MAX_CHARS = 16000;

const AI_TOOLS_PROMPT = [
  'DATABASE QUERY TOOLS:',
  'You also have read-only database tools backed by the rider\'s local SQLite analytics tables (all rides, 1 Hz FIT/cockpit/Strava telemetry, FIT laps & ERG workout steps, power-duration curves, Hevy strength exercises, full multi-source daily wellness, and raw timestamped Apple Health / Health Auto Export readings & sleep stages).',
  'The TRAINING DATA block covers the period selected in the UI at summary level. Whenever a question asks about specific rides, intervals/laps, pacing, cadence fade, HR drift/recovery, W\' matches, pedalling quadrants, elevation/temperature, strength lifts/weights, daily wellness (sleeping HR, SDNN/rMSSD HRV, Baevsky stress, readiness/sleep scores, respiratory rate, SpO2, weight, nutrition), raw 24h/overnight health readings, sleep stages, or dates outside the summary block, call the database tools instead of saying data is missing.',
  'Prefer get_ride_detail and compare_intervals before get_ride_segment; use get_wellness for daily/weekly wellness summaries and per-source comparisons, get_health_metrics for raw daily/weekly health metric rollups & discovery, and get_health_readings for overnight/24h timestamped readings or sleep-stage hypnograms.'
].join('\n');

const TOOL_DEFS = [
  {
    name: 'search_rides',
    description: 'Search and filter rides or non-cycling activities across the rider\'s full history using indexed SQL metrics.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start local date inclusive (YYYY-MM-DD).' },
        to: { type: 'string', description: 'End local date inclusive (YYYY-MM-DD).' },
        activity_type: { type: 'string', description: 'Filter by activity_type: ride, strength, run, walk, mobility, other, or all.' },
        indoor: { type: 'boolean', description: 'Filter cycling rides: true = indoor/trainer, false = outdoor.' },
        min_duration_min: { type: 'number', description: 'Minimum duration in minutes.' },
        min_tss: { type: 'number', description: 'Minimum cycling TSS.' },
        min_np: { type: 'number', description: 'Minimum Normalized Power (W).' },
        keyword: { type: 'string', description: 'Case-insensitive substring matched against title or description.' },
        sort_by: { type: 'string', enum: ['date_desc', 'date_asc', 'tss_desc', 'np_desc', 'duration_desc', 'ef_desc'], description: 'Sort order (default date_desc).' },
        limit: { type: 'integer', description: 'Maximum rows to return (1-50, default 20).' }
      }
    }
  },
  {
    name: 'get_ride_detail',
    description: 'Fetch full metrics for one ride (W\' depletion, matches, work above CP, quadrants, zones, decoupling, HR recovery, elevation, temperature, cycling dynamics), all its FIT laps / ERG steps / detected efforts, key MMP bests, and adjacent wellness & strength context.',
    parameters: {
      type: 'object',
      properties: {
        ride_id: { type: 'string', description: 'Exact ride_id if known.' },
        date: { type: 'string', description: 'Local date YYYY-MM-DD (used when ride_id is omitted).' },
        title_contains: { type: 'string', description: 'Optional substring to disambiguate when multiple rides share a date.' }
      }
    }
  },
  {
    name: 'get_ride_segment',
    description: 'Query time-bucketed telemetry from 1 Hz samples for any slice of a ride (power, target, HR, cadence, speed, altitude, grade, temperature, L/R balance, torque effectiveness, pedal smoothness).',
    parameters: {
      type: 'object',
      properties: {
        ride_id: { type: 'string', description: 'Exact ride_id.' },
        start_s: { type: 'integer', description: 'Start time in seconds from ride start (default 0).' },
        end_s: { type: 'integer', description: 'End time in seconds from ride start (default full ride).' },
        bucket_s: { type: 'integer', description: 'Aggregation bucket width in seconds (auto-chosen so <= 120 buckets are returned).' }
      },
      required: ['ride_id']
    }
  },
  {
    name: 'compare_intervals',
    description: 'Compare laps, ERG workout steps, or auto-detected hard efforts across rides in a date range (power, % target, execution %, HR rise, 60 s HR recovery, cadence fade, torque, grade).',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start local date inclusive (YYYY-MM-DD).' },
        to: { type: 'string', description: 'End local date inclusive (YYYY-MM-DD).' },
        kind: { type: 'string', enum: ['all', 'fit_lap', 'erg_step', 'auto_effort'], description: 'Segment source filter (default all).' },
        min_duration_s: { type: 'integer', description: 'Minimum interval duration in seconds.' },
        max_duration_s: { type: 'integer', description: 'Maximum interval duration in seconds.' },
        min_watts: { type: 'integer', description: 'Minimum interval average power (W).' },
        work_only: { type: 'boolean', description: 'If true, only return hard/work steps (>= 88% FTP).' },
        limit: { type: 'integer', description: 'Maximum rows to return (1-80, default 40).' }
      }
    }
  },
  {
    name: 'get_power_curve',
    description: 'Compute the mean-maximal power curve (best efforts from 1 s to 4 h with ride dates) and fit Critical Power (CP), W\', and Pmax for a date range, optionally compared against an earlier period.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start local date inclusive (YYYY-MM-DD).' },
        to: { type: 'string', description: 'End local date inclusive (YYYY-MM-DD).' },
        compare_from: { type: 'string', description: 'Optional comparison start date (YYYY-MM-DD).' },
        compare_to: { type: 'string', description: 'Optional comparison end date (YYYY-MM-DD).' }
      }
    }
  },
  {
    name: 'get_wellness',
    description: 'Get daily or weekly recovery metrics (resting HR, sleeping HR, HRV SDNN & rMSSD, sleep hours & stages, bed/wake times, sleep & readiness scores, Baevsky stress index, respiratory rate, SpO2, weight, BP, glucose, calories eaten) joined with daily cycling TSS and strength load.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start local date inclusive (YYYY-MM-DD).' },
        to: { type: 'string', description: 'End local date inclusive (YYYY-MM-DD).' },
        group_by: { type: 'string', enum: ['day', 'week'], description: 'Return daily rows or Monday-start weekly averages (default day).' },
        include_sources: { type: 'boolean', description: 'If true on daily mode, also include unmerged per-source rows (apple, icu, healthconnect) from wellness_by_source.' }
      }
    }
  },
  {
    name: 'get_health_metrics',
    description: 'List all stored raw health metrics (from Apple Health / Health Auto Export) with date ranges and sample counts, or query daily/weekly rollups (count, sum, avg, min, max, 10th percentile, last value) for a metric such as heart_rate, heart_rate_variability, step_count, active_energy, apple_sleeping_wrist_temperature, vo2_max, or weight_body_mass.',
    parameters: {
      type: 'object',
      properties: {
        metric: { type: 'string', description: 'Canonical metric name (e.g. "heart_rate", "heart_rate_variability", "step_count"). Omit to list all available raw metrics.' },
        from: { type: 'string', description: 'Start local date inclusive (YYYY-MM-DD).' },
        to: { type: 'string', description: 'End local date inclusive (YYYY-MM-DD).' },
        group_by: { type: 'string', enum: ['day', 'week'], description: 'Return daily rollups or Monday-start weekly rollups (default day).' },
        limit: { type: 'integer', description: 'Maximum rows to return (1-180, default 90).' }
      }
    }
  },
  {
    name: 'get_health_readings',
    description: 'Query raw timestamped health readings (individual overnight/24h HR, HRV, RHR, wrist temp, etc.) or time-bucketed averages, plus sleep sessions & stage hypnograms.',
    parameters: {
      type: 'object',
      properties: {
        metric: { type: 'string', description: 'Metric name (e.g. "heart_rate", "heart_rate_variability", "resting_heart_rate", or "sleep"). Defaults to "heart_rate".' },
        date: { type: 'string', description: 'Single date (YYYY-MM-DD) for detailed timestamped readings and sleep stages.' },
        from: { type: 'string', description: 'Start date inclusive (YYYY-MM-DD) when querying a range.' },
        to: { type: 'string', description: 'End date inclusive (YYYY-MM-DD) when querying a range.' },
        by_night: { type: 'boolean', description: 'If true, filter by overnight wake-up night_day (18:00 prev day to 18:00) instead of calendar local_day.' },
        bucket_min: { type: 'integer', description: 'Optional aggregation window in minutes (1-1440). Auto-applied if raw samples exceed limit.' },
        include_sleep: { type: 'boolean', description: 'Include sleep nights & stages from health_sleep_sessions (default true when date or metric="sleep" is given).' },
        limit: { type: 'integer', description: 'Maximum readings/buckets to return (1-300, default 200).' }
      }
    }
  },
  {
    name: 'get_strength_history',
    description: 'Query Hevy / strength sessions and individual exercises (sets, max weight kg, reps, RPE, estimated volume kg, heavy leg day flags).',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start local date inclusive (YYYY-MM-DD).' },
        to: { type: 'string', description: 'End local date inclusive (YYYY-MM-DD).' },
        exercise: { type: 'string', description: 'Case-insensitive substring of exercise name (e.g. "squat", "deadlift", "bench").' },
        leg_only: { type: 'boolean', description: 'If true, only return lower-body/heavy-leg exercises.' },
        limit: { type: 'integer', description: 'Maximum rows to return (1-80, default 40).' }
      }
    }
  },
  {
    name: 'run_readonly_sql',
    description: 'Run a custom read-only SQL SELECT/WITH query over the 10 analytics tables (ride_metrics, ride_samples, ride_laps, ride_mmp, strength_exercises, wellness_index, wellness_by_source, health_readings, health_sleep_sessions, health_metric_daily). Capped at 100 rows.',
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'Single read-only SELECT or WITH query referencing only the 10 analytics tables.' }
      },
      required: ['sql']
    }
  }
];

function claudeTools() {
  return TOOL_DEFS.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}
function geminiTools() {
  return [{ functionDeclarations: TOOL_DEFS.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
}
function openaiTools() {
  return TOOL_DEFS.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
}

const clampInt = (v, lo, hi, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.trunc(n))) : def;
};
const dayFilter = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null);

function handleSearchRides(db, args = {}) {
  const where = [];
  const params = [];
  const from = dayFilter(args.from), to = dayFilter(args.to);
  if (from) { where.push('local_day >= ?'); params.push(from); }
  if (to) { where.push('local_day <= ?'); params.push(to); }
  if (args.activity_type && args.activity_type !== 'all') { where.push('activity_type = ?'); params.push(String(args.activity_type)); }
  if (typeof args.indoor === 'boolean') { where.push('indoor = ?'); params.push(args.indoor ? 1 : 0); }
  if (Number.isFinite(Number(args.min_duration_min))) { where.push('duration_s >= ?'); params.push(Math.round(Number(args.min_duration_min) * 60)); }
  if (Number.isFinite(Number(args.min_tss))) { where.push('tss >= ?'); params.push(Number(args.min_tss)); }
  if (Number.isFinite(Number(args.min_np))) { where.push('np >= ?'); params.push(Number(args.min_np)); }
  if (typeof args.keyword === 'string' && args.keyword.trim()) {
    where.push('(LOWER(title) LIKE ? OR LOWER(COALESCE(description, \'\')) LIKE ?)');
    const pat = `%${args.keyword.trim().toLowerCase()}%`;
    params.push(pat, pat);
  }
  const orderMap = {
    date_desc: 'started_ms DESC',
    date_asc: 'started_ms ASC',
    tss_desc: 'COALESCE(tss, 0) DESC, started_ms DESC',
    np_desc: 'COALESCE(np, 0) DESC, started_ms DESC',
    duration_desc: 'duration_s DESC, started_ms DESC',
    ef_desc: 'COALESCE(ef, 0) DESC, started_ms DESC'
  };
  const orderBy = orderMap[args.sort_by] || orderMap.date_desc;
  const limit = clampInt(args.limit, 1, 50, 20);
  const wSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM ride_metrics ${wSql}`).get(...params).n;
  const rows = db.prepare(`
    SELECT ride_id, local_day, title, source, activity_type, sport_type, indoor,
           ROUND(duration_s / 60.0, 1) AS duration_min, ROUND(COALESCE(distance_m, 0) / 1000.0, 2) AS distance_km,
           elevation_gain_m, avg_watts, max_watts, np, intensity_factor, tss, strength_tss, kj,
           avg_hr, max_hr, avg_cadence, left_bal, avg_temp_c, vi, ef, decoupling_pct, trimp,
           matches, wbal_max_depletion_pct, compliance_pct, heavy_legs, sample_count, lap_count
    FROM ride_metrics ${wSql}
    ORDER BY ${orderBy}
    LIMIT ?
  `).all(...params, limit);
  return { totalMatches: total, returned: rows.length, rides: rows };
}

function handleGetRideDetail(db, args = {}) {
  let ride = null;
  if (typeof args.ride_id === 'string' && args.ride_id.trim()) {
    ride = db.prepare('SELECT * FROM ride_metrics WHERE ride_id = ?').get(args.ride_id.trim());
  } else {
    const where = [];
    const params = [];
    const d = dayFilter(args.date);
    if (d) { where.push('local_day = ?'); params.push(d); }
    if (typeof args.title_contains === 'string' && args.title_contains.trim()) {
      where.push('LOWER(title) LIKE ?');
      params.push(`%${args.title_contains.trim().toLowerCase()}%`);
    }
    if (!where.length) return { error: 'Provide ride_id or date.' };
    ride = db.prepare(`SELECT * FROM ride_metrics WHERE ${where.join(' AND ')} ORDER BY started_ms DESC LIMIT 1`).get(...params);
  }
  if (!ride) return { error: 'Ride not found.' };

  const laps = db.prepare(`
    SELECT kind, lap_idx, start_s, duration_s, is_work, target_w, avg_w, max_w, np,
           pct_target, execution_pct, avg_hr, max_hr, hr_rise, hr_rec_60s,
           avg_cadence, cad_fade, avg_torque_nm, left_bal, distance_m, ascent_m, avg_grade_pct, trigger
    FROM ride_laps WHERE ride_id = ? ORDER BY kind, lap_idx
  `).all(ride.ride_id);

  const mmpRows = db.prepare('SELECT duration_s, watts FROM ride_mmp WHERE ride_id = ? ORDER BY duration_s').all(ride.ride_id);
  const mmp = {};
  for (const m of mmpRows) mmp[VeloPower.durLabel(m.duration_s)] = m.watts;

  const strength = ride.activity_type === 'strength'
    ? db.prepare('SELECT ex_idx, exercise_name, raw_line, sets_count, max_weight_kg, max_reps, max_rpe, est_volume_kg, is_leg FROM strength_exercises WHERE ride_id = ? ORDER BY ex_idx').all(ride.ride_id)
    : [];

  const wellness = db.prepare(`
    SELECT day, rhr, sleep_hr, rhr_src, hrv, hrv_kind, hrv_src, hrv_rmssd, hrv_sdnn,
           sleep_h, deep_h, rem_h, core_h, awake_h, bed_min, wake_min,
           sleep_score, icu_readiness, baevsky, resp, spo2, weight_kg, bp_sys, bp_dia, glucose, kcal_in, source
    FROM wellness_index
    WHERE day >= date(?, '-1 day') AND day <= date(?, '+1 day')
    ORDER BY day
  `).all(ride.local_day, ride.local_day);

  const nearbyStrength = db.prepare(`
    SELECT ride_id, local_day, title, strength_tss, heavy_legs, strength_volume_kg
    FROM ride_metrics
    WHERE activity_type = 'strength' AND local_day >= date(?, '-2 day') AND local_day <= ?
    ORDER BY started_ms DESC
  `).all(ride.local_day, ride.local_day);

  const { index_hash: _ih, samples_hash: _sh, ...cleanRide } = ride;
  return { ride: cleanRide, laps, mmp, ...(strength.length ? { strengthExercises: strength } : {}), nearbyWellness: wellness, nearbyStrength };
}

function handleGetRideSegment(db, args = {}) {
  const id = typeof args.ride_id === 'string' ? args.ride_id.trim() : '';
  if (!id) return { error: 'ride_id is required.' };
  const bounds = db.prepare('SELECT MIN(t_s) AS min_t, MAX(t_s) AS max_t, COUNT(*) AS n FROM ride_samples WHERE ride_id = ?').get(id);
  if (!bounds || !bounds.n) return { error: 'No 1 Hz samples stored for this ride.' };

  const startS = Number.isFinite(Number(args.start_s)) ? Math.max(bounds.min_t, Math.trunc(Number(args.start_s))) : bounds.min_t;
  const endS = Number.isFinite(Number(args.end_s)) ? Math.min(bounds.max_t, Math.trunc(Number(args.end_s))) : bounds.max_t;
  if (endS < startS) return { error: 'end_s must be >= start_s.' };

  const span = Math.max(1, endS - startS + 1);
  let bucketS = clampInt(args.bucket_s, 1, 3600, 0);
  if (!bucketS) bucketS = Math.max(1, Math.ceil(span / 80));
  else if (Math.ceil(span / bucketS) > 120) bucketS = Math.ceil(span / 120);

  const buckets = db.prepare(`
    SELECT
      CAST((t_s - ?) / ? AS INTEGER) AS bucket_idx,
      MIN(t_s) AS from_s,
      MAX(t_s) AS to_s,
      COUNT(*) AS samples,
      ROUND(AVG(power)) AS avg_power,
      MAX(power) AS max_power,
      ROUND(AVG(NULLIF(target_power, 0))) AS avg_target_w,
      ROUND(AVG(NULLIF(hr, 0))) AS avg_hr,
      MAX(NULLIF(hr, 0)) AS max_hr,
      ROUND(AVG(NULLIF(cadence, 0))) AS avg_cadence,
      ROUND(AVG(speed_kmh), 1) AS avg_speed_kmh,
      ROUND(AVG(alt_m), 1) AS avg_alt_m,
      ROUND(AVG(grade_pct), 1) AS avg_grade_pct,
      ROUND(AVG(temp_c), 1) AS avg_temp_c,
      ROUND(AVG(left_bal), 1) AS avg_left_bal,
      ROUND(AVG(left_te), 1) AS avg_left_te,
      ROUND(AVG(right_te), 1) AS avg_right_te,
      ROUND(AVG(left_ps), 1) AS avg_left_ps,
      ROUND(AVG(right_ps), 1) AS avg_right_ps
    FROM ride_samples
    WHERE ride_id = ? AND t_s >= ? AND t_s <= ?
    GROUP BY bucket_idx
    ORDER BY bucket_idx
    LIMIT 120
  `).all(startS, bucketS, id, startS, endS);

  return { ride_id: id, start_s: startS, end_s: endS, bucket_s: bucketS, bucketCount: buckets.length, buckets };
}

function handleCompareIntervals(db, args = {}) {
  const where = ['1=1'];
  const params = [];
  const from = dayFilter(args.from), to = dayFilter(args.to);
  if (from) { where.push('r.local_day >= ?'); params.push(from); }
  if (to) { where.push('r.local_day <= ?'); params.push(to); }
  if (args.kind && args.kind !== 'all') { where.push('l.kind = ?'); params.push(String(args.kind)); }
  if (Number.isFinite(Number(args.min_duration_s))) { where.push('l.duration_s >= ?'); params.push(Math.trunc(Number(args.min_duration_s))); }
  if (Number.isFinite(Number(args.max_duration_s))) { where.push('l.duration_s <= ?'); params.push(Math.trunc(Number(args.max_duration_s))); }
  if (Number.isFinite(Number(args.min_watts))) { where.push('l.avg_w >= ?'); params.push(Math.trunc(Number(args.min_watts))); }
  if (args.work_only === true) where.push('l.is_work = 1');

  const limit = clampInt(args.limit, 1, 80, 40);
  const rows = db.prepare(`
    SELECT l.ride_id, r.local_day, r.title, l.kind, l.lap_idx, l.start_s, l.duration_s, l.is_work,
           l.target_w, l.avg_w, l.max_w, l.np, l.pct_target, l.execution_pct,
           l.avg_hr, l.max_hr, l.hr_rise, l.hr_rec_60s, l.avg_cadence, l.cad_fade, l.avg_torque_nm, l.avg_grade_pct
    FROM ride_laps l
    JOIN ride_metrics r ON r.ride_id = l.ride_id
    WHERE ${where.join(' AND ')}
    ORDER BY r.started_ms DESC, l.lap_idx ASC
    LIMIT ?
  `).all(...params, limit);
  return { count: rows.length, intervals: rows };
}

function powerCurveForRange(db, from, to) {
  const where = ["r.activity_type = 'ride'"];
  const params = [];
  if (from) { where.push('r.local_day >= ?'); params.push(from); }
  if (to) { where.push('r.local_day <= ?'); params.push(to); }
  const rows = db.prepare(`
    SELECT m.duration_s, m.watts, m.ride_id, r.local_day, r.title
    FROM ride_mmp m
    JOIN ride_metrics r ON r.ride_id = m.ride_id
    WHERE ${where.join(' AND ')}
    ORDER BY m.duration_s ASC, m.watts DESC, r.started_ms DESC
  `).all(...params);

  const bestByDur = new Map();
  for (const row of rows) {
    if (!bestByDur.has(row.duration_s)) bestByDur.set(row.duration_s, row);
  }
  const curve = VeloPower.GRID.map(d => (bestByDur.has(d) ? bestByDur.get(d).watts : null));
  const model = VeloPower.fitModel(curve);
  const points = VeloPower.GRID.map((d, i) => {
    const r = bestByDur.get(d);
    return r ? { duration_s: d, label: VeloPower.durLabel(d), watts: curve[i], ride_id: r.ride_id, date: r.local_day, title: r.title } : null;
  }).filter(Boolean);
  return { model: model && model.ok ? model : { ok: false, reason: model ? model.reason : 'no-data' }, points, curve };
}

function handleGetPowerCurve(db, args = {}) {
  const from = dayFilter(args.from), to = dayFilter(args.to);
  const main = powerCurveForRange(db, from, to);
  const out = { from, to, cpModel: main.model, bests: main.points };
  const cFrom = dayFilter(args.compare_from), cTo = dayFilter(args.compare_to);
  if (cFrom || cTo) {
    const cmp = powerCurveForRange(db, cFrom, cTo);
    const cmpMap = new Map(cmp.points.map(p => [p.duration_s, p.watts]));
    out.comparison = {
      from: cFrom, to: cTo, cpModel: cmp.model,
      deltas: main.points.map(p => ({
        duration_s: p.duration_s, label: p.label, current_w: p.watts,
        previous_w: cmpMap.get(p.duration_s) ?? null,
        delta_w: cmpMap.has(p.duration_s) ? p.watts - cmpMap.get(p.duration_s) : null
      }))
    };
  }
  return out;
}

function handleGetWellness(db, args = {}) {
  const where = ['1=1'];
  const params = [];
  const from = dayFilter(args.from), to = dayFilter(args.to);
  if (from) { where.push('w.day >= ?'); params.push(from); }
  if (to) { where.push('w.day <= ?'); params.push(to); }

  const rows = db.prepare(`
    SELECT w.day, w.rhr, w.sleep_hr, w.rhr_src, w.hrv, w.hrv_kind, w.hrv_src, w.hrv_rmssd, w.hrv_sdnn,
      w.sleep_h, w.deep_h, w.rem_h, w.core_h, w.awake_h, w.bed_min, w.wake_min,
      w.sleep_score, w.icu_readiness, w.baevsky, w.resp, w.spo2, w.weight_kg, w.bp_sys, w.bp_dia, w.glucose, w.kcal_in, w.source,
      COALESCE((SELECT ROUND(SUM(COALESCE(r.tss, 0)), 1) FROM ride_metrics r WHERE r.local_day = w.day AND r.activity_type = 'ride'), 0) AS cycling_tss,
      COALESCE((SELECT ROUND(SUM(COALESCE(r.strength_tss, 0)), 1) FROM ride_metrics r WHERE r.local_day = w.day AND r.activity_type = 'strength'), 0) AS strength_tss,
      COALESCE((SELECT MAX(r.heavy_legs) FROM ride_metrics r WHERE r.local_day = w.day AND r.activity_type = 'strength'), 0) AS heavy_legs
    FROM wellness_index w
    WHERE ${where.join(' AND ')}
    ORDER BY w.day DESC
    LIMIT 180
  `).all(...params);

  if (args.group_by === 'week') {
    const weeks = new Map();
    const pushIf = (arr, v) => { if (v !== null && v !== undefined && Number.isFinite(Number(v))) arr.push(Number(v)); };
    for (const r of rows) {
      const dt = new Date(`${r.day}T12:00:00Z`);
      const mon = new Date(dt); mon.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
      const wk = mon.toISOString().slice(0, 10);
      let g = weeks.get(wk);
      if (!g) {
        g = {
          week: wk, days: 0, rhrs: [], sleepHrs: [], hrvs: [], rmssds: [], sdnns: [],
          sleeps: [], deeps: [], rems: [], scores: [], readiness: [], baevskys: [],
          resps: [], spo2s: [], weights: [], cycling_tss: 0, strength_tss: 0
        };
        weeks.set(wk, g);
      }
      g.days++;
      pushIf(g.rhrs, r.rhr);
      pushIf(g.sleepHrs, r.sleep_hr);
      pushIf(g.hrvs, r.hrv);
      pushIf(g.rmssds, r.hrv_rmssd);
      pushIf(g.sdnns, r.hrv_sdnn);
      pushIf(g.sleeps, r.sleep_h);
      pushIf(g.deeps, r.deep_h);
      pushIf(g.rems, r.rem_h);
      pushIf(g.scores, r.sleep_score);
      pushIf(g.readiness, r.icu_readiness);
      pushIf(g.baevskys, r.baevsky);
      pushIf(g.resps, r.resp);
      pushIf(g.spo2s, r.spo2);
      pushIf(g.weights, r.weight_kg);
      g.cycling_tss += r.cycling_tss || 0;
      g.strength_tss += r.strength_tss || 0;
    }
    const avg = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null);
    return {
      group_by: 'week',
      weeks: [...weeks.values()].sort((a, b) => b.week.localeCompare(a.week)).map(g => ({
        week: g.week, days: g.days, avg_rhr: avg(g.rhrs), avg_sleep_hr: avg(g.sleepHrs),
        avg_hrv: avg(g.hrvs), avg_hrv_rmssd: avg(g.rmssds), avg_hrv_sdnn: avg(g.sdnns),
        avg_sleep_h: avg(g.sleeps), avg_deep_h: avg(g.deeps), avg_rem_h: avg(g.rems),
        avg_sleep_score: avg(g.scores), avg_icu_readiness: avg(g.readiness), avg_baevsky: avg(g.baevskys),
        avg_resp: avg(g.resps), avg_spo2: avg(g.spo2s), avg_weight_kg: avg(g.weights),
        cycling_tss: Math.round(g.cycling_tss), strength_tss: Math.round(g.strength_tss)
      }))
    };
  }
  const out = { group_by: 'day', count: rows.length, days: rows };
  if (args.include_sources === true) {
    const sWhere = ['1=1'];
    const sParams = [];
    if (from) { sWhere.push('day >= ?'); sParams.push(from); }
    if (to) { sWhere.push('day <= ?'); sParams.push(to); }
    out.sources = db.prepare(`
      SELECT day, source, rhr, sleep_hr, rhr_src, hrv, hrv_kind, hrv_src, hrv_rmssd, hrv_sdnn,
             sleep_h, deep_h, rem_h, core_h, awake_h, bed_min, wake_min,
             sleep_score, icu_readiness, baevsky, resp, spo2, weight_kg, bp_sys, bp_dia, glucose, kcal_in
      FROM wellness_by_source
      WHERE ${sWhere.join(' AND ')}
      ORDER BY day DESC, source ASC
      LIMIT 360
    `).all(...sParams);
  }
  return out;
}

function resolveHealthMetric(db, rawMetric) {
  const norm = RawHealth.normalizeMetricName(rawMetric) || String(rawMetric || '').trim().toLowerCase();
  if (!norm) return null;
  const exact = db.prepare('SELECT metric FROM health_metric_daily WHERE LOWER(metric) = ? LIMIT 1').get(norm);
  if (exact) return exact.metric;
  const exactRead = db.prepare('SELECT metric FROM health_readings WHERE LOWER(metric) = ? LIMIT 1').get(norm);
  if (exactRead) return exactRead.metric;
  const partial = db.prepare('SELECT metric FROM health_metric_daily WHERE LOWER(metric) LIKE ? ORDER BY LENGTH(metric) ASC LIMIT 1').get(`%${norm}%`);
  if (partial) return partial.metric;
  const partialRead = db.prepare('SELECT metric FROM health_readings WHERE LOWER(metric) LIKE ? ORDER BY LENGTH(metric) ASC LIMIT 1').get(`%${norm}%`);
  return partialRead ? partialRead.metric : norm;
}

function handleGetHealthMetrics(db, args = {}) {
  const from = dayFilter(args.from), to = dayFilter(args.to);
  if (!args.metric || !String(args.metric).trim()) {
    const where = ['1=1'];
    const params = [];
    if (from) { where.push('day >= ?'); params.push(from); }
    if (to) { where.push('day <= ?'); params.push(to); }
    const metrics = db.prepare(`
      SELECT metric, MAX(unit) AS unit, COUNT(*) AS days, SUM(sample_count) AS total_samples,
             MIN(day) AS first_day, MAX(day) AS last_day,
             ROUND(AVG(val_avg), 2) AS avg_val, ROUND(MIN(val_min), 2) AS min_val, ROUND(MAX(val_max), 2) AS max_val
      FROM health_metric_daily
      WHERE ${where.join(' AND ')}
      GROUP BY metric
      ORDER BY total_samples DESC, metric ASC
    `).all(...params);

    const sWhere = ['1=1'];
    const sParams = [];
    if (from) { sWhere.push('night_day >= ?'); sParams.push(from); }
    if (to) { sWhere.push('night_day <= ?'); sParams.push(to); }
    const sleepSummary = db.prepare(`
      SELECT
        SUM(CASE WHEN kind = 'night' THEN 1 ELSE 0 END) AS night_count,
        SUM(CASE WHEN kind = 'stage' THEN 1 ELSE 0 END) AS stage_count,
        MIN(night_day) AS first_night,
        MAX(night_day) AS last_night
      FROM health_sleep_sessions
      WHERE ${sWhere.join(' AND ')}
    `).get(...sParams);
    return { count: metrics.length, metrics, sleepSummary };
  }

  const metric = resolveHealthMetric(db, args.metric);
  const where = ['metric = ?'];
  const params = [metric];
  if (from) { where.push('day >= ?'); params.push(from); }
  if (to) { where.push('day <= ?'); params.push(to); }
  const limit = clampInt(args.limit, 1, 180, 90);
  const rows = db.prepare(`
    SELECT day, sample_count, val_sum, val_avg, val_min, val_max, val_p10, val_last, unit
    FROM health_metric_daily
    WHERE ${where.join(' AND ')}
    ORDER BY day DESC
    LIMIT ?
  `).all(...params, limit);

  const unit = (rows.find(r => r.unit) || {}).unit || '';
  if (args.group_by === 'week') {
    const weeks = new Map();
    for (const r of rows) {
      const dt = new Date(`${r.day}T12:00:00Z`);
      const mon = new Date(dt); mon.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
      const wk = mon.toISOString().slice(0, 10);
      let g = weeks.get(wk);
      if (!g) { g = { week: wk, days: 0, samples: 0, sumTotal: 0, avgs: [], mins: [], maxs: [] }; weeks.set(wk, g); }
      g.days++;
      g.samples += r.sample_count || 0;
      if (r.val_sum !== null) g.sumTotal += r.val_sum;
      if (r.val_avg !== null) g.avgs.push(r.val_avg);
      if (r.val_min !== null) g.mins.push(r.val_min);
      if (r.val_max !== null) g.maxs.push(r.val_max);
    }
    const r2 = (x) => Math.round(x * 100) / 100;
    const mean = (a) => (a.length ? r2(a.reduce((s, v) => s + v, 0) / a.length) : null);
    return {
      metric,
      unit,
      group_by: 'week',
      weeks: [...weeks.values()].sort((a, b) => b.week.localeCompare(a.week)).map(g => ({
        week: g.week,
        days: g.days,
        samples: g.samples,
        sum_val: r2(g.sumTotal),
        avg_val: mean(g.avgs),
        min_val: g.mins.length ? Math.min(...g.mins) : null,
        max_val: g.maxs.length ? Math.max(...g.maxs) : null
      }))
    };
  }
  return { metric, unit, group_by: 'day', count: rows.length, days: rows };
}

function handleGetHealthReadings(db, args = {}) {
  const metricArg = String(args.metric || '').trim().toLowerCase();
  const sleepOnly = metricArg === 'sleep' || metricArg === 'sleep_analysis';
  const d = dayFilter(args.date);
  const from = dayFilter(args.from), to = dayFilter(args.to);
  const byNight = args.by_night === true;
  const limit = clampInt(args.limit, 1, 300, 200);
  const includeSleep = args.include_sleep === true || (args.include_sleep !== false && (Boolean(d) || sleepOnly));

  let out = {};
  if (!sleepOnly) {
    const metric = resolveHealthMetric(db, args.metric || 'heart_rate');
    const col = byNight ? 'night_day' : 'local_day';
    const where = ['metric = ?'];
    const params = [metric];
    if (d) { where.push(`${col} = ?`); params.push(d); }
    else {
      if (from) { where.push(`${col} >= ?`); params.push(from); }
      if (to) { where.push(`${col} <= ?`); params.push(to); }
    }
    const wSql = where.join(' AND ');
    const bounds = db.prepare(`SELECT COUNT(*) AS n, MIN(ts_ms) AS min_ts, MAX(ts_ms) AS max_ts FROM health_readings WHERE ${wSql}`).get(...params);

    if (!bounds || !bounds.n) {
      out = { metric, count: 0, readings: [] };
    } else if (args.bucket_min !== undefined || bounds.n > limit) {
      const spanMin = Math.max(1, (bounds.max_ts - bounds.min_ts) / 60000);
      const targetBuckets = Math.min(limit, 120);
      let bucketMin = clampInt(args.bucket_min, 1, 1440, 0);
      if (!bucketMin) bucketMin = Math.max(1, Math.ceil(spanMin / targetBuckets));
      else if (Math.ceil(spanMin / bucketMin) > limit) bucketMin = Math.ceil(spanMin / limit);
      const bucketMs = bucketMin * 60000;
      const rows = db.prepare(`
        SELECT
          CAST((ts_ms - ?) / ? AS INTEGER) AS bucket_idx,
          MIN(local_ts) AS from_local,
          MAX(local_ts) AS to_local,
          COUNT(*) AS samples,
          ROUND(AVG(value), 2) AS avg_val,
          ROUND(MIN(COALESCE(val_min, value)), 2) AS min_val,
          ROUND(MAX(COALESCE(val_max, value)), 2) AS max_val,
          MAX(unit) AS unit
        FROM health_readings
        WHERE ${wSql}
        GROUP BY bucket_idx
        ORDER BY bucket_idx ASC
        LIMIT ?
      `).all(bounds.min_ts, bucketMs, ...params, limit);
      out = { metric, by_night: byNight, totalSamples: bounds.n, bucket_min: bucketMin, bucketCount: rows.length, buckets: rows };
    } else {
      const rows = db.prepare(`
        SELECT local_ts, local_day, night_day, value, val_min, val_max, unit, source
        FROM health_readings
        WHERE ${wSql}
        ORDER BY ts_ms ASC
        LIMIT ?
      `).all(...params, limit);
      out = { metric, by_night: byNight, totalSamples: bounds.n, count: rows.length, readings: rows };
    }
  } else {
    out = { metric: 'sleep' };
  }

  if (includeSleep) {
    const sWhere = ['1=1'];
    const sParams = [];
    if (d) { sWhere.push('night_day = ?'); sParams.push(d); }
    else {
      if (from) { sWhere.push('night_day >= ?'); sParams.push(from); }
      if (to) { sWhere.push('night_day <= ?'); sParams.push(to); }
    }
    out.sleepSessions = db.prepare(`
      SELECT kind, night_day, stage,
             datetime(start_ms / 1000, 'unixepoch', 'localtime') AS start_local,
             datetime(end_ms / 1000, 'unixepoch', 'localtime') AS end_local,
             duration_min, deep_h, rem_h, core_h, awake_h, in_bed_h, source
      FROM health_sleep_sessions
      WHERE ${sWhere.join(' AND ')}
      ORDER BY night_day DESC, kind ASC, start_ms ASC
      LIMIT 200
    `).all(...sParams);
  }
  return out;
}

function handleGetStrengthHistory(db, args = {}) {
  const where = ['1=1'];
  const params = [];
  const from = dayFilter(args.from), to = dayFilter(args.to);
  if (from) { where.push('s.local_day >= ?'); params.push(from); }
  if (to) { where.push('s.local_day <= ?'); params.push(to); }
  if (typeof args.exercise === 'string' && args.exercise.trim()) {
    where.push('LOWER(s.exercise_name) LIKE ?');
    params.push(`%${args.exercise.trim().toLowerCase()}%`);
  }
  if (args.leg_only === true) where.push('s.is_leg = 1');
  const limit = clampInt(args.limit, 1, 80, 40);
  const rows = db.prepare(`
    SELECT s.ride_id, s.local_day, r.title AS workout_title, r.strength_tss, r.heavy_legs,
           s.exercise_name, s.raw_line, s.sets_count, s.max_weight_kg, s.max_reps, s.max_rpe, s.est_volume_kg, s.is_leg
    FROM strength_exercises s
    JOIN ride_metrics r ON r.ride_id = s.ride_id
    WHERE ${where.join(' AND ')}
    ORDER BY s.local_day DESC, r.started_ms DESC, s.ex_idx ASC
    LIMIT ?
  `).all(...params, limit);
  return { count: rows.length, exercises: rows };
}

const FORBIDDEN_SQL_KW = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|REPLACE)\b/i;
const FORBIDDEN_TABLES = /\b(rides|settings|db_settings|meta|operations|sync_tombstones|wellness_days|sqlite_master|sqlite_schema|sqlite_temp_master|sqlite_temp_schema)\b/i;

function stripCommentsAndStrings(sql) {
  return String(sql || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, " '' ");
}

function handleRunReadonlySql(store, args = {}) {
  const raw = String(args.sql || '').trim();
  if (!raw) return { error: 'sql is required.' };
  const cleaned = stripCommentsAndStrings(raw).trim();
  if (!/^(SELECT|WITH)\b/i.test(cleaned)) return { error: 'Only SELECT or WITH queries are permitted.' };
  const withoutTrailingSemi = cleaned.replace(/;\s*$/, '');
  if (withoutTrailingSemi.includes(';')) return { error: 'Multiple SQL statements are not permitted.' };
  if (FORBIDDEN_SQL_KW.test(withoutTrailingSemi)) return { error: 'Query contains forbidden write or DDL keyword.' };
  if (FORBIDDEN_TABLES.test(withoutTrailingSemi)) return { error: 'Query may only reference the 10 analytics tables (ride_metrics, ride_samples, ride_laps, ride_mmp, strength_exercises, wellness_index, wellness_by_source, health_readings, health_sleep_sessions, health_metric_daily).' };

  const roDb = new DatabaseSync(store.file, { readOnly: true });
  try {
    roDb.exec('PRAGMA query_only = ON;');
    const allRows = roDb.prepare(raw.replace(/;\s*$/, '')).all();
    const truncated = allRows.length > SQL_MAX_ROWS;
    const rows = allRows.slice(0, SQL_MAX_ROWS);
    let out = { rowCount: allRows.length, truncated, rows };
    while (JSON.stringify(out).length > SQL_MAX_CHARS && out.rows.length > 1) {
      out.rows = out.rows.slice(0, Math.max(1, Math.floor(out.rows.length * 0.7)));
      out.truncated = true;
    }
    return out;
  } finally {
    roDb.close();
  }
}

function capPayload(obj) {
  let json = JSON.stringify(obj);
  if (json.length <= MAX_RESULT_CHARS) return obj;
  const copy = { ...obj };
  for (const key of ['rides', 'buckets', 'intervals', 'bests', 'days', 'weeks', 'exercises', 'rows', 'laps', 'readings', 'sleepSessions', 'metrics', 'sources']) {
    if (Array.isArray(copy[key])) {
      while (copy[key].length > 1 && JSON.stringify(copy).length > MAX_RESULT_CHARS) {
        copy[key] = copy[key].slice(0, Math.max(1, Math.floor(copy[key].length * 0.75)));
        copy.truncated = true;
      }
    }
  }
  return copy;
}

function executeTool(store, name, args = {}) {
  try {
    store.analytics.syncAll();
    const db = store.db;
    let res;
    switch (name) {
      case 'search_rides': res = handleSearchRides(db, args); break;
      case 'get_ride_detail': res = handleGetRideDetail(db, args); break;
      case 'get_ride_segment': res = handleGetRideSegment(db, args); break;
      case 'compare_intervals': res = handleCompareIntervals(db, args); break;
      case 'get_power_curve': res = handleGetPowerCurve(db, args); break;
      case 'get_wellness': res = handleGetWellness(db, args); break;
      case 'get_health_metrics': res = handleGetHealthMetrics(db, args); break;
      case 'get_health_readings': res = handleGetHealthReadings(db, args); break;
      case 'get_strength_history': res = handleGetStrengthHistory(db, args); break;
      case 'run_readonly_sql': res = handleRunReadonlySql(store, args); break;
      default: res = { error: `Unknown tool: ${name}` };
    }
    return capPayload(res);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

module.exports = { TOOL_DEFS, AI_TOOLS_PROMPT, claudeTools, geminiTools, openaiTools, executeTool };
