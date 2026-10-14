const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load() {
  const values = new Map();
  const ctx = vm.createContext({ window: {}, performance, localStorage: {
    getItem: k => values.get(k) || null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k)
  } });
  for (const file of ['velo-metrics', 'velo-sport-science', 'velo-ai-coach', 'velo-block-planner']) {
    vm.runInContext(fs.readFileSync(`js/${file}.js`, 'utf8'), ctx);
  }
  return { S: ctx.window.VeloSportScience, C: ctx.window.VeloAiCoach, P: ctx.window.VeloBlockPlanner, ctx };
}
const { S, C, P, ctx: realm } = load();
const context = overrides => ({
  profile: { name: 'Test rider', ftp: 200, weightKg: 75, maxHr: 180 },
  ctl: 40, atl: 38, tsb: 2, formKey: 'productive', formZone: 'Productive',
  sevenDayTss: 300, sevenDayHours: 6, recentWorkouts: [], recentList: '', consecutiveDays: 1,
  lookbackDays: 28, targetFocus: 'auto', durationMin: 60, goal: 'ftp', insight: { lines: [] }, notes: '',
  history: { rides28: 12, hoursPerWeek4w: 6, hoursPerWeekWin: 6, lowIntensityPct: 80, highIntensityPct: 10, daysSinceHard: 6 },
  ...overrides
});

test('every evidence entry is graded, fully referenced and written plainly for riders', () => {
  for (const [id, e] of Object.entries(S.EVIDENCE)) {
    assert(['A', 'B', 'C'].includes(e.grade), id);
    assert(e.refs.length > 0, id);
    for (const r of e.refs) assert(S.REFERENCES[r], `${id}: ${r} has no full reference`);
    assert(!/\b(CTL|ATL|TSB|TSS|FTP|VO2|HRV|HRmax)\b/.test(e.plain), `${id} plain text uses jargon`);
  }
  for (const [goal, m] of Object.entries(S.GOAL_MODELS)) {
    assert(C.GOALS[goal], goal);
    for (const id of m.evidence) assert(S.EVIDENCE[id], `${goal}: ${id}`);
  }
});

test('the brief is tailored to the goal and to the rider', () => {
  const vo2 = S.brief('vo2', context());
  assert(vo2.includes('Rønnestad et al., 2020') && vo2.includes('GOAL MODEL'));
  assert(!vo2.includes('Mandsager'));
  const longevity = S.brief('longevity', context());
  assert(longevity.includes('Mandsager et al., 2018') && longevity.includes('4 x 4'));
  // Context adds only what applies.
  assert(!S.select('ftp', context()).includes('hrv'));
  assert(S.select('ftp', context({ readiness: { level: 'amber' } })).includes('hrv'));
  assert(S.select('ftp', context({ tsb: -22 })).includes('recovery'));
  assert(S.select('ftp', context({ strength: { count: 2 } })).includes('strength'));
  assert(S.select('balanced', context({ history: { hoursPerWeekWin: 3 } })).includes('time_efficient'));
  assert(S.select('ftp', context({ notes: 'Gran fondo race in 6 weeks' })).includes('taper'));
  assert(!S.select('ftp', context({ notes: 'critical power test went well' })).includes('taper'));
  assert(S.select('ftp', context({ notes: 'I am 58 years old' })).includes('masters'));
  assert(S.select('ftp', context(), 'block').includes('taper'));
});

test('only references from the evidence base survive in AI output', () => {
  assert.equal(S.verifyRef('Ronnestad et al. 2020'), 'Rønnestad et al., 2020');
  assert.equal(S.verifyRef('Stoggl and Sperlich (2014)'), 'Stöggl & Sperlich, 2014');
  assert.equal(S.verifyRef('Smith et al., 2025'), '');
  assert.equal(S.verifyRef(''), '');
  const clean = S.sanitise([
    { principle: 'Short intervals', why: 'More time near your limit.', ref: 'Rønnestad et al., 2015' },
    { principle: 'Made up', why: 'Invented claim.', ref: 'Doe et al., 2026' },
    { principle: '', why: 'missing name' },
    'not an object'
  ]);
  assert.equal(clean.length, 2);
  assert.equal(clean[0].grade, 'B');
  assert.equal(clean[1].ref, '');
  assert.equal(S.sanitise(null).length, 0);
});

