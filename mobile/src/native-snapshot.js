/**
 * Streaming pieces for the phone store's snapshots, so no step holds a whole history as one string:
 * an incremental SHA-256 (crypto.subtle only hashes a complete buffer), a gzip writer that appends to a
 * file in chunks, and a check that hashes a gzip file while decompressing it.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);

/** SHA-256 fed in pieces: `new Sha256().update(a).update(b).hex()`. */
export class Sha256 {
  constructor() {
    this.h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    this.w = new Uint32Array(64); this.buf = new Uint8Array(64); this.fill = 0; this.total = 0;
  }
  block(b, at) {
    const w = this.w, h = this.h;
    for (let t = 0; t < 16; t++, at += 4) w[t] = (b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3];
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15], c = w[t - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((c >>> 17) | (c << 15)) ^ ((c >>> 19) | (c << 13)) ^ (c >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let [A, B, C, D, E, F, G, H] = h;
    for (let t = 0; t < 64; t++) {
      const S1 = ((E >>> 6) | (E << 26)) ^ ((E >>> 11) | (E << 21)) ^ ((E >>> 25) | (E << 7));
      const t1 = (H + S1 + ((E & F) ^ (~E & G)) + K[t] + w[t]) | 0;
      const S0 = ((A >>> 2) | (A << 30)) ^ ((A >>> 13) | (A << 19)) ^ ((A >>> 22) | (A << 10));
      const t2 = (S0 + ((A & B) ^ (A & C) ^ (B & C))) | 0;
      H = G; G = F; F = E; E = (D + t1) | 0; D = C; C = B; B = A; A = (t1 + t2) | 0;
    }
    h[0] += A; h[1] += B; h[2] += C; h[3] += D; h[4] += E; h[5] += F; h[6] += G; h[7] += H;
  }
  update(bytes) {
    let i = 0;
    this.total += bytes.length;
    if (this.fill) {
      i = Math.min(64 - this.fill, bytes.length);
      this.buf.set(bytes.subarray(0, i), this.fill); this.fill += i;
      if (this.fill < 64) return this;
      this.block(this.buf, 0); this.fill = 0;
    }
    for (; i + 64 <= bytes.length; i += 64) this.block(bytes, i);
    if (i < bytes.length) { this.buf.set(bytes.subarray(i)); this.fill = bytes.length - i; }
    return this;
  }
  hex() {
    const bits = this.total * 8, tail = new Uint8Array(((this.fill + 8) >> 6 << 6) + 64 - this.fill);
    tail[0] = 0x80;
    const n = tail.length, high = Math.floor(bits / 0x100000000), low = bits >>> 0;
    tail[n - 8] = high >>> 24; tail[n - 7] = high >>> 16; tail[n - 6] = high >>> 8; tail[n - 5] = high;
    tail[n - 4] = low >>> 24; tail[n - 3] = low >>> 16; tail[n - 2] = low >>> 8; tail[n - 1] = low;
    this.total -= n; this.update(tail);
    return [...this.h].map((x) => x.toString(16).padStart(8, '0')).join('');
  }
}

const join = (parts, n) => { const out = new Uint8Array(n); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };

/**
 * Writes `produce(write)` gzipped to files[name], appending about `chunkBytes` at a time. `write(bytes)`
 * resolves once the compressor has taken the bytes. Resolves to { hash, bytes }: the SHA-256 of everything
 * written (before compression) and the size of the file.
 */
export async function writeGzipFile(files, name, produce, { chunkBytes = 1 << 20 } = {}) {
  await files.write(name, new Uint8Array(0));
  const gz = new CompressionStream('gzip'), writer = gz.writable.getWriter(), reader = gz.readable.getReader();
  let size = 0;
  const flush = async (parts, n) => { if (n) { await files.append(name, join(parts, n)); size += n; } };
  const pump = (async () => {
    let parts = [], n = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value); n += value.length;
        if (n >= chunkBytes) { await flush(parts, n); parts = []; n = 0; }
      }
      await flush(parts, n);
    } catch (e) { reader.cancel(e).catch(() => {}); throw e; } // a failed append also stops the writer
  })();
  const hash = new Sha256();
  try {
    await produce(async (bytes) => { hash.update(bytes); await writer.write(bytes); });
    await writer.close();
  } catch (e) {
    writer.abort(e).catch(() => {});
    await pump.catch(() => {});
    throw e;
  }
  await pump;
  return { hash: hash.hex(), bytes: size };
}

/** SHA-256 of a gzip file's content, decompressed a chunk at a time; refuses more than `max` bytes. */
export async function hashGzipFile(files, name, max = Infinity) {
  const reader = new Blob([await files.read(name)]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const hash = new Sha256();
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return hash.hex();
    n += value.length;
    if (n > max) { reader.cancel().catch(() => {}); throw Object.assign(new Error('Backup is too large.'), { status: 400 }); }
    hash.update(value);
  }
}
