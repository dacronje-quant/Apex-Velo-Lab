// Bulk history import: GPX / worker-safe TCX parsing, FIT sport filter, streaming zip walk (nested and
// Strava exports), hashing, contract dedupe and the import-job adapter. Fixtures: tests/fixtures/bulk-import.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto'), zlib = require('node:zlib');

vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../js/velo-metrics.js'), 'utf8') + ';globalThis.VeloMetrics = VeloMetrics;');
global.VeloRideImporter = require('../js/velo-importer.js');
const I = global.VeloRideImporter;
const B = require('../js/velo-bulk-import.js');
const D = require('../js/velo-dedupe.js');
const Jobs = require('../js/velo-import-jobs.js');
const F = require('./fixtures/bulk-import/make-fixtures.cjs');
const fflate = require('../vendor/fflate.min.js');

const dir = path.join(__dirname, 'fixtures/bulk-import');
const fixture = (name) => new File([fs.readFileSync(path.join(dir, name))], name);
const profile = { name: 'Tester', ftp: 200 };

async function runAll(files, opts = {}) {
  const rides = [], rows = [];
  let index = null;
  const result = await B.run(files, { profile, ...opts }, { onRides: (r) => rides.push(...r), onIndex: (m) => { index = m; }, onFile: (r) => rows.push(r) });
  return { ...result, rides, rows, index };
}

test('committed fixtures match the generator', () => {
  for (const [name, bytes] of Object.entries(F.build())) assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(dir, name))), bytes, `${name}: run make-fixtures.cjs`);
});

test('GPX: coordinates give distance and speed; extensions give power, heart rate and cadence', () => {
  const r = I.parseGpx(fs.readFileSync(path.join(dir, 'ride.gpx'), 'utf8'), 'T', 200);
  assert.equal(r.title, 'Lunch loop');
  assert.equal(r.fileSport, 'cycling');
  assert.equal(r.source, 'GPX Import');
  assert.equal(r.date, '2026-03-07T07:00:00.000Z');
  assert.equal(r.duration, 40);
  assert.equal(r.avgWatts, 160);
  assert.equal(r.avgHr, 130);
  assert.equal(r.avgCadence, 80);
  assert.ok(r.distanceKm > 0.4 && r.distanceKm < 0.45, `distance ${r.distanceKm}`); // 38 steps of ~11.1 m (the segment gap is not counted)
  assert.equal(r.samples.filter(s => s.segmentStart).length, 1);
});

test('GPX without power keeps power empty; CDATA names and entities are decoded; untimed GPX is rejected', () => {
  const r = I.parseGpx(F.gpx({ start: '2026-01-01T08:00:00Z', seconds: 30, name: '<![CDATA[Café & hills]]>' }), 'T', 200);
  assert.equal(r.title, 'Café & hills');
  assert.equal(r.avgWatts, 0);
  assert.equal(r.np, 0);
  assert.equal(I.parseGpx(F.gpx({ start: '2026-01-01T08:00:00Z', seconds: 30, name: 'Tom &amp; Jerry' }), 'T', 200).title, 'Tom & Jerry');
  assert.throws(() => I.parseGpx('<gpx><trk><trkseg><trkpt lat="1" lon="2"></trkpt></trkseg></trk></gpx>'), /No timed track points/);
});

test('TCX parses without DOMParser (Web Worker) and reports its Sport', () => {
  assert.equal(typeof DOMParser, 'undefined');
  const r = I.parseTcx(F.tcx({ start: '2026-01-01T08:00:00Z', seconds: 60, power: 220, sport: 'Running' }), 200, 'T');
  assert.equal(r.duration, 60);
  assert.equal(r.avgWatts, 220);
  assert.equal(r.avgHr, 135);
  assert.equal(r.avgCadence, 88);
  assert.equal(r.fileSport, 'Running');
  assert.equal(r.date, '2026-01-01T08:00:00.000Z');
});

test('FIT: sport and sub_sport come from the file', () => {
  const r = I.parseFit(F.fit({ start: '2026-01-01T08:00:00Z', seconds: 30, sport: 2, subSport: 58 }).buffer, 'T', 200);
  assert.equal(r.fitSport, 2);
  assert.equal(r.fitSubSport, 58);
  assert.equal(r.duration, 30);
  assert.equal(I.parseFit(F.fit({ start: '2026-01-01T08:00:00Z', seconds: 30, power: null }).buffer, 'T', 200).avgWatts, 0);
});

