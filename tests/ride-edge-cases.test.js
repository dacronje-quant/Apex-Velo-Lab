const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ctx = vm.createContext({ window: { addEventListener() {} }, navigator: {} });
for (const file of ['velo-metrics', 'velo-importer', 'velo-insight', 'velo-analytics', 'velo-export', 'velo-strava-sync', 'app']) {
  vm.runInContext(fs.readFileSync(`js/${file}.js`, 'utf8'), ctx);
}
const get = name => vm.runInContext(name, ctx);
const M = get('VeloMetrics'), I = get('VeloRideImporter'), F = get('VeloInsight');
const A = get('VeloAnalytics'), E = get('VeloExport'), S = get('VeloStravaSync'), App = get('VeloApp');
const block = (n, start = 0, power = 200) => Array.from({ length: n }, (_, i) => ({ time: start + i, power }));

test('numeric-string times interpolate as seconds without mutating the source', () => {
  const input = [{ time: '10', power: 100 }, { time: '15', power: 200 }];
  const result = M.toOneHz(input);
  assert.deepEqual(Array.from(result, s => s.time), [10, 11, 12, 13, 14, 15]);
  assert.equal(input[0].time, '10');
});

test('invalid timed rows cannot inflate duration or crash energy calculations', () => {
  const result = I.summarize([null, { time: NaN, power: 999 }, { time: 0, power: 100 }], 200, {});
  assert.equal(result.duration, 1);
  assert.equal(M.workKjFromSamples(result.samples), 0.1);
});

test('short ride NP fallback includes coasting', () => {
  const ride = I.summarize([...block(10), ...block(10, 10, 0)], 200, {});
  assert.equal(ride.avgWatts, 100);
  assert.equal(ride.np, 100);
});

test('explicit short pause skips interpolation and splits peak windows', () => {
  const samples = M.toOneHz([...block(15), { time: 19, power: 200, segmentStart: true }, ...block(14, 20)]);
  assert.equal(samples.length, 30);
  assert.equal(M.bestRollingAvg(samples, 30), null);
  assert.equal(M.normalizedPower(samples), 0);
});

test('live pause retains totals and bests but starts fresh rolling windows', () => {
  const a = new A(200);
  for (let i = 0; i < 20; i++) a.update(100);
  a.startSegment();
  for (let i = 0; i < 20; i++) a.update(300);
  assert.equal(a.totalSeconds, 40);
  assert.equal(a.totalJoules, 8000);
  assert.equal(a.normalizedPower, 0);
  assert.equal(a.getLiveMmp()[2], null); // no continuous 30 seconds
  assert.equal(a.getLiveMmp()[0], 300);
});

test('Pause/Resume clears cockpit smoothing and marks the next recorded segment', () => {
  const a = Object.create(App.prototype);
  Object.assign(a, {
    isPlaying: false, isWorkoutCompleted: false, intervalIndex: 0,
    currentWorkout: { intervals: [{ duration: 300 }] },
    recordedSamples: block(20), powerBuffer: [100, 100], analytics: new A(),
    audio: { init() {} }, ble: { startTrainerWorkout() {}, pauseTrainerWorkout() {} },
    clock: { stop() {} }, ergApplyNow() {}, start1HzTimer() {}, acquireWakeLock() {},
    updatePlaybackControlsUi() {}, updatePowerSourceBadge() {}, releaseWakeLock() {}
  });
  a.togglePlayPause();
  assert.equal(a.powerBuffer.length, 0);
  assert.equal(a._nextSampleStartsSegment, true);
});

test('on-target streak cannot bridge a pause', () => {
  const samples = [...block(20), ...block(20, 100)].map(s => ({ ...s, target: 200 }));
  assert.equal(F.longestOnTarget(samples).seconds, 20);
});

test('HR recovery requires uninterrupted recovery time', () => {
  const samples = [...block(40, 0, 250), ...block(40, 40, 100), ...block(40, 200, 100), ...block(80, 240, 100)]
    .map((s, i) => ({ ...s, target: s.power, hr: i < 40 ? 170 : 140 }));
  assert.equal(F.hrRecovery(samples, 200, 180), null);
});

test('Strava short stream uses measured average instead of summary estimate', () => {
  const r = S.toRecord({ id: 1, sport_type: 'Ride', start_date: '2026-09-20T00:00:00Z',
    moving_time: 20, average_watts: 999, samples: [...block(10), ...block(10, 10, 0)] }, { ftp: 200 });
  assert.equal(r.np, 100);
  assert.equal(r.avgWatts, 100);
});

test('long ride export and Strava summary avoid argument-count limits', () => {
  const samples = block(180000).map(s => ({ ...s, speed: 30 }));
  assert.equal(E.totals({}, samples).maxSpeed, 30);
  assert.equal(S.toRecord({ id: 2, sport_type: 'Ride', start_date: '2026-09-20T00:00:00Z',
    moving_time: samples.length, samples }, { ftp: 200 }).maxWatts, 200);
});

test('export duration fallback counts active time', () => {
  assert.equal(E.totals({}, [...block(30), ...block(30, 300)]).duration, 60);
});

test('CSV round-trip preserves short pause markers', () => {
  const samples = [...block(15), ...block(15, 15)]; samples[15].segmentStart = true;
  const ride = { date: '2026-09-20T00:00:00Z', duration: 30 };
  const imported = I.parseCsv(E.buildCsv(ride, samples), 'Test', 200);
  assert.equal(imported.samples[15].segmentStart, true);
  assert.equal(M.bestRollingAvg(imported.samples, 30), null);
});

