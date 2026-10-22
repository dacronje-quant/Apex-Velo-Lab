import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import {
  toHealthDays, mergeDay, WellnessSources, toRide, importRides, removeRides, ridePayload, fromThisApp, HealthConnectDestination,
  NativeHealthConnect, HC_SOURCE, BACKFILL_DAYS, CHUNK_DAYS, addDays
} from '../src/native-healthconnect.js';
import { NativeStore } from '../src/native-store.js';
import { isFromDestination } from '../src/native-outbox.js';
import { nodeDriver, folderFiles } from './sqlite-node.js';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
vm.runInThisContext(fs.readFileSync(path.join(root, 'js/velo-metrics.js'), 'utf8') + ';globalThis.VeloMetrics = VeloMetrics;');
const VeloRideImporter = require('../../js/velo-importer.js');
const VeloDedupe = require('../../js/velo-dedupe.js');
const VeloHealth = require('../../js/velo-health.js');
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/healthconnect-records.json', import.meta.url)));
const summarize = (s, ftp, meta) => VeloRideImporter.summarize(s, ftp, meta);

async function openStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-hc-'));
  const store = await NativeStore.open({ db: nodeDriver(path.join(dir, 'apex.sqlite')), files: folderFiles(path.join(dir, 'b')), backupDelayMs: 3600000 });
  t.after(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
}
const memPrefs = () => { const m = new Map(); return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => m.set(k, v), remove: async (k) => m.delete(k) }; };

test('wellness records become velo-health days on the morning you wake up', () => {
  const days = toHealthDays(fixture.wellness);
  assert.deepEqual(Object.keys(days), ['2026-10-15'], 'an implausible weight makes no day of its own');
  const s = days['2026-10-15'].summary;
  assert.equal(s.rhr, 46, 'the lowest resting HR of the day');
  assert.equal(s.hrv, 65, 'HRV: the readings taken asleep (the afternoon one is left out)');
  assert.equal(s.hrvKind, 'rmssd');
  assert.deepEqual([s.sleepH, s.deepH, s.coreH, s.remH, s.awakeH], [8, 2, 4.5, 1.5, 0.5], 'the app with the longer night wins; its nap counts');
  assert.deepEqual([s.bed, s.wake], [22 * 60 + 45, 6 * 60 + 45], 'bedtime and wake-up of the main sleep, local time');
  assert.deepEqual([s.weight, s.spo2, s.resp], [72.6, 96.5, 14.4], 'the last weight; SpO2 and breathing averaged');
  assert.equal(days['2026-10-15'].src, HC_SOURCE);
  assert.ok(days['2026-10-15'].ids.includes('sl2') && days['2026-10-15'].ids.includes('w2'), 'record ids are kept for deletions');
  const [d] = VeloHealth.daily({ v: 1, days });
  assert.equal(d.rhr, 46);
  assert.equal(d.sleepH, 8);
  assert.equal(VeloHealth.readiness([d], '2026-10-15').level !== undefined, true, 'readiness runs on the day');
});

test('merge: each field from the preferred source, the other fills gaps, HRV kinds never mix', () => {
  const icu = { src: 'icu', summary: { rhr: 50, hrv: 60, hrvKind: 'sdnn', hrvSrc: 'icu', sleepH: 7, deepH: 1, sleepScore: 80, weight: 71, rhrSrc: 'icu' } };
  const hc = { src: HC_SOURCE, summary: { rhr: 46, hrv: 65, hrvKind: 'rmssd', hrvSrc: 'hc', hrvRmssd: 65, sleepH: 8, deepH: 2, bed: 1365, rhrSrc: 'hc', spo2: 97 } };
  const m = mergeDay(icu, hc).summary;
  assert.deepEqual([m.rhr, m.hrv, m.sleepH, m.deepH, m.bed, m.weight, m.spo2, m.sleepScore], [46, 65, 8, 2, 1365, 71, 97, 80], 'Health Connect first by default; icu-only values stay');
  const p = { rhr: 'icu', hrv: 'icu', sleep: 'icu', weight: HC_SOURCE, spo2: HC_SOURCE, resp: HC_SOURCE, icuHrvKind: 'sdnn' };
  const n = mergeDay(icu, hc, p).summary;
  assert.deepEqual([n.rhr, n.hrv, n.hrvKind, n.sleepH, n.bed], [50, 60, 'sdnn', 7, null], 'intervals.icu first: the whole sleep group comes from it');
  const noIcuHrv = mergeDay({ src: 'icu', summary: { rhr: 50 } }, hc, p).summary;
  assert.equal(noIcuHrv.hrv, null, 'rMSSD never fills a gap in SDNN days');
  assert.equal(mergeDay({ src: 'icu', summary: { rhr: 50 } }, hc, { ...p, icuHrvKind: 'rmssd' }).summary.hrv, 65, 'rMSSD fills rMSSD');
  assert.equal(mergeDay(null, null), null);
});

