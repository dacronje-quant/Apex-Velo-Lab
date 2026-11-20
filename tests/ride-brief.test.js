// The ride coach's data brief (js/velo-ride-brief.js) and the answer clean-up: a 2 x 13 x 30/15 s ERG session
// like the rider's own, where the coach must see sets, heart rate and the recording, and read power vs target as ERG.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ctx = vm.createContext({ window: {}, console });
for (const file of ['velo-metrics', 'velo-insight', 'velo-ride-brief']) vm.runInContext(fs.readFileSync(`js/${file}.js`, 'utf8'), ctx);
const B = vm.runInContext('VeloRideBrief', ctx);

function thirtyFifteen() {
  const S = [];
  let t = 0, hr = 110;
  const step = (sec, target, cad, hrTo) => {
    for (let i = 0; i < sec; i++, t++) {
      hr += (hrTo - hr) * 0.05;
      // ERG lag: the first seconds of a step still carry the previous power.
      const prev = S.length ? S[S.length - 1].power : target;
      const power = i < 3 ? Math.round(prev + (target - prev) * 0.4) : target + ((t * 7) % 9) - 3;
      S.push({ time: t, timestamp: 1.7e12 + t * 1000, target, power, cadence: cad, hr: Math.round(hr) });
    }
  };
  step(600, 110, 88, 120);
  for (let set = 0; set < 2; set++) {
    for (let k = 0; k < 13; k++) { step(30, 236, 100 - k, 150 + k + set * 4); step(15, 103, 85, 135 + k + set * 4); }
    if (set === 0) step(300, 100, 85, 115);
  }
  step(300, 100, 85, 110);
  return S;
}

test('the brief carries sets, steps, ERG notes, earlier rides and the recording', () => {
  const samples = thirtyFifteen();
  const ride = { id: 'r1', title: '30/15 2x13', date: '2026-11-19T18:00:00Z', duration: samples.length, np: 200, if: '0.85', tss: 55, avgHr: 140, maxHr: 166, ftpAtRide: 197, control: { erg: true, changed: false }, samples };
  const text = B.build(ride, { maxHr: 185, previous: [{ date: '2026-11-05T18:00:00Z', duration: 3000, np: 198, avgHr: 145, maxHr: 170, workP: 236, workHr: 158 }], recent: [{ date: '2026-11-17T18:00:00Z', title: 'Endurance', duration: 3600, tss: 45, np: 140 }] });
  assert.match(text, /^THIS RIDE\n/);
  assert.match(text, /ERG mode: the trainer sets the power/);
  assert.match(text, /Never tell the rider to hold power closer to target/);
  assert.equal((text.match(/\| work \d+ \|/g) || []).length, 26, 'every hard effort is a row');
  assert.match(text, /Set 1: 13 efforts \(work 1-13\), 30 s at 236 W/);
  assert.match(text, /Set 2: 13 efforts \(work 14-26\)/);
  assert.match(text, /EARLIER RIDES OF THIS WORKOUT[\s\S]*2026-11-05/);
  assert.match(text, /OTHER RIDES IN THE 14 DAYS BEFORE[\s\S]*Endurance/);
  assert.match(text, /RECORDING \(5 s averages\)/);
  assert.ok(text.length < 60000, `brief stays compact (${text.length} chars)`);
  // Settled power leaves out the ERG transition, so it sits on target while the raw average does not.
  const work = B.steps(samples, 197).filter(s => s.work);
  assert.ok(work.every(s => Math.abs(s.settledP - 236) <= 3), 'settled power is on target');
  assert.ok(work.every(s => s.settledP - s.avgP >= 3), 'raw averages include the transition');
});

test('a ride with ERG off reads power vs target as pacing; a long ride keeps the trace short', () => {
  const samples = Array.from({ length: 4 * 3600 }, (_, t) => ({ time: t, target: 150, power: 150, cadence: 90, hr: 130 }));
  const text = B.build({ title: 'Long', samples, ftpAtRide: 200, control: { erg: false } }, {});
  assert.match(text, /ERG was off/);
  const trace = text.split('RECORDING')[1].trim().split('\n').length - 1;
  assert.ok(trace <= B.MAX_TRACE_ROWS, `${trace} trace rows`);
});

test('answers wrapped in JSON or code fences come back as plain markdown', () => {
  const wrapped = '{\n\n"review": "- You hit or exceeded the 236 W target on all 26 hard efforts.\\n- Your heart rate rose steadily."\n\n}';
  assert.equal(B.cleanAiText(wrapped), '- You hit or exceeded the 236 W target on all 26 hard efforts.\n- Your heart rate rose steadily.');
  assert.equal(B.cleanAiText('```json\n{"summary": "Good ride.", "tips": ["Eat earlier", "Sleep more"]}\n```'), 'Good ride.\n\n- Eat earlier\n\n- Sleep more');
  assert.equal(B.cleanAiText('**Plain** answer'), '**Plain** answer');
  assert.equal(B.cleanAiText('{not json'), '{not json');
});

test('Pw:HR drift: smart-recorded imports are measured, HR dropouts do not make an interval ride look steady', () => {
  const I = vm.runInContext('VeloInsight', ctx);
  const N = 3600;
  const steady = Array.from({ length: N }, (_, t) => ({ time: t, timestamp: 1.7e12 + t * 1000, power: 180 + ((t * 7) % 9) - 4, hr: Math.round(130 + 13 * t / N) }));
  const full = I.decoupling(steady);
  assert.equal(full.status, 'ok');
  const sparse = I.decoupling(steady.filter(s => s.time % 3 === 0));
  assert.equal(sparse.status, 'ok', 'a point every 3 s (Garmin smart recording) is still a 60-min ride');
  assert.ok(Math.abs(sparse.pct - full.pct) <= 0.3, `${sparse.pct} vs ${full.pct}`);
  const overUnder = Array.from({ length: N }, (_, t) => ({ time: t, timestamp: 1.7e12 + t * 1000, power: (t % 240) < 120 ? 230 : 150, hr: (t % 7) ? 150 : 0 }));
  const d = I.decoupling(overUnder);
  assert.ok(d.vi > 1.02, `VI is measured across HR dropouts (${d.vi})`);
});
