const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const ctx = vm.createContext({ window: {}, console });
for (const f of ['velo-metrics', 'velo-workouts', 'velo-ai-coach']) vm.runInContext(fs.readFileSync(`js/${f}.js`, 'utf8'), ctx);
const L = vm.runInContext('DEFAULT_WORKOUT_LIBRARY', ctx), C = vm.runInContext('VeloAiCoach', ctx), M = vm.runInContext('VeloMetrics', ctx);

test('planned IF smooths over 30 s like NP: 15/15 s surges are not scored as sustained 150%', () => {
  const iv = [];
  for (let i = 0; i < 40; i++) iv.push({ duration: 15, pctFtp: 150 }, { duration: 15, pctFtp: 50 });
  const load = C.estimateLoad(iv);
  assert.equal(load.durationMin, 20);
  assert.ok(Math.abs(Number(load.if) - 1.0) <= 0.02, load.if);
  // Same answer as NP of the equivalent ride at FTP 100 W.
  const ride = iv.flatMap(x => Array(x.duration).fill(x.pctFtp));
  assert.ok(Math.abs(Number(load.if) * 100 - M.normalizedPower(ride)) <= 1);
});

test('steady sessions are unchanged by smoothing', () => {
  const load = C.estimateLoad([{ duration: 3600, pctFtp: 100 }]);
  assert.deepEqual({ ...load }, { durationMin: 60, if: '1.00', tss: 100 });
});

test('every built-in workout lists the duration, IF and TSS its intervals actually give', () => {
  for (const w of L) {
    const e = C.estimateLoad(w.intervals);
    assert.equal(w.durationMin, e.durationMin, w.id);
    assert.equal(w.tss, e.tss, w.id);
    assert.equal(Number(w.if), Number(e.if), w.id);
  }
});
