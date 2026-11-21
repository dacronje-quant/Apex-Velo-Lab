import test from 'node:test';
import assert from 'node:assert/strict';
import { ergNote } from '../src/native-ride-view.js';
import { ergBackAfterFreeRide, FREE_RIDE } from '../src/native-today.js';

const rider = (o = {}) => ({
  ergModeEnabled: true, erg: { mode: 'normal' },
  ble: { isTrainerConnected: () => true, slots: { trainer: { controlGranted: true } } },
  getErgProfile: () => ({ label: 'Responsive' }), ...o
});

test('ERG note: the step\'s ERG style with a trainer, nothing without one', () => {
  assert.deepEqual(ergNote(rider()), { text: 'ERG Responsive', state: 'on' });
  assert.deepEqual(ergNote(rider({ getErgProfile: () => ({ label: 'Steady' }) })), { text: 'ERG Steady', state: 'on' });
  assert.equal(ergNote(rider({ ble: { isTrainerConnected: () => false } })), null, 'no trainer, no ERG note');
  assert.equal(ergNote({}), null);
});

test('ERG note: off, blocked and the short-lived states', () => {
  assert.deepEqual(ergNote(rider({ ergModeEnabled: false })), { text: 'ERG off', state: 'off' });
  assert.equal(ergNote(rider({ ergModeEnabled: false }), true), null, 'a free ride is ERG off by design');
  assert.deepEqual(ergNote(rider(), true), { text: 'ERG on', state: 'on' }, 'ERG switched on during a free ride');
  const blocked = rider(); blocked.ble.slots.trainer.controlGranted = false;
  assert.deepEqual(ergNote(blocked), { text: 'ERG blocked by another app', state: 'warn' });
  assert.equal(ergNote(rider({ erg: { mode: 'soft-start' } })).text, 'ERG soft start');
  assert.equal(ergNote(rider({ erg: { mode: 'stall' } })).text, 'ERG eased');
  assert.equal(ergNote(rider({ erg: { mode: 'stand' } })).text, 'ERG standing');
});

class App {
  constructor() { this.ergModeEnabled = false; this.toggles = 0; this.currentWorkout = null; }
  selectWorkout(w) { if (!w || !w.intervals || !w.intervals.length) return; this.currentWorkout = w; }
  toggleErgMode() { this.ergModeEnabled = !this.ergModeEnabled; this.toggles++; }
}
const vo2 = { id: 'vo2', intervals: [{ duration: 180, pctFtp: 120 }] };

test('after a free ride, the next workout loaded turns ERG back on, once', () => {
  const app = new App();
  ergBackAfterFreeRide(app);
  ergBackAfterFreeRide(app);
  app.selectWorkout(FREE_RIDE);
  app.selectWorkout({ id: 'empty', intervals: [] });
  assert.equal(app.ergModeEnabled, false, 'free ride again or an empty workout leaves ERG off');
  app.selectWorkout(vo2);
  assert.deepEqual([app.ergModeEnabled, app.toggles, app.currentWorkout.id], [true, 1, 'vo2']);
  assert.equal(Object.prototype.hasOwnProperty.call(app, 'selectWorkout'), false, 'the app\'s own selectWorkout is back');
  app.ergModeEnabled = false;
  app.selectWorkout(vo2);
  assert.equal(app.ergModeEnabled, false, 'a later ERG-off choice by the rider is kept');
});

test('after a free ride, ERG already switched back on by the rider is left alone', () => {
  const app = new App();
  ergBackAfterFreeRide(app);
  app.ergModeEnabled = true;
  app.selectWorkout(vo2);
  assert.equal(app.toggles, 0);
});
