// Analytics across rides from sampleSummary (js/velo-ride-summary.js) give the same numbers as from the samples:
// the Android app holds summaries in memory and loads a ride's samples only when one ride is viewed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ctx = vm.createContext({ window: {}, console, document: { getElementById: () => null } });
vm.runInContext('class VeloApp { cyclingRides() { return (this.completedWorkouts || []).filter(r => VeloMetrics.isCycling(r)); } }', ctx);
for (const file of ['velo-metrics', 'velo-insight', 'velo-trends', 'velo-power']) vm.runInContext(fs.readFileSync(`js/${file}.js`, 'utf8'), ctx);
ctx.window.VeloPower = vm.runInContext('VeloPower', ctx);
for (const file of ['velo-ftp-model', 'velo-ftp-history']) vm.runInContext(fs.readFileSync(`js/${file}.js`, 'utf8'), ctx);
vm.runInContext('var VeloFtpModel = window.VeloFtpModel, VeloFtpHistory = window.VeloFtpHistory;', ctx);
for (const file of ['velo-ride-summary', 'app-power', 'app-insight', 'app-ftp-history', 'app-ask']) vm.runInContext(fs.readFileSync(`js/${file}.js`, 'utf8'), ctx);
const S = vm.runInContext('VeloRideSummary', ctx), VeloApp = vm.runInContext('VeloApp', ctx);
vm.runInContext(`Date.now = () => ${Date.parse('2026-09-20T12:00:00Z')};`, ctx); // FTP over time runs up to "now"; both apps get the same now
const DAY = 86400000;

let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
/** Per-second samples for steps of [seconds, watts, target]; heart rate follows power with a lag, optional drift. */
function samples(steps, { start = Date.parse('2026-09-01T07:00:00Z'), drift = 0, gapAt = -1 } = {}) {
  const out = [];
  let t = 0, hr = 95;
  for (const [sec, w, target] of steps) for (let i = 0; i < sec; i++, t++) {
    const p = Math.max(0, Math.round(w + (rnd() - 0.5) * 14));
    hr += (55 + 0.42 * w + drift * t / 600 - hr) / 25;
    const skip = gapAt >= 0 && t >= gapAt ? 120 : 0; // a 2-minute pause in the recording
    out.push({ time: t + skip, timestamp: start + (t + skip) * 1000, power: p, hr: Math.round(hr + (rnd() - 0.5) * 2), cadence: 88 + Math.round((rnd() - 0.5) * 6), ...(target ? { target } : {}) });
  }
  return out;
}
const day = (i) => new Date(Date.parse('2026-09-01T07:00:00Z') + i * DAY).toISOString();
const RIDES = [
  { id: 'endurance', date: day(0), title: 'Endurance', ftpAtRide: 250, samples: samples([[5400, 165]], { drift: 1.2 }) },
  { id: 'intervals', date: day(2), title: '4x8 threshold', ftpAtRide: 250, samples: samples([[600, 140, 140], ...Array.from({ length: 4 }, () => [[480, 252, 250], [240, 130, 130]]).flat(), [600, 130, 130]]) },
  { id: 'hour', date: day(4), title: 'Hour at tempo', ftpAtRide: 250, samples: samples([[600, 150], [3600, 228], [300, 140]], { gapAt: 2000 }) },
  { id: 'ramp', date: day(6), title: 'Ramp test', ftpAtRide: 250, rampTest: true, samples: samples(Array.from({ length: 20 }, (_, i) => [60, 120 + i * 20])) },
  { id: 'no-ftp', date: day(8), title: 'Imported, no FTP', samples: samples([[2700, 190]]) },
  { id: 'short', date: day(9), title: 'Spin', ftpAtRide: 250, samples: samples([[900, 150]]) },
  { id: 'summary-only', date: day(10), title: 'Summary import', np: 200, avgWatts: 195, avgHr: 140, duration: 3600, ftpAtRide: 250 }
];
const profile = { id: 'p', name: 'Rider', ftp: 255, maxHr: 188, lthr: 172 };
function app(rides) {
  const a = new VeloApp();
  a.completedWorkouts = rides; a.activeProfile = { ...profile }; a.activeProfileId = 'p';
  a.dismissedFtp = () => 0;
  return a;
}
const withSamples = () => app(structuredClone(RIDES));
const summaryOnly = () => app(structuredClone(RIDES).map((r) => {
  if (!r.samples) return r;
  const { samples: _, ...rest } = r;
  return { ...rest, sampleSummary: JSON.parse(JSON.stringify(S.of(r))) }; // as the phone database returns it
}));
const plain = (v) => JSON.parse(JSON.stringify(v));

test('the summary is small next to the samples and survives JSON', () => {
  for (const r of RIDES.filter((x) => x.samples)) {
    const s = S.of(r), bytes = JSON.stringify(s).length;
    assert.deepEqual(JSON.parse(JSON.stringify(s)), plain(s));
    assert.ok(bytes < JSON.stringify(r.samples).length / 20, `${r.id}: ${bytes} bytes`);
  }
  assert.equal(S.of({ id: 'x', samples: [{ power: 1 }] }), null);
  assert.equal(S.count({ samples: [1, 2, 3] }), 3);
  assert.equal(S.count({ sampleSummary: { v: S.VERSION, n: 99 } }), 99);
  assert.equal(S.get({ sampleSummary: { v: S.VERSION + 1, n: 99 } }), null, 'an older or newer summary is not used');
});

