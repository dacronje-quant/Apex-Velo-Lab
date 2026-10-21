/**
 * Entry point of the Android layer, bundled to www/mobile/apex-native.js and loaded first in <head>.
 * In a plain browser it does nothing, so the same www/ folder still opens on a PC.
 * Browser tests set window.__APEX_NATIVE_FAKE__ = { ble, http, aiHttp, prefs, plugins } before this runs.
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { BleClient } from '@capacitor-community/bluetooth-le';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Preferences } from '@capacitor/preferences';
import { Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { installNativeBluetooth } from './native-ble.js';
import { NativeStrava, StravaDestination } from './native-strava.js';
import { PrefsSyncLedger, UploadQueue } from './native-outbox.js';
import { NativeAi } from './native-ai.js';
import { NativeIcu } from './native-icu.js';
import { bootNativeApp } from './native-app.js';

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
  // Outbound uploads. The rides, the FIT writer and the ride description belong to the page (js/), which
  // loads after this module, so they are looked up when an upload runs.
  const stravaOut = new StravaDestination({ strava, describe: (ride) => (window.app ? window.app.stravaDescription(ride) : '') });
  const uploads = new UploadQueue({
    ledger: new PrefsSyncLedger({ prefs }),
    destinations: [stravaOut],
    getRide: async (id) => {
      const ride = window.app && window.app.completedWorkouts.find((r) => r.id === id);
      if (ride && Array.isArray(ride.samples) && ride.samples.length) return ride;
      // The list may hold only the summary; the samples are in IndexedDB.
      const stored = window.VeloDB ? ((await window.VeloDB.getAllRides()) || []).find((r) => r.id === id) : null;
      return stored || ride || null;
    },
    buildFit: (ride) => window.VeloExport.buildFit(ride, ride.samples)
  });
  window.ApexNative = { bluetooth, strava, ai, icu, uploads, platform: fake ? 'test' : Capacitor.getPlatform() };
  bootNativeApp({ bluetooth, strava, ai, icu, uploads, plugins });
}
