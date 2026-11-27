'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { LocalStore } = require('../scripts/sqlite-store.cjs');
const { parseStrengthExerciseLine } = require('../scripts/sqlite-analytics.cjs');
const aiTools = require('../scripts/ai-tools.cjs');

let op = 0;
const reqOf = (s, extra = {}) => ({ revision: s.revision, operationId: 'analytics_op_' + ++op, ...extra });

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-analytics-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeErgSamples() {
  const out = [];
  let t = 0;
  const push = (sec, power, target, hr, cad) => {
    for (let i = 0; i < sec; i++) {
      out.push({ time: t++, power, target, hr, cadence: cad, speed: 30, dist: t * 0.008, alt: 100 + i * 0.1, temp: 21 });
    }
  };
  push(120, 120, 120, 115, 85); // warmup
  for (let rep = 0; rep < 2; rep++) {
    // 180 s work @ 240 W (120% of 200 FTP) with slight HR rise & cadence fade
    for (let i = 0; i < 180; i++) {
      out.push({ time: t++, power: 238 + (i % 5), target: 240, hr: 155 + Math.floor(i / 15), cadence: 94 - Math.floor(i / 30), speed: 35, dist: t * 0.009, alt: 120 + i * 0.2, temp: 22 });
    }
    // 120 s recovery
    for (let i = 0; i < 120; i++) {
      out.push({ time: t++, power: 100, target: 100, hr: Math.max(120, 166 - Math.floor(i / 3)), cadence: 85, speed: 24, dist: t * 0.007, alt: 156, temp: 21 });
    }
  }
  return out;
}

test('parseStrengthExerciseLine handles compact and comma-separated Hevy formats', () => {
  const a = parseStrengthExerciseLine('Squat (Barbell): 3x5 @ 110 kg (RPE 8)');
  assert.equal(a.exerciseName, 'Squat (Barbell)');
  assert.equal(a.setsCount, 3);
  assert.equal(a.maxWeightKg, 110);
  assert.equal(a.maxReps, 5);
  assert.equal(a.maxRpe, 8);
  assert.equal(a.estVolumeKg, 1650);
  assert.equal(a.isLeg, 1);

  const b = parseStrengthExerciseLine('Bench Press (Barbell): 60 kg x 10 (RPE 6), 60 kg x 8 (RPE 9.5)');
  assert.equal(b.exerciseName, 'Bench Press (Barbell)');
  assert.equal(b.setsCount, 2);
  assert.equal(b.maxWeightKg, 60);
  assert.equal(b.maxReps, 10);
  assert.equal(b.maxRpe, 9.5);
  assert.equal(b.estVolumeKg, 1080);
  assert.equal(b.isLeg, 0);
});

