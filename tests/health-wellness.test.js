/**
 * APEX VELO // LAB - Analytics > Health numbers (js/velo-wellness.js).
 * Run: node tests/health-wellness.test.js
 */
const assert = require('assert');
const W = require('../js/velo-wellness.js');

let n = 0;
const check = (name, fn) => { fn(); n++; console.log('ok  ' + name); };
const day = (i) => W.addDays('2026-10-17', -i);
/** i days before 17 Oct, newest last. */
const series = (count, fn) => Array.from({ length: count }, (_, k) => ({ day: day(count - 1 - k), ...fn(count - 1 - k) }));

check('values: missing metrics are null; Apple Health HRV counts as SDNN, intervals.icu keeps both kinds', () => {
  assert.strictEqual(W.value({ day: '2026-10-17', rhr: 50 }, 'sleepHr'), null);
  assert.strictEqual(W.value({ day: '2026-10-17', hrv: 55 }, 'hrvSdnn'), 55, 'Apple Health day: hrv is the watch SDNN');
  assert.strictEqual(W.value({ day: '2026-10-17', hrv: 70, hrvSrc: 'icu', hrvSdnn: 52 }, 'hrvSdnn'), 52);
  assert.strictEqual(W.value({ day: '2026-10-17', hrv: 70, hrvSrc: 'icu' }, 'hrvSdnn'), null, 'an intervals.icu rMSSD is never shown as SDNN');
  assert.deepStrictEqual(W.present([{ day: '2026-10-17', rhr: 50, steps: 4000 }]), ['rhr', 'steps']);
});

check('tile stats: latest, last 30 days and the 30 before', () => {
  const days = series(60, (i) => ({ rhr: i < 30 ? 48 : 52 }));
  const s = W.stats(days, 'rhr', '2026-10-17', 30);
  assert.deepStrictEqual([s.last, s.avg, s.prev, s.n, s.nPrev], [48, 48, 52, 30, 30]);
  assert.strictEqual(W.stats(days, 'steps', '2026-10-17'), null);
});

check('7-day trailing average uses calendar days, so a gap does not stretch the window', () => {
  const pts = [{ t: 0, v: 10 }, { t: 86400000, v: 20 }, { t: 10 * 86400000, v: 40 }];
  assert.deepStrictEqual(W.trailing(pts, 7).map(p => p.v), [10, 15, 40]);
});

check('normal band: 60 days before each day on a log scale, from 14 values', () => {
  const days = series(40, (i) => ({ hrv: i % 2 ? 50 : 70 }));
  const band = W.normalBand(days, 'hrv');
  assert.strictEqual(band.length, 40 - 14, 'the first 14 days have no band');
  const last = band[band.length - 1];
  assert.ok(last.lo < last.mid && last.mid < last.hi);
  assert.ok(Math.abs(last.mid - Math.sqrt(50 * 70)) < 0.6, 'geometric mean of 50 and 70');
});

check('weekly averages start on Monday', () => {
  const t = (d) => new Date(d + 'T12:00:00').getTime();
  const w = W.weekly([{ t: t('2026-10-12'), v: 1 }, { t: t('2026-10-18'), v: 3 }, { t: t('2026-10-19'), v: 10 }]);
  assert.deepStrictEqual(w.map(x => [new Date(x.t).getDay(), x.v, x.n]), [[1, 2, 2], [1, 10, 1]]);
});

check('sleep mix: averages, stage shares from staged nights only, shortest and longest night', () => {
  const days = [
    { day: '2026-10-15', sleepH: 8, deepH: 1.2, coreH: 5, remH: 1.8 },
    { day: '2026-10-16', sleepH: 6, deepH: 1, coreH: 3.6, remH: 1.4 },
    { day: '2026-10-17', sleepH: 7 }
  ];
  const m = W.sleepMix(days, '2026-10-01', '2026-10-17');
  assert.strictEqual(m.nights, 3); assert.strictEqual(m.staged, 2);
  assert.strictEqual(m.sleepH, 7);
  assert.ok(Math.abs(m.deepH - 1.1) < 1e-9 && Math.abs(m.share.deep - 1.1 / 7) < 1e-9);
  assert.deepStrictEqual([m.shortest.day, m.longest.day], ['2026-10-16', '2026-10-15']);
  assert.strictEqual(W.sleepMix(days, '2026-11-01', '2026-11-30'), null);
});

check('load response: next morning grouped by the day before, never counting time before the first ride', () => {
  // HRV 60 after rest, 50 after a 120 TSS day; ride every other day from 20 days ago.
  const rides = [];
  for (let i = 20; i >= 1; i -= 2) rides.push({ day: day(i), tss: 120 });
  const days = series(30, (i) => ({ hrv: rides.some(r => r.day === day(i + 1)) ? 50 : 60, rhr: 50 }));
  const r = W.loadResponse(days, rides, { from: day(29), to: day(0) });
  assert.strictEqual(r.mornings, 20, 'mornings from the day after the first ride');
  const g = Object.fromEntries(r.groups.map(x => [x.key, x]));
  assert.deepStrictEqual([g.rest.n, g.hard.n, g.easy.n, g.mid.n], [10, 10, 0, 0]);
  assert.deepStrictEqual([g.rest.hrv, g.hard.hrv, r.all.hrv], [60, 50, 55]);
  assert.deepStrictEqual([g.rest.dHrv, g.hard.dHrv, g.hard.dRhr], [5, -5, 0]);
  assert.strictEqual(W.loadResponse(days, []), null, 'no rides, no comparison');
});

check('formatting: hours as h:mm, steps with separators, decimals from the catalogue', () => {
  assert.strictEqual(W.fmt('sleepH', 7.5), '7:30');
  assert.strictEqual(W.fmt('steps', 12345.4), '12,345');
  assert.strictEqual(W.fmt('spo2', 96.44), '96.4');
  assert.strictEqual(W.fmt('rhr', null), '--');
});

console.log(`\n${n} checks passed`);
