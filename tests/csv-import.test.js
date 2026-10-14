const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const ctx = vm.createContext({ window: {} });
for (const file of ['velo-metrics', 'velo-importer']) vm.runInContext(fs.readFileSync(`js/${file}.js`, 'utf8'), ctx);
const I = vm.runInContext('VeloRideImporter', ctx);
const rows = (n, line) => Array.from({ length: n }, (_, i) => line(i)).join('\n');

test('a timestamp column is not mistaken for the time column', () => {
  const csv = 'timestamp,power,heart_rate\n' + rows(600, i => `${new Date(Date.UTC(2026, 0, 1, 7, 0, i)).toISOString()},200,140`);
  const r = I.parseCsv(csv, 'T', 200);
  assert.equal(r.duration, 600);
  assert.equal(r.date, '2026-01-01T07:00:00.000Z');
  assert.equal(r.samples[599].time, 599);
});

test('elapsed time as h:mm:ss or m:ss is understood', () => {
  const hms = (s) => `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  assert.equal(I.parseCsv('time,watts\n' + rows(4000, i => `${hms(i)},180`), 'T', 200).duration, 4000);
  assert.equal(I.parseCsv('time,watts\n' + rows(300, i => `${Math.floor(i / 60)}:${String(i % 60).padStart(2, '0')},180`), 'T', 200).duration, 300);
});

test('exact header names win: time and timestamp both present', () => {
  const csv = 'timestamp,time,power\n' + rows(120, i => `${Date.UTC(2026, 0, 1) + i * 1000},${i},250`);
  const r = I.parseCsv(csv, 'T', 200);
  assert.equal(r.duration, 120);
  assert.equal(r.avgWatts, 250);
});
