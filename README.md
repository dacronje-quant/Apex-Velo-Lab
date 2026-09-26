# APEX VELO LAB v3

> Indoor cycling cockpit, AI workout builder and training-analytics dashboard in one HTML app, served by a small local server that also holds your Claude API key.
> Built for Divan (185 W FTP baseline, 75 kg, 175 max HR) with Favero Assioma DUO-Shi pedals and a Wahoo KICKR SHIFT.

## Quick start

1. Double-click **`Launch-Apex-Velo.bat`**. It needs no installs; it runs `start_server.ps1` with Windows PowerShell.
2. On the first run it creates `.env` and opens it in Notepad. Paste your Anthropic API key after `ANTHROPIC_API_KEY=`, save, and close Notepad. Chrome then opens at `http://localhost:8080`. Web Bluetooth needs localhost or HTTPS, so use Chrome or Edge.
3. Pair the devices from **Hardware Lab** (the drawer in the header): pedals, trainer and heart-rate strap.
4. To run the test suite, open `http://localhost:8080/test_suite.html`. It should end with `COMPLETED` and 0 failures. The tests run the app in an isolated test mode (in-memory settings and a separate test database), so they never touch your recorded rides.

Keep the port at 8080. The browser stores your rides and settings per address, so a different port starts with an empty history.

## AI Coach engine and your API key

- The local server serves the app and forwards coach requests from `/api/coach` to the Claude API. It reads the key from `.env`, or from an `ANTHROPIC_API_KEY` environment variable, which takes priority. The key never reaches the browser, is never written to `localStorage`, and `.env` is never served.
- `.env` is listed in `.gitignore`. If you prefer not to keep the key in a file, set it as a Windows user environment variable (`setx ANTHROPIC_API_KEY "sk-ant-..."`, then open a new window) and leave the `.env` line empty.
- The default is **Claude Opus 5.5 at low effort**, with adaptive thinking and a summarised reasoning trace shown in the app. Change it for every browser in `.env` (`APEX_COACH_MODEL`, `APEX_COACH_EFFORT`), or per browser in **Coach > Claude engine**. Sonnet 5 costs about half as much; Haiku 4.5 is the fastest option.
- The server listens on localhost only. It accepts API calls only from pages it served (it checks Host and Origin and requires a JSON content type), so other websites cannot use your key.
- Without a key, the coach falls back to the offline engine and says so in the status pill.
- `server.js` is an equivalent Node.js server (`node server.js --open`) for machines without Windows PowerShell. It reads the same `.env` and exposes the same API.

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

## Phone view (ride in another room)

The PC keeps the Bluetooth sensors and runs the ride; your phone becomes a live screen and remote.

1. **One time:** double-click `Enable-Phone-View.bat` and click **Yes** on the Windows prompt. It lets the server listen on your home network and opens the port in Windows Firewall for *private* networks only. Your home Wi-Fi/Ethernet must be set to **Private network** in Windows settings. (Undo any time: `Enable-Phone-View.bat remove`.)
2. Start `Launch-Apex-Velo.bat` as usual and open the app on the PC. The console window prints the phone address, e.g. `http://192.168.1.23:8080/live.html`.
3. On the iPhone (same Wi-Fi, not mobile data) open that address in Safari, then **Share > Add to Home Screen** for a full-screen "Apex Live" icon.

The phone has three screens; swipe sideways or tap the tabs, and it remembers the last one:

- **Focus** - the current step and countdown, power against target, a 2-minute power trace, heart rate and cadence.
- **Session** - % complete and time left, the whole workout as zone-coloured blocks with a gliding playhead, avg power, NP, TSS and kJ.
- **Balance** - live L/R split from the pedals, a 2-minute balance trace with its average, cadence and power source.

The controls stay at the bottom of every screen: **Start/Pause**, nudge **ERG +/-1%**, reset ERG, and **Skip step** (tap twice to confirm). Keep the Apex tab open on the PC (it can be minimised). Only devices on your private home network are accepted; anything else gets 403. iPhone Safari cannot keep the screen awake over plain http, so set Settings > Display & Brightness > Auto-Lock to Never while riding (or just tap the screen now and then).

## Security & privacy

