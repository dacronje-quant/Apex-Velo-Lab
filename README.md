# APEX VELO LAB v3

> Indoor cycling cockpit, AI workout builder and training-analytics dashboard in one HTML app, served by a small local server that also holds your Claude and/or Gemini API key.
> Built for Divan (185 W FTP baseline, 75 kg, 175 max HR) with Favero Assioma DUO-Shi pedals and a Wahoo KICKR SHIFT.

## Quick start

1. Double-click **`Launch-Apex-Velo.bat`**. It needs no installs; it runs `start_server.ps1` with Windows PowerShell.
2. On the first run it creates `.env` and opens it in Notepad. Paste your Anthropic API key after `ANTHROPIC_API_KEY=` and/or your Google Gemini key after `GEMINI_API_KEY=`, save, and close Notepad. Chrome then opens at `http://localhost:8080`. Web Bluetooth needs localhost or HTTPS, so use Chrome or Edge.
3. Open **Devices** in the header. Choose a device type under **Add or replace a device**, then **Pair device**. After pairing once, use **Connect saved devices** before a ride.
4. To run the test suite, open `http://localhost:8080/test_suite.html`. It should end with `COMPLETED`; the only check expected to fail is *Banister PMC*, which compares against fixed values from your HealthFit archive and drifts as days pass (see *Tests*). The tests run the app in an isolated test mode (in-memory settings and a separate test database), so they never touch your recorded rides.

Keep the port at 8080. The browser stores your rides and settings per address, so a different port starts with an empty history.

**No internet needed to ride.** Chart.js and the Inter / JetBrains Mono fonts are served from the app folder (`vendor/`, `css/fonts.css`), so the cockpit, charts and phone view work with no connection. Only the AI coach (Claude / Gemini) and Strava need the internet; without it the coach uses its offline engine.

### Updating

Your app folder is a Git checkout of `main`. To get the latest version:

```
cd C:\Users\dacro\Documents\Apex-Velo-Lab
git -c core.autocrlf=true pull origin main
```

Then restart `Launch-Apex-Velo.bat` (the server only reads its code at start) and press **Ctrl+F5** in Chrome. Your `.env`, `.strava-tokens.json` and `data/` ride history are not in Git, so an update never touches them.

## AI Coach engine and your API key

- The local server serves the app and forwards coach requests from `/api/coach` to the Claude API or the Gemini API. It reads the keys from `.env`, or from `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` environment variables, which take priority. Keys never reach the browser, are never written to `localStorage`, and `.env` is never served.
- `.env` is listed in `.gitignore`. If you prefer not to keep the key in a file, set it as a Windows user environment variable (`setx ANTHROPIC_API_KEY "sk-ant-..."`, then open a new window) and leave the `.env` line empty.
- **Choose Claude or Gemini** in **Coach > AI engine** (provider, model, effort; saved per browser), or set the default for every browser in `.env` (`APEX_COACH_PROVIDER`, `APEX_COACH_MODEL`, `APEX_GEMINI_MODEL`, `APEX_COACH_EFFORT`). The Claude default is **Opus 5.5 at low effort** with adaptive thinking; Sonnet 5 costs about half as much and Haiku 4.5 is the fastest. The Gemini default is **Gemini 3.8 Flash**; 3.1 Pro (preview) and 3.1 Flash-Lite are also offered, and effort sets Gemini's thinking level. Both show a summarised reasoning trace.
- **Time available: Auto** lets the coach choose the most effective session length (30-150 min) from the session type, your goal, form and usual ride length; the offline engine and Claude/Gemini both explain the choice.
- **History look-back** (Coach > Session request: 7, 14, 28, 42 or 90 days) sets how far back the coach reviews rides, volume and intensity mix. Each ride in the window is listed (the 30 most recent at most), so the prompt stays small. Fitness, fatigue and form (CTL/ATL/TSB) are always computed on your PC from your full history.
- **Plain-language coaching.** New AI session advice, block summaries and ride reviews explain what to do and why in everyday words, using numbers mainly for actionable durations or targets. The offline coach uses the same approach. Existing saved AI answers are kept; ask again to get a new explanation. Open **Coach > Training terms explained**, or **Settings > Training guide**, to review proposed simple names alongside the acronyms.
- **AI chooses weekly ride time.** In Coach > Training block, leave **Hours per week** blank to let the connected AI choose weekly allowances from recent riding and recovery. The app bounds the choice using the recent four-week average, recent-week volume, recovery signals and selected days, limits increases between build-week allowances, and shortens recovery/test weeks. These are planning estimates, not a measured optimum. If AI is unavailable or does not choose hours for every week, no new plan is saved: enter hours or try again. Entered hours preserve the existing planning behavior; re-planning keeps your choice to delegate hours to AI.
- The server listens on localhost only. It accepts API calls only from pages it served (it checks Host and Origin and requires a JSON content type), so other websites cannot use your key.
- Without a key, the coach falls back to the offline engine and says so in the status pill.
- `server.js` is an equivalent Node.js server (`node server.js --open`) for machines without Windows PowerShell. It reads the same `.env` and exposes the same API.

## Bluetooth Devices

**Workout-aware ERG:** the cockpit's **ERG response** defaults to **Auto**, choosing settings for each interval rather than using one setting for the whole ride. Easy/endurance steps use a longer PowerMatch average and gentle corrections; tempo, SweetSpot, threshold and over-unders use stable corrections; longer VO2 / hard-start efforts use faster corrections. Hard bursts up to 30 seconds hold the proportional trim learned on steadier steps, so PowerMatch does not chase trainer lag. Targets change at the interval boundary, preserving the full recovery duration. Steady and Responsive overrides are saved on this browser; burst protection still applies. Display power smoothing is independent of resistance control.

**All workout types stay in ERG.** Auto adapts how power targets and meter corrections are handled; it does not switch trainer modes or recommend another mode. Cadence drills use gentle corrections and all adaptive profiles pause PowerMatch corrections briefly during rapid cadence changes so they do not compete with the trainer's own ERG response. Explicit low-cadence targets lower the stall threshold and the cadence needed for a restart. Short bursts and sprint steps hold the learned trim while following the prescribed ERG target. Paced tests use stable corrections at the prescribed power; a target-controlled test does not measure unrestricted maximum effort. A failed ramp-test step pauses instead of continuing at a reduced load; the Stand load reduction is unavailable on ramp-test efforts.

