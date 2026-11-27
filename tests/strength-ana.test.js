const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const S = require(path.join(__dirname, '../js/velo-strength-ana.js'));

const mkSession = (id, date, exercises, extra = {}) => ({
  id,
  source: 'Hevy',
  title: extra.title || 'Full Body',
  date,
  duration: extra.duration || 3600,
  activityType: 'strength',
  strengthTss: extra.strengthTss || 40,
  heavyLegs: extra.heavyLegs ?? true,
  exercises,
  hevy: extra.hevy
});

test('VeloStrengthAnalytics.parseExercises handles collapsed sets, mixed RPE sets, bodyweight and timed sets', () => {
  const rec = mkSession('hevy_1', '2026-11-22T09:00:00Z', [
    'Squat (Barbell): 3x5 @ 110 kg (RPE 8)',
    'Bench Press (Barbell): 60 kg x 10 (RPE 6), 80 kg x 6 (RPE 9)',
    'Pull Up: 3x10',
    'Plank: 2x60s'
  ]);
  const parsed = S.parseExercises(rec);
  assert.equal(parsed.length, 4);

  assert.equal(parsed[0].title, 'Squat (Barbell)');
  assert.equal(parsed[0].muscleGroup, 'legs');
  assert.equal(parsed[0].sets, 3);
  assert.equal(parsed[0].volumeKg, 1650);
  assert.equal(parsed[0].bestWeightKg, 110);
  assert.equal(parsed[0].bestE1rmKg, 128.5); // 110 * (1 + 5/30) = 128.33 -> nearest 0.5 = 128.5
  assert.equal(parsed[0].avgRpe, 8);

  assert.equal(parsed[1].muscleGroup, 'chest');
  assert.equal(parsed[1].sets, 2);
  assert.equal(parsed[1].volumeKg, 1080);
  assert.equal(parsed[1].bestWeightKg, 80);
  assert.equal(parsed[1].bestE1rmKg, 96);

  assert.equal(parsed[2].muscleGroup, 'back');
  assert.equal(parsed[2].sets, 3);
  assert.equal(parsed[2].volumeKg, 0);

  assert.equal(parsed[3].muscleGroup, 'core');
  assert.equal(parsed[3].sets, 2);
});

test('VeloStrengthAnalytics computes kpis, weekly buckets, lift progression, muscle split and PRs', () => {
  const now = new Date('2026-11-22T20:00:00Z');
  const workouts = [
    // Previous 6w window (~55 days ago)
    mkSession('h0', '2026-09-28T09:00:00Z', ['Squat (Barbell): 3x5 @ 95 kg', 'Lat Pulldown (Cable): 3x10 @ 60 kg'], { strengthTss: 32 }),
    // Current 6w window
    mkSession('h1', '2026-11-08T09:00:00Z', ['Squat (Barbell): 3x5 @ 105 kg', 'Bench Press (Barbell): 3x6 @ 75 kg'], { strengthTss: 38 }),
    mkSession('h2', '2026-11-15T09:00:00Z', ['Squat (Barbell): 3x5 @ 110 kg', 'Bench Press (Barbell): 3x6 @ 80 kg', 'Triceps Pushdown: 3x12 @ 20 kg'], { strengthTss: 44 }),
    mkSession('h3', '2026-11-22T09:00:00Z', ['Squat (Barbell): 3x5 @ 115 kg', 'Deadlift (Barbell): 2x5 @ 130 kg'], { strengthTss: 48 }),
    // Cycling ride must be ignored
    { id: 'ride_1', activityType: 'ride', date: '2026-11-21T08:00:00Z', duration: 3600, tss: 70 }
  ];

  const kpi = S.kpis(workouts, 42, now);
  assert.equal(kpi.cur.sessions, 3);
  assert.ok(kpi.prev && kpi.prev.sessions === 1);
  assert.equal(kpi.cur.heavyLegDays, 3);
  assert.ok(kpi.cur.volumeKg > kpi.prev.volumeKg);

  const weekly = S.weekly(workouts, 6, now);
  assert.equal(weekly.length, 6);
  const lastWeek = weekly[weekly.length - 1];
  assert.equal(lastWeek.sessions, 1);
  assert.ok(lastWeek.volumeKg > 0);

  const catalog = S.exerciseCatalog(workouts, 42, now);
  assert.equal(catalog[0].title, 'Squat (Barbell)');
  assert.equal(catalog[0].sessions, 3);
  assert.ok(catalog[0].deltaPct > 0);

  const prog = S.exerciseProgression(workouts, 'Squat (Barbell)', 42, now);
  assert.deepEqual(prog.map(p => p.bestWeightKg), [105, 110, 115]);

  const split = S.muscleSplit(workouts, 42, now);
  assert.ok(split.totalSets > 0);
  const legs = split.groups.find(g => g.key === 'legs');
  assert.ok(legs && legs.sets === 11);

  const rec = S.records(workouts);
  assert.ok(rec.biggestVolume && rec.biggestVolume.r.id === 'h2' || rec.biggestVolume.r.id === 'h3');
  assert.equal(rec.weekStreak, 3);
  assert.ok(rec.topLifts.some(l => l.name === 'Squat' && l.weightKg === 115));
  assert.ok(rec.topLifts.some(l => l.name === 'Deadlift' && l.weightKg === 130));
});

