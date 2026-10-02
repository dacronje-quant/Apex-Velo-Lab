const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const storage = new Map();
const ctx = vm.createContext({ window: { addEventListener() {} }, navigator: {},
  performance: { now: () => 10000 },
  localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } });
for (const file of ['velo-metrics', 'velo-erg', 'velo-analytics', 'velo-workouts', 'app']) {
  vm.runInContext(fs.readFileSync(`js/${file}.js`, 'utf8'), ctx);
}
const E = vm.runInContext('VeloErg', ctx), App = vm.runInContext('VeloApp', ctx);
const input = { target: 200, cadence: 90, targetCadence: 90, cadenceKnown: true, power: 190, pedalPower: 185, ftp: 200 };
const run = (erg, count, patch = {}) => Array.from({ length: count }, () => erg.tick({ ...input, ...patch }));
const step = (pctFtp, duration, extras = {}) => ({ pctFtp, duration, ...extras });

test('Auto distinguishes steady, sustained, VO2, bursts, torque and ramp test steps', () => {
  const cases = [[step(65, 1800), 'steady'], [step(90, 1200), 'tempo'],
    [step(105, 60), 'tempo'], [step(120, 180), 'responsive'], [step(120, 45), 'responsive'],
    [step(120, 30), 'burst'], [step(170, 15), 'burst'], [step(90, 300, { cadence: 55 }), 'torque']];
  for (const [iv, expected] of cases) assert.equal(E.describe({ category: 'vo2' }, iv).key, expected);
  const ramp = { id: 'ramp', category: 'assessment' };
  assert.equal(E.describe(ramp, step(120, 60)).key, 'assessment');
  assert.equal(E.describe(ramp, step(45, 300)).key, 'steady');
  assert.equal(E.describe(ramp, step(120, 60)).controlMode, 'erg');
});

test('sprints, short intervals, cadence drills and tests all retain ERG', () => {
  for (const iv of [step(180, 15), step(120, 20), step(150, 40, { effort: 'all-out' }),
    step(100, 1200, { name: '20-minute FTP test' }), step(100, 480, { effort: 'test' }),
    step(60, 120, { name: 'Cadence drill' })]) {
    assert.equal(E.describe({}, iv).controlMode, 'erg');
    assert.doesNotMatch(E.describe({}, iv).reason, /resistance\s*\/\s*level|switch.*mode/i);
  }
  assert.equal(E.describe({}, step(120, 30)).controlMode, 'erg');
  assert.equal(E.describe({}, step(120, 180)).controlMode, 'erg');
  assert.equal(E.describe({ category: 'assessment', title: 'Ramp Test' }, step(120, 60)).controlMode, 'erg');
  assert.equal(E.describe({}, step(60, 120, { effort: 'cadence' })).key, 'cadence');
  assert.equal(E.describe({}, step(100, 1200, { effort: 'test' })).key, 'paced');
});

test('explicit intent overrides names, and recovery names do not turn into sprint efforts', () => {
  assert.equal(E.describe({}, step(50, 15, { name: 'Sprint recovery' })).key, 'steady');
  assert.equal(E.describe({}, step(50, 120, { name: 'Recovery after FTP test' })).key, 'steady');
  assert.equal(E.describe({}, step(120, 60, { name: 'Sprint', effort: 'steady' })).key, 'responsive');
  assert.equal(E.describe({ id: 'ramp', category: 'assessment' }, step(100, 1200, { effort: 'test' })).key, 'paced');
});

test('every built-in workout step gets a valid profile without changing workout data', () => {
  const library = vm.runInContext('DEFAULT_WORKOUT_LIBRARY', ctx);
  const before = JSON.stringify(library);
  for (const w of library) for (const iv of w.intervals) {
    const e = new E();
    e.configure(w, iv);
    const target = Math.round(200 * iv.pctFtp / 100);
    const r = e.tick({ ...input, target, power: target, pedalPower: target });
    assert.equal(r.watts, target, `${w.id}: ${iv.name}`);
  }
  assert.equal(JSON.stringify(library), before);
});

test('a 15-second recovery is preserved fully and the burst target is applied immediately', () => {
  const e = new E();
  e.configure({}, step(50, 15));
  for (let left = 14; left >= 0; left--) {
    assert.equal(e.tick({ ...input, target: 100, pedalPower: 100, nextTarget: 300,
      secondsLeft: left, stepDuration: 15, stepKey: 0 }).watts, 100);
  }
  e.configure({}, step(150, 30));
  assert.equal(e.now(300, 1), 300);
  assert.equal(e.tick({ ...input, target: 300, stepKey: 1 }).watts, 300);
});