These are conservative software presets. Physical response and firmware behavior need checking on the trainer. Guidance: [TrainerRoad smart trainer modes](https://support.trainerroad.com/hc/trainerroad-support/articles/360024069532-smart-trainer-modes-explained), [Wahoo ERG guide](https://support.wahoofitness.com/hc/en-us/articles/4402565516946-A-Guide-to-using-ERG-mode), and [Wahoo Easy Ramp](https://support.wahoofitness.com/hc/en-us/articles/39167740791442-ERG-Easy-Ramp-explained). The per-profile numerical tuning is Apex's implementation choice. Run `node --test tests/erg-adaptive.test.js` for controller and workout-engine regressions.

The Devices drawer supports FTMS trainers/smart bikes, Cycling Power Service meters (pedals, crank, spider or hub), heart-rate sensors and the Wahoo KICKR HEADWIND fan. Measurements depend on what the device reports; a power meter does not have to report cadence or left/right balance. Existing Bluetooth assignments remain compatible.

- **Connect saved devices** reconnects one at a time. **Stop connecting** cancels the current attempt and remaining devices. Each saved device has Reconnect/Retry, Stop, Rename, Replace and Forget in Apex. Forget clears the app assignment; browser permission remains in browser site settings.
- A cancelled replacement keeps the current connection. An incompatible replacement keeps the previous device saved so it can be reconnected. A device already assigned to another role is rejected to avoid competing connections.
- The card distinguishes **receiving data**, **waiting for data**, **no skin contact**, **reconnecting** and **failed**. Trainer control is shown separately from the connection. Calibration is available only on a connected meter exposing its control point, while the ride is paused.
- **Measurement sources & PowerMatch** selects power and cadence independently. Auto prefers the power meter and falls back to the trainer; fixed selections do not fall back. Source preferences and changes during the ride are saved with the ride; each sample retains its power source. Source changes clear smoothing and PowerMatch memory. The existing ERG governor, speed/distance handling, calibration and diagnostics remain available.
- **HEADWIND:** first pair it on the PC. Connecting sends no airflow commands. Manual control offers Off, presets and a 0–100% slider; sent commands and fan-confirmed airflow are shown separately. Optional Apex automatic cooling maps fresh HR (60–95% max HR) or power (40–120% FTP) to 20–100% airflow, using a trailing average (20 s for power, 10 s for HR) in 5% steps, changed at most once every 10 s so the fan does not hunt with every pedal stroke. It holds the last setting on pause or signal loss, uses no simulator readings, and returns to manual if a command fails. A manual adjustment overrides auto. Use Off when finished.
- **Phone:** the Devices screen reconnects saved devices, stops connection attempts, and offers fan presets and cooling-mode selection. New pairing still requires a click on the PC. Restart the local server after updating so it accepts the added commands.

HEADWIND uses a proprietary adapter based on [WearWind's implementation](https://github.com/garanj/wearwind/blob/main/app/src/main/java/com/garan/wearwind/FanControlService.kt) and [BlueWind's service definition](https://github.com/octopusx/bluewind/blob/main/headwind/spec.py). Protocol behavior is covered by mocked regression tests; physical compatibility must still be checked on your fan/firmware. `node --test tests/bluetooth-updates.test.js` runs the connection, cancellation, replacement, source and fan regressions. The browser suite also checks focus, keyboard navigation and device controls.

## Backups (automatic)

Your ride history lives in the browser (IndexedDB + localStorage), so clearing Chrome's site data would erase it. The app therefore backs it up **automatically**:

- About 15 s after anything changes the history (a ride saved, an import, a Strava sync, a delete, a profile change), and at least once a day, the app sends the same backup as **Backup JSON** - profiles, workout library and every ride **with its per-second samples** - gzipped, to the local server.
- The server saves it as `data\backups\apex_velo_backup_<date>_<time>.json.gz` and keeps the **newest 14**. An unchanged history is not backed up twice in a day. **Settings (gear icon) > Backups** shows the last backup; **Back up now** makes one immediately. Apple Health recovery days are included in every backup.
- **Restore:** drop a backup file (`.json.gz` or `.json`) on the **Import** zone in History. Rides already in the history are skipped; you are asked whether to restore the rider profiles too.
- Only the app opened **on this PC** can write backups (not a phone on the Wi-Fi, not another website), only real Apex Velo Lab backups are accepted, and the folder is **never served** by the web server. `data/backups/` is git-ignored.
- Want an off-PC copy? Point OneDrive / Google Drive at the `data\backups` folder, or copy a file to a USB stick now and then.

## Settings

The **gear icon** in the header opens Settings - everything you set up once:

- **Rider** - FTP, weight, max / threshold heart rate and crank length (opens the rider profiles).
- **AI engine** - Claude or Gemini, model and reasoning effort (low by default).
- **Apple Health** - live status, the address and token for Health Auto Export, and the setup steps with your PC's address filled in.
- **Backups** - last automatic backup and **Back up now**.
- **Phone view** - the address to open on your phone.

## Apple Health: resting HR, HRV and sleep (Health Auto Export)

Your Apple Watch's **resting heart rate**, **HRV** (Apple's SDNN, in ms) and **sleep** reach the app through the **Health Auto Export** iPhone app, which posts them to this PC. They drive the daily **readiness**, the **calendar recovery strip** and the resting HR / HRV trends in Analytics. Nothing is uploaded anywhere else.

**Setup (about 2 minutes, once):**
1. Phone view must be enabled (`Enable-Phone-View.bat`, see below) - the iPhone talks to the PC over your home Wi-Fi. Tip: give the PC a fixed address in your router (DHCP reservation) so the URL never changes.
2. In the app open **Settings > Apple Health** and copy the **URL** (e.g. `http://192.168.1.23:8080/api/health`) and the **token**.
3. On the iPhone install **Health Auto Export** (automations need its Premium tier) and allow it to read *Heart Rate*, *Resting Heart Rate*, *Heart Rate Variability* and *Sleep Analysis*.
4. **Automations > New automation > REST API**: paste the URL; add a header `Authorization` = `Bearer <token>`; data type **Health Metrics** with those four metrics; format **JSON** (version 2); date range **Since last sync** (the first time: the last 60 days, so readiness has a baseline straight away); sync **every hour**; turn it on. If iOS asks to find devices on your local network, tap **Allow**.
5. Tap **Manual export**, then **Check now** in Settings - *Last received* updates.

**How it works.** The server only stores what arrives (`data\health\inbox`, never served, git-ignored) - after checking the token; the app on the PC collects it at start-up, every 10 minutes and when Settings opens, folds it into one record per day and then lets the server delete the payloads. Every reading is keyed by its own timestamp (sleep by stage and start/end), so hourly exports that overlap, or the same data sent twice, never count twice. A new token (Settings) stops the old one working. Missed days fill in on the next sync (the phone must be on home Wi-Fi and the PC server running).

**Sleeping resting HR and HRV.** Both are taken from the night, not the whole day. Resting HR is the **floor of your heart rate while asleep** - the 10th percentile of the readings inside your sleep stages, so one bad low optical reading cannot set it and REM or restless spells do not lift it. It falls back to Apple's daily *Resting Heart Rate* on a night with fewer than 20 heart rate readings asleep. HRV is the average of the readings taken asleep (all of that night's readings, 18:00 on, when none were). Heart rate is kept only overnight (18:00-12:00). Nights from before *Heart Rate* was exported keep Apple's daily value, which usually sits a few bpm higher - so the resting HR baseline takes about 30 nights to be fully sleep-based.

**Readiness** (advisory - it never blocks a workout), against your own normal:
- **HRV:** 7-day average (log scale) against your 60-day normal range (mean +/- 0.5 SD); last night far below normal (more than 1.5 SD) counts too.
- **Resting HR:** today against your 30-day average - +5 bpm is a flag, +8 a strong one.
- **Sleep:** under 6 h (or 1.5 h under your average) is a flag, under 5 h a strong one.
- 0 flags = **green** (ready for threshold / VO2), 1-2 = **amber** (go easier), 3+ = **red** (Z1-Z2 recovery). Until 7 nights of HRV exist it shows *Building baseline (n/7 nights)*.
- It shows in the cockpit before Start, in Analytics and in the Coach; the AI coach (and the offline engine) turn a key session into endurance on amber and a recovery spin on red. Click the chip for the reasons.

## Training blocks (periodised plans)

In **AI Coach > Training block**, pick a goal, a length (4-12 weeks), a start date, your hours per week, the days you can ride and a long-ride day. The coach builds a periodised block:

- **3 load weeks + 1 recovery week** (about 45% less load, a short key session kept), and a final lighter week that ends with a **ramp test** to reset FTP and zones.
- **Progressive overload by a controlled CTL ramp** (3-4 CTL per load week by goal, none in the first week if you start fatigued). Volume grows toward your available hours instead of jumping to them.
- **Phase progression per goal**, e.g. Raise FTP: SweetSpot foundation -> threshold build -> threshold + VO2 peak.
- **1-3 key sessions a week** (at most 2 while CTL is under 30), never on consecutive days (also across weeks) and never the day after the long ride; the other rides are easy, so most of the time stays in Zone 1-2.
- With Claude or Gemini connected, the model designs the periodisation (week types, phases, weekly load, key-session types) and its reasoning is shown. The app always places the sessions on your days and enforces the rules above, and clamps the weekly load to a safe ramp. Without a key, the built-in engine plans the block on its own.

