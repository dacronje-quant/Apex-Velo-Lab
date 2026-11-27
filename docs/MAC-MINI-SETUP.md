# Home Server, Tailscale & Mac mini Setup

Run one canonical Apex Velo Lab server on your home PC today (or an always-on Mac mini later) so every desktop browser and your Android APK stay in sync over your private Tailscale network.

## Part 1: Use your Windows PC + Tailscale today

1. **Tailscale prerequisites:**
   - Install Tailscale on your **Windows PC**, **Android phone**, and **iPhone** (if you use Apple Health).
   - In the Tailscale Admin Console -> **DNS**, enable **MagicDNS** and **HTTPS Certificates**.

2. **Enable Tailscale mode in `.env`:**
   Open `.env` in the Apex Velo Lab folder and set:
   ```env
   APEX_ALLOW_TAILSCALE=1
   APEX_TAILSCALE_HOST=your-pc-name.your-tailnet.ts.net
   ```
   Restart `Launch-Apex-Velo.bat` (or `node server.js`).

3. **Serve over private HTTPS:**
   ```powershell
   tailscale serve --bg http://127.0.0.1:8080
   ```
   - Chrome/Edge on any PC on your Tailnet can now open `https://your-pc-name.your-tailnet.ts.net` (Web Bluetooth works over HTTPS!).
   - In **Settings > Sync**, copy the pairing link or scan the QR code into the Android APK (**You > Connections > Home server**).

4. **AI keys & Apple Health:**
   - Put your `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and/or `OPENAI_API_KEY` in `.env` on the server. When **Use Home Server's AI keys when reachable** is enabled on Android, the APK uses those keys automatically over Tailscale and falls back to any local keys you entered on Android if offline.
   - Point **Health Auto Export** on your iPhone to `https://your-pc-name.your-tailnet.ts.net/api/health` (shown in **Settings > Apple Health**). Apple Health stays the primary recovery source; Android's Health Connect and `intervals.icu` stay in `wellness_days` as backup without mixing SDNN and rMSSD HRV scales.

---

## Part 2: Move to an always-on Mac mini (5 minutes)

1. **Install prerequisites on the Mac mini:**
   - Install **Node.js 24+** (`brew install node@24` or nodejs.org).
   - Install **Tailscale** (Standalone macOS installer recommended so it connects before login) and sign into your Tailnet.
   - Clone or copy the `Apex-Velo-Lab` folder to the Mac mini (for example `~/Apex-Velo-Lab`).

2. **Copy your existing data & `.env`:**
   - Stop the Windows Apex Velo server first.
   - Copy `%LOCALAPPDATA%\ApexVeloLab\apex.sqlite` from Windows to `~/.local/share/ApexVeloLab/apex.sqlite` on macOS (create the directory if needed).
   - Copy your `.env` file to `~/Apex-Velo-Lab/.env` and update `APEX_TAILSCALE_HOST` to your Mac mini's `.ts.net` name.
   - Optional: set `APEX_BACKUP_MIRROR_DIR=/Users/<your-username>/Library/Mobile Documents/com~apple~CloudDocs/ApexVeloBackups` in `.env` so verified `.json.gz` backup snapshots mirror to iCloud Drive automatically (use an absolute path rather than `~`).

3. **Start automatically on boot (`launchd`):**
   ```bash
   cd ~/Apex-Velo-Lab
   chmod +x scripts/macos/install-service.sh
   ./scripts/macos/install-service.sh
   sudo pmset -a sleep 0 disksleep 0 autorestart 1
   tailscale serve --bg http://127.0.0.1:8080
   ```

4. **Point your devices to the Mac mini:**
   - On your Windows PC/laptop: bookmark `https://your-mac-mini.your-tailnet.ts.net`.
   - On your Android APK: open **You > Connections > Home server**, update the URL/token from **Settings > Sync**, and tap **Save & test**.
   - On your iPhone (Health Auto Export): update the REST URL to `https://your-mac-mini.your-tailnet.ts.net/api/health` (and token if you generated a new one).
