const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ctx = vm.createContext({ window: { addEventListener() {} }, navigator: {} });
vm.runInContext(fs.readFileSync('js/app.js', 'utf8'), ctx);
const App = vm.runInContext('VeloApp', ctx);

function workout() {
  const app = Object.create(App.prototype);
  const text = {};
  Object.assign(app, {
    currentWorkout: {
      title: 'Unequal steps', durationMin: 999,
      intervals: [
        { name: 'Warmup', duration: 120, pctFtp: 50 },
        { name: 'Endurance', duration: 480, pctFtp: 75 }
      ]
    },
    activeProfile: { ftp: 200 }, ergBiasMultiplier: 1,
    intervalIndex: 0, intervalSecondsRemaining: 120,
    setText: (id, value) => { text[id] = value; },
    renderIntervalTrack() { this.updateWorkoutOverview(); }
  });
  return { app, text };
}

test('overview uses actual step lengths and a time-weighted average including warmup', () => {
  const { app, text } = workout();
  const original = JSON.stringify(app.currentWorkout);
  app.updateWorkoutOverview();
  assert.equal(text.hudWorkoutTitle, 'Unequal steps');
  assert.equal(text.hudWorkoutDuration, '10 min');
  assert.equal(text.hudWorkoutAvgPower, '140 W'); // 2 min at 100 W + 8 min at 150 W
  assert.equal(JSON.stringify(app.currentWorkout), original);
});

test('expected average follows FTP and bias using the rounded targets sent to ERG', () => {
  const { app, text } = workout();
  app.ergBiasMultiplier = 1.1;
  app.updateWorkoutOverview();
  assert.equal(text.hudWorkoutAvgPower, '154 W');
  app.activeProfile.ftp = 250;
  app.updateWorkoutOverview();
  assert.equal(text.hudWorkoutAvgPower, '192 W'); // 2 min at 138 W + 8 min at 206 W
  assert.equal(text.hudWorkoutDuration, '10 min');
});

test('extending and shortening a step updates the full plan and respects the five-second minimum', () => {
  const { app, text } = workout();
  app.adjustIntervalDuration(30);
  assert.equal(app.currentWorkout.intervals[0].duration, 150);
  assert.equal(text.hudWorkoutDuration, '10 min 30 s');
  assert.equal(text.hudWorkoutAvgPower, '138 W');
  app.adjustIntervalDuration(-1000);
  assert.equal(app.intervalSecondsRemaining, 5);
  assert.equal(app.currentWorkout.intervals[0].duration, 5);
  assert.equal(text.hudWorkoutDuration, '8 min 5 s');
  assert.equal(text.hudWorkoutAvgPower, '149 W');
});

test('hour-long workouts retain seconds and zero-power recoveries count toward the average', () => {
  const { app, text } = workout();
  app.currentWorkout.intervals = [{ duration: 3600, pctFtp: 100 }, { duration: 65, pctFtp: 0 }];
  app.updateWorkoutOverview();
  assert.equal(text.hudWorkoutDuration, '1:01:05');
  assert.equal(text.hudWorkoutAvgPower, '196 W');
});

test('a plan without timed steps has no expected power value', () => {
  const { app, text } = workout();
  app.currentWorkout.intervals = [];
  app.updateWorkoutOverview();
  assert.equal(text.hudWorkoutDuration, '0 min');
  assert.equal(text.hudWorkoutAvgPower, '--');
});
