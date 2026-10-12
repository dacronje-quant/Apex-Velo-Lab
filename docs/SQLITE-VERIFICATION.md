# SQLite storage verification

Verified on Windows with Node 24 and desktop Edge, using temporary data folders and synthetic records. No test launches the rider's real server, pairs hardware, uses personal service credentials or writes to the default user database.

## Covered behavior

- The actual batch launcher, PowerShell entry point and direct Node server open the same SQLite API. First-use portable runtime download verifies SHA-256; a second launch reuses it offline.
- Migration preserves complete rides, IndexedDB-only samples, profiles, preferences, health records and Strava restore points. Original browser data and legacy snapshots remain recoverable. An unreadable browser database stops migration.
- A new browser loads confirmed PC data. Preference edits and metadata-only ride updates persist; summaries cannot discard existing samples. Deletes remain deleted after reload.
- Concurrent tabs/connections reject stale writes. Failed saves retain an ordered recovery outbox, including later queued changes. Repeated operation IDs cannot commit the same save twice. Reload retains conflicting changes for export and allows new saves.
- Backups verify checksums before publication. Preview, in-app restore and imported gzip files work; restore requires a safety snapshot first. Invalid names, corrupted snapshots and failed safety backups leave live data unchanged.
- Retention preserves recent, daily, weekly, monthly, migration and before-restore copies. Daily checks run without a browser. An optional second-copy destination receives verified snapshots; mirror failure retains the local copy and reports an error.
- Database writes roll back after validation failures or process death during a transaction. Corrupt databases and newer schemas are never reset automatically.
- Interrupted rides recover paused with their original samples. A completed ride is marked saved only after database confirmation. Health inbox exports are acknowledged only after SQLite confirms their save. Existing Strava snapshot/undo helpers work with SQLite.
- Demo/test modes do not access production SQLite. Storage APIs reject LAN and unrelated browser origins. Database, backup and server-helper files are not served as static assets.

## Reproduce

```text
npm test
npm run test:storage
npm run test:browser
```

Browser checks need optional development dependencies (`npm install`) and a supported installed browser. The app itself requires no npm install. Windows uses installed Edge by default for tests.

The feature was also checked from an exported staged tree excluding pre-existing uncommitted UI changes. All its Node tests and the actual SQLite browser workflow passed. The broader browser suite in the existing working copy has one strength-training coach-context failure; it also fails in the preserved pre-change baseline and is outside this storage change.

`node tests/sqlite-real-data-trial.cjs` optionally checks the newest legacy snapshot by full-content hash in a separate ignored private trial folder. It leaves the source unchanged and does not activate the real database.

## Practical limits

These checks establish the tested behavior, not a guarantee against every OS, hardware or disk failure. Interrupted-ride checkpoints run approximately every five seconds and require working browser storage. Daily backups require the server to be running. Protecting against loss of the PC requires a separate backup destination. SQLite, browser recovery copies and snapshots are not encrypted by Apex.
