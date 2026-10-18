// FTP estimates calculated in the app (js/velo-ftp-model.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ctx = vm.createContext({ window: {} });
for (const file of ['velo-metrics', 'velo-insight', 'velo-power']) vm.runInContext(fs.readFileSync(`js/${file}.js`, 'utf8'), ctx);
ctx.window.VeloPower = vm.runInContext('VeloPower', ctx);
vm.runInContext(fs.readFileSync('js/velo-ftp-model.js', 'utf8'), ctx);
const P = vm.runInContext('VeloPower', ctx), F = vm.runInContext('window.VeloFtpModel', ctx);
const DAY = 86400000;

let seed = 11;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

/** An hour of 5-minute steps from 150 to 260 W; heart rate follows power (HR = 60 + 0.45 W) with a 20 s lag. */
function ride({ hrOf = (w) => 60 + 0.45 * w, steps = [150, 170, 190, 210, 230, 250, 260, 240, 220, 200, 180, 160] } = {}) {
  const s = [];
  let t = 0, hr = 100;
  for (const w of steps) for (let i = 0; i < 300; i++, t++) {
    const p = w + (rnd() - 0.5) * 10;
    hr += (hrOf(w) - hr) / 20; // first-order lag
    s.push({ time: t, power: p, hr: hr + (rnd() - 0.5) * 2 });
  }
  return s;
}

test('power vs heart rate read at threshold: the workout-implied FTP', () => {
  const est = F.hrPowerEstimate(P.prepare(ride()), 165, 220);
  assert.equal(est.ok, true, est.reason);
  assert.ok(Math.abs(est.implied - (165 - 60) / 0.45) < 6, `implied ${est.implied} vs ${(105 / 0.45).toFixed(1)}`);
  assert.ok(est.r2 > 0.9 && est.n >= 40 && est.se < 5);
});

test('ineligible workouts say why', () => {
  assert.match(F.hrPowerEstimate(P.prepare(ride({ hrOf: () => 140 })), 165, 220).reason, /barely changed|did not rise/);
  assert.match(F.hrPowerEstimate(P.prepare(ride({ steps: [150, 160] })), 165, 220).reason, /steady minutes/);
  assert.match(F.hrPowerEstimate(P.prepare(ride({ hrOf: (w) => 40 + 0.3 * w })), 175, 220).reason, /under threshold/);
});

test('threshold heart rate: LTHR, else 90% of max HR', () => {
  assert.deepEqual({ ...F.thresholdHr({ lthr: 162, maxHr: 190 }) }, { hr: 162, assumed: false });
  assert.deepEqual({ ...F.thresholdHr({ maxHr: 190 }) }, { hr: 171, assumed: true });
  assert.equal(F.thresholdHr({}), null);
});

test('Kalman filter: one noisy reading moves the estimate part-way; repeated readings converge', () => {
  const one = F.kalman([{ t: 0, v: 250, sd: 10 }], { v: 200, sd: 16 });
  assert.ok(one[0].v > 200 && one[0].v < 250 && one[0].sd < 16);
  const many = F.kalman(Array.from({ length: 20 }, (_, i) => ({ t: i * 7 * DAY, v: 240, sd: 10 })), { v: 200, sd: 16 });
  assert.ok(Math.abs(many.at(-1).v - 240) < 2);
});

test('capacity floor: the most a ride proves', () => {
  const curve = new Array(P.GRID.length).fill(null);
  curve[P.gridIndex(1200)] = 250; curve[P.gridIndex(2700)] = 235; curve[P.gridIndex(3600)] = 228;
  const f = F.capacityFloor(curve);
  assert.equal(f.d, '20 min'); assert.ok(Math.abs(f.v - 232.5) < 1e-9);
});

test('build: five histories, B carries the workout-implied FTP and a 90% range', () => {
  const now = Date.UTC(2026, 9, 18);
  const rides = Array.from({ length: 10 }, (_, i) => {
    const prep = P.prepare(ride());
    return { id: 'r' + i, t: now - (60 - i * 6) * DAY, title: 'Ramp ' + i, curve: P.mmp(prep), hrp: F.hrPowerEstimate(prep, 165, 220) };
  });
  const out = F.build({ rides, ftpAt: () => 220, now, thr: { hr: 165, assumed: false } });
  const s = out.series;
  assert.equal(s.B.length, 10);
  assert.ok(s.B.every(p => p.workoutImplied > 0 && p.low < p.y && p.y < p.high));
  assert.ok(Math.abs(s.B.at(-1).y - 233) < 8, `B ${s.B.at(-1).y}`);
  assert.ok(s.A.length > 3 && s.Aplus.length === s.A.filter(p => p.y !== null).length);
  assert.ok(s.C.length > 3 && s.Cfloor.length > 0);
  assert.equal(out.stats.hrRides, 10);
  assert.equal(F.build({ rides: [], ftpAt: () => 200, now }).series.B.length, 0);
});
