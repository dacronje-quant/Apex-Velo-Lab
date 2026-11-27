'use strict';
/**
 * Non-destructive HealthFit .fit enrichment script.
 *
 * Reads cycling .fit files from HEALTHFIT_DIR (default: ~/Downloads/HealthFit/HealthFit),
 * matches them against existing rides via the running Apex server's /api/storage API,
 * and strictly adds missing 1 Hz samples, FIT laps, elevation, temperature, and cycling
 * dynamics without ever deleting rides or overwriting existing samples/metadata.
 *
 * Usage:
 *   node scripts/enrich-healthfit-fits.cjs --dry-run   (default; read-only)
 *   node scripts/enrich-healthfit-fits.cjs --apply     (backs up twice, saves in batches, verifies)
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js/velo-metrics.js'), 'utf8') + ';globalThis.VeloMetrics = VeloMetrics;');
const VeloRideImporter = require('../js/velo-importer.js');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const digest = (val) => sha256(JSON.stringify(val));

const PRESERVED_FIELDS = [
  'id', 'title', 'date', 'source', 'profileName', 'strava', 'stravaActivityId',
  'stravaCheckedAt', 'aiBreakdown', 'ftpAtRide', 'tss', 'np', 'if',
  'avgWatts', 'maxWatts', 'avgHr', 'maxHr', 'avgCadence', 'distanceKm',
  'duration', 'description', 'notes'
];

const OPTIONAL_FIT_FIELDS = [
  'elevationGainM', 'elevationLossM', 'avgTempC', 'maxTempC',
  'avgLeftTe', 'avgRightTe', 'avgLeftPs', 'avgRightPs',
  'fitSport', 'fitSubSport', 'fitMeta'
];

async function apiJson(base, urlPath, body = undefined) {
  const opts = {
    headers: { Origin: base },
    signal: AbortSignal.timeout(60000)
  };
  if (body !== undefined) {
    opts.method = 'POST';
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(base + urlPath, opts);
  const json = await r.json().catch(() => ({}));
  if (!r.ok || !json.ok) {
    throw Object.assign(new Error(json.error || `HTTP ${r.status} on ${urlPath}`), { status: r.status });
  }
  return json;
}

function durationMatches(aSec, bSec) {
  const a = Number(aSec) || 0, b = Number(bSec) || 0;
  if (!(a > 0 && b > 0)) return true;
  return Math.abs(a - b) / Math.max(a, b) <= 0.10;
}

function findMatch(fname, parsed, byFileName, cyclingRides) {
  const exact = byFileName.get(fname.toLowerCase());
  if (exact) return exact;
  const tFit = Date.parse(parsed.date);
  if (!Number.isFinite(tFit)) return null;
  let best = null, bestDiff = Infinity;
  for (const r of cyclingRides) {
    const tr = Date.parse(r.date);
    if (!Number.isFinite(tr)) continue;
    const diff = Math.abs(tr - tFit);
    if (diff <= 5 * 60000 && durationMatches(r.duration, parsed.duration) && diff < bestDiff) {
      best = r;
      bestDiff = diff;
    }
  }
  return best;
}

function mergeAdditive(existing, fname, fileHash, parsed) {
  const next = structuredClone(existing);
  let changed = false;
  let addedSamples = 0, addedLaps = 0, addedElev = false, addedGps = false;

  const hadSamples = Array.isArray(existing.samples) && existing.samples.length > 0;
  if (!hadSamples && Array.isArray(parsed.samples) && parsed.samples.length > 0) {
    next.samples = parsed.samples;
    if (!(Number(next.samplesCount) > 0)) next.samplesCount = parsed.samples.length;
    addedSamples = parsed.samples.length;
    changed = true;
  }

  const hadLaps = Array.isArray(existing.laps) && existing.laps.length > 0;
  if (!hadLaps && Array.isArray(parsed.laps) && parsed.laps.length > 0) {
    next.laps = parsed.laps;
    addedLaps = parsed.laps.length;
    changed = true;
  }

  for (const k of OPTIONAL_FIT_FIELDS) {
    if ((existing[k] === undefined || existing[k] === null) && parsed[k] !== undefined && parsed[k] !== null) {
      next[k] = parsed[k];
      if (k === 'elevationGainM') addedElev = true;
      changed = true;
    }
  }

  if ((existing.fileName === undefined || existing.fileName === null) && fname) {
    next.fileName = fname;
    changed = true;
  }
  if ((existing.fileHash === undefined || existing.fileHash === null) && fileHash) {
    next.fileHash = fileHash;
    changed = true;
  }

  if (addedSamples > 0 && parsed.samples.some(s => s.lat !== undefined && s.lon !== undefined)) {
    addedGps = true;
  }

  return { next, changed, hadSamples, addedSamples, addedLaps, addedElev, addedGps };
}

function assertPreservedFields(before, after) {
  for (const k of PRESERVED_FIELDS) {
    if (digest(before[k] ?? null) !== digest(after[k] ?? null)) {
      throw new Error(`Invariant violation on ride ${before.id}: preserved field "${k}" changed!`);
    }
  }
  if (Array.isArray(before.samples) && before.samples.length > 0) {
    if (digest(before.samples) !== digest(after.samples)) {
      throw new Error(`Invariant violation on ride ${before.id}: existing samples were altered!`);
    }
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const port = process.env.APEX_PORT || '8080';
  const base = `http://localhost:${port}`;
  const hfDir = process.env.HEALTHFIT_DIR || path.join(os.homedir(), 'Downloads', 'HealthFit', 'HealthFit');

  if (!fs.existsSync(hfDir)) throw new Error(`HealthFit folder not found: ${hfDir}`);

  const state = await apiJson(base, '/api/storage');
  if (!state.ok || !state.initialized) throw new Error('Apex SQLite storage is not initialized.');

  const beforeRides = state.rides || [];
  const beforeById = new Map(beforeRides.map(r => [String(r.id), r]));
  const byFileName = new Map();
  const cyclingRides = [];
  for (const r of beforeRides) {
    if (r.fileName) byFileName.set(String(r.fileName).toLowerCase(), r);
    if (!r.activityType || r.activityType === 'ride') cyclingRides.push(r);
  }

  const fitFiles = fs.readdirSync(hfDir)
    .filter(f => /cycling/i.test(f) && f.toLowerCase().endsWith('.fit'))
    .sort();

  let matched = 0, unmatched = 0, parseErrors = 0;
  let addedSamplesRides = 0, addedSamplesCount = 0;
  let addedLapsRides = 0, addedLapsCount = 0;
  let addedElevRides = 0, addedGpsRides = 0;
  let existingSamplesPreservedCount = 0;
  const enrichedMap = new Map();

  for (const fname of fitFiles) {
    const rawBuf = fs.readFileSync(path.join(hfDir, fname));
    const fileHash = sha256(rawBuf);
    let parsed;
    try {
      parsed = VeloRideImporter.parseFit(rawBuf.buffer.slice(rawBuf.byteOffset, rawBuf.byteOffset + rawBuf.byteLength), 'Rider', 210);
    } catch (e) {
      parseErrors++;
      console.error(`Parse error (${fname}): ${e.message}`);
      continue;
    }

    const existing = findMatch(fname, parsed, byFileName, cyclingRides);
    if (!existing) {
      unmatched++;
      continue;
    }
    matched++;
    const current = enrichedMap.get(String(existing.id)) || existing;
    const res = mergeAdditive(current, fname, fileHash, parsed);
    if (res.hadSamples && !enrichedMap.has(String(existing.id))) existingSamplesPreservedCount++;
    if (res.changed) {
      assertPreservedFields(beforeById.get(String(existing.id)), res.next);
      enrichedMap.set(String(existing.id), res.next);
      if (res.addedSamples > 0) { addedSamplesRides++; addedSamplesCount += res.addedSamples; }
      if (res.addedLaps > 0) { addedLapsRides++; addedLapsCount += res.addedLaps; }
      if (res.addedElev) addedElevRides++;
      if (res.addedGps) addedGpsRides++;
    }
  }

  const toUpdate = [...enrichedMap.values()];
  const summary = {
    mode: apply ? 'apply' : 'dry-run',
    totalLiveRides: beforeRides.length,
    fitFilesScanned: fitFiles.length,
    matched,
    unmatched,
    parseErrors,
    ridesToEnrich: toUpdate.length,
    addedSamplesRides,
    addedSamplesCount,
    addedLapsRides,
    addedLapsCount,
    addedElevRides,
    addedGpsRides,
    existingSamplesPreservedCount
  };

  if (!apply) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const beforeAnalytics = await apiJson(base, '/api/storage/analytics-status');

  // Backup Layer 1: verified gzipped JSON snapshot through server API
  const preBackup = await apiJson(base, '/api/storage/backup', {});
  if (preBackup.rides !== beforeRides.length) {
    throw new Error(`Pre-enrichment backup ride count mismatch: ${preBackup.rides} !== ${beforeRides.length}`);
  }

  // Backup Layer 2: verified raw SQLite file copy
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rawBackupDir = path.join(state.dir, 'backups', `pre-fit-enrich-${stamp}`);
  fs.mkdirSync(rawBackupDir, { recursive: true });
  for (const ext of ['', '-wal', '-shm']) {
    const src = state.file + ext;
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(rawBackupDir, path.basename(src)));
  }
  const copySqlite = path.join(rawBackupDir, path.basename(state.file));
  const checkDb = new DatabaseSync(copySqlite, { readOnly: true });
  try {
    const qc = checkDb.prepare('PRAGMA quick_check').get();
    if (!qc || qc.quick_check !== 'ok') throw new Error('Raw SQLite backup copy failed PRAGMA quick_check!');
  } finally {
    checkDb.close();
  }

  // Save in batches of 25
  let revision = state.revision;
  const runId = crypto.randomBytes(4).toString('hex');
  const BATCH_SIZE = 25;
  for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
    const batch = toUpdate.slice(i, i + BATCH_SIZE);
    const batchIdx = Math.floor(i / BATCH_SIZE) + 1;
    const saveRes = await apiJson(base, '/api/storage/save', {
      revision,
      operationId: `fit_enrich_${runId}_${batchIdx}`,
      put: batch
    });
    revision = saveRes.revision;
  }

  // Post-write verification
  const afterState = await apiJson(base, '/api/storage');
  const afterRides = afterState.rides || [];
  const afterById = new Map(afterRides.map(r => [String(r.id), r]));
  if (afterRides.length !== beforeRides.length) {
    throw new Error(`Post-write ride count mismatch: ${afterRides.length} !== ${beforeRides.length}`);
  }
  for (const [id, before] of beforeById.entries()) {
    const after = afterById.get(id);
    if (!after) throw new Error(`Missing ride after enrichment: ${id}`);
    assertPreservedFields(before, after);
    if (!enrichedMap.has(id) && digest(before) !== digest(after)) {
      throw new Error(`Untouched ride ${id} changed unexpectedly!`);
    }
  }

  const afterAnalytics = await apiJson(base, '/api/storage/analytics-status');
  const postBackup = await apiJson(base, '/api/storage/backup', {});

  console.log(JSON.stringify({
    ok: true,
    summary,
    backups: {
      preSnapshot: { name: preBackup.name, rides: preBackup.rides, bytes: preBackup.bytes },
      preRawCopyDir: rawBackupDir,
      postSnapshot: { name: postBackup.name, rides: postBackup.rides, bytes: postBackup.bytes }
    },
    analyticsBefore: beforeAnalytics,
    analyticsAfter: afterAnalytics,
    zeroLossVerified: true
  }, null, 2));
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
