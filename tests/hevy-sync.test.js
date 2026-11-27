const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const json = (v) => JSON.parse(JSON.stringify(v));

function loadSyncContext() {
  const ctx = vm.createContext({});
  for (const file of ['velo-metrics', 'velo-dedupe', 'velo-strava-sync', 'velo-hevy-sync']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, `js/${file}.js`), 'utf8'), ctx);
  }
  return {
    H: vm.runInContext('VeloHevySync', ctx),
    S: vm.runInContext('VeloStravaSync', ctx)
  };
}

const sampleWorkout = (overrides = {}) => ({
  id: 'w-101',
  title: 'Lower Body Strength',
  description: '',
  start_time: '2026-11-10T17:00:00Z',
  end_time: '2026-11-10T18:00:00Z',
  updated_at: '2026-11-10T18:05:00Z',
  exercises: [
    {
      title: 'Back Squat (Barbell)',
      notes: '',
      sets: [
        { type: 'warmup', weight_kg: 60, reps: 8, rpe: null },
        { type: 'normal', weight_kg: 100, reps: 5, rpe: 8.5 },
        { type: 'normal', weight_kg: 100, reps: 5, rpe: 8.5 },
        { type: 'normal', weight_kg: 100, reps: 5, rpe: 9 }
      ]
    },
    {
      title: 'Bench Press (Barbell)',
      notes: '',
      sets: [
        { type: 'normal', weight_kg: 75, reps: 8, rpe: 8 },
        { type: 'normal', weight_kg: 80, reps: 6, rpe: 9 }
      ]
    },
    {
      title: 'Plank',
      notes: '',
      sets: [
        { type: 'normal', weight_kg: null, reps: null, duration_seconds: 60, rpe: null },
        { type: 'normal', weight_kg: null, reps: null, duration_seconds: 60, rpe: null }
      ]
    }
  ],
  ...overrides
});

test('VeloHevySync.formatExercise, computeStrengthLoad and toRecord build valid strength records', () => {
  const { H } = loadSyncContext();
  const w = sampleWorkout();

  assert.equal(H.formatExercise(w.exercises[0]), 'Back Squat (Barbell): 3x5 @ 100 kg (RPE 9)');
  assert.equal(H.formatExercise(w.exercises[1]), 'Bench Press (Barbell): 75 kg x 8 (RPE 8), 80 kg x 6 (RPE 9)');
  assert.equal(H.formatExercise(w.exercises[2]), 'Plank: 2x60s');

  const load = H.computeStrengthLoad(w, 3600);
  assert.equal(load.strengthTssMethod, 'sets & RPE');
  assert.equal(load.workingSetCount, 7);
  assert.equal(load.setCount, 8);
  assert.equal(load.volumeKg, 3 * 5 * 100 + 75 * 8 + 80 * 6);
  assert.ok(load.strengthTss > 5 && load.strengthTss <= 60);

  const rec = H.toRecord(w, { profileName: 'Tester' });
  assert.equal(rec.id, 'hevy_w-101');
  assert.equal(rec.source, 'Hevy');
  assert.equal(rec.hevyWorkoutId, 'w-101');
  assert.equal(rec.activityType, 'strength');
  assert.equal(rec.tss, 0);
  assert.equal(rec.duration, 3600);
  assert.equal(rec.heavyLegs, true);
  assert.equal(rec.exercises.length, 3);
  assert.equal(rec.profileName, 'Tester');
});