test('sport filter: all cycling incl. indoor/virtual (default), outdoor cycling only, everything', () => {
  const outdoor = B.sportOf({ fitSport: 2, fitSubSport: 7 }), zwift = B.sportOf({ fitSport: 2, fitSubSport: 58 });
  const trainer = B.sportOf({ fitSport: 4, fitSubSport: 6 }), run = B.sportOf({ fitSport: 1 }), unknown = B.sportOf({});
  assert.equal(B.filterReason(outdoor, 'cycling'), null);
  assert.equal(B.filterReason(zwift, 'cycling'), null, 'virtual rides are in by default');
  assert.equal(B.filterReason(trainer, 'cycling'), null, 'trainer sessions are in by default');
  assert.equal(B.filterReason(outdoor, 'outdoor'), null);
  assert.equal(B.filterReason(zwift, 'outdoor'), 'indoor cycling');
  assert.equal(B.filterReason(trainer, 'outdoor'), 'indoor cycling');
  assert.match(B.filterReason(run, 'cycling'), /not cycling/);
  assert.equal(B.filterReason(run, 'all'), null);
  assert.equal(B.filterReason(unknown, 'cycling'), null, 'files without a sport (own CSV exports) count as cycling');
  assert.equal(B.sportFromText('Virtual Ride').indoor, true);
  assert.equal(B.sportFromText('Biking').family, 'ride');
  assert.equal(B.sportFromText('Weight Training').family, 'strength');
  // The file name never decides: a ".fit" called "ride" that holds a run is still a run.
  assert.deepEqual(['ride.fit', 'a/b.FIT.gz', 'x.tcx.gz', 'y.gpx', 'z.csv', 'e.zip', 'p.jpg', 'q.zip.gz'].map(n => B.kindOf(n)?.kind ?? null),
    ['fit', 'fit', 'tcx', 'gpx', 'csv', 'zip', null, null]);
});

test('CSV rows: quotes, commas and newlines inside fields; Strava activities.csv index', () => {
  assert.deepEqual(B.csvRows('a,b\r\n"x, y","say ""hi""\nthere"\n'), [['a', 'b'], ['x, y', 'say "hi"\nthere']]);
  const idx = B.stravaIndex(F.CSV);
  assert.equal(idx.get('1001.fit.gz').name, 'Morning ride, hills');
  assert.equal(idx.get('1001.fit.gz').description, 'Two climbs.\nLegs "ok".');
  assert.equal(idx.get('1003.fit.gz').type, 'Virtual Ride');
  assert.ok(B.isStravaIndex(F.CSV));
  assert.ok(!B.isStravaIndex('time,power\n1,200\n'));
});

test('SHA-256 fallback matches Node crypto (padding edges included)', async () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 1000]) {
    const bytes = crypto.randomBytes(n);
    const want = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.equal(B.sha256Js(new Uint8Array(bytes)), want, `length ${n}`);
    assert.equal(await B.sha256(new Uint8Array(bytes)), want);
  }
});

test('Strava "Download your data" zip: gz entries, sport filter by file content, names from activities.csv', async () => {
  const { counts, rides, index } = await runAll([fixture('strava-export.zip')], { mode: 'cycling' });
  assert.deepEqual(counts, { found: 4, parsed: 3, skipped: 1, errors: 0, duplicates: 0 }); // run skipped; photo/profile ignored
  assert.equal(B.applyIndex(rides, index), 3);
  assert.ok(rides.every(r => r.origin === 'strava'), 'rides from a Strava export are tagged so they are never uploaded back');
  const byFile = Object.fromEntries(rides.map(r => [r.fileName, r]));
  assert.equal(byFile['1001.fit.gz'].title, 'Morning ride, hills');
  assert.equal(byFile['1001.fit.gz'].description, 'Two climbs.\nLegs "ok".');
  assert.equal(byFile['1001.fit.gz'].stravaActivityId, '1001');
  assert.equal(byFile['1001.fit.gz'].source, 'import:fit');
  assert.match(byFile['1001.fit.gz'].fileHash, /^[0-9a-f]{64}$/);
  assert.equal(byFile['1001.fit.gz'].fileHash, crypto.createHash('sha256').update(F.fit(F.RIDES.stravaFit)).digest('hex'), 'hash of the decompressed bytes');
  assert.equal(byFile['1004.tcx.gz'].title, 'Coffee spin');
  assert.equal(byFile['1004.tcx.gz'].source, 'import:tcx');
  assert.equal(byFile['1003.fit.gz'].title, 'Zwift - Watopia');

  const outdoor = await runAll([fixture('strava-export.zip')], { mode: 'outdoor' });
  assert.equal(outdoor.counts.parsed, 2);
  assert.ok(!outdoor.rides.some(r => r.fileName === '1003.fit.gz'), 'outdoor only leaves the Zwift ride out');
  const all = await runAll([fixture('strava-export.zip')], { mode: 'all' });
  assert.equal(all.counts.parsed, 4);
  const run = all.rides.find(r => r.fileName === '1002.gpx');
  assert.equal(run.activityType, 'run', 'non-cycling activities stay out of cycling analytics');
  assert.equal(run.source, 'import:gpx');
});