test('FIT round-trip preserves explicit short pauses and active work', () => {
  const samples = [...block(15), ...block(15, 19)]; samples[15].segmentStart = true;
  const bytes = E.buildFit({ date: '2026-09-20T00:00:00Z', duration: 30 }, samples);
  const imported = I.parseFit(bytes.buffer, 'Test', 200);
  assert.equal(imported.duration, 30);
  assert.equal(imported.kj, 6);
  assert.equal(imported.samples[15].segmentStart, true);
  assert.equal(M.bestRollingAvg(imported.samples, 30), null);
});

test('live NP matches post-ride NP after multiple pauses', () => {
  const a = new A(200), samples = [];
  for (const power of [100, 300, 200]) {
    if (samples.length) a.startSegment();
    for (let i = 0; i < 45; i++) {
      a.update(power); samples.push({ time: samples.length, power, segmentStart: samples.length > 0 && i === 0 });
    }
  }
  assert.equal(a.normalizedPower, M.normalizedPower(samples));
  assert.deepEqual(Array.from(a.getLiveMmp()), Array.from(M.mmpCurve(samples)));
  assert.equal(a.totalJoules, M.workKjFromSamples(samples) * 1000);
});

// Read the emitted binary fields independently of VeloRideImporter's round-trip logic.
function readFitMessages(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const defs = {}, messages = [];
  const end = view.getUint8(0) + view.getUint32(4, true);
  let at = view.getUint8(0);
  while (at < end) {
    const header = view.getUint8(at++), local = header & 15;
    if (header & 64) {
      const little = view.getUint8(at + 1) === 0;
      const global = view.getUint16(at + 2, little), count = view.getUint8(at + 4);
      at += 5;
      const fields = [];
      for (let i = 0; i < count; i++, at += 3) fields.push({ number: view.getUint8(at), size: view.getUint8(at + 1) });
      defs[local] = { global, little, fields };
    } else {
      const def = defs[local], values = {};
      for (const field of def.fields) {
        values[field.number] = field.size === 1 ? view.getUint8(at) : field.size === 2 ? view.getUint16(at, def.little) : view.getUint32(at, def.little);
        at += field.size;
      }
      messages.push({ global: def.global, values });
    }
  }
  return messages;
}

test('raw smart-recording FIT export retains short interpolation', () => {
  const samples = [{ time: 0, power: 100 }, { time: 5, power: 200 }];
  const bytes = E.buildFit({ date: '2026-09-20T00:00:00Z' }, samples);
  const result = I.parseFit(bytes.buffer, 'Test', 200);
  assert.equal(result.duration, 6);
  assert.equal(M.workKjFromSamples(result.samples), 0.7);
  assert.equal(readFitMessages(bytes).filter(m => m.global === 21).length, 2);
});

test('FIT event intervals agree with timer totals for both zero- and one-based sample times', () => {
  for (const firstTime of [0, 1]) {
    const t0 = Date.parse('2026-09-20T00:00:00Z'), samples = [];
    let gap = 0;
    for (const [segment, seconds] of [15, 35, 45].entries()) {
      if (segment) gap += segment === 1 ? 5 : 101;
      for (let i = 0; i < seconds; i++) {
        const time = samples.length + firstTime;
        samples.push({ time, timestamp: t0 + (time + gap) * 1000, power: 200, segmentStart: segment > 0 && i === 0 });
      }
    }
    const messages = readFitMessages(E.buildFit({ date: new Date(t0).toISOString(), duration: 95 }, samples));
    let start = null, active = 0;
    for (const { global, values } of messages) if (global === 21) {
      if (values[1] === 0) start = values[253];
      else { assert.notEqual(start, null); active += values[253] - start; start = null; }
    }
    const session = messages.find(m => m.global === 18).values;
    assert.equal(active, 95);
    assert.equal(session[8], 95000);
    assert.equal(session[7], 201000); // 95 active + 106 paused seconds
  }
});

test('100 varied paused rides agree with independently calculated segment windows', () => {
  let seed = 12345;
  const random = limit => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
  for (let trial = 0; trial < 100; trial++) {
    const segments = Array.from({ length: 3 }, () => Array.from({ length: 15 + random(85) }, () => random(501)));
    const samples = [], a = new A(200);
    let time = 0;
    for (const [segment, powers] of segments.entries()) {
      if (segment) { a.startSegment(); time += 12 + random(90); }
      powers.forEach((power, i) => { a.update(power); samples.push({ time: time++, power, segmentStart: segment > 0 && i === 0 }); });
    }
    const means = size => segments.flatMap(powers => Array.from({ length: Math.max(0, powers.length - size + 1) }, (_, start) =>
      powers.slice(start, start + size).reduce((sum, power) => sum + power, 0) / size));
    for (const size of [5, 15, 30, 60, 120]) {
      const values = means(size);
      assert.equal(M.bestRollingAvg(samples, size), values.length ? Math.round(Math.max(...values)) : null);
    }
    const values = means(30);
    const np = values.length ? Math.round((values.reduce((sum, value) => sum + value ** 4, 0) / values.length) ** 0.25) : 0;
    assert.equal(M.normalizedPower(samples), np);
    assert.equal(a.normalizedPower, np);
    assert.deepEqual(Array.from(a.getLiveMmp()), Array.from(M.mmpCurve(samples)));
  }
});