test('VeloHevySync.plan replaces matching Strava strength duplicates, updates, and removes cleanly', () => {
  const { H } = loadSyncContext();
  const range = H.rangeFor({ mode: 'custom', from: '2026-11-01', to: '2026-11-20' });
  const w1 = sampleWorkout();
  const stravaDup = {
    id: 'strava_777',
    source: 'Strava',
    stravaActivityId: '777',
    strava: { state: 'imported', activityId: '777' },
    title: 'Afternoon Weight Training',
    date: '2026-11-10T17:04:00Z',
    duration: 3550,
    activityType: 'strength',
    sportType: 'WeightTraining',
    avgHr: 128,
    maxHr: 156,
    totalCalories: 410,
    sufferScore: 24,
    tss: 0,
    strengthTss: 24
  };
  const ride = {
    id: 'ride_1',
    source: 'Cockpit',
    title: 'Morning Z2',
    date: '2026-11-10T08:00:00Z',
    duration: 3600,
    activityType: 'ride',
    tss: 55
  };

  // 1. Replace matching Strava strength record while keeping HR, calories & stravaActivityId.
  const p1 = H.plan({ workouts: [w1], history: [ride, stravaDup], range });
  assert.equal(p1.replaced.length, 1);
  assert.equal(p1.added.length, 0);
  const s1 = H.nextState([ride, stravaDup], p1);
  assert.equal(s1.history.length, 2);
  assert.deepEqual(json(s1.del), ['strava_777']);
  const hevyRec = s1.history.find(r => r.id === 'hevy_w-101');
  assert.ok(hevyRec);
  assert.equal(hevyRec.source, 'Hevy');
  assert.equal(hevyRec.avgHr, 128);
  assert.equal(hevyRec.maxHr, 156);
  assert.equal(hevyRec.totalCalories, 410);
  assert.equal(hevyRec.sufferScore, 24);
  assert.equal(hevyRec.stravaActivityId, '777');
  assert.equal(hevyRec.strava.linkedBy, 'hevy');

  // 2. Re-syncing same workout is idempotent.
  const p2 = H.plan({ workouts: [w1], history: s1.history, range });
  assert.equal(p2.hasChanges, false);
  assert.equal(p2.unchanged, 1);

  // 3. Adding a new workout and updating an existing one.
  const w2 = sampleWorkout({ id: 'w-202', title: 'Upper Push', start_time: '2026-11-12T17:00:00Z', end_time: '2026-11-12T17:45:00Z', exercises: [sampleWorkout().exercises[1]] });
  const p3 = H.plan({ workouts: [{ ...w1, title: 'Heavy Legs' }, w2], history: s1.history, range });
  assert.equal(p3.updated.length, 1);
  assert.equal(p3.added.length, 1);
  const s3 = H.nextState(s1.history, p3);
  assert.equal(s3.history.length, 3);
  assert.equal(s3.history.find(r => r.id === 'hevy_w-101').title, 'Heavy Legs');
  assert.equal(s3.history.find(r => r.id === 'hevy_w-202').heavyLegs, false);

  // 4. Removing an in-range Hevy workout no longer present in Hevy.
  const p4 = H.plan({ workouts: [w2], history: s3.history, range });
  assert.equal(p4.removed.length, 1);
  assert.equal(p4.removed[0].record.id, 'hevy_w-101');
  const s4 = H.nextState(s3.history, p4);
  assert.equal(s4.history.length, 2);
  assert.equal(s4.history.some(r => r.id === 'hevy_w-101'), false);
});

test('VeloStravaSync skips Strava strength when skipStrength=true and dedupes cleanly when false', () => {
  const { H, S } = loadSyncContext();
  const range = S.rangeFor({ mode: 'custom', from: '2026-11-01', to: '2026-11-20' });
  const hevyRec = H.toRecord(sampleWorkout());
  const stravaRide = {
    id: '888', name: 'Evening Ride', type: 'Ride', sport_type: 'Ride',
    start_date: '2026-11-11T17:00:00Z', moving_time: 3600, elapsed_time: 3600,
    distance: 32000, average_watts: 200, detailed: true
  };
  const stravaStrength = {
    id: '777', name: 'Weight Training', type: 'WeightTraining', sport_type: 'WeightTraining',
    start_date: '2026-11-10T17:02:00Z', moving_time: 3500, elapsed_time: 3600,
    average_heartrate: 130, max_heartrate: 158, calories: 420, suffer_score: 26, detailed: true
  };

  // skipStrength = true: Strava strength is ignored; ride is imported; Hevy record untouched and not stale-linked.
  const linkedHevy = { ...hevyRec, stravaActivityId: '777', strava: { state: 'found', activityId: '777' } };
  const pSkip = S.plan({ activities: [stravaRide, stravaStrength], history: [linkedHevy], range, opts: { skipStrength: true } });
  assert.equal(pSkip.skippedStrength, 1);
  assert.equal(pSkip.new.length, 1);
  assert.equal(pSkip.new[0].activity.id, '888');
  assert.equal(pSkip.staleLinks.length, 0);
  const nextSkip = S.nextState([linkedHevy], pSkip);
  assert.equal(nextSkip.history.length, 2);
  assert.deepEqual(json(S.validate([linkedHevy], nextSkip.history, pSkip)), []);

  // skipStrength = false: Strava strength links to unlinked Hevy record via VeloDedupe without doubling up,
  // and combineRecord preserves Hevy's title, exercises & strengthTss while filling HR/calories.
  const pNoSkip = S.plan({ activities: [stravaStrength], history: [hevyRec], range, opts: { skipStrength: false } });
  assert.equal(pNoSkip.new.length, 0);
  assert.equal(pNoSkip.linked.length, 1);
  const nextNoSkip = S.nextState([hevyRec], pNoSkip);
  assert.equal(nextNoSkip.history.length, 1);
  const merged = nextNoSkip.history[0];
  assert.equal(merged.id, 'hevy_w-101');
  assert.equal(merged.source, 'Hevy');
  assert.equal(merged.title, 'Lower Body Strength');
  assert.equal(merged.exercises.length, 3);
  assert.equal(merged.strengthTss, hevyRec.strengthTss);
  assert.equal(merged.avgHr, 130);
  assert.equal(merged.totalCalories, 420);
  assert.deepEqual(json(S.validate([hevyRec], nextNoSkip.history, pNoSkip)), []);
});

