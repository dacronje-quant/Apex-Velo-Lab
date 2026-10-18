/**
 * APEX VELO // LAB - backfill from Health Auto Export files, Apple Watch first, intervals.icu beside it
 * (js/velo-health.js, js/velo-unzip.js).
 * Run: node tests/health-import.test.js
 */
const assert = require('assert');
const zlib = require('zlib');
const H = require('../js/velo-health.js');
const Z = require('../js/velo-unzip.js');

let n = 0;
const checks = [];
const check = (name, fn) => checks.push([name, fn]);
const pay = (metrics) => ({ data: { metrics } });
const t = (day, hh, mm) => `${day} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00 +0100`;
const WATCH = 'Rider’s Apple Watch';   // as Health Auto Export writes it (curly quote, no-break space)
const dayOf = (store, day) => H.daily(store).find(r => r.day === day);

// One daily file as Health Auto Export saves it: the night ending that morning (aggregated sleep), heart
// rate every 5 min 00:00-07:00 and 22:00-23:55, HRV and breathing from the watch, and the same metrics
// from WHOOP / Athlytic as well.
function dayFile(day, { hr = 52, hrv = 40, whoopHrv = 90, sleep = 7.5, whoopSleep = 8.6, resp = 15, whoopResp = 19 } = {}) {
  const hrRows = [], hrvRows = [], respRows = [];
  for (let m = 0; m < 24 * 60; m += 5) {
    if (m > 7 * 60 && m < 22 * 60) continue;
    const late = m >= 22 * 60;
    hrRows.push({ date: t(day, Math.floor(m / 60), m % 60), Min: hr, Avg: late ? hr + 6 : hr + (m % 3), Max: hr + 4 });
  }
  for (const [h, mm] of [[1, 0], [3, 0], [5, 0], [23, 0]]) {
    hrvRows.push({ date: t(day, h, mm), qty: h === 23 ? hrv + 10 : hrv, source: WATCH });
    respRows.push({ date: t(day, h, mm), qty: resp, source: WATCH });
  }
  hrvRows.push({ date: t(day, 6, 30), qty: whoopHrv, source: 'WHOOP' });
  respRows.push({ date: t(day, 6, 30), qty: whoopResp, source: 'WHOOP' });
  const prev = H.addDays(day, -1);
  return pay([
    { name: 'sleep_analysis', units: 'hr', data: [
      { date: t(day, 0, 0), source: WATCH, totalSleep: sleep, deep: 1, rem: 1.5, core: sleep - 2.5, awake: 0.3, asleep: 0, inBed: 0, sleepStart: t(prev, 23, 0), sleepEnd: t(day, 6, 50), inBedStart: t(prev, 23, 0), inBedEnd: t(day, 6, 50) },
      { date: t(day, 0, 0), source: 'WHOOP', totalSleep: whoopSleep, deep: 2.5, rem: 2.5, core: whoopSleep - 5, sleepStart: t(prev, 22, 30), sleepEnd: t(day, 7, 10) }
    ] },
    { name: 'resting_heart_rate', units: 'count/min', data: [{ date: t(day, 0, 3), qty: 64, source: WATCH }, { date: t(day, 6, 59), qty: 61, source: 'Athlytic' }, { date: t(day, 7, 4), qty: 58, source: 'WHOOP' }] },
    { name: 'respiratory_rate', units: 'count/min', data: respRows },
    { name: 'heart_rate_variability', units: 'ms', data: hrvRows },
    { name: 'heart_rate', units: 'count/min', data: hrRows },
    { name: 'apple_sleeping_wrist_temperature', units: 'degC', data: [{ date: t(day, 0, 0), qty: 35.1, source: WATCH }] }
  ]);
}

check('Apple Watch first: HRV, breathing and sleep from the watch, never WHOOP or Athlytic', () => {
  const { store } = H.merge(H.emptyStore(), H.parsePayload(dayFile('2026-01-03')));
  const d = dayOf(store, '2026-01-03');
  assert.strictEqual(d.hrv, 40, 'watch HRV asleep, not WHOOP\'s 90');
  assert.strictEqual(d.resp, 15, 'watch breathing rate, not WHOOP\'s 19');
  assert.deepStrictEqual([d.sleepH, d.deepH, d.remH], [7.5, 1, 1.5], 'the watch night, although WHOOP\'s is longer');
  assert.strictEqual(d.bed, 23 * 60);
  assert.strictEqual(d.wake, 6 * 60 + 50, 'sleep window from the watch night');
  assert.strictEqual(d.rhrSrc, 'sleep');
});