The sessions appear on the **Calendar** (dashed cards with a **Load** button that builds the interval workout for your FTP), and the block card shows planned vs done TSS per week and this week's sessions. **After every ride** (and after imports or syncs) the plan is re-checked against what you actually rode: sessions are marked done or missed, and the coach suggests adjustments that change nothing until you press **Apply**: move a missed key session to a safe day, ease the next key session when form (TSB) is below -25, shorten the next ride after a week well over plan, lighten the week after low consistency, or extend a key session when you are fresh and consistent. **Re-plan from today** rebuilds the remaining weeks with your current fitness and keeps the completed weeks. The block is stored in this browser.

## Send rides to Strava

After a ride, the workout summary has a **Send to Strava** button. It shows the result on the ride itself: **Sent to Strava** with a *View on Strava* link, **Already on Strava** if another app (Wahoo, Garmin, Zwift) uploaded the same ride, or **Not sent - upload failed** with the reason and a Retry button. The history table marks every sent ride with an orange *Strava ✓* chip linked to the activity.

**Already on Strava?** When a ride summary opens, the app first looks for the same ride in your Strava activities (a ride starting within 10 minutes, or overlapping at least half of it - runs and other sports never match). If it is there, for example uploaded by Wahoo, Garmin or Zwift, the panel says **Already on Strava** with the activity name and link, and there is nothing to send. **Check Strava** in the History toolbar does the same for every ride at once and reports how many were found.

**One-time setup (about 3 minutes):**

1. Go to [strava.com/settings/api](https://www.strava.com/settings/api) and create an application. Any name and website work (e.g. `Apex Velo Lab`, `http://localhost`); set **Authorization Callback Domain** to `localhost`.
2. Copy its **Client ID** and **Client Secret** into `.env` as `STRAVA_CLIENT_ID=` and `STRAVA_CLIENT_SECRET=`, then restart `Launch-Apex-Velo.bat`.
3. Open any ride summary and click **Connect Strava**. Approve access (keep *Upload your activities* and *View data about your private activities* ticked - the second one lets the app see which rides are already on Strava). The window closes by itself and the app shows *Ready to upload as <your name>*.

The secret stays in `.env`; the access tokens are stored in `.strava-tokens.json` in the app folder (never served to the browser, listed in `.gitignore`) and are refreshed automatically. *Disconnect Strava* in the panel revokes access and deletes them.

**Workout image.** Strava's API does not let personal apps attach photos (only partner apps such as Zwift can). So every send also creates a workout image (stats, power trace in zone colours, target, heart rate, time in zone, peaks, L/R balance), saves it to your Downloads and copies it to the clipboard. In the Strava activity choose *Add photos* and drop it in. *Copy image* / *Save image* in the panel repeat that at any time.

What is uploaded: the ride's FIT file (per-second power, cadence, heart rate, speed, distance and L/R balance, validated with Garmin's FIT SDK), the workout title, the trainer flag, and a short description (avg/NP power, IF, TSS, heart rate, balance, work). Only rides recorded with per-second data can be sent; summary-only imports cannot.

## Sync from Strava (import your activities)

The **Sync from Strava** card in *History* imports your Strava activities for a date range into the history and the Calendar - outdoor rides, Zwift rides from other apps, gym sessions, walks, yoga.

1. Pick a range: the last **2 / 4 / 8 (default) / 12 / 26 weeks**, or **Custom dates** (from - to). The last choice is remembered.
2. Click **Sync from Strava**. The app reads the range from Strava and shows a **preview** - nothing is changed yet:
   **New** (will be imported) · **Linked** (already in the app, summaries combined) · **Refreshed** (edited on Strava) · **Removed** (deleted on Strava) · **Merged Strava duplicates** · **Needs review** (possible duplicates).
3. Press **Apply** to write it, or **Cancel**. **Undo last sync** (with the time of that sync) puts everything back.

**Refresh semantics.** A sync is a complete, repeatable refresh of the chosen range:
- Records imported from Strava (source *Strava*) inside the range are rebuilt from what Strava returns now: updated when you edited them on Strava (name, description, calories...), added when new, and removed from the app **only** when they no longer exist on Strava. Removals are listed in the preview and need Apply.
- Records outside the range are never touched.
- Rides recorded in this app are never removed; their Strava links are re-checked (a link to a deleted activity is reported, not changed).
- Matched rides, including already linked rides, use Strava distance and moving time (elapsed time if moving time is missing). Missing Strava values fall back to the original HealthFit/local summary. Local recordings and measured training load are retained; Strava fills missing summary metrics or power recordings. Preview lists combined/refreshed rides, and Undo restores the pre-sync records.
- Running the same sync twice: the second preview says **No changes**.

