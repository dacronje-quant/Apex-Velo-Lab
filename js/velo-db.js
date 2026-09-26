/**
 * APEX VELO // LAB - IndexedDB persistence for rides (full per-second samples live here).
 *
 * Safety rules:
 * - A read that fails or times out returns null, never an empty list, so callers can tell
 *   "the database is empty" from "the database could not be read".
 * - A write never replaces a stored ride's per-second samples with a summary-only copy.
 * - Success is reported only when the transaction actually completes.
 * - The test suite runs the app with ?apexTest=1 and gets its own database.
 */
class VeloDB {
  static dbName = (typeof window !== 'undefined' && window.__APEX_TEST_MODE__) ? 'ApexVeloDB_test' : 'ApexVeloDB';
  static version = 1;
  static dbInstance = null;
  static OPEN_TIMEOUT_MS = 5000;
  static TX_TIMEOUT_MS = 20000;

  static open() {
    if (VeloDB.dbInstance) return Promise.resolve(VeloDB.dbInstance);
    return new Promise((resolve) => {
      if (typeof indexedDB === 'undefined' || !indexedDB) { resolve(null); return; }
      let settled = false;
      const finish = (db) => { if (!settled) { settled = true; clearTimeout(tm); resolve(db); } };
      const tm = setTimeout(() => { console.warn('IndexedDB open timed out'); finish(null); }, VeloDB.OPEN_TIMEOUT_MS);
      try {
        const req = indexedDB.open(VeloDB.dbName, VeloDB.version);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('rides')) {
            const store = db.createObjectStore('rides', { keyPath: 'id' });
            store.createIndex('date', 'date', { unique: false });
            store.createIndex('profileName', 'profileName', { unique: false });
          }
          if (!db.objectStoreNames.contains('profiles')) db.createObjectStore('profiles', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
        };
        req.onsuccess = () => {
          const db = req.result;
          if (settled) { try { db.close(); } catch (e) { /* ignore */ } return; }
          db.onversionchange = () => { try { db.close(); } catch (e) { /* ignore */ } VeloDB.dbInstance = null; };
          VeloDB.dbInstance = db;
          finish(db);
        };
        req.onerror = () => { console.warn('IndexedDB open error', req.error); finish(null); };
        req.onblocked = () => { console.warn('IndexedDB open blocked (another tab is upgrading it)'); };
      } catch (e) {
        finish(null);
      }
    });
  }

  /** Runs fn(store) in one transaction; resolves true only when the transaction completes. */
  static async _write(fn) {
    const db = await VeloDB.open();
    if (!db) return false;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; clearTimeout(tm); resolve(v); } };
      const tm = setTimeout(() => { console.warn('IndexedDB write timed out'); finish(false); }, VeloDB.TX_TIMEOUT_MS);
      try {
        const tx = db.transaction('rides', 'readwrite');
        tx.oncomplete = () => finish(true);
        tx.onerror = () => { console.warn('IndexedDB write error', tx.error); finish(false); };
        tx.onabort = () => { console.warn('IndexedDB write aborted', tx.error); finish(false); };
        fn(tx.objectStore('rides'));
      } catch (e) {
        console.warn('IndexedDB write failed', e);
        finish(false);
      }
    });
  }

  static hasSamples(ride) { return !!(ride && Array.isArray(ride.samples) && ride.samples.length); }

  /** Upserts rides. A ride passed without samples keeps the samples already stored for it. */
  static saveRidesBatch(rides) {
    const list = (rides || []).filter(r => r && r.id !== undefined && r.id !== null);
    if (!list.length) return Promise.resolve(true);
    return VeloDB._write((store) => {
      for (const r of list) {
        if (VeloDB.hasSamples(r)) { store.put(r); continue; }
        const get = store.get(r.id);
        get.onsuccess = () => {
          const existing = get.result;
          store.put(VeloDB.hasSamples(existing) ? { ...r, samples: existing.samples } : r);
        };
      }
    });
  }

  static saveRide(ride) { return VeloDB.saveRidesBatch([ride]); }

  /** All stored rides, [] when the database is empty, or null when it could not be read. */
  static async getAllRides() {
    const db = await VeloDB.open();
    if (!db) return null;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; clearTimeout(tm); resolve(v); } };
      const tm = setTimeout(() => { console.warn('IndexedDB read timed out'); finish(null); }, VeloDB.TX_TIMEOUT_MS);
      try {
        const req = db.transaction('rides', 'readonly').objectStore('rides').getAll();
        req.onsuccess = () => finish(req.result || []);
        req.onerror = () => { console.warn('IndexedDB read error', req.error); finish(null); };
      } catch (e) {
        console.warn('IndexedDB read failed', e);
        finish(null);
      }
    });
  }

  static clearAllRides() { return VeloDB._write((store) => store.clear()); }

  static deleteRide(id) { return VeloDB._write((store) => store.delete(id)); }
}

if (typeof window !== 'undefined') window.VeloDB = VeloDB;
