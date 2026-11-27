'use strict';
/**
 * Relational SQLite analytics index for Apex Velo Lab (schema v4).
 *
 * Maintains 10 normalized, queryable tables alongside the canonical JSON `rides`,
 * `settings`, and `wellness_days` tables so backups, restores, and mobile sync remain
 * unchanged while SQL queries and AI tools can inspect every ride, 1 Hz sample,
 * lap/interval, MMP curve, strength exercise, merged & per-source wellness day,
 * raw timestamped health reading, sleep session/stage, and daily health rollup directly.
 */
const crypto = require('node:crypto');
const VeloMetrics = require('../js/velo-metrics.js');
if (!globalThis.VeloMetrics) globalThis.VeloMetrics = VeloMetrics;
const VeloPower = require('../js/velo-power.js');
const VeloInsight = require('../js/velo-insight.js');
const VeloTrends = require('../js/velo-trends.js');
const VeloHealth = require('../js/velo-health.js');
const VeloSync = require('../js/velo-sync.js');
const RawHealth = require('./raw-health.cjs');

const DAY_MS = 86400000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const INDEXER_VERSION = 'v1';
const WELLNESS_INDEXER_VERSION = 'v2';
const LEG_LIFTS_RE = /squat|dead\s*lift|\brdl\b|romanian|lunge|leg\s*press|hip\s*thrust|step[\s-]*up|bulgarian/i;
const ANALYTICS_TABLES = [
  'ride_metrics',
  'ride_samples',
  'ride_laps',
  'ride_mmp',
  'strength_exercises',
  'wellness_index',
  'wellness_by_source',
  'health_readings',
  'health_sleep_sessions',
  'health_metric_daily'
];

const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');
const numOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const intOrNull = (v) => { const n = numOrNull(v); return n === null ? null : Math.round(n); };
const round1 = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10) / 10);
const round2 = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);
const round4 = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10000) / 10000);

function meanPos(arr) {
  let s = 0, n = 0;
  for (const v of arr) { const x = Number(v); if (x > 0) { s += x; n++; } }
  return n ? s / n : null;
}
function meanFinite(arr) {
  let s = 0, n = 0;
  for (const v of arr) { if (v !== null && v !== undefined && Number.isFinite(Number(v))) { s += Number(v); n++; } }
  return n ? s / n : null;
}

/** Parses a formatted Hevy exercise line into structured sets/weight/reps/RPE/volume metrics. */
function parseStrengthExerciseLine(rawLine) {
  const line = String(rawLine || '').trim();
  if (!line) return null;
  const colon = line.indexOf(':');
  const exerciseName = (colon >= 0 ? line.slice(0, colon) : line).trim().slice(0, 140) || 'Exercise';
  const rest = colon >= 0 ? line.slice(colon + 1).trim() : '';

  let setsCount = 0, maxWeight = null, maxReps = null, maxRpe = null, estVolume = 0;
  for (const m of rest.matchAll(/RPE\s*([\d.]+)/gi)) {
    const rpe = Number(m[1]);
    if (Number.isFinite(rpe) && rpe > 0 && (maxRpe === null || rpe > maxRpe)) maxRpe = rpe;
  }

  // Pattern A: compact uniform sets e.g. "3x5 @ 110 kg (RPE 8)", "2x10 @ 8 kg", "3x10"
  const uniform = rest.match(/^(\d+)\s*x\s*(\d+)(?:\s*@\s*([\d.]+)\s*kg)?/i);
  if (uniform && !/,/.test(rest)) {
    const sets = Number(uniform[1]), reps = Number(uniform[2]), w = uniform[3] !== undefined ? Number(uniform[3]) : null;
    setsCount = sets;
    maxReps = reps;
    if (w !== null && Number.isFinite(w)) {
      maxWeight = w;
      estVolume = Math.round(sets * reps * w * 10) / 10;
    }
  } else if (rest) {
    // Pattern B: comma-separated individual sets e.g. "60 kg x 10 (RPE 6), 60 kg x 8 (RPE 9)"
    const parts = rest.split(',').map(s => s.trim()).filter(Boolean);
    for (const part of parts) {
      let matched = false;
      const wr = part.match(/([\d.]+)\s*kg\s*x\s*(\d+)/i);
      if (wr) {
        const w = Number(wr[1]), r = Number(wr[2]);
        setsCount++;
        if (maxWeight === null || w > maxWeight) maxWeight = w;
        if (maxReps === null || r > maxReps) maxReps = r;
        estVolume += w * r;
        matched = true;
      } else {
        const repOnly = part.match(/\b(\d+)\s*reps?\b/i);
        const wOnly = part.match(/([\d.]+)\s*kg\b/i);
        if (repOnly) {
          const r = Number(repOnly[1]);
          setsCount++;
          if (maxReps === null || r > maxReps) maxReps = r;
          matched = true;
        } else if (wOnly) {
          const w = Number(wOnly[1]);
          setsCount++;
          if (maxWeight === null || w > maxWeight) maxWeight = w;
          matched = true;
        } else if (/\b\d+\s*(?:s|m|set)\b/i.test(part)) {
          setsCount++;
          matched = true;
        }
      }
      if (!matched && parts.length === 1) {
        const durSet = part.match(/^(\d+)\s*x\s*\d+\s*(?:s|m)\b/i);
        if (durSet) setsCount += Number(durSet[1]);
      }
    }
    estVolume = Math.round(estVolume * 10) / 10;
  }

  return {
    exerciseName,
    rawLine: line,
    setsCount: setsCount || null,
    maxWeightKg: maxWeight,
    maxReps,
    maxRpe,
    estVolumeKg: estVolume > 0 ? estVolume : null,
    isLeg: LEG_LIFTS_RE.test(exerciseName) ? 1 : 0
  };
}

/**
 * Auto-detects sustained hard efforts (>= 30 s at >= 88% FTP using 10 s rolling average)
 * for outdoor/unstructured rides that lack FIT laps or ERG targets.
 */