test('Garmin export: nested zip streamed, exact copies dropped by hash, empty and broken files counted', async () => {
  const known = (await runAll([fixture('strava-export.zip')])).rides.map(r => r.fileHash);
  const { counts, rows, rides } = await runAll([fixture('garmin-export.zip')], { knownHashes: known });
  assert.deepEqual(counts, { found: 5, parsed: 2, skipped: 1, errors: 1, duplicates: 1 });
  assert.ok(rides.every(r => r.origin === 'garmin'));
  assert.equal(rows.find(r => r.status === 'duplicate').origin, 'garmin');
  const status = Object.fromEntries(rows.map(r => [r.path.split('/').pop(), r.status]));
  assert.deepEqual(status, { 'rider_2026-03-02.fit': 'duplicate', 'rider_2026-03-06_edge.fit': 'parsed', 'rider_2026-03-06_watch.fit': 'parsed', 'monitoring_2026-03-06.fit': 'skipped', 'broken.fit': 'error' });
  assert.ok(rows.every(r => r.path.startsWith('garmin-export.zip/DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip/')));
});

test('loose files: .fit.gz, .tcx, .gpx, own CSV export, unsupported file', async () => {
  const files = [
    new File([F.gz(F.fit({ start: '2026-02-01T08:00:00Z', seconds: 60 }))], 'a.fit.gz'),
    new File([F.tcx({ start: '2026-02-02T08:00:00Z', seconds: 60 })], 'b.tcx'),
    fixture('ride.gpx'),
    new File(['time,power,hr\n' + Array.from({ length: 60 }, (_, i) => `${i},150,120`).join('\n')], 'c.csv'),
    new File(['hello'], 'notes.txt')
  ];
  const { counts, rides } = await runAll(files);
  assert.deepEqual(counts, { found: 4, parsed: 4, skipped: 1, errors: 0, duplicates: 0 });
  assert.deepEqual(rides.map(r => r.source), ['import:fit', 'import:tcx', 'import:gpx', 'import:csv']);
  assert.ok(rides.every(r => r.origin === undefined), 'loose files have no known origin');
});

test('origin from the export layout: Strava activities/ at the archive root, Garmin DI_CONNECT folders', () => {
  assert.equal(B.originOf('export_123.zip/activities/1001.fit.gz'), 'strava');
  assert.equal(B.originOf('export_123.zip/activities/sub/1001.fit.gz'), null);
  assert.equal(B.originOf('my-rides.zip/2026/ride.fit'), null);
  assert.equal(B.originOf('ride.fit'), null);
  assert.equal(B.originOf('garmin.zip/DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip/a.fit'), 'garmin');
  assert.equal(B.originOf('DI_CONNECT/DI-Connect-Fitness/x.fit'), 'garmin');
  const r = { importPath: 'loose/1001.fit.gz' };
  B.applyIndex([r], B.stravaIndex(F.CSV));
  assert.equal(r.origin, 'strava', 'a ride listed in activities.csv is Strava\'s');
});