test('power curve, zones, medals and the CP model are the same from the summary', () => {
  const a = withSamples(), b = summaryOnly();
  for (const r of RIDES.filter((x) => x.samples)) {
    const ra = a.completedWorkouts.find((x) => x.id === r.id), rb = b.completedWorkouts.find((x) => x.id === r.id);
    assert.deepEqual(plain(b.ridePower(rb)), plain(a.ridePower(ra)), r.id);
    for (const ftp of [180, 255, 320]) {
      a.activeProfile.ftp = b.activeProfile.ftp = ftp;
      assert.deepEqual(b.rideZoneSeconds(rb), a.rideZoneSeconds(ra), `${r.id} zones at ${ftp} W`);
    }
    assert.deepEqual(b.rideMedalPeaks(rb), a.rideMedalPeaks(ra));
  }
  assert.deepEqual(plain(b.powerEntries()), plain(a.powerEntries()));
  assert.equal(b.powerEntries().length, 6, 'the summary-only import has no curve, as before');
  assert.deepEqual(plain(b.powerModelAt(Date.parse(day(12)))), plain(a.powerModelAt(Date.parse(day(12)))));
  assert.equal(b.historySignature(), a.historySignature(), 'caches keyed on the history stay valid when samples come and go');
});

test('FTP evidence, the FTP suggestion and FTP over time are the same, for any heart-rate settings', () => {
  for (const hr of [{ maxHr: 188, lthr: 172 }, { maxHr: 200, lthr: 0 }, { maxHr: 0, lthr: 150 }]) {
    const a = withSamples(), b = summaryOnly();
    Object.assign(a.activeProfile, hr); Object.assign(b.activeProfile, hr);
    for (const r of a.completedWorkouts) {
      const rb = b.completedWorkouts.find((x) => x.id === r.id);
      assert.deepEqual(plain(b.ftpEvidenceOf(rb)), plain(a.ftpEvidenceOf(r)), `${r.id} ${JSON.stringify(hr)}`);
    }
    const last = (x) => x.completedWorkouts.find((r) => r.id === 'hour');
    assert.deepEqual(plain(b.ftpSuggestionFor(last(b))), plain(a.ftpSuggestionFor(last(a))));
    const fa = a.appFtpBundle(), fb = b.appFtpBundle();
    assert.ok(fa && fa.series, 'FTP over time has series');
    assert.deepEqual(plain(fb), plain(fa));
  }
});

test('heart-rate drift, efficiency factor, the coach\'s last hard session and Ask are the same', () => {
  const a = withSamples(), b = summaryOnly();
  assert.deepEqual(plain(b.driftTrendData()), plain(a.driftTrendData()));
  assert.ok(a.driftTrendData().length >= 1, 'a steady ride has a drift value');
  for (const r of a.completedWorkouts) {
    const rb = b.completedWorkouts.find((x) => x.id === r.id);
    assert.deepEqual(plain(b.rideEf(rb)), plain(a.rideEf(r)), `${r.id} EF`);
    assert.equal(b.askDrift(rb), a.askDrift(r), `${r.id} drift for Ask`);
    if (r.samples) for (const ftp of [200, 250, 300]) assert.deepEqual(plain(b.rideIntervalRows(rb, ftp)), plain(a.rideIntervalRows(r, ftp)), `${r.id} steps at ${ftp}`);
  }
  const now = new Date(Date.parse(day(11)));
  const ca = a.coachInsight(28, now), cb = b.coachInsight(28, now);
  assert.ok(ca.lastHard && ca.lastHard.id === 'intervals', 'the interval session is the last hard one');
  assert.deepEqual(plain(cb), plain(ca));
});

test('the split analytics give exactly what they gave before', () => {
  const I = vm.runInContext('VeloInsight', ctx), F = vm.runInContext('VeloFtpModel', ctx), P = vm.runInContext('VeloPower', ctx);
  for (const r of RIDES.filter((x) => x.samples)) {
    assert.deepEqual(plain(I.ftpEvidenceFor(I.ftpEvidenceBase(r.samples), profile)), plain(I.ftpEvidence(r.samples, profile)));
    assert.deepEqual(plain(I.intervalWork(I.intervalSteps(r.samples), 250)), plain(I.intervalRows(r.samples, 250)));
    assert.deepEqual(plain(F.hrPowerFromBlocks(F.hrPowerBlocks(P.prepare(r.samples)), 172, 250)), plain(F.hrPowerEstimate(P.prepare(r.samples), 172, 250)));
  }
  assert.equal(I.ftpEvidence([], profile), null);
  assert.equal(I.rampEvidence(RIDES[3].samples.slice(0, 50), profile), null);
  assert.deepEqual(plain(F.hrPowerEstimate(null, 172, 250)), { ok: false, reason: 'no samples' });
});
