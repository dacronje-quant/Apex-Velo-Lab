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
import { NativeStrava } from './native-strava.js';
import { NativeAi } from './native-ai.js';
import { NativeIcu } from './native-icu.js';
import { bootNativeApp } from './native-app.js';
import { NativeStore } from './native-store.js';
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
  window.ApexNative = { bluetooth, store, strava, ai, icu, platform: fake ? 'test' : Capacitor.getPlatform() };
  bootNativeApp({ bluetooth, storage, strava, ai, icu, plugins });
}
