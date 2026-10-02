// Ask (js/velo-ask.js): period windows and the training-data text the AI answers from.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const VeloAsk = require('../js/velo-ask.js');

const now = new Date(2026, 9, 2, 15, 30); // 2 Oct 2026, local time

test('preset periods end today and cover the stated number of days', () => {
  for (const p of VeloAsk.PERIODS.filter(x => x.days > 0)) {
    const r = VeloAsk.range(p.key, now);
    assert.equal(r.days, p.days, p.key);
    assert.equal(VeloAsk.dayKey(r.to), '2026-10-02');
    assert.equal(r.label, p.label);
  }
  assert.equal(VeloAsk.dayKey(VeloAsk.range('7d', now).from), '2026-09-26');
});

test('all history starts at the first activity; unknown keys fall back to 6 weeks', () => {
  const r = VeloAsk.range('all', now, { firstTs: new Date(2025, 0, 15, 9).getTime() });
  assert.equal(VeloAsk.dayKey(r.from), '2025-01-15');
  assert.equal(VeloAsk.range('nope', now).key, '6w');
});

test('custom dates are inclusive and swapped when reversed', () => {
  const r = VeloAsk.range('custom', now, { fromKey: '2026-09-10', toKey: '2026-09-01' });
  assert.equal(VeloAsk.dayKey(r.from), '2026-09-01');
  assert.equal(VeloAsk.dayKey(r.to), '2026-09-10');
  assert.equal(r.days, 10);
  assert.equal(r.label, '2026-09-01 to 2026-09-10');
});

const base = () => ({
  today: '2026-10-02',
  period: { label: 'Last 6 weeks', from: '2026-08-22', to: '2026-10-02', days: 42 },
  rider: { name: 'Test | Rider', ftp: 250, weightKg: 75, maxHr: 190, lthr: 0 },
  form: { ctl: 42.6, atl: 50.1, tsb: -7.5, formLabel: 'training', ramp: 1.2, rampLabel: 'steady' },
  model: { from: '2026-07-04', to: '2026-10-02', cp: 240, w: 18500, pmax: 900 },
  totals: { cur: { rides: 2, hours: 2.5, km: 70, tss: 150, kj: 1800, avgNp: 210, longestSec: 5400, withPower: 2, withHr: 1 },
    prev: { rides: 1, hours: 1, km: 30, tss: 60, kj: 700, avgNp: 200, longestSec: 3600 }, prevFrom: '2026-07-11', prevTo: '2026-08-21' },
  rides: [
    { date: '2026-10-01', title: 'Threshold\n2x20', dur: 3600, km: 35, avgW: 200, np: 220, ifac: 0.88, tss: 78, kj: 720, avgHr: 150, p5: 260, p20: 230, zone3: [60, 30, 10] },
    { date: '2026-09-20', title: '', dur: 5400, km: 35, avgW: 180 }
  ],
  meanings: [['NP', 'surge-weighted average']]
});

test('build lists every section with measured values only', () => {
  const t = VeloAsk.build(base());
  for (const s of ['TODAY: 2026-10-02', 'PERIOD ASKED ABOUT: Last 6 weeks', 'RIDER:', 'FORM TODAY:', 'CRITICAL POWER MODEL', 'PERIOD TOTALS', 'RIDES (newest first)', 'MEANINGS: NP = surge-weighted average'])
    assert.ok(t.includes(s), s);
  assert.ok(t.includes('FTP 250 W (3.33 W/kg)'));
  assert.ok(t.includes('threshold HR not set'));
  assert.ok(t.includes("W' (burst energy reserve) 18.5 kJ"));
  assert.ok(t.includes('freshness (TSB) -7.5'));
  assert.ok(t.includes('the 42 days before (2026-07-11 to 2026-08-21)'));
  // Missing values are "-", never guessed; pipes and newlines in titles can't break the table.
  assert.ok(t.includes('2026-09-20 | Ride | 1:30 | 35.0 | 180 | - | -'));
  assert.ok(t.includes('2026-10-01 | Threshold 2x20 | 1:00'));
  assert.ok(t.includes('RIDER: Test Rider;'));
  assert.ok(!t.includes('NaN') && !t.includes('undefined'));
});

test('no model, no rides: says so instead of inventing numbers', () => {
  const x = base();
  x.model = null; x.modelNote = 'no effort of 12 min or more'; x.rides = []; x.form = null;
  const t = VeloAsk.build(x);
  assert.ok(t.includes('CRITICAL POWER MODEL: none (no effort of 12 min or more)'));
  assert.ok(t.includes('(no rides in this period)'));
  assert.ok(!t.includes('FORM TODAY'));
});

test('a very long period is trimmed from the oldest rides and stays under the limit', () => {
  const x = base();
  x.rides = Array.from({ length: 2000 }, (_, i) => ({ date: '2026-01-01', title: 'Long ride title '.repeat(3) + i, dur: 3600, km: 30, avgW: 200, np: 210, ifac: 0.8, tss: 64, kj: 720, avgHr: 140, maxHr: 170, cad: 88, left: 49.5, ef: 1.5, drift: 3.2, p5: 260, p20: 230, zone3: [70, 20, 10] }));
  const t = VeloAsk.build(x);
  assert.ok(t.length <= VeloAsk.MAX_CHARS, `${t.length}`);
  assert.ok(t.includes('Long ride title Long ride title Long ride title 0 |'), 'newest ride kept');
  assert.ok(!t.includes('title 1999 |'), 'oldest ride dropped');
  assert.match(t, /\(\d+ older rides in this period are not listed; the totals and weeks above include them\)/);
});
