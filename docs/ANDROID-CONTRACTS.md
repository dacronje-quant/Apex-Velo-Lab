# Android workstream contracts

Shared rules every Android workstream codes against, so parallel branches fit together.

## Layering

- `mobile/src/native-*.js`: the Android layer (ES modules, bundled by `mobile/scripts/build-web.cjs`).
  Each module exports a class taking its dependencies (`http`, `prefs`, plugins) in the constructor so tests can
  inject fakes (see `mobile/tests/fake-native.js`). Wire new modules in `mobile/src/index.js` and expose them on
  `window.ApexNative`.
- Native Kotlin plugins live in `mobile/android/app/src/main/java/com/apexvelo/lab/plugins/<Name>Plugin.kt`,
  registered in `MainActivity`. JS talks to them only through a thin wrapper module in `mobile/src/`.
- Root `js/` is shared with the desktop. Change it only when the feature is useful on both, and keep desktop tests green.

## Storage (workstream B owns, others consume)

- The phone answers the same `/api/storage/*` routes and response shapes as `server.js` + `scripts/sqlite-store.cjs`
  (`GET /api/storage`, `/rides`, `/db-settings`; `POST /save`, `/migrate`, ...). `js/velo-storage.js` then runs unchanged.
- New tables (added by B, empty until their owners use them):
  - `import_jobs(id TEXT PK, source TEXT, status TEXT, total INT, done INT, skipped INT, errors INT, created_at TEXT, updated_at TEXT, cursor TEXT)`
  - `import_files(job_id TEXT, path TEXT, hash TEXT, ride_id TEXT, status TEXT, error TEXT, PRIMARY KEY(job_id, path))`
  - `sync_ledger(ride_id TEXT, destination TEXT, external_id TEXT, content_hash TEXT, status TEXT, attempts INT, last_error TEXT, updated_at TEXT, PRIMARY KEY(ride_id, destination))`
  - `wellness_days(day TEXT, source TEXT, json TEXT, PRIMARY KEY(day, source))`
- Until B merges, other workstreams use the existing ride save path (`app.saveRides`/history APIs) and keep
  ledger/job state in settings keys prefixed `apex_sync_` / `apex_import_`, behind a small adapter so B can swap it.

## Ride identity and dedupe

- Ride `source` values: `recorded`, `import:fit`, `import:tcx`, `import:gpx`, `import:csv`, `healthconnect`, `icu`.
- File hash: SHA-256 of the decompressed file bytes, stored as `ride.fileHash`.
- Duplicate = same `fileHash`, or start time within ±60 s and duration within ±5 %. Keep the record with power,
  then more channels, then the longer one. Use and extend `js/velo-dedupe.js`.

## Destinations (outbound)

- Each destination implements `{ id, label, isConnected(), upload(ride, fitBytes) -> { externalId } }` and records
  results in the sync ledger. Never upload a ride to the destination it was imported from.

## Secrets

- Tokens and keys only in Capacitor Preferences (or Android Keystore-backed storage), never in localStorage,
  exports or the APK. No client secrets in the app once the broker exists (H).

## Tests and PRs

- Unit tests: `mobile/tests/*.test.mjs` (node --test). Browser flow: extend `mobile/tests/native-browser.cjs`.
- Kotlin: JVM unit tests where possible; CI must at least compile (`./gradlew assembleDebug`).
- One PR per workstream into `claude/android-apk-poc`; keep diffs focused; update `mobile/README.md` for user-visible changes.