test('wellness_days: both sources stored, merged into the health store, preferences re-merge every day', async (t) => {
  const store = await openStore(t);
  const prefs = memPrefs();
  const w = new WellnessSources({ store, prefs });
  // A day the app stored from intervals.icu before Health Connect existed (only in the health store).
  const target = { '2026-10-15': { src: 'icu', summary: { rhr: 50, hrv: 70, hrvKind: 'rmssd', hrvSrc: 'icu', sleepH: 7 } }, '2026-10-14': { src: 'icu', summary: { rhr: 51, hrv: 71, hrvKind: 'rmssd' } } };
  assert.equal(await w.apply(target, HC_SOURCE, toHealthDays(fixture.wellness)), 1, 'the first merge looks at every day; only the shared one changes');
  assert.equal(target['2026-10-15'].src, 'merged');
  assert.equal(target['2026-10-15'].summary.rhr, 46);
  assert.equal(target['2026-10-14'].src, 'icu');
  assert.deepEqual((await store.listWellnessDays({ source: 'icu' })).map((r) => r.day), ['2026-10-14', '2026-10-15'], 'earlier intervals.icu days are kept in the table');
  await w.setFieldPref('rhr', 'icu');
  await w.remerge(target);
  assert.equal(target['2026-10-15'].summary.rhr, 50);
  await assert.rejects(w.setFieldPref('rhr', 'strava'), /Unknown/);
  assert.deepEqual(await w.daysWithIds(['w2']), ['2026-10-15']);
  await w.apply(target, HC_SOURCE, { '2026-10-15': null });
  assert.equal(target['2026-10-15'].src, 'icu', 'a Health Connect day removed leaves the intervals.icu day');
  assert.equal(target['2026-10-15'].summary.rhr, 50);
});

test('a cycling session with its series becomes a ride with 1 Hz samples', () => {
  const { session, series } = fixture.ride;
  const ride = toRide(session, series, { ftp: 250, profileName: 'Rider', summarize });
  assert.equal(ride.id, 'hc_ex1');
  assert.equal(ride.source, HC_SOURCE);
  assert.equal(ride.origin, 'com.zwift.android.prod');
  assert.equal(ride.title, 'Watopia Hilly Route');
  assert.equal(ride.indoor, true);
  assert.equal(ride.duration, 600);
  assert.equal(ride.avgWatts, 200);
  assert.ok(ride.tss > 0);
  assert.equal(ride.distanceKm, 5.4);
  assert.equal(ride.avgCadence, 90);
  assert.ok(ride.samples.every((s) => s.hr > 0), 'heart rate every 5 s is held in between');
  assert.equal(ride.samples[10].speed, 32.4);
  const bare = toRide({ ...session, id: 'ex2', title: null, origin: 'com.strava' }, {}, { summarize });
  assert.deepEqual([bare.title, bare.duration, bare.samples.length], ['Strava ride', 600, 0]);
  assert.equal(isFromDestination(bare, 'strava'), true, 'a ride the Strava app wrote is never sent back to Strava');
  assert.equal(isFromDestination(ride, HC_SOURCE), true, 'nor any Health Connect ride back to Health Connect');
});

test('rides from Health Connect are deduplicated against the history; the copy with power wins', () => {
  const { session, series } = fixture.ride;
  const ride = () => toRide(session, series, { ftp: 250, summarize });
  const start = new Date(session.start + 30000).toISOString();
  const fitNoPower = { id: 'fit_1', date: start, duration: 590, source: 'import:fit', title: 'My commute', avgHr: 140, strava: { state: 'sent', activityId: 9 } };
  const list = [fitNoPower];
  let r = importRides(list, [ride()], VeloDedupe);
  assert.equal(r.replaced.length, 1, 'the FIT copy without power is replaced');
  assert.deepEqual([list[0].id, list[0].title, list[0].source, list[0].strava.activityId, list[0].avgWatts], ['fit_1', 'My commute', HC_SOURCE, 9, 200]);
  r = importRides(list, [ride()], VeloDedupe);
  assert.equal(r.updated.length, 1, 'the same session read again updates its ride');
  assert.equal(list.length, 1);
  const recorded = [{ id: 'ride_1', date: start, duration: 600, source: 'APEX VELO Cockpit', avgWatts: 180 }];
  r = importRides(recorded, [ride()], VeloDedupe);
  assert.equal(r.skipped, 1, 'a ride recorded in the app is never swapped');
  assert.equal(recorded.length, 1);
  const other = [];
  r = importRides(other, [ride()], VeloDedupe);
  assert.equal(r.added.length, 1);
  assert.equal(removeRides(other, ['ex1']).length, 1);
  assert.equal(other.length, 0);
});