test('archives are streamed: entries are parsed before the whole zip has been read, and a streamed zip (data descriptors) works', async () => {
  // A zip written by a streaming writer (sizes in data descriptors), as phones and some exporters produce.
  const parts = [];
  const z = new fflate.Zip((err, chunk) => { if (err) throw err; parts.push(chunk); });
  for (let i = 0; i < 6; i++) {
    const f = new fflate.ZipDeflate(`rides/r${i}.fit`, { level: 6 });
    z.add(f);
    f.push(F.fit({ start: `2026-04-0${i + 1}T08:00:00Z`, seconds: 300, power: 150 + i }), true);
  }
  z.end();
  const bytes = Buffer.concat(parts.map(p => Buffer.from(p)));
  let pulled = 0;
  const CHUNK = 512, total = Math.ceil(bytes.length / CHUNK);
  const src = { name: 'stream.zip', stream: () => new ReadableStream({ pull(c) { if (pulled >= total) return c.close(); c.enqueue(new Uint8Array(bytes.subarray(pulled * CHUNK, ++pulled * CHUNK))); } }) };
  let pulledAtFirst = null, n = 0;
  for await (const e of B.walk([src])) {
    assert.ok(e.bytes, e.error || e.skip);
    if (pulledAtFirst === null) pulledAtFirst = pulled;
    n++;
  }
  assert.equal(n, 6);
  assert.ok(pulledAtFirst < total, `first ride came out after ${pulledAtFirst} of ${total} chunks`);
});

test('cancel stops the walk early', async () => {
  let calls = 0;
  const { counts, cancelled } = await runAll([fixture('strava-export.zip'), fixture('garmin-export.zip')], { isCancelled: () => ++calls > 3 });
  assert.equal(cancelled, true);
  assert.ok(counts.found < 9);
});

test('zip bomb guards: oversized entries (.fit and .fit.gz) are dropped at 64 MB, the rest of the archive still imports', async () => {
  const zeros = new Uint8Array(70 * 1024 * 1024); // compresses to ~70 KB
  const ok = F.fit({ start: '2026-05-01T08:00:00Z', seconds: 60 });
  const bomb = F.zip({ 'big.fit': zeros, 'big.fit.gz': F.gz(zeros), 'ok.fit': ok });
  assert.ok(bomb.length < 1024 * 1024, `fixture is ${bomb.length} bytes`);
  const { counts, rows, rides } = await runAll([new File([bomb], 'bomb.zip')]);
  assert.deepEqual(counts, { found: 3, parsed: 1, skipped: 0, errors: 2, duplicates: 0 });
  assert.deepEqual(rows.filter(r => r.status === 'error').map(r => [r.path, r.error]), [
    ['bomb.zip/big.fit', 'file too large (over 64 MB unpacked)'], ['bomb.zip/big.fit.gz', 'file too large (over 64 MB unpacked)']]);
  assert.equal(rides[0].fileName, 'ok.fit');
  // Loose files: a .fit.gz that unpacks past the cap, and a plain file past it.
  const loose = await runAll([new File([F.gz(new Uint8Array(3000))], 'a.fit.gz'), new File([new Uint8Array(3000)], 'b.fit')], { limits: { entryBytes: 2000 } });
  assert.equal(loose.counts.errors, 2);
  assert.ok(loose.rows.every(r => /file too large/.test(r.error)));
});

