/**
 * APEX VELO // LAB - reads the files inside a .zip (pure, no DOM).
 *
 * For backfills from a downloaded folder: Google Drive (and most tools) zip a folder as stored or
 * deflated entries, which the browser's DecompressionStream inflates. No ZIP64, no encryption.
 *
 *   each(blob, test, fn) -> calls fn(name, text) for every file whose name passes test(name), one at
 *                           a time, so a big archive never sits in memory as text all at once.
 *                           Folders and macOS "__MACOSX" / "._" copies are skipped. Returns the count.
 */
(function (root) {
  'use strict';

  async function inflate(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open .zip files - unzip it first and pick the files.');
    return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  }

  async function each(blob, test, fn) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    // End of central directory: the last record, before a comment of up to 64 KB.
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a .zip file.');
    const count = dv.getUint16(eocd + 10, true);
    const dec = new TextDecoder();
    let p = dv.getUint32(eocd + 16, true), n = 0;
    for (let e = 0; e < count; e++) {
      if (p + 46 > buf.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('The .zip file is damaged.');
      const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      const base = name.split('/').pop();
      if (!base || /(^|\/)__MACOSX\//.test(name) || base.startsWith('._') || !test(name)) continue;
      if (local + 30 > buf.length || dv.getUint32(local, true) !== 0x04034b50) throw new Error('The .zip file is damaged.');
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const bytes = buf.subarray(start, start + size);
      if (method !== 0 && method !== 8) throw new Error(`${base}: unsupported compression in the .zip file.`);
      await fn(name, method === 0 ? dec.decode(bytes) : await inflate(bytes));
      n++;
    }
    return n;
  }

  const VeloUnzip = { each };
  if (typeof module !== 'undefined' && module.exports) module.exports = VeloUnzip;
  if (root) root.VeloUnzip = VeloUnzip;
})(typeof window !== 'undefined' ? window : null);