test('rides recorded here are written as an exercise session with series; Health Connect rides never are', async () => {
  const samples = Array.from({ length: 120 }, (_, i) => ({ time: i, timestamp: Date.parse('2026-10-16T07:00:00Z') + i * 1000, power: i < 5 ? 0 : 210, hr: i < 3 ? 0 : 130, cadence: 88, speed: 36 }));
  const ride = { id: 'ride_9', date: '2026-10-16T07:00:00.000Z', duration: 120, title: 'Sweet spot', source: 'APEX VELO Cockpit', totalDistanceMeters: 1200, totalCalories: 25, completedAt: 1790000000000, samples };
  const p = ridePayload(ride);
  assert.equal(p.clientId, 'apexvelo-ride_9');
  assert.equal(p.exerciseType, 9, 'indoor: stationary biking');
  assert.equal(p.end - p.start, 120000);
  assert.equal(p.hr.length, 117, 'no zero heart rate');
  assert.equal(p.power.length, 120, 'zero power is a real value');
  assert.equal(p.speed[0][1], 10);
  assert.deepEqual([p.distance, p.kcal, p.version], [1200, 25, 1790000000000]);
  const written = [];
  const hc = { plugin: { async writeRide(x) { written.push(x); return { id: 'hc-123' }; } }, async canWrite() { return true; } };
  const dest = new HealthConnectDestination({ hc });
  assert.deepEqual(await dest.upload(ride), { externalId: 'hc-123' });
  await assert.rejects(dest.upload({ ...ride, source: HC_SOURCE }), /Only rides recorded/);
  hc.plugin.writeRide = async () => { throw Object.assign(new Error('denied'), { code: 'PERMISSION' }); };
  await assert.rejects(dest.upload(ride), (e) => e.needsConnect === true);
  assert.equal(fromThisApp({ origin: 'com.apexvelo.lab.debug' }), true);
});

/** A scripted plugin over the fixture: every record is "in" Health Connect; changes are queued by the test. */
function fakePlugin({ granted: allowed = ['HeartRateVariabilityRmssd', 'RestingHeartRate', 'SleepSession', 'Weight', 'OxygenSaturation', 'RespiratoryRate', 'ExerciseSession', 'HeartRate', 'Power', 'Speed', 'Cadence', 'Distance'] } = {}) {
  const all = [...Object.values(fixture.wellness).flat(), { ...fixture.ride.session }, { ...fixture.ride.session, id: 'ex-self', origin: 'com.apexvelo.lab' },
    { ...fixture.ride.session, id: 'ex-run', exerciseType: 56 }];
  for (const [type, list] of Object.entries(fixture.ride.series)) for (const r of list) all.push({ ...r, type });
  const log = { reads: [], started: 0, acked: [] };
  const p = {
    log, all, pending: [], tokenExpired: false, allowed,
    async availability() { return { status: 'available', history: true, background: true }; },
    async grantedHealthPermissions() { return { read: p.allowed, write: [], history: true, background: false }; },
    async readRecords({ type, start, end, origin, pageToken }) {
      log.reads.push(type);
      const hits = all.filter((r) => r.type === type && (r.time ?? r.start) >= start && (r.time ?? r.start) < end && (!origin || r.origin === origin));
      const from = Number(pageToken || 0);
      return { records: hits.slice(from, from + 2), pageToken: from + 2 < hits.length ? String(from + 2) : null };
    },
    async startChanges({ types }) { log.started++; log.tokenTypes = types; p.pending = []; },
    async pendingChanges() { return { changes: p.pending, hasToken: log.started > 0, tokenExpired: p.tokenExpired }; },
    async ackChanges({ upTo }) { log.acked.push(upTo); p.pending = p.pending.filter((c) => c.seq > upTo); }
  };
  return p;
}

