/**
 * Outbound uploads on the phone: the sync ledger and the offline retry queue.
 *
 * The ledger keeps one row per (ride, destination) with the columns of the SQLite `sync_ledger` table in
 * docs/ANDROID-CONTRACTS.md. Until that table exists (workstream B) the rows live in Capacitor Preferences
 * under `apex_sync_` keys, behind PrefsSyncLedger; a SQLite adapter with the same methods replaces it.
 *
 * Row statuses: 'queued' (waiting; `attempts` counts failed tries), 'sent' (external_id is the destination's
 * activity id), 'failed' (given up; sending again by hand re-queues it), 'skipped' (never sent: the ride came
 * from that destination).
 */

export const LEDGER_PREFIX = 'apex_sync_';
export const BACKOFF_MS = [60e3, 5 * 60e3, 15 * 60e3, 60 * 60e3, 6 * 60 * 60e3];
export const MAX_ATTEMPTS = 8;

/** When a queued row may be tried again: right away before the first failure, then with growing gaps. */
export function nextAttemptAt(row) {
  if (!row || !row.attempts) return 0;
  return Date.parse(row.updated_at) + BACKOFF_MS[Math.min(row.attempts, BACKOFF_MS.length) - 1];
}

/**
 * A ride is never sent back to the service it was imported from: the desktop's Strava sync (source 'Strava'),
 * an import tagged with `origin` (Strava export files: origin 'strava'; Health Connect: the Strava app's package),
 * or a ride whose source is the destination (Health Connect rides are never written back to it).
 */
const ORIGIN_APPS = { 'com.strava': 'strava' }; // Health Connect rides: origin is the writing app's package
export function isFromDestination(ride, destinationId) {
  if (!ride) return false;
  const id = String(destinationId).toLowerCase();
  const origin = String(ride.origin || '').toLowerCase();
  if (origin === id || ORIGIN_APPS[origin] === id) return true;
  if (String(ride.source || '').toLowerCase().split(/[:/]/).includes(id)) return true;
  return id === 'strava' && !!ride.strava && ride.strava.state === 'imported';
}

async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Ledger adapter over Capacitor Preferences: one JSON map per destination (`apex_sync_ledger_<destination>`),
 * plus small options (`apex_sync_opt_<name>`). Writes are serialised so concurrent updates are not lost.
 */
export class PrefsSyncLedger {
  constructor({ prefs, now = () => Date.now() }) {
    Object.assign(this, { prefs, now });
    this._chain = Promise.resolve();
  }

  _key(destination) { return `${LEDGER_PREFIX}ledger_${destination}`; }

  async _map(destination) {
    try { const m = JSON.parse((await this.prefs.get(this._key(destination))) || '{}'); return m && typeof m === 'object' ? m : {}; } catch (e) { return {}; }
  }

  _locked(fn) {
    const run = this._chain.then(fn, fn);
    this._chain = run.catch(() => {});
    return run;
  }

  async get(rideId, destination) { return (await this._map(destination))[rideId] || null; }

  async list(destination) { return Object.values(await this._map(destination)); }

  /** Merges `patch` into the row (created if missing) and stamps updated_at. Resolves the new row. */
  update(rideId, destination, patch) {
    return this._locked(async () => {
      const m = await this._map(destination);
      const row = { ride_id: String(rideId), destination, external_id: null, content_hash: null, status: 'queued', attempts: 0, last_error: null, ...m[rideId], ...patch, updated_at: new Date(this.now()).toISOString() };
      m[rideId] = row;
      await this.prefs.set(this._key(destination), JSON.stringify(m));
      return row;
    });
  }

  remove(rideId, destination) {
    return this._locked(async () => {
      const m = await this._map(destination);
      if (!(rideId in m)) return;
      delete m[rideId];
      await this.prefs.set(this._key(destination), JSON.stringify(m));
    });
  }

  async getOption(name) { return this.prefs.get(`${LEDGER_PREFIX}opt_${name}`); }
  setOption(name, value) { return this.prefs.set(`${LEDGER_PREFIX}opt_${name}`, String(value)); }
}

/**
 * The retry queue. destinations: [{ id, label, isConnected(), upload(ride, fitBytes) -> { externalId, duplicate? } }],
 * where upload throws { retryable, needsConnect } errors (see StravaDestination). getRide(id) -> ride with samples
 * or null when the ride is gone; buildFit(ride) -> Uint8Array. onChange(rideId, row, result) fires after each try.
 * run() is called at app start, on resume, after enqueue, and by a timer for the next due retry.
 */
export class UploadQueue {
  constructor({ ledger, destinations, getRide, buildFit, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, onChange = () => {} }) {
    Object.assign(this, { ledger, getRide, buildFit, now, setTimer, clearTimer, onChange });
    this.destinations = new Map(destinations.map((d) => [d.id, d]));
    this._running = null;
    this._again = false;
    this._timer = null;
  }

