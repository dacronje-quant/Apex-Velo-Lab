import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRoute, matchRoute } from '../src/native-shell.js';

test('routes: hash forms normalise, patterns capture params', () => {
  assert.equal(normalizeRoute('#/history/abc/'), 'history/abc');
  assert.equal(normalizeRoute('ride'), 'ride');
  assert.equal(normalizeRoute(''), '');
  assert.deepEqual(matchRoute('history/:rideId', 'history/ride_1%202'), { rideId: 'ride_1 2' });
  assert.equal(matchRoute('history/:rideId', 'history'), null);
  assert.equal(matchRoute('progress/power', 'progress/fitness'), null);
});