test('AI prompts carry the evidence brief, the method and an evidence field', () => {
  const c = Object.create(C.prototype);
  const prompt = c.buildPrompt(context({ goal: 'vo2' }));
  assert(prompt.includes('SPORT-SCIENCE EVIDENCE BRIEF'));
  assert(prompt.includes('METHOD: 1) needs analysis'));
  assert(prompt.includes('"evidence": ['));
  assert(prompt.includes('Cite only the references listed above'));
  const p = new P({ isLive: false });
  const block = p.buildDesignPrompt(P.normaliseOptions({ goal: 'ftp', weeks: 8, hoursPerWeek: 6, days: [0, 2, 4, 6] }), context());
  assert(block.includes('SPORT-SCIENCE EVIDENCE BRIEF') && block.includes('Bosquet et al., 2007'));
  assert(block.includes('"evidence": ['));
});

test('AI evidence with invented studies is cleaned before it reaches the rider', async () => {
  const c = new C({ activeProfile: context().profile, completedWorkouts: [] });
  c.getPhysiologicalContext = () => context();
  c.engine = { reachable: true, provider: 'claude', providers: { claude: { configured: true, model: 'claude-opus-5-5' } } };
  const answer = {
    coachAssessment: { formZone: 'Productive', fitnessDiagnosis: 'a', fatigueStatus: 'b', trainingAdvice: 'c' },
    workout: { title: 'T', category: 'vo2', intervals: [{ name: 'Warmup', duration: 600, pctFtp: 55, cadence: 88 }, { name: 'Hard', duration: 240, pctFtp: 112, cadence: 98 }, { name: 'Cooldown', duration: 300, pctFtp: 45, cadence: 85 }] },
    weekPlan: { days: [{ dayLabel: 'Today', focus: 'vo2max', title: 'x', durationMin: 20, tss: 20 }] },
    evidence: [{ principle: 'Real', why: 'Real study.', ref: 'Helgerud et al., 2007' }, { principle: 'Fake', why: 'Fake study.', ref: 'Nobody et al., 2031' }]
  };
  realm.fetch = async () => ({ ok: true, json: async () => ({ text: JSON.stringify(answer), provider: 'claude', model: 'claude-opus-5-5' }) });
  vm.runInContext('globalThis.fetch = fetch', realm);
  const rec = await c.generateRecommendation('auto', 60, 'vo2');
  assert.equal(rec.source, 'claude');
  assert.deepEqual(Array.from(rec.evidence, e => e.ref), ['Helgerud et al., 2007', '']);
});

test('offline sessions explain their evidence in plain words', () => {
  const c = Object.create(C.prototype);
  for (const goal of ['ftp', 'vo2', 'longevity', 'balanced']) {
    const rec = c.generateOfflineHeuristic(context({ goal }));
    assert(rec.evidence.length >= 2 && rec.evidence.length <= 4, goal);
    for (const e of rec.evidence) {
      assert(e.principle && e.why && S.REFERENCES[e.ref] && e.grade);
      assert(!/\b(CTL|ATL|TSB|TSS|FTP|VO2)\b/.test(e.principle + ' ' + e.why), e.principle);
    }
  }
  const recovery = c.generateOfflineHeuristic(context({ targetFocus: 'recovery' }));
  assert(!recovery.evidence.some(e => /interval|threshold/i.test(e.principle)));
  const long = c.generateOfflineHeuristic(context({ targetFocus: 'endurance', durationMin: 120 }));
  assert(/carbohydrate per hour/.test(long.coachAssessment.trainingAdvice));
  const short = c.generateOfflineHeuristic(context({ targetFocus: 'endurance', durationMin: 60 }));
  assert(!/carbohydrate/.test(short.coachAssessment.trainingAdvice));
});

test('longevity builds aerobic fitness with a heart-rate guided 4 x 4 that fits the time', () => {
  const c = Object.create(C.prototype);
  const ctx = context({ goal: 'longevity' });
  assert.equal(c.decideFocus(ctx), 'vo2max');
  assert.equal(c.decideFocus(context({ goal: 'longevity', history: { daysSinceHard: 2 } })), 'endurance');
  for (const durationMin of [45, 60, 90]) {
    const rec = c.generateOfflineHeuristic(context({ goal: 'longevity', targetFocus: 'vo2max', durationMin }));
    const hard = rec.workout.intervals.filter(iv => /Aerobic Power/.test(iv.name));
    assert.equal(hard.length, 4);
    assert(hard.every(iv => iv.duration === 240));
    assert(Math.abs(rec.workout.durationMin - durationMin) <= 3, `${durationMin} -> ${rec.workout.durationMin}`);
    assert(rec.coachAssessment.trainingAdvice.includes('153-171 bpm'));
  }
  const week = c.buildWeekPlan(ctx, 'vo2max', c.buildWorkout('vo2max', ctx).workout);
  assert.equal(week.days.filter(d => d.focus === 'vo2max').length, 1);
  assert(P.PHASES.longevity.slice(1).every(ph => ph.keys[0] === 'vo2max'));
});

