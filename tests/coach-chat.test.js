// The AI Coach chat's pure helpers (js/velo-coach-chat.js): the rider's words set the options, workouts read
// back as one line, and the conversation (with the workouts and plans the coach built) goes to the AI in turns.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/velo-coach-chat.js');

test('every intent has the words the message box needs', () => {
  assert.deepEqual(C.INTENT_KEYS, ['chat', 'workout', 'plan']);
  for (const k of C.INTENT_KEYS) {
    const i = C.INTENTS[k];
    for (const f of ['label', 'short', 'icon', 'send', 'sendShort', 'placeholder', 'placeholderShort', 'help']) assert.ok(i[f], `${k}.${f}`);
  }
  assert.ok(C.EMPTY_REQUEST.workout && C.EMPTY_REQUEST.plan);
});

test('a workout length comes from the session, never from an interval', () => {
  const min = (t) => C.parseRequest(t, 'workout').durationMin ?? null;
  assert.equal(min('45 min sweet spot'), 45);
  assert.equal(min('a 90-minute endurance ride'), 90);
  assert.equal(min('1.5 h tempo'), 90);
  assert.equal(min('1h30 easy'), 90);
  assert.equal(min('an hour of zone 2'), 60);
  assert.equal(min('60 min with 3x10 min at 105%'), 60);
  assert.equal(min('2x20 min at threshold'), null);
  assert.equal(min('5 x 3 min VO2 with 3 min easy'), null);
  assert.equal(min('legs tired, something easy'), null);
  const p = C.parseRequest('50 min tempo', 'workout');
  assert.equal(p.durationOption, 45, 'the nearest length option');
  assert.deepEqual(p.said, ['50 min']);
  assert.deepEqual(C.parseRequest('45 min sweet spot', 'chat'), { said: [] }, 'a question sets nothing');
});

test('a plan request sets weeks, weekly hours, ride days and the long ride', () => {
  const days = [0, 1, 2, 3, 4, 5, 6];
  const a = C.parseRequest('Gran fondo in 10 weeks, no rides on Friday', 'plan', { days });
  assert.equal(a.weeks, 10);
  assert.deepEqual(a.days, [0, 1, 2, 3, 5, 6]);
  assert.deepEqual(a.said, ['10 weeks', 'no Friday']);
  assert.equal(C.parseRequest('3 weeks of base', 'plan').weeks, 4, 'clamped to the shortest plan');
  assert.equal(C.parseRequest('a 16 week build', 'plan').weeks, 12, 'clamped to the longest plan');
  assert.equal(C.parseRequest('6 hours a week', 'plan').hoursPerWeek, 6);
  assert.equal(C.parseRequest('6 hours a week', 'workout').durationMin, undefined, 'weekly hours are not a session length');
  assert.deepEqual(C.parseRequest('4 rides a week', 'plan', { days: [0, 2] }).days, [1, 3, 5, 6]);
  assert.equal(C.parseRequest('4 rides a week', 'plan', { days: [0, 2, 4, 6] }).days, undefined, 'the same number of days keeps the rider\'s days');
  assert.deepEqual(C.parseRequest("can't ride Mondays or Wednesdays", 'plan', { days }).days, [1, 3, 4, 5, 6]);
  assert.deepEqual(C.parseRequest('except Tuesday, Thursday and Friday', 'plan', { days }).days, [0, 2, 5, 6]);
  const long = C.parseRequest('long ride on Saturday', 'plan', { days: [1, 3] });
  assert.equal(long.longDay, 5);
  assert.deepEqual(long.days, [1, 3, 5], 'the long ride day becomes a ride day');
  assert.equal(C.parseRequest('no rides on Sunday, long ride Sunday', 'plan', { days }).longDay, undefined, 'a day off is never the long ride');
});

test('a workout reads back as one line with its repeats folded', () => {
  const ivs = [{ duration: 600, pctFtp: 55 }];
  for (let i = 0; i < 3; i++) ivs.push({ duration: 720, pctFtp: 90 }, { duration: 240, pctFtp: 55 });
  ivs.push({ duration: 300, pctFtp: 50 });
  assert.equal(C.structure(ivs), '10m 55%, 3x (12m 90%, 4m 55%), 5m 50%');
  const thirty = [{ duration: 600, pctFtp: 55 }];
  for (let i = 0; i < 10; i++) thirty.push({ duration: 30, pctFtp: 120 }, { duration: 15, pctFtp: 50 });
  assert.equal(C.structure(thirty), '10m 55%, 10x (30s 120%, 15s 50%)');
  assert.equal(C.structure([{ duration: 90, pctFtp: 100 }]), '1m30s 100%');
  assert.ok(C.structure(Array.from({ length: 200 }, (_, i) => ({ duration: 60 + i, pctFtp: 60 }))).length <= 420);
});

