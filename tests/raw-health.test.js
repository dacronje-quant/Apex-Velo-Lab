'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const RawHealth = require('../scripts/raw-health.cjs');
const { LocalStore } = require('../scripts/sqlite-store.cjs');
const { ANALYTICS_TABLES } = require('../scripts/sqlite-analytics.cjs');
const aiTools = require('../scripts/ai-tools.cjs');

const ROOT = path.resolve(__dirname, '..');

function makeTempDir(t, prefix = 'apex-raw-health-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise(r => s.close(r));
  return p;
}

test('parseHealthAutoExportPayload captures all 24h metrics, BP split, sleep nights & stages, and unknown metrics', () => {
  const payload = {
    data: {
      metrics: [
        {
          name: 'heart_rate', units: 'count/min',
          data: [
            { date: '2026-10-10 02:15:00 +0200', Min: 48, Avg: 52, Max: 56, source: 'Watch' },
            { date: '2026-10-10 14:30:00 +0200', qty: 112 }
          ]
        },
        { name: 'heart_rate_variability', units: 'ms', data: [{ date: '2026-10-10 03:00:00 +0200', qty: 68.4 }] },
        { name: 'resting_heart_rate', units: 'count/min', data: [{ date: '2026-10-10 06:00:00 +0200', qty: 49 }] },
        { name: 'step_count', units: 'count', data: [{ date: '2026-10-10 15:00:00 +0200', qty: 8420 }] },
        { name: 'active_energy', units: 'kcal', data: [{ date: '2026-10-10 15:00:00 +0200', qty: 540 }] },
        { name: 'apple_sleeping_wrist_temperature', units: '°C', data: [{ date: '2026-10-10 06:30:00 +0200', qty: 36.12 }] },
        { name: 'vo2_max', units: 'mL/min·kg', data: [{ date: '2026-10-10 10:00:00 +0200', qty: 56.3 }] },
        { name: 'blood_pressure', units: 'mmHg', data: [{ date: '2026-10-10 08:00:00 +0200', systolic: 118, diastolic: 74 }] },
        { name: 'custom_hydration_score', units: 'pts', data: [{ date: '2026-10-10 09:00:00 +0200', qty: 88 }] },
        {
          name: 'sleep_analysis', units: 'hr',
          data: [
            { startDate: '2026-10-09 23:00:00 +0200', endDate: '2026-10-10 00:30:00 +0200', value: 'Deep', qty: 1.5, source: 'Watch' },
            { startDate: '2026-10-10 00:30:00 +0200', endDate: '2026-10-10 02:30:00 +0200', value: 'REM', qty: 2.0, source: 'Watch' },
            { totalSleep: 7.4, deep: 1.5, rem: 2.0, core: 3.9, awake: 0.2, inBed: 7.6, sleepStart: '2026-10-09 23:00:00 +0200', sleepEnd: '2026-10-10 06:36:00 +0200', source: 'Watch' }
          ]
        }
      ]
    }
  };

  const parsed = RawHealth.parseHealthAutoExportPayload(payload);
  assert.equal(parsed.readings.length, 11);
  assert.equal(parsed.sleepSessions.length, 3);

  const metrics = new Set(parsed.readings.map(r => r.metric));
  for (const expected of [
    'heart_rate', 'heart_rate_variability', 'resting_heart_rate',
    'step_count', 'active_energy', 'apple_sleeping_wrist_temperature',
    'vo2_max', 'blood_pressure_systolic', 'blood_pressure_diastolic', 'custom_hydration_score'
  ]) {
    assert.ok(metrics.has(expected), `Expected metric ${expected}`);
  }

  const hrNight = parsed.readings.find(r => r.metric === 'heart_rate' && r.value === 52);
  assert.equal(hrNight.unit, 'bpm');
  assert.equal(hrNight.valMin, 48);
  assert.equal(hrNight.valMax, 56);
  assert.equal(hrNight.localDay, '2026-10-10');
  assert.equal(hrNight.nightDay, '2026-10-10');

  const temp = parsed.readings.find(r => r.metric === 'apple_sleeping_wrist_temperature');
  assert.equal(temp.unit, 'degC');

  const stages = parsed.sleepSessions.filter(s => s.kind === 'stage');
  assert.equal(stages.length, 2);
  assert.equal(stages[0].stage, 'deep');
  assert.equal(stages[0].durationMin, 90);
  assert.equal(stages[0].nightDay, '2026-10-10');

  const night = parsed.sleepSessions.find(s => s.kind === 'night');
  assert.equal(night.durationMin, 444);
  assert.equal(night.deepH, 1.5);
});

