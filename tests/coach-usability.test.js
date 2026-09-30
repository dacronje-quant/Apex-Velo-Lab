const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

function load() {
  const values = new Map();
  const ctx = vm.createContext({ window: {}, localStorage: {
    getItem: k => values.get(k) || null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k)
  } });
  for (const file of ['velo-metrics', 'velo-ai-coach', 'velo-block-planner', 'velo-insight']) {
    const src = fs.readFileSync(`js/${file}.js`, 'utf8');
    vm.runInContext(src, ctx);
  }
  return { P: ctx.window.VeloBlockPlanner, C: ctx.window.VeloAiCoach, I: ctx.window.VeloInsight };
}
const { P, C, I } = load();
const context = overrides => ({
  profile: { name: 'Test rider', ftp: 185, weightKg: 75, maxHr: 175 },
  ctl: 35, atl: 32, tsb: 3, formKey: 'productive', formZone: 'Productive',
  sevenDayTss: 250, sevenDayHours: 5, recentWorkouts: [], recentList: '', consecutiveDays: 1,
  lookbackDays: 28, targetFocus: 'auto', durationMin: 60, goal: 'ftp', insight: { lines: [] },
  history: { rides28: 12, rides7: 3, hoursPerWeek4w: 5, hours7: 5, lowIntensityPct: 80, daysSinceHard: 3 },
  ...overrides
});
const options = { goal: 'ftp', weeks: 8, hoursPerWeek: null, days: [0, 2, 4, 6], longDay: 6, startDate: '2026-10-05' };
function planner(ctx = context()) {
  return new P({ isLive: false, getPhysiologicalContext: () => ctx, detectEngine: async () => {} });
}

test('blank hours asks AI to choose; entered and legacy hours stay manual', () => {
  for (const hours of [null, '', '  ']) assert.equal(P.normaliseOptions({ ...options, hoursPerWeek: hours }).aiChoosesHours, true);
  assert.equal(P.normaliseOptions({ ...options, hoursPerWeek: 7 }).hoursPerWeek, 7);
  assert.equal(P.normaliseOptions({ ...options, hoursPerWeek: undefined }).hoursPerWeek, 6);
});

test('AI time bounds respond to recent volume, a break, fatigue and little history', () => {
  const normal = P.historyTimeBounds(context(), options.days).baselineHours;
  assert.equal(normal, 5);
  assert(P.historyTimeBounds(context({ tsb: -30 }), options.days).baselineHours < normal);
  assert(P.historyTimeBounds(context({ readiness: { level: 'amber' } }), options.days).baselineHours < normal);
  assert(P.historyTimeBounds(context({ history: { rides28: 12, hoursPerWeek4w: 5, hours7: 0 } }), options.days).baselineHours < normal);
  assert.equal(P.historyTimeBounds(context({ history: {} }), options.days).baselineHours, 2);
});

test('AI-chosen time respects exact budgets, selected days and hard-day spacing', async () => {
  const p = planner(); p.coach.isLive = true;
  p.requestDesign = async () => ({ provider: 'mock', design: { weeks: Array.from({ length: 8 }, (_, i) => ({ week: i + 1, recommendedHours: 5 })) } });
  const { block } = await p.create(options);
  assert.equal(block.options.aiChoosesHours, true);
  const hardDates = [];
  let previous = block.options.hoursPerWeek;
  for (const w of block.weeks) {
    assert(w.plannedMin <= w.hoursBudget * 60 + 0.001);
    for (const s of w.sessions) {
      assert(options.days.includes(P.dow(s.date)));
      assert(s.durationMin >= P.FOCUS[s.focus].min);
      if (s.key) hardDates.push(P.parse(s.date).getTime());
    }
    if (w.type === 'build') {
      assert(w.hoursBudget <= previous * 1.1 + 0.001);
      previous = w.hoursBudget;
    }
  }
  for (let i = 1; i < hardDates.length; i++) assert((hardDates[i] - hardDates[i - 1]) / 86400000 >= 2);
  assert(block.weeks.find(w => w.type === 'recovery').hoursBudget < previous);
  assert(!/\b(CTL|ATL|TSB|TSS|FTP)\b/.test(block.summary));
});

