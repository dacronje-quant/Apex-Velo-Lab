const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ctx = vm.createContext({});
for (const file of ['velo-metrics', 'velo-dedupe', 'velo-strava-sync'])
  vm.runInContext(fs.readFileSync(`js/${file}.js`, 'utf8'), ctx);
const S = vm.runInContext('VeloStravaSync', ctx);
const activity = { id: '123', sport_type: 'Ride', name: 'Outdoor ride', start_date: '2026-09-20T08:00:00Z',
  moving_time: 3500, elapsed_time: 4000, distance: 30123, average_heartrate: 145 };
const ride = { id: 'hf', source: 'HealthFit FIT', date: activity.start_date, duration: 3600,
  distanceKm: 29, avgWatts: 180, np: 200, tss: 80, samples: [{ time: 1, power: 180 }],
  strava: { activityId: '123', state: 'found' } };
const range = S.rangeFor({ mode: 'custom', from: '2026-09-19', to: '2026-09-21' });
const plan = (r, a = activity) => S.plan({ history: [r], activities: [a], range });
const json = value => JSON.parse(JSON.stringify(value));

test('already linked HealthFit rides refresh Strava time/distance and retain local telemetry/load', () => {
  const original = JSON.stringify(ride);
  const p = plan(ride);
  assert.equal(p.refreshed.length, 1);
  assert.equal(p.new.length, 0);
  const next = S.nextState([ride], p).history[0];
  assert.equal(next.duration, 3500);
  assert.equal(next.distanceKm, 30.12);
  assert.equal(next.elapsedSec, 4000);
  assert.equal(next.avgHr, 145);
  assert.equal(next.samples, ride.samples);
  assert.equal(next.tss, 80);
  assert.equal(next.np, 200);
  assert.equal(next.source, ride.source);
  assert.deepEqual(json(S.validate([ride], [next], p)), []);
  assert.equal(JSON.stringify(ride), original);
  assert.equal(plan(next).hasChanges, false);
  const edited = S.nextState([next], plan(next, { ...activity, distance: 32000, moving_time: 3700 })).history[0];
  assert.equal(edited.distanceKm, 32);
  assert.equal(edited.duration, 3700);
});

test('missing or invalid Strava summary falls back to original HealthFit values', () => {
  const combined = S.combineRecord(ride, activity);
  const next = S.combineRecord(combined, { ...activity, distance: null, moving_time: 0, elapsed_time: 0, average_heartrate: null });
  assert.equal(next.duration, 3600);
  assert.equal(next.distanceKm, 29);
  assert.equal(next.avgHr, 145);
  assert.equal(next.samples, ride.samples);
  assert.equal(S.combineRecord(ride, { ...activity, distance: -10 }).distanceKm, 29);
  assert.equal(S.combineRecord(ride, { ...activity, moving_time: -5 }).duration, 4000);
});

test('new matches combine once, validate and become idempotent linked refreshes', () => {
  const unlinked = { ...ride, source: 'FIT import', strava: undefined };
  const p = plan(unlinked);
  assert.equal(p.linked.length, 1);
  const state = S.nextState([unlinked], p);
  assert.equal(state.history.length, 1);
  const next = state.history[0];
  assert.equal(next.strava.activityId, '123');
  assert.equal(next.distanceKm, 30.12);
  assert.equal(next.samples, ride.samples);
  assert.deepEqual(json(S.validate([unlinked], state.history, p)), []);
  assert.equal(plan(next).hasChanges, false);
});

test('unmatched and out-of-range native records remain unchanged; validation rejects unrelated edits', () => {
  const p = S.plan({ history: [ride], activities: [], range });
  assert.equal(S.nextState([ride], p).history[0], ride);
  const matched = plan(ride);
  const next = S.nextState([ride], matched).history[0];
  assert.ok(S.validate([ride], [{ ...next, title: 'Unexpected edit' }], matched).length);
  assert.ok(S.validate([ride], [{ ...next, samples: [] }], matched).length);
});

test('Strava streams fill absent local recordings while existing samples always win', () => {
  const empty = { ...ride, samples: [], avgWatts: 0, np: 0, tss: 0 };
  const a = { ...activity, average_watts: 200, device_watts: true };
  assert.deepEqual(json(S.streamCandidates(plan(empty, a))), ['123']);
  const samples = Array.from({ length: 60 }, (_, i) => ({ time: i + 1, power: 200 }));
  const p = plan(empty, { ...a, samples });
  const next = S.nextState([empty], p).history[0];
  assert.equal(next.samples.length, 60);
  assert.equal(next.tssMethod, 'power-stream');
  assert.deepEqual(json(S.validate([empty], [next], p)), []);
  assert.equal(plan(next, a).hasChanges, false);
  assert.equal(S.combineRecord(ride, { ...a, samples }).samples, ride.samples);
  const unlinked = { ...empty, source: 'FIT import', strava: undefined };
  assert.deepEqual(json(S.streamCandidates(plan(unlinked, a))), ['123']);
  const first = S.nextState([empty], plan(empty, a)).history[0];
  const retry = plan(first, a);
  assert.equal(retry.hasChanges, false);
  assert.deepEqual(json(S.streamCandidates(retry)), ['123']);
});
