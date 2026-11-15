import test from 'node:test';
import assert from 'node:assert/strict';
import { RideLayouts, ALL_ITEMS, DEFAULTS, PANELS, TILES, TILE_GROUPS, ZOOMS, graphWindow, pastSegments, futureSegments } from '../src/native-ride-view.js';

const mem = (init = {}) => { const m = { ...init }; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } }; };
const on = (l) => l.items.filter((x) => x.on).map((x) => x.id);

test('ride layout: graph, next step, heart rate and cadence by default; saved per rider; reset', () => {
  const l = new RideLayouts(mem());
  const a = l.get('rider_a');
  assert.deepEqual(on(a), ['panel:graph', 'panel:next', 'tile:hr', 'tile:cadence']);
  assert.deepEqual(a.items.map((x) => x.id), ALL_ITEMS, 'every item, in catalog order');
  assert.equal(a.items.length, Object.keys(PANELS).length + Object.keys(TILES).length);
  assert.deepEqual(a.lines, { power: true, target: true, hr: true, cadence: false });
  assert.equal(a.zoom, 'all');
  a.items.find((x) => x.id === 'tile:hr').on = false;
  a.items.find((x) => x.id === 'tile:np').on = true;
  a.lines.cadence = true; a.zoom = '3m';
  l.set('rider_a', a);
  const again = l.get('rider_a');
  assert.deepEqual(on(again), ['panel:graph', 'panel:next', 'tile:cadence', 'tile:np']);
  assert.deepEqual([again.lines.cadence, again.zoom], [true, '3m']);
  assert.deepEqual(on(l.get('rider_b')), DEFAULTS.on, 'another rider keeps the default');
  assert.deepEqual(on(l.reset('rider_a')), DEFAULTS.on);
});

test('ride layout: a layout from the earlier two-view screen keeps its tiles; retired items and bad values are dropped', () => {
  const old = { rider: {
    simple: [{ id: 'panel:hero', on: true }, { id: 'panel:profile', on: true }, { id: 'tile:power', on: true }, { id: 'tile:tss', on: true }, { id: 'tile:hr', on: false }, { id: 'zz', on: true }, null],
    full: [{ id: 'rideGraph', on: true }, { id: 'ftile:np', on: true }], lines: { hr: false }, zoom: 'huge'
  } };
  const l = new RideLayouts(mem({ apex_ride_layout_v1: JSON.stringify(old) })).get('rider');
  assert.deepEqual(on(l), ['panel:graph', 'tile:tss'], 'the workout profile panel is the live graph now');
  assert.deepEqual(l.lines, { power: true, target: true, hr: false, cadence: false });
  assert.equal(l.zoom, 'all');
  assert.deepEqual(on(new RideLayouts(mem({ apex_ride_layout_v1: 'not json' })).get('rider')), DEFAULTS.on);
});

test('ride tiles: every tile is in exactly one Metrics group; zoom levels go from the whole ride to one minute', () => {
  assert.deepEqual(TILE_GROUPS.flatMap(([, ids]) => ids).sort(), Object.keys(TILES).sort());
  assert.deepEqual(ZOOMS.map((z) => z.secs), [0, 600, 180, 60]);
});

test('graph window: the whole ride, or a zoomed window that follows the ride with the next target in view', () => {
  assert.deepEqual(graphWindow(0, 500, 2760), [0, 2760], 'All');
  assert.deepEqual(graphWindow(600, 20, 300), [0, 300], 'a ride shorter than the window shows whole');
  assert.deepEqual(graphWindow(60, 10, 2760), [0, 60], 'the start: the window does not go before 0');
  assert.deepEqual(graphWindow(60, 425, 2760), [380, 440], 'three quarters behind, a quarter ahead');
  assert.deepEqual(graphWindow(180, 2750, 2760), [2580, 2760], 'the end: the window stops at the end');
  assert.deepEqual(graphWindow(60, 500, 0), [440, 500], 'a free ride (nothing planned ahead) ends at now');
});

test('graph targets: ridden targets come from the samples, coming targets from the plan as it stands now', () => {
  const samples = [1, 2, 3].map((t) => ({ time: t, target: 100 })).concat([4, 5].map((t) => ({ time: t, target: 200 })), [{ time: 6, target: 0 }], [{ time: 30, target: 200 }]);
  assert.deepEqual(pastSegments(samples), [{ t0: 0, t1: 3, watts: 100 }, { t0: 3, t1: 5, watts: 200 }, { t0: 29, t1: 30, watts: 200 }]);
  assert.deepEqual(pastSegments([]), []);
  const intervals = [{ duration: 300, pctFtp: 50 }, { duration: 180, pctFtp: 75 }, { duration: 60, pctFtp: 120 }];
  // 40 s into the ride, after a skip to the second step with 170 s of it left, intensity at 110 %.
  assert.deepEqual(futureSegments({ intervals, index: 1, remaining: 170, now: 40, ftp: 200, bias: 1.1 }), [{ t0: 40, t1: 210, watts: 165 }, { t0: 210, t1: 270, watts: 264 }]);
  assert.deepEqual(futureSegments({ intervals, index: 3, remaining: 0, now: 500, ftp: 200 }), [], 'finished');
});
