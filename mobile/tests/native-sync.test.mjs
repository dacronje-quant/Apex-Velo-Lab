import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeSync, parsePairingInput, normalizeSyncUrl } from '../src/native-sync.js';
import { NativeStore } from '../src/native-store.js';
import { WellnessSources } from '../src/native-healthconnect.js';
import { nodeDriver, folderFiles } from './sqlite-node.js';

const memPrefs = () => {
  const m = new Map();
  return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => m.set(k, v), remove: async (k) => m.delete(k) };
};

test('pairing input accepts Tailscale HTTPS and apexvelo://sync links, and rejects plain-HTTP public hosts', () => {
  assert.equal(normalizeSyncUrl('https://mac-mini.tailnet.ts.net/'), 'https://mac-mini.tailnet.ts.net');
  assert.equal(normalizeSyncUrl('http://100.80.10.2:8080/'), 'http://100.80.10.2:8080');
  assert.throws(() => normalizeSyncUrl('http://example.com:8080'), /https:\/\//);

  const p = parsePairingInput('apexvelo://sync?url=https%3A%2F%2Fmac-mini.tailnet.ts.net&token=abc1234567890abcdef');
  assert.deepEqual(p, { url: 'https://mac-mini.tailnet.ts.net', token: 'abc1234567890abcdef' });
});

test('NativeSync defers sync while a ride is actively recording', async () => {
  let called = 0;
  const prefs = memPrefs();
  const sync = new NativeSync({
    http: { request: async () => { called++; return { status: 200, data: {} }; } },
    prefs,
    store: Promise.resolve({}),
    getApp: () => ({ isPlaying: true, hasUnsavedRide: () => true })
  });
  await sync.setConfig({ url: 'https://mac-mini.tailnet.ts.net', token: 'a'.repeat(32) });
  const r = await sync.sync({ reason: 'auto' });
  assert.equal(r.skipped, 'riding');
  assert.equal(called, 0);
});

test('WellnessSources prioritizes Apple Health over Health Connect and intervals.icu without mixing HRV scales', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-nsync-'));
  const store = await NativeStore.open({ db: nodeDriver(path.join(dir, 'apex.sqlite')), files: folderFiles(path.join(dir, 'b')), backupDelayMs: 3600000 });
  t.after(async () => {
    await store.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await store.putWellnessDays('apple', {
    '2026-11-01': { summary: { rhr: 46, hrv: 61, hrvKind: 'sdnn', sleepH: 7.4 }, src: 'apple' }
  });
  await store.putWellnessDays('healthconnect', {
    '2026-11-01': { summary: { rhr: 51, hrv: 88, hrvKind: 'rmssd', spo2: 98 }, src: 'healthconnect' },
    '2026-11-02': { summary: { rhr: 49, hrv: 92, hrvKind: 'rmssd', sleepH: 7.8 }, src: 'healthconnect' }
  });
  await store.putWellnessDays('icu', {
    '2026-11-02': { summary: { rhr: 50, hrv: 59, hrvKind: 'sdnn', sleepScore: 86 }, src: 'icu' }
  });

  const target = {};
  const ws = new WellnessSources({ store, prefs: memPrefs() });
  await ws.remerge(target);

  assert.equal(target['2026-11-01'].summary.rhr, 46);
  assert.equal(target['2026-11-01'].summary.hrv, 61);
  assert.equal(target['2026-11-01'].summary.spo2, 98);
  // Day 2026-11-02 uses icu SDNN (59) rather than Health Connect rMSSD (92) to protect SDNN baseline
  assert.equal(target['2026-11-02'].summary.hrv, 59);
  assert.equal(target['2026-11-02'].summary.hrvKind, 'sdnn');
  assert.equal(target['2026-11-02'].summary.sleepH, 7.8);
  assert.equal(target['2026-11-02'].summary.sleepScore, 86);
});

test('NativeSync reloads storage before remerging wellness so saveHealthStore never uses a stale revision', async () => {
  const order = [];
  let storageRev = 1;
  let storeRev = 1;
  const prefs = memPrefs();
  const store = {
    async syncManifest() { return { storeId: 's1', revision: storeRev, rides: [], settings: {}, wellness: [], tombstones: [] }; },
    async ridesByIds() { return []; },
    async settingsWithMeta() { return {}; },
    async wellnessByKeys() { return []; },
    async applySyncBatch() {
      order.push('applySyncBatch');
      storeRev = 2;
      return { ok: true, changed: true, revision: storeRev, storeId: 's1' };
    }
  };
  const app = {
    isPlaying: false,
    hasUnsavedRide: () => false,
    completedWorkouts: [],
    healthStore: { v: 1, days: {} },
    loadHealthStore: () => ({ v: 1, days: {} }),
    refreshHealthDerived: () => order.push('refreshHealthDerived'),
    afterHealthChange: () => order.push('afterHealthChange'),
    saveHealthStore: () => {
      order.push(`saveHealthStore@rev${storageRev}`);
      assert.equal(storageRev, storeRev);
    }
  };
  const sync = new NativeSync({
    http: {
      async request(opts) {
        if (opts.url.endsWith('/api/sync/manifest')) {
          return { status: 200, data: { ok: true, wantRideIds: [], wantSettingKeys: [], wantWellnessKeys: [], tombstones: [] } };
        }
        return {
          status: 200,
          data: {
            ok: true,
            changed: true,
            revision: 2,
            serverTime: 5000,
            rides: [],
            settings: {},
            wellness: [{ day: '2026-11-03', source: 'apple', data: { summary: { rhr: 48 } }, updatedAt: 5000 }],
            tombstones: []
          }
        };
      }
    },
    prefs,
    store: Promise.resolve(store),
    wellness: Promise.resolve({
      async remerge() {
        order.push('remerge');
        return 1;
      }
    }),
    getApp: () => app,
    reloadStorage: async () => {
      order.push('reloadStorage');
      storageRev = storeRev;
      return { rides: [], settings: {} };
    }
  });
  await sync.setConfig({ url: 'https://mac-mini.tailnet.ts.net', token: 'a'.repeat(32) });
  const r = await sync.sync({ reason: 'test' });
  assert.equal(r.ok, true);
  assert.ok(order.indexOf('reloadStorage') >= 0);
  assert.ok(order.indexOf('remerge') > order.indexOf('reloadStorage'));
  assert.ok(order.includes('saveHealthStore@rev2'));
});
