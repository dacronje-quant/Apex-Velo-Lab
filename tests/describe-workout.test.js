const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const ctx = vm.createContext({ window: {}, console });
for (const f of ['velo-metrics', 'velo-workouts', 'velo-ai-coach', 'velo-describe']) vm.runInContext(fs.readFileSync(`js/${f}.js`, 'utf8'), ctx);
const D = vm.runInContext('window.VeloDescribe', ctx), C = vm.runInContext('VeloAiCoach', ctx);

test('the prompt carries only the request and FTP, never ride history', () => {
  const p = D.buildPrompt('2x20 at 250 W', 250);
  assert.match(p, /2x20 at 250 W/);
  assert.match(p, /FTP is 250 W/);
  assert.match(p, /do not analyse training history/);
  assert.doesNotMatch(p, /RIDES IN THE LAST|TSB|CTL|fatigueStatus/);
  assert.ok(D.buildPrompt('x'.repeat(5000), 200).length < 3000, 'very long requests are cut');
});

test('an answer becomes a checked library workout with load from the intervals', () => {
  const text = '```json\n{"title":"5x3 VO2","category":"vo2","desc":"Five threes.","intervals":[' +
    '{"name":"Warmup","duration":600,"pctFtp":55,"cadence":90},' +
    '{"name":"VO2 1","duration":180,"pctFtp":115,"cadence":105},' +
    '{"name":"Too hard","duration":2,"pctFtp":400},' +
    '{"name":"Bad","duration":"x","pctFtp":"y"},' +
    '{"name":"Cooldown","duration":300,"pctFtp":45}]}\n```';
  const w = D.toWorkout(text, C.estimateLoad, 1000);
  assert.equal(w.id, 'ai_req_1000');
  assert.equal(w.category, 'vo2');
  assert.equal(JSON.stringify(w.intervals[2]), JSON.stringify({ name: 'Too hard', duration: 5, pctFtp: 250 }), 'clamped to 5 s and 250%');
  assert.equal(w.intervals[3].pctFtp, 30, 'unreadable targets fall to the minimum');
  assert.equal(w.intervals[1].cadence, 105);
  const load = C.estimateLoad(w.intervals);
  assert.deepEqual([w.durationMin, w.tss, w.if], [load.durationMin, load.tss, load.if]);
});

test('answers without steps, wrapped in prose, or absurdly long are handled', () => {
  assert.throws(() => D.toWorkout('Sorry, I cannot help.', C.estimateLoad), /did not contain a workout/);
  assert.throws(() => D.toWorkout('{"title":"x","intervals":[]}', C.estimateLoad), /any workout steps/);
  const prose = 'Here you go: {"workout":{"title":"Easy","category":"recovery","intervals":[{"name":"Spin","duration":1800,"pctFtp":50}]}} Enjoy!';
  const w = D.toWorkout(prose, C.estimateLoad);
  assert.equal(w.title, 'Easy');
  assert.equal(w.category, 'custom', 'unknown categories become custom');
  assert.throws(() => D.toWorkout('{"intervals":[{"duration":14400,"pctFtp":60},{"duration":14400,"pctFtp":60}]}', C.estimateLoad), /longer than 6 hours/);
});
