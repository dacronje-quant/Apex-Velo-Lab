// The WebView move (src/native-migrate.js) on node:sqlite with a scripted WebView storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeStore } from '../src/native-store.js';
import { WebViewMigration } from '../src/native-migrate.js';
import { nodeDriver, folderFiles } from './sqlite-node.js';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-native-migrate-'));
  const store = await NativeStore.open({ db: nodeDriver(path.join(dir, 'apex.sqlite')), files: folderFiles(path.join(dir, 'backups')), backupDelayMs: 3600000 });
  t.after(async () => { await store.close().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
}
/** WebView storage of the version before the update: localStorage history text, IndexedDB rides by key. */
function webView({ history = null, rides = [], settings = {}, dbSettings = [] } = {}) {
  const keyed = [...rides].sort((a, b) => (typeof a.id === typeof b.id ? (a.id < b.id ? -1 : 1) : typeof a.id === 'number' ? -1 : 1));
  const reads = { ride: 0, pages: 0 };
  return {
    reads, _all: keyed,
    historyText: () => (history === null ? null : JSON.stringify(history)),
    localHistory: () => null,
    settings: () => ({ ...settings }),
    dbSettings: async () => dbSettings,
    ride: async (id) => { reads.ride++; return keyed.find((r) => r.id === id || String(r.id) === String(id)) || null; },
    async ridesAfter(key, n) {
      reads.pages++;
      const from = key === null ? 0 : keyed.findIndex((r) => r.id === key) + 1;
      return keyed.slice(from, from + n);
    },
    rideKeys: async () => keyed.map((r) => r.id)
  };
}
/** What js/velo-storage.js would send to /migrate for the same storage (its merge, copied; IndexedDB rides in key order). */
function veloStorageMerge(source) {
  const raw = source.historyText();
  const history = raw !== null ? JSON.parse(raw) : [];
  const byId = new Map(history.map((r) => [String(r.id), r]));
  if (raw !== '[]') for (const r of source._all) {
    const old = byId.get(String(r.id));
    byId.set(String(r.id), old ? { ...old, ...(!(old.samples?.length) && r.samples?.length ? { samples: r.samples } : {}) } : r);
  }
  return [...byId.values()];
}
const s = (i, n = 3) => Array.from({ length: n }, (_, t) => ({ time: t, power: 100 + i + t }));
const rideAt = (id, day, extra = {}) => ({ id, date: `2026-09-${String(day).padStart(2, '0')}T07:00:00.000Z`, title: 'Ride ' + id, ...extra });

test('gives the same rides, in the same order, as the desktop migration of js/velo-storage.js', async (t) => {
  const store = await fixture(t);
  const rides = [rideAt('b', 2, { samples: s(2) }), rideAt('a', 1, { samples: s(1) }), rideAt(7, 7, { samples: s(7) }), rideAt('z', 9, { samples: [] }), rideAt('only-db', 4, { samples: s(4) })];
  // The localStorage history lists summaries (no samples), in the app's order, and one ride IndexedDB lacks.
  const history = [rideAt('z', 9, { title: 'Renamed in history' }), rideAt('a', 1), rideAt('7', 7), rideAt('history-only', 5), rideAt('b', 2, { samples: s(20, 1) })];
  const source = webView({ history, rides, settings: { apex_erg_response: 'steady' } });
  const progress = [];
  const result = await new WebViewMigration({ store, source, batchSize: 2, onProgress: (done, total) => progress.push([done, total]) }).run();
  assert.equal(result.moved, true); assert.equal(result.rides, 6);
  assert.deepEqual(await store.rides(), veloStorageMerge(source));
  assert.equal((await store.rides())[2].samples.length, 3, 'history "7" picks up the samples of IndexedDB key 7');
  assert.deepEqual(await store.settings(), { apex_erg_response: 'steady' });
  assert.equal(await store.initialized(), true);
  assert.deepEqual(progress[0], [0, 6]); assert.deepEqual(progress.at(-1), [6, 6]);
  assert.equal((await store.backups()).files[0].reason, 'migration');
  assert.deepEqual(await new WebViewMigration({ store, source }).run(), { moved: false }, 'a later start moves nothing');
});

test('an explicit empty history (everything deleted) moves no IndexedDB rides', async (t) => {
  const store = await fixture(t);
  const source = webView({ history: [], rides: [rideAt('old', 1, { samples: s(1) })] });
  await new WebViewMigration({ store, source }).run();
  assert.deepEqual(await store.rides(), []);
  assert.equal(await store.initialized(), true);
});

test('a start killed half-way resumes: rides staged unchanged are not staged again, changed ones are', async (t) => {
  const store = await fixture(t);
  const rides = Array.from({ length: 25 }, (_, i) => rideAt('r' + String(i).padStart(2, '0'), 1 + (i % 28), { samples: s(i) }));
  const source = webView({ rides });
  const stage = store.stageMigration.bind(store);
  let batches = 0;
  store.stageMigration = async (list) => { if (++batches === 3) throw new Error('app killed'); return stage(list); };
  await assert.rejects(() => new WebViewMigration({ store, source, batchSize: 5 }).run(), /app killed/);
  assert.equal(await store.initialized(), false); assert.deepEqual(await store.rides(), []);
  assert.equal(Object.keys(await store.migrationStaged()).length, 10, 'two batches were staged');
  // Before the next start the rider kept using the app on the WebView storage: one staged ride changed.
  rides[3].title = 'Edited after the failed move';
  const staged = [];
  store.stageMigration = async (list) => { staged.push(...list.map((r) => r.id)); return stage(list); };
  await new WebViewMigration({ store, source, batchSize: 5 }).run();
  assert.deepEqual(staged, ['r03', ...rides.slice(10).map((r) => r.id)]);
  assert.deepEqual(await store.rides(), rides);
});

test('unreadable WebView data stops the move before anything is written', async (t) => {
  const store = await fixture(t);
  await assert.rejects(() => new WebViewMigration({ store, source: { ...webView(), dbSettings: async () => null } }).run(), /could not be read/);
  await assert.rejects(() => new WebViewMigration({ store, source: { ...webView(), historyText: () => '{"not":"a list"}' } }).run(), /history is invalid/);
  await assert.rejects(() => new WebViewMigration({ store, source: webView({ rides: [{ id: 'bad', date: 'never' }] }) }).run(), /valid ID or date/);
  assert.equal(await store.initialized(), false);
});