**Duplicates - three layers, in order.**
1. *Exact id:* an activity already linked to a ride (sent with *Send to Strava*, found by *Check Strava*, or linked by an earlier sync) is never imported again.
2. *Fuzzy match* (`js/velo-dedupe.js`): start time, overlap, duration, distance and energy - titles are ignored. The timezone rule only applies to HealthFit rides (they store local time with a `Z`) and only for this PC's UTC offset; a ride that is identical but 3 h later is a different ride. A duplicate (score >= 0.8) is not imported; the Strava id is linked to your ride instead (the app's ride with 1 Hz data always wins). A **possible** match (0.6-0.8) is never imported automatically: it waits in *Needs review* with **Import** / **It's the same**, and your answer is remembered per Strava activity.
3. *Within Strava:* the same session logged twice (e.g. Motra + your watch's "Strength Training" a few seconds apart) keeps the richer one (the description with the exercises); the other id is remembered as merged and never imported later.

**What is imported.** A record with source *Strava* and the Strava activity id. Rides get TSS from weighted average power / FTP when there is power, else from heart rate (hrTSS), else from duration at IF 0.65; estimated TSS is flagged (*est.* chip in History). The FTP / threshold HR used is stored with the record, so changing your profile later does not rewrite old imports.

**Second-by-second power.** For rides recorded with a real power meter (Strava's `device_watts`; never Strava's estimated power), the preview also fetches the ride's power stream - time, watts, heart rate, cadence, speed, distance - as 1 Hz samples (gaps of up to 5 s from "smart recording" are held; longer gaps are pauses and left out). NP and TSS are then computed from the samples (*power-stream*, not estimated), and the ride shows in the power curve and ride review like one recorded here. At most 30 streams per sync (one Strava read each), stopping early near the rate limit; the preview says how many rides still wait for power data and the next sync adds them. A ride without a power stream is marked once and not asked again. Imported rides are never sent back to Strava.

**Threshold heart rate.** Heart-rate TSS uses the optional *Threshold heart rate* in your profile. Left blank, it is estimated as 90 % of max HR and the record is marked as estimated; once you enter your real threshold HR, the next sync recomputes those estimated records (records that already used a real threshold HR are kept).

**Background check.** About 5 s after the app opens, it quietly reads your chosen range from Strava (the list plus up to 20 descriptions - no power streams) and plans a sync **without applying it**. If anything would change, a count badge appears on the *History* tab and the *Sync from Strava* button, with one toast. Nothing is imported until you press Sync and Apply. Turn it off with *Check Strava for changes when the app opens*.

**Non-cycling activities.** Strength, walks, yoga and other sports are **non-cycling** activities: they appear on the Calendar with their own icon and colour and in History, but never in cycling analytics, the power curve (MMP), FTP or power charts. Strength sessions keep Motra's exercise list for the detail view and get a **strength load** from Strava's relative effort (capped at 60). It counts toward fatigue (ATL) - toggle **Count strength sessions in fatigue** - and toward cycling fitness (CTL) only if you tick the second toggle. A heavy leg day (squats, deadlifts, lunges... or a high strength load) counts like a hard day: the training block review suggests turning a key ride on the next day into endurance, and the AI coach does not prescribe a key session right after it. The coach and block prompts get one line on the strength sessions in the look-back window (count, dates, main lifts).

**Safety.**
- Strava is **read-only** for this feature: the sync only calls `GET /athlete/activities`, `GET /activities/{id}` and `GET /activities/{id}/streams`. No uploads, edits or deletes on Strava (tested - see *Tests*).
- Rides recorded here (cockpit, HealthFit, FIT imports - anything not from Strava) are never modified, replaced or deleted by a sync; the only change allowed is adding the Strava link.
- **Preview first:** nothing is written until you press Apply.
- **Restore point before apply:** the full history (localStorage + the IndexedDB ride database), the training block and the sync state are saved first; if that fails, the sync is aborted. Per-second samples are kept by reference, except for records the sync removes or whose samples it replaces - those samples are stored in full. The last 5 restore points are kept.
- **Atomic apply:** the complete new history is computed in memory and validated (no app ride lost or changed, no duplicate ids, counts add up), then written once (one database transaction). Any error: storage is rolled back to exactly the previous state and the error is shown.
- **Undo last sync** restores that restore point exactly (power streams a sync added are removed again, streams of records it deleted come back); rides you recorded after the sync are kept.

**Strava limits.** Strava allows 100 read requests per 15 minutes. One sync uses 1 request per 200 activities plus one per activity for descriptions and calories; details are cached (and re-read after 3 days) and at most 60 are fetched per sync, with progress shown. If the limit is reached, the preview says how many descriptions are still missing and the next sync adds them.

**Permission.** The sync needs *View data about your private activities* (`activity:read_all`). If your connection is older or that box was unticked, the app asks you to **Reconnect Strava** (Disconnect, then Connect Strava). Deleting an imported record in the app is allowed; the next sync of that range imports it again. *Re-sync HealthFit* / *Wipe & re-sync from folder* rebuild the whole history (Strava imports included) - run a Strava sync afterwards.

## Phone view (ride in another room)

The PC keeps the Bluetooth sensors and runs the ride; your phone becomes a live screen and remote.

1. **One time:** double-click `Enable-Phone-View.bat` and click **Yes** on the Windows prompt. It lets the server listen on your home network and opens the port in Windows Firewall for *private* networks only. Your home Wi-Fi/Ethernet must be set to **Private network** in Windows settings. (Undo any time: `Enable-Phone-View.bat remove`.)
2. Start `Launch-Apex-Velo.bat` as usual and open the app on the PC. The console window prints the phone address, e.g. `http://192.168.1.23:8080/live.html`.
3. On the iPhone (same Wi-Fi, not mobile data) open that address in Safari, then **Share > Add to Home Screen** for a full-screen "Apex Live" icon.

The phone has six screens; swipe sideways or tap the tabs, and it remembers the last one:

- **Ride** (TrainerRoad-style) - six big tiles (target watts, power with +/- vs target, interval time left, heart rate, cadence, workout time left) over a graph of the **whole workout**: every step as a blue block at its target watts (ridden part brighter, current step outlined), with your power (yellow), heart rate (red) and cadence (green) traced over it and a playhead. Turn the phone sideways on the bars for a one-row layout: tiles in a row, a bigger graph and the controls in a single row.
- **Focus** - the current step and countdown, **5 s average power** against target, a 2-minute power trace, heart rate and cadence.
- **Session** - % complete and time left, the whole workout as zone-coloured blocks with a gliding playhead, avg power, heart rate, cadence and distance, plus **W′ left** (kJ and %, with *Empty in m:ss* while you are above CP) when the PC has a CP model.
- **Balance** - live L/R split from the pedals, a 2-minute balance trace with its average, cadence and power source.
- **Pedal** - the pedal-stroke polar view: lobe split = measured L/R balance, size = measured power vs FTP, rotation = measured cadence. The lobe shape itself is a model (labelled MODEL) - the pedals don't send force per crank angle.
- **Devices** - connect your sensors from the phone and see how each one is doing: link state, live reading (W / rpm / bpm), battery, signal and how long it has been connected. The ring at the top shows all three at a glance; **Connect saved** wakes every known sensor with one tap (one after another, which Windows Bluetooth prefers). A dropped link shows *Reconnecting - retry 2/8 in 3 s* with **Retry now** / **Stop**, and gives a toast and a buzz on whichever screen you are on. **Disconnect** asks for a second tap. The pedal card has **Zero-offset** (not while riding). The device dots in the header open this screen, and turn amber / red when a sensor is reconnecting or failed. The heart icon beats at your pulse and the crank turns at your cadence.

**Connecting from the phone.** Bluetooth stays on the PC; the phone is its remote. A sensor you have connected on this PC before connects straight from the phone - even after a restart, because Chrome remembers which devices the app may use. A brand-new sensor needs **one click on the PC** the first time (browsers only open the Bluetooth list after a real click): tap **Pair on PC** on the phone, and the PC shows a *Your phone wants to connect...* banner with a **Pair now** button and a chime. After that the phone can connect it on its own.

Chrome forgets a sensor it has not seen for a few minutes (and every sensor when it restarts), and then refuses to reconnect it with *Bluetooth Device is no longer in range* - however close it is. So a connect from the phone listens for the sensor first (up to 12 s, even with the PC window minimised) and connects the moment it shows up: wake it before you tap (turn the cranks, put the strap on). A sensor that stays silent shows *Not found nearby* instead of three failed tries. This relies on Chrome's `chrome://flags/#enable-web-bluetooth-new-permissions-backend` (Enabled); without it the phone can only reconnect sensors picked since the PC page last loaded, and asks for **Pair now** otherwise.

Before you press Start (and while paused) the phone already shows live heart rate, power and cadence from connected devices; nothing is recorded until the ride runs.

A thin zone-coloured bar of the whole workout sits above the controls on every screen, with a needle showing where you are. The controls stay at the bottom of every screen, sized for sweaty fingers (60 px targets): **Start/Pause**, **-5 W / +5 W** (the middle shows the change from the plan in watts - tap it to go back to the plan), **Stand 30s** and **Skip step** (tap twice to confirm). When a workout ends, the phone shows the **+5 min easy spin** offer with giant buttons too. Keep the Apex tab open on the PC (it can be minimised). Only devices on your private home network are accepted; anything else gets 403.

**No visible lag.** The PC pushes every ride second to the phone the moment it happens, and the phone keeps a request open that the server answers as soon as the new data arrives (long-poll), so the phone shows each update about 10-20 ms after the PC. Taps on the phone reach the PC just as fast: the PC keeps its own request open for commands, and each command is confirmed by the PC so it is never lost or applied twice.

**Download the finished ride on your phone.** After **Finish** (or the easy-spin offer times out), a **Download .fit** button appears on every phone screen. Tap it to save the completed activity, including its recorded power, heart rate, cadence, speed, distance and balance, directly to the phone. Your browser may ask you to confirm the download; on iPhone, find it in Safari's Downloads / the Files app. Keep the PC server running and the phone on the same Wi-Fi until the download finishes. Only the latest completed file is held in server memory; if a connection fails, the PC retries automatically. Restart the launcher and refresh both the PC and phone pages after updating. Run `node --test tests/phone-fit-download.test.js` to verify the download flow on both local servers.

**Instant taps.** A tap on the phone shows its result straight away (and buzzes) - +/-5 W, Start/Pause and Stand don't wait for the PC. The PC applies the command within a few tens of ms and its confirmed state replaces the prediction exactly when it arrives (each command has an id the PC acknowledges), so rapid taps add up correctly and nothing flickers. If the PC doesn't confirm within 4 s, the screen falls back to the real state. After the phone wakes or Wi-Fi comes back, it reconnects at once.

**Screen stays on.** Over plain http on your home Wi-Fi, iPhone Safari has no Wake Lock, so the phone view plays a tiny silent, invisible looping video - the technique the NoSleep.js library uses - which keeps the screen on. Browsers only allow it after a tap, so the page asks you to tap anywhere once. If your phone still dims, set Settings > Display & Brightness > Auto-Lock to Never while riding.

## Security & privacy

- **Secrets live only in `.env`** (Anthropic and Gemini keys, Strava client secret) and `.strava-tokens.json`; both are git-ignored and the local server refuses to serve any dot-file, `.git`, the server scripts or helper scripts. The browser never sees a key.
- **The server only answers this PC and devices on your private home network** (10.x, 172.16-31.x, 192.168.x, link-local). This is checked on the real client address of every request, which a client cannot fake, so even on a public Wi-Fi nothing outside answers. Every page and data file, not just the API, also refuses requests made through another website's address (DNS rebinding), so no website can read your ride history. Open the app as `http://localhost:8080` on the PC and by the numbered address the launcher prints on the phone; a PC name such as `http://DESKTOP-ABC:8080` is refused. Do **not** forward port 8080 on your router - the app is not meant to be reachable from the internet.
- `Enable-Phone-View.bat` opens the port in Windows Firewall for **Private** networks only; `Enable-Phone-View.bat remove` undoes it.
- Strava sync data stays in the browser (history, restore points in IndexedDB); besides `.strava-tokens.json`, the server only writes the automatic backups in `data\backups` (this PC only, never served, git-ignored).
- Personal ride history (`data/divan_cycling_history.*`) is git-ignored; run `parse_healthfit.ps1` to build your own from HealthFit `.fit` exports (set `HEALTHFIT_DIR` if they are not in `Downloads\HealthFit\HealthFit`).

## Data integrity rules

- **No placeholders.** Nothing is synthesised: no sine waves, no mock PRs and no default cadence, HR or balance. A channel that was not recorded shows `--` in the UI and is left out of the exports.
- **Imports are 1 Hz.** Many head units log a point only every few seconds ("smart recording"). FIT, TCX and CSV imports hold the last reading through gaps of up to 10 s, so every sample is one second and NP, power bests, medals and the FTP evidence are measured over the right durations; longer gaps are pauses and are left out.
- **Source hierarchy.** The Assioma pedals (CPS 0x1818) are ground truth for power, cadence and L/R balance. The KICKR (FTMS 0x1826) supplies speed, distance and ERG control. When the pedals are absent, the trainer's power takes over, and the power-source badge in the cockpit shows which device is live.
- **Distance.** With the KICKR connected, distance adds what the trainer's odometer moved each second. After a pause, a dropout or a trainer reboot (its counter restarts) it only re-syncs, so the total never jumps back and pedalling while paused is not counted.
- **PowerMatch.** In ERG mode the trainer target is trimmed by the pedal/trainer error. The trim is capped at ±45 W and moves at most 2 W/s. The Devices drawer shows the live trim.
- **ERG that never walls you.** `js/velo-erg.js` shapes every trainer target:
  - *Soft start* - only from a real standstill: Start, Resume, Skip/Jump or a trainer reconnect while you are not spinning begins at about half the target (or your current power, if higher). The trainer holds there until you pass 70 rpm, then ramps to target over 8 s. While you are pedalling every step change is instant, HIIT included.
  - *Stand* - **Stand 30s** (cockpit button, **S** key, or the phone) eases the load 5 % for 30 s for an out-of-the-saddle break; the anti-stall guard and PowerMatch pause meanwhile, then it ramps back over 4 s. Tap again to end early.
  - *Anti-stall* - on a step above Z2, 3 s under 60 rpm *and* under 85 % of the target watts (or under 40 rpm) eases the load to 60 % of target (the pill reads *ERG EASED - SPIN UP*). Once you are back above 75 rpm it ramps to target over 6 s. Grinding a hard effort at low cadence while holding the watts is left alone, and a low-cadence drill lowers the thresholds to its own cadence target.
  - *Step lead* - an upward step is sent up to 2 s early so the flywheel's lag lines up with the real step, but never more than 10 % of the step it cuts into: a 15 s recovery loses at most 1 s, a 10 s one none. Downward steps are never early, so hard efforts are never cut short.
  - *PowerMatch* - the trim is a pedal/trainer calibration, so it carries to the next step in proportion to the new target (short intervals start already matched). After any target change it waits 6 s before adjusting, it is off during a ramp, and it never adds watts while cadence is low, so it can't overshoot a step or deepen a stall.
- **The simulator never touches a real ride.** It switches off as soon as a device connects, and once a ride has used real hardware a dropout is recorded as no power (`NONE`), never filled with simulated values.
- **Heart rate.** A strap reporting no skin contact or 0 bpm (a Polar H10 does this while the electrodes are dry) shows `--` and is not recorded; the last value is never frozen on screen.
- **Apple Health.** Recovery values appear only for days that have them - no carrying forward, no averages dressed up as a day. Implausible readings are dropped (resting HR outside 25-130 bpm, HRV of 0 or above 300 ms, more than 20 h of sleep); several sleep sources for one night are never added together (the longest is kept).

## Features

### Riding
- **Cockpit.** Tabular-mono telemetry with no numeric jitter. The interval track is a HiDPI canvas with a 60 fps interpolated playhead, Coggan Z1–Z7 colours, hover tooltips and click-to-jump. Smoothing pills are 1 s, 3 s, 5 s and 10 s.
- **Zen mode.** A halo shows target compliance: lime within ±5%, amber under, cyan over. There is an optional cadence halo and a heart-rate strain gauge. Toggle with `H`.
- **BLE resilience.** Each device has its own connection slot and a serialised write queue. A first connection is tried up to 3 times (Windows often rejects the very first GATT connection to a Polar strap or power meter) and times out after 15 s instead of hanging; if it still fails, the toast gives the real reason and what to check. After an unexpected link loss mid-ride the app reconnects with exponential backoff (1 s, 2 s, 4 s … capped at 30 s, ±15% jitter, 8 attempts). A reconnect that Chrome refuses with *no longer in range* (it has not seen the device in a scan lately) watches the device's advertisements for up to 12 s first, then connects.
- **Live device preview.** As soon as a device connects, its live values show in the cockpit (and Zen mode) before you press Start, while paused and after a ride: heart rate and HR zone from the strap, and power, W/kg, cadence and L/R balance from the pedals (or the KICKR). This is display only: nothing is recorded, and the ride clock, averages, NP/TSS and distance do not move until you start. A device that stops sending shows `--` again.
- **Ride safety.** The screen is kept awake while riding (Screen Wake Lock), and closing or reloading the tab during a ride asks first.
- **Devices drawer.** Shows battery, RSSI, link state, the commanded ERG watts and the PowerMatch trim for each device. RSSI appears only where the browser supports `watchAdvertisements`; otherwise it shows `--`.
- **Pedal calibration.** A 3-second countdown, then the CPS **Start Offset Compensation (op code 0x0C)**. A toast shows the offset the pedals return, and the last offset is kept.
- **Drift-free clock.** A Worker-driven 1 Hz tick keeps timing accurate when the tab is in the background and resyncs after sleep.
- **Live W′ balance.** A cockpit card shows how much of your anaerobic reserve above critical power (W′) is left, second by second: it drains above CP, recharges below it (pauses recharge too), shows *empty in m:ss at this power* while you are above CP, and counts the matches you burn. It uses the CP model of your last 90 days at the moment you start (see *Power & critical power*); without a model it says what it needs instead of guessing.
- **Audio cues.** 3-2-1 countdown beeps before every step change, a "go" tone on the change and a fanfare at the end. Mute with the speaker icon or `M`.
- **+5 min easy spin.** When the last step ends, the ride keeps going on a 5-minute easy spin (45 % FTP) and a prompt offers **+5 min easy spin** or **Finish now** for 10 s (on the PC and the phone). No answer = finish: the extra step is dropped and the workout is saved as completed. Accept, and at the end of the spin you are asked again.
- **Keyboard.** Space start/pause, Tab or -> next step, `S` stand break, `Z` Zen, `F` fullscreen, `P` mini-HUD, `M` mute; the full list is behind the keyboard icon.

### AI Coach
- **Build a session:** the Workouts tab is the library (filter, search, fine-tune in the table); anything built for you comes from the **AI Coach** (its notes box takes free-text requests like "45 min over-unders").
- **Goals:** FTP, Longevity (Z2/durability), VO2max and Balanced.
- **Context from your real history.** 28-day hours per week, intensity mix, CTL/ATL/TSB, days since the last hard and last long ride, and a power-profile type from your all-time MMP curve. Free-text notes are passed through as well.
- **Claude or Gemini (Claude Opus 5.5 or Gemini 3.8 Flash, low effort by default).** The summarised reasoning trace is rendered as markdown with a live timer, alongside phase cards and a 7-day plan that ramps CTL, drops the ramp to 0 when fatigued and never stacks hard days within 48 h. Click a day of the plan to pre-fill the request.
- **Offline engine.** Builds a workout sized to the requested duration: sweet-spot blocks, threshold under/overs, 4×4 VO2 or Rønnestad 30/15. IF and TSS are computed from the intervals, not estimated.
- **One-click load** into the cockpit, and **Clear Recommendation**.
- **Recent ride insight in the prompt.** From rides with recorded power, the coach (Claude/Gemini, and the offline engine's advice) gets: the last hard session's interval diagnosis (and its saved AI breakdown), the Pw:HR drift of recent steady rides, new power bests over an earlier best (5 min and longer), and an FTP suggestion you have not applied yet - so a session type that faded is re-paced, aerobic work stays steady while drift is high, and targets reflect a proven FTP.

### Analytics - progression dashboard
One **time range for the whole page** (6 weeks, 3 months, 6 months, 1 year, All), and section links under the title (Overview, Fitness & load, Power & CP, Intensity, Aerobic engine, Pedal balance) that stay on screen and follow your scroll.
- **Plain English everywhere.** Every acronym and metric in the app has a short plain-English line under its name (*TSS - workout load score*, *CP - your long-effort limit*, *W′ - burst energy reserve*) and its full name on hover. They come from one shared glossary (`js/velo-glossary.js`) that matches *Settings › Training terms explained*.
- **Today strip:** readiness, form (TSB) with its zone, fitness (CTL) and fatigue (ATL), **ramp rate** (CTL gained in 7 days - above ~7/week is flagged as injury/illness risk) and FTP with W/kg.
- **Progression tiles** - value, trend sparkline over the range and change vs 6 weeks ago (green = the good direction): FTP, fitness (CTL), **efficiency factor**, 20-min peak (best in 90 days), resting HR and HRV (30-day averages).
- **Fitness & load:** the PMC (coloured form bands, daily TSS bars, tooltips and a form badge: Fresh, Productive, Optimal, High Fatigue or Overtraining) and weekly TSS / hours / kJ / rides with a 4-week average and KPIs vs the previous period, or **Zones**: hours per power zone each week, stacked; click a week to list its rides.
- **Power & critical power:**
  - **Power duration curve** on a log-time axis from 1 s to 4 h: your best for every duration in the page range, the all-time best (HealthFit archive included), the same-length period before (dashed) and the **CP model** (dashed amber); during or after a ride also *This session*. Point at the curve or drag the slider to read any duration: this period (W, W/kg and the ride that set it - click to open it), all-time, the change vs the previous period, the model's value and this session as % of your PR. **W | W/kg** toggle, and *Show the curve as a table*.
  - **Critical power model** from the best efforts of the last 90 days: **CP**, **W′** (kJ and J/kg) and **Pmax**, CP vs your FTP, an **estimated VO2max** from your best 5 min, the fit error, and *how long W′ lasts* at 105-150% of CP. It tells you when the window lacks all-out efforts (W′ then reads low) and, without a model, exactly what it needs.
  - **CP & W′ over time:** the model refitted along the range (each point uses the 90 days before it) in two lanes, with the FTP in use for comparison.
- **Intensity distribution:** time in each power zone over the range (from second-by-second power, each ride against the FTP it was ridden with), the 3-zone split (low < 75 %, moderate 75-105 %, high > 105 % FTP), the **polarization index** and whether the period was polarized, pyramidal, threshold-heavy or high-intensity heavy.
- **Aerobic engine:** **efficiency factor** (NP / average HR) of steady aerobic rides only (Z2 to tempo, VI <= 1.06, 20 min+) with a 30-day average line - rising = more watts per heartbeat; the **Pw:HR decoupling trend**; and **resting HR & HRV** (7-day averages, from Apple Health).
- **Power profile & FTP:** a **power profile** (5 s, 1 min, 5 min, 20 min) - best of the last 90 days vs the 90 days before, W/kg, and a **PR** badge only when it beats everything before (HealthFit archive included); and **FTP history & monthly peak NP** (bars: highest-NP ride per month; amber line: the FTP in use and your logged FTP changes; green triangles: months where a ride proved an FTP within 5 % of yours or above).
- **Pedal balance:** average left-leg % per ride, measured by the pedals, with the usual 48-52 % band shaded and a 10-ride average line.
- **Explore** (collapsed): intensity mix, the records board (best NP, longest ride, biggest TSS, most kJ, best week, streak) and every ride as NP vs duration.
- **Ride review.** Each ride opens in a modal with a completion banner, comparisons against the last 90 days, peaks versus PRs, time in zone, interval execution and prev/next navigation. Rides with second-by-second power also get:
  - **Power analysis:** variability index, efficiency factor, **work and time above CP**, **W′ low point** (the deepest dip: kJ, % and when), **matches** (W′ drops of 2 kJ or more) and **TRIMP** (Edwards). W′ uses the CP model on the ride's date; if the ride beat the model, it says so.
  - **Ride plot:** power (with target and a CP line), **W′ balance**, heart rate and cadence in stacked lanes on one time axis. The drawing is decimated for speed (peaks kept); the readout under the pointer reads the exact second from the full data.
  - **Time in zones:** power and heart-rate zones side by side as labelled bars.
  - **Ride power curve** against your best of the 90 days before and the model, and the **power distribution** (time per 25 W band, coloured by zone).
  - **Quadrant analysis:** every pedalling second as pedal speed (cadence x crank length) against average pedal force, split at CP and your average cadence, with the % of time in each quadrant (grinding, sprinting, easy, spinning). Set your crank length in the rider profile (blank = 172.5 mm).
  - Also: the **longest stretch held on target** (+/-5 %, 3 s power), **cadence & average torque** (N·m while pedalling), and **heart-rate recovery**: the bpm drop in the 60 s after each hard effort that took HR to 85 % of max or more, flagged when it slows on later repeats (you keep pedalling in ERG, so compare repeats within a ride, not rides).
- **Highlights: PR medals.** Best power for 5 s, 1 min, 5 min, 20 min and 60 min against rides *before* this one: **gold** = all-time best (including the HealthFit archive), **silver** = best this year, **bronze** = best in the last 90 days. Shown in the ride review and as chips in History.
- **Aerobic decoupling (Pw:HR).** On steady rides (after the warm-up: variability index at most 1.05, 80 % of the time within 20 % of the average power, both halves at about the same power, at least 20 min with heart rate): power per heartbeat, first half vs second half. Four bands: **3.5 % or less = base consolidated**, under 5 % = coupled, 5-8 % = mild drift, over 8 % = decoupled (fatigue, heat or dehydration). Interval rides say "not measured".
- **FTP suggestion - only when a ride proves it.** Estimate = best 20 min x 0.95 or best 60 min, whichever is higher; it must beat your FTP by 2 % and 3 W, and the 20-min effort must be steady (not sprints). If heart rate shows a hard effort (>= 85 % of max HR or >= 90 % of threshold HR), one ride is enough; otherwise a second ride within 21 days must confirm it and the lower value is suggested. **Update FTP** changes the profile in one click; **Not now** is remembered and you are only asked again for a higher value.
- **Interval diagnosis.** For every hard step (88 % FTP and up, numbered *Interval 1, 2...*): on target or not, cadence fade and heart-rate rise from the first to the last third of the step - computed offline, free. **Ask the AI coach** sends only that step table (no raw data) to your AI coach at **low** effort (the cheapest level, whatever the coach card is set to) and saves the answer with the ride, so reopening it costs nothing.
- **Pedal balance.** Only measured L/R balance is shown (cockpit, phone, Analytics). The Assioma pedals over Bluetooth do not send torque effectiveness, pedal smoothness or force per crank angle, so the app shows none of those (the old Biomech tab and its simulated charts are gone; the pedal polar view lives on the phone, labelled MODEL).
- **Exports.** FIT (binary, CRC-checked, per-second records including L/R balance), TCX (with TPX extensions) and CSV (with a named header, which the importer reads back). Rides that have only summary data export only a summary.
- **Calendar.** Rides are bucketed by local date. It shows YTD monthly bars and all-time totals. With Apple Health set up, every day shows a **recovery strip** - a readiness-coloured bar and resting HR (♥), HRV (∿) and sleep (☾), each coloured against your own normal (hover for the details) - and the week / month / year shows average resting HR, HRV and sleep with the change vs the previous period. Future days show only the plan; days without data show nothing.

## Architecture

```
index.html            App shell, SVG icon sprite, all views
Launch-Apex-Velo.bat  Double-click launcher (creates .env, asks for the key once, starts the server)
start_server.ps1      Local server (PowerShell): static files, /api/coach (Claude / Gemini) and /api/strava/* (keys stay here)
server.js             Same server for Node.js (optional)
.env.example          Template for .env (API keys, coach provider/model/effort, port)
css/style.css         Design system (obsidian/slate tokens, glass surfaces, responsive breakpoints)
css/fonts.css         Local Inter / JetBrains Mono fonts (no internet needed)
vendor/               Chart.js 4.4.1 (MIT) and the font files (SIL OFL), with their licences
sw.js                 Network-first service worker (bump CACHE_NAME when files change; never caches /api/)
data/                 divan_cycling_history.json/.js - HealthFit archive + all-time MMP; backups/ - automatic backups; health/ - Health Auto Export token + inbox
js/
  velo-metrics.js     Pure maths: zones, NP/IF/TSS, MMP, form bands, backoff, compliance
  velo-db.js          IndexedDB persistence
  velo-ble.js         Web Bluetooth: CPS, FTMS, HRS, battery, RSSI, reconnect, write queues
  velo-erg.js         ERG governor: soft start, anti-stall, step lead, stand break, PowerMatch
  velo-insight.js     Post-ride maths: decoupling, PR medals, FTP evidence/suggestion, interval diagnosis
  velo-clock.js       Worker-based drift-free 1 Hz clock
  velo-sim.js         Hardware simulator
  velo-analytics.js   Rolling MMP, PMC history
  velo-progress.js    Weekly aggregates, KPIs, records, coach profile
  velo-importer.js    FIT / TCX / CSV import (recorded channels only)
  velo-export.js      FIT / TCX / CSV export
  velo-ai-coach.js    Goals, context, offline engine, week plan, Claude/Gemini prompt
  velo-block-planner.js  Training blocks: periodisation, session placement, post-ride review
  velo-workouts.js    Workout library
  velo-biomech.js     Pedal-stroke polar view (phone Pedal screen)
  velo-health.js      Apple Health: payload parsing, per-day de-duplication, readiness, calendar flags (pure)
  velo-trends.js      Dashboard maths: efficiency factor, ramp rate, power profile, balance trend, sparklines (pure)
  velo-power.js       Power maths: 1 s-4 h mean-maximal curve, CP model (CP, W', Pmax), W' balance, matches, TRIMP, quadrant analysis, polarization (pure)
  velo-sound.js, velo-pip.js, velo-folder-sync.js
  app.js              Orchestrator: state, tick loop, cockpit, Zen, BLE events, calibration
  app-analytics.js    PMC, MMP, FTP and weekly progression charts, page range (mixin)
  app-dashboard.js    Analytics dashboard: today strip, tiles, power profile, CP model card, CP history, intensity distribution, EF / recovery / balance charts (mixin)
  app-power.js        Per-ride power cache, CP model at any date (memoised), live W' balance in the cockpit (mixin)
  app-ride-analysis.js Ride review power analysis: ride plot lanes, W' metrics, zones, ride curve, distribution, quadrants (mixin)
  velo-glossary.js    Plain-English meaning of every acronym / metric, shown under labels and as tooltips
  app-health.js       Apple Health pickup, storage, readiness chips, calendar helpers, Settings panel (mixin)
  app-settings.js     Settings screen (mixin)
  app-history.js      History, ride review, exports, calendar (mixin)
  app-coach.js        Coach UI and markdown renderer (mixin)
  app-block.js        Training block UI and planned sessions on the calendar (mixin)
  app-strava.js       Send to Strava: upload, status per ride, workout image (mixin)
  velo-dedupe.js      Fuzzy duplicate detection (start, overlap, duration, distance, energy)
  velo-strava-sync.js Sync from Strava: range, 3-layer dedupe, power streams, refresh plan, validation (pure logic)
  app-strava-sync.js  Sync from Strava UI: preview + streams, restore points, atomic apply, undo, background check (mixin)
  app-insight.js      Ride review highlights, FTP update + log, History medals, AI interval breakdown, drift trend, coach insight (mixin)
  app-backup.js       Automatic gzipped history backups to the local server, status line, Back up now (mixin)
test_suite.html       In-browser test suite
tests/strava-sync-servers.test.js  Runs server.js and start_server.ps1 against a mock Strava
live.html             Phone view (six screens, remote controls, device connect)
Enable-Phone-View.bat One-time firewall/URL setup for the phone view (`remove` undoes it)
```

**Helper scripts** (run by hand in PowerShell, not by the app):
- `parse_healthfit.ps1` - builds `data/divan_cycling_history.json` from your HealthFit `.fit` exports; `create_js_data.ps1` wraps that JSON into the `.js` file the app loads.
- `compute_mmp.ps1` - computes the all-time power curve (MMP) from the same `.fit` files.

The mixins extend `VeloApp.prototype` with `Object.assign` and load after `app.js`. The app keeps one `requestAnimationFrame` loop, which pauses while the page is hidden. `destroy()` removes every listener, chart, observer and timer.

## Fixes in v3

- The pedal calibration command sent 0x0D. It now sends 0x0C (Start Offset Compensation) and parses the 0x20 response.
- The FTMS control point now enables indications before any write, and "control not permitted" (0x05) is handled.
- `ergModeEnabled` was never defined; it is now.
- Hard-coded defaults are gone: imports no longer invent 90 rpm, 140 bpm, 200 W or 49.8/50.2 balance.
- Reconnecting no longer registers duplicate listeners.
- Cadence is no longer frozen when the cranks stop: it drops to 0 after 3 s without a crank-revolution change.
- The folder-sync importer passed its FIT-parser arguments in the wrong order.
- Ride dates now use the start time and local-day bucketing.
- kJ is now integrated over the real sample time steps.
- Object URLs are revoked after download, and charts are destroyed when their modal closes.
- `alert()` calls are replaced with toasts.
- All files are UTF-8 with LF line endings and no BOM.

## Fixes in v3.1 (reliability review)

- Connecting any device crashed with "options is not defined" before Chrome's device picker opened.
- A failed first Bluetooth connection left the device stuck in "connecting" with no message; it is now retried, times out, and reports the reason.
- A heart-rate strap without skin contact kept the last heart rate on screen and in the recording.
- With the simulator on (the default), a power dropout during a real ride was filled with simulated watts, cadence and balance.
- Running the test suite deleted your recorded rides, profile and settings (it shares the browser storage with the app); it now runs in an isolated test mode.
- IndexedDB reads that took longer than 200 ms were treated as "no rides", after which summary-only copies could overwrite stored per-second data. Reads now wait for the real result, a failed read writes nothing back, and a summary-only save keeps the stored samples.
- The saved average power skipped 0 W seconds, so it was higher than the cockpit's; it now includes them everywhere, like TrainingPeaks and Garmin.
- The low-battery warning repeated on every battery notification; a new device showed the previous device's battery level.
- The trainer name filter matched Wahoo TICKR heart-rate straps; the pedal name filter missed upper-case "ASSIOMA" names.
- The BLE reconnect test had been failing since fixed connection delays were added; the delays are now scalable and 0 in tests.

## Formulas

- **NP** = (mean of the 30 s rolling average^4)^(1/4), over full 30 s windows only (live, saved and post-ride NP are identical; no NP before 30 s)
- **IF** = NP / FTP
- **TSS** = (seconds × NP × IF) / (FTP × 3600) × 100
- **CTL**ₜ = CTLₜ₋₁ + (TSSₜ − CTLₜ₋₁) / 42; **ATL** uses the same formula with 7 in place of 42.
- **TSB** = CTL − ATL. Form bands: > 5 Fresh, > −10 Productive, > −25 Optimal, > −40 High Fatigue, otherwise Overtraining.
- **Work (kJ)** = Σ P·Δt / 1000; energy in kcal ≈ kJ (assuming about 24% gross efficiency).
- **Planned CTL ramp:** daily TSS ≈ CTL + 6 × ramp per week.
- **Mean-maximal power** at 1 s ... 4 h: the best average over each window of second-by-second power; windows never span a pause (same rule as NP and the medals).
- **CP and W′:** the 2-parameter work-time model, work = CP × t + W′, fitted to the 3-20 min bests of the window. Bests more than 5 % under the line are treated as submaximal (weight 0.02) and the fit repeated, so easy rides cannot drag CP down. **Pmax** is then fitted with CP and W′ fixed in Morton's 3-parameter form, which is also the drawn model curve: P(t) = CP + W′ / (t + W′ / (Pmax − CP)). A model needs bests at 1 min or less and 12 min or more, a fit error under 8 % and CP no higher than the 20-min best.
- **W′ balance** (Skiba / Froncioni-Clarke differential): above CP, W′bal −= (P − CP) each second; below CP, W′bal += (CP − P) × (W′ − W′bal) / W′. A pause of s seconds recovers W′ − (W′ − W′bal) × e^(−CP·s/W′). A **match** is a fall of 2 kJ or more from the last high point (it ends once 1 kJ is won back).
- **Estimated VO2max** = 10.8 × (best 5-min W/kg) + 7 ml/kg/min.
- **TRIMP (Edwards)** = Σ minutes × weight (1-5 at 50-60-70-80-90 % of max HR).
- **Quadrant analysis:** pedal speed CPV = cadence × crank length × 2π / 60 (m/s); average effective pedal force AEPF = P / CPV (N).
- **Polarization index** = log10(low / moderate × high × 100) with the three fractions; polarized when low > high > moderate and the index is above 2.

## Tests

Open `test_suite.html`. It covers metrics, a FIT CRC round-trip, TCX/CSV round-trips, summary-only exports, the CPS 0x0C command, BLE reconnect with a fake device, write serialisation, PMC ranges, progression, the MMP scrub, the AI goals and week plan, Zen thresholds, resource lifecycle, the clock, calendar bucketing and the device badges. It also checks the Claude path with a mocked `/api/coach` (request shape, reasoning parsing, fallback), switching between Claude and Gemini, auto session duration, the history look-back window, training blocks (3:1 structure, 48 h between key sessions, hours respected, calendar cards, post-ride adjustments), the ERG governor (soft start, anti-stall, HIIT-safe step lead, PowerMatch), and that no API key is stored in the browser. It also checks Polar H10 contact handling, first-connect retries, that a real ride never falls back to simulator data, and that the tests leave your real storage untouched. It also checks the Send to Strava flow with a mocked Strava (upload, processing, sent link, failure, history chip, workout image, and matching rides that already exist on Strava). It also checks **Sync from Strava** with Strava mocked (nothing leaves the machine): the preview writes nothing; only GET requests go out; Apply writes a restore point first and then writes once; Undo restores byte-identical storage; app-recorded rides are unchanged and the Calendar renders the same rides before and after; the three dedupe layers (id skip, fuzzy link, Motra/watch merge), possible matches never auto-imported, decisions remembered; refresh (Strava edit updates, Strava delete removes only that record, out-of-range records untouched, second sync = no changes); custom ranges; a timezone-mislabelled HealthFit ride matched while the same ride 3 h later is not; strength on the Calendar but excluded from power analytics and counted in fatigue; the training block and coach prompts; a simulated failure at every stage of Apply leaves storage unchanged; and the real-storage-untouched check. It also checks the power streams: 1 Hz conversion (short gaps held, pauses dropped), TSS from the stream, streams fetched only for power-meter rides, a rate-limited sync adding them later, exact Undo after streams were added or removed, imports never sent back to Strava; the background check (read-only, no streams, badge, off switch); and a real threshold HR replacing the estimate. It also checks the ride-time extras (Stand break without tripping anti-stall, exact +/-5 W from the phone, the +5 min easy spin offer - accept, finish, timeout - with the library workout untouched, and the server accepting the new phone commands), connecting sensors from the phone (a known sensor reconnects without the Bluetooth chooser, a new one raises the Pair now banner, disconnect keeps it reconnectable; a sensor Chrome has forgotten is found by a short scan - a dead advertisement watch cleared first - and connects once the scan has stopped, a silent one ends as *not found* after one scan, Stop ends a scan at once, and a browser that cannot scan asks for Pair now) and the post-ride insight (decoupling only on steady rides, gold/silver/bronze medals against earlier rides, the FTP suggestion rules and its one-click update, and the AI interval breakdown asking at low effort with the step table only and saving the answer). It also checks the automatic backup (gzipped with samples and profiles, sent to a mocked server - the test page never writes to your `data\backups` - skipped when nothing changed, restored from a `.json.gz` on the Import zone), that the page loads no internet URLs and Chart.js and both fonts come from the app folder, the FTP history chart (FTP line and change log, proven FTP only when a ride tested it), the drift trend (steady rides only), and the recent-ride insight in the coach prompt and offline advice. It also covers the debugging fixes: a 5-second TCX becomes 1 Hz with its pause kept and a true 1-minute peak, the KICKR distance through a counter reset and a pause, live NP equal to post-ride NP, the interval track redrawn only when the step changes, and a delete triggering the backup. It also checks the power analytics end to end: the CP model from test rides, the log-time power curve with its model line and the W/kg toggle, the CP model card, the zone distribution and polarization index, the CP history, the weekly zones view, the ride plot lanes with W′ balance, the review charts being released on close, and live W′ balance in the cockpit and the phone snapshot. The suite has 107 checks. The calendar checks open the week and month of your latest ride, so they do not depend on today's date; the *Banister PMC* check compares against fixed values from the HealthFit archive, so it drifts as days pass and is the one expected failure.

`node --test tests/power-model.test.js` checks the power maths on its own: the 1 s-4 h curve equals the existing peak maths exactly (pauses, smart recording and gaps included), zone seconds, the CP model on model curves, on realistic rider curves (CP at 90-98 % of the 20-min best) and with submaximal efforts mixed in, W′ balance (depletion, recovery, pauses, matches), TRIMP, the power histogram, quadrant analysis, the 3-zone split and the model history. Run every Node test with `node --test tests/*.test.js`.

`node tests/strava-sync-servers.test.js` starts both local servers (from a temporary copy, with a fake token file - your real `.env` and tokens are never used) against a mock Strava and checks `/api/strava/sync`: paging, detail batches, power streams (data, deleted, rate-limited, bad ids), the `activity:read_all` check, errors, identical answers from both servers, that the sync path only ever sends GET requests to Strava, the backup endpoint (written and read back, non-Apex / non-gzip / wrong type / other websites refused, never served, newest 14 kept, no temp files), and who may connect (pages load on localhost, another site's Host is refused, a client outside the home network is refused even when it claims to be localhost) - 43 checks. The PowerShell part runs when `pwsh` or `powershell` is on the PATH.

## License

Personal use.
