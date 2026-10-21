/**
 * APEX VELO // LAB - bulk history import core: many ride files at once, including .zip archives
 * (nested zips in a Garmin GDPR export, the Strava "Download your data" zip) and .gz files.
 *
 * Runs unchanged in a Web Worker (js/velo-import-worker.js), on the page (fallback) and in node tests.
 * Archives are streamed: entries are read chunk by chunk with fflate's Unzip, and only one ride file
 * at a time is held in memory, so multi-GB exports never have to fit in RAM.
 *
 * Sport filtering uses what the file says (FIT sport/sub_sport, TCX Activity Sport, GPX type),
 * never the file name. Dedupe against history happens on the page (VeloDedupe.admit); this module
 * only drops exact copies (same SHA-256 of the decompressed bytes).
 */
class VeloBulkImport {
  /** Filter modes offered in the UI; 'cycling' (the default) includes indoor and virtual rides. */
  static MODES = { cycling: 'All cycling (incl. indoor/virtual)', outdoor: 'Outdoor cycling only', all: 'Everything' };

  // FIT profile enums (sport / sub_sport) used for the filter.
  static FIT_INDOOR_SUB = new Set([5, 6, 58]); // spin, indoor_cycling, virtual_activity

  /** What a path is: { kind: 'fit'|'tcx'|'gpx'|'csv'|'zip', gz } or null when it is not a ride file. */
  static kindOf(path) {
    const name = String(path).toLowerCase().split('/').pop();
    const gz = name.endsWith('.gz');
    const ext = (gz ? name.slice(0, -3) : name).split('.').pop();
    if (ext === 'zip' && !gz) return { kind: 'zip', gz: false };
    return ['fit', 'tcx', 'gpx', 'csv'].includes(ext) ? { kind: ext, gz } : null;
  }

  /**
   * The activity family of a parsed ride from the sport recorded in its file:
   * { family: 'ride'|'run'|'walk'|'strength'|'mobility'|'other', indoor, known }.
   */
  static sportOf(ride) {
    if (ride.fitSport !== undefined) {
      const s = ride.fitSport, sub = ride.fitSubSport || 0;
      const indoor = VeloBulkImport.FIT_INDOOR_SUB.has(sub);
      if (s === 2 || s === 21) return { family: 'ride', indoor, known: true };          // cycling, e_biking
      if ((s === 4 || s === 10) && (sub === 5 || sub === 6)) return { family: 'ride', indoor: true, known: true }; // trainer logged as fitness equipment
      if (s === 1) return { family: 'run', indoor: sub === 1 || sub === 45, known: true };
      if (s === 11 || s === 17) return { family: 'walk', indoor: false, known: true };   // walking, hiking
      if (sub === 20) return { family: 'strength', indoor: true, known: true };          // strength_training
      if (sub === 43 || sub === 44) return { family: 'mobility', indoor: true, known: true }; // yoga, pilates
      return { family: 'other', indoor: false, known: true };
    }
    if (ride.fileSport) return VeloBulkImport.sportFromText(ride.fileSport);
    return { family: 'ride', indoor: false, known: false };
  }

  /** TCX Sport attribute, GPX <type> or a Strava "Activity Type". */
  static sportFromText(text) {
    const t = String(text).trim().toLowerCase();
    const indoor = /virtual|indoor|trainer|spin/.test(t);
    if (/cycl|bik|ride|^1$/.test(t)) return { family: 'ride', indoor, known: true };
    if (/run|^9$/.test(t)) return { family: 'run', indoor, known: true };
    if (/walk|hik|^10$/.test(t)) return { family: 'walk', indoor: false, known: true };
    if (/weight|strength|crossfit|workout|hiit/.test(t)) return { family: 'strength', indoor: true, known: true };
    if (/yoga|pilates/.test(t)) return { family: 'mobility', indoor: true, known: true };
    return { family: 'other', indoor: false, known: true };
  }

  /** null when the ride passes the filter, else the reason it is skipped. Unknown sport counts as cycling. */
  static filterReason(sport, mode) {
    if (mode === 'all') return null;
    if (sport.family !== 'ride') return `not cycling (${sport.family})`;
    if (mode === 'outdoor' && sport.indoor) return 'indoor cycling';
    return null;
  }

  // ------------------------------------------------------------- helpers --
  static concat(chunks, total) {
    if (chunks.length === 1) return chunks[0];
    const out = new Uint8Array(total ?? chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  static async readStream(stream) {
    const reader = stream.getReader(), chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); total += value.length;
    }
    return VeloBulkImport.concat(chunks, total);
  }

