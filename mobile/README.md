# Apex Velo for Android (proof of concept)

The Apex Velo Lab cockpit as an installable Android app (APK). It pairs your Bluetooth trainer and sensors from the phone, runs ERG workouts, keeps your rides on the phone and sends them to Strava (upload only). No PC or local server is needed.

It is the same web app as the desktop version, wrapped with [Capacitor](https://capacitorjs.com). The files in the repository root (`index.html`, `js/`, `css/`) are not changed; a small Android layer in `mobile/src/` fills in what a browser on the PC normally provides.

## What works

| | |
|---|---|
| **Trainer control** | Bluetooth FTMS smart trainers in ERG mode (Wahoo KICKR, Tacx, Elite, Zwift Hub, Saris...), with the same ERG logic, power-range limits and auto-reconnect as the desktop app |
| **Sensors** | Bluetooth power meters (Cycling Power Service, incl. calibration), heart-rate straps, KICKR HEADWIND |
| **Workouts** | The full workout library, the custom interval builder, saved workouts, ramp tests, Zen cockpit, audio cues and the offline coach (workouts and multi-week plans) |
| **Storage** | Rides, profiles and settings are saved in a SQLite database in the app on the phone (ride samples compressed), as the desktop app saves them on the PC, and survive restarts and app updates. The first start after updating from a version that kept them in the app's web storage moves them in a ride at a time ("Moving your rides into the phone database", with progress), checks each one and keeps a snapshot of the earlier data; if that start is interrupted nothing is half-moved and the next start goes on where it stopped. Recovery snapshots are kept in the app's private storage (not in Android cloud backup). The app starts with each ride's summary rather than its per-second samples, so a long history starts quickly: a ride's samples load when you open it, export it or send it, and the power curve, FTP history and other analytics read the summaries (`js/velo-ride-summary.js`, made when a ride is saved; rides saved before get theirs in the background after the first start). Settings > About lists the open-source licences |
| **Strava** | Connect your account and send rides (FIT upload): per ride, or automatically when a ride finishes. Upload only: the app never reads your Strava activities |
| **Ride files** | Every ride recorded on the phone is also saved as a FIT file in **Documents/ApexVelo** (switch: Settings > Ride files), ready for any file manager, Garmin Connect, TrainingPeaks or intervals.icu. History > Export (FIT, TCX, CSV, full JSON backup) saves there too; the workout image opens the share sheet. FIT/TCX/CSV import works in History, and **History > Import history** takes many files or whole archives at once (.fit/.tcx/.gpx/.csv, .gz, .zip, a Garmin data export or Strava's "Download your data" zip), with a sport filter (all cycling incl. indoor/virtual by default), duplicate detection and a progress panel; rides from a Strava export are never uploaded back to Strava |
| **Import folder and sharing** | Pick a folder in **Settings > Import** (a Dropbox or Drive folder, or where a Garmin, Wahoo or Karoo export lands) and new ride files there are imported when the app opens, when it comes back to the screen and once a day; or share .fit/.tcx/.gpx/.zip/.gz files to Apex Velo from Garmin Connect, Wahoo, Files or email. See [Import rides automatically](#import-rides-automatically) |
| **Health** | Resting HR, HRV and sleep read from **Health Connect** (Samsung Health, Fitbit, Google Fit, Garmin, Oura...) and/or **intervals.icu**, for the readiness score, the calendar recovery strip and the recovery trends. When both have a day, Settings > Health picks which comes first per value (Health Connect by default). One-time backfill of two years, then only changes |
| **Health Connect rides** | Cycling sessions other apps write to Health Connect (Zwift, Samsung Health, Garmin...) join your history with their power, heart rate, cadence, speed and distance; duplicates of rides you already have are skipped (the copy with power is kept). Rides recorded in Apex Velo can be saved to Health Connect |
| **Analytics** | History, calendar, PMC (fitness/fatigue/form), power curve, CP, FTP history, and **Health**: every intervals.icu wellness value over time (resting and sleeping HR, HRV rMSSD and SDNN with your normal range, sleep stages, sleep and readiness scores, Baevsky stress index, breathing, SpO2, weight, blood pressure, glucose) and how your next-morning HRV, resting HR and sleep answer the previous day's training |
| **History tab** | Rides grouped by month (title, date, duration, NP, TSS, a tick when on Strava), with search (title, notes, source) and filters (rides, other activities, with power, not on Strava). Tap a ride for its page: the full ride summary (Strava send and status, AI breakdown, power analysis, zones, intervals, previous/next) with its samples loaded on demand, and ⋯ for Edit title and notes, Export FIT/TCX/CSV and Delete. **+** opens Add rides (files, Import history with its progress, Watch a folder). The ⋯ next to the ride count has Check Strava, the full JSON backup, current-session exports, training-load options (opens You › Your data) and Clear all history (`src/native-history.js`) |
| **AI** | **Ask** (questions about your own training), the **AI coach** (sessions and multi-week plans) and ride **interval breakdowns**, with Claude, Gemini or ChatGPT and your own API key. Without a key the built-in offline coach is used |

## Not in this first version

These need the PC server or another device, so they are switched off in the app:

- **Phone remote view** (the app *is* the phone view now).
- **Apple Health via Health Auto Export** (it sends to the PC). The app reads the same data from Health Connect or intervals.icu instead.
- **PC backups** (Settings > Backups). Use **History > Export** for a full JSON backup instead.
- Fullscreen button and keyboard shortcuts.

Known limits:

- **Screen off works, but the cockpit is only live on screen.** See [Riding with the screen off](#riding-with-the-screen-off): in the background the app records and keeps ERG on the planned step targets, without the cockpit's soft start, anti-stall and new PowerMatch corrections.
- ANT+ is not supported (Bluetooth only), the same as on the desktop.
- Rides live in the app's private storage. **Uninstalling the app deletes them** (the FIT files in Documents/ApexVelo stay). Export a JSON backup first to keep profiles, settings and Strava links too.

## Riding with the screen off

The screen stays on while you ride, but you can lock the phone or switch apps: recording and ERG go on. From **Start** until the ride is saved or discarded, a notification shows the elapsed time, power, heart rate, the current interval and its target, with **Pause** / **Resume**. Tapping it opens the app. Android 13+ asks once for permission to show notifications (the ride records without it, the notification is just hidden).

How it works: while the app is on screen, the cockpit runs the ride exactly as on the PC. When Android pauses the app (screen off, another app in front), a native recorder in a foreground service takes over: 3 seconds after the app went to the background, or after 10 seconds without a cockpit second while it is on screen (so a slow phone is not handed over for nothing). It listens to the same trainer, power meter and heart-rate strap (its own Bluetooth clients on the existing connections, no new pairing), records one sample per second and sets each interval's ERG target on time, keeping your PowerMatch trim. When you come back, the cockpit takes the ride back and merges those seconds in: nothing is lost or counted twice, and a pause, the end of the workout or the end of a ramp test that happened meanwhile is applied. A toast says how many seconds were recorded with the screen off. In the background ERG holds the planned targets; soft start, anti-stall and new PowerMatch corrections resume when the app is on screen again.

If Android reloads the app's page mid-ride while the app keeps running (the activity is recreated, or the WebView restarts), the reopened app picks the running ride up where the recorder is, reconnects your devices and carries on.

**If the app is killed** (crash, low memory), the ride is not lost: every second is written to a file in the app's private storage as it is recorded. At the next start **Recover unfinished ride** offers it, paused; resume or finish and save as usual.

**Battery settings.** At the first ride, the app explains once that some phones still stop background apps to save battery, and offers **Open battery settings** (the system list where you can set Apex Velo to *Unrestricted* / *Don't optimise*). The app never asks for the exemption directly. Samsung, Xiaomi and some others may need this for long rides.

**Play Console: foreground service declaration** (App content > Foreground service permissions; owner task). Select **Connected device** and use:

> Apex Velo records indoor cycling workouts from Bluetooth LE fitness devices the user has paired in the app (smart trainers, power meters, heart-rate straps) and controls the smart trainer's resistance (ERG mode). When the user starts a workout, the app starts a foreground service of type connectedDevice that keeps the Bluetooth connections, records one sample per second and sends the planned power target to the trainer at each interval, so the ride continues with the screen off or another app in front. The service shows an ongoing notification with the elapsed time, power, heart rate and current interval, with Pause/Resume, and stops when the user saves or discards the workout. Stopping it would end the recording and the trainer control in the middle of the user's workout. It does not run outside a workout the user started.

Video for the declaration: start a workout with a paired trainer, lock the phone, show the notification updating and Pause/Resume working, unlock and show the ride continuing, then save it (the notification goes away).

## Install the APK

1. Open the repository's **Actions** tab, choose the latest green **Android app** run, and download the `apex-velo-android-debug` artifact (a zip containing `app-debug.apk`).
2. Copy `app-debug.apk` to the phone and open it. Allow "install unknown apps" for your file manager or browser when Android asks.
3. Open **Apex Velo**, set up your rider (FTP, weight, max HR), then **Devices > Pair device**. Android asks once for **Nearby devices** permission (Android 12+) or Location (Android 11 and older, needed for Bluetooth scanning there).

Requirements: Android 7.0 (API 24) or newer with Bluetooth LE. Health Connect needs Android 9 or newer. Close Zwift, the Wahoo app and similar apps so they don't hold the trainer connection.

Newer CI builds install over older ones and keep your data: every build is signed with the same debug key (`android/app/apex-debug.keystore`) and CI numbers the versions. The test APK shows up as **Apex Velo (dev)** (app id `com.apexvelo.lab.debug`) and installs next to the release/Play app (`com.apexvelo.lab`). With both installed, Android asks which app should finish a Strava sign-in; pick the one you signed in from.

**Moving from the test APK to the release/Play app** (or from a test APK built before the app was renamed "Apex Velo (dev)"): export first (**History > Export**, full JSON backup), then import it in the new app. The two are signed with different keys, so Android can't update one over the other, and each keeps its own data. Strava, intervals.icu and AI keys are not in the export; enter them again.

## Import rides automatically

**Watched folder.** In **Settings (gear) > Import**, press **Choose folder** and pick the folder your ride files arrive in: a Dropbox or Google Drive folder synced to the phone, the folder you unzipped a Garmin or Strava export into, or where the Wahoo or Karoo app saves its files. Android asks you to allow access to that one folder; the app reads nothing else. Every .fit, .tcx, .gpx, .zip and .gz file in it and its subfolders (and a Strava export's activities.csv, for the ride names) is imported, with the sport filter and duplicate detection of **History > Import history**.

After that the folder is checked when the app opens and when it comes back to the screen. A daily background check (Android decides the exact time, when the battery is not low) starts the import when the app is running; when it is not, it says how many new rides are waiting (with notifications allowed; Android 13+ asks when you pick the folder) and opening the app imports them. A file is read once: it is remembered by its name, size and change time, so a file saved again with new content is read again and nothing else is. Settings > Import shows the folder, the last check and how many files were imported; **Scan now** checks at once and **Remove** stops watching (rides already imported stay).

**Share to Apex Velo.** In Garmin Connect, the Wahoo app, Files, Drive or an email, share one or more .fit, .tcx, .gpx, .zip or .gz files and pick **Apex Velo**. They are copied into the app first, so an import Android stops half-way goes on the next time the app opens; a file that stops the import twice is skipped and named.

Big exports are read from storage a piece at a time, never loaded whole: the same limits as Import history apply (64 MB per ride file, 20 GB unpacked per archive, archives at most 4 levels deep). Each import is listed in the phone database (import_jobs), and rides keep their origin, so a ride that came from a Strava export is never uploaded back to Strava.

## Connect Strava

**One tap (builds with a token broker).** In **Settings (gear) > Strava**, press **Connect Strava** and approve on the Strava page, keeping **Upload your activities** ticked (the app asks for nothing else). You return to the app automatically (`apexvelo://localhost/strava`). No API application or secret is needed: the Apex Velo token broker ([`broker/`](../broker/README.md), a small stateless Cloudflare Worker) holds the client secret and turns the sign-in code into tokens. Only the code and, later, the refresh token pass through it; it stores nothing.

**Your own Strava API application** (builds without a broker, or **Settings > Strava > Advanced > Use my own Strava API app**), the same as the desktop setup:

1. At [strava.com/settings/api](https://www.strava.com/settings/api), create an application (or reuse your desktop one). **Authorization Callback Domain** must be `localhost`.
2. In the app: **Settings (gear) > Strava**, enter the **Client ID** and **Client Secret**, press **Save**, then **Connect Strava**.
3. Approve on the Strava page as above.

Switching between the two signs you out of Strava (a sign-in belongs to one API application); connect again afterwards. Your own application's credentials are kept for when you switch back. Riders already connected with their own application stay on it when an update adds the broker.

Tokens (and your own secret, if you use one) are kept in the app's private Android storage (not in the web storage or in exports). Uploads go from the phone straight to Strava's API; only sign-in and token refresh use the broker. If the broker is down or busy, uploads wait in the queue and you stay signed in; only Strava itself refusing the sign-in signs you out.

**Sending rides.** Open a ride and press **Send to Strava**, or switch on **Auto-upload new rides to Strava** in Settings > Strava to send each ride recorded on the phone when it finishes. Without a connection the ride waits in a queue and is retried when the app opens or comes back to the screen, with growing gaps (1 min, 5 min, 15 min, 1 h, then every 6 h; it gives up after 8 tries, and **Send now** on the ride tries again). Settings > Strava shows how many rides are waiting.

**Upload only.** The phone never lists or reads Strava activities, so there is no **Sync from Strava** or **Check Strava** in the app (the desktop keeps both). A ride counts as on Strava when this phone uploaded it: the activity id Strava returned is kept in the app's sync record (and a ride Strava already has is linked to the existing activity). Rides that came from Strava are never sent back. To bring your history in, use your own export files (Strava "Download your data", Garmin, Wahoo, intervals.icu).

## Connect intervals.icu (health data)

The app reads your recovery data from intervals.icu, so it needs to be there already (from Garmin, Oura, Whoop, or an Apple Watch through HealthFit or a similar app).

1. On [intervals.icu/settings](https://intervals.icu/settings), open **Developer settings** and copy your **API key**.
2. In the app: **Settings (gear) > Health**, paste the key and press **Save and backfill**. The key is checked, then all your wellness history is read once (up to about two years, which is what the app keeps). Readiness and the calendar fill in straight away.
3. After that the last 7 days are refreshed when the app starts or comes back to the screen, at most once an hour. **Sync now** refreshes immediately; **Backfill all again** re-reads everything.

Analytics > Health shows every wellness value intervals.icu has for you: `avgSleepingHR`, `hrv`, `hrvSDNN`, `sleepScore`, `readiness`, `baevskySI`, `respiration`, `spO2`, `weight`, `systolic`/`diastolic`, `bloodGlucose` and `kcalConsumed`, as well as the values below. Cards for values you don't have stay hidden.

The readiness score uses resting HR (`restingHR`), HRV and sleep (`sleepSecs`, plus the stages from the custom numeric wellness fields `DeepSleep`, `LightSleep` and `REMSleep` in seconds, when your account has them; the iPhone wellness-sync apps write those codes). HRV is taken from one column for every day, so the baselines never mix two scales: **HRV used for readiness** in Settings > Health is Automatic (whichever most of your days have), overnight rMSSD (`hrv`) or Apple Watch SDNN (`hrvSDNN`). Changing it reads your history again. The app only reads; nothing is written to intervals.icu. The key is kept in the app's private Android storage, like the Strava and AI keys.

## Connect Health Connect

Health Connect is Android's shared store for health data: built into Android 14 and newer, an app from Google Play on Android 9 to 13. Apex Velo reads recovery data and rides from the apps that write there, and can save your rides to it.

1. **Settings (gear) > Health**, under **Health Connect**. On Android 9-13 without it, press **Get Health Connect** (opens Play), then come back.
2. Press **Allow** next to what you want; each data type is listed with what it is used for, and Health Connect lets you switch each one on or off:
   - **Recovery data**: HRV (rMSSD), resting heart rate, sleep with its stages, weight, blood oxygen and breathing rate. Readiness, the calendar strip and Analytics > Health use them.
   - **Rides from other apps**: exercise sessions, plus heart rate, power, speed, cadence and distance during cycling sessions. Only cycling (outdoor and indoor) is imported; heart rate outside rides is never read.
   - **Save rides recorded here**: writes each ride recorded in Apex Velo as a session (stationary biking for trainer rides) with heart rate, power, cadence, speed, distance and calories. **Save each ride I record here** then sends new rides when they finish, through the same retry queue as Strava. Imported rides and rides that came from Health Connect are never written.
3. The first sync reads the last two years (Health Connect asks for "past data" access for that), 30 days at a time; if the app is closed half-way it goes on where it stopped. After that only what changed is read, when the app opens and when you come back to it. There is no background job: if the app is not opened for about 30 days, Health Connect forgets the change position and the next start reads the two years again.

**Both sources.** With intervals.icu set up too, each day keeps both copies (the phone database's `wellness_days` table, sources `icu` and `healthconnect`). **When intervals.icu and Health Connect both have a day** sets, for resting HR, HRV, sleep, weight, blood oxygen and breathing rate, which source comes first; the other fills days the first has nothing for. HRV is never mixed: Health Connect has overnight rMSSD, so if intervals.icu has Apple Watch SDNN, one kind is used for all days.

**Duplicates.** A Health Connect ride is the same ride as one in your history when it starts within 60 s and lasts within 5 % of it (docs/ANDROID-CONTRACTS.md). The copy with power wins, then the one with more channels, then the longer one; the stored ride keeps its id, name and Strava link. A ride you recorded in Apex Velo is never replaced. Deleting a session in its own app removes its ride here at the next sync only when Health Connect was its only source; a ride that replaced a file copy, whose FIT file was also imported (and dropped as a duplicate), or that is linked to Strava stays, as the file or recorded ride it was.

**Disconnect** removes all of Apex Velo's Health Connect permissions; days and rides already read stay. **Manage in Health Connect** opens Health Connect's page for the app.

## Health Connect on Google Play (owner)

Play reviews every app that asks for health permissions. Before the first release with Health Connect:

1. **Health apps declaration** (Play Console > App content > Health apps): declare the app as a fitness / training app that reads and writes Health Connect data.
2. **Health Connect permissions declaration** (Play Console > App content > Health Connect): list each permission in `android/app/src/main/AndroidManifest.xml` and why it is needed. Suggested wording, one line each:
   - `READ_HEART_RATE_VARIABILITY`, `READ_RESTING_HEART_RATE`, `READ_SLEEP`: daily readiness score, calendar recovery strip and recovery trends.
   - `READ_WEIGHT`, `READ_OXYGEN_SATURATION`, `READ_RESPIRATORY_RATE`: trends in Analytics > Health.
   - `READ_EXERCISE`, `READ_HEART_RATE`, `READ_POWER`, `READ_SPEED`, `READ_DISTANCE`: import cycling rides recorded by other apps into the training history (training load, power curve, FTP). Cadence is covered by `READ_EXERCISE`.
   - `WRITE_EXERCISE`, `WRITE_HEART_RATE`, `WRITE_POWER`, `WRITE_SPEED`, `WRITE_DISTANCE`, `WRITE_TOTAL_CALORIES_BURNED`: save rides recorded in the app to Health Connect, when the rider switches it on.
   - `READ_HEALTH_DATA_HISTORY`: the one-time two-year backfill of the above (data older than 30 days).
   Background reading (`READ_HEALTH_DATA_IN_BACKGROUND`) is not requested: the app reads only while it is open.
   Attach a short screen recording of Settings > Health (allowing each group) and of a ride appearing in History, if Play asks for one.
3. **Privacy policy**: host `mobile/PRIVACY.md` (or your own policy that covers the same) at a public URL, enter it in Play Console > App content > Privacy policy, and put the same URL in `privacy_policy_url` in `android/app/src/main/res/values/strings.xml`. That URL is linked from the screen Health Connect opens when the rider taps the privacy policy link (`HealthRationaleActivity`, registered for `androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE` on Android 13 and older and `VIEW_PERMISSION_USAGE` / `HEALTH_PERMISSIONS` on Android 14+).
4. **Data safety form**: health and fitness data collected (read) and shared with no one; processed on the device only; not transferred off the device by the app; the rider can request deletion by uninstalling or disconnecting. Rides the rider chooses to upload to Strava or intervals.icu are sent at the rider's request (declare "Fitness info" as shared with the rider's consent if Play counts that).
5. Only the permissions above are declared; adding a type later means updating the manifest, this list and the declaration together.

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

**Strava sign-in.** Set the token broker URL (see [broker/README.md](../broker/README.md)) for one-tap Strava sign-in, either in `mobile/app-config.json` (`"brokerUrl": "https://..."`) or as `APEX_BROKER_URL=https://... npm run build`; the environment variable wins. https only. Without one, the app uses the rider's own Strava API application. CI reads the repository variable `APEX_BROKER_URL` (Settings > Secrets and variables > Actions > Variables); it is a public URL, not a secret.

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

## Phone layout

The app has five tabs at the bottom: **Ride**, **Train**, **History**, **Progress** and **You** (docs/ANDROID-UX.md).
Android back closes a sheet, then goes back a page, then to the tab's first screen, then to Ride, then leaves the app.

- **Ride** opens on **Today**: your readiness, today's planned or loaded workout with **Start ride**, *Change workout*
  and *Free ride*, your last ride and this week. The devices chip at the top opens the devices sheet: each device,
  its state and Connect. Tap a device for its details (calibration, PowerMatch, power and cadence source, fan).
- **The ride screen** is full screen. It shows power against target, the step countdown (it pulses before a step
  change), the next step, your tiles, and **End**, **Pause** and **Skip**. End asks before it saves, and so does
  back. ⚙ opens **Controls** (intensity, ERG, shorten or extend the step, Stand, smoothing, ERG response, audio,
  devices, simulator, rider) and **Show all metrics** (the full cockpit: live graph, L/R, W′ balance, time in zone,
  the interval queue).
- **Customise this screen** (in Controls) switches every panel, tile and graph line on or off and moves them up or
  down, in both views. It is saved for each rider. *Minimal*, *Standard* and *Everything* are presets, and *Reset*
  goes back to Standard.
- Train, History, Progress and You show the existing screens until their phone versions land.

## Tests

```bash
npm test               # unit tests: ride handoff, merging and recovery (screen off), Bluetooth shim, Strava upload client and token exchangers (own application, broker, switching), upload queue and ledger, AI engine vs server.js, intervals.icu wellness (Node, no browser)
npm run test:browser   # the built app in Chromium with a simulated FTMS trainer, HR strap, Strava, Claude and intervals.icu
npm run test:phone     # phone layout at 393x852 with touch: tabs, back, deep links, taps to reach, no sideways scroll, 44 px targets, ride parity, customisation; History (U3)
```

The browser test pairs the trainer through the in-app chooser and rides an ERG workout. It checks the trainer gets its targets, drops and reconnects the link, saves the ride, signs in to Strava, uploads the FIT file and records it in the ledger, checks that no Strava activity is ever read, signs in through a token broker in a second app (no secret on the phone, own application under Advanced), queues an auto-upload while offline and sends it on resume, saves an AI key, asks a question in Ask, gets an AI interval breakdown, backfills health data from intervals.icu and reloads the app. The **Android app** GitHub workflow runs both, then builds the APK. For riding with the screen off it halts the page mid-ride while a fake native recorder in the test runner keeps recording and moves ERG to the next step, checks every second is merged back once on resume, then reloads the page mid-ride (the live ride is taken back), then kills the app in the background and recovers the ride from the journal. `cd android && ./gradlew testDebugUnitTest` runs the JVM tests of the native recorder (parsers, takeover, ramp test, journal).

## How it works

| File | Role |
|---|---|
| `src/native-ble.js` | `navigator.bluetooth` (Web Bluetooth) on top of the native BLE plugin, including an in-app device chooser. `js/velo-ble.js` runs unchanged |
| `src/native-strava.js` | The upload subset of the desktop server's `/api/strava/*` routes, answered on the phone with native HTTP and the mobile OAuth flow; the `TokenExchanger` for sign-in (`ByoExchanger`: your own client id and secret; `BrokerExchanger`: the token broker, no secret on the phone; the broker is the default when the build has one, `src/app-config.js`); `StravaDestination` for the upload queue |
| `src/native-outbox.js` | The sync ledger (one row per ride and destination, kept under `apex_sync_` keys until the SQLite `sync_ledger` table exists) and the offline upload queue with backoff |
| `src/native-ride.js` | Riding with the screen off: hands each ride second to the native recorder (`ApexRide` plugin, `android/.../ride/`: `RideRecorder` takeover logic, `BleTap` GATT clients on the page's devices, `RideJournal` crash-safe file, `RideService` foreground service and notification), takes the native seconds back on resume (`mergeSamples`, `adoptSnapshot`) and feeds an unfinished journal to **Recover unfinished ride** |
| `src/native-icu.js` | Reads intervals.icu wellness (resting HR, HRV, sleep) and turns it into the day records `js/velo-health.js` uses |
| `src/native-store.js` | The desktop SQLite store (`scripts/sqlite-store.cjs`) on an async driver: answers `/api/storage/*` with the same shapes, so `js/velo-storage.js` runs unchanged. `GET /api/storage` answers the rides without samples and with their `sampleSummary`; `src/native-app.js` loads one ride's samples when a view needs them. Also the `import_jobs`, `import_files`, `sync_ledger` and `wellness_days` tables with a small API (`await ApexNative.store`, then `putImportJob`, `putImportFiles`, `findImportFileByHash`, `putSyncEntry`, `listSyncEntries`, `putWellnessDays`, `listWellnessDays`, ...), and `SqliteSyncLedger`, the upload queue's ledger with the same methods as `PrefsSyncLedger` (`src/native-outbox.js`) plus a one-time move of its Preferences rows |
| `src/native-migrate.js` | Moves the earlier WebView data (IndexedDB + localStorage) into the store on the first start, a ride at a time, resumable |
| `src/native-snapshot.js` | Streaming SHA-256, gzip file writer and check for the store's snapshots |
| `src/native-licences.js` | Settings > About: open-source licences |
| `src/native-sqlite.js` | The store's driver over `@capacitor-community/sqlite`, and its snapshot folder through `@capacitor/filesystem` |
| `src/native-app.js` | Answers `/api/` calls on the phone (saved data from `native-store.js`), adds Settings > Strava (with auto-upload), hides Sync from Strava, keeps the screen on, shares exports, handles the back button, hides PC-only features |
| `src/index.js` | Entry point. Does nothing in a normal browser |
| `scripts/build-web.cjs` | Copies the desktop app into `www/` and adds the two tags that load the layer |
| `android/` | The Capacitor Android project (permissions, `apexvelo://` link, icons, signing) |
