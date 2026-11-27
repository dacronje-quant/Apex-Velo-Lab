'use strict';
/**
 * Non-destructive CLI importer for raw health data into Apex Velo Lab's SQLite analytics tables.
 *
 * Supports:
 *   --from-backups         Recover raw HR/HRV/RHR/sleep readings from verified .json.gz snapshots
 *                          and live `apex_health_v1` in SQLite.
 *   --json <file|dir>      Import one Health Auto Export JSON file or all JSON files in a directory.
 *   --apple-xml <file>     Stream-import an Apple Health `export.xml` or `export.zip` archive.
 *   --dry-run              Preview counts without writing to SQLite (default if --apply omitted).
 *   --apply                Verify PRAGMA quick_check, apply transactionally, and re-verify integrity.
 *   --dir <dataDir>        Optional SQLite data dir (defaults to APEX_DATA_DIR / LocalStore default).
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { LocalStore } = require('./sqlite-store.cjs');
const RawHealth = require('./raw-health.cjs');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { fromBackups: false, jsonPaths: [], appleXmlPaths: [], apply: false, dir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from-backups') out.fromBackups = true;
    else if (a === '--apply') out.apply = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--json' && argv[i + 1]) out.jsonPaths.push(path.resolve(argv[++i]));
    else if (a === '--apple-xml' && argv[i + 1]) out.appleXmlPaths.push(path.resolve(argv[++i]));
    else if (a === '--dir' && argv[i + 1]) out.dir = path.resolve(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function collectJsonFiles(targetPath) {
  if (!fs.existsSync(targetPath)) throw new Error(`Path not found: ${targetPath}`);
  const st = fs.statSync(targetPath);
  if (st.isFile()) return [targetPath];
  const files = [];
  for (const name of fs.readdirSync(targetPath).sort()) {
    const full = path.join(targetPath, name);
    if (fs.statSync(full).isFile() && /\.json$/i.test(name)) files.push(full);
  }
  return files;
}

function collectBackupPayloads(store) {
  const dirs = [store.backupDir, path.join(ROOT, 'data', 'backups')];
  const sources = [];
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(n => /\.json\.gz$/i.test(n)).sort();
    for (const n of files) {
      const full = path.join(dir, n);
      try {
        const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(full)).toString('utf8'));
        const health = data.health || (data.settings && data.settings.apex_health_v1 ? JSON.parse(data.settings.apex_health_v1) : null);
        if (health && health.days) sources.push({ label: path.basename(full), health });
      } catch { /* skip unreadable backup */ }
    }
  }
  const liveRow = store.db.prepare("SELECT value FROM settings WHERE key='apex_health_v1'").get();
  if (liveRow && liveRow.value) {
    try {
      const health = JSON.parse(liveRow.value);
      if (health && health.days) sources.push({ label: 'live:apex_health_v1', health });
    } catch { /* ignore */ }
  }
  return sources;
}