test('v1 database upgrades automatically to v3 and backfills all 6 analytics tables', () => {
  const dir = makeTempDir(tPlaceholder());
  const dbPath = path.join(dir, 'apex.sqlite');

  // Seed a v1 schema DB directly (without wellness_days or analytics tables)
  const v1 = new DatabaseSync(dbPath);
  v1.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE rides (id TEXT PRIMARY KEY, json TEXT NOT NULL, position INTEGER NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE db_settings (key TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE operations (id TEXT PRIMARY KEY, result TEXT NOT NULL, at INTEGER NOT NULL);
  `);
  v1.prepare('INSERT INTO meta VALUES (?,?)').run('initialized', '1');
  v1.prepare('INSERT INTO settings VALUES (?,?)').run('apex_velo_profiles', JSON.stringify([{ id: 'p1', name: 'Rider', ftp: 200, maxHr: 180, weightKg: 75 }]));
  v1.prepare('INSERT INTO settings VALUES (?,?)').run('apex_velo_active_prof_id', 'p1');
  v1.prepare('INSERT INTO settings VALUES (?,?)').run('apex_health_v1', JSON.stringify({
    v: 1,
    days: {
      '2026-10-09': { summary: { rhr: 50, hrv: 68, sleepH: 7.8, deepH: 1.2, remH: 1.8, coreH: 4.8 } },
      '2026-10-10': { summary: { rhr: 53, hrv: 54, sleepH: 6.4, deepH: 0.9, remH: 1.3, coreH: 4.2 } }
    }
  }));

  const ergRide = {
    id: 'ride_erg_1', date: '2026-10-10T08:00:00.000Z', title: '2x3min VO2 Erg', source: 'APEX VELO Cockpit',
    duration: 720, avgWatts: 170, maxWatts: 242, np: 195, if: '0.98', tss: 24, kj: 122, avgHr: 145, maxHr: 167, avgCadence: 88,
    ftpAtRide: 200, trainer: true, samples: makeErgSamples(),
    laps: [{ lapIdx: 1, startSec: 120, durationSec: 180, avgWatts: 240, maxWatts: 242, avgHr: 160, maxHr: 166, avgCadence: 92, trigger: 'time' }]
  };
  const strengthRide = {
    id: 'hevy_1', source: 'Hevy', activityType: 'strength', sportType: 'WeightTraining',
    title: 'Leg Day', date: '2026-10-09T17:00:00.000Z', duration: 2400, strengthTss: 48, heavyLegs: true,
    hevy: { setCount: 5, workingSetCount: 5, volumeKg: 2730 },
    exercises: ['Squat (Barbell): 3x5 @ 110 kg (RPE 8)', 'Bench Press (Barbell): 60 kg x 10 (RPE 6), 60 kg x 8 (RPE 9)']
  };
  v1.prepare('INSERT INTO rides VALUES (?,?,?)').run(ergRide.id, JSON.stringify(ergRide), 0);
  v1.prepare('INSERT INTO rides VALUES (?,?,?)').run(strengthRide.id, JSON.stringify(strengthRide), 1);
  v1.close();

  const store = new LocalStore({ dir, mirrorDir: null });
  try {
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 4);
    const st = store.analyticsStatus();
    assert.equal(st.indexedRides, 2);
    assert.equal(st.ridesWithSamples, 1);
    assert.equal(st.totalSamples, 720);
    assert.ok(st.totalLaps >= 5); // 1 fit_lap + 5 erg_steps
    assert.ok(st.totalMmp >= 8);
    assert.equal(st.totalStrengthExercises, 2);
    assert.equal(st.totalWellnessDays, 2);

    // Check incremental metadata update preserves samples in ride_samples
    store.update(reqOf(store, { put: [{ ...ergRide, title: 'Renamed VO2', samples: [] }] }));
    assert.equal(store.analyticsStatus().totalSamples, 720);

    // Check all 8 AI tools against the upgraded DB
    const search = aiTools.executeTool(store, 'search_rides', { activity_type: 'ride', indoor: true });
    assert.equal(search.totalMatches, 1);
    assert.equal(search.rides[0].title, 'Renamed VO2');

    const detail = aiTools.executeTool(store, 'get_ride_detail', { ride_id: 'ride_erg_1' });
    assert.equal(detail.ride.title, 'Renamed VO2');
    assert.ok(detail.laps.some(l => l.kind === 'fit_lap'));
    assert.ok(detail.laps.some(l => l.kind === 'erg_step' && l.is_work === 1));
    assert.equal(detail.nearbyWellness.length, 2);
    assert.equal(detail.nearbyStrength.length, 1);

    const seg = aiTools.executeTool(store, 'get_ride_segment', { ride_id: 'ride_erg_1', start_s: 120, end_s: 299, bucket_s: 60 });
    assert.equal(seg.bucketCount, 3);
    assert.ok(seg.buckets[0].avg_power >= 235);

    const ivs = aiTools.executeTool(store, 'compare_intervals', { kind: 'erg_step', work_only: true });
    assert.equal(ivs.count, 2);
    assert.ok(ivs.intervals[0].hr_rec_60s > 0);

    const curve = aiTools.executeTool(store, 'get_power_curve', {});
    assert.ok(curve.bests.some(b => b.duration_s === 60 && b.watts >= 238));

    const well = aiTools.executeTool(store, 'get_wellness', { group_by: 'day' });
    assert.equal(well.count, 2);
    assert.equal(well.days.find(d => d.day === '2026-10-09').heavy_legs, 1);

    const str = aiTools.executeTool(store, 'get_strength_history', { exercise: 'squat', leg_only: true });
    assert.equal(str.count, 1);
    assert.equal(str.exercises[0].max_weight_kg, 110);

    const sqlOk = aiTools.executeTool(store, 'run_readonly_sql', { sql: 'SELECT ride_id, avg_watts FROM ride_metrics WHERE activity_type = \'ride\'' });
    assert.equal(sqlOk.rowCount, 1);
    assert.equal(sqlOk.rows[0].avg_watts, 170);

    // Security rejections on run_readonly_sql
    for (const badSql of [
      'DELETE FROM ride_metrics',
      'SELECT * FROM settings',
      'SELECT * FROM rides',
      'SELECT * FROM sqlite_master',
      'PRAGMA table_info(ride_metrics)',
      'SELECT 1; DROP TABLE ride_metrics'
    ]) {
      const bad = aiTools.executeTool(store, 'run_readonly_sql', { sql: badSql });
      assert.ok(bad.error, `Expected rejection for: ${badSql}`);
    }

    // Delete ride cleans all analytics child tables
    store.update(reqOf(store, { del: ['ride_erg_1'] }));
    assert.equal(store.analyticsStatus().indexedRides, 1);
    assert.equal(store.analyticsStatus().totalSamples, 0);
    assert.equal(store.analyticsStatus().totalLaps, 0);
    assert.equal(store.analyticsStatus().totalMmp, 0);
  } finally {
    store.close();
  }
});

test('auto-effort detection extracts unstructured hard efforts when no FIT laps or targets exist', (t) => {
  const dir = makeTempDir(t);
  const store = new LocalStore({ dir, mirrorDir: null });
  try {
    const samples = [];
    for (let i = 0; i < 400; i++) {
      const hard = i >= 100 && i < 160;
      samples.push({ time: i, power: hard ? 250 : 120, hr: hard ? 165 : Math.max(120, 165 - Math.floor((i - 160) / 2)), cadence: hard ? 95 : 85 });
    }
    const ride = {
      id: 'outdoor_1', date: '2026-10-12T07:00:00.000Z', title: 'Outdoor Hill Climb', source: 'Strava',
      duration: 400, avgWatts: 140, np: 175, tss: 15, trainer: false, ftpAtRide: 200, samples
    };
    store.migrate(reqOf(store, { rides: [ride], settings: { apex_velo_profiles: JSON.stringify([{ id: 'p1', ftp: 200, maxHr: 185 }]), apex_velo_active_prof_id: 'p1' } }));
    const detail = aiTools.executeTool(store, 'get_ride_detail', { ride_id: 'outdoor_1' });
    const auto = detail.laps.filter(l => l.kind === 'auto_effort');
    assert.equal(auto.length, 1);
    assert.equal(auto[0].duration_s, 60);
    assert.equal(auto[0].avg_w, 250);
    assert.ok(auto[0].hr_rec_60s > 0);
  } finally {
    store.close();
  }
});

function tPlaceholder() {
  const cleanups = [];
  // fallback helper when test signature doesn't take t (not needed: node:test passes t if param given)
  return { after(fn) { cleanups.push(fn); process.once('exit', () => { for (const f of cleanups) try { f(); } catch {} }); } };
}
