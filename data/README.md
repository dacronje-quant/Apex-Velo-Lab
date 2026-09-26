# APEX VELO LAB — Historical Rides Data Folder

You can place your historical ride files directly into this folder!

### Supported Formats:
1. **`.tcx` (Garmin Training Center XML)**: The universal standard exported by:
   - **Garmin Connect**: Go to any Activity > Gear icon (⚙️) > *Export to TCX*
   - **Strava**: Go to any Activity > Three dots (...) > *Export TCX*
   - **Wahoo SYSTM / ELEMNT**: Export activity as TCX
   - **Zwift**: Download activity file from your Zwift Dashboard
   - **TrainerRoad**: Go to Past Workouts > Ride > *Download TCX*
2. **`.json`**: Complete backup archives exported directly from APEX VELO LAB.
3. **`.csv`**: Second-by-second telemetry files with `Time, Watts, Cadence, HR, Balance`.

---

### How to Import Into the App:
1. Open [index.html](../index.html) in your browser.
2. Go to the **History & Sync** tab.
3. Drag & drop your `.tcx` or `.json` files into the **"Import Historical Rides"** zone (or click **"Choose Files / Data Folder"**).
4. The app will automatically parse the full second-by-second telemetry, compute your **Normalized Power (NP®)**, **TSS®**, **Intensity Factor (IF®)**, update your **Performance Management Chart (CTL/ATL/TSB)**, and refresh your **Power Duration Curve (MMP)** with your real historical bests!
