'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const VeloSync = require('../js/velo-sync.js');
const VeloDedupe = require('../js/velo-dedupe.js');
const VeloHealth = require('../js/velo-health.js');

test('isSyncedSetting separates synced training data from device-local settings', () => {
  for (const k of ['apex_velo_profiles', 'apex_ask_v1', 'apex_training_block', 'apex_velo_saved_workouts', 'apex_health_v1']) {
    assert.equal(VeloSync.isSyncedSetting(k), true, `${k} should sync`);
  }
  for (const k of ['apex_ble_known_v1', 'apex_ride_layout_v1', 'apex_onboarding', 'apex_sound_muted', 'apex_gemini_api_key', 'apex_strava_autosync']) {
    assert.equal(VeloSync.isSyncedSetting(k), false, `${k} should stay device-local`);
  }
});

test('mergeRides handles updates, tombstones, sample preservation, and fuzzy cross-device dedupe', () => {
  const t0 = 1790000000000;
  const local = [
    { ride: { id: 'r1', date: '2026-10-01T08:00:00.000Z', title: 'Morning Ride', duration: 3600, avgWatts: 210, samples: [{ time: 0, power: 210 }] }, updatedAt: t0 + 1000, contentHash: 'h1' },
    { ride: { id: 'hc_99', date: '2026-10-02T08:00:20.000Z', title: 'Health Connect ride', duration: 1800, source: 'healthconnect', avgHr: 140 }, updatedAt: t0 + 2000, contentHash: 'h2' },
    { ride: { id: 'del_1', date: '2026-10-03T08:00:00.000Z', title: 'To Delete' }, updatedAt: t0 + 1000, contentHash: 'h3' }
  ];
  const remote = [
    { ride: { id: 'r1', date: '2026-10-01T08:00:00.000Z', title: 'Renamed Sweet Spot', duration: 3600, avgWatts: 210, strava: { state: 'sent', activityId: 77 } }, updatedAt: t0 + 5000, contentHash: 'h1b' },
    { ride: { id: 'rec_2', date: '2026-10-02T08:00:00.000Z', title: 'Threshold Intervals', duration: 1805, source: 'APEX VELO Cockpit', avgWatts: 255, samples: [{ time: 0, power: 255 }] }, updatedAt: t0 + 1500, contentHash: 'h4' }
  ];
  const tombstones = [{ kind: 'ride', id: 'del_1', deletedAt: t0 + 4000 }];

  const res = VeloSync.mergeRides(local, remote, tombstones, VeloDedupe, t0 + 6000);
  const byId = new Map(res.rides.map(x => [x.ride.id, x]));

  assert.equal(byId.has('del_1'), false, 'deleted ride is dropped');
  assert.equal(byId.get('r1').ride.title, 'Renamed Sweet Spot');
  assert.equal(byId.get('r1').ride.samples.length, 1, 'samples preserved when newer edit omitted samples');
  assert.equal(byId.get('r1').ride.strava.activityId, 77);

  // Fuzzy dedupe kept APEX VELO Cockpit ride (rec_2) over hc_99 and emitted a tombstone for hc_99
  assert.equal(byId.has('rec_2'), true);
  assert.equal(byId.has('hc_99'), false);
  assert.ok(res.tombstones.some(t => t.kind === 'ride' && t.id === 'hc_99'));
});

test('mergeChat unions messages chronologically, merges saved flags, and respects clearedAt', () => {
  const localRaw = JSON.stringify({
    period: '6w', clearedAt: 1000,
    messages: [
      { id: 'm0', role: 'user', content: 'old cleared', at: 900 },
      { id: 'm1', role: 'user', content: 'How is my fitness?', at: 2000 },
      { id: 'm2', role: 'workout', at: 3000, saved: false, workout: { id: 'w1', title: 'SS', intervals: [{ duration: 600, pctFtp: 88 }] } }
    ]
  });
  const remoteRaw = JSON.stringify({
    period: '12w', clearedAt: 1000,
    messages: [
      { id: 'm2', role: 'workout', at: 3000, saved: true, workout: { id: 'w1', title: 'SS', intervals: [{ duration: 600, pctFtp: 88 }] } },
      { id: 'm3', role: 'user', content: 'Make it shorter', at: 4000 }
    ]
  });
  const merged = VeloSync.mergeChat(localRaw, 3500, remoteRaw, 4500);
  const parsed = JSON.parse(merged.value);
  assert.equal(parsed.period, '12w');
  assert.deepEqual(parsed.messages.map(m => m.id), ['m1', 'm2', 'm3']);
  assert.equal(parsed.messages[1].saved, true);
});

