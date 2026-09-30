const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ctx = vm.createContext({ window: { addEventListener() {} }, navigator: {} });
for (const file of ['velo-metrics', 'app', 'app-remote']) {
  vm.runInContext(fs.readFileSync(`js/${file}.js`, 'utf8'), ctx);
}
const App = vm.runInContext('VeloApp', ctx);
function rider() {
  const app = Object.create(App.prototype);
  Object.assign(app, { currentWorkout: { intervals: [] }, activeProfile: { ftp: 200, maxHr: 190 },
    intervalIndex: 0, isPlaying: true, lastInstantPower: 300, powerBuffer: [0, 0, 0, 100, 100, 200, 200, 300, 300, 300],
    remoteTrace: [], totalElapsedSeconds: 10 });
  return app;
}
test('phone averages use the requested trailing seconds and include coasting', () => {
  const s = rider().buildRemoteSnapshot();
  assert.equal(s.power, 300);
  assert.deepEqual(JSON.parse(JSON.stringify(s.powerAverages)), { 3: 300, 5: 260, 7: 214, 10: 150 });
});
test('short buffers average available samples; paused readings stay current', () => {
  const app = rider(); app.powerBuffer = [0, 200];
  assert.equal(app.buildRemoteSnapshot().powerAverages[10], 100);
  app.isPlaying = false;
  assert.ok(Object.values(app.buildRemoteSnapshot().powerAverages).every(p => p === 300));
});
