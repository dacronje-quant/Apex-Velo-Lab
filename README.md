# APEX VELO LAB v3

> Indoor cycling cockpit, AI workout builder and training-analytics dashboard in one HTML app, served by a small local server that also holds your Claude and/or Gemini API key.
> Built for Divan (185 W FTP baseline, 75 kg, 175 max HR) with Favero Assioma DUO-Shi pedals and a Wahoo KICKR SHIFT.

## Quick start

1. Double-click **`Launch-Apex-Velo.bat`**. It needs no installs; it runs `start_server.ps1` with Windows PowerShell.
2. On the first run it creates `.env` and opens it in Notepad. Paste your Anthropic API key after `ANTHROPIC_API_KEY=` and/or your Google Gemini key after `GEMINI_API_KEY=`, save, and close Notepad. Chrome then opens at `http://localhost:8080`. Web Bluetooth needs localhost or HTTPS, so use Chrome or Edge.
3. Pair the devices from **Hardware Lab** (the drawer in the header): pedals, trainer and heart-rate strap.
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
- The server listens on localhost only. It accepts API calls only from pages it served (it checks Host and Origin and requires a JSON content type), so other websites cannot use your key.
- Without a key, the coach falls back to the offline engine and says so in the status pill.
- `server.js` is an equivalent Node.js server (`node server.js --open`) for machines without Windows PowerShell. It reads the same `.env` and exposes the same API.

## Backups (automatic)

Your ride history lives in the browser (IndexedDB + localStorage), so clearing Chrome's site data would erase it. The app therefore backs it up **automatically**:

- About 15 s after anything changes the history (a ride saved, an import, a Strava sync, a delete, a profile change), and at least once a day, the app sends the same backup as **Backup JSON** - profiles, workout library and every ride **with its per-second samples** - gzipped, to the local server.
- The server saves it as `data\backups\apex_velo_backup_<date>_<time>.json.gz` and keeps the **newest 14**. An unchanged history is not backed up twice in a day. **Settings (gear icon) > Backups** shows the last backup; **Back up now** makes one immediately. Apple Health recovery days are included in every backup.
- **Restore:** drop a backup file (`.json.gz` or `.json`) on the **Import** zone in History. Rides already in the history are skipped; you are asked whether to restore the rider profiles too.
- Only the app opened **on this PC** can write backups (not a phone on the Wi-Fi, not another website), only real Apex Velo Lab backups are accepted, and the folder is **never served** by the web server. `data/backups/` is git-ignored.
- Want an off-PC copy? Point OneDrive / Google Drive at the `data\backups` folder, or copy a file to a USB stick now and then.

## Settings

The **gear icon** in the header opens Settings - everything you set up once:

- **Rider** - FTP, weight, max / threshold heart rate (opens the rider profiles).
- **AI engine** - Claude or Gemini, model and reasoning effort (low by default).
- **Apple Health** - live status, the address and token for Health Auto Export, and the setup steps with your PC's address filled in.
- **Backups** - last automatic backup and **Back up now**.
- **Phone view** - the address to open on your phone.

## Apple Health: resting HR, HRV and sleep (Health Auto Export)

Your Apple Watch's **resting heart rate**, **HRV** (Apple's SDNN, in ms) and **sleep** reach the app through the **Health Auto Export** iPhone app, which posts them to this PC. They drive the daily **readiness**, the **calendar recovery strip** and the resting HR / HRV trends in Analytics. Nothing is uploaded anywhere else.

**Setup (about 2 minutes, once):**
1. Phone view must be enabled (`Enable-Phone-View.bat`, see below) - the iPhone talks to the PC over your home Wi-Fi. Tip: give the PC a fixed address in your router (DHCP reservation) so the URL never changes.
2. In the app open **Settings > Apple Health** and copy the **URL** (e.g. `http://192.168.1.23:8080/api/health`) and the **token**.
3. On the iPhone install **Health Auto Export** (automations need its Premium tier) and allow it to read *Resting Heart Rate*, *Heart Rate Variability* and *Sleep Analysis*.
4. **Automations > New automation > REST API**: paste the URL; add a header `Authorization` = `Bearer <token>`; data type **Health Metrics** with those three metrics; format **JSON** (version 2); date range **Since last sync** (the first time: the last 60 days, so readiness has a baseline straight away); sync **every hour**; turn it on. If iOS asks to find devices on your local network, tap **Allow**.
5. Tap **Manual export**, then **Check now** in Settings - *Last received* updates.

