const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const H = require('../js/velo-health.js');
function harness(initial = {}) {
  const mem = { ...initial }, localStorage = { getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
  const window = { addEventListener() {}, __APEX_TEST_MODE__: true }, context = vm.createContext({ window, localStorage, navigator: {}, console, setTimeout, clearTimeout, VeloHealth: H, APEX_LOCAL_HISTORY: null });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8') + '\nwindow.AppClass = VeloApp;', context);
  const app = Object.create(window.AppClass.prototype);
  return { app, context, mem, localStorage };
}
test('fresh profiles are neutral; existing profiles and selected legacy IDs survive byte-for-byte', () => {
  const fresh = harness(); const profiles = fresh.app.loadProfiles();
  assert.equal(profiles.length, 1); assert.equal(profiles[0].name, 'Rider'); assert.equal(profiles[0].id, 'prof_rider');
  const saved = [{ id: 'prof_divan', name: 'Existing rider', ftp: 213, weightKg: 72, maxHr: 181, ftpHistory: [{ from: 210, to: 213 }] }, { id: 'prof_1', name: 'Second rider', ftp: 170 }];
  const old = harness({ apex_velo_profiles: JSON.stringify(saved), apex_velo_active_prof_id: 'prof_1' });
  old.app.profiles = old.app.loadProfiles();
  assert.equal(JSON.stringify(old.app.profiles), JSON.stringify(saved)); assert.equal(old.app.loadActiveProfileId(), 'prof_1');
});
test('saved history needs no migration flag; new installs do not write a database-clearing tombstone', () => {
  const rides = [{ id: 'keep', samples: [{ time: 1, power: 123 }], arbitraryField: 'keep' }];
  const old = harness({ apex_velo_history: JSON.stringify(rides) }); assert.equal(JSON.stringify(old.app.loadHistory()), JSON.stringify(rides));
  const fresh = harness(); assert.equal(fresh.app.loadHistory().length, 0); assert.equal(fresh.mem.apex_velo_history, undefined);
});
function healthHarness(setItem, ackStatus = 200, body) {
  const h = harness(); h.localStorage.setItem = setItem;
  const calls = [], payload = body || { data: { metrics: [{ name: 'resting_heart_rate', data: [{ date: '2026-10-03 08:00:00 +0200', qty: 52 }] }] } };
  h.context.fetch = async (url, options) => { calls.push(url); return url.endsWith('/ack') ? { ok: ackStatus === 200 }
    : { ok: true, json: async () => ({ files: [{ name: 'sample.json', body: payload }], remaining: 0 }) }; };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/app-health.js'), 'utf8'), h.context);
  Object.assign(h.app, { healthStore: H.emptyStore(), refreshHealthDerived() {}, afterHealthChange() {}, scheduleAutoBackup() {} });
  return { ...h, calls };
}
test('health quota failure retains exports; a subsequent retry saves before acknowledging', async () => {
  let full = true, saved = false;
  const h = healthHarness(() => { if (full) throw Object.assign(new Error('full'), { name: 'QuotaExceededError' }); saved = true; });
  const first = await h.app.pullHealthInbox({ force: true }); assert.equal(first.ok, false); assert.equal(h.calls.includes('api/health/ack'), false);
  full = false; const second = await h.app.pullHealthInbox({ force: true }); assert.equal(second.ok, true); assert.ok(saved); assert.ok(h.calls.includes('api/health/ack'));
});
test('health acknowledgement failure and unsupported exports remain retryable', async () => {
  const failedAck = healthHarness(() => {}, 500); assert.equal((await failedAck.app.pullHealthInbox({ force: true })).ok, false);
  const unsupported = healthHarness(() => {}, 200, { data: { metrics: [{ name: 'unsupported', data: [] }] } });
  assert.equal((await unsupported.app.pullHealthInbox({ force: true })).ok, false); assert.equal(unsupported.calls.includes('api/health/ack'), false);
});