test('zip bomb guards: one 1 MB chunk holding a 1 GB zero entry is unpacked in small pieces, with bounded memory', async () => {
  // Build the bomb by streaming zeros through native deflate (fast), so the test never holds 1 GB either.
  const zeros = new Uint8Array(16 * 1024 * 1024), GB = 64 * zeros.length;
  const deflate = zlib.createDeflateRaw({ level: 9 }), packed = [];
  deflate.on('data', (c) => packed.push(c));
  let crc = 0;
  for (let i = 0; i < 64; i++) { deflate.write(zeros); crc = zlib.crc32(zeros, crc); }
  await new Promise((resolve) => deflate.end(resolve));
  const parts = [];
  const z = new fflate.Zip((err, chunk) => { if (err) throw err; parts.push(chunk); });
  const entry = new fflate.ZipPassThrough('bomb.fit');
  Object.assign(entry, { compression: 8, crc, size: GB });
  z.add(entry);
  entry.push(new Uint8Array(Buffer.concat(packed)), true);
  z.end();
  const bytes = Buffer.concat(parts.map(p => Buffer.from(p)));
  assert.ok(bytes.length <= 1024 * 1024 * 2, `bomb is ${bytes.length} bytes`);
  const one = { name: 'bomb.zip', stream: () => new ReadableStream({ start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); } }) };

  // Watch every unpacked block fflate hands back, and the buffer memory at that moment.
  const real = B.fflate();
  let maxBlock = 0, maxBuffers = 0;
  const base = process.memoryUsage().arrayBuffers;
  class WatchedUnzip extends real.Unzip {
    set onfile(fn) {
      this._onfile = (file) => {
        let wrapped;
        Object.defineProperty(file, 'ondata', { configurable: true, get: () => wrapped, set: (h) => {
          wrapped = (err, chunk, final) => {
            if (chunk) { maxBlock = Math.max(maxBlock, chunk.length); maxBuffers = Math.max(maxBuffers, process.memoryUsage().arrayBuffers - base); }
            h(err, chunk, final);
          };
        } });
        fn(file);
      };
    }
    get onfile() { return this._onfile; }
  }
  const saved = B.fflate;
  B.fflate = () => ({ ...real, Unzip: WatchedUnzip });
  try {
    const { counts, rows } = await runAll([one]);
    assert.deepEqual(counts, { found: 1, parsed: 0, skipped: 0, errors: 1, duplicates: 0 });
    assert.match(rows[0].error, /file too large/);
  } finally {
    B.fflate = saved;
  }
  assert.ok(maxBlock > 0 && maxBlock <= 20 * 1024 * 1024, `largest unpacked block ${maxBlock} bytes`);
  assert.ok(maxBuffers < 256 * 1024 * 1024, `buffer memory peaked at +${Math.round(maxBuffers / 1024 / 1024)} MB`);
});

test('zip bomb guards: total unpacked bytes per archive and nesting depth are capped', async () => {
  const ride = (d) => F.fit({ start: `2026-05-0${d}T08:00:00Z`, seconds: 60 });
  const entries = Object.fromEntries([1, 2, 3, 4, 5, 6].map(d => [`r${d}.fit`, ride(d)]));
  const big = await runAll([new File([F.zip(entries)], 'many.zip')], { limits: { archiveBytes: ride(1).length * 2.5 } });
  assert.equal(big.counts.parsed, 2, 'reading stops once the archive is over budget');
  assert.match(big.rows.find(r => r.status === 'error').error, /archive too large/);
  let nested = F.zip({ 'deep.fit': ride(1) });
  for (let i = 0; i < 3; i++) nested = F.zip({ [`level${i}.zip`]: nested, [`top${i}.fit`]: ride(i + 2) });
  const deep = await runAll([new File([nested], 'nested.zip')], { limits: { depth: 2 } });
  assert.equal(deep.counts.parsed, 3, 'the outer zip and two nested levels are read; the third level is refused');
  assert.match(deep.rows.find(r => r.status === 'error').error, /nested too deep/);
  assert.equal((await runAll([new File([nested], 'nested.zip')])).counts.parsed, 4, 'default depth reads it all');
});

test('gzip cap also holds without DecompressionStream (fflate fallback)', async () => {
  const saved = globalThis.DecompressionStream;
  try {
    delete globalThis.DecompressionStream;
    await assert.rejects(B.gunzip(F.gz(new Uint8Array(500000)), 100000), /file too large/);
    assert.equal((await B.gunzip(F.gz(new Uint8Array(5000)), 100000)).length, 5000);
  } finally {
    globalThis.DecompressionStream = saved;
  }
});