test('parseApexHealthStoreRaw extracts raw hr, hrv, rhr, sleep from apex_health_v1', () => {
  const storeObj = {
    v: 1,
    days: {
      '2026-10-12': {
        hr: { '2026-10-11 23:45:00 +0200': 51, '2026-10-12 06:10:00 +0200': 55 },
        hrv: { '2026-10-12 02:30:00 +0200': 64.2 },
        rhr: { '2026-10-12 00:05:00 +0200': 49 },
        sleep: {
          'night|2026-10-12|Apple Watch': {
            night: { total: 7.2, deep: 1.1, rem: 1.7, core: 4.4, awake: 0.2, inBed: 7.4, start: '2026-10-11 23:00:00 +0200', end: '2026-10-12 06:24:00 +0200' }
          },
          'seg|deep|2026-10-11 23:30:00 +0200|2026-10-12 00:15:00 +0200': {
            seg: { stage: 'deep', h: 0.75 }
          }
        }
      },
      '2026-10-01': { summary: { rhr: 50, hrv: 60, sleepH: 7.5 } }
    }
  };
  const out = RawHealth.parseApexHealthStoreRaw(storeObj);
  assert.equal(out.readings.length, 4);
  assert.equal(out.sleepSessions.length, 2);
  assert.equal(out.readings.find(r => r.metric === 'heart_rate' && r.value === 51).nightDay, '2026-10-12');
  assert.equal(out.sleepSessions.find(s => s.kind === 'night').source, 'Apple Watch');
});

test('streamAppleHealthXml streams records, scales fractional percentages, and extracts sleep stages', async (t) => {
  const dir = makeTempDir(t);
  const xmlPath = path.join(dir, 'export.xml');
  fs.writeFileSync(xmlPath, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<HealthData locale="en_US">',
    '  <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" startDate="2026-10-14 23:10:00 +0200" endDate="2026-10-14 23:10:00 +0200" value="54"/>',
    '  <Record type="HKQuantityTypeIdentifierOxygenSaturation" sourceName="Watch" unit="%" startDate="2026-10-15 03:00:00 +0200" endDate="2026-10-15 03:00:00 +0200" value="0.975"/>',
    '  <Record type="HKQuantityTypeIdentifierBodyMass" sourceName="Scale" unit="kg" startDate="2026-10-15 07:30:00 +0200" endDate="2026-10-15 07:30:00 +0200" value="74.6"/>',
    '  <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Phone" unit="count" startDate="2026-10-15 12:00:00 +0200" endDate="2026-10-15 12:15:00 +0200" value="1450"/>',
    '  <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" startDate="2026-10-14 23:15:00 +0200" endDate="2026-10-15 00:45:00 +0200" value="HKCategoryValueSleepAnalysisAsleepDeep"/>',
    '</HealthData>'
  ].join('\n'));

  const batches = [];
  const totals = await RawHealth.streamAppleHealthXml(xmlPath, async (b) => batches.push(b), { batchSize: 2 });
  assert.equal(totals.totalReadings, 4);
  assert.equal(totals.totalSleep, 1);
  const allReadings = batches.flatMap(b => b.readings);
  const allSleep = batches.flatMap(b => b.sleepSessions);
  assert.equal(allReadings.find(r => r.metric === 'heart_rate').nightDay, '2026-10-15');
  assert.equal(allReadings.find(r => r.metric === 'blood_oxygen_saturation').value, 97.5);
  assert.equal(allReadings.find(r => r.metric === 'weight_body_mass').value, 74.6);
  assert.equal(allReadings.find(r => r.metric === 'step_count').value, 1450);
  assert.equal(allSleep[0].stage, 'deep');
  assert.equal(allSleep[0].durationMin, 90);
});

