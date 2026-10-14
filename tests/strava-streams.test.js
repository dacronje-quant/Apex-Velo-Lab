const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const ctx = vm.createContext({ window: {} });
for (const file of ['velo-metrics', 'velo-dedupe', 'velo-power', 'velo-strava-sync']) vm.runInContext(fs.readFileSync(`js/${file}.js`, 'utf8'), ctx);
const S = vm.runInContext('VeloStravaSync', ctx), M = vm.runInContext('VeloMetrics', ctx), P = vm.runInContext('VeloPower', ctx);

// 20 min at 300 W, a 30 min cafe stop, then 20 min at 300 W.
const streams = (pause = 1800) => {
  const time = [], watts = [];
  for (let i = 0; i < 1200; i++) { time.push(i); watts.push(300); }
  for (let i = 0; i < 1200; i++) { time.push(1200 + pause + i); watts.push(300); }
  return { time: { data: time }, watts: { data: watts } };
};

test('a pause in a Strava stream starts a new segment instead of joining the efforts', () => {
  const s = S.streamsToSamples(streams());
  assert.equal(s.length, 2400, 'paused seconds are not filled');
  assert.equal(s[1200].segmentStart, true);
  assert.equal(s[1200].time - s[1199].time, 1801, 'the time channel keeps the pause');
  assert.equal(s.filter(x => x.segmentStart).length, 1);
  // A 40-minute best cannot come from two 20-minute halves either side of the stop.
  assert.equal(M.bestRollingAvg(s, 2400), null);
  assert.equal(M.bestRollingAvg(s, 1200), 300);
  // W' recovers across the stop.
  const prep = P.prepare(s);
  assert.deepEqual([...prep.starts], [0, 1200]);
  assert.equal(prep.gaps[1], 1800);
});

test('smart-recording gaps up to 5 s are still held, not treated as pauses', () => {
  const s = S.streamsToSamples({ time: { data: Array.from({ length: 100 }, (_, i) => i < 50 ? i : i + 4) }, watts: { data: Array(100).fill(200) } });
  assert.equal(s.length, 104);
  assert.equal(s.some(x => x.segmentStart), false);
  assert.ok(s.every((x, i) => x.time === i + 1));
});