**How it works.** The server only stores what arrives (`data\health\inbox`, never served, git-ignored) - after checking the token; the app on the PC collects it at start-up, every 10 minutes and when Settings opens, folds it into one record per day and then lets the server delete the payloads. Every reading is keyed by its own timestamp (sleep by stage and start/end), so hourly exports that overlap, or the same data sent twice, never count twice. A new token (Settings) stops the old one working. Missed days fill in on the next sync (the phone must be on home Wi-Fi and the PC server running).

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
   **New** (will be imported) · **Linked** (already in the app, only a link is added) · **Refreshed** (edited on Strava) · **Removed** (deleted on Strava) · **Merged Strava duplicates** · **Needs review** (possible duplicates).
3. Press **Apply** to write it, or **Cancel**. **Undo last sync** (with the time of that sync) puts everything back.

**Refresh semantics.** A sync is a complete, repeatable refresh of the chosen range:
- Records imported from Strava (source *Strava*) inside the range are rebuilt from what Strava returns now: updated when you edited them on Strava (name, description, calories...), added when new, and removed from the app **only** when they no longer exist on Strava. Removals are listed in the preview and need Apply.
- Records outside the range are never touched.
- Rides recorded in this app are never removed; their Strava links are re-checked (a link to a deleted activity is reported, not changed).
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

The phone has four screens; swipe sideways or tap the tabs, and it remembers the last one:

- **Focus** - the current step and countdown, **5 s average power** against target, a 2-minute power trace, heart rate and cadence.
- **Session** - % complete and time left, the whole workout as zone-coloured blocks with a gliding playhead, avg power, heart rate, cadence and distance.
- **Balance** - live L/R split from the pedals, a 2-minute balance trace with its average, cadence and power source.
- **Pedal** - the pedal-stroke polar view: lobe split = measured L/R balance, size = measured power vs FTP, rotation = measured cadence. The lobe shape itself is a model (labelled MODEL) - the pedals don't send force per crank angle.

Before you press Start (and while paused) the phone already shows live heart rate, power and cadence from connected devices; nothing is recorded until the ride runs.

A thin zone-coloured bar of the whole workout sits above the controls on every screen, with a needle showing where you are. The controls stay at the bottom of every screen, sized for sweaty fingers (60 px targets): **Start/Pause**, **-5 W / +5 W** (the middle shows the change from the plan in watts - tap it to go back to the plan), **Stand 30s** and **Skip step** (tap twice to confirm). When a workout ends, the phone shows the **+5 min easy spin** offer with giant buttons too. Keep the Apex tab open on the PC (it can be minimised). Only devices on your private home network are accepted; anything else gets 403.