  state(rideId, destinationId) { return this.ledger.get(rideId, destinationId); }

  async autoUpload(destinationId) { return (await this.ledger.getOption(`auto_${destinationId}`)) === '1'; }
  setAutoUpload(destinationId, on) { return this.ledger.setOption(`auto_${destinationId}`, on ? '1' : '0'); }

  /**
   * Puts a ride in the queue. A ride already sent stays sent (its row is returned, nothing is uploaded);
   * `retry` re-queues a failed one with a fresh attempt count. Rides from the destination itself are skipped.
   */
  async enqueue(ride, destinationId, { retry = false } = {}) {
    if (!this.destinations.has(destinationId)) throw new Error(`Unknown destination ${destinationId}`);
    const row = await this.ledger.get(ride.id, destinationId);
    if (row && row.status === 'sent') return row;
    if (isFromDestination(ride, destinationId)) return this.ledger.update(ride.id, destinationId, { status: 'skipped', last_error: `Imported from ${this.destinations.get(destinationId).label}: never sent back.` });
    if (row && row.status === 'queued' && !retry) return row;
    if (row && row.status === 'failed' && !retry) return row;
    return this.ledger.update(ride.id, destinationId, { status: 'queued', attempts: 0, last_error: null });
  }

  /** Records a ride the destination already has (e.g. a ride restored with its activity id) without uploading it. */
  markSent(rideId, destinationId, externalId) {
    return this.ledger.update(rideId, destinationId, { status: 'sent', external_id: String(externalId), last_error: null });
  }

  /** Queues the ride, runs the queue now and resolves the ride's row afterwards. */
  async sendNow(ride, destinationId) {
    await this.enqueue(ride, destinationId, { retry: true });
    await this.run();
    return this.ledger.get(ride.id, destinationId);
  }

  /** Counts for the settings screen: { queued, failed, sent, nextAt }. */
  async summary(destinationId) {
    const rows = await this.ledger.list(destinationId);
    const queued = rows.filter((r) => r.status === 'queued');
    return {
      queued: queued.length, failed: rows.filter((r) => r.status === 'failed').length, sent: rows.filter((r) => r.status === 'sent').length,
      nextAt: queued.length ? Math.min(...queued.map(nextAttemptAt)) : null
    };
  }

  /** Tries every due row once. Overlapping calls share one pass (and trigger one more pass after it). */
  run() {
    if (this._running) { this._again = true; return this._running; }
    this._running = (async () => {
      try {
        do { this._again = false; await this._pass(); } while (this._again);
      } finally {
        this._running = null;
        await this._schedule().catch(() => {});
      }
    })();
    return this._running;
  }

  async _pass() {
    for (const [id, dest] of this.destinations) {
      const due = (await this.ledger.list(id)).filter((r) => r.status === 'queued' && nextAttemptAt(r) <= this.now());
      if (!due.length || !(await dest.isConnected().catch(() => false))) continue;
      for (const row of due) {
        if (!(await this._try(dest, row))) break; // signed out: the rest wait for the next sign-in
      }
    }
  }

  /** One upload. Resolves false when the destination needs a new sign-in. */
  async _try(dest, row) {
    const ride = await this.getRide(row.ride_id);
    if (!ride) { await this.ledger.remove(row.ride_id, dest.id); return true; } // the ride was deleted
    if (isFromDestination(ride, dest.id)) {
      this.onChange(ride.id, await this.ledger.update(ride.id, dest.id, { status: 'skipped' }), null);
      return true;
    }
    let next, result = null, signedOut = false;
    try {
      if (!Array.isArray(ride.samples) || !ride.samples.length) throw Object.assign(new Error('This ride has no second-by-second data to send.'), { retryable: false });
      const bytes = this.buildFit(ride);
      const hash = await sha256Hex(bytes);
      result = await dest.upload(ride, bytes);
      next = { status: 'sent', external_id: String(result.externalId), content_hash: hash, last_error: null };
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (e && e.needsConnect) { signedOut = true; next = { status: 'queued', last_error: msg }; }
      else {
        const attempts = (row.attempts || 0) + 1;
        next = { status: e && e.retryable && attempts < MAX_ATTEMPTS ? 'queued' : 'failed', attempts, last_error: msg };
      }
    }
    this.onChange(ride.id, await this.ledger.update(ride.id, dest.id, next), result);
    return !signedOut;
  }

  async _schedule() {
    if (this._timer) { this.clearTimer(this._timer); this._timer = null; }
    let soonest = Infinity;
    for (const id of this.destinations.keys()) {
      for (const r of await this.ledger.list(id)) if (r.status === 'queued' && r.attempts) soonest = Math.min(soonest, nextAttemptAt(r));
    }
    if (soonest === Infinity) return;
    this._timer = this.setTimer(() => { this._timer = null; this.run().catch(() => {}); }, Math.max(1000, soonest - this.now()));
  }
}