test('VeloStrengthAnalytics.parseExercises handles Motra/Bevel multi-line format and ignores Set/Calories metadata', () => {
  const motra = mkSession('strava_m', '2026-10-25T07:10:52Z', [
    'Tracked with Motra.',
    'TVL: 5.1K  kg',
    'Duration: 31m',
    'Calories: 180',
    'Exercises: 5',
    'Barbell Bench Press',
    'Set 1: 6 reps x 60 kg',
    'Set 2: 6 reps x 80 kg',
    'Superset',
    'Kneeling Crunch · Cable (Single)',
    'Set 1 — 47,5 kg × 20'
  ], { source: 'Strava' });
  const parsed = S.parseExercises(motra);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].title, 'Bench Press (Barbell)');
  assert.equal(parsed[0].muscleGroup, 'chest');
  assert.equal(parsed[0].sets, 2);
  assert.equal(parsed[0].bestWeightKg, 80);
  assert.equal(parsed[1].title, 'Cable Crunch');
  assert.equal(parsed[1].bestWeightKg, 47.5);
});

test('VeloStrengthAnalytics.canonicalName groups equivalent lifts and monthly() aggregates long history', () => {
  assert.equal(S.canonicalName('Barbell Bench Press'), 'Bench Press (Barbell)');
  assert.equal(S.canonicalName('Back Squat · Barbell'), 'Squat (Barbell)');
  assert.equal(S.canonicalName('Barbell Back Squat'), 'Squat (Barbell)');
  assert.equal(S.canonicalName('Standing Military Press (Barbell)'), 'Overhead Press (Barbell)');
  assert.equal(S.canonicalName('Barbell Overhead Press / Military Press'), 'Overhead Press (Barbell)');
  assert.equal(S.canonicalName('Straight Leg Deadlift'), 'Romanian Deadlift (Barbell)');
  assert.equal(S.canonicalName('Pulldown (Wide Parellel Grip)'), 'Lat Pulldown');
  assert.equal(S.canonicalName('Cable Lat Pull Down Wide Hammer'), 'Lat Pulldown');
  assert.equal(S.canonicalName('Triceps Extension (Cable)'), 'Triceps Pushdown (Cable)');
  assert.equal(S.canonicalName('Rope Cable Triceps Pushdown · Cable (Single)'), 'Triceps Pushdown (Cable)');
  assert.equal(S.canonicalName('Row (Hammer machine)'), 'Machine Row');

  const workouts = [
    mkSession('m1', '2025-10-05T09:00:00Z', ['Barbell Bench Press: 3x5 @ 90 kg']),
    mkSession('m2', '2025-10-19T09:00:00Z', ['Bench Press (Barbell): 3x5 @ 92.5 kg']),
    mkSession('m3', '2026-01-10T09:00:00Z', ['Bench Press (Barbell): 3x5 @ 95 kg'])
  ];
  const cat = S.exerciseCatalog(workouts, 0);
  assert.equal(cat.length, 1);
  assert.equal(cat[0].title, 'Bench Press (Barbell)');
  assert.equal(cat[0].sessions, 3);

  const months = S.monthly(workouts, new Date('2026-01-20T00:00:00Z'));
  assert.equal(months.length, 4);
  assert.equal(months[0].sessions, 2);
  assert.equal(months[3].sessions, 1);
});
