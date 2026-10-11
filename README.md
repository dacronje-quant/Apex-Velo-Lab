# Apex Velo Lab

An indoor cycling cockpit, AI workout builder and training-analytics dashboard that runs entirely on your own computer. Ride structured ERG workouts with Bluetooth trainers and sensors, import your history, track fitness/fatigue/form, power curves and CP, and (optionally) get workouts and training blocks from Claude, ChatGPT or Gemini.

No account, no cloud service, no subscription. Your rides stay in your browser and on your PC.

## Requirements

### Minimum (try it out, analyse imported rides)

| | |
|---|---|
| **Computer** | Windows 10/11 (nothing to install - uses the built-in PowerShell), **or** macOS / Linux / Windows with [Node.js 18+](https://nodejs.org) |
| **Browser** | Any current Chrome, Edge, Firefox or Safari |
| **Internet** | Only to download the app. Riding, analytics and the offline coach work offline |
| **Cycling hardware** | None - the built-in simulator and **Explore a demo** work without sensors |

### Recommended for indoor riding

| | |
|---|---|
| **Browser** | Desktop **Chrome or Edge** (Web Bluetooth). Firefox and Safari cannot pair sensors |
| **Bluetooth** | Bluetooth 4.0+ (BLE) in the PC or a USB BLE dongle. ANT+ is not supported |
| **Smart trainer** | Any trainer or smart bike with **Bluetooth FTMS** (e.g. Wahoo KICKR, Tacx/Garmin, Elite, Zwift Hub, Saris, JetBlack) for ERG control. Turn off other apps (Zwift, Wahoo app) so they don't hold the connection |
| **Heart-rate strap** | Any Bluetooth heart-rate strap (standard Heart Rate service) |

### Full functionality (optional extras)

| Feature | What you need |
|---|---|
| **Power meter** | Bluetooth power pedals/crank/hub (Cycling Power Service, e.g. Favero Assioma, Garmin Rally, Stages, 4iiii). Used as the true power source, with left/right balance where reported; PowerMatch trims the trainer to it |
| **Fan control** | Wahoo KICKR HEADWIND (Bluetooth) |
| **Phone remote** | A phone or tablet on the **same home Wi-Fi** as the PC (any modern browser; iPhone Safari works). Shows the ride and controls the workout from another room. On Windows, run `Enable-Phone-View.bat` once |
| **AI coach / Ask** | Internet plus your own API key from Anthropic (Claude), OpenAI (ChatGPT) or Google (Gemini). Usage is billed by the provider. Without a key the offline coach is used |
| **Strava** | Internet plus your own free Strava API application (see [setup](docs/LOCAL-SETUP.md#optional-connections)) |
| **Recovery (HRV, resting HR, sleep)** | iPhone with Apple Health and the third-party **Health Auto Export** app (automatic exports need its paid tier), on the same Wi-Fi as the PC |

**Network:** the app is a local server for your PC and your private home network only. Do not port-forward it or expose it to the internet.

## Quick start

1. **Download** - click **Code > Download ZIP** on GitHub (or the latest Release) and extract it, or `git clone` the repository.
2. **Start**
   - **Windows:** double-click **`Launch-Apex-Velo.bat`**. Keep the window open while you use the app.
   - **macOS / Linux / Node.js:** in the folder, run `node server.js --open` (no `npm install` needed).

   The app opens at **http://localhost:8080**. Always use this address - the browser stores your rides per address, so a different port or hostname looks like an empty app.
3. **Set up** - choose **Set up my rider** and enter your FTP, weight and max heart rate, or **Explore a demo** to look around with synthetic rides (kept separate from your own data).
4. **Ride** - open **Devices** in the header, choose a device type and **Pair device**. Next time, **Connect saved devices** reconnects everything. Pick a workout and press **Start**.
5. **Bring your history (optional)** - drop FIT, TCX or CSV files from Garmin, Wahoo, Strava, Apple Watch and others into **History > Import**, or connect Strava.

### Optional: AI coach, Strava, phone

The launcher creates a `.env` file in the app folder the first time it runs (from `.env.example`). Edit it, then restart the launcher:

```
ANTHROPIC_API_KEY=      # and/or OPENAI_API_KEY= / GEMINI_API_KEY=
STRAVA_CLIENT_ID=
STRAVA_CLIENT_SECRET=
```

Keys stay on your PC; the browser never sees them. Step-by-step instructions for each connection, the phone remote and Apple Health are in **[local setup and troubleshooting](docs/LOCAL-SETUP.md)**.

## Your data

- Rides, settings and profiles live in your browser (IndexedDB) at `http://localhost:8080`. The app also writes compressed **automatic backups** to `data/backups` (newest 14). Restore one by dropping it on History's import zone.
- `.env`, Strava tokens and everything in `data/` are git-ignored, so updating never touches them. See [privacy](docs/PRIVACY.md).

## Updating

`git pull` (or extract a new ZIP over the folder, keeping `.env` and `data/`), restart the launcher and press **Ctrl+F5** in the browser.

## Documentation

- [Local setup, connections and troubleshooting](docs/LOCAL-SETUP.md)
- [Full feature reference](docs/FEATURES.md) - cockpit, ERG behaviour, devices, coach, training blocks, Strava sync, phone view, analytics, formulas, architecture
- [Privacy and local data](docs/PRIVACY.md)
- [Maintainer: preparing a release](docs/SHARING.md)
- `tools/` - optional PowerShell helpers to build a ride archive from a HealthFit `.fit` export folder (not needed for normal use)

## Development

`npm test` runs the Node checks. For browser checks: `npm install`, then `npm run test:browser` and `npm run test:suite`. `npm run check:share` scans the tracked files for secrets and private data before a release. See [development checks](docs/LOCAL-SETUP.md#development-checks).

## Licence

[MIT](LICENSE). Bundled libraries and fonts keep their own notices in `vendor/`.

## Support development

Apex Velo Lab is free. If it's useful to you, you can [donate via PayPal](https://paypal.me/divanquant) - entirely optional.