- **Secrets live only in `.env`** (Anthropic key, Strava client secret) and `.strava-tokens.json`; both are git-ignored and the local server refuses to serve any dot-file, `.git`, the server scripts or helper scripts. The browser never sees a key.
- **The server only answers this PC and devices on your private home network** (10.x, 172.16-31.x, 192.168.x). Requests from any other address or from other websites are refused (403). Do **not** forward port 8080 on your router - the app is not meant to be reachable from the internet.
- `Enable-Phone-View.bat` opens the port in Windows Firewall for **Private** networks only; `Enable-Phone-View.bat remove` undoes it.
- Personal ride history (`data/divan_cycling_history.*`) is git-ignored; run `parse_healthfit.ps1` to build your own from HealthFit `.fit` exports (set `HEALTHFIT_DIR` if they are not in `Downloads\HealthFit\HealthFit`).

## Data integrity rules

- **No placeholders.** Nothing is synthesised: no sine waves, no mock PRs and no default cadence, HR or balance. A channel that was not recorded shows `--` in the UI and is left out of the exports.
- **Source hierarchy.** The Assioma pedals (CPS 0x1818) are ground truth for power, cadence and L/R balance. The KICKR (FTMS 0x1826) supplies speed, distance and ERG control. When the pedals are absent, the trainer's power takes over, and the power-source badge in the cockpit shows which device is live.
- **PowerMatch.** In ERG mode the trainer target is trimmed by the pedal/trainer error. The trim is capped at ±45 W and moves at most 2 W/s. The Hardware Lab drawer shows the live trim.
- **The simulator never touches a real ride.** It switches off as soon as a device connects, and once a ride has used real hardware a dropout is recorded as no power (`NONE`), never filled with simulated values.
- **Heart rate.** A strap reporting no skin contact or 0 bpm (a Polar H10 does this while the electrodes are dry) shows `--` and is not recorded; the last value is never frozen on screen.

## Features

### Riding
- **Cockpit.** Tabular-mono telemetry with no numeric jitter. The interval track is a HiDPI canvas with a 60 fps interpolated playhead, Coggan Z1–Z7 colours, hover tooltips and click-to-jump. Smoothing pills are 1 s, 3 s, 5 s and 10 s.
- **Zen mode.** A halo shows target compliance: lime within ±5%, amber under, cyan over. There is an optional cadence halo and a heart-rate strain gauge. Toggle with `H`.
- **BLE resilience.** Each device has its own connection slot and a serialised write queue. A first connection is tried up to 3 times (Windows often rejects the very first GATT connection to a Polar strap or power meter) and times out after 15 s instead of hanging; if it still fails, the toast gives the real reason and what to check. After an unexpected link loss mid-ride the app reconnects with exponential backoff (1 s, 2 s, 4 s … capped at 30 s, ±15% jitter, 8 attempts).
- **Ride safety.** The screen is kept awake while riding (Screen Wake Lock), and closing or reloading the tab during a ride asks first.
- **Hardware Lab drawer.** Shows battery, RSSI, link state, the commanded ERG watts and the PowerMatch trim for each device. RSSI appears only where the browser supports `watchAdvertisements`; otherwise it shows `--`.
- **Pedal calibration.** A 3-second countdown, then the CPS **Start Offset Compensation (op code 0x0C)**. A toast shows the offset the pedals return, and the last offset is kept.
- **Drift-free clock.** A Worker-driven 1 Hz tick keeps timing accurate when the tab is in the background and resyncs after sleep.

### AI workout builder
- **Goals:** FTP, Longevity (Z2/durability), VO2max and Balanced.
- **Context from your real history.** 28-day hours per week, intensity mix, CTL/ATL/TSB, days since the last hard and last long ride, and a power-profile type from your all-time MMP curve. Free-text notes are passed through as well.
- **Claude (Opus 5.5, low effort by default).** The summarised reasoning trace is rendered as markdown with a live timer, alongside phase cards and a 7-day plan that ramps CTL, drops the ramp to 0 when fatigued and never stacks hard days within 48 h. Click a day of the plan to pre-fill the request.
- **Offline engine.** Builds a workout sized to the requested duration: sweet-spot blocks, threshold under/overs, 4×4 VO2 or Rønnestad 30/15. IF and TSS are computed from the intervals, not estimated.
- **One-click load** into the cockpit, and **Clear Recommendation**.

