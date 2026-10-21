import test from 'node:test';
import assert from 'node:assert/strict';
import { PrefsSyncLedger, UploadQueue, nextAttemptAt, isFromDestination, BACKOFF_MS, MAX_ATTEMPTS } from '../src/native-outbox.js';
import { UploadError } from '../src/native-strava.js';

const T0 = Date.parse('2026-10-20T10:00:00Z');

function setup({ rides = {}, connected = true, answers = [] } = {}) {
  const store = new Map(), uploads = [], changes = [], timers = [];
  let now = T0;
  const prefs = { get: async (k) => store.get(k) ?? null, set: async (k, v) => store.set(k, v), remove: async (k) => store.delete(k) };
  const ledger = new PrefsSyncLedger({ prefs, now: () => now });
  const dest = {
    id: 'strava', label: 'Strava', connected,
    async isConnected() { return this.connected; },
    async upload(ride, bytes) {
      uploads.push({ id: ride.id, bytes });
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return a || { externalId: String(9000 + uploads.length) };
    }
  };
  const queue = new UploadQueue({
    ledger, destinations: [dest], getRide: async (id) => rides[id] || null, buildFit: (r) => new Uint8Array([r.samples.length]),
    now: () => now, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
    onChange: (id, row, result) => changes.push({ id, status: row.status, result })
  });
  return { queue, ledger, dest, store, uploads, changes, timers, tick: (ms) => { now += ms; } };
}
const ride = (id, extra = {}) => ({ id, samples: [{ power: 200 }, { power: 210 }], ...extra });

test('a queued ride is uploaded once and recorded with its activity id', async () => {
  const t = setup({ rides: { a: ride('a') } });
  await t.queue.enqueue(ride('a'), 'strava');
  await t.queue.run();
  const row = await t.queue.state('a', 'strava');
  assert.equal(row.status, 'sent');
  assert.equal(row.external_id, '9001');
  assert.match(row.content_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(row).sort(), ['attempts', 'content_hash', 'destination', 'external_id', 'last_error', 'ride_id', 'status', 'updated_at'], 'the sync_ledger columns');
  assert.ok([...t.store.keys()].every((k) => k.startsWith('apex_sync_')));
  // Already uploaded: sending again does not upload.
  assert.equal((await t.queue.sendNow(ride('a'), 'strava')).external_id, '9001');
  assert.equal(t.uploads.length, 1);
});

test('offline: retried with backoff, then given up after the attempt limit', async () => {
  const offline = () => new UploadError('Could not reach Strava (offline).', { retryable: true });
  const t = setup({ rides: { a: ride('a') }, answers: Array.from({ length: MAX_ATTEMPTS }, offline) });
  await t.queue.enqueue(ride('a'), 'strava');
  await t.queue.run();
  let row = await t.queue.state('a', 'strava');
  assert.deepEqual([row.status, row.attempts, row.last_error], ['queued', 1, 'Could not reach Strava (offline).']);
  assert.equal(nextAttemptAt(row), T0 + BACKOFF_MS[0]);
  assert.equal(t.timers.at(-1).ms, BACKOFF_MS[0], 'a timer is set for the next try');
  await t.queue.run();
  assert.equal(t.uploads.length, 1, 'not due yet (app resumed too soon)');
  for (let i = 1; i < MAX_ATTEMPTS; i++) { t.tick(BACKOFF_MS[Math.min(i, BACKOFF_MS.length) - 1]); await t.queue.run(); }
  row = await t.queue.state('a', 'strava');
  assert.deepEqual([row.status, row.attempts], ['failed', MAX_ATTEMPTS]);
  assert.equal(t.uploads.length, MAX_ATTEMPTS);
  t.tick(24 * 3600e3); await t.queue.run();
  assert.equal(t.uploads.length, MAX_ATTEMPTS, 'a failed ride waits for the rider');
  assert.equal((await t.queue.sendNow(ride('a'), 'strava')).status, 'sent', 'Send again re-queues it');
});

test('backoff grows and is capped', () => {
  const at = (attempts) => nextAttemptAt({ attempts, updated_at: new Date(T0).toISOString() }) - T0;
  assert.equal(nextAttemptAt({ attempts: 0, updated_at: new Date(T0).toISOString() }), 0);
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(at), [...BACKOFF_MS, BACKOFF_MS.at(-1)]);
});

test('a permanent error fails at once; signed out waits without using up attempts', async () => {
  const t = setup({ rides: { a: ride('a'), b: ride('b'), c: ride('c') }, answers: [new UploadError('Bad file'), new UploadError('Connect Strava again.', { needsConnect: true })] });
  for (const id of ['a', 'b', 'c']) await t.queue.enqueue(ride(id), 'strava');
  await t.queue.run();
  assert.equal((await t.queue.state('a', 'strava')).status, 'failed');
  const b = await t.queue.state('b', 'strava');
  assert.deepEqual([b.status, b.attempts], ['queued', 0]);
  assert.equal(t.uploads.length, 2, 'after a sign-out the rest of the queue waits');
  t.dest.connected = false;
  await t.queue.run();
  assert.equal(t.uploads.length, 2, 'nothing is tried while not connected');
  t.dest.connected = true;
  await t.queue.run();
  assert.deepEqual([(await t.queue.state('b', 'strava')).status, (await t.queue.state('c', 'strava')).status], ['sent', 'sent']);
});

test('rides from Strava are never uploaded to Strava', async () => {
  assert.equal(isFromDestination({ source: 'Strava' }, 'strava'), true);
  assert.equal(isFromDestination({ source: 'import:strava' }, 'strava'), true);
  assert.equal(isFromDestination({ source: 'recorded', strava: { state: 'imported' } }, 'strava'), true);
  assert.equal(isFromDestination({ source: 'import:fit' }, 'strava'), false);
  assert.equal(isFromDestination({ source: 'APEX VELO Cockpit' }, 'strava'), false);
  const t = setup({ rides: { s: ride('s', { source: 'Strava' }) } });
  assert.equal((await t.queue.sendNow(ride('s', { source: 'Strava' }), 'strava')).status, 'skipped');
  // Even a row queued earlier (before the ride was known to come from Strava) is not sent.
  await t.ledger.update('s', 'strava', { status: 'queued' });
  await t.queue.run();
  assert.equal(t.uploads.length, 0);
  assert.equal((await t.queue.state('s', 'strava')).status, 'skipped');
});

test('a deleted ride leaves the queue; overlapping runs share one pass', async () => {
  const t = setup({ rides: { a: ride('a') } });
  await t.queue.enqueue(ride('a'), 'strava');
  await t.queue.enqueue(ride('gone'), 'strava');
  await Promise.all([t.queue.run(), t.queue.run(), t.queue.run()]);
  assert.equal(t.uploads.length, 1);
  assert.equal(await t.queue.state('gone', 'strava'), null);
  assert.deepEqual(await t.queue.summary('strava'), { queued: 0, failed: 0, sent: 1, nextAt: null });
});

test('auto-upload is off until switched on', async () => {
  const t = setup();
  assert.equal(await t.queue.autoUpload('strava'), false);
  await t.queue.setAutoUpload('strava', true);
  assert.equal(await t.queue.autoUpload('strava'), true);
  assert.equal(t.store.get('apex_sync_opt_auto_strava'), '1');
});
