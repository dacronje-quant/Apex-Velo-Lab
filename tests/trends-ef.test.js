const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const ctx = vm.createContext({ window: {} });
for (const f of ['velo-metrics', 'velo-trends']) vm.runInContext(fs.readFileSync(`js/${f}.js`, 'utf8'), ctx);
const T = vm.runInContext('VeloTrends', ctx);
const ride = (fn, n = 3600) => ({ date: '2026-09-01T07:00:00Z', ftpAtRide: 250, samples: Array.from({ length: n }, (_, i) => ({ time: i + 1, ...fn(i) })) });

test('a steady ride gets an Efficiency Factor', () => {
  const e = T.efOf(ride(() => ({ power: 180, hr: 135 })));
  assert.equal(e.ef, 1.33);
});

test('HR dropouts during the hard efforts cannot make an interval session look steady', () => {
  // 3 min at 330 W / 2 min at 120 W; the strap loses contact in every hard effort.
  const intervals = ride(i => (i % 300) < 180 ? { power: 330, hr: 0 } : { power: 160, hr: 125 }, 7200);
  assert.equal(T.efOf(intervals), null);
});

test('a few seconds of lost HR on a steady ride still count', () => {
  const e = T.efOf(ride(i => ({ power: 180, hr: i % 50 === 0 ? 0 : 135 })));
  assert.ok(e && e.ef === 1.33);
});