test('steady PowerMatch ignores small noise and responds gently to persistent error', () => {
  const e = new E();
  e.configure({}, step(65, 1800));
  const values = run(e, 30, { pedalPower: 198 });
  assert.ok(values.every(r => r.watts === 200));
  const corrected = run(e, 15);
  assert.ok(e.offset > 0);
  assert.ok(corrected.every((r, i) => !i || r.watts - corrected[i - 1].watts <= 1));
});

test('configure on every tick still allows PowerMatch to settle; responsive corrects sooner', () => {
  const watts = mode => {
    const e = new E();
    return Array.from({ length: 12 }, () => {
      e.configure({}, step(120, 180), mode);
      return e.tick(input).watts;
    });
  };
  const steady = watts('steady'), fast = watts('responsive');
  assert.ok(steady.slice(0, 8).every(w => w === 200));
  assert.ok(fast.slice(0, 5).every(w => w === 200));
  assert.ok(fast[5] > 200);
  assert.ok(fast[11] > steady[11]);
});

test('bursts hold proportional calibration instead of chasing transient under-power', () => {
  const e = new E();
  e.configure({}, step(90, 300));
  run(e, 20);
  const learned = e.offset;
  assert.ok(learned > 0);
  e.configure({}, step(150, 30));
  const commanded = e.now(300, 1);
  assert.equal(e.offset, Math.round(learned * 1.5));
  const burst = run(e, 30, { target: 300, power: 200, pedalPower: 200, stepKey: 1 });
  assert.ok(burst.every(r => r.watts === commanded));
  e.configure({}, step(50, 120));
  e.now(100, 2);
  const recoveryTrim = e.offset;
  run(e, 12, { target: 100, power: 110, pedalPower: 110, stepKey: 2 });
  assert.ok(e.offset < recoveryTrim);
});

test('manual response overrides still preserve burst protection and ramp-test failure handling', () => {
  const e = new E();
  e.configure({}, step(150, 20), 'responsive');
  assert.equal(e.profile.key, 'responsive');
  run(e, 30, { target: 300, pedalPower: 200 });
  assert.equal(e.offset, 0);
  e.configure({ id: 'ramp', category: 'assessment' }, step(120, 60), 'steady');
  assert.equal(e.profile.test, true);
  assert.equal(run(e, 3, { target: 240, cadence: 50, power: 150 })[2].event, 'test-stop');
});

test('low cadence at target power is respected; a real stall still eases the load', () => {
  const e = new E();
  e.configure({}, step(100, 300, { cadence: 55 }));
  e.softStart({ target: 200, cadence: 55, cadenceKnown: true, targetCadence: 55 });
  assert.equal(e.ramp, null);
  assert.ok(run(e, 12, { targetCadence: 55, cadence: 55, power: 200, pedalPower: 200 }).every(r => r.watts === 200));
  run(e, 12, { targetCadence: 55, cadence: 45, power: 200, pedalPower: 180 });
  assert.equal(e.offset, 0);
  const stall = run(e, 3, { targetCadence: 55, cadence: 30, power: 70, pedalPower: 70 });
  assert.equal(stall[2].event, 'stall');
  assert.equal(stall[2].watts, 120);
  assert.ok(run(e, 6, { targetCadence: 55, cadence: 60, power: 200, pedalPower: null }).at(-1).watts === 200);
});

test('a recovery cancels a previous stalled load cap and gets its full target immediately', () => {
  const e = new E();
  e.configure({}, step(150, 180));
  run(e, 3, { target: 300, cadence: 30, power: 80, pedalPower: null, stepKey: 0 });
  assert.ok(e.ramp);
  e.configure({}, step(50, 120));
  assert.equal(e.now(100, 1), 100);
  assert.equal(e.ramp, null);
});

test('same-watt new steps reset settling and stall history; reset clears step identity', () => {
  const e = new E();
  e.configure({}, step(100, 60));
  run(e, 12, { stepKey: 1 });
  e.lowCadSec = 2;
  e.now(200, 2);
  assert.equal(e.lowCadSec, 0);
  assert.equal(e.pmSettle, e.o.pmSettleSec);
  e.reset();
  assert.equal(e.lastStepKey, null);
  assert.equal(e.offset, 0);
});

test('sensor loss clears PowerMatch, and absent cadence does not invent a stall', () => {
  const e = new E();
  e.configure({}, step(90, 300));
  run(e, 20);
  assert.ok(e.offset > 0);
  const missing = run(e, 10, { pedalPower: null, power: null, cadenceKnown: false, cadence: 0 });
  assert.equal(e.offset, 0);
  assert.ok(missing.every(r => r.watts === 200 && r.event === null));
});

