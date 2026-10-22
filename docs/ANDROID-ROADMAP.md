# Apex Velo for Android: roadmap

From the Capacitor proof of concept (`mobile/`) to an app anyone can install from Google Play.

## Principles

1. **Local-first.** Rides and health data live on the phone. Any cloud piece is opt-in, minimal and revocable.
2. **No developer keys in the default path.** One-tap connections; "bring your own key" stays under Advanced.
3. **The rider's own data in, optional destinations out.** Strava is an upload destination only. History comes from the rider's own files.
4. **The desktop app keeps working.** Root `index.html`, `js/`, `css/` stay shared; Android-only code lives in `mobile/`.

## Data flow

```
 IN (rider-owned)                      OUT (optional)
 Bulk FIT/ZIP import ─┐            ┌─> Strava (upload only, activity:write)
 Watched folder ──────┤            ├─> intervals.icu (FIT upload + planned workouts)
 Share-to-app ────────┼─> Apex ────┼─> Health Connect (write session)
 Health Connect ──────┤   Velo     ├─> Documents/ApexVelo/*.fit
 intervals.icu ───────┘ (on phone) └─> AI (MCP connector, share sheet, on-device)
 Rides recorded in-app
```

Strava data is never read through the API: this avoids Strava's per-app rate limits and its API-agreement
limits on AI use. A rider's full history arrives through their own export files (Strava "Download your data",
Garmin GDPR export, Wahoo/Zwift/Karoo folders, intervals.icu originals).

## Workstreams

| Wave | ID | Workstream | Branch |
|---|---|---|---|
| 0 | - | Roadmap + contracts (this PR) | `feat/android-roadmap` |
| 1 | A | Release foundations: CI release signing from secrets, AAB, versioning | `feat/android-release` |
| 1 | B | Native SQLite store answering `/api/storage/*` on the phone | `feat/android-sqlite` |
| 1 | C | Bulk import (web layer): zip/gz/GPX, sport filter, dedupe, progress | `feat/bulk-import` |
| 1 | D | Strava upload-only | `feat/strava-upload-only` |
| 2 | E | Native import: streaming unzip, watched folder, share target, resumable jobs | `feat/android-native-import` |
| 2 | F | Health Connect read/write | `feat/android-health-connect` |
| 2 | G | Foreground ride service | `feat/android-ride-service` |
| 2 | H | Token broker (Cloudflare Worker) for Strava/intervals.icu OAuth | `feat/token-broker` |
| 3 | UX | UI overhaul: audit, simpler navigation (design approved by owner first), then screen rebuilds and onboarding | `feat/ux-*` |
| 4 | I | AI: share-to-AI, on-device Gemini Nano, MCP connector + opt-in encrypted mirror | `feat/ai-connect` |

Every workstream opens a PR into `claude/android-apk-poc`, is reviewed by a separate reviewer agent, and must
keep the root test suite (`npm test`) and the mobile suites (`cd mobile && npm test && npm run test:browser`) green.

## AI: chosen approach

1. **Share to AI** (no infrastructure): a compact training summary into the ChatGPT / Claude / Gemini app via the Android share sheet.
2. **On-device** Gemini Nano where available, the offline coach otherwise.
3. **Connect your AI account** via a remote MCP server with OAuth: the rider adds "Apex Velo" as a connector in
   Claude or ChatGPT and uses their own subscription. It reads an opt-in, end-to-end-encrypted summary mirror
   (no raw streams), revocable from the app with one tap.
4. Bring-your-own API key stays under Advanced (exists today).

## Owner-only tasks (accounts)

- Release keystore as GitHub secrets (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`).
- Google Play Console, Health Connect permission declaration, Data Safety form, privacy policy URL.
- Strava API application for the app + athlete-limit review.
- Cloudflare account for the broker and MCP server.