function startMockHevy() {
  const log = [];
  const workouts = [
    sampleWorkout({ id: 'w-new', start_time: '2026-11-18T17:00:00Z', end_time: '2026-11-18T18:00:00Z' }),
    ...Array.from({ length: 10 }, (_, i) => sampleWorkout({
      id: `w-p1-${i}`,
      title: `Session ${i}`,
      start_time: new Date(Date.parse('2026-11-15T12:00:00Z') - i * 86400000).toISOString().replace('.000Z', 'Z'),
      end_time: new Date(Date.parse('2026-11-15T13:00:00Z') - i * 86400000).toISOString().replace('.000Z', 'Z')
    })),
    sampleWorkout({ id: 'w-old', start_time: '2026-10-01T12:00:00Z', end_time: '2026-10-01T13:00:00Z' })
  ];
  let mode = 'ok';
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    log.push({ method: req.method, path: u.pathname, query: u.search, apiKey: req.headers['api-key'] || null });
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return send(405, { error: 'read-only expected' });
    if (mode === '401' || req.headers['api-key'] !== 'hevy-secret-key') return send(401, { error: 'Unauthorized' });
    if (mode === '429') return send(429, { error: 'Too Many Requests' });
    if (u.pathname === '/v1/workouts') {
      const page = Number(u.searchParams.get('page') || '1');
      const pageSize = Number(u.searchParams.get('pageSize') || '10');
      const slice = workouts.slice((page - 1) * pageSize, page * pageSize);
      return send(200, { page, page_count: Math.ceil(workouts.length / pageSize), workouts: slice });
    }
    return send(404, { error: 'Not found' });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({
      srv,
      log,
      port: srv.address().port,
      setMode: (m) => { mode = m; }
    }));
  });
}

async function waitServer(port, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://localhost:${port}/api/hevy/status`);
      if (r.ok) return true;
    } catch (e) { /* starting */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`server on ${port} did not start within ${ms} ms`);
}

function reservePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