check('Apple Watch first for the daily resting HR too (too few heart rate readings asleep)', () => {
  const p = dayFile('2026-01-03');
  p.data.metrics.find(m => m.name === 'heart_rate').data = [];
  const d = dayOf(H.merge(H.emptyStore(), H.parsePayload(p)).store, '2026-01-03');
  assert.deepStrictEqual([d.rhr, d.rhrSrc], [64, 'apple'], 'the watch\'s 64, not the lowest app value (58)');
  const noWatch = dayFile('2026-01-03');
  noWatch.data.metrics.find(m => m.name === 'heart_rate').data = [];
  noWatch.data.metrics.find(m => m.name === 'resting_heart_rate').data.shift();
  assert.strictEqual(dayOf(H.merge(H.emptyStore(), H.parsePayload(noWatch)).store, '2026-01-03').rhr, 58, 'no watch value: the other apps are still used');
});

check('a reading stored before sources were kept is not counted again with its source', () => {
  const store = H.emptyStore();
  store.days['2026-10-17'] = { hrv: { [t('2026-10-17', 1, 0)]: 40 } };
  H.merge(store, H.parsePayload(pay([{ name: 'heart_rate_variability', data: [{ date: t('2026-10-17', 1, 0), qty: 40, source: WATCH }, { date: t('2026-10-17', 4, 0), qty: 70, source: WATCH }] }])));
  assert.strictEqual(dayOf(store, '2026-10-17').hrv, 55, '(40 + 70) / 2 - the 01:00 reading once');
});

check('backfill: all files read together, so a night split over two daily files is complete', () => {
  const files = [dayFile('2026-01-04', { hrv: 50 }), dayFile('2026-01-03', { hrv: 20 })];   // any order
  const r = H.importExports(H.emptyStore(), files, '2026-10-18');
  assert.deepStrictEqual([r.files, r.skipped, r.days, r.changed], [2, 0, 2, 2], 'the 5 Jan evening alone is not a day');
  const d4 = dayOf(r.store, '2026-01-04');
  assert.strictEqual(d4.hrv, 45, 'the 3 Jan 23:00 reading (30, in the 3 Jan file) belongs to the night of the 4th: (30 + 50 * 3) / 4');
  assert.ok(r.store.days['2026-01-04'].summary && !r.store.days['2026-01-04'].hr, 'old days keep only their values');
  assert.strictEqual(H.importExports(r.store, files, '2026-10-18').changed, 0, 'importing again changes nothing');
  const one = H.importExports(H.emptyStore(), [files[0]], '2026-10-18');
  assert.strictEqual(dayOf(one.store, '2026-01-04').hrv, 50);
});

check('backfill: recent days keep their readings like a live sync; other files are skipped', () => {
  const r = H.importExports(H.emptyStore(), [dayFile('2026-10-17'), { data: { metrics: [{ name: 'step_count', data: [{ qty: 4000 }] }] } }, {}], '2026-10-18');
  assert.deepStrictEqual([r.files, r.skipped], [1, 2]);
  assert.ok(r.store.days['2026-10-17'].hr, 'raw heart rate kept for the last week');
  assert.ok(r.store.days['2026-10-18'].hrv, 'and the evening readings wait for the next night');
  assert.strictEqual(dayOf(r.store, '2026-10-17').hrv, 40);
});

check('backfill updates an older day group by group and keeps what the files lack', () => {
  const store = { v: 1, days: { '2026-01-03': { summary: { rhr: 50, rhrSrc: 'apple', hrv: 33, hrvSrc: 'day', sleepH: 6, deepH: null, remH: null, coreH: null, awakeH: null } } } };
  const p = dayFile('2026-01-03');
  p.data.metrics = p.data.metrics.filter(m => m.name !== 'sleep_analysis');
  H.importExports(store, [p], '2026-10-18');
  const d = dayOf(store, '2026-01-03');
  assert.strictEqual(d.hrv, 40, 'the file wins');
  assert.strictEqual(d.sleepH, 6, 'sleep the file did not have stays');
});

// intervals.icu (the Android app) for the same days: summaries as mobile/src/native-icu.js makes them.
const icuDay = (o) => Object.assign({ rhr: 47, hrv: 75, sleepH: 8.4, deepH: 2, remH: 2, coreH: 4.4, awakeH: null, rhrSrc: 'icu', hrvSrc: 'icu', hrvKind: 'rmssd', hrvRmssd: 75, hrvSdnn: 45, sleepScore: 88, baevsky: 101.5, resp: 18 }, o);

