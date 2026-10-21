/**
 * Moves the rides and settings an earlier version kept in the WebView (IndexedDB + localStorage) into the
 * phone database, on the first start after the update and before js/velo-storage.js boots.
 *
 * It gives the result js/velo-storage.js's own migration would (the same merge of the localStorage history
 * with the IndexedDB rides, in the same order), but reads one ride at a time and stages a few at a time
 * (NativeStore.stageMigration), so no step holds the whole history: that migration posts it as one request.
 * A start that is killed half-way leaves the WebView data untouched and nothing visible in the database;
 * the next start skips the rides staged unchanged and goes on. velo-storage.js then finds the database
 * initialized and only reads it.
 *
 * `source` reads the WebView storage (webViewSource below; tests pass their own):
 *   historyText() -> the 'apex_velo_history' string or null, localHistory() -> rides or null,
 *   settings() -> { key: value } of the saved keys, dbSettings() -> IndexedDB settings records or null,
 *   ride(id) -> the IndexedDB ride or null, ridesAfter(key, n) -> up to n rides after that key (null: from
 *   the start), in key order, rideKeys() -> every IndexedDB ride key (for the progress count).
 */
import { settingKey, rideHash } from './native-store.js';

const fail = (message) => { throw new Error(message); };
const uuid = () => crypto.randomUUID().replace(/-/g, '_');

export class WebViewMigration {
  constructor({ store, source, onProgress = () => {}, batchSize = 10 }) {
    Object.assign(this, { store, source, onProgress, batchSize });
  }

  /** Resolves to { moved: false } when the database already has the data, else { moved: true, rides, storeId }. */
  async run() {
    const { store, source } = this;
    if (await store.exclusive(() => store.initialized())) return { moved: false };
    const dbSettings = await source.dbSettings();
    if (dbSettings === null) fail('Browser data could not be read. Your original data is untouched.');
    const rawHistory = source.historyText();
    let history = [];
    if (rawHistory !== null) {
      history = JSON.parse(rawHistory);
      if (!Array.isArray(history)) fail('Browser history is invalid. Your original data is untouched.');
    } else history = source.localHistory() || [];
    // An explicit empty-history marker records a delete, not missing data: the IndexedDB rides are not used.
    const useDb = rawHistory !== '[]';
    const byId = new Map(history.map((r) => [String(r.id), r]));
    const total = byId.size + (useDb ? (await source.rideKeys()).filter((k) => !byId.has(String(k))).length : 0);
    const staged = await store.migrationStaged();
    const order = [], batch = [];
    let done = 0;
    const flush = async () => {
      if (batch.length) await store.stageMigration(batch.splice(0));
      this.onProgress(done, total);
    };
    const add = async (ride) => {
      const id = String(ride.id);
      order.push(id); done++;
      if (staged[id] !== await rideHash(ride)) batch.push(ride);
      if (batch.length >= this.batchSize || done % this.batchSize === 0) await flush();
    };
    this.onProgress(0, total);
    // The history's rides first, in its order, each with the IndexedDB samples when the history copy has none.
    for (const [id, old] of byId) {
      const r = useDb ? await source.ride(old.id) : null;
      await add(r && String(r.id) === id ? { ...old, ...(!(old.samples?.length) && r.samples?.length ? { samples: r.samples } : {}) } : old);
    }
    // Then the IndexedDB rides the history does not list, in key order.
    if (useDb) {
      for (let after = null; ;) {
        const page = await source.ridesAfter(after, this.batchSize);
        for (const r of page) if (!byId.has(String(r.id))) await add(r);
        if (page.length < this.batchSize) break;
        after = page[page.length - 1].id;
      }
    }
    await flush();
    const settings = source.settings();
    const revision = await store.exclusive(() => store.revision());
    try {
      await store.finishMigration({ revision, operationId: uuid(), order, settings, dbSettings: dbSettings.filter((s) => !s.key.startsWith('sqlite_')) });
    } catch (e) {
      if (e.status !== 409 || !await store.exclusive(() => store.initialized())) throw e;
    }
    return { moved: true, rides: order.length, storeId: await store.exclusive(() => store.meta('storeId')) };
  }
}

const request = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

/**
 * Reads the WebView storage of the version before the update: localStorage and the app's IndexedDB
 * (VeloDB: object stores 'rides', keyed by ride ID, and 'settings').
 */
export function webViewSource(win = window) {
  let opened = null;
  const db = async () => {
    if (!opened) opened = win.VeloDB.open();
    const handle = await opened;
    if (!handle) fail('Browser data could not be read. Your original data is untouched.');
    return handle;
  };
  const store = async (name) => (await db()).transaction(name, 'readonly').objectStore(name);
  return {
    historyText: () => win.localStorage.getItem('apex_velo_history'),
    localHistory: () => (win.APEX_LOCAL_HISTORY?.rides ? win.APEX_LOCAL_HISTORY.rides.map((r) => ({ ...r, profileName: r.profileName || win.APEX_LOCAL_HISTORY.riderName })) : null),
    settings() {
      const out = {};
      for (let i = 0; i < win.localStorage.length; i++) { const k = win.localStorage.key(i); if (settingKey(k)) out[k] = win.localStorage.getItem(k); }
      return out;
    },
    dbSettings: () => win.VeloDB.listSettings(''),
    /** The ride saved under this ID, as a number or as text (the history and IndexedDB may differ). */
    async ride(id) {
      for (const key of [id, typeof id === 'number' ? String(id) : Number(id)]) {
        if (typeof key === 'number' && !Number.isFinite(key)) continue;
        try { const r = await request((await store('rides')).get(key)); if (r) return r; } catch { /* not a valid key */ }
      }
      return null;
    },
    async ridesAfter(key, n) {
      const rides = await store('rides');
      return request(rides.getAll(key === null ? null : win.IDBKeyRange.lowerBound(key, true), n));
    },
    async rideKeys() { return request((await store('rides')).getAllKeys()); }
  };
}
