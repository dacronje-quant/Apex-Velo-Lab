// Riding with the screen off (src/native-ride.js): the page hands each sample to the native recorder, the
// native side takes over when the page stops ticking, and the page takes the seconds back on resume without
// losing or doubling one; an unfinished journal becomes the recovery copy. The native side is the
// contract-equivalent fake in fake-ride-native.cjs (the Kotlin recorder has its own JVM tests).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mergeSamples, planFromApp, adoptSnapshot, recoverySnapshot, NativeRide, LEASE_MS } from '../src/native-ride.js';

const { FakeRideNative } = createRequire(import.meta.url)('./fake-ride-native.cjs');

/** Enough of VeloApp for the ride hooks: a 1 Hz tick that records like js/app.js, pause, finish. */
class FakeApp {
  constructor() {
    this.activeProfile = { ftp: 200, weightKg: 70 };
    this.activeProfileId = 'p1';
    this.ergBiasMultiplier = 1;
    this.ergModeEnabled = true;
    this.currentWorkout = { id: 'w', title: 'W', intervals: [{ name: 'Warmup', pctFtp: 50, duration: 10 }, { name: 'Steady', pctFtp: 75, duration: 10 }] };
    this.intervalIndex = 0;
    this.intervalSecondsRemaining = 10;
    this.totalElapsedSeconds = 0;
    this.totalDistanceMeters = 0;
    this.maxSpeedKmh = 0;
    this.recordedSamples = [];
    this.isPlaying = false;
    this.isWorkoutCompleted = false;
    this.toasts = [];
    this.calls = [];
    this.analytics = { n: 0, segments: 0, reset() { this.n = 0; this.segments = 0; }, startSegment() { this.segments++; }, update() { this.n++; } };
    this.erg = { offset: 0, lastBase: 100 };
  }
  getCurrentTargetWatts() { return Math.round(this.activeProfile.ftp * this.currentWorkout.intervals[this.intervalIndex].pctFtp / 100 * this.ergBiasMultiplier); }
  togglePlayPause() { this.isPlaying = !this.isPlaying; this.calls.push(this.isPlaying ? 'play' : 'pause'); }
  tick1Hz() {
    this.totalElapsedSeconds++; this.intervalSecondsRemaining--;
    this.recordedSamples.push({ time: this.totalElapsedSeconds, workoutStep: this.intervalIndex, power: 180, hr: 140, target: this.getCurrentTargetWatts() });
    if (this.intervalSecondsRemaining <= 0 && this.intervalIndex < this.currentWorkout.intervals.length - 1) {
      this.intervalIndex++; this.intervalSecondsRemaining = this.currentWorkout.intervals[this.intervalIndex].duration;
    }
  }
  finishWorkout() { this.isWorkoutCompleted = true; this.isPlaying = false; this.calls.push('finish'); }
  finishRampTest(f) { this.calls.push('ramp:' + f.reason); }
  resetWorkout() { this.totalElapsedSeconds = 0; this.recordedSamples = []; }
  showToast(m) { this.toasts.push(m); }
}

function setup({ visible = true } = {}) {
  let clock = 1000;
  const fake = new FakeRideNative({ now: () => clock });
  const doc = { visibilityState: visible ? 'visible' : 'hidden', addEventListener() {} };
  const win = { document: doc, crypto: globalThis.crypto, VeloStorage: { storeId: 's1' } };
  const ride = new NativeRide({ plugin: fake, win });
  class App extends FakeApp {}
  ride.install(App.prototype, null, null);
  const app = new App();
  win.app = app;
  const settle = async () => { await ride.queue; await ride.reclaiming; await ride.queue; };
  return { fake, ride, app, doc, settle, advance: (ms) => { clock += ms; } };
}

test('mergeSamples keeps the page seconds up to the handoff, then the native ones, one per second', () => {
  const js = [1, 2, 3, 4].map((time) => ({ time, by: 'js' }));
  const nat = [6, 4, 5, 5].map((time) => ({ time, by: 'native' }));
  const m = mergeSamples(js, nat, 3);
  assert.deepEqual(m.map((s) => [s.time, s.by]), [[1, 'js'], [2, 'js'], [3, 'js'], [4, 'native'], [5, 'native'], [6, 'native']]);
});