test('key sessions progress through a phase: more time in zone, same session length', () => {
  const c = Object.create(C.prototype);
  const inZone = (focus, step, extra = {}) => {
    const ctx = context({ durationMin: 75, progressionStep: step, ...extra });
    const { workout } = c.buildWorkout(focus, ctx);
    assert(Math.abs(workout.durationMin - 75) <= 3, `${focus} step ${step}: ${workout.durationMin}`);
    return workout.intervals.filter(iv => iv.pctFtp >= 85).reduce((a, iv) => a + iv.duration, 0);
  };
  for (const [focus, extra] of [['sweetspot', {}], ['threshold', {}], ['vo2max', {}], ['vo2max', { ctl: 15 }]]) {
    const t = [0, 1, 2].map(s => inZone(focus, s, extra));
    assert(t[0] <= t[1] && t[1] <= t[2] && t[0] < t[2], `${focus} ${JSON.stringify(extra)}: ${t}`);
  }
  // Without a block, sessions are unchanged.
  const base = c.buildWorkout('sweetspot', context({ durationMin: 75 })).workout.intervals;
  const none = c.buildWorkout('sweetspot', context({ durationMin: 75, progressionStep: null })).workout.intervals;
  assert.deepEqual(base, none);
  assert.equal(S.progressionStep({ type: 'build', stage: '1/3' }), 0);
  assert.equal(S.progressionStep({ type: 'build', stage: '2/3' }), 1);
  assert.equal(S.progressionStep({ type: 'build', stage: '3/3' }), 2);
  assert.equal(S.progressionStep({ type: 'build', stage: '2/2' }), 2);
  assert.equal(S.progressionStep({ type: 'recovery', stage: '' }), null);
});

test('blocks carry their evidence and load progressive key workouts', async () => {
  const coach = {
    isLive: false, model: 'mock', detectEngine: async () => {}, buildWorkout: C.prototype.buildWorkout,
    getPhysiologicalContext: (focus, durationMin, goal) => context({ targetFocus: focus, durationMin, goal })
  };
  const p = new P(coach);
  const { block } = await p.create({ goal: 'ftp', weeks: 8, hoursPerWeek: 7, days: [1, 3, 5, 6], longDay: 6, startDate: '2026-11-02' }, { useAi: false });
  assert(block.evidence.length >= 3);
  assert(block.evidence.every(e => S.REFERENCES[e.ref]));
  const firstMeso = block.weeks.slice(0, 3);
  const ss = firstMeso.map(w => w.sessions.find(s => s.focus === 'sweetspot')).filter(Boolean);
  assert.equal(ss.length, 3);
  const rests = ss.map(s => p.workoutFor(s.id).intervals.filter(iv => /^Recovery \d/.test(iv.name)).map(iv => iv.duration)[0]);
  assert(rests[0] > rests[2], `rests ${rests}`);
  // An AI design with invented references falls back to the evidence base.
  p.coach.isLive = true;
  p.requestDesign = async (opts) => ({ provider: 'mock', model: 'm', design: { weeks: Array.from({ length: opts.weeks }, (_, i) => ({ week: i + 1 })), evidence: [{ principle: 'x', why: 'y', ref: 'Fake, 2030' }] } });
  const ai = await p.create({ goal: 'vo2', weeks: 6, hoursPerWeek: 6, days: [1, 3, 5, 6], startDate: '2026-11-02' });
  assert.equal(ai.block.evidence.length, 1);
  assert.equal(ai.block.evidence[0].ref, '');
});

test('both servers use the same sport-scientist system prompt', () => {
  // Line endings are normalised: Windows checkouts use CRLF.
  const js = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n').match(/const SYSTEM_PROMPT = ([\s\S]*?);\n/)[1];
  const fromJs = vm.runInNewContext(js);
  const ps = fs.readFileSync('start_server.ps1', 'utf8').replace(/\r\n/g, '\n').match(/\$systemPrompt = ([\s\S]*?)\n\n/)[1];
  const fromPs = ps.split(/" \+\s*\n\s*"/).join('').replace(/^"|"$/g, '');
  assert.equal(fromPs, fromJs);
  assert(fromJs.includes('Never invent data, studies or citations'));
  assert(fromJs.includes('SPORT-SCIENCE EVIDENCE BRIEF'));
  assert(/^[\x20-\x7e]*$/.test(fromJs));
});
