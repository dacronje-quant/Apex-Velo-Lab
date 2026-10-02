// Power-duration model, W' balance and advanced ride metrics (js/velo-power.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ctx = vm.createContext({ window: {} });
for (const file of ['velo-metrics', 'velo-insight', 'velo-power']) vm.runInContext(fs.readFileSync(`js/${file}.js`, 'utf8'), ctx);
const plain = (v) => JSON.parse(JSON.stringify(v));
const M = vm.runInContext('VeloMetrics', ctx), I = vm.runInContext('VeloInsight', ctx), P = vm.runInContext('VeloPower', ctx);

let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const block = (n, start, power, extra = {}) => Array.from({ length: n }, (_, i) => ({ time: start + i, timestamp: 1e12 + (start + i) * 1000, power: typeof power === 'function' ? power(i) : power, ...extra }));

/** A ride with a cockpit pause (segmentStart), a smart-recording gap and a long import gap. */
function messyRide() {
  const s = block(1500, 0, () => Math.round(150 + rnd() * 250));
  const resumed = block(900, 1500, () => Math.round(100 + rnd() * 300)).map(x => ({ ...x, timestamp: x.timestamp + 120000 }));
  resumed[0].segmentStart = true;
  const smart = [];
  for (let t = 2400; t < 3000; t += 1 + Math.floor(rnd() * 4)) smart.push({ time: t, power: Math.round(120 + rnd() * 200) });
  const afterGap = block(700, 3100, () => Math.round(200 + rnd() * 80)).map(({ timestamp, ...x }) => x);
  return [...s, ...resumed, ...smart.map(x => ({ ...x })), ...afterGap];
}

test('MMP grid matches bestRollingAvg and the medal peaks exactly, never spanning pauses', () => {
  for (let k = 0; k < 3; k++) {
    const samples = messyRide();
    const curve = P.mmp(P.prepare(samples));
    const oneHz = M.toOneHz(samples);
    P.GRID.forEach((d, g) => assert.equal(curve[g], M.bestRollingAvg(oneHz, d), `duration ${d}`));
    const peaks = I.peaksOf(samples);
    I.MEDAL_DURATIONS.forEach((d, i) => assert.equal(curve[P.gridIndex(d)], peaks[i]));
  }
  M.MMP_DURATIONS.forEach(d => assert.ok(P.gridIndex(d) >= 0, `grid has ${d}`));
});

test('zone seconds agree with the Coggan zones', () => {
  const powers = [0, 54, 55, 75, 76, 90, 105, 106, 120, 150, 151, 400];
  const z = P.zoneSeconds(Float64Array.from(powers), 100);
  const ref = I.timeInZones(powers.map(p => ({ power: p })), 100);
  assert.deepEqual(plain(z), plain(ref));
});

const morton = (t, cp, w, pmax) => cp + w / (t + w / (pmax - cp));
const curveOf = (fn) => P.GRID.map(t => (t <= 3600 ? Math.round(fn(t)) : null));

test('CP model recovers CP and W\' from a hyperbolic curve and Pmax from the short end', () => {
  const m = P.fitModel(curveOf(t => (t >= 180 ? 250 + 20000 / t : morton(t, 250, 20000, 900))));
  assert.equal(m.ok, true);
  assert.ok(Math.abs(m.cp - 250) <= 1, `cp ${m.cp}`);
  assert.ok(Math.abs(m.w - 20000) <= 200, `w ${m.w}`);
  assert.ok(Math.abs(m.pmax - 900) <= 60, `pmax ${m.pmax}`);
  assert.ok(m.rmsePct < 1);
  // On a Morton-shaped curve CP stays within 2% and under the 20-min best.
  const mo = P.fitModel(curveOf(t => morton(t, 250, 20000, 900)));
  assert.ok(mo.ok && Math.abs(mo.cp - 250) / 250 < 0.02 && mo.cp <= Math.round(morton(1200, 250, 20000, 900)), `cp ${mo.cp}`);
});

test('CP lands at 92-97% of the 20-min best on realistic rider curves', () => {
  const riders = {
    allround: [[1, 950], [5, 820], [15, 640], [30, 520], [60, 410], [180, 315], [300, 285], [600, 255], [1200, 232], [3600, 212], [14400, 170]],
    diesel: [[1, 700], [5, 620], [15, 480], [30, 400], [60, 330], [180, 285], [300, 272], [600, 258], [1200, 245], [3600, 230], [14400, 195]],
    sprinter: [[1, 1400], [5, 1250], [15, 950], [30, 700], [60, 520], [180, 340], [300, 300], [600, 262], [1200, 236], [3600, 210], [14400, 160]]
  };
  const interp = (a) => P.GRID.map(t => { for (let i = 1; i < a.length; i++) { const [x, px] = a[i - 1], [y, py] = a[i]; if (t <= y) return Math.round(px + (py - px) * (Math.log(t / x) / Math.log(y / x))); } return null; });
  for (const [name, a] of Object.entries(riders)) {
    const c = interp(a), m = P.fitModel(c), r = m.cp / c[P.gridIndex(1200)];
    assert.ok(m.ok && r >= 0.9 && r <= 0.98, `${name}: cp ${m.cp} = ${r.toFixed(3)} of 20 min`);
  }
});

test('submaximal points are down-weighted (upper-envelope fit)', () => {
  const easy = new Set([240, 600, 900]);
  const c = curveOf(t => (t >= 180 ? 230 + 18000 / t : morton(t, 230, 18000, 850)) * (easy.has(t) ? 0.85 : 1));
  const m = P.fitModel(c);
  assert.equal(m.ok, true);
  assert.ok(Math.abs(m.cp - 230) <= 2, `cp ${m.cp}`);
  assert.ok(Math.abs(m.w - 18000) <= 500, `w ${m.w}`);
  assert.ok(m.used < m.points);
});