function resolveXmlFromArchive(archiveOrXml) {
  if (!fs.existsSync(archiveOrXml)) throw new Error(`File not found: ${archiveOrXml}`);
  if (!/\.zip$/i.test(archiveOrXml)) return { xmlPath: archiveOrXml, cleanup: null };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-apple-health-'));
  const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} };
  try {
    if (process.platform === 'win32') {
      execFileSync('powershell.exe', [
        '-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${archiveOrXml.replace(/'/g, "''")}' -DestinationPath '${tmpDir.replace(/'/g, "''")}' -Force`
      ], { stdio: 'ignore' });
    } else {
      execFileSync('unzip', ['-qq', '-o', archiveOrXml, '-d', tmpDir], { stdio: 'ignore' });
    }
    const candidates = [
      path.join(tmpDir, 'apple_health_export', 'export.xml'),
      path.join(tmpDir, 'export.xml')
    ];
    let xmlPath = candidates.find(p => fs.existsSync(p));
    if (!xmlPath) {
      const findXml = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) { const r = findXml(p); if (r) return r; }
          else if (/^export\.xml$/i.test(e.name)) return p;
        }
        return null;
      };
      xmlPath = findXml(tmpDir);
    }
    if (!xmlPath) throw new Error(`No export.xml found inside ${archiveOrXml}`);
    return { xmlPath, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.fromBackups && !args.jsonPaths.length && !args.appleXmlPaths.length)) {
    console.log('Usage: node scripts/import-raw-health.cjs [--from-backups] [--json <file|dir>] [--apple-xml <export.xml|export.zip>] [--dry-run | --apply] [--dir <dataDir>]');
    process.exit(args.help ? 0 : 1);
  }

  const store = new LocalStore({
    ...(args.dir ? { dir: args.dir } : {}),
    legacyDir: path.join(ROOT, 'data', 'backups')
  });

  try {
    const qcBefore = store.db.prepare('PRAGMA quick_check').get().quick_check;
    if (qcBefore !== 'ok') throw new Error(`Pre-check failed: ${qcBefore}`);
    const before = store.analyticsStatus();

    const totals = { readings: 0, sleepSessions: 0, files: 0, metrics: new Set(), touchedDays: new Set() };
    const collectBatchStats = (parsed) => {
      totals.readings += parsed.readings.length;
      totals.sleepSessions += parsed.sleepSessions.length;
      for (const r of parsed.readings) {
        totals.metrics.add(r.metric);
        totals.touchedDays.add(r.localDay);
      }
      for (const ss of parsed.sleepSessions) totals.touchedDays.add(ss.nightDay);
    };

    if (args.fromBackups) {
      const sources = collectBackupPayloads(store);
      for (const src of sources) {
        totals.files++;
        const parsed = RawHealth.parseApexHealthStoreRaw(src.health);
        collectBatchStats(parsed);
        if (args.apply && (parsed.readings.length || parsed.sleepSessions.length)) {
          store.analytics.ingestRawHealth(parsed, { transactional: true });
        }
      }
    }

    for (const jp of args.jsonPaths) {
      for (const file of collectJsonFiles(jp)) {
        totals.files++;
        const json = JSON.parse(fs.readFileSync(file, 'utf8'));
        const parsed = RawHealth.parseHealthAutoExportPayload(json);
        collectBatchStats(parsed);
        if (args.apply && (parsed.readings.length || parsed.sleepSessions.length)) {
          store.analytics.ingestRawHealth(parsed, { transactional: true });
        }
      }
    }

    for (const xp of args.appleXmlPaths) {
      const resolved = resolveXmlFromArchive(xp);
      try {
        totals.files++;
        await RawHealth.streamAppleHealthXml(resolved.xmlPath, async (batch) => {
          collectBatchStats(batch);
          if (args.apply) store.analytics.ingestRawHealth(batch, { transactional: true });
        }, { batchSize: 5000 });
      } finally {
        if (resolved.cleanup) resolved.cleanup();
      }
    }

    const after = store.analyticsStatus();
    const qcAfter = store.db.prepare('PRAGMA quick_check').get().quick_check;
    if (qcAfter !== 'ok') throw new Error(`Post-check failed: ${qcAfter}`);
    if (after.indexedRides !== before.indexedRides || after.totalSamples !== before.totalSamples) {
      throw new Error(`Safety check failed: ride counts changed (${before.indexedRides}->${after.indexedRides}, samples ${before.totalSamples}->${after.totalSamples})`);
    }

    console.log(JSON.stringify({
      ok: true,
      mode: args.apply ? 'apply' : 'dry-run',
      zeroLossVerified: true,
      parsed: {
        sourcesScanned: totals.files,
        readings: totals.readings,
        sleepSessions: totals.sleepSessions,
        metrics: [...totals.metrics].sort(),
        touchedDays: totals.touchedDays.size
      },
      before,
      after
    }, null, 2));
  } finally {
    store.close();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e && e.stack ? e.stack : String(e));
    process.exit(1);
  });
}
