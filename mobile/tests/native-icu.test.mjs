import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { NativeIcu, toHealthDays, pickHrvField, addDays, BACKFILL_DAYS } from '../src/native-icu.js';

const VeloHealth = createRequire(import.meta.url)('../../js/velo-health.js');
const KEY = 'abc123def456ghi789jkl0';

function setup() {
  const store = new Map(), requests = [], replies = [];
  const http = { async request(o) { requests.push(o); const r = replies.shift(); if (!r) throw new Error('unexpected request ' + o.url); return typeof r === 'function' ? r(o) : r; } };
  const prefs = { get: async (k) => store.get(k) ?? null, set: async (k, v) => store.set(k, v), remove: async (k) => store.delete(k) };
  return { icu: new NativeIcu({ http, prefs, now: () => 1_800_000_000_000 }), store, requests, replies };
}
const ok = (data) => ({ status: 200, headers: {}, data });

test('wellness rows become velo-health days; days without recovery data are skipped', () => {
  const days = toHealthDays([
    { id: '2026-10-15', restingHR: 47.6, hrv: 71.4, hrvSDNN: 58, sleepSecs: 26460, weight: 72 },
    { id: '2026-10-16', restingHR: 200, sleepSecs: 0, weight: 72 },
    { id: '2026-10-17', hrvSDNN: 61 },
    { id: 'not-a-day', restingHR: 50 }
  ], 'hrv');
  assert.deepEqual(Object.keys(days), ['2026-10-15']);
  const store = { v: 1, days };
  const [d] = VeloHealth.daily(store);
  assert.equal(d.day, '2026-10-15');
  assert.equal(d.rhr, 48);
  assert.equal(d.hrv, 71);
  assert.equal(d.sleepH, 7.4);
  assert.equal(d.deepH, null);
  VeloHealth.compact(store, '2026-12-31');
  assert.deepEqual(VeloHealth.daily(store)[0], d, 'compacting keeps intervals.icu days as they are');
});

test('one HRV scale throughout: the field most days have, rMSSD on a tie', () => {
  assert.equal(pickHrvField([{ hrvSDNN: 60 }, { hrvSDNN: 61, hrv: 70 }]), 'hrvSDNN');
  assert.equal(pickHrvField([{ hrvSDNN: 60, hrv: 70 }]), 'hrv');
  assert.equal(pickHrvField([{ restingHR: 50 }]), null);
  assert.equal(toHealthDays([{ id: '2026-10-15', hrv: 70, hrvSDNN: 60 }], 'hrvSDNN')['2026-10-15'].summary.hrv, 60);
});

test('sleep stages come from the DeepSleep, LightSleep and REMSleep custom fields', () => {
  const s = toHealthDays([{ id: '2026-10-15', sleepSecs: 27000, DeepSleep: 3960, LightSleep: 17280, REMSleep: 5760 }])['2026-10-15'].summary;
  assert.deepEqual([s.sleepH, s.deepH, s.coreH, s.remH], [7.5, 1.1, 4.8, 1.6]);
  const [d] = VeloHealth.daily({ v: 1, days: toHealthDays([{ id: '2026-10-15', sleepSecs: 27000, DeepSleep: 3960, REMSleep: 5760 }]) });
  assert.deepEqual([d.deepH, d.remH, d.coreH], [1.1, 1.6, null]);
  const none = toHealthDays([{ id: '2026-10-15', restingHR: 50, DeepSleep: 3600 }])['2026-10-15'].summary;
  assert.equal(none.deepH, null, 'no stages without a night of sleep');
});

test('the key is checked with Basic auth before it is kept; a rejected key is not stored', async () => {
  const { icu, store, requests, replies } = setup();
  await assert.rejects(icu.setKey('x'), /API key/);
  replies.push({ status: 403, headers: {}, data: { error: 'Access denied' } });
  await assert.rejects(icu.setKey(KEY), /did not accept the API key/);
  assert.equal((await icu.status()).configured, false);
  replies.push(ok({ id: 'i42', name: 'Test Rider', email: 'x@example.com' }));
  assert.deepEqual(await icu.setKey(` ${KEY} `), { id: 'i42', name: 'Test Rider' });
  assert.equal(requests.at(-1).url, 'https://intervals.icu/api/v1/athlete/0');
  assert.equal(requests.at(-1).headers.Authorization, 'Basic ' + Buffer.from('API_KEY:' + KEY).toString('base64'));
  assert.equal(store.get('icu_api_key'), KEY);
  assert.equal((await icu.status()).athlete.name, 'Test Rider');
});

test('wellness reads a date range, keeps the HRV field from the first read, and a new account starts afresh', async () => {
  const { icu, replies, requests } = setup();
  await assert.rejects(icu.wellness('2026-10-17', 7), /API key first/);
  replies.push(ok({ id: 'i42', name: 'A' }));
  await icu.setKey(KEY);
  replies.push(ok([{ id: '2026-10-16', hrvSDNN: 60 }, { id: '2026-10-17', hrvSDNN: 62, hrv: 75 }]));
  const r = await icu.wellness('2026-10-17', BACKFILL_DAYS);
  const u = new URL(requests.at(-1).url);
  assert.equal(u.pathname, '/api/v1/athlete/0/wellness');
  assert.equal(u.searchParams.get('oldest'), addDays('2026-10-17', -799));
  assert.equal(u.searchParams.get('newest'), '2026-10-17');
  assert.equal(r.hrvField, 'hrvSDNN');
  assert.equal(r.days['2026-10-17'].summary.hrv, 62);
  replies.push(ok([{ id: '2026-10-17', hrvSDNN: 62, hrv: 75 }]));
  assert.equal((await icu.wellness('2026-10-17', 7)).hrvField, 'hrvSDNN', 'a short read with rMSSD does not switch scales');
  assert.equal((await icu.status()).lastSync, 1_800_000_000_000);
  replies.push(ok({ id: 'i42', name: 'A' }));
  await icu.setKey(KEY);
  assert.equal((await icu.status()).hrvField, 'hrvSDNN', 'same account keeps its choice');
  replies.push(ok({ id: 'i99', name: 'B' }));
  await icu.setKey(KEY);
  assert.equal((await icu.status()).hrvField, null);
  assert.equal((await icu.status()).lastSync, null, 'a new account is backfilled again');
  await icu.setHrvMode('hrv');
  replies.push(ok([{ id: '2026-10-17', hrvSDNN: 62, hrv: 75 }]));
  assert.equal((await icu.wellness('2026-10-17', 7)).days['2026-10-17'].summary.hrv, 75, 'a chosen kind is used');
  await icu.setHrvMode('auto');
  replies.push(ok([{ id: '2026-10-16', hrvSDNN: 60 }, { id: '2026-10-17', hrvSDNN: 62, hrv: 75 }]));
  assert.equal((await icu.wellness('2026-10-17', BACKFILL_DAYS)).hrvField, 'hrvSDNN', 'automatic picks again');
  await assert.rejects(icu.setHrvMode('x'), /Unknown/);
  await icu.removeKey();
  assert.equal((await icu.status()).configured, false);
});