test('AI chooses weekly time but cannot prescribe unlimited hours or bypass recovery', async () => {
  const p = planner();
  p.coach.isLive = true;
  let sent;
  p.requestDesign = async (opts, ctx) => {
    sent = p.buildDesignPrompt(opts, ctx);
    return { design: { summary: 'A gradual plan.', weeks: Array.from({ length: 8 }, (_, i) => ({
      week: i + 1, recommendedHours: i === 0 ? 4 : 999, targetTss: 99999
    })) }, provider: 'mock' };
  };
  const { block } = await p.create(options);
  assert(sent.includes('AI-CHOSEN WEEKLY TIME'));
  assert(sent.includes('"recommendedHours"'));
  assert.equal(block.weeks[0].hoursBudget, 4);
  for (const w of block.weeks) {
    assert(w.plannedMin <= w.hoursBudget * 60 + 0.001);
    assert(w.hoursBudget <= block.options.timeBounds.ceilingHours);
  }
});

test('blank hours never falls back to a local time choice or replaces an existing block on failure', async () => {
  const p = planner();
  p.block = { id: 'existing', weeks: [] };
  await assert.rejects(p.create(options), /AI coach is unavailable/);
  assert.equal(p.block.id, 'existing');
  p.coach.isLive = true;
  p.requestDesign = async () => { throw new Error('test outage'); };
  await assert.rejects(p.create(options), /AI could not choose/);
  assert.equal(p.block.id, 'existing');
  p.requestDesign = async () => ({ provider: 'mock', design: { weeks: [{ recommendedHours: 4 }] } });
  await assert.rejects(p.create(options), /every week/);
  assert.equal(p.block.id, 'existing');
});

test('reload and replan keep the hours field delegated to AI', async () => {
  const p = planner(); p.coach.isLive = true;
  p.requestDesign = async opts => ({ provider: 'mock', design: { weeks: Array.from({ length: opts.weeks }, (_, i) => ({ week: i + 1, recommendedHours: 4 })) } });
  await p.create({ ...options, startDate: P.today() });
  const reloaded = new P(p.coach);
  assert.equal(reloaded.block.options.aiChoosesHours, true);
  reloaded.requestDesign = p.requestDesign;
  const replanned = await reloaded.replanFromToday();
  assert.equal(replanned.block.options.aiChoosesHours, true);
});

test('manual plans retain the original session schedule and workout targets', () => {
  // Fixed snapshots from main before the AI-hours change (aad9e5d).
  // Comparing against HEAD would silently stop checking the old behavior after a commit.
  const original = {
    2: '59232d2cfdfafe8fea5cadf4fb7b652a36444d3a2465194d1124679985c06421',
    6: 'ff569c8f9f5e5b74e29b626b1df88f60464f101c2c09271158f2b3e8997489e7',
    12: '369a2065d2dbefb716de0b19f67002d0b8e8ea455056bcd5915ba0b041270510'
  };
  const ctx = context();
  for (const hoursPerWeek of [2, 6, 12]) {
    const opts = { ...options, hoursPerWeek };
    const current = P.assemble(P.normaliseOptions(opts), ctx);
    const snapshot = { sessions: current.weeks.map(w => w.sessions), stats: current.stats };
    assert.equal(createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'), original[hoursPerWeek]);
  }
});

test('offline advice uses everyday words while preserving exact workout instructions', () => {
  const c = Object.create(C.prototype);
  for (const focus of ['recovery', 'endurance', 'sweetspot', 'threshold', 'vo2max']) {
    const rec = c.generateOfflineHeuristic(context({ targetFocus: focus }));
    assert(!/\b(CTL|ATL|TSB|TSS|IF|NP|VO2|FTP)\b/.test(Object.values(rec.coachAssessment).join(' ')));
    assert(!/\d/.test(rec.coachAssessment.fitnessDiagnosis + rec.coachAssessment.fatigueStatus));
    assert(rec.workout.intervals.every(iv => Number.isFinite(iv.pctFtp) && iv.duration > 0 && iv.cadence > 0));
    assert.equal(rec.weekPlan.days.length, 7);
  }
});

test('all AI prompts request simple explanations while retaining numeric input and schemas', () => {
  const c = Object.create(C.prototype);
  const ctx = context();
  const prompt = c.buildPrompt(ctx);
  assert(prompt.includes('Write for a beginner'));
  assert(prompt.includes('"pctFtp": 55'));
  assert(prompt.includes('CTL (fitness) 35.0'));
  const p = planner();
  const blockPrompt = p.buildDesignPrompt(P.normaliseOptions({ ...options, hoursPerWeek: 6 }), ctx);
  assert(blockPrompt.includes('Use plain language for a beginner'));
  const review = I.breakdownPrompt([], { ftp: 185 });
  assert(review.includes('Use numbers only when needed'));
  for (const path of ['server.js', 'start_server.ps1']) {
    const src = fs.readFileSync(path, 'utf8');
    assert(src.includes('Explain things to a beginner'));
    assert(src.includes('Keep numeric workout fields and schema keys exact'));
    assert(!src.includes('reply with exactly the JSON object requested'));
  }
});
