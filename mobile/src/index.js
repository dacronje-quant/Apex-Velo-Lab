/**
 * Entry point of the Android layer, bundled to www/mobile/apex-native.js and loaded first in <head>.
 * In a plain browser it does nothing, so the same www/ folder still opens on a PC.
 * Browser tests set window.__APEX_NATIVE_FAKE__ = { ble, http, aiHttp, prefs, plugins, sqlite, backupFiles } before
 * this runs (`sqlite` is a native-store db driver; without it the app keeps the WebView storage).
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { BleClient } from '@capacitor-community/bluetooth-le';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Preferences } from '@capacitor/preferences';
import { Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { installNativeBluetooth } from './native-ble.js';
import { NativeStrava, StravaDestination } from './native-strava.js';
import { PrefsSyncLedger, UploadQueue } from './native-outbox.js';
import { NativeAi } from './native-ai.js';
import { NativeIcu } from './native-icu.js';
import { bootNativeApp } from './native-app.js';
import { NativeStore, openingLedger } from './native-store.js';
import { openCapacitorDatabase, filesystemFiles } from './native-sqlite.js';
import { WebViewMigration, webViewSource } from './native-migrate.js';

const fake = window.__APEX_NATIVE_FAKE__;
if (fake || Capacitor.isNativePlatform()) {
  const plugins = (fake && fake.plugins) || { App, Browser, KeepAwake, Filesystem, Share };
  const prefs = (fake && fake.prefs) || {
    get: async (key) => (await Preferences.get({ key })).value,
    set: (key, value) => Preferences.set({ key, value }),
    remove: (key) => Preferences.remove({ key })
  };
  const bluetooth = installNativeBluetooth((fake && fake.ble) || BleClient);
  const strava = new NativeStrava({ http: (fake && fake.http) || CapacitorHttp, prefs, openUrl: (url) => plugins.Browser.open({ url }) });
  const ai = new NativeAi({ http: (fake && (fake.aiHttp || fake.http)) || CapacitorHttp, prefs, ...(fake && fake.aiBases ? { bases: fake.aiBases } : {}) });
  const icu = new NativeIcu({ http: (fake && fake.http) || CapacitorHttp, prefs });
  // Saved data: SQLite in the app's private storage, opened once; a failure is reported by every
  // /api/storage answer, and js/velo-storage.js then keeps the WebView storage and shows why.
  const store = fake && !fake.sqlite ? null : (async () => {
    const db = fake ? fake.sqlite : await openCapacitorDatabase(SQLiteConnection, CapacitorSQLite);
    const s = await NativeStore.open({ db, files: (fake && fake.backupFiles) || filesystemFiles(plugins.Filesystem), dir: 'this phone', file: 'apexSQLite.db' });
    s.startDailyBackups(60000).catch(() => {}); // after the app has started
    return s;
  })();
  if (store) store.catch(() => {});
  const storage = store && {
    async route(pathname, method, body) {
      let s;
      try { s = await store; } catch (e) { return { status: 503, body: { error: `The phone database could not be opened (${(e && e.message) || e}).` } }; }
      return s.route(pathname, method, body);
    },
    /** Moves earlier WebView data in (once); onProgress(done, total). */
    async migrate(onProgress) {
      return new WebViewMigration({ store: await store, source: webViewSource(window), onProgress }).run();
    }
  };
  // Outbound uploads. The rides, the FIT writer and the ride description belong to the page (js/), which
  // loads after this module, so they are looked up when an upload runs. The ledger is the sync_ledger table
  // (D's Preferences rows moved in once); without a phone database it stays in Preferences.
  const stravaOut = new StravaDestination({ strava, describe: (ride) => (window.app ? window.app.stravaDescription(ride) : '') });
  const uploads = new UploadQueue({
    ledger: store ? openingLedger(store, { prefs, destinations: [stravaOut.id], options: [`auto_${stravaOut.id}`], fallback: new PrefsSyncLedger({ prefs }) }) : new PrefsSyncLedger({ prefs }),
    destinations: [stravaOut],
    getRide: async (id) => {
      const ride = window.app && window.app.completedWorkouts.find((r) => r.id === id);
      if (ride && Array.isArray(ride.samples) && ride.samples.length) return ride;
      // The list may hold only the summary: the samples are in the phone database (or IndexedDB without one).
      let stored = null;
      if (store) stored = await (await store).ride(id).catch(() => null);
      else if (window.VeloDB) stored = ((await window.VeloDB.getAllRides()) || []).find((r) => r.id === id);
      return stored || ride || null;
    },
    buildFit: (ride) => window.VeloExport.buildFit(ride, ride.samples)
  });
  window.ApexNative = { bluetooth, store, strava, ai, icu, uploads, platform: fake ? 'test' : Capacitor.getPlatform() };
  bootNativeApp({ bluetooth, storage, strava, ai, icu, uploads, plugins });
}
