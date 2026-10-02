const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { Viewport } = require('../js/velo-live-graph.js');

test('following camera keeps recent history and upcoming intervals around the cursor', () => {
  const camera = new Viewport();
  camera.setMode('follow', 0);
  const view = camera.range(3600, .5, 0);
  assert.equal(view.end - view.start, 360);
  assert.equal(view.position, 1800);
  assert.equal((view.position - view.start) / 360, .65);
  const next = camera.range(3600, 1800.5 / 3600, 500);
  assert.equal(next.start - view.start, .5); // continuous movement between one-second updates
});

test('following window stays inside the workout at the start, finish and on short workouts', () => {
  const camera = new Viewport();
  camera.setMode('follow', 0);
  assert.deepEqual(camera.range(3600, 0, 0), { start: 0, end: 360, position: 0 });
  assert.deepEqual(camera.range(3600, 1, 0), { start: 3240, end: 3600, position: 3600 });
  assert.deepEqual(camera.range(120, .5, 0), { start: 0, end: 120, position: 60 });
});

test('full-to-follow zoom interpolates smoothly and can be reversed while paused', () => {
  const camera = new Viewport();
  camera.range(3600, .5, 0);
  camera.setMode('follow', 0);
  const middle = camera.range(3600, .5, 240);
  assert.equal(middle.end - middle.start, 1980);
  assert(camera.isAnimating(240));
  camera.setMode('full', 240);
  assert.deepEqual(camera.range(3600, .5, 240), middle);
  assert.deepEqual(camera.range(3600, .5, 720), { start: 0, end: 3600, position: 1800 });
  assert.equal(camera.isAnimating(720), false);
});

test('reduced motion switches immediately and reset retains the chosen view', () => {
  const camera = new Viewport({ reduceMotion: true });
  camera.range(3600, .5, 0);
  camera.setMode('follow', 0);
  assert.equal(camera.range(3600, .5, 0).end - camera.current.start, 360);
  assert.equal(camera.isAnimating(0), false);
  camera.reset();
  assert.equal(camera.mode, 'follow');
  assert.deepEqual(camera.range(3600, 0, 0), { start: 0, end: 360, position: 0 });
});

test('a paused zoom still requests its final frame after the animation deadline', () => {
  const camera = new Viewport();
  camera.range(3600, .5, 0);
  camera.setMode('follow', 0);
  camera.range(3600, .5, 470);
  assert(camera.isAnimating(500));
  assert.equal(camera.range(3600, .5, 500).end - camera.current.start, 360);
  assert.equal(camera.isAnimating(500), false);
});

const ctx = vm.createContext({ window: { addEventListener() {} }, navigator: {} });
for (const file of ['app', 'app-remote']) vm.runInContext(fs.readFileSync(`js/${file}.js`, 'utf8'), ctx);
const App = vm.runInContext('VeloApp', ctx);
const json = value => JSON.parse(JSON.stringify(value));

test('recent graph readings retain one-second detail, coasting and missing sensor gaps', () => {
  const app = Object.assign(Object.create(App.prototype), {
    currentWorkout: { intervals: [{ duration: 3600, pctFtp: 75 }] },
    recordedSamples: Array.from({ length: 1000 }, (_, i) => ({ time: i + 1, power: i, hr: 140, cadence: 90 }))
  });
  app.recordedSamples[999] = { time: 1000, power: 0, hr: 0, cadence: 0, segmentStart: true };
  const hist = app.remoteRideHist(3600);
  assert.equal(hist.recent.t.length, 480);
  assert.equal(hist.recent.t[0], 521);
  assert.equal(hist.recent.p[0], 520);
  assert.equal(hist.recent.p[479], 0);
  assert.equal(hist.recent.h[479], null);
  assert.equal(hist.recent.c[479], null);
  assert.equal(hist.recent.breaks[479], 1);
  assert(Buffer.byteLength(JSON.stringify(hist)) < 64 * 1024);
});

test('traces stay on their actual interval after skipping a step and editing durations', () => {
  const app = Object.assign(Object.create(App.prototype), {
    currentWorkout: { intervals: [{ duration: 300 }, { duration: 300 }, { duration: 300 }] },
    recordedSamples: [
      { time: 1, workoutStep: 0, stepTime: 1, power: 100 },
      { time: 2, workoutStep: 2, stepTime: 1, power: 200 },
      { time: 3, workoutStep: 2, stepTime: 2, src: 'NONE', power: 0 }
    ]
  });
  const original = JSON.stringify(app.recordedSamples);
  let hist = app.remoteRideHist(900);
  assert.deepEqual(json(hist.recent.t), [1, 601, 602]);
  assert.deepEqual(json(hist.recent.p), [100, 200, null]);
  app.currentWorkout.intervals[0].duration += 30;
  hist = app.remoteRideHist(930);
  assert.deepEqual(json(hist.recent.t), [1, 631, 632]);
  assert.equal(JSON.stringify(app.recordedSamples), original);
});