test('dedupe contract: same hash, or start within 60 s and duration within 5 %; keep power, then channels, then length', () => {
  const base = { date: '2026-03-06T07:00:00Z', duration: 3600 };
  assert.ok(D.sameRide(base, { date: '2026-03-06T07:00:59Z', duration: 3500 }));
  assert.ok(!D.sameRide(base, { date: '2026-03-06T07:01:01Z', duration: 3600 }));
  assert.ok(!D.sameRide(base, { date: '2026-03-06T07:00:00Z', duration: 3000 }));
  assert.ok(D.sameRide({ ...base, fileHash: 'x' }, { date: '2025-01-01T00:00:00Z', duration: 10, fileHash: 'x' }));

  const noPower = { ...base, avgHr: 140, avgCadence: 90, distanceKm: 30 };
  const power = { ...base, date: '2026-03-06T07:00:30Z', avgWatts: 200, duration: 3550 };
  assert.ok(D.compareQuality(power, noPower) > 0, 'power beats more channels');
  assert.ok(D.compareQuality({ ...power, avgHr: 140 }, power) > 0, 'then more channels');
  assert.ok(D.compareQuality({ ...power, duration: 3600 }, power) > 0, 'then the longer one');

  const idx = D.rideIndex([noPower]);
  const v = D.admit(idx, power);
  assert.equal(v.verdict, 'replace');
  assert.equal(v.with, noPower);
  assert.equal(D.admit(idx, { ...noPower }).verdict, 'duplicate');
  assert.equal(D.admit(idx, { date: '2026-03-06T09:00:00Z', duration: 3600 }).verdict, 'new');

  const run = { ...base, activityType: 'run', avgHr: 150, avgWatts: 250 };
  assert.ok(!D.sameRide(base, run), 'a run never matches a ride');
  assert.equal(D.admit(D.rideIndex([noPower]), run).verdict, 'new', 'a run with power never replaces a ride');
  assert.ok(D.sameRide({ ...base, type: 'VirtualRide' }, base), 'Strava ride types are rides');
  assert.ok(!D.sameRide({ ...base, type: 'Walk' }, base));

  const recorded = { ...base, source: 'APEX VELO Cockpit', avgHr: 140 };
  assert.equal(D.admit(D.rideIndex([recorded]), { ...power, avgHr: 150, distanceKm: 20 }).verdict, 'duplicate', 'a ride recorded in the app is never replaced');
});

test('rides from the Garmin export dedupe against Strava ones: the copy with power is kept', async () => {
  const strava = (await runAll([fixture('strava-export.zip')])).rides;
  const garmin = (await runAll([fixture('garmin-export.zip')], { knownHashes: strava.map(r => r.fileHash) })).rides;
  const idx = D.rideIndex(strava);
  const verdicts = garmin.map(r => [r.fileName, D.admit(idx, r).verdict]);
  // Order of arrival: the device file with power first, the watch copy without power second (-> duplicate).
  assert.deepEqual(verdicts, [['rider_2026-03-06_edge.fit', 'new'], ['rider_2026-03-06_watch.fit', 'duplicate']]);
  const reversed = D.rideIndex(strava);
  assert.deepEqual([...garmin].reverse().map(r => D.admit(reversed, r).verdict), ['new', 'replace']);
});

test('import job adapter: rows shaped like import_jobs / import_files in apex_import_ keys, last 5 kept', async () => {
  const mem = new Map();
  const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const jobs = new Jobs(store);
  const job = await jobs.create({ source: 'export.zip' });
  assert.deepEqual(Object.keys(job).sort(), ['created_at', 'cursor', 'done', 'errors', 'id', 'skipped', 'source', 'status', 'total', 'updated_at']);
  await jobs.putFiles(job.id, [{ path: 'a.fit', hash: 'h', ride_id: 'r1', status: 'imported' }, { path: 'b.fit', status: 'error', error: 'bad' },
    { path: 'c.fit', status: 'duplicate' }, { path: 'd.fit', status: 'skipped', error: 'not cycling (run)' }]);
  await jobs.putFiles(job.id, [{ path: 'd.fit', status: 'error', error: 'later' }]);
  assert.deepEqual((await jobs.files(job.id)).map(r => [r.job_id === job.id, r.path, r.status]), [[true, 'b.fit', 'error'], [true, 'd.fit', 'error']],
    'only errors and skipped files are logged');
  await jobs.putFiles(job.id, Array.from({ length: 700 }, (_, i) => ({ path: `e${i}.fit`, status: 'error', error: 'x' })));
  assert.equal((await jobs.files(job.id)).length, Jobs.MAX_FILES);
  await jobs.update(job.id, { status: 'done', total: 2, done: 1, errors: 1 });
  assert.equal((await jobs.get(job.id)).status, 'done');
  for (let i = 0; i < 6; i++) await jobs.create({ source: `more ${i}` });
  assert.equal((await jobs.list()).length, 5);
  assert.equal(await jobs.get(job.id), null);
  assert.ok([...mem.keys()].every(k => k.startsWith('apex_import_')));
  assert.equal([...mem.keys()].filter(k => k.startsWith('apex_import_files_')).length, 0, 'files of dropped jobs are removed');
});