test('server.js /api/hevy/status and /api/hevy/workouts paginate, filter and handle errors', async (t) => {
  const mock = await startMockHevy();
  t.after(() => new Promise(r => mock.srv.close(r)));

  const port = await reservePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-hevy-srv-'));
  const dataDir = path.join(dir, 'data-dir');
  fs.mkdirSync(dataDir);
  fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(dir, 'server.js'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>test</title>');
  fs.writeFileSync(path.join(dir, '.env'), [
    'HEVY_API_KEY=hevy-secret-key',
    `APEX_HEVY_BASE_URL=http://127.0.0.1:${mock.port}`,
    `APEX_PORT=${port}`,
    `APEX_DATA_DIR=${dataDir}`,
    ''
  ].join('\n'));

  const child = spawn(process.execPath, [path.join(dir, 'server.js')], {
    cwd: dir,
    env: { ...process.env, APEX_NO_BROWSER: '1', HEVY_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      try { child.kill(); } catch (e) { resolve(); }
      setTimeout(resolve, 2000);
    });
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  await waitServer(port);

  // Status never leaks the key
  const stRes = await fetch(`http://localhost:${port}/api/hevy/status`);
  assert.equal(stRes.status, 200);
  const stText = await stRes.text();
  assert.equal(stText.includes('hevy-secret-key'), false);
  const st = JSON.parse(stText);
  assert.equal(st.configured, true);
  assert.equal(st.keySource, 'dotenv');

  // Paginated fetch filtered to November stops after page 2 because w-old is before `after`
  const wRes = await fetch(`http://localhost:${port}/api/hevy/workouts?after=${encodeURIComponent('2026-11-01T00:00:00Z')}&before=${encodeURIComponent('2026-11-20T00:00:00Z')}`);
  assert.equal(wRes.status, 200);
  const wData = await wRes.json();
  assert.equal(wData.pages, 2);
  assert.equal(wData.workouts.length, 11);
  assert.equal(wData.workouts.some(w => w.id === 'w-old'), false);
  assert.ok(mock.log.every(x => x.method === 'GET' && x.apiKey === 'hevy-secret-key'));

  // Upstream 401 and 429 surface cleanly
  mock.setMode('401');
  const r401 = await fetch(`http://localhost:${port}/api/hevy/workouts`);
  assert.equal(r401.status, 401);
  assert.equal((await r401.json()).invalidKey, true);

  mock.setMode('429');
  const r429 = await fetch(`http://localhost:${port}/api/hevy/workouts`);
  assert.equal(r429.status, 429);
});

test('server.js /api/hevy/workouts reports missing HEVY_API_KEY cleanly', async (t) => {
  const port = await reservePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-hevy-nokey-'));
  const dataDir = path.join(dir, 'data-dir');
  fs.mkdirSync(dataDir);
  fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(dir, 'server.js'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>test</title>');
  fs.writeFileSync(path.join(dir, '.env'), `APEX_PORT=${port}\nAPEX_DATA_DIR=${dataDir}\n`);

  const child = spawn(process.execPath, [path.join(dir, 'server.js')], {
    cwd: dir,
    env: { ...process.env, APEX_NO_BROWSER: '1', HEVY_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      try { child.kill(); } catch (e) { resolve(); }
      setTimeout(resolve, 2000);
    });
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  await waitServer(port);
  const st = await (await fetch(`http://localhost:${port}/api/hevy/status`)).json();
  assert.equal(st.configured, false);
  assert.equal(st.keySource, null);

  const wRes = await fetch(`http://localhost:${port}/api/hevy/workouts`);
  assert.equal(wRes.status, 400);
  const wBody = await wRes.json();
  assert.equal(wBody.needsKey, true);
});

test('app-history separates Ride log from Strength log and sorts strength metrics', () => {
  const ctx = vm.createContext({
    window: { VeloApp: function () {} },
    document: { querySelectorAll: () => [], getElementById: () => null },
    VeloMetrics: require(path.join(ROOT, 'js/velo-metrics.js')),
    VeloStravaSync: require(path.join(ROOT, 'js/velo-strava-sync.js'))
  });
  ctx.VeloApp = function () {};
  ctx.VeloApp.esc = (v) => String(v ?? '');
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/app-history.js'), 'utf8'), ctx);
  const app = new ctx.VeloApp();
  app.historySortColumn = 'date';
  app.historySortDirection = 'desc';
  app.completedWorkouts = [
    { id: 'ride_1', title: 'Endurance', date: '2026-11-18T08:00:00Z', duration: 3600, activityType: 'ride', tss: 60 },
    { id: 'hevy_a', title: 'Upper', date: '2026-11-19T17:00:00Z', duration: 2400, activityType: 'strength', strengthTss: 22, exercises: ['Bench'], hevy: { workingSetCount: 9, volumeKg: 3200 } },
    { id: 'hevy_b', title: 'Legs', date: '2026-11-20T17:00:00Z', duration: 3600, activityType: 'strength', strengthTss: 48, exercises: ['Squat', 'RDL'], hevy: { workingSetCount: 16, volumeKg: 8400 } }
  ];

  const rides = json(app.getSortedWorkouts());
  assert.equal(rides.length, 1);
  assert.equal(rides[0].id, 'ride_1');

  assert.deepEqual(json(app.getSortedStrengthWorkouts().map(r => r.id)), ['hevy_b', 'hevy_a']);
  app.sortStrengthHistory('volume');
  assert.deepEqual(json(app.getSortedStrengthWorkouts().map(r => r.id)), ['hevy_b', 'hevy_a']);
  app.sortStrengthHistory('volume');
  assert.deepEqual(json(app.getSortedStrengthWorkouts().map(r => r.id)), ['hevy_a', 'hevy_b']);
  app.sortStrengthHistory('sets');
  assert.deepEqual(json(app.getSortedStrengthWorkouts().map(r => r.id)), ['hevy_b', 'hevy_a']);
  app.sortStrengthHistory('load');
  assert.deepEqual(json(app.getSortedStrengthWorkouts().map(r => r.id)), ['hevy_b', 'hevy_a']);
});