test('mergeProfiles unions ftpHistory without losing older FTP entries', () => {
  const localRaw = JSON.stringify([{ id: 'p1', name: 'Rider', ftp: 280, ftpHistory: [{ date: '2026-01-01', ftp: 250, source: 'manual' }] }]);
  const remoteRaw = JSON.stringify([{ id: 'p1', name: 'Rider', ftp: 285, ftpHistory: [{ date: '2026-06-01', ftp: 285, source: 'ramp' }] }]);
  const merged = JSON.parse(VeloSync.mergeProfiles(localRaw, 100, remoteRaw, 200).value);
  assert.equal(merged[0].ftp, 285);
  assert.deepEqual(merged[0].ftpHistory.map(h => h.ftp), [250, 285]);
});

test('buildHealthStore prioritizes Apple Health and never mixes SDNN and rMSSD HRV scales', () => {
  const rows = [
    { day: '2026-10-10', source: 'apple', data: { summary: { rhr: 48, hrv: 62, hrvKind: 'sdnn', sleepH: 7.5 } }, updatedAt: 100 },
    { day: '2026-10-10', source: 'healthconnect', data: { summary: { rhr: 52, hrv: 90, hrvKind: 'rmssd', sleepH: 8.0, spo2: 98 } }, updatedAt: 200 },
    // Day 2026-10-11 only has Health Connect (rMSSD) and intervals.icu (SDNN backup)
    { day: '2026-10-11', source: 'healthconnect', data: { summary: { rhr: 50, hrv: 95, hrvKind: 'rmssd', sleepH: 7.0 } }, updatedAt: 200 },
    { day: '2026-10-11', source: 'icu', data: { summary: { rhr: 51, hrv: 60, hrvKind: 'sdnn', sleepScore: 84 } }, updatedAt: 250 }
  ];
  const store = VeloSync.buildHealthStore(rows, {}, VeloHealth);
  // 2026-10-10: Apple Health wins for RHR, HRV (SDNN), sleep; Health Connect fills missing SpO2
  assert.equal(store.days['2026-10-10'].summary.rhr, 48);
  assert.equal(store.days['2026-10-10'].summary.hrv, 62);
  assert.equal(store.days['2026-10-10'].summary.hrvKind, 'sdnn');
  assert.equal(store.days['2026-10-10'].summary.spo2, 98);
  // 2026-10-11: Health Connect rMSSD is NOT mixed into SDNN baseline; icu SDNN fills HRV instead!
  assert.equal(store.days['2026-10-11'].summary.rhr, 50);
  assert.equal(store.days['2026-10-11'].summary.hrv, 60);
  assert.equal(store.days['2026-10-11'].summary.hrvKind, 'sdnn');
  assert.equal(store.days['2026-10-11'].summary.sleepScore, 84);
});

test('planDelta requests only missing or changed rides, settings, and wellness rows', () => {
  const local = {
    rides: [{ id: 'r1', updatedAt: 10, contentHash: 'a' }, { id: 'r2', updatedAt: 20, contentHash: 'b' }],
    settings: { apex_coach_goal: { updatedAt: 10, hash: 's1' } },
    wellness: [{ day: '2026-10-01', source: 'healthconnect', updatedAt: 30, hash: 'w1' }],
    tombstones: []
  };
  const remote = {
    rides: [{ id: 'r1', updatedAt: 10, contentHash: 'a' }, { id: 'r3', updatedAt: 25, contentHash: 'c' }],
    settings: { apex_coach_goal: { updatedAt: 15, hash: 's2' } },
    wellness: [{ day: '2026-10-01', source: 'apple', updatedAt: 30, hash: 'w2' }],
    tombstones: []
  };
  const d = VeloSync.planDelta(local, remote);
  assert.deepEqual(d.pullRideIds, ['r3']);
  assert.deepEqual(d.pushRideIds, ['r2']);
  assert.deepEqual(d.pullSettingKeys, ['apex_coach_goal']);
  assert.deepEqual(d.pushSettingKeys, ['apex_coach_goal']);
  assert.deepEqual(d.pullWellnessKeys, [{ day: '2026-10-01', source: 'apple' }]);
  assert.deepEqual(d.pushWellnessKeys, [{ day: '2026-10-01', source: 'healthconnect' }]);
});
