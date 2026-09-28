/**
 * APEX VELO // LAB - resting HR and HRV come from sleep (js/velo-health.js).
 * Run: node tests/health-sleep-metrics.test.js
 */
const assert = require('assert');
const H = require('../js/velo-health.js');

let n = 0;
const check = (name, fn) => { fn(); n++; console.log('ok  ' + name); };
const pay = (metrics) => ({ data: { metrics } });
const t = (day, hh, mm) => `${day} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00 +0200`;
const dayOf = (store, day) => H.daily(store).find(r => r.day === day);

// Night of 27 -> 28 Sep asleep 23:00-06:30 (stage segments). Heart rate every 5 min 22:00-08:00:
// awake 70, asleep 50-57 with one bad 35 reading; daytime 90 at 14:00 is never kept.
function night() {
  const hr = [], stage = (value, a, b) => ({ value, qty: (b - a) / 60, startDate: t(a < 1440 ? '2026-09-27' : '2026-09-28', Math.floor((a % 1440) / 60), a % 60), endDate: t(b < 1440 ? '2026-09-27' : '2026-09-28', Math.floor((b % 1440) / 60), b % 60) });
  for (let m = 22 * 60; m <= 32 * 60; m += 5) {
    const asleep = m >= 23 * 60 && m <= 30 * 60 + 30;
    const v = asleep ? 50 + (m % 8) : 70;
    const d = m < 1440 ? '2026-09-27' : '2026-09-28';
    hr.push({ date: t(d, Math.floor((m % 1440) / 60), m % 60), Min: v - 2, Avg: v, Max: v + 2 });
  }
  hr.push({ date: t('2026-09-28', 3, 2), Avg: 35 });
  hr.push({ date: t('2026-09-28', 14, 0), Avg: 90 });
  return pay([
    { name: 'heart_rate', units: 'count/min', data: hr },
    { name: 'resting_heart_rate', units: 'count/min', data: [{ date: t('2026-09-28', 0, 0), qty: 58 }] },
    { name: 'heart_rate_variability', units: 'ms', data: [{ date: t('2026-09-27', 23, 40), qty: 60 }, { date: t('2026-09-28', 4, 0), qty: 70 }, { date: t('2026-09-28', 17, 0), qty: 20 }] },
    { name: 'sleep_analysis', units: 'hr', data: [stage('Core', 23 * 60, 26 * 60), stage('Awake', 26 * 60, 26 * 60 + 10), stage('Deep', 26 * 60 + 10, 28 * 60), stage('REM', 28 * 60, 30 * 60 + 30)] }
  ]);
}

check('resting HR is the 5th percentile of heart rate while asleep, not Apple\'s daily value', () => {
  const { store } = H.merge(H.emptyStore(), H.parsePayload(night()));
  const r = dayOf(store, '2026-09-28');
  assert.strictEqual(r.rhrSrc, 'sleep');
  assert.ok(r.rhr >= 50 && r.rhr <= 51, `rhr ${r.rhr}`);   // not 35 (bad reading), not 58 (Apple), not 70 (awake)
  assert.ok(!store.days['2026-09-28'].hr[t('2026-09-28', 14, 0)], 'daytime heart rate is not stored');
});

check('HRV averages only the readings taken asleep; evening readings belong to the next morning', () => {
  const r = dayOf(H.merge(H.emptyStore(), H.parsePayload(night())).store, '2026-09-28');
  assert.strictEqual(r.hrv, 65);
  assert.strictEqual(r.hrvSrc, 'sleep');
});

check('too few heart rate readings asleep: Apple\'s resting HR; no HRV asleep: that night\'s readings', () => {
  const p = night();
  p.data.metrics[0].data = p.data.metrics[0].data.slice(0, 30);   // 22:00-00:25 only
  p.data.metrics[2].data = [{ date: t('2026-09-28', 17, 0), qty: 20 }];
  const r = dayOf(H.merge(H.emptyStore(), H.parsePayload(p)).store, '2026-09-28');
  assert.strictEqual(r.rhr, 58); assert.strictEqual(r.rhrSrc, 'apple');
  assert.strictEqual(r.hrv, 20); assert.strictEqual(r.hrvSrc, 'day');
});

check('per-night sleep rows (start/end) work as the sleep window too', () => {
  const p = night();
  p.data.metrics[3].data = [{ date: t('2026-09-28', 0, 0), totalSleep: 7.3, deep: 1.8, rem: 2.5, core: 3, sleepStart: t('2026-09-27', 23, 0), sleepEnd: t('2026-09-28', 6, 30) }];
  const r = dayOf(H.merge(H.emptyStore(), H.parsePayload(p)).store, '2026-09-28');
  assert.strictEqual(r.rhrSrc, 'sleep'); assert.ok(r.rhr <= 51);
  assert.strictEqual(r.hrv, 65);
});

check('re-sending the same heart rate data counts nothing twice; compacted days keep the sleep values', () => {
  const m1 = H.merge(H.emptyStore(), H.parsePayload(night()));
  assert.strictEqual(H.merge(m1.store, H.parsePayload(night())).added, 0);
  const before = dayOf(m1.store, '2026-09-28');
  H.compact(m1.store, '2026-10-20');
  const after = dayOf(m1.store, '2026-09-28');
  assert.deepStrictEqual([after.rhr, after.hrv, after.rhrSrc], [before.rhr, before.hrv, 'sleep']);
});

console.log(`\n${n} checks passed`);