### Analytics
- **PMC** with 30d, 90d, 180d, YTD and All ranges. Coloured form bands, daily TSS bars, tooltips (date, CTL, ATL, TSB, TSS) and a form badge: Fresh, Productive, Optimal, High Fatigue or Overtraining.
- **Progression dashboard.** Weekly TSS, hours, kJ or rides with a 4-week average; click a week to list its rides. KPIs with the change from the previous period, the intensity mix, a personal-records board (best NP, longest ride, biggest TSS, most kJ, best week, streak) and an NP-vs-duration scatter.
- **MMP.** The all-time curve comes from your real FIT archive (`compute_mmp.ps1`) merged with rides recorded here. The scrub slider compares the PR with the live ride at each duration.
- **Ride review.** Each ride opens in a modal with a completion banner, comparisons against the last 90 days, peaks versus PRs, time in zone, interval execution, a scrub chart and prev/next navigation.
- **Biomechanics.** Drawn only from measured power and balance, using spring animations. Real CPS hardware does not report torque effectiveness or pedal smoothness, so those charts stay empty and are labelled "NOT REPORTED BY CPS". In simulator mode they are labelled "SIMULATOR MODEL".
- **Exports.** FIT (binary, CRC-checked, per-second records including L/R balance), TCX (with TPX extensions) and CSV (with a named header, which the importer reads back). Rides that have only summary data export only a summary.
- **Calendar.** Rides are bucketed by local date. It shows YTD monthly bars and all-time totals.

## Architecture

```
index.html            App shell, SVG icon sprite, all views
Launch-Apex-Velo.bat  Double-click launcher (creates .env, asks for the key once, starts the server)
start_server.ps1      Local server (PowerShell): static files, /api/coach (Claude) and /api/strava/* (keys stay here)
server.js             Same server for Node.js (optional)
.env.example          Template for .env (API key, coach model/effort, port)
css/style.css         Design system (obsidian/slate tokens, glass surfaces, responsive breakpoints)
sw.js                 Network-first service worker (cache apex-velo-cache-v4, never caches /api/)
data/                 divan_cycling_history.json/.js - HealthFit archive + all-time MMP
js/
  velo-metrics.js     Pure maths: zones, NP/IF/TSS, MMP, form bands, backoff, compliance
  velo-db.js          IndexedDB persistence
  velo-ble.js         Web Bluetooth: CPS, FTMS, HRS, battery, RSSI, reconnect, write queues
  velo-clock.js       Worker-based drift-free 1 Hz clock
  velo-sim.js         Hardware simulator
  velo-analytics.js   Rolling MMP, PMC history
  velo-progress.js    Weekly aggregates, KPIs, records, coach profile
  velo-importer.js    FIT / TCX / CSV import (recorded channels only)
  velo-export.js      FIT / TCX / CSV export
  velo-ai-coach.js    Goals, context, offline engine, week plan, Claude prompt
  velo-ai-architect.js, velo-workouts.js  Workout library and builder
  velo-biomech.js     HiDPI biomech canvas with spring animation
  velo-sound.js, velo-pip.js, velo-folder-sync.js
  app.js              Orchestrator: state, tick loop, cockpit, Zen, BLE events, calibration
  app-analytics.js    PMC, MMP, progression and biomech charts (mixin)
  app-history.js      History, ride review, exports, calendar (mixin)
  app-coach.js        Coach UI and markdown renderer (mixin)
  app-strava.js       Send to Strava: upload, status per ride, workout image (mixin)
test_suite.html       In-browser test suite
```

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

- **NP** = (mean of the 30 s rolling average^4)^(1/4)
- **IF** = NP / FTP
- **TSS** = (seconds × NP × IF) / (FTP × 3600) × 100
- **CTL**ₜ = CTLₜ₋₁ + (TSSₜ − CTLₜ₋₁) / 42; **ATL** uses the same formula with 7 in place of 42.
- **TSB** = CTL − ATL. Form bands: > 5 Fresh, > −10 Productive, > −25 Optimal, > −40 High Fatigue, otherwise Overtraining.
- **Work (kJ)** = Σ P·Δt / 1000; energy in kcal ≈ kJ (assuming about 24% gross efficiency).
- **Planned CTL ramp:** daily TSS ≈ CTL + 6 × ramp per week.

## Tests

Open `test_suite.html`. It covers metrics, a FIT CRC round-trip, TCX/CSV round-trips, summary-only exports, the CPS 0x0C command, BLE reconnect with a fake device, write serialisation, PMC ranges, progression, the MMP scrub, the AI goals and week plan, Zen thresholds, resource lifecycle, the clock, calendar bucketing and the device badges. It also checks the Claude path with a mocked `/api/coach` (request shape, reasoning parsing, fallback) and that no API key is stored in the browser. It also checks Polar H10 contact handling, first-connect retries, that a real ride never falls back to simulator data, and that the tests leave your real storage untouched. It also checks the Send to Strava flow with a mocked Strava (upload, processing, sent link, failure, history chip, workout image, and matching rides that already exist on Strava). The current result is **72 passed, 0 failed**.

## License

Personal use.
