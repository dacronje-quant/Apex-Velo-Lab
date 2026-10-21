# Apex Velo for Android (proof of concept)

The Apex Velo Lab cockpit as an installable Android app (APK). It pairs your Bluetooth trainer and sensors from the phone, runs ERG workouts, keeps your rides on the phone and sends them to (and syncs them from) Strava. No PC or local server is needed.

It is the same web app as the desktop version, wrapped with [Capacitor](https://capacitorjs.com). The files in the repository root (`index.html`, `js/`, `css/`) are not changed; a small Android layer in `mobile/src/` fills in what a browser on the PC normally provides.

## What works

| | |
|---|---|
| **Trainer control** | Bluetooth FTMS smart trainers in ERG mode (Wahoo KICKR, Tacx, Elite, Zwift Hub, Saris...), with the same ERG logic, power-range limits and auto-reconnect as the desktop app |
| **Sensors** | Bluetooth power meters (Cycling Power Service, incl. calibration), heart-rate straps, KICKR HEADWIND |
| **Workouts** | The full workout library, the custom interval builder, saved workouts, ramp tests, Zen cockpit, audio cues and the offline coach (workouts and multi-week plans) |
| **Storage** | Rides, profiles and settings are saved in the app on the phone and survive restarts and app updates |
| **Strava** | Connect your account, send rides (FIT upload), check which rides are already there, and **Sync from Strava** |
| **Ride files** | Every ride recorded on the phone is also saved as a FIT file in **Documents/ApexVelo** (switch: Settings > Ride files), ready for any file manager, Garmin Connect, TrainingPeaks or intervals.icu. History > Export (FIT, TCX, CSV, full JSON backup) saves there too; the workout image opens the share sheet. FIT/TCX/CSV import works in History, and **History > Import history** takes many files or whole archives at once (.fit/.tcx/.gpx/.csv, .gz, .zip, a Garmin data export or Strava's "Download your data" zip), with a sport filter (all cycling incl. indoor/virtual by default), duplicate detection and a progress panel; rides from a Strava export are never uploaded back to Strava |
| **Health** | Resting HR, HRV and sleep read from **intervals.icu** (your watch's wellness data there), for the readiness score, the calendar recovery strip and the recovery trends. One-time backfill of all history, then the last week is refreshed automatically |
| **Analytics** | History, calendar, PMC (fitness/fatigue/form), power curve, CP, FTP history, and **Health**: every intervals.icu wellness value over time (resting and sleeping HR, HRV rMSSD and SDNN with your normal range, sleep stages, sleep and readiness scores, Baevsky stress index, breathing, SpO2, weight, blood pressure, glucose) and how your next-morning HRV, resting HR and sleep answer the previous day's training |
| **AI** | **Ask** (questions about your own training), the **AI coach** (sessions and multi-week plans) and ride **interval breakdowns**, with Claude, Gemini or ChatGPT and your own API key. Without a key the built-in offline coach is used |

## Not in this first version

These need the PC server or another device, so they are switched off in the app:

- **Phone remote view** (the app *is* the phone view now).
- **Apple Health via Health Auto Export** (it sends to the PC). The app reads the same data from intervals.icu instead.
- **PC backups** (Settings > Backups). Use **History > Export** for a full JSON backup instead.
- Fullscreen button and keyboard shortcuts.

Known limits:

- **Keep the app open and on screen while riding.** The screen stays on during a ride. If you switch apps or lock the phone, Android may pause the app, and recording and ERG then stop. Background recording would need an Android foreground service (a possible next step).
- ANT+ is not supported (Bluetooth only), the same as on the desktop.
- Rides live in the app's private storage. **Uninstalling the app deletes them** (the FIT files in Documents/ApexVelo stay). Export a JSON backup first to keep profiles, settings and Strava links too.

## Install the APK

1. Open the repository's **Actions** tab, choose the latest green **Android app** run, and download the `apex-velo-android-debug` artifact (a zip containing `app-debug.apk`).
2. Copy `app-debug.apk` to the phone and open it. Allow "install unknown apps" for your file manager or browser when Android asks.
3. Open **Apex Velo**, set up your rider (FTP, weight, max HR), then **Devices > Pair device**. Android asks once for **Nearby devices** permission (Android 12+) or Location (Android 11 and older, needed for Bluetooth scanning there).

Requirements: Android 7.0 (API 24) or newer with Bluetooth LE. Close Zwift, the Wahoo app and similar apps so they don't hold the trainer connection.

Newer CI builds install over older ones and keep your data: every build is signed with the same debug key (`android/app/apex-debug.keystore`) and CI numbers the versions.

## Connect Strava

The app uses your own free Strava API application, the same as the desktop setup:

1. At [strava.com/settings/api](https://www.strava.com/settings/api), create an application (or reuse your desktop one). **Authorization Callback Domain** must be `localhost`.
2. In the app: **Settings (gear) > Strava**, enter the **Client ID** and **Client Secret**, press **Save**, then **Connect Strava**.
3. Approve on the Strava page, keeping **Upload your activities** and **View data about your activities** ticked. You return to the app automatically (`apexvelo://localhost/strava`).

The secret and tokens are kept in the app's private Android storage (not in the web storage or in exports). Strava's API is called directly from the phone.

## Connect intervals.icu (health data)

The app reads your recovery data from intervals.icu, so it needs to be there already (from Garmin, Oura, Whoop, or an Apple Watch through HealthFit or a similar app).

1. On [intervals.icu/settings](https://intervals.icu/settings), open **Developer settings** and copy your **API key**.
2. In the app: **Settings (gear) > Health**, paste the key and press **Save and backfill**. The key is checked, then all your wellness history is read once (up to about two years, which is what the app keeps). Readiness and the calendar fill in straight away.
3. After that the last 7 days are refreshed when the app starts or comes back to the screen, at most once an hour. **Sync now** refreshes immediately; **Backfill all again** re-reads everything.

Analytics > Health shows every wellness value intervals.icu has for you: `avgSleepingHR`, `hrv`, `hrvSDNN`, `sleepScore`, `readiness`, `baevskySI`, `respiration`, `spO2`, `weight`, `systolic`/`diastolic`, `bloodGlucose` and `kcalConsumed`, as well as the values below. Cards for values you don't have stay hidden.

The readiness score uses resting HR (`restingHR`), HRV and sleep (`sleepSecs`, plus the stages from the custom numeric wellness fields `DeepSleep`, `LightSleep` and `REMSleep` in seconds, when your account has them; the iPhone wellness-sync apps write those codes). HRV is taken from one column for every day, so the baselines never mix two scales: **HRV used for readiness** in Settings > Health is Automatic (whichever most of your days have), overnight rMSSD (`hrv`) or Apple Watch SDNN (`hrvSDNN`). Changing it reads your history again. The app only reads; nothing is written to intervals.icu. The key is kept in the app's private Android storage, like the Strava and AI keys.

## Add an AI key

Ask, the AI coach and the interval breakdowns call the AI provider straight from the phone. No PC is involved.

1. Create an API key: Anthropic at [platform.claude.com/settings/keys](https://platform.claude.com/settings/keys), Google Gemini at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) or OpenAI at [platform.openai.com/api-keys](https://platform.openai.com/api-keys). One is enough.
2. In the app: **Settings (gear) > AI engine**, paste the key and press **Save keys**. The app reads that provider's model list, and the status line says **Ready**.
3. Pick the provider, model and reasoning effort in the same section. **Low** effort answers fastest and costs least. Keep the app open while a long answer is on its way.

Keys are kept in the app's private Android storage (Capacitor Preferences), not in the web storage or in exports, and each key is only sent to its own provider. Each question is billed to your API account. The prompts and requests are the same as the desktop server's (`mobile/src/native-ai.js`, checked against `server.js` by `tests/native-ai.test.mjs`).

Don't share an APK from a phone where you've saved keys, and don't build one with a key inside: the debug signing key is in this repository.

## Build it yourself

You need Node.js 22+, JDK 21 and the Android SDK (or Android Studio).

```bash
cd mobile
npm ci
npm run build          # assembles www/ from the desktop app + the Android layer
npx cap sync android   # copies www/ and the plugins into the Android project
cd android && ./gradlew assembleDebug
# -> android/app/build/outputs/apk/debug/app-debug.apk
```

Or open `mobile/android` in Android Studio after `npm run sync`, and run it on a connected phone. Chrome's `chrome://inspect` shows the app's console and DevTools.

Run `npm run build && npx cap sync android` again after changing anything in the root app or in `mobile/src/`. After changing `apex-velo-icon.png`, run `python3 scripts/make-icons.py` to regenerate the launcher icons and splash screens.

## Tests

```bash
npm test               # unit tests: Bluetooth shim, Strava client, AI engine vs server.js, intervals.icu wellness (Node, no browser)
npm run test:browser   # the built app in Chromium with a simulated FTMS trainer, HR strap, Strava, Claude and intervals.icu
```

The browser test pairs the trainer through the in-app chooser and rides an ERG workout. It checks the trainer gets its targets, drops and reconnects the link, saves the ride, signs in to Strava, uploads the FIT file, syncs, saves an AI key, asks a question in Ask, gets an AI interval breakdown, backfills health data from intervals.icu and reloads the app. The **Android app** GitHub workflow runs both, then builds the APK.

## How it works

| File | Role |
|---|---|
| `src/native-ble.js` | `navigator.bluetooth` (Web Bluetooth) on top of the native BLE plugin, including an in-app device chooser. `js/velo-ble.js` runs unchanged |
| `src/native-strava.js` | The desktop server's `/api/strava/*` routes, answered on the phone with native HTTP and the mobile OAuth flow |
| `src/native-icu.js` | Reads intervals.icu wellness (resting HR, HRV, sleep) and turns it into the day records `js/velo-health.js` uses |
| `src/native-app.js` | Answers `/api/` calls on the phone, switches storage to the phone, adds Settings > Strava, keeps the screen on, shares exports, handles the back button, hides PC-only features |
| `src/index.js` | Entry point. Does nothing in a normal browser |
| `scripts/build-web.cjs` | Copies the desktop app into `www/` and adds the two tags that load the layer |
| `android/` | The Capacitor Android project (permissions, `apexvelo://` link, icons, signing) |
