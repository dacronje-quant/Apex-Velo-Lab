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
| **Ride files** | Every ride recorded on the phone is also saved as a FIT file in **Documents/ApexVelo** (switch: Settings > Ride files), ready for any file manager, Garmin Connect, TrainingPeaks or intervals.icu. History > Export (FIT, TCX, CSV, full JSON backup) saves there too; the workout image opens the share sheet. FIT/TCX/CSV import works in History |
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

Newer CI builds install over older ones and keep your data: every build is signed with the same debug key (`android/app/apex-debug.keystore`) and CI numbers the versions. The test APK shows up as **Apex Velo (dev)** (app id `com.apexvelo.lab.debug`) and installs next to the release/Play app (`com.apexvelo.lab`). With both installed, Android asks which app should finish a Strava sign-in; pick the one you signed in from.

**Moving from the test APK to the release/Play app** (or from a test APK built before the app was renamed "Apex Velo (dev)"): export first (**History > Export**, full JSON backup), then import it in the new app. The two are signed with different keys, so Android can't update one over the other, and each keeps its own data. Strava, intervals.icu and AI keys are not in the export; enter them again.

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

## Release builds

The committed `android/app/apex-debug.keystore` (password `android`) is for development only: it is public, so anyone could sign an "update" with it. Store releases are signed with a private release key that never goes into the repository.

**Versions.** `versionName` is the `version` in `mobile/package.json`; `versionCode` is 1000 + the GitHub Actions run number (1000 for local builds), so each CI build installs over the last one and Play accepts every upload, and a re-created workflow (run numbers back at 1) can't drop below codes already on Play. Debug builds show as e.g. `0.1.0-debug.42`. Bump `version` in `package.json` for a new release.

**Create the release keystore** (once, and keep a backup: Play will only accept updates signed by the same key, unless you use Play App Signing, which is recommended):

```bash
keytool -genkeypair -v -keystore apex-release.keystore -alias apexvelo \
  -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 apex-release.keystore > apex-release.keystore.b64   # macOS: base64 -i apex-release.keystore
```

**Add the GitHub secrets** (repository Settings > Secrets and variables > Actions > New repository secret):

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | the contents of `apex-release.keystore.b64` |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | `apexvelo` (the `-alias` above) |
| `ANDROID_KEY_PASSWORD` | the key password (same as the keystore password unless you chose another) |

Delete the `.b64` file afterwards. With all four set, every push and manual run of the **Android app** workflow also uploads `apex-velo-android-release` (signed `app-release.aab` for Play, `app-release.apk` for sideloading, and the R8 `mapping.txt` for crash reports). Pull requests and forks have no access to the key: they build the debug APK and an unsigned release build (to check minification) only.

**Sign locally** by setting the same values as environment variables, or as Gradle properties in `~/.gradle/gradle.properties` (never in the repository), with `ANDROID_KEYSTORE_FILE` pointing at the keystore file:

```bash
ANDROID_KEYSTORE_FILE=/path/to/apex-release.keystore ANDROID_KEYSTORE_PASSWORD=... \
ANDROID_KEY_ALIAS=apexvelo ANDROID_KEY_PASSWORD=... ./gradlew bundleRelease assembleRelease
```

Without them, `bundleRelease`/`assembleRelease` still work but leave the output unsigned.

**Release build settings.** R8 minification and resource shrinking are on for release (`android/app/proguard-rules.pro` keeps the Capacitor bridge, plugins and Cordova classes, which are found by name at run time). The app targets API 36.

**Backups.** Android Auto Backup is on, but leaves out the Capacitor Preferences file with Strava sign-ins and API keys (`res/xml/backup_rules.xml`, `res/xml/data_extraction_rules.xml`); after a restore the rider signs in again. Don't rely on it for rides: cloud backup is best-effort and capped at 25 MB per app, and past that Android silently skips it. Moving to a new phone with a cable or device-to-device transfer carries rides, profiles and settings reliably. To keep a copy of your own, use **History > Export** (full JSON backup, saved to **Documents/ApexVelo**).

**Owner checklist for a Play release**

1. Add the four secrets above, push, and download `apex-velo-android-release` from the run.
2. Before the first Play upload, smoke-test `app-release.apk` on a phone: Bluetooth scan and pairing, saving an API key, an export to Documents/ApexVelo, and the share sheet. These are the paths R8 could break.
3. Upload `app-release.aab` to Play Console, and with each AAB also upload that run's `mapping.txt` (App bundle explorer > the version > Downloads > ReTrace mapping file), so crash reports are readable.
4. Bump `version` in `mobile/package.json` for each release. `versionCode` is 1000 + the workflow run number, so it always grows; if the workflow is ever re-created, raise the 1000 offset in `android/app/build.gradle` above the last code on Play.

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