test('rapid cadence changes pause meter corrections in either direction, then resume at steady cadence', () => {
  for (const cadence of [105, 75]) {
    const e = new E();
    e.configure({}, step(90, 300));
    run(e, 20);
    const before = e.offset;
    const transient = run(e, 3, { cadence, pedalPower: cadence > 90 ? 230 : 150 });
    assert.equal(e.offset, before);
    assert.ok(transient.every(r => r.watts === 200 + Math.round(before)));
    run(e, 8, { cadence, pedalPower: 185 });
    assert.ok(e.offset > before);
  }
});

test('long cadence drills and paced tests still correct sustained meter error in ERG', () => {
  for (const effort of ['cadence', 'test']) {
    const e = new E();
    e.configure({}, step(100, 1200, { effort }));
    assert.equal(e.o.pmFreeze, false);
    run(e, 20);
    assert.ok(e.offset > 0);
    assert.equal(e.profile.controlMode, 'erg');
  }
});

function appFixture(intervals, category = 'vo2') {
  const app = Object.create(App.prototype), commands = [];
  const noOp = () => {};
  Object.assign(app, { currentWorkout: { id: category === 'assessment' ? 'ramp' : 'test', category, intervals },
    intervalIndex: 0, intervalSecondsRemaining: intervals[0].duration, totalElapsedSeconds: 0,
    activeProfile: { ftp: 200 }, ergBiasMultiplier: 1, ergModeEnabled: true, ergResponse: 'auto',
    powerMatchEnabled: true, isPlaying: true, erg: new E(), simulator: { enabled: false, step: noOp },
    blePedal: { lastTime: 10000, watts: 100, cadence: 90, leftPct: null, rightPct: null },
    bleTrainer: { lastTime: 10000, watts: 100, cadence: 90, speed: null, distanceMeters: null },
    bleHr: { lastTime: -1e9, hr: null },
    ble: { isTrainerConnected: () => true, getState: () => 'connected',
      setTrainerErgPower: w => commands.push(w), pauseTrainerWorkout: noOp },
    clock: { stop: noOp }, audio: { countdownTick: noOp, intervalGo: noOp },
    analytics: new (vm.runInContext('VeloAnalytics', ctx))(200), powerBuffer: [], recordedSamples: [],
    totalDistanceMeters: 0, currentSpeed: 0, maxSpeedKmh: 0, rideHadHardware: true,
    activeTab: 'cockpit', updateStandUi: noOp, updateHudDisplays: noOp, updateTelemetryChart: noOp,
    updatePowerSourceBadge: noOp, updateHudTitles: noOp, renderIntervalTrack: noOp, updateIntervalCountdown: noOp,
    updatePlaybackControlsUi: noOp, releaseWakeLock: noOp, showToast: noOp });
  return { app, commands };
}

test('workout engine commands the new interval exactly at the boundary', () => {
  const { app, commands } = appFixture([step(50, 15), step(150, 30)]);
  for (let i = 0; i < 15; i++) app.tick1Hz();
  assert.deepEqual(commands, [...Array(15).fill(100), 300]);
  assert.ok(app.recordedSamples.every(s => s.target === 100));
  assert.equal(app.intervalIndex, 1);
  assert.equal(app.intervalSecondsRemaining, 30);
  assert.equal(app.erg.profile.key, 'burst');
});

test('ramp failure pauses the workout, retains measured samples and never commands an eased test load', () => {
  const { app, commands } = appFixture([step(120, 60)], 'assessment');
  app.blePedal.watts = 140; app.blePedal.cadence = 50;
  app.tick1Hz(); app.tick1Hz(); app.tick1Hz();
  assert.equal(app.isPlaying, false);
  assert.equal(app.erg.mode, 'test-stop');
  assert.deepEqual(commands, [240, 240]);
  assert.equal(app.recordedSamples.length, 3);
  assert.equal(app.recordedSamples[2].power, 140);
});

test('response preference is saved, applies immediately, and invalid selections are ignored', () => {
  const { app, commands } = appFixture([step(90, 300)]);
  app.$ = () => null; app.setText = () => {};
  app.setErgResponse('steady');
  assert.equal(storage.get('apex_erg_response'), 'steady');
  assert.equal(app.erg.profile.key, 'steady');
  assert.equal(commands.at(-1), 180);
  app.setErgResponse('anything');
  assert.equal(app.ergResponse, 'steady');
});