test('the plan carries the page\'s step targets, devices and ramp settings', () => {
  const app = new FakeApp();
  app.ergBiasMultiplier = 1.05;
  app.ble = { slots: { trainer: { device: { id: 'AA:01' } }, hr: { device: null } }, powerRange: { min: 0, max: 1500 } };
  const plan = planFromApp(app);
  assert.deepEqual(plan.steps.map((s) => s.watts), [105, 158]);
  assert.equal(plan.trainer, 'AA:01');
  assert.equal(plan.hr, '');
  assert.equal(plan.powerMax, 1500);
  assert.equal(plan.rampStepPct, 0);
});

test('page ticks are handed over; a paused page is replaced by native seconds and takes them back with none lost', async () => {
  const { fake, ride, app, settle, advance } = setup();
  app.togglePlayPause();
  await settle();
  assert.equal(ride.active, true);
  assert.equal(fake.active, true);
  for (let i = 0; i < 5; i++) { app.tick1Hz(); await settle(); advance(1000); fake.tick(); }
  assert.equal(fake.journal.samples.length, 5, 'every page second reaches the journal');
  assert.equal(fake.native.length, 0, 'the native side only records while the page does not');
  assert.equal(ride.jsTime, 5);

  // The WebView is paused: nothing from the page for longer than the lease.
  for (let i = 0; i < 8; i++) { advance(1000); fake.tick(); }
  assert.equal(fake.owner, 'native');
  assert.equal(fake.elapsed, 12);
  assert.deepEqual(fake.commands.filter((c) => c.op === 'target').map((c) => c.watts), [100, 150], 'ERG target at takeover and at the step change');

  // The page runs one tick before it hears it lost the ride: that second is dropped for the native one.
  app.tick1Hz();
  await settle();
  assert.equal(ride.owner, 'js');
  assert.deepEqual(app.recordedSamples.map((s) => s.time), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.ok(app.recordedSamples.slice(5).every((s) => s.bg === 1));
  assert.equal(app.totalElapsedSeconds, 12);
  assert.equal(app.intervalIndex, 1);
  assert.equal(app.intervalSecondsRemaining, 8);
  assert.equal(app.analytics.n, 12, 'analytics rebuilt from the merged ride');
  assert.match(app.toasts.at(-1), /7 s recorded while the screen was off/);

  // The page owns the ride again: its next second is accepted and follows on.
  app.tick1Hz();
  await settle();
  assert.equal(ride.jsTime, 13);
  assert.equal(fake.elapsed, 13);
});

test('while hidden the page leaves the ride to the native side, and takes it back when visible', async () => {
  const { fake, ride, app, doc, settle, advance } = setup({ visible: false });
  app.togglePlayPause();
  await settle();
  app.tick1Hz(); await settle();
  for (let i = 0; i < 5; i++) { advance(1000); fake.tick(); }
  app.tick1Hz(); await settle(); // rejected: hidden, so no reclaim
  assert.equal(ride.owner, 'native');
  app.tick1Hz(); await settle(); // skipped
  assert.equal(app.totalElapsedSeconds, 2, 'the page does not tick while the native side owns the ride');
  doc.visibilityState = 'visible';
  app.tick1Hz(); await settle();
  assert.equal(ride.owner, 'js');
  assert.deepEqual(app.recordedSamples.map((s) => s.time), [1, 2, 3, 4]);
});

test('Pause in the notification, the workout end and a ramp-test stop reach the page on resume', async () => {
  const { fake, app, ride, settle, advance } = setup();
  app.togglePlayPause(); await settle();
  for (let i = 0; i < 4; i++) { advance(1000); fake.tick(); }
  fake.notificationPause(true);
  assert.equal(fake.commands.at(-1).op, 'pause', 'the native side pauses the trainer itself');
  await ride.reclaim(app);
  assert.deepEqual(app.calls, ['play', 'pause']);

  const b = setup();
  b.app.togglePlayPause(); await b.settle();
  for (let i = 0; i < 25; i++) { b.advance(1000); b.fake.tick(); }
  assert.equal(b.fake.ended, true);
  await b.ride.reclaim(b.app);
  assert.equal(b.app.calls.at(-1), 'finish');
  assert.equal(b.app.recordedSamples.length, 20, 'recording stops at the end of the workout');
  assert.equal(b.fake.active, false, 'the saved ride stops the native recorder');

  const c = setup();
  c.app.togglePlayPause(); await c.settle();
  for (let i = 0; i < 4; i++) { c.advance(1000); c.fake.tick(); }
  c.fake.event = { type: 'test-stop', reason: 'target-missed', measuredWatts: 150 };
  await c.ride.reclaim(c.app);
  assert.equal(c.app.calls.at(-1), 'ramp:target-missed');
});

test('notification Pause while the page owns the ride toggles the page', async () => {
  const { fake, app, settle } = setup();
  app.togglePlayPause(); await settle();
  fake.notificationPause(true);
  assert.equal(app.isPlaying, false);
  await settle();
  assert.equal(fake.paused, true);
});

test('the plan is sent again only when it changes', async () => {
  const { fake, app, settle } = setup();
  const sent = [];
  const sample = fake.sample.bind(fake);
  fake.sample = (a) => { sent.push(!!a.plan); return sample(a); };
  app.togglePlayPause(); await settle();
  app.tick1Hz(); await settle();
  app.ergBiasMultiplier = 1.1;
  app.tick1Hz(); await settle();
  app.tick1Hz(); await settle();
  assert.deepEqual(sent, [false, true, false]);
  assert.equal(fake.plan.steps[0].watts, 110);
});

test('an unfinished journal becomes the recovery copy when it has more than the page checkpoint', async () => {
  const header = JSON.stringify({ key: 'sqlite_active_ride:k1', storeId: 's1', profileId: 'p1', startedAt: 5, workout: { id: 'w', intervals: [{ name: 'A', duration: 60, pctFtp: 50 }] } });
  const samples = [1, 2, 2, 3].map((time) => JSON.stringify({ time, timestamp: 1000 + time, power: 200, dist: time / 100, workoutStep: 0 }));
  const snap = recoverySnapshot({ header: JSON.parse(header), samples, state: { step: 0, remaining: 57, distanceM: 30, maxSpeed: 32 } });
  assert.deepEqual(snap.samples.map((s) => s.time), [1, 2, 3]);
  assert.equal(snap.elapsed, 3);
  assert.equal(snap.remaining, 57);
  assert.equal(snap.key, 'sqlite_active_ride:k1');
  assert.equal(recoverySnapshot({ header: JSON.parse(header), samples: [] }), null);

  const fake = new FakeRideNative();
  fake.journal = { header, samples, state: JSON.stringify({ step: 0, remaining: 57, distanceM: 30, maxSpeed: 32 }) };
  const idb = new Map([['sqlite_active_ride:k1', { key: 'sqlite_active_ride:k1', samples: [{ time: 1 }] }]]);
  const settings = { getSetting: async (k) => idb.get(k) || null, putSetting: async (v) => { idb.set(v.key, v); return true; } };
  let initRan = false;
  const V = { storeId: 's1', initRecovery: async () => { initRan = true; } };
  new NativeRide({ plugin: fake, win: { document: { addEventListener() {} } } }).install({}, V, settings);
  await V.initRecovery({});
  assert.equal(initRan, true);
  assert.equal(idb.get('sqlite_active_ride:k1').samples.length, 3, 'the journal replaces the shorter checkpoint');
  assert.equal(fake.journal, null, 'the journal is cleared once the recovery copy holds it');
  assert.ok(LEASE_MS >= 2000);
});

test('save and discard stop the native recorder; the first ride explains battery settings once', async () => {
  const { fake, app, ride, settle } = setup();
  const store = new Map();
  ride.prefs = { get: async (k) => store.get(k), set: async (k, v) => store.set(k, v) };
  const body = [];
  ride.win.document = { visibilityState: 'visible', addEventListener() {}, getElementById: () => null,
    createElement: () => ({ setAttribute() {}, addEventListener() {}, remove() {} }), body: { appendChild: (n) => body.push(n) } };
  await ride.permissionsOnce();
  await ride.permissionsOnce();
  assert.equal(body.length, 1);
  app.togglePlayPause(); await settle();
  app.tick1Hz(); await settle();
  app.resetWorkout(false); await settle();
  assert.equal(fake.active, false);
  assert.equal(ride.active, false);
});