test('no model without a 12-min effort or with a flat curve', () => {
  const short = P.GRID.map(t => (t <= 600 ? Math.round(morton(t, 250, 20000, 900)) : null));
  assert.equal(P.fitModel(short).ok, false);
  assert.equal(P.fitModel(short).reason, 'coverage');
  assert.equal(P.fitModel(P.GRID.map(() => null)).reason, 'no-data');
});

test('2-parameter regression is exact on a hyperbola', () => {
  const r = P.fitCp2(P.GRID.map(t => 240 + 15000 / t), P.GRID);
  assert.ok(Math.abs(r.cp - 240) < 0.5 && Math.abs(r.w - 15000) < 50 && r.r2 > 0.999);
});

test('W\' balance: depletion above CP, exponential recovery, pauses and matches', () => {
  const cp = 200, w = 20000;
  // 120 s at 300 W uses exactly 12 kJ.
  let r = P.wbal(P.prepare(block(120, 0, 300)), cp, w);
  assert.equal(r.maxDepletion, 12000);
  assert.equal(r.end, 8000);
  assert.equal(r.aboveSec, 120);
  assert.equal(r.aboveKj, 12);
  // Recovery below CP approaches W' and never passes it.
  r = P.wbal(P.prepare([...block(120, 0, 300), ...block(1800, 120, 100)]), cp, w);
  assert.ok(r.end > 19000 && r.end <= w);
  // A 10-minute pause between two efforts recovers W' (wall clock), riding straight through does not.
  const a = block(120, 0, 300), b = block(120, 120, 300).map(x => ({ ...x, timestamp: x.timestamp + 600000 }));
  b[0].segmentStart = true;
  const paused = P.wbal(P.prepare([...a, ...b]), cp, w);
  const straight = P.wbal(P.prepare(block(240, 0, 300)), cp, w);
  assert.equal(straight.min, -4000);
  assert.ok(paused.min > 5000, `paused min ${paused.min}`);
  // 5 x (4 min at CP + 60 W / 4 min at 100 W) = 5 matches.
  const vo2 = [];
  for (let k = 0; k < 5; k++) { vo2.push(...block(240, vo2.length, 260)); vo2.push(...block(240, vo2.length, 100)); }
  assert.equal(P.wbal(P.prepare(vo2), cp, w).matches, 5);
  // Steady riding under CP burns no matches.
  assert.equal(P.wbal(P.prepare(block(3600, 0, 190)), cp, w).matches, 0);
  assert.equal(P.wbal(P.prepare(block(10, 0, 100)), 0, w), null);
  assert.equal(Math.round(P.timeToEmpty(10000, 300, 200)), 100);
  assert.equal(P.timeToEmpty(10000, 150, 200), Infinity);
});

test('HR zones, Edwards TRIMP and the power histogram', () => {
  const s = block(3600, 0, 210, { hr: 153 }); // 87% of 175
  const m = P.rideMetrics(P.prepare(s), { maxHr: 175 });
  assert.equal(m.trimp, 240);
  assert.equal(m.hrAvg, 153);
  assert.deepEqual(plain(m.hrZones), [0, 0, 0, 3600, 0]);
  assert.equal(m.hist.counts[8], 3600);
  assert.equal(P.rideMetrics(P.prepare(s)).trimp, null);
});

test('quadrant analysis splits force and pedal speed at CP and the average cadence', () => {
  const s = [...block(600, 0, 300, { cadence: 60 }), ...block(600, 600, 150, { cadence: 100 })];
  const q = P.quadrants(P.prepare(s), 250);
  assert.deepEqual(plain(q.pct), [0, 50, 0, 50]);
  assert.equal(q.refCad, 80);
  assert.ok(q.points.length <= 1500);
  assert.equal(P.quadrants(P.prepare(block(30, 0, 200, { cadence: 90 })), 200), null);
});

test('Seiler 3-zone distribution and polarization index', () => {
  const pol = P.seiler([40, 40, 2, 3, 10, 4, 1]);
  assert.equal(pol.type, 'polarized');
  assert.ok(pol.pi > 2);
  const pyr = P.seiler([30, 50, 10, 5, 3, 1, 1]);
  assert.equal(pyr.type, 'pyramidal');
  assert.deepEqual(plain(pyr.pct), [80, 15, 5]);
  assert.equal(P.seiler([0, 0, 0, 0, 0, 0, 0]), null);
  assert.equal(P.seiler([10, 10, 30, 30, 5, 0, 0]).type, 'threshold');
});

test('model history follows a rising CP and VO2max estimate', () => {
  const D = 86400000, now = Date.UTC(2026, 5, 1);
  const entries = [0, 1, 2, 3, 4, 5].map(k => ({ id: 'r' + k, t: now - (150 - k * 30) * D, curve: curveOf(t => morton(t, 200 + k * 10, 20000, 850)) }));
  const h = P.modelHistory(entries, { from: now - 120 * D, to: now, stepDays: 30 });
  assert.equal(h.length, 5);
  assert.ok(h.every(x => x.ok));
  assert.ok(h[h.length - 1].cp > h[0].cp);
  assert.equal(P.vo2maxEstimate(300, 75), 50.2);
  assert.equal(P.vo2maxEstimate(300, 0), null);
  assert.equal(P.durLabel(90), '1m30');
  assert.equal(P.durLabel(5400), '1h30');
});
