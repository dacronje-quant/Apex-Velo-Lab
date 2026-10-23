/**
 * Entry point of the Android layer, bundled to www/mobile/apex-native.js and loaded first in <head>.
 * In a plain browser it does nothing, so the same www/ folder still opens on a PC.
 * Browser tests set window.__APEX_NATIVE_FAKE__ = { ble, http, aiHttp, prefs, plugins, sqlite, backupFiles, importPlugin, ridePlugin, brokerUrl } before
 * this runs (`sqlite` is a native-store db driver; without it the app keeps the WebView storage; plugins.HealthConnect
 * is the Health Connect plugin, left out when the test has none; `brokerUrl` replaces the build's token broker, so
 * tests do not depend on how the app was built).
 */
import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
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
import { BROKER_URL } from './app-config.js';
import { PrefsSyncLedger, UploadQueue } from './native-outbox.js';
import { NativeAi } from './native-ai.js';
import { NativeIcu } from './native-icu.js';
import { bootNativeApp } from './native-app.js';
import { installShell } from './native-shell.js';
import { installRideTab } from './native-today.js';
import { installYou } from './native-you.js';
import { installOnboarding } from './native-onboarding.js';
import { NativeRide } from './native-ride.js';
import { NativeStore, openingLedger } from './native-store.js';
import { openCapacitorDatabase, filesystemFiles } from './native-sqlite.js';
import { WebViewMigration, webViewSource } from './native-migrate.js';
import { NativeHealthConnect, HealthConnectDestination, WellnessSources } from './native-healthconnect.js';
import { NativeImport, SqliteImportJobs, installNativeImportUi } from './native-import.js';

const fake = window.__APEX_NATIVE_FAKE__;
if (fake || Capacitor.isNativePlatform()) {
  const plugins = (fake && fake.plugins) || { App, Browser, KeepAwake, Filesystem, Share, HealthConnect: registerPlugin('HealthConnect') };
  const prefs = (fake && fake.prefs) || {
    get: async (key) => (await Preferences.get({ key })).value,
    set: (key, value) => Preferences.set({ key, value }),
    remove: (key) => Preferences.remove({ key })
  };
  const bluetooth = installNativeBluetooth((fake && fake.ble) || BleClient);
  // One-tap Strava sign-in through the token broker when this build has one (src/app-config.js).
  const strava = new NativeStrava({ http: (fake && fake.http) || CapacitorHttp, prefs, openUrl: (url) => plugins.Browser.open({ url }), brokerUrl: fake ? fake.brokerUrl || '' : BROKER_URL });
  const ai = new NativeAi({ http: (fake && (fake.aiHttp || fake.http)) || CapacitorHttp, prefs, ...(fake && fake.aiBases ? { bases: fake.aiBases } : {}) });
  const icu = new NativeIcu({ http: (fake && fake.http) || CapacitorHttp, prefs });
  // Saved data: SQLite in the app's private storage, opened once; a failure is reported by every
  // /api/storage answer, and js/velo-storage.js then keeps the WebView storage and shows why.
  const store = fake && !fake.sqlite ? null : (async () => {
    const db = fake ? fake.sqlite : await openCapacitorDatabase(SQLiteConnection, CapacitorSQLite);
    // Ride summaries are made by the page's js/velo-ride-summary.js, which loads after this module.
    const s = await NativeStore.open({ db, files: (fake && fake.backupFiles) || filesystemFiles(plugins.Filesystem), dir: 'this phone', file: 'apexSQLite.db',
      summarize: (ride) => (window.VeloRideSummary ? window.VeloRideSummary.of(ride) : null), summaryVersion: () => (window.VeloRideSummary ? window.VeloRideSummary.VERSION : 0) });
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
    /** One ride with its samples, or null. */
    async ride(id) { return (await store).ride(id); },
    /** Rides whose summary is missing, one ride's new summary, and the summaries of some rides ({ id: summary }). */
    async summariesNeeded() { return (await store).summariesNeeded(); },
    async summarizeRide(id) { return (await store).summarizeRide(id); },
    async summaries(ids) { return (await store).summaries(ids); },
    /** The JSON backup with every ride's samples, as UTF-8 pieces. */
    async exportChunks(head, tail) { return (await store).exportChunks(head, tail); },
    /** Moves earlier WebView data in (once); onProgress(done, total). */
    async migrate(onProgress) {
      return new WebViewMigration({ store: await store, source: webViewSource(window), onProgress }).run();
    }
  };
  // Outbound uploads. The rides, the FIT writer and the ride description belong to the page (js/), which
  // loads after this module, so they are looked up when an upload runs. The ledger is the sync_ledger table
  // (D's Preferences rows moved in once); without a phone database it stays in Preferences.
  const stravaOut = new StravaDestination({ strava, describe: (ride) => (window.app ? window.app.stravaDescription(ride) : '') });
  // Health Connect (Android 9+): recovery data and other apps' rides in, rides recorded here out. Its days are
  // kept in the phone database (wellness_days), so it needs one.
  const healthConnect = plugins.HealthConnect ? new NativeHealthConnect({ plugin: plugins.HealthConnect, prefs }) : null;
  const wellness = healthConnect && store ? store.then((s) => new WellnessSources({ store: s, prefs })) : null;
  if (wellness) wellness.catch(() => {});
  const hcOut = healthConnect ? new HealthConnectDestination({ hc: healthConnect }) : null;
  const outs = [stravaOut, hcOut].filter(Boolean);
  const uploads = new UploadQueue({
    ledger: store ? openingLedger(store, { prefs, destinations: [stravaOut.id], options: [`auto_${stravaOut.id}`], fallback: new PrefsSyncLedger({ prefs }) }) : new PrefsSyncLedger({ prefs }),
    destinations: outs,
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
  // Ride import from Android: watched folder, share target, streamed reads of content URIs (ApexImportPlugin.kt).
  // Import jobs are logged in the phone database's import_jobs / import_files tables when it is open.
  const importPlugin = fake ? fake.importPlugin : registerPlugin('ApexImport');
  const nativeImport = importPlugin ? new NativeImport({ plugin: importPlugin, store, getApp: () => window.app }) : null;
  const importJobs = store ? new SqliteImportJobs(store, () => new window.VeloImportJobs()) : null;
  window.ApexNative = { bluetooth, store, strava, ai, icu, uploads, nativeImport, healthConnect, platform: fake ? 'test' : Capacitor.getPlatform() };
  // Riding with the screen off: the native recorder in a foreground service (com.apexvelo.lab.ride).
  const ridePlugin = fake ? fake.ridePlugin : registerPlugin('ApexRide');
  const ride = ridePlugin ? new NativeRide({ plugin: ridePlugin, prefs }) : null;
  window.ApexNative.ride = ride;
  // Phone navigation (docs/ANDROID-UX.md): bottom tabs, pages, sheets, routes; the screens register their pages on it.
  const shell = installShell({ exit: () => plugins.App.minimizeApp().catch(() => {}) });
  window.ApexNative.shell = shell;
  window.ApexNative.rideTab = installRideTab({ shell });
  bootNativeApp({ bluetooth, storage, strava, ai, icu, uploads, plugins, ride, healthConnect, wellness, shell });
  installNativeImportUi({ nativeImport, jobs: importJobs, App: plugins.App });
  // You (Settings, profile, devices, connections, data) and the first-run onboarding (workstream U5).
  installYou({ shell, services: { strava, icu, healthConnect, ai } });
  installOnboarding({ shell });
}