test('sync: a resumable two-year backfill in chunks, then only what the changes token reports', async () => {
  const plugin = fakePlugin();
  const prefs = memPrefs();
  const hc = new NativeHealthConnect({ plugin, prefs, now: () => 42 });
  const seen = { days: {}, sessions: [], removed: [] };
  const handlers = {
    days: async (d) => Object.assign(seen.days, d),
    sessions: async (list) => seen.sessions.push(...list),
    removed: async (ids) => { seen.removed.push(...ids); return 0; },
    daysWithIds: async (ids) => (ids.includes('w2') ? ['2026-10-15'] : [])
  };
  const res = await hc.sync(handlers, { today: '2026-10-17' });
  assert.equal(plugin.log.started, 1, 'the changes token is taken before the backfill');
  assert.equal(res.backfilled, true);
  assert.equal(Object.keys(seen.days).length, BACKFILL_DAYS, 'every day of the two years is written (empty ones as null)');
  assert.equal(seen.days['2026-10-15'].summary.rhr, 46);
  assert.equal(seen.days['2026-10-16'], null);
  // 30-day chunks; the chunk with the three sessions takes two pages (the fake returns two records a page).
  assert.equal(plugin.log.reads.filter((t) => t === 'ExerciseSession').length, Math.ceil(BACKFILL_DAYS / CHUNK_DAYS) + 1, '30-day chunks, every page read');
  assert.deepEqual(seen.sessions.map((s) => s.session.id), ['ex1'], "other sports and the app's own sessions are skipped");
  assert.equal(seen.sessions[0].series.Power[0].samples.length > 0, true, 'series read from the session app');
  const st = await hc.state();
  assert.deepEqual([st.done, st.next, st.lastSync], [true, addDays('2026-10-17', 1 - BACKFILL_DAYS), 42]);

  // Changes: an HRV reading upserted, a weight deleted, a new session.
  plugin.log.reads.length = 0;
  for (const d of Object.keys(seen.days)) delete seen.days[d];
  seen.sessions.length = 0;
  plugin.pending = [
    { seq: 7, op: 'upsert', type: 'HeartRateVariabilityRmssd', id: 'hrv2', time: fixture.wellness.HeartRateVariabilityRmssd[1].time, offset: 7200 },
    { seq: 8, op: 'delete', id: 'w2' },
    { seq: 9, op: 'upsert', ...fixture.ride.session }
  ];
  await hc.sync(handlers, { today: '2026-10-17' });
  assert.deepEqual(Object.keys(seen.days).sort(), ['2026-10-15'], 'only the touched day is read again');
  assert.deepEqual(seen.removed, ['w2']);
  assert.deepEqual(seen.sessions.map((s) => s.session.id), ['ex1']);
  assert.deepEqual(plugin.log.acked, [9]);
  assert.equal(plugin.log.started, 1);

  // An expired token (the phone was off the app for a month): everything is read again.
  plugin.tokenExpired = true;
  plugin.pendingChanges = async () => { const r = { changes: [], hasToken: true, tokenExpired: plugin.tokenExpired }; plugin.tokenExpired = false; return r; };
  await hc.sync(handlers, { today: '2026-10-17' });
  assert.equal(plugin.log.started, 2);
});

test('sync: an interrupted backfill goes on from its last chunk; nothing is read without permission', async () => {
  const plugin = fakePlugin();
  const prefs = memPrefs();
  const hc = new NativeHealthConnect({ plugin, prefs });
  let chunks = 0;
  const handlers = { days: async () => { if (++chunks === 3) throw new Error('app killed'); }, sessions: async () => {}, removed: async () => 0, daysWithIds: async () => [] };
  await assert.rejects(hc.sync(handlers, { today: '2026-10-17' }), /app killed/);
  assert.equal((await hc.state()).next, addDays('2026-10-18', -2 * CHUNK_DAYS));
  handlers.days = async () => { chunks++; };
  await hc.sync(handlers, { today: '2026-10-17' });
  assert.equal(chunks, 3 + Math.ceil(BACKFILL_DAYS / CHUNK_DAYS) - 2, 'the two stored chunks are not read again');
  assert.equal(plugin.log.started, 1);
  const none = new NativeHealthConnect({ plugin: fakePlugin({ granted: [] }), prefs: memPrefs() });
  assert.deepEqual(await none.sync(handlers, { today: '2026-10-17' }), { days: 0, sessions: 0, removed: 0, backfilled: false });
});

test('sync: types allowed later (rides after recovery) start the token and the backfill again', async () => {
  const plugin = fakePlugin({ granted: ['HeartRateVariabilityRmssd', 'RestingHeartRate'] });
  const hc = new NativeHealthConnect({ plugin, prefs: memPrefs() });
  const sessions = [];
  const handlers = { days: async () => {}, sessions: async (l) => sessions.push(...l), removed: async () => 0, daysWithIds: async () => [] };
  await hc.sync(handlers, { today: '2026-10-17' });
  assert.deepEqual(plugin.log.tokenTypes, ['HeartRateVariabilityRmssd', 'RestingHeartRate'], 'the token covers only allowed types');
  assert.equal(sessions.length, 0);
  plugin.allowed = [...plugin.allowed, 'ExerciseSession', 'Power'];
  await hc.sync(handlers, { today: '2026-10-17' });
  assert.equal(plugin.log.started, 2);
  assert.deepEqual(sessions.map((s) => s.session.id), ['ex1']);
  assert.deepEqual(Object.keys(sessions[0].series), ['Power'], 'only allowed series are read');
});