**No visible lag.** The PC pushes every ride second to the phone the moment it happens, and the phone keeps a request open that the server answers as soon as the new data arrives (long-poll), so the phone shows each update about 10-20 ms after the PC. Taps on the phone reach the PC just as fast: the PC keeps its own request open for commands, and each command is confirmed by the PC so it is never lost or applied twice.

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
- **PowerMatch.** In ERG mode the trainer target is trimmed by the pedal/trainer error. The trim is capped at ±45 W and moves at most 2 W/s. The Hardware Lab drawer shows the live trim.
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
- **BLE resilience.** Each device has its own connection slot and a serialised write queue. A first connection is tried up to 3 times (Windows often rejects the very first GATT connection to a Polar strap or power meter) and times out after 15 s instead of hanging; if it still fails, the toast gives the real reason and what to check. After an unexpected link loss mid-ride the app reconnects with exponential backoff (1 s, 2 s, 4 s … capped at 30 s, ±15% jitter, 8 attempts).
- **Live device preview.** As soon as a device connects, its live values show in the cockpit (and Zen mode) before you press Start, while paused and after a ride: heart rate and HR zone from the strap, and power, W/kg, cadence and L/R balance from the pedals (or the KICKR). This is display only: nothing is recorded, and the ride clock, averages, NP/TSS and distance do not move until you start. A device that stops sending shows `--` again.
- **Ride safety.** The screen is kept awake while riding (Screen Wake Lock), and closing or reloading the tab during a ride asks first.
- **Hardware Lab drawer.** Shows battery, RSSI, link state, the commanded ERG watts and the PowerMatch trim for each device. RSSI appears only where the browser supports `watchAdvertisements`; otherwise it shows `--`.
- **Pedal calibration.** A 3-second countdown, then the CPS **Start Offset Compensation (op code 0x0C)**. A toast shows the offset the pedals return, and the last offset is kept.
- **Drift-free clock.** A Worker-driven 1 Hz tick keeps timing accurate when the tab is in the background and resyncs after sleep.
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
One **time range for the whole page** (6 weeks, 3 months, 6 months, 1 year, All).
- **Today strip:** readiness, form (TSB) with its zone, fitness (CTL) and fatigue (ATL), **ramp rate** (CTL gained in 7 days - above ~7/week is flagged as injury/illness risk) and FTP with W/kg.
- **Progression tiles** - value, trend sparkline over the range and change vs 6 weeks ago (green = the good direction): FTP, fitness (CTL), **efficiency factor**, 20-min peak (best in 90 days), resting HR and HRV (30-day averages).
- **Fitness & load:** the PMC (coloured form bands, daily TSS bars, tooltips and a form badge: Fresh, Productive, Optimal, High Fatigue or Overtraining) and weekly TSS / hours / kJ / rides with a 4-week average and KPIs vs the previous period; click a week to list its rides.
- **Aerobic engine:** **efficiency factor** (NP / average HR) of steady aerobic rides only (Z2 to tempo, VI <= 1.06, 20 min+) with a 30-day average line - rising = more watts per heartbeat; the **Pw:HR decoupling trend**; and **resting HR & HRV** (7-day averages, from Apple Health).
- **Power:** a **power profile** (5 s, 1 min, 5 min, 20 min) - best of the last 90 days vs the 90 days before, W/kg, and a **PR** badge only when it beats everything before (HealthFit archive included); the power-duration curve with the scrub tool (all-time curve from your FIT archive merged with rides recorded here); and **FTP history & monthly peak NP** (bars: highest-NP ride per month; amber line: the FTP in use and your logged FTP changes; green triangles: months where a ride proved an FTP within 5 % of yours or above).
- **Pedal balance:** average left-leg % per ride, measured by the pedals.
- **Explore** (collapsed): intensity mix, the records board (best NP, longest ride, biggest TSS, most kJ, best week, streak) and every ride as NP vs duration.
- **Ride review.** Each ride opens in a modal with a completion banner, comparisons against the last 90 days, peaks versus PRs, time in zone, interval execution, a scrub chart and prev/next navigation. Plus: the **longest stretch held on target** (+/-5 %, 3 s power), **cadence & average torque** (N·m while pedalling), and **heart-rate recovery**: the bpm drop in the 60 s after each hard effort that took HR to 85 % of max or more, flagged when it slows on later repeats (you keep pedalling in ERG, so compare repeats within a ride, not rides).
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
  velo-sound.js, velo-pip.js, velo-folder-sync.js
  app.js              Orchestrator: state, tick loop, cockpit, Zen, BLE events, calibration
  app-analytics.js    PMC, MMP, FTP and weekly progression charts, page range (mixin)
  app-dashboard.js    Analytics dashboard: today strip, tiles, power profile, EF / recovery / balance charts (mixin)
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
live.html             Phone view (four screens, remote controls)
Enable-Phone-View.bat One-time firewall/URL setup for the phone view (`remove` undoes it)
```

**Helper scripts** (run by hand in PowerShell, not by the app):
- `parse_healthfit.ps1` - builds `data/divan_cycling_history.json` from your HealthFit `.fit` exports; `create_js_data.ps1` wraps that JSON into the `.js` file the app loads.
- `compute_mmp.ps1` - computes the all-time power curve (MMP) from the same `.fit` files.
- `test_header.ps1 <file.fit>` - prints a FIT file's header, for debugging an import.
- `fix_all_mojibake.ps1` - a one-off repair script from the original conversion to UTF-8. The files are already clean and it no longer parses; **do not run it**.

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

## Tests

Open `test_suite.html`. It covers metrics, a FIT CRC round-trip, TCX/CSV round-trips, summary-only exports, the CPS 0x0C command, BLE reconnect with a fake device, write serialisation, PMC ranges, progression, the MMP scrub, the AI goals and week plan, Zen thresholds, resource lifecycle, the clock, calendar bucketing and the device badges. It also checks the Claude path with a mocked `/api/coach` (request shape, reasoning parsing, fallback), switching between Claude and Gemini, auto session duration, the history look-back window, training blocks (3:1 structure, 48 h between key sessions, hours respected, calendar cards, post-ride adjustments), the ERG governor (soft start, anti-stall, HIIT-safe step lead, PowerMatch), and that no API key is stored in the browser. It also checks Polar H10 contact handling, first-connect retries, that a real ride never falls back to simulator data, and that the tests leave your real storage untouched. It also checks the Send to Strava flow with a mocked Strava (upload, processing, sent link, failure, history chip, workout image, and matching rides that already exist on Strava). It also checks **Sync from Strava** with Strava mocked (nothing leaves the machine): the preview writes nothing; only GET requests go out; Apply writes a restore point first and then writes once; Undo restores byte-identical storage; app-recorded rides are unchanged and the Calendar renders the same rides before and after; the three dedupe layers (id skip, fuzzy link, Motra/watch merge), possible matches never auto-imported, decisions remembered; refresh (Strava edit updates, Strava delete removes only that record, out-of-range records untouched, second sync = no changes); custom ranges; a timezone-mislabelled HealthFit ride matched while the same ride 3 h later is not; strength on the Calendar but excluded from power analytics and counted in fatigue; the training block and coach prompts; a simulated failure at every stage of Apply leaves storage unchanged; and the real-storage-untouched check. It also checks the power streams: 1 Hz conversion (short gaps held, pauses dropped), TSS from the stream, streams fetched only for power-meter rides, a rate-limited sync adding them later, exact Undo after streams were added or removed, imports never sent back to Strava; the background check (read-only, no streams, badge, off switch); and a real threshold HR replacing the estimate. It also checks the ride-time extras (Stand break without tripping anti-stall, exact +/-5 W from the phone, the +5 min easy spin offer - accept, finish, timeout - with the library workout untouched, and the server accepting the new phone commands) and the post-ride insight (decoupling only on steady rides, gold/silver/bronze medals against earlier rides, the FTP suggestion rules and its one-click update, and the AI interval breakdown asking at low effort with the step table only and saving the answer). It also checks the automatic backup (gzipped with samples and profiles, sent to a mocked server - the test page never writes to your `data\backups` - skipped when nothing changed, restored from a `.json.gz` on the Import zone), that the page loads no internet URLs and Chart.js and both fonts come from the app folder, the FTP history chart (FTP line and change log, proven FTP only when a ride tested it), the drift trend (steady rides only), and the recent-ride insight in the coach prompt and offline advice. It also covers the debugging fixes: a 5-second TCX becomes 1 Hz with its pause kept and a true 1-minute peak, the KICKR distance through a counter reset and a pause, live NP equal to post-ride NP, the interval track redrawn only when the step changes, and a delete triggering the backup. The suite has 93 checks. The calendar checks open the week and month of your latest ride, so they do not depend on today's date; the *Banister PMC* check compares against fixed values from the HealthFit archive, so it drifts as days pass and is the one expected failure.

`node tests/strava-sync-servers.test.js` starts both local servers (from a temporary copy, with a fake token file - your real `.env` and tokens are never used) against a mock Strava and checks `/api/strava/sync`: paging, detail batches, power streams (data, deleted, rate-limited, bad ids), the `activity:read_all` check, errors, identical answers from both servers, that the sync path only ever sends GET requests to Strava, the backup endpoint (written and read back, non-Apex / non-gzip / wrong type / other websites refused, never served, newest 14 kept, no temp files), and who may connect (pages load on localhost, another site's Host is refused, a client outside the home network is refused even when it claims to be localhost) - 43 checks. The PowerShell part runs when `pwsh` or `powershell` is on the PATH.

## License

Personal use.
