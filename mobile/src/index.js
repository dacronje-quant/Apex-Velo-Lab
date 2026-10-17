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
import { NativeStrava } from './native-strava.js';
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
  window.ApexNative = { bluetooth, strava, ai, icu, platform: fake ? 'test' : Capacitor.getPlatform() };
  bootNativeApp({ bluetooth, strava, ai, icu, plugins });
}