function detectAutoEfforts(prep, ftp, maxHr = 0, rawSamples = []) {
  const n = prep && prep.n ? prep.n : 0;
  if (n < 30 || !(ftp > 0)) return [];
  const { power, hr, cad, time, starts } = prep;
  const segOf = new Int32Array(n);
  let seg = -1, si = 0;
  const hard = new Uint8Array(n);
  let acc = 0, runStart = 0;
  for (let i = 0; i < n; i++) {
    if (si < starts.length && starts[si] === i) { seg++; si++; acc = 0; runStart = i; }
    segOf[i] = seg;
    acc += power[i] - (i - runStart >= 10 ? power[i - 10] : 0);
    if (i - runStart >= 9 && acc / 10 >= ftp * 0.88) hard[i] = 1;
  }
  const efforts = [];
  let i = 0;
  while (i < n) {
    if (!hard[i]) { i++; continue; }
    let j = i;
    while (j < n && hard[j] && segOf[j] === segOf[i]) j++;
    // Snap boundaries to the actual effort edges (capture the ramp-in up to 9 s, trim recovery tail)
    let a = i, b = j;
    for (let k = 0; k < 9 && a > 0 && segOf[a - 1] === segOf[i] && power[a - 1] >= ftp * 0.85; k++) a--;
    while (a < b && power[a] < ftp * 0.85) a++;
    while (b > a && power[b - 1] < ftp * 0.85) b--;
    const len = b - a;
    if (len >= 30) {
      const pSlice = [];
      const hSlice = [];
      const cSlice = [];
      const gSlice = [];
      let torqueSum = 0, torqueN = 0;
      for (let k = a; k < b; k++) {
        pSlice.push(power[k]);
        if (hr[k] > 0) hSlice.push(hr[k]);
        if (cad[k] > 0) cSlice.push(cad[k]);
        if (power[k] > 0 && cad[k] >= 20) { torqueSum += (power[k] * 60) / (2 * Math.PI * cad[k]); torqueN++; }
        const rs = rawSamples[k];
        if (rs && Number.isFinite(rs.grade)) gSlice.push(rs.grade);
      }
      const avgW = Math.round(pSlice.reduce((s, v) => s + v, 0) / len);
      const maxW = Math.round(Math.max(...pSlice));
      const third = Math.floor(len / 3);
      const long = len >= 60 && third >= 5;
      let hrRise = null, cadFade = null;
      if (long) {
        const h1 = meanPos(hr.slice(a, a + third)), h2 = meanPos(hr.slice(b - third, b));
        if (h1 && h2) hrRise = Math.round(h2 - h1);
        const c1 = meanPos(cad.slice(a, a + third)), c2 = meanPos(cad.slice(b - third, b));
        if (c1 && c2) cadFade = Math.round(c2 - c1);
      }
      let hrRec60s = null;
      if (b + 60 <= n && segOf[Math.min(n - 1, b + 62)] === segOf[i] && !hard.slice(j, b + 60).some(Boolean)) {
        const hEnd = meanPos(hr.slice(Math.max(a, b - 3), Math.min(n, b + 2)));
        const h60 = meanPos(hr.slice(b + 58, Math.min(n, b + 63)));
        if (hEnd && h60 && (!maxHr || Math.max(...hSlice) >= maxHr * 0.7)) hrRec60s = Math.round(hEnd - h60);
      }
      efforts.push({
        lapIdx: efforts.length + 1,
        startSec: Math.round(time[a] ?? a),
        durationSec: len,
        isWork: 1,
        avgWatts: avgW,
        maxWatts: maxW,
        np: VeloMetrics.normalizedPower(pSlice) || avgW,
        avgHr: hSlice.length ? Math.round(hSlice.reduce((s, v) => s + v, 0) / hSlice.length) : null,
        maxHr: hSlice.length ? Math.round(Math.max(...hSlice)) : null,
        hrRise,
        hrRec60s,
        avgCadence: cSlice.length ? Math.round(cSlice.reduce((s, v) => s + v, 0) / cSlice.length) : null,
        cadFade,
        avgTorqueNm: torqueN >= 10 ? round1(torqueSum / torqueN) : null,
        avgGradePct: gSlice.length ? round1(meanFinite(gSlice)) : null
      });
    }
    i = j;
  }
  return efforts;
}

class RideAnalyticsIndex {
  constructor(db) {
    this.db = db;
    this.stmts = null;
  }

  initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ride_metrics (
        ride_id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        local_day TEXT NOT NULL,
        started_ms INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        activity_type TEXT NOT NULL DEFAULT 'ride',
        sport_type TEXT NOT NULL DEFAULT '',
        indoor INTEGER,
        duration_s INTEGER NOT NULL DEFAULT 0,
        elapsed_s INTEGER,
        distance_m REAL,
        elevation_gain_m REAL,
        elevation_loss_m REAL,
        avg_watts INTEGER,
        max_watts INTEGER,
        np INTEGER,
        intensity_factor REAL,
        tss REAL,
        strength_tss REAL,
        kj INTEGER,
        calories INTEGER,
        avg_hr INTEGER,
        max_hr INTEGER,
        avg_cadence INTEGER,
        max_cadence INTEGER,
        avg_speed_kmh REAL,
        max_speed_kmh REAL,
        left_bal REAL,
        avg_temp_c REAL,
        max_temp_c REAL,
        avg_left_te REAL,
        avg_right_te REAL,
        avg_left_ps REAL,
        avg_right_ps REAL,
        avg_torque_nm REAL,
        vi REAL,
        ef REAL,
        decoupling_pct REAL,
        decoupling_status TEXT,
        trimp INTEGER,
        wbal_min_j INTEGER,
        wbal_max_depletion_pct INTEGER,
        matches INTEGER,
        above_cp_kj REAL,
        above_cp_s INTEGER,
        quad_q1 REAL,
        quad_q2 REAL,
        quad_q3 REAL,
        quad_q4 REAL,
        compliance_pct INTEGER,
        hr_recovery_first INTEGER,
        hr_recovery_last INTEGER,
        hr_recovery_slowing INTEGER,
        ftp_at_ride INTEGER,
        ftp_est_w INTEGER,
        z1_s INTEGER,
        z2_s INTEGER,
        z3_s INTEGER,
        z4_s INTEGER,
        z5_s INTEGER,
        z6_s INTEGER,
        z7_s INTEGER,
        hr_z1_s INTEGER,
        hr_z2_s INTEGER,
        hr_z3_s INTEGER,
        hr_z4_s INTEGER,
        hr_z5_s INTEGER,
        heavy_legs INTEGER NOT NULL DEFAULT 0,
        strength_sets INTEGER,
        strength_volume_kg REAL,
        sample_count INTEGER NOT NULL DEFAULT 0,
        lap_count INTEGER NOT NULL DEFAULT 0,
        has_gps INTEGER NOT NULL DEFAULT 0,
        has_altitude INTEGER NOT NULL DEFAULT 0,
        has_temp INTEGER NOT NULL DEFAULT 0,
        has_dynamics INTEGER NOT NULL DEFAULT 0,
        ai_breakdown TEXT,
        description TEXT,
        index_hash TEXT NOT NULL,
        samples_hash TEXT NOT NULL DEFAULT '0'
      );
      CREATE INDEX IF NOT EXISTS idx_ride_metrics_day ON ride_metrics(local_day DESC);
      CREATE INDEX IF NOT EXISTS idx_ride_metrics_type_ms ON ride_metrics(activity_type, started_ms DESC);