check('Apple Watch files first, intervals.icu fills the rest and adds its own values', () => {
  const { store } = H.importExports(H.emptyStore(), [dayFile('2026-01-03'), dayFile('2026-01-04')], '2026-10-18');
  assert.strictEqual(H.setIcu(store, '2026-01-03', icuDay()), true);
  assert.strictEqual(H.setIcu(store, '2026-01-03', icuDay()), false, 'the same values twice change nothing');
  H.setIcu(store, '2026-02-01', icuDay());   // a day only intervals.icu has
  const d = dayOf(store, '2026-01-03');
  assert.deepStrictEqual([d.hrv, d.hrvSdnn, d.resp, d.sleepH, d.deepH], [40, 40, 15, 7.5, 1], 'the watch\'s values');
  assert.notStrictEqual(d.rhrSrc, 'icu');
  assert.deepStrictEqual([d.sleepScore, d.baevsky, d.hrvRmssd], [88, 101.5, 75], 'intervals.icu\'s own values stay');
  const only = dayOf(store, '2026-02-01');
  assert.deepStrictEqual([only.rhr, only.sleepH], [47, 8.4], 'a day without files: intervals.icu');
  assert.strictEqual(only.hrv, 45, 'with Apple Watch HRV in the store, intervals.icu days give SDNN, never rMSSD');
  assert.strictEqual(H.daily({ v: 1, days: { '2026-02-01': { summary: icuDay(), src: 'icu' } } })[0].hrv, 75, 'without Apple data the chosen column stays');
  assert.deepStrictEqual(H.sources(store), { apple: 2, icu: 2 });
});

check('an intervals.icu sync never replaces Apple data, and an import keeps intervals.icu values', () => {
  const store = { v: 1, days: { '2026-01-03': { summary: icuDay(), src: 'icu' } } };   // as the app stored them before
  H.importExports(store, [dayFile('2026-01-03')], '2026-10-18');
  assert.ok(store.days['2026-01-03'].icu && store.days['2026-01-03'].summary.hrv === 40, 'both kept, each in its place');
  H.setIcu(store, '2026-01-03', icuDay({ rhr: 45 }));
  const d = dayOf(store, '2026-01-03');
  assert.strictEqual(d.hrv, 40);
  assert.strictEqual(d.sleepScore, 88);
  // A recent day with raw readings: compacting keeps the intervals.icu values beside the summary.
  const fresh = H.importExports(H.emptyStore(), [dayFile('2026-10-17')], '2026-10-18').store;
  H.setIcu(fresh, '2026-10-17', icuDay());
  const before = dayOf(fresh, '2026-10-17');
  H.compact(fresh, '2026-11-30');
  assert.ok(fresh.days['2026-10-17'].icu && !fresh.days['2026-10-17'].hr);
  assert.deepStrictEqual(dayOf(fresh, '2026-10-17'), before, 'compacting changes no value');
});

// A minimal zip writer (stored and deflated entries), as Google Drive's folder download makes them.
function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text, deflate] of entries) {
    const raw = Buffer.from(text), data = deflate ? zlib.deflateRawSync(raw) : raw, nm = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nm, data); centrals.push(ch, nm);
    offset += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return new Blob([Buffer.concat([...locals, cd, end])]);
}

check('a .zip of the Drive folder: every JSON file, stored or deflated, macOS copies skipped', async () => {
  const a = JSON.stringify(dayFile('2026-01-03')), b = JSON.stringify(dayFile('2026-01-04'));
  const blob = zip([['Health/', '', false], ['Health/HealthAutoExport-2026-01-03.json', a, true], ['Health/HealthAutoExport-2026-01-04.json', b, false],
    ['__MACOSX/Health/._HealthAutoExport-2026-01-04.json', 'x', false], ['Health/notes.txt', 'hello', false]]);
  const imp = H.importer(), names = [];
  const count = await Z.each(blob, (nm) => /\.json$/i.test(nm), (nm, text) => { names.push(nm); imp.add(JSON.parse(text)); });
  assert.strictEqual(count, 2);
  assert.deepStrictEqual(names, ['Health/HealthAutoExport-2026-01-03.json', 'Health/HealthAutoExport-2026-01-04.json']);
  const r = imp.apply(H.emptyStore(), '2026-10-18');
  assert.deepStrictEqual([r.files, r.days], [2, 2]);
  await assert.rejects(Z.each(new Blob(['not a zip at all, just some text']), () => true, () => {}), /Not a \.zip/);
});

(async () => {
  for (const [name, fn] of checks) { await fn(); n++; console.log('ok  ' + name); }
  console.log(`\n${n} checks passed`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
