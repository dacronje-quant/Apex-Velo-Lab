import test from 'node:test';
import assert from 'node:assert/strict';
import { RideLayouts, normalizeItems, PRESETS, TILES } from '../src/native-ride-view.js';

const mem = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } }; };

test('ride layouts: Standard by default, saved per rider, presets and reset', () => {
  const l = new RideLayouts(mem());
  const a = l.get('rider_a');
  assert.equal(a.simple.find((x) => x.id === 'tile:hr').on, true);
  assert.equal(a.simple.length, 4 + Object.keys(TILES).length);
  a.simple.find((x) => x.id === 'tile:hr').on = false;
  l.set('rider_a', a);
  assert.equal(l.get('rider_a').simple.find((x) => x.id === 'tile:hr').on, false);
  assert.equal(l.get('rider_b').simple.find((x) => x.id === 'tile:hr').on, true);
  assert.ok(l.preset('rider_a', 'everything').full.every((x) => x.on));
  assert.equal(l.reset('rider_a').simple.find((x) => x.id === 'tile:hr').on, true);
  assert.deepEqual(PRESETS.minimal.lines, { power: true, target: true, cadence: false, hr: false });
});

test('ride layouts: unknown and duplicate items dropped, new catalog items added switched off', () => {
  const out = normalizeItems([{ id: 'b', on: true }, { id: 'zz', on: true }, { id: 'b', on: false }], ['a', 'b', 'c']);
  assert.deepEqual(out, [{ id: 'b', on: true }, { id: 'a', on: false }, { id: 'c', on: false }]);
});