      CREATE TABLE IF NOT EXISTS ride_samples (
        ride_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        t_s INTEGER NOT NULL,
        segment INTEGER NOT NULL DEFAULT 0,
        power INTEGER,
        target_power INTEGER,
        hr INTEGER,
        cadence INTEGER,
        speed_kmh REAL,
        dist_km REAL,
        alt_m REAL,
        grade_pct REAL,
        temp_c REAL,
        lat REAL,
        lon REAL,
        left_bal REAL,
        left_te REAL,
        right_te REAL,
        left_ps REAL,
        right_ps REAL,
        PRIMARY KEY (ride_id, idx)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_ride_samples_ride_t ON ride_samples(ride_id, t_s);

      CREATE TABLE IF NOT EXISTS ride_laps (
        ride_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        lap_idx INTEGER NOT NULL,
        start_s INTEGER,
        duration_s INTEGER NOT NULL,
        is_work INTEGER NOT NULL DEFAULT 0,
        target_w INTEGER,
        avg_w INTEGER,
        max_w INTEGER,
        np INTEGER,
        pct_target INTEGER,
        execution_pct INTEGER,
        avg_hr INTEGER,
        max_hr INTEGER,
        hr_rise INTEGER,
        hr_rec_60s INTEGER,
        avg_cadence INTEGER,
        cad_fade INTEGER,
        avg_torque_nm REAL,
        left_bal REAL,
        distance_m REAL,
        ascent_m REAL,
        avg_grade_pct REAL,
        trigger TEXT,
        PRIMARY KEY (ride_id, kind, lap_idx)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_ride_laps_work ON ride_laps(is_work, duration_s);

      CREATE TABLE IF NOT EXISTS ride_mmp (
        ride_id TEXT NOT NULL,
        duration_s INTEGER NOT NULL,
        watts INTEGER NOT NULL,
        PRIMARY KEY (ride_id, duration_s)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_ride_mmp_dur_watts ON ride_mmp(duration_s, watts DESC);

      CREATE TABLE IF NOT EXISTS strength_exercises (
        ride_id TEXT NOT NULL,
        ex_idx INTEGER NOT NULL,
        local_day TEXT NOT NULL,
        exercise_name TEXT NOT NULL,
        raw_line TEXT NOT NULL,
        sets_count INTEGER,
        max_weight_kg REAL,
        max_reps INTEGER,
        max_rpe REAL,
        est_volume_kg REAL,
        is_leg INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (ride_id, ex_idx)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_strength_ex_name ON strength_exercises(exercise_name, local_day DESC);
      CREATE INDEX IF NOT EXISTS idx_strength_ex_day ON strength_exercises(local_day DESC);

      CREATE TABLE IF NOT EXISTS wellness_index (
        day TEXT PRIMARY KEY,
        rhr REAL,
        sleep_hr REAL,
        rhr_src TEXT,
        hrv REAL,
        hrv_kind TEXT,
        hrv_src TEXT,
        hrv_rmssd REAL,
        hrv_sdnn REAL,
        sleep_h REAL,
        deep_h REAL,
        rem_h REAL,
        core_h REAL,
        awake_h REAL,
        bed_min INTEGER,
        wake_min INTEGER,
        sleep_score REAL,
        icu_readiness REAL,
        baevsky REAL,
        resp REAL,
        spo2 REAL,
        weight_kg REAL,
        bp_sys REAL,
        bp_dia REAL,
        glucose REAL,
        kcal_in REAL,
        source TEXT
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS wellness_by_source (
        day TEXT NOT NULL,
        source TEXT NOT NULL,
        rhr REAL,
        sleep_hr REAL,
        rhr_src TEXT,
        hrv REAL,
        hrv_kind TEXT,
        hrv_src TEXT,
        hrv_rmssd REAL,
        hrv_sdnn REAL,
        sleep_h REAL,
        deep_h REAL,
        rem_h REAL,
        core_h REAL,
        awake_h REAL,
        bed_min INTEGER,
        wake_min INTEGER,
        sleep_score REAL,
        icu_readiness REAL,
        baevsky REAL,
        resp REAL,
        spo2 REAL,
        weight_kg REAL,
        bp_sys REAL,
        bp_dia REAL,
        glucose REAL,
        kcal_in REAL,
        PRIMARY KEY (day, source)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_wellness_src_day ON wellness_by_source(source, day DESC);

      CREATE TABLE IF NOT EXISTS health_readings (
        metric TEXT NOT NULL,
        ts_ms INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'apple_health',
        local_ts TEXT NOT NULL,
        local_day TEXT NOT NULL,
        night_day TEXT NOT NULL,
        value REAL NOT NULL,
        val_min REAL,
        val_max REAL,
        unit TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (metric, ts_ms, source)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_hr_day_metric ON health_readings(local_day DESC, metric);
      CREATE INDEX IF NOT EXISTS idx_hr_night_metric ON health_readings(night_day DESC, metric);

      CREATE TABLE IF NOT EXISTS health_sleep_sessions (
        kind TEXT NOT NULL,
        night_day TEXT NOT NULL,
        stage TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        duration_min REAL NOT NULL,
        deep_h REAL,
        rem_h REAL,
        core_h REAL,
        awake_h REAL,
        in_bed_h REAL,
        source TEXT NOT NULL DEFAULT 'apple_health',
        PRIMARY KEY (kind, night_day, stage, start_ms, source)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_hsleep_night ON health_sleep_sessions(night_day DESC, kind, start_ms);

      CREATE TABLE IF NOT EXISTS health_metric_daily (
        day TEXT NOT NULL,
        metric TEXT NOT NULL,
        sample_count INTEGER NOT NULL,
        val_sum REAL,
        val_avg REAL,
        val_min REAL,
        val_max REAL,
        val_p10 REAL,
        val_last REAL,
        unit TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (day, metric)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_hmd_metric_day ON health_metric_daily(metric, day DESC);
    `);

    // Upgrade existing v3 wellness_index tables idempotently
    const wCols = new Set(this.db.prepare('PRAGMA table_info(wellness_index)').all().map(c => c.name));
    for (const [col, def] of [
      ['sleep_hr', 'REAL'],
      ['rhr_src', 'TEXT'],
      ['hrv_src', 'TEXT'],
      ['hrv_rmssd', 'REAL'],
      ['hrv_sdnn', 'REAL'],
      ['bed_min', 'INTEGER'],
      ['wake_min', 'INTEGER'],
      ['sleep_score', 'REAL'],
      ['icu_readiness', 'REAL'],
      ['baevsky', 'REAL'],
      ['resp', 'REAL'],
      ['weight_kg', 'REAL'],
      ['bp_sys', 'REAL'],
      ['bp_dia', 'REAL'],
      ['glucose', 'REAL'],
      ['kcal_in', 'REAL']
    ]) {
      if (!wCols.has(col)) this.db.exec(`ALTER TABLE wellness_index ADD COLUMN ${col} ${def}`);
    }
  }

  _prepare() {
    if (this.stmts) return this.stmts;
    this.stmts = {
      getHashes: this.db.prepare('SELECT index_hash, samples_hash FROM ride_metrics WHERE ride_id=?'),
      upsertMetric: this.db.prepare(`INSERT OR REPLACE INTO ride_metrics (
        ride_id, started_at, local_day, started_ms, title, source, activity_type, sport_type, indoor,
        duration_s, elapsed_s, distance_m, elevation_gain_m, elevation_loss_m,
        avg_watts, max_watts, np, intensity_factor, tss, strength_tss, kj, calories,
        avg_hr, max_hr, avg_cadence, max_cadence, avg_speed_kmh, max_speed_kmh, left_bal,
        avg_temp_c, max_temp_c, avg_left_te, avg_right_te, avg_left_ps, avg_right_ps, avg_torque_nm,
        vi, ef, decoupling_pct, decoupling_status, trimp,
        wbal_min_j, wbal_max_depletion_pct, matches, above_cp_kj, above_cp_s,
        quad_q1, quad_q2, quad_q3, quad_q4, compliance_pct,
        hr_recovery_first, hr_recovery_last, hr_recovery_slowing, ftp_at_ride, ftp_est_w,
        z1_s, z2_s, z3_s, z4_s, z5_s, z6_s, z7_s, hr_z1_s, hr_z2_s, hr_z3_s, hr_z4_s, hr_z5_s,
        heavy_legs, strength_sets, strength_volume_kg,
        sample_count, lap_count, has_gps, has_altitude, has_temp, has_dynamics,
        ai_breakdown, description, index_hash, samples_hash
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      insertSample: this.db.prepare(`INSERT INTO ride_samples (
        ride_id, idx, t_s, segment, power, target_power, hr, cadence, speed_kmh, dist_km,
        alt_m, grade_pct, temp_c, lat, lon, left_bal, left_te, right_te, left_ps, right_ps
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      insertLap: this.db.prepare(`INSERT INTO ride_laps (
        ride_id, kind, lap_idx, start_s, duration_s, is_work, target_w, avg_w, max_w, np,
        pct_target, execution_pct, avg_hr, max_hr, hr_rise, hr_rec_60s, avg_cadence, cad_fade,
        avg_torque_nm, left_bal, distance_m, ascent_m, avg_grade_pct, trigger
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      insertMmp: this.db.prepare('INSERT INTO ride_mmp (ride_id, duration_s, watts) VALUES (?,?,?)'),
      insertStrength: this.db.prepare('INSERT INTO strength_exercises (ride_id, ex_idx, local_day, exercise_name, raw_line, sets_count, max_weight_kg, max_reps, max_rpe, est_volume_kg, is_leg) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
      delMetric: this.db.prepare('DELETE FROM ride_metrics WHERE ride_id=?'),
      delSamples: this.db.prepare('DELETE FROM ride_samples WHERE ride_id=?'),
      delLaps: this.db.prepare('DELETE FROM ride_laps WHERE ride_id=?'),
      delMmp: this.db.prepare('DELETE FROM ride_mmp WHERE ride_id=?'),
      delStrength: this.db.prepare('DELETE FROM strength_exercises WHERE ride_id=?'),
      upsertWellness: this.db.prepare(`INSERT OR REPLACE INTO wellness_index (
        day, rhr, sleep_hr, rhr_src, hrv, hrv_kind, hrv_src, hrv_rmssd, hrv_sdnn,
        sleep_h, deep_h, rem_h, core_h, awake_h, bed_min, wake_min,
        sleep_score, icu_readiness, baevsky, resp, spo2, weight_kg, bp_sys, bp_dia, glucose, kcal_in, source
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      upsertWellnessSource: this.db.prepare(`INSERT OR REPLACE INTO wellness_by_source (
        day, source, rhr, sleep_hr, rhr_src, hrv, hrv_kind, hrv_src, hrv_rmssd, hrv_sdnn,
        sleep_h, deep_h, rem_h, core_h, awake_h, bed_min, wake_min,
        sleep_score, icu_readiness, baevsky, resp, spo2, weight_kg, bp_sys, bp_dia, glucose, kcal_in
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      upsertHealthReading: this.db.prepare(`INSERT INTO health_readings (
        metric, ts_ms, source, local_ts, local_day, night_day, value, val_min, val_max, unit
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(metric, ts_ms, source) DO UPDATE SET
        value = excluded.value,
        val_min = COALESCE(excluded.val_min, health_readings.val_min),
        val_max = COALESCE(excluded.val_max, health_readings.val_max),
        unit = CASE WHEN excluded.unit != '' THEN excluded.unit ELSE health_readings.unit END`),
      upsertSleepSession: this.db.prepare(`INSERT OR REPLACE INTO health_sleep_sessions (
        kind, night_day, stage, start_ms, end_ms, duration_min,
        deep_h, rem_h, core_h, awake_h, in_bed_h, source
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
      upsertMetricDaily: this.db.prepare(`INSERT OR REPLACE INTO health_metric_daily (
        day, metric, sample_count, val_sum, val_avg, val_min, val_max, val_p10, val_last, unit
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`),
      selectDayMetricReadings: this.db.prepare(
        'SELECT value, val_min, val_max, unit FROM health_readings WHERE local_day=? AND metric=? ORDER BY ts_ms ASC'
      )
    };
    return this.stmts;
  }

  getActiveProfile() {
    let profiles = [];
    let activeId = null;
    try {
      const pRow = this.db.prepare("SELECT value FROM settings WHERE key='apex_velo_profiles'").get();
      if (pRow) profiles = JSON.parse(pRow.value) || [];
      const aRow = this.db.prepare("SELECT value FROM settings WHERE key='apex_velo_active_prof_id'").get();
      if (aRow) activeId = aRow.value;
    } catch { /* fallback to defaults */ }
    const p = (Array.isArray(profiles) && (profiles.find(x => x && x.id === activeId) || profiles[0])) || {};
    return {
      ftp: Number(p.ftp) > 0 ? Number(p.ftp) : 185,
      maxHr: Number(p.maxHr) > 0 ? Number(p.maxHr) : 0,
      lthr: Number(p.lthr) > 0 ? Number(p.lthr) : 0,
      weightKg: Number(p.weightKg) > 0 ? Number(p.weightKg) : 0,
      crankMm: Number(p.crankMm) > 100 && Number(p.crankMm) < 220 ? Number(p.crankMm) : 172.5
    };
  }

  _cpModelBefore(startedMs) {
    const rows = this.db.prepare(`
      SELECT m.ride_id, m.duration_s, m.watts
      FROM ride_mmp m
      JOIN ride_metrics r ON r.ride_id = m.ride_id
      WHERE r.activity_type = 'ride' AND r.started_ms > ? AND r.started_ms <= ?
    `).all(startedMs - 90 * DAY_MS, startedMs);
    if (!rows.length) return null;
    const byRide = new Map();
    for (const row of rows) {
      let curve = byRide.get(row.ride_id);
      if (!curve) { curve = new Array(VeloPower.GRID.length).fill(null); byRide.set(row.ride_id, curve); }
      const gi = VeloPower.GRID.indexOf(row.duration_s);
      if (gi >= 0) curve[gi] = row.watts;
    }
    const env = VeloPower.envelope([...byRide.values()].map(curve => ({ curve })));
    const m = VeloPower.fitModel(env.watts);
    return m && m.ok ? m : null;
  }

  deleteRide(rideId) {
    const id = String(rideId);
    const s = this._prepare();
    s.delMetric.run(id);
    s.delSamples.run(id);
    s.delLaps.run(id);
    s.delMmp.run(id);
    s.delStrength.run(id);
  }

  clearRides() {
    this.db.exec('DELETE FROM ride_metrics; DELETE FROM ride_samples; DELETE FROM ride_laps; DELETE FROM ride_mmp; DELETE FROM strength_exercises;');
  }

  _buildIndexHash(contentHash, ride, profile, cpModel) {
    const ftp = intOrNull(ride.ftpAtRide) || profile.ftp;
    return `${contentHash || ''}|${ftp}|${profile.maxHr}|${profile.lthr}|${profile.crankMm}|${cpModel ? `${cpModel.cp}:${cpModel.w}` : '0'}|${INDEXER_VERSION}`;
  }

  indexRide(ride, contentHash = '', { profile = null, cpModel = null } = {}) {
    if (!ride || ride.id === undefined || ride.id === null) return false;
    const prof = profile || this.getActiveProfile();
    const s = this._prepare();
    const id = String(ride.id);
    const samplesHash = String(contentHash || '').split(':')[1] || (Array.isArray(ride.samples) && ride.samples.length ? 'legacy' : '0');
    const expectedHash = this._buildIndexHash(contentHash, ride, prof, cpModel);
    const existing = s.getHashes.get(id);
    if (existing && existing.index_hash === expectedHash) return false;

    const samples = Array.isArray(ride.samples) && ride.samples.length ? ride.samples : null;
    const oneHz = samples ? VeloMetrics.toOneHz(samples) : null;
    const activityType = ride.activityType || 'ride';
    const isCycling = VeloMetrics.isCycling(ride);
    const ftp = intOrNull(ride.ftpAtRide) || prof.ftp;
    const startedMs = Date.parse(ride.date) || 0;
    const localDay = VeloMetrics.localDateKey(ride.date) || String(ride.date || '').slice(0, 10);

    let indoor = null;
    if (ride.trainer === true || [5, 6, 58].includes(Number(ride.fitSubSport)) || /indoor|virtual/i.test(String(ride.sportType || ride.title || ''))) indoor = 1;
    else if (ride.trainer === false || (Number(ride.fitSport) === 2 && Number(ride.fitSubSport || 0) === 0)) indoor = 0;

    let hasGps = 0, hasAlt = 0, hasTemp = 0, hasDyn = 0;
    if (!existing || existing.samples_hash !== samplesHash) {
      s.delSamples.run(id);
      if (oneHz && oneHz.length) {
        let seg = 0;
        for (let i = 0; i < oneHz.length; i++) {
          const pt = oneHz[i];
          if (i > 0 && VeloMetrics.isSampleBreak(oneHz[i - 1], pt)) seg++;
          if (pt.lat !== undefined && pt.lon !== undefined) hasGps = 1;
          if (pt.alt !== undefined) hasAlt = 1;
          if (pt.temp !== undefined) hasTemp = 1;
          if (pt.leftTe !== undefined || pt.rightTe !== undefined || pt.leftPs !== undefined || pt.rightPs !== undefined) hasDyn = 1;
          s.insertSample.run(
            id, i, intOrNull(pt.time) ?? i, seg,
            intOrNull(pt.power), intOrNull(pt.target), intOrNull(pt.hr), intOrNull(pt.cadence),
            numOrNull(pt.speed), numOrNull(pt.dist),
            numOrNull(pt.alt), numOrNull(pt.grade), numOrNull(pt.temp),
            numOrNull(pt.lat), numOrNull(pt.lon),
            numOrNull(pt.leftBal), numOrNull(pt.leftTe), numOrNull(pt.rightTe), numOrNull(pt.leftPs), numOrNull(pt.rightPs)
          );
        }
      }
    } else if (oneHz && oneHz.length) {
      for (let i = 0; i < oneHz.length; i++) {
        const pt = oneHz[i];
        if (pt.lat !== undefined && pt.lon !== undefined) hasGps = 1;
        if (pt.alt !== undefined) hasAlt = 1;
        if (pt.temp !== undefined) hasTemp = 1;
        if (pt.leftTe !== undefined || pt.rightTe !== undefined || pt.leftPs !== undefined || pt.rightPs !== undefined) hasDyn = 1;
      }
    }

    s.delMmp.run(id);
    s.delLaps.run(id);
    s.delStrength.run(id);

    let prep = null, curve = null, rm = null, zones = null, dec = null, ef = null;
    let torque = null, hrRec = null, ftpEv = null, qa = null, wb = null;
    let lapCount = 0;

    if (oneHz && oneHz.length && isCycling) {
      prep = VeloPower.prepare(oneHz);
      curve = VeloPower.mmp(prep);
      for (let g = 0; g < VeloPower.GRID.length; g++) {
        if (curve[g] > 0) s.insertMmp.run(id, VeloPower.GRID[g], curve[g]);
      }
      rm = VeloPower.rideMetrics(prep, { maxHr: prof.maxHr });
      zones = ftp > 0 ? VeloPower.zoneSeconds(prep.power, ftp) : null;
      dec = VeloInsight.decoupling(oneHz);
      ef = VeloTrends.efOf({ ...ride, samples: oneHz, ftpAtRide: ftp });
      torque = VeloInsight.avgTorque(oneHz);
      hrRec = VeloInsight.hrRecovery(oneHz, ftp, prof.maxHr);
      ftpEv = ride.rampTest ? VeloInsight.rampEvidence(oneHz, { maxHr: prof.maxHr }) : VeloInsight.ftpEvidence(oneHz, { maxHr: prof.maxHr, lthr: prof.lthr });
      qa = VeloPower.quadrants(prep, (cpModel && cpModel.cp) || ftp, prof.crankMm);
      wb = cpModel ? VeloPower.wbal(prep, cpModel.cp, cpModel.w) : null;

      // 1) FIT laps
      if (Array.isArray(ride.laps) && ride.laps.length) {
        for (const lap of ride.laps) {
          const startS = intOrNull(lap.startSec);
          const durS = Math.max(0, intOrNull(lap.durationSec) || 0);
          let hrRise = null, cadFade = null, avgTorque = null, avgGrade = null;
          if (startS !== null && durS > 0) {
            const seg = oneHz.filter(pt => pt.time >= startS && pt.time < startS + durS);
            if (seg.length >= 10) {
              avgTorque = VeloInsight.avgTorque(seg);
              const grades = seg.map(pt => pt.grade).filter(v => Number.isFinite(v));
              if (grades.length) avgGrade = round1(meanFinite(grades));
              if (seg.length >= 60) {
                const third = Math.floor(seg.length / 3);
                const h1 = meanPos(seg.slice(0, third).map(pt => pt.hr)), h2 = meanPos(seg.slice(-third).map(pt => pt.hr));
                if (h1 && h2) hrRise = Math.round(h2 - h1);
                const c1 = meanPos(seg.slice(0, third).map(pt => pt.cadence)), c2 = meanPos(seg.slice(-third).map(pt => pt.cadence));
                if (c1 && c2) cadFade = Math.round(c2 - c1);
              }
            }
          }
          const isWork = ftp > 0 && (Number(lap.avgWatts) >= ftp * 0.88 || Number(lap.np) >= ftp * 0.88) ? 1 : 0;
          s.insertLap.run(
            id, 'fit_lap', intOrNull(lap.lapIdx) || (lapCount + 1), startS, durS, isWork,
            null, intOrNull(lap.avgWatts), intOrNull(lap.maxWatts), intOrNull(lap.np),
            null, null, intOrNull(lap.avgHr), intOrNull(lap.maxHr), hrRise, null,
            intOrNull(lap.avgCadence), cadFade, avgTorque, numOrNull(lap.leftBal),
            numOrNull(lap.distanceM), numOrNull(lap.ascentM), avgGrade, lap.trigger ? String(lap.trigger) : null
          );
          lapCount++;
        }
      }

      // 2) ERG workout steps (where targets were recorded)
      let hasErgWork = false;
      if (oneHz.some(pt => Number(pt.target) > 0)) {
        const rows = VeloInsight.intervalRows(oneHz, ftp);
        let cursor = 0;
        for (const r of rows) {
          if (r.work) hasErgWork = true;
          const segStart = oneHz[cursor] ? intOrNull(oneHz[cursor].time) : cursor;
          const seg = oneHz.slice(cursor, cursor + r.sec);
          cursor += r.sec;
          const maxW = seg.length ? Math.round(Math.max(...seg.map(pt => Number(pt.power) || 0))) : null;
          const maxH = seg.length ? Math.round(Math.max(...seg.map(pt => Number(pt.hr) || 0))) || null : null;
          const endIdx = cursor;
          const recMatch = hrRec && hrRec.efforts ? hrRec.efforts.find(e => Math.abs(e.at - endIdx) <= 10) : null;
          s.insertLap.run(
            id, 'erg_step', r.n, segStart, r.sec, r.work ? 1 : 0,
            r.target || null, r.avgP, maxW, VeloMetrics.normalizedPower(seg) || r.avgP,
            r.pctOfTarget, r.execution, r.hr, maxH, r.hrRise, recMatch ? recMatch.drop : null,
            r.cadence, r.cadFade, VeloInsight.avgTorque(seg), null, null, null, null, null
          );
          lapCount++;
        }
      }

      // 3) Auto-detected hard efforts if neither FIT laps nor ERG work steps exist
      if ((!Array.isArray(ride.laps) || !ride.laps.length) && !hasErgWork) {
        const auto = detectAutoEfforts(prep, ftp, prof.maxHr, oneHz);
        for (const a of auto) {
          s.insertLap.run(
            id, 'auto_effort', a.lapIdx, a.startSec, a.durationSec, 1,
            null, a.avgWatts, a.maxWatts, a.np,
            null, null, a.avgHr, a.maxHr, a.hrRise, a.hrRec60s,
            a.avgCadence, a.cadFade, a.avgTorqueNm, null, null, null, a.avgGradePct, null
          );
          lapCount++;
        }
      }
    } else if (isCycling) {
      // Summary-only ride (e.g. EF from NP / avgHr)
      ef = VeloTrends.efOf(ride);
      if (ride.sampleSummary && Array.isArray(ride.sampleSummary.curve)) {
        for (let g = 0; g < VeloPower.GRID.length; g++) {
          const w = ride.sampleSummary.curve[g];
          if (w > 0) s.insertMmp.run(id, VeloPower.GRID[g], w);
        }
      }
    }

    // Strength exercises
    let strengthSets = intOrNull(ride.hevy && ride.hevy.setCount);
    let strengthVol = numOrNull(ride.hevy && ride.hevy.volumeKg);
    if (activityType === 'strength') {
      const lines = Array.isArray(ride.exercises) && ride.exercises.length
        ? ride.exercises
        : String(ride.description || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      let sumSets = 0, sumVol = 0;
      lines.forEach((line, idx) => {
        const parsed = parseStrengthExerciseLine(line);
        if (!parsed) return;
        if (parsed.setsCount) sumSets += parsed.setsCount;
        if (parsed.estVolumeKg) sumVol += parsed.estVolumeKg;
        s.insertStrength.run(
          id, idx + 1, localDay, parsed.exerciseName, parsed.rawLine,
          parsed.setsCount, parsed.maxWeightKg, parsed.maxReps, parsed.maxRpe, parsed.estVolumeKg, parsed.isLeg
        );
      });
      if (strengthSets === null && sumSets > 0) strengthSets = sumSets;
      if (strengthVol === null && sumVol > 0) strengthVol = Math.round(sumVol);
    }

    const avgW = intOrNull(ride.avgWatts);
    const np = intOrNull(ride.np);
    const vi = avgW > 0 && np > 0 ? round2(np / avgW) : null;
    const distM = numOrNull(ride.totalDistanceMeters) ?? (numOrNull(ride.distanceKm) !== null ? Math.round(Number(ride.distanceKm) * 1000) : null);

    // Optional sample-derived rollups if ride lacks top-level fields
    let elevGain = numOrNull(ride.elevationGainM), elevLoss = numOrNull(ride.elevationLossM);
    let avgTemp = numOrNull(ride.avgTempC), maxTemp = numOrNull(ride.maxTempC);
    let lTe = numOrNull(ride.avgLeftTe), rTe = numOrNull(ride.avgRightTe), lPs = numOrNull(ride.avgLeftPs), rPs = numOrNull(ride.avgRightPs);
    if (oneHz && oneHz.length && (hasAlt || hasTemp || hasDyn)) {
      const temps = [], ltes = [], rtes = [], lpss = [], rpss = [];
      let gain = 0, loss = 0, prevAlt = null;
      for (const pt of oneHz) {
        if (Number.isFinite(pt.alt)) {
          if (prevAlt === null) prevAlt = pt.alt;
          else {
            const d = pt.alt - prevAlt;
            if (d >= 1.0) { gain += d; prevAlt = pt.alt; } else if (d <= -1.0) { loss += -d; prevAlt = pt.alt; }
          }
        }
        if (Number.isFinite(pt.temp)) temps.push(pt.temp);
        if (pt.leftTe > 0) ltes.push(pt.leftTe);
        if (pt.rightTe > 0) rtes.push(pt.rightTe);
        if (pt.leftPs > 0) lpss.push(pt.leftPs);
        if (pt.rightPs > 0) rpss.push(pt.rightPs);
      }
      if (elevGain === null && hasAlt) elevGain = Math.round(gain);
      if (elevLoss === null && hasAlt) elevLoss = Math.round(loss);
      if (avgTemp === null && temps.length) avgTemp = round1(meanFinite(temps));
      if (maxTemp === null && temps.length) maxTemp = round1(Math.max(...temps));
      if (lTe === null && ltes.length) lTe = round1(meanPos(ltes));
      if (rTe === null && rtes.length) rTe = round1(meanPos(rtes));
      if (lPs === null && lpss.length) lPs = round1(meanPos(lpss));
      if (rPs === null && rpss.length) rPs = round1(meanPos(rpss));
    }

    const hrZ = rm && rm.hrZones ? rm.hrZones : null;
    const z = zones || [null, null, null, null, null, null, null];
    const aiText = ride.aiBreakdown && ride.aiBreakdown.text ? String(ride.aiBreakdown.text) : null;

    s.upsertMetric.run(
      id, String(ride.date), localDay, startedMs,
      String(ride.title || ''), String(ride.source || ''), activityType, String(ride.sportType || ''), indoor,
      Math.max(0, intOrNull(ride.duration) || 0), intOrNull(ride.elapsedSec), distM, elevGain, elevLoss,
      avgW, intOrNull(ride.maxWatts), np, numOrNull(ride.if), numOrNull(ride.tss), numOrNull(ride.strengthTss), intOrNull(ride.kj), intOrNull(ride.totalCalories),
      intOrNull(ride.avgHr), intOrNull(ride.maxHr), intOrNull(ride.avgCadence), intOrNull(ride.maxCadence), numOrNull(ride.avgSpeedKmh), numOrNull(ride.maxSpeedKmh), numOrNull(ride.leftBal),
      avgTemp, maxTemp, lTe, rTe, lPs, rPs, torque,
      vi, ef ? ef.ef : null, dec && dec.status === 'ok' ? dec.pct : null, dec ? dec.status : null, rm ? rm.trimp : null,
      wb ? wb.min : null, wb ? wb.maxDepletionPct : null, wb ? wb.matches : null, wb ? wb.aboveKj : null, wb ? wb.aboveSec : null,
      qa ? qa.pct[0] : null, qa ? qa.pct[1] : null, qa ? qa.pct[2] : null, qa ? qa.pct[3] : null, intOrNull(ride.compliancePct),
      hrRec ? hrRec.first : null, hrRec ? hrRec.last : null, hrRec ? (hrRec.slowing ? 1 : 0) : null,
      intOrNull(ride.ftpAtRide), ftpEv && ftpEv.estimate > 0 ? ftpEv.estimate : null,
      z[0], z[1], z[2], z[3], z[4], z[5], z[6],
      hrZ ? hrZ[0] : null, hrZ ? hrZ[1] : null, hrZ ? hrZ[2] : null, hrZ ? hrZ[3] : null, hrZ ? hrZ[4] : null,
      ride.heavyLegs ? 1 : 0, strengthSets, strengthVol,
      oneHz ? oneHz.length : (intOrNull(ride.samplesCount) || 0), lapCount,
      hasGps, hasAlt, hasTemp, hasDyn,
      aiText, ride.description ? String(ride.description) : null,
      expectedHash, samplesHash
    );
    return true;
  }

  _wellnessCols(sum, fallbackHrvKind = null) {
    const hrv = numOrNull(sum.hrv);
    const hrvKind = sum.hrvKind ? String(sum.hrvKind) : (hrv !== null ? fallbackHrvKind : null);
    return [
      numOrNull(sum.rhr),
      numOrNull(sum.sleepHr),
      sum.rhrSrc ? String(sum.rhrSrc) : null,
      hrv,
      hrvKind,
      sum.hrvSrc ? String(sum.hrvSrc) : null,
      numOrNull(sum.hrvRmssd) ?? (hrv !== null && hrvKind === 'rmssd' ? hrv : null),
      numOrNull(sum.hrvSdnn) ?? (hrv !== null && hrvKind === 'sdnn' ? hrv : null),
      numOrNull(sum.sleepH),
      numOrNull(sum.deepH),
      numOrNull(sum.remH),
      numOrNull(sum.coreH),
      numOrNull(sum.awakeH),
      intOrNull(sum.bed),
      intOrNull(sum.wake),
      numOrNull(sum.sleepScore),
      numOrNull(sum.icuReadiness),
      numOrNull(sum.baevsky),
      numOrNull(sum.resp),
      numOrNull(sum.spo2),
      numOrNull(sum.weight),
      numOrNull(sum.bpSys),
      numOrNull(sum.bpDia),
      numOrNull(sum.glucose),
      numOrNull(sum.kcalIn)
    ];
  }

  ingestRawHealth({ readings = [], sleepSessions = [] } = {}, { transactional = true } = {}) {
    if ((!readings || !readings.length) && (!sleepSessions || !sleepSessions.length)) {
      return { readings: 0, sleepSessions: 0, metrics: [], touchedDays: 0 };
    }
    const s = this._prepare();
    const touchedPairs = new Set();
    const touchedDays = new Set();
    const uniqueMetrics = new Set();

    const runWork = () => {
      let readingCount = 0;
      for (const r of readings || []) {
        if (!r || !r.metric || !Number.isFinite(r.tsMs) || !Number.isFinite(r.value) || !DAY_RE.test(r.localDay || '')) continue;
        const unit = r.unit ? String(r.unit) : '';
        const source = r.source ? String(r.source) : 'apple_health';
        const nightDay = DAY_RE.test(r.nightDay || '') ? r.nightDay : r.localDay;
        s.upsertHealthReading.run(
          String(r.metric), Math.round(r.tsMs), source,
          String(r.localTs || `${r.localDay} 00:00:00`), r.localDay, nightDay,
          Number(r.value), numOrNull(r.valMin), numOrNull(r.valMax), unit
        );
        touchedPairs.add(`${r.localDay}|${r.metric}`);
        touchedDays.add(r.localDay);
        uniqueMetrics.add(r.metric);
        readingCount++;
      }

      let sleepCount = 0;
      for (const ss of sleepSessions || []) {
        if (!ss || !ss.kind || !DAY_RE.test(ss.nightDay || '') || !(Number(ss.durationMin) > 0)) continue;
        s.upsertSleepSession.run(
          String(ss.kind), ss.nightDay, String(ss.stage || 'total'),
          Math.round(Number(ss.startMs) || 0), Math.round(Number(ss.endMs) || 0),
          round2(ss.durationMin), numOrNull(ss.deepH), numOrNull(ss.remH),
          numOrNull(ss.coreH), numOrNull(ss.awakeH), numOrNull(ss.inBedH),
          ss.source ? String(ss.source) : 'apple_health'
        );
        touchedDays.add(ss.nightDay);
        sleepCount++;
      }

      for (const pair of touchedPairs) {
        const sep = pair.indexOf('|');
        const day = pair.slice(0, sep);
        const metric = pair.slice(sep + 1);
        const rows = s.selectDayMetricReadings.all(day, metric);
        if (!rows.length) continue;
        let valSum = 0;
        let valMin = Infinity;
        let valMax = -Infinity;
        let unit = '';
        const vals = [];
        for (const row of rows) {
          const v = Number(row.value);
          valSum += v;
          vals.push(v);
          const lo = row.val_min !== null && row.val_min !== undefined ? Number(row.val_min) : v;
          const hi = row.val_max !== null && row.val_max !== undefined ? Number(row.val_max) : v;
          if (lo < valMin) valMin = lo;
          if (hi > valMax) valMax = hi;
          if (!unit && row.unit) unit = row.unit;
        }
        const sorted = vals.slice().sort((a, b) => a - b);
        const idx = (sorted.length - 1) * 0.1;
        const loIdx = Math.floor(idx);
        const valP10 = sorted[loIdx] + (sorted[Math.min(loIdx + 1, sorted.length - 1)] - sorted[loIdx]) * (idx - loIdx);
        const valLast = vals[vals.length - 1];
        s.upsertMetricDaily.run(
          day, metric, rows.length,
          round4(valSum), round4(valSum / rows.length), round4(valMin), round4(valMax), round4(valP10), round4(valLast), unit
        );
      }

      return { readings: readingCount, sleepSessions: sleepCount, metrics: [...uniqueMetrics], touchedDays: touchedDays.size };
    };

    if (transactional) {
      this.db.exec('BEGIN IMMEDIATE');
      try { const res = runWork(); this.db.exec('COMMIT'); return res; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
    return runWork();
  }

  syncWellness() {
    const s = this._prepare();
    const wRows = this.db.prepare('SELECT day, source, json, updated_at FROM wellness_days ORDER BY day, source').all();
    const healthRow = this.db.prepare("SELECT value, updated_at FROM settings WHERE key='apex_health_v1'").get();
    const wdPart = wRows.length
      ? `wd:${wRows.length}:${wRows.reduce((a, r) => a + ':' + r.day + r.source + r.updated_at, '')}`
      : 'wd:0';
    const setPart = healthRow && healthRow.value ? `set:${healthRow.updated_at}:${sha256(healthRow.value)}` : 'set:0';
    const sigSrc = `${WELLNESS_INDEXER_VERSION}|${wdPart}|${setPart}`;
    const prevSig = this.db.prepare("SELECT value FROM meta WHERE key='analytics_wellness_sig'").get()?.value;
    if (prevSig === sigSrc) return false;

    this.db.exec('DELETE FROM wellness_index; DELETE FROM wellness_by_source;');
    if (wRows.length) {
      const parsedRows = [];
      const fallbackByDay = new Map();
      for (const r of wRows) {
        let data; try { data = JSON.parse(r.json); } catch { continue; }
        if (!data || typeof data !== 'object') continue;
        parsedRows.push({ day: r.day, source: r.source, data, updatedAt: r.updated_at || 0 });
        const sum = data.summary ? data.summary : (() => { const d = VeloHealth.summarizeDay(r.day, data); delete d.day; return d; })();
        if (!sum || typeof sum !== 'object') continue;
        const fbHrvKind = r.source === 'apple' ? 'sdnn' : (r.source === 'healthconnect' || r.source === 'icu' ? 'rmssd' : null);
        s.upsertWellnessSource.run(r.day, r.source, ...this._wellnessCols(sum, fbHrvKind));
        if (!fallbackByDay.has(r.day)) fallbackByDay.set(r.day, []);
        fallbackByDay.get(r.day).push({ source: r.source, sum });
      }
      const built = VeloSync.buildHealthStore(parsedRows, {}, VeloHealth);
      const writtenDays = new Set();
      for (const [day, rec] of Object.entries((built && built.days) || {})) {
        if (!DAY_RE.test(day) || !rec || !rec.summary) continue;
        s.upsertWellness.run(day, ...this._wellnessCols(rec.summary, null), rec.src || 'merged');
        writtenDays.add(day);
      }
      // Guarantee no day from wellness_days is dropped even if only auxiliary metrics exist
      for (const [day, list] of fallbackByDay.entries()) {
        if (writtenDays.has(day) || !DAY_RE.test(day)) continue;
        list.sort((a, b) => (a.source === 'apple' ? -1 : b.source === 'apple' ? 1 : a.source.localeCompare(b.source)));
        const merged = Object.assign({}, ...list.slice().reverse().map(x => x.sum));
        s.upsertWellness.run(day, ...this._wellnessCols(merged, list[0].source === 'apple' ? 'sdnn' : 'rmssd'), list[0].source);
      }
    } else if (healthRow && healthRow.value) {
      try {
        const parsed = JSON.parse(healthRow.value);
        const days = parsed && parsed.days && typeof parsed.days === 'object' ? parsed.days : {};
        for (const [day, rec] of Object.entries(days)) {
          if (!DAY_RE.test(day) || !rec || typeof rec !== 'object') continue;
          const sum = rec.summary ? rec.summary : VeloHealth.summarizeDay(day, rec);
          const hasAny = sum.rhr !== null || sum.hrv !== null || sum.sleepH !== null || sum.spo2 != null
            || sum.weight != null || sum.resp != null || sum.sleepScore != null || sum.icuReadiness != null;
          if (!hasAny) continue;
          const src = rec.src || 'apple';
          const fbKind = src === 'apple' ? 'sdnn' : null;
          s.upsertWellness.run(day, ...this._wellnessCols(sum, fbKind), src);
          s.upsertWellnessSource.run(day, src, ...this._wellnessCols(sum, fbKind));
        }
      } catch { /* ignore unreadable legacy blob */ }
    }

    if (healthRow && healthRow.value) {
      try {
        const parsed = JSON.parse(healthRow.value);
        const raw = RawHealth.parseApexHealthStoreRaw(parsed);
        if (raw.readings.length || raw.sleepSessions.length) {
          this.ingestRawHealth(raw, { transactional: false });
        }
      } catch { /* ignore unreadable legacy blob */ }
    }

    this.db.prepare("INSERT OR REPLACE INTO meta VALUES ('analytics_wellness_sig', ?)").run(sigSrc);
    return true;
  }

  syncAll({ transactional = true } = {}) {
    const profile = this.getActiveProfile();
    const rawRides = this.db.prepare('SELECT id, json, content_hash FROM rides ORDER BY position, id').all();
    const rawIds = new Set(rawRides.map(r => String(r.id)));
    const existingRows = this.db.prepare('SELECT ride_id, index_hash FROM ride_metrics').all();
    const existingMap = new Map(existingRows.map(r => [r.ride_id, r.index_hash]));

    const staleOrMissing = [];
    for (const r of rawRides) {
      const id = String(r.id);
      const curHash = existingMap.get(id);
      if (!curHash) {
        staleOrMissing.push(r);
      } else {
        const prefix = `${r.content_hash || ''}|`;
        // If content_hash or profile changed, check exact base signature (cpModel is resolved during indexing)
        const ftpGuess = profile.ftp;
        const idxParts = curHash.split('|');
        const profileMatches = idxParts[2] === String(profile.maxHr) && idxParts[3] === String(profile.lthr) && idxParts[4] === String(profile.crankMm) && idxParts[6] === INDEXER_VERSION;
        if (!curHash.startsWith(prefix) || !profileMatches) {
          staleOrMissing.push(r);
        } else {
          // Also check if ride has no ftpAtRide and profile ftp changed
          const mRow = this.db.prepare('SELECT ftp_at_ride FROM ride_metrics WHERE ride_id=?').get(id);
          if (mRow && mRow.ftp_at_ride === null && idxParts[1] !== String(ftpGuess)) staleOrMissing.push(r);
        }
      }
    }
    const orphanIds = existingRows.map(r => r.ride_id).filter(id => !rawIds.has(id));

    const runWork = () => {
      for (const id of orphanIds) this.deleteRide(id);
      // Pass 1: index rides (populates ride_mmp for CP calculations)
      const parsedRides = [];
      for (const r of staleOrMissing) {
        const ride = JSON.parse(r.json);
        parsedRides.push({ ride, contentHash: r.content_hash || '' });
        this.indexRide(ride, r.content_hash || '', { profile });
      }
      // Pass 2: for newly indexed cycling rides with samples, compute 90-day CP model and update W'bal / quadrants if a CP model exists
      const cpCache = new Map();
      for (const { ride, contentHash } of parsedRides) {
        if (!VeloMetrics.isCycling(ride) || !Array.isArray(ride.samples) || !ride.samples.length) continue;
        const day = VeloMetrics.localDateKey(ride.date) || String(ride.date || '').slice(0, 10);
        let cpModel = cpCache.get(day);
        if (cpModel === undefined) {
          cpModel = this._cpModelBefore(Date.parse(ride.date) || 0);
          cpCache.set(day, cpModel);
        }
        if (cpModel) this.indexRide(ride, contentHash, { profile, cpModel });
      }
      this.syncWellness();
    };

    if (!staleOrMissing.length && !orphanIds.length) {
      if (transactional) {
        this.db.exec('BEGIN IMMEDIATE');
        try { this.syncWellness(); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; }
      } else {
        this.syncWellness();
      }
      return { indexed: 0, deleted: 0 };
    }

    if (transactional) {
      this.db.exec('BEGIN IMMEDIATE');
      try { runWork(); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    } else {
      runWork();
    }
    return { indexed: staleOrMissing.length, deleted: orphanIds.length };
  }

  status() {
    const count = (t) => this.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    const withSamples = this.db.prepare('SELECT COUNT(*) AS n FROM ride_metrics WHERE sample_count > 0').get().n;
    const healthMetrics = this.db.prepare(`
      SELECT metric, MAX(unit) AS unit, SUM(sample_count) AS readings, COUNT(*) AS days, MIN(day) AS firstDay, MAX(day) AS lastDay
      FROM health_metric_daily
      GROUP BY metric
      ORDER BY readings DESC, metric ASC
    `).all();
    return {
      schemaVersion: 4,
      indexedRides: count('ride_metrics'),
      ridesWithSamples: withSamples,
      totalSamples: count('ride_samples'),
      totalLaps: count('ride_laps'),
      totalMmp: count('ride_mmp'),
      totalStrengthExercises: count('strength_exercises'),
      totalWellnessDays: count('wellness_index'),
      totalWellnessSourceRows: count('wellness_by_source'),
      totalHealthReadings: count('health_readings'),
      totalSleepSessions: count('health_sleep_sessions'),
      totalHealthMetricDays: count('health_metric_daily'),
      healthMetricCount: healthMetrics.length,
      healthMetrics
    };
  }
}

module.exports = { RideAnalyticsIndex, parseStrengthExerciseLine, detectAutoEfforts, ANALYTICS_TABLES };