test('LocalStore upgrades v3 wellness_index to v4, populates all 10 tables, and exposes 10 AI tools idempotently', (t) => {
  const dir = makeTempDir(t);
  const dbPath = path.join(dir, 'apex.sqlite');

  // Seed a v3 schema DB with narrow wellness_index + multi-source wellness_days
  const v3 = new DatabaseSync(dbPath);
  v3.exec(`
    PRAGMA user_version = 3;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE rides (id TEXT PRIMARY KEY, json TEXT NOT NULL, position INTEGER NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0, content_hash TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE db_settings (key TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE operations (id TEXT PRIMARY KEY, result TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE sync_tombstones (kind TEXT NOT NULL, id TEXT NOT NULL, deleted_at INTEGER NOT NULL, PRIMARY KEY(kind, id));
    CREATE TABLE wellness_days (day TEXT NOT NULL, source TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day, source));
    CREATE TABLE wellness_index (day TEXT PRIMARY KEY, rhr REAL, hrv REAL, hrv_kind TEXT, sleep_h REAL, deep_h REAL, rem_h REAL, core_h REAL, awake_h REAL, spo2 REAL, source TEXT) WITHOUT ROWID;
  `);
  v3.prepare('INSERT INTO meta VALUES (?,?)').run('initialized', '1');
  v3.prepare('INSERT INTO wellness_days VALUES (?,?,?,?)').run(
    '2026-10-20', 'apple',
    JSON.stringify({ summary: { rhr: 49, hrv: 64, hrvKind: 'sdnn', sleepH: 7.6, deepH: 1.1, remH: 1.9, coreH: 4.6, awakeH: 0.2, bed: 1380, wake: 400 }, src: 'apple' }),
    1000
  );
  v3.prepare('INSERT INTO wellness_days VALUES (?,?,?,?)').run(
    '2026-10-20', 'icu',
    JSON.stringify({ summary: { rhr: 51, sleepHr: 48, hrv: 60, hrvKind: 'sdnn', hrvRmssd: 55, hrvSdnn: 60, sleepH: 7.5, sleepScore: 89, icuReadiness: 92, baevsky: 3.1, resp: 14.8, spo2: 97.6, weight: 74.2 }, src: 'icu' }),
    1001
  );
  v3.prepare('INSERT INTO wellness_days VALUES (?,?,?,?)').run(
    '2026-10-20', 'healthconnect',
    JSON.stringify({ summary: { rhr: 50, hrv: 58, hrvKind: 'rmssd', hrvRmssd: 58, sleepH: 7.4 }, src: 'healthconnect' }),
    1002
  );
  v3.close();

  const store = new LocalStore({ dir, mirrorDir: null });
  try {
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 4);
    assert.equal(ANALYTICS_TABLES.length, 10);

    const wRow = store.db.prepare('SELECT * FROM wellness_index WHERE day = ?').get('2026-10-20');
    assert.equal(wRow.rhr, 49); // Apple wins primary rhr
    assert.equal(wRow.sleep_hr, 48); // icu auxiliary kept
    assert.equal(wRow.hrv_sdnn, 60);
    assert.equal(wRow.hrv_rmssd, 58); // healthconnect > icu in DEFAULT_WELLNESS_ORDER
    assert.equal(wRow.sleep_score, 89);
    assert.equal(wRow.icu_readiness, 92);
    assert.equal(wRow.baevsky, 3.1);
    assert.equal(wRow.resp, 14.8);
    assert.equal(wRow.spo2, 97.6);
    assert.equal(wRow.weight_kg, 74.2);

    assert.equal(store.analyticsStatus().totalWellnessSourceRows, 3);

    // Ingest raw HAE payload twice -> must be strictly idempotent
    const hae = {
      data: {
        metrics: [
          {
            name: 'heart_rate', units: 'bpm',
            data: [
              { date: '2026-10-19 23:00:00 +0200', qty: 55 },
              { date: '2026-10-20 01:00:00 +0200', qty: 48 },
              { date: '2026-10-20 04:00:00 +0200', qty: 50 },
              { date: '2026-10-20 19:00:00 +0200', qty: 92 }
            ]
          },
          { name: 'step_count', units: 'count', data: [{ date: '2026-10-20 18:00:00 +0200', qty: 9100 }] },
          {
            name: 'sleep_analysis', units: 'hr',
            data: [{ startDate: '2026-10-19 23:00:00 +0200', endDate: '2026-10-20 00:30:00 +0200', value: 'Deep', qty: 1.5 }]
          }
        ]
      }
    };
    const r1 = store.ingestHealthAutoExport(hae);
    const r2 = store.ingestHealthAutoExport(hae);
    assert.equal(r1.readings, 5);
    assert.equal(r2.readings, 5);
    assert.equal(store.analyticsStatus().totalHealthReadings, 5); // no duplicates!
    assert.equal(store.analyticsStatus().totalSleepSessions, 1);

    // Verify AI tools
    const well = aiTools.executeTool(store, 'get_wellness', { from: '2026-10-20', to: '2026-10-20', include_sources: true });
    assert.equal(well.days[0].sleep_hr, 48);
    assert.equal(well.days[0].baevsky, 3.1);
    assert.equal(well.sources.length, 3);

    const wellWeek = aiTools.executeTool(store, 'get_wellness', { group_by: 'week' });
    assert.equal(wellWeek.weeks[0].avg_icu_readiness, 92);
    assert.equal(wellWeek.weeks[0].avg_weight_kg, 74.2);

    const catalog = aiTools.executeTool(store, 'get_health_metrics', {});
    assert.equal(catalog.count, 2);
    assert.equal(catalog.sleepSummary.stage_count, 1);

    const dailySteps = aiTools.executeTool(store, 'get_health_metrics', { metric: 'steps', from: '2026-10-20', to: '2026-10-20' });
    assert.equal(dailySteps.metric, 'step_count');
    assert.equal(dailySteps.days[0].val_sum, 9100);

    const nightHr = aiTools.executeTool(store, 'get_health_readings', { metric: 'heart_rate', date: '2026-10-20', by_night: true });
    assert.equal(nightHr.count, 3); // 23:00 Oct 19 + 01:00 + 04:00 Oct 20 (excludes 19:00 evening which belongs to Oct 21 night)
    assert.equal(nightHr.sleepSessions.length, 1);

    const calHr = aiTools.executeTool(store, 'get_health_readings', { metric: 'heart_rate', date: '2026-10-20', by_night: false });
    assert.equal(calHr.count, 3); // 01:00 + 04:00 + 19:00 Oct 20 (excludes 23:00 Oct 19)

    const bucketedHr = aiTools.executeTool(store, 'get_health_readings', { metric: 'heart_rate', date: '2026-10-20', bucket_min: 180 });
    assert.ok(bucketedHr.bucketCount >= 2 && Array.isArray(bucketedHr.buckets));

    const sqlAll = aiTools.executeTool(store, 'run_readonly_sql', {
      sql: 'SELECT w.day, w.baevsky, s.source FROM wellness_index w JOIN wellness_by_source s ON s.day = w.day ORDER BY s.source'
    });
    assert.equal(sqlAll.rowCount, 3);

    const sqlBad = aiTools.executeTool(store, 'run_readonly_sql', { sql: 'SELECT * FROM wellness_days' });
    assert.ok(sqlBad.error);
  } finally {
    store.close();
  }
});