const workout = { role: 'workout', workout: { title: 'Threshold 2x8', durationMin: 40, tss: 45, if: 0.84, intervals: [{ duration: 600, pctFtp: 55 }, { duration: 480, pctFtp: 105 }, { duration: 240, pctFtp: 55 }, { duration: 480, pctFtp: 105 }, { duration: 240, pctFtp: 55 }, { duration: 300, pctFtp: 50 }] }, assessment: { trainingAdvice: 'Hold cadence at 90.' } };
const plan = { role: 'plan', plan: { title: 'Raise FTP block', weekCount: 2, startDate: '2026-11-23', endDate: '2026-12-06', hours: 'up to 6 h a week', summary: 'Build, then recover.', weeks: [{ index: 1, type: 'build', phase: 'Base' }, { index: 2, type: 'recovery', phase: 'Recover' }] } };

test('the conversation goes to the AI as alternating turns, with the coach\'s workouts and plans as its turns', () => {
  const msgs = [
    { role: 'note', content: 'Now looking at: Last 6 weeks' },
    { role: 'assistant', content: 'an orphan answer before any question' },
    { role: 'user', content: 'How is my fitness?' },
    { role: 'assistant', content: 'Up 4 points.' },
    { role: 'user', intent: 'workout', content: '' },
    workout,
    { role: 'user', intent: 'plan', content: 'Two weeks please' },
    plan,
    { role: 'error', content: 'busy' },
    { role: 'user', content: 'Why that workout?' }
  ];
  const h = C.historyForApi(msgs);
  assert.deepEqual(h.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user']);
  assert.equal(h[0].content, 'How is my fitness?', 'it starts with the rider; notes, errors and an orphan answer are left out');
  assert.equal(h[2].content, C.EMPTY_REQUEST.workout, 'an empty request still has words');
  assert.match(h[3].content, /^\[Built in this chat\] Workout "Threshold 2x8" \(40 min, TSS 45, IF 0\.84\): 10m 55%, 2x \(8m 105%, 4m 55%\), 5m 50%\. Coach's advice: Hold cadence at 90\./);
  assert.match(h[5].content, /^\[Built in this chat\] Training plan "Raise FTP block": 2 weeks, 2026-11-23 to 2026-12-06, up to 6 h a week\. Weeks: W1 build \(Base\), W2 recovery \(Recover\)\./);
  const joined = C.historyForApi([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }, { role: 'assistant', content: 'c' }]);
  assert.deepEqual(joined, [{ role: 'user', content: 'a\n\nb' }, { role: 'assistant', content: 'c' }], 'turns in a row are joined');
  assert.equal(C.historyForApi(Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i) }))).length, 20);
});

test('a workout or plan request carries the chat so far, the asked-about answer at length', () => {
  const long = 'x'.repeat(1500);
  const msgs = [{ role: 'user', content: 'Plan my week?' }, { role: 'assistant', content: `Ride 4 x 8 min at 105% FTP. ${long}` }, workout];
  const b = C.brief(msgs);
  assert.match(b, /^Rider: Plan my week\?\nCoach: Ride 4 x 8 min/);
  assert.ok(b.split('\n')[1].length <= 520, 'answers are cut short by default');
  assert.match(b, /Coach built: Workout "Threshold 2x8"/);
  assert.ok(C.brief(msgs, { focus: 1 }).split('\n')[1].length > 1400, '"Make it a workout" keeps that answer');
  const many = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ${'y'.repeat(400)}` }));
  assert.ok(C.brief(many).length <= 2600, 'the oldest turns go when it is long');
  assert.match(C.brief(many), /turn 29/);
  assert.equal(C.requestNotes('make it shorter', ''), 'make it shorter');
  assert.match(C.requestNotes('make it shorter', 'Rider: hi'), /^make it shorter\n\nEARLIER IN THIS CHAT \(context only - build what the rider asks for above\):\nRider: hi$/);
});

test('an answer that describes a session offers to become a workout', () => {
  assert.equal(C.looksLikeSession('Try 4 x 8 min at 105% FTP with 4 min easy.'), true);
  assert.equal(C.looksLikeSession('Ride 90 min in zone 2 at 65% of FTP.'), true);
  assert.equal(C.looksLikeSession('Your fitness rose 12% this month and fatigue is steady.'), false);
});
