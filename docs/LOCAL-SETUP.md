# Run Apex Velo Lab on your own computer

Apex is a local app for experimenting with cycling workouts and analytics. You do not need an account, a hosted service, an AI key or a trainer to explore it.

## Start

Download the repository ZIP and extract it, or clone the repository. On Windows, double-click `Launch-Apex-Velo.bat`. Windows PowerShell starts the server and opens the app at `http://localhost:8080`. Keep the terminal open while using the app. The launcher creates `.env` only when it does not exist; it never replaces your settings.

On macOS, Linux or Windows with Node.js 18 or later, run `node server.js --open` from the extracted folder. No `npm install` is needed to run the app. If the browser does not open, visit `http://localhost:8080` yourself.

Use desktop Chrome or Edge for Web Bluetooth. Browser/platform support varies; the simulator and file imports work without Bluetooth. Phone Safari can display the remote view; it does not pair trainers itself. Launching a browser does not guarantee Bluetooth permission: pairing still requires a browser prompt.

## First ride or experiment

1. Select **Set up my rider**. Replace the placeholder FTP, weight and maximum heart rate. Optional threshold HR and crank length can be left blank.
2. Choose a workout. Without connected hardware it uses the simulator; no real measurements are implied.
3. For real riding, open **Devices**, pair supported sensors and an FTMS trainer. Trainer control stays in ERG.
4. Import FIT, TCX, CSV or an Apex backup in **History**. A synthetic TCX is available at `data/sample_sweetspot_ride.tcx`; importing it is optional.

**Explore a demo** opens `?apexDemo=1`, with clearly synthetic rides. It uses in-memory settings and a separate `ApexVeloDB_demo` database. Reloading resets demo settings. Demo server requests and Bluetooth pairing are blocked. **Return to my app** returns to your real storage.

## Optional connections

**AI:** edit your own `.env`, add an Anthropic or Gemini key and restart the server. Keys stay server-side. Without a key, the local workout and plan engines remain available. Leaving weekly hours blank specifically delegates hours to AI and needs a successful AI response; enter hours to generate a local plan. AI requests send the selected training and recovery context to the chosen provider; Ask also sends your question and conversation context. Provider usage may incur charges.

**Strava:** create your own personal Strava API application, with `localhost` as its callback domain. Put your client ID and secret in `.env`, restart, and use **Connect Strava**. Everyone uses their own application and tokens; no maintainer credentials are supplied. Public integrations have different approval requirements; this repo does not operate one.

**Apple Health:** optional **Health Auto Export** on the iPhone uploads Heart Rate, Resting Heart Rate, Heart Rate Variability and Sleep Analysis. Follow **Settings > Apple Health** for the URL, bearer token and JSON setup. Automated exports require that third-party app's supported automation tier. The phone must reach the running computer on the same trusted network. Background delivery depends on iOS and the exporter; it is not a guaranteed hourly feed. Use **Manual export**, then **Check now**, to diagnose a missing day. Readiness needs an HRV baseline; absent data is not a sign of good recovery. Google Fit and Android Health Connect are not built-in connections.

**Phone remote:** on Windows, run `Enable-Phone-View.bat` once if needed, then restart the launcher. Open the address in **Settings > Phone view** on the same trusted Wi-Fi. Other devices on that LAN can access the remote and allowed controls. Keep the PC app on `localhost`; private health/archive management is available only there. Do not port-forward this local server or expose it through a public tunnel.

## Data, backups and updates

Use the same browser profile and `http://localhost:8080` every time. Changing the hostname, port or browser gives a different storage area. Rides and samples live in IndexedDB; settings and recovery days also use browser storage. Automatic compressed backups are stored under `data/backups` (newest 14); use **Back up now** before changing computer or clearing browser data. Restore an Apex backup from History's import zone.

An update keeps existing rider profiles, rides, health data and device settings. The legacy private archive is still recognised. Optional `data/local-history.json` is loaded only by the PC app; **Merge local archive** adds missing rides without replacing current records. No archive is supplied to new users. The older private archive filenames remain supported without rewriting those files.

For a Git checkout, run `git pull` from the folder, then restart the server and refresh the browser. When updating a ZIP install, copy new app files over the existing folder while retaining your `.env`, token files and `data` directory. Browser storage remains at the same address. Export a backup first.

## Troubleshooting

- **Port in use:** close the older Apex terminal first. Check which app owns port 8080 before using another port; a new port has separate browser storage.
- **Empty history after an update:** check the exact browser, profile, hostname and port. Restore a backup rather than clearing storage.
- **Health storage full:** server exports remain queued. Export a backup, free browser capacity and retry. Do not delete browser data without a verified backup.
- **Health inbox full:** collect existing exports on the PC, then resend. The server rejects additional exports instead of silently deleting unread ones.
- **Bluetooth unavailable:** use desktop Chrome/Edge at localhost, enable OS Bluetooth, wake sensors and disconnect competing apps. Hardware/firmware support still needs checking on your equipment.
- **No AI response:** verify your own key, provider/model access and network. Local riding is still available.

## Development checks

`npm test` runs the Node checks. Browser checks need the optional development dependency: `npm install`, then `npx playwright install chromium` where required. Windows uses installed Edge by default; set `APEX_BROWSER_CHANNEL` to choose another installed channel. Run `npm run test:browser` for new/existing installations and demo isolation, and `npm run test:suite` for the broader browser suite. Both use temporary or isolated storage and synthetic fixtures. `npm run check:share` checks the tracked working-tree contents for common private files and credential patterns; it does not certify Git history.