  static async gunzip(bytes) {
    if (typeof DecompressionStream !== 'undefined' && typeof Blob !== 'undefined') {
      return VeloBulkImport.readStream(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')));
    }
    return VeloBulkImport.fflate().gunzipSync(bytes);
  }

  static fflate() {
    const f = (typeof self !== 'undefined' && self.fflate) || (typeof globalThis !== 'undefined' && globalThis.fflate);
    if (f) return f;
    if (typeof require === 'function') return require('../vendor/fflate.min.js');
    throw new Error('fflate is not loaded');
  }

  static toHex(buf) { return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join(''); }

  /** SHA-256 hex of the bytes. Web Crypto where available (secure contexts), a plain JS fallback otherwise. */
  static async sha256(bytes) {
    const subtle = typeof crypto !== 'undefined' && crypto.subtle;
    if (subtle) { try { return VeloBulkImport.toHex(await subtle.digest('SHA-256', bytes)); } catch (e) { /* fall through */ } }
    return VeloBulkImport.sha256Js(bytes);
  }

  static sha256Js(bytes) {
    const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
      0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const len = bytes.length, padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
    padded.set(bytes); padded[len] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, Math.floor(len / 0x20000000)); dv.setUint32(padded.length - 4, (len << 3) >>> 0);
    const W = new Uint32Array(64), rot = (x, n) => (x >>> n) | (x << (32 - n));
    for (let o = 0; o < padded.length; o += 64) {
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rot(W[i - 15], 7) ^ rot(W[i - 15], 18) ^ (W[i - 15] >>> 3), s1 = rot(W[i - 2], 17) ^ rot(W[i - 2], 19) ^ (W[i - 2] >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
        const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      [a, b, c, d, e, f, g, h].forEach((v, i) => { H[i] = (H[i] + v) >>> 0; });
    }
    return H.map(v => v.toString(16).padStart(8, '0')).join('');
  }

  /** RFC 4180 CSV rows (quoted fields, embedded commas, quotes and newlines). */
  static csvRows(text) {
    const rows = [];
    let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = ''; rows.push(row); row = [];
      } else field += ch;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.length > 1 || r[0]);
  }

  /** True for Strava's activities.csv (the index of a "Download your data" export), not a ride. */
  static isStravaIndex(text) {
    const head = text.slice(0, 2000).split(/\r?\n/)[0].toLowerCase();
    return head.includes('activity id') && head.includes('filename');
  }

  /** Strava activities.csv -> Map(file base name -> { name, description, type, stravaId }). */
  static stravaIndex(text) {
    const rows = VeloBulkImport.csvRows(text.replace(/^﻿/, ''));
    const head = (rows.shift() || []).map(h => h.trim().toLowerCase());
    const col = (name) => head.indexOf(name);
    const iFile = col('filename'), iName = col('activity name'), iDesc = col('activity description'), iType = col('activity type'), iId = col('activity id');
    const out = new Map();
    if (iFile < 0) return out;
    for (const r of rows) {
      const file = (r[iFile] || '').trim();
      if (!file) continue;
      out.set(VeloBulkImport.baseName(file), {
        name: iName >= 0 ? (r[iName] || '').trim() : '', description: iDesc >= 0 ? (r[iDesc] || '').trim() : '',
        type: iType >= 0 ? (r[iType] || '').trim() : '', stravaId: iId >= 0 ? (r[iId] || '').trim() : ''
      });
    }
    return out;
  }

  /**
   * Where an archive entry came from: 'strava' for the Strava "Download your data" layout
   * (<export>.zip/activities/<id>.<ext>), 'garmin' for a Garmin data export (DI_CONNECT folders), else null.
   * Rides from Strava must never be uploaded back to Strava.
   */
  static originOf(path) {
    const p = String(path).replace(/\\/g, '/');
    if (/(^|\/)DI[_-]CONNECT(\/|$)|\/DI-Connect-[^/]+\//i.test(p)) return 'garmin';
    if (/^[^/]+\.zip\/activities\/[^/]+$/i.test(p)) return 'strava';
    return null;
  }

  static baseName(path) { return String(path).split(/[\\/]/).pop().toLowerCase(); }

  // ------------------------------------------------------- walking files --
  /**
   * Yields every candidate file inside the sources, streaming archives:
   * { path, kind, gz, bytes } for ride files, { path, index } for a Strava activities.csv,
   * { path, skip } for chosen files that are not ride files and { path, error } for unreadable ones.
   * Non-ride entries inside archives (photos, JSON, account CSVs) are passed over silently.
   * `sources` are File/Blob-like objects with name and stream().
   */
  static async *walk(sources, opts = {}) {
    const isCancelled = opts.isCancelled || (() => false);
    for (const src of sources) {
      if (isCancelled()) return;
      const k = VeloBulkImport.kindOf(src.name);
      if (!k) { yield { path: src.name, skip: 'not a ride file' }; continue; }
      try {
        if (k.kind === 'zip') yield* VeloBulkImport.walkZip(src.stream(), src.name, isCancelled);
        else {
          const raw = await VeloBulkImport.readStream(k.gz && typeof DecompressionStream !== 'undefined'
            ? src.stream().pipeThrough(new DecompressionStream('gzip')) : src.stream());
          const bytes = k.gz && typeof DecompressionStream === 'undefined' ? VeloBulkImport.fflate().gunzipSync(raw) : raw;
          yield* VeloBulkImport.classifyBytes(src.name, k, bytes, true);
        }
      } catch (e) {
        yield { path: src.name, error: e.message || String(e) };
      }
    }
  }

  static *classifyBytes(path, k, bytes, topLevel) {
    if (k.kind === 'csv') {
      const text = new TextDecoder().decode(bytes);
      if (VeloBulkImport.isStravaIndex(text)) { yield { path, index: VeloBulkImport.stravaIndex(text) }; return; }
      // Inside archives a CSV is almost always account data (Garmin, Strava), not a ride: ignored.
      if (!topLevel) return;
    }
    yield { path, kind: k.kind, gz: false, bytes };
  }

  /** Streams a zip (and zips inside it) entry by entry. Only ride files are buffered, one at a time. */
  static async *walkZip(stream, label, isCancelled) {
    const fflate = VeloBulkImport.fflate();
    const ready = [];
    const open = (prefix, depth) => {
      const unzip = new fflate.Unzip();
      unzip.register(fflate.UnzipInflate);
      unzip.onfile = (file) => {
        const path = `${prefix}/${file.name}`;
        if (file.name.endsWith('/')) return;
        const k = VeloBulkImport.kindOf(file.name);
        if (!k) return; // account data, photos, JSON: not counted, never read
        if (k.kind === 'zip' && depth >= 4) { ready.push({ path, skip: 'archive nested too deep' }); return; }
        if (k.kind === 'zip') {
          const inner = open(path, depth + 1);
          file.ondata = (err, chunk, final) => {
            if (err) { ready.push({ path, error: err.message || String(err) }); return; }
            try { inner.push(chunk, final); } catch (e) { ready.push({ path, error: e.message || String(e) }); }
          };
        } else {
          const chunks = [];
          let total = 0;
          file.ondata = (err, chunk, final) => {
            if (err) { ready.push({ path, error: err.message || String(err) }); return; }
            if (chunk && chunk.length) { chunks.push(chunk); total += chunk.length; }
            if (final) ready.push({ path, k, raw: VeloBulkImport.concat(chunks, total) });
          };
        }
        try { file.start(); } catch (e) { ready.push({ path, error: e.message || String(e) }); }
      };
      return unzip;
    };
    const root = open(label, 0);
    const reader = stream.getReader();
    try {
      for (;;) {
        if (isCancelled()) { await reader.cancel().catch(() => {}); return; }
        const { done, value } = await reader.read();
        root.push(done ? new Uint8Array(0) : value, done);
        while (ready.length) {
          const item = ready.shift();
          if (!item.raw) { yield item; continue; }
          try {
            const bytes = item.k.gz ? await VeloBulkImport.gunzip(item.raw) : item.raw;
            yield* VeloBulkImport.classifyBytes(item.path, item.k, bytes, false);
          } catch (e) {
            yield { path: item.path, error: e.message || String(e) };
          }
          if (isCancelled()) { await reader.cancel().catch(() => {}); return; }
        }
        if (done) return;
      }
    } finally {
      try { reader.releaseLock(); } catch (e) { /* already released */ }
    }
  }

  // ------------------------------------------------------------- parsing --
  /** Parses one ride file into a ride record (VeloRideImporter), tagged with source, fileHash and path. */
  static parseRide(entry, profile) {
    const I = VeloRideImporter;
    const name = profile.name || 'Imported rider', ftp = Number(profile.ftp) || 185;
    let ride;
    if (entry.kind === 'fit') {
      const b = entry.bytes;
      ride = I.parseFit(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), name, ftp);
    } else {
      const text = new TextDecoder().decode(entry.bytes);
      if (entry.kind === 'tcx') ride = I.parseTcx(text, ftp, name);
      else if (entry.kind === 'gpx') ride = I.parseGpx(text, name, ftp);
      else ride = I.parseCsv(text, name, ftp);
    }
    ride.source = `import:${entry.kind}`;
    ride.fileName = entry.path.split('/').pop();
    ride.importPath = entry.path;
    return ride;
  }

  /**
   * The whole import of one job. Callbacks:
   *  onProgress(counts, currentPath)  counts = { found, parsed, skipped, errors, duplicates }
   *  onRides(rides)                   a batch of parsed rides (to dedupe against history and keep)
   *  onIndex(map)                     names/descriptions from a Strava activities.csv
   *  onFile({ path, hash, status, error, rideId })  one row per file, for the import_files log
   * opts: { mode, profile, knownHashes, batchSize, isCancelled }.
   */
  static async run(sources, opts = {}, cb = {}) {
    const mode = opts.mode || 'cycling';
    const profile = opts.profile || {};
    const seen = new Set(opts.knownHashes || []);
    const batchSize = opts.batchSize || 25;
    const counts = { found: 0, parsed: 0, skipped: 0, errors: 0, duplicates: 0 };
    const progress = (path) => cb.onProgress && cb.onProgress({ ...counts }, path);
    const file = (row) => cb.onFile && cb.onFile(row);
    let batch = [], lastFlush = Date.now();
    const flush = () => { if (batch.length && cb.onRides) cb.onRides(batch); batch = []; lastFlush = Date.now(); };
    for await (const entry of VeloBulkImport.walk(sources, opts)) {
      if (entry.index) { if (cb.onIndex) cb.onIndex(entry.index); continue; }
      if (entry.skip) { counts.skipped++; file({ path: entry.path, status: 'skipped', error: entry.skip }); progress(entry.path); continue; }
      counts.found++;
      if (entry.error) { counts.errors++; file({ path: entry.path, status: 'error', error: entry.error }); progress(entry.path); continue; }
      try {
        const hash = await VeloBulkImport.sha256(entry.bytes);
        if (seen.has(hash)) { counts.duplicates++; file({ path: entry.path, hash, status: 'duplicate', origin: VeloBulkImport.originOf(entry.path) }); progress(entry.path); continue; }
        seen.add(hash);
        const ride = VeloBulkImport.parseRide(entry, profile);
        ride.fileHash = hash;
        const sport = VeloBulkImport.sportOf(ride);
        const reason = !ride.samplesCount ? 'no track data' : VeloBulkImport.filterReason(sport, mode);
        if (reason) { counts.skipped++; file({ path: entry.path, hash, status: 'skipped', error: reason }); progress(entry.path); continue; }
        if (sport.family !== 'ride') ride.activityType = sport.family;
        const origin = VeloBulkImport.originOf(entry.path);
        if (origin) ride.origin = origin;
        counts.parsed++;
        file({ path: entry.path, hash, status: 'parsed', rideId: ride.id });
        batch.push(ride);
      } catch (e) {
        counts.errors++;
        file({ path: entry.path, status: 'error', error: e.message || String(e) });
      }
      progress(entry.path);
      if (batch.length >= batchSize || Date.now() - lastFlush > 1000) flush();
    }
    flush();
    const cancelled = !!(opts.isCancelled && opts.isCancelled());
    progress(null);
    return { counts, cancelled };
  }

  /** Applies Strava activities.csv names, descriptions and ids to imported rides (matched by file name); they are Strava's. */
  static applyIndex(rides, index) {
    if (!index || !index.size) return 0;
    let n = 0;
    for (const r of rides) {
      const meta = index.get(VeloBulkImport.baseName(r.importPath || r.fileName || ''));
      if (!meta) continue;
      if (meta.name) r.title = meta.name;
      if (meta.description) r.description = meta.description;
      if (meta.stravaId) r.stravaActivityId = meta.stravaId;
      r.origin = 'strava';
      n++;
    }
    return n;
  }
}

if (typeof self !== 'undefined') self.VeloBulkImport = VeloBulkImport;
if (typeof module !== 'undefined') module.exports = VeloBulkImport;