test('POST /api/health persists incoming raw metrics directly to SQLite while keeping inbox working', { timeout: 25000 }, async (t) => {
  const tmp = makeTempDir(t, 'apex-srv-health-');
  const appDir = path.join(tmp, 'app');
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(appDir);
  for (const name of ['index.html', 'server.js', 'js', 'scripts']) {
    fs.cpSync(path.join(ROOT, name), path.join(appDir, name), { recursive: true });
  }
  fs.mkdirSync(path.join(appDir, 'data', 'health'), { recursive: true });
  const token = 'b'.repeat(48);
  fs.writeFileSync(path.join(appDir, 'data', 'health', 'token.txt'), token);

  const port = await freePort();
  fs.writeFileSync(path.join(appDir, '.env'), `APEX_PORT=${port}\nANTHROPIC_API_KEY=\nGEMINI_API_KEY=\n`);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: appDir,
    env: { ...process.env, APEX_DATA_DIR: dataDir, APEX_NO_BROWSER: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await new Promise(r => child.once('exit', r)); }
  });

  const base = `http://localhost:${port}`;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${base}/api/storage`); if (r.ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }

  // Initialize LocalStore via /api/storage/migrate (mimics booted desktop app)
  const mig = await fetch(`${base}/api/storage/migrate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ revision: 0, operationId: 'init_health_test_01', rides: [], settings: {}, dbSettings: [] })
  });
  assert.equal(mig.status, 200);

  // Send a HAE payload with both known and extra metrics
  const haeRes = await fetch(`${base}/api/health`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: {
        metrics: [
          { name: 'heart_rate', units: 'count/min', data: [{ date: '2026-11-01 07:00:00 +0100', Avg: 58 }] },
          { name: 'step_count', units: 'count', data: [{ date: '2026-11-01 18:00:00 +0100', qty: 10500 }] },
          { name: 'apple_sleeping_wrist_temperature', units: '°C', data: [{ date: '2026-11-01 06:30:00 +0100', qty: 36.4 }] }
        ]
      }
    })
  });
  assert.equal(haeRes.status, 200);

  // Verify inbox still has the raw JSON file
  const inbox = await (await fetch(`${base}/api/health/inbox`)).json();
  assert.equal(inbox.files.length, 1);

  // Verify SQLite immediately holds the raw metrics via analytics-status
  const st = await (await fetch(`${base}/api/storage/analytics-status`)).json();
  assert.equal(st.schemaVersion, 4);
  assert.equal(st.totalHealthReadings, 3);
  assert.equal(st.healthMetricCount, 3);
});
