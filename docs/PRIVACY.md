# Local data and sharing

Apex Velo Lab has no hosted user account or central health database. Each person runs a local server with a SQLite database in their private user data folder (`%LOCALAPPDATA%\ApexVeloLab` on Windows), credentials and backups. App copies for the same OS user share this database unless `APEX_DATA_DIR` selects a separate folder. Browser storage retains compatibility caches, unsent saves and unfinished-ride recovery copies.

The ordinary cockpit, simulator and charts load bundled assets. Optional AI calls send the chosen training/recovery context to the configured AI provider. Strava connection and sync communicate with Strava using your own credentials. Health Auto Export sends authorised metrics from the iPhone to the local inbox. Disconnecting a service does not automatically erase previously imported rides.

The server permits local/private-network clients and validates Host and Origin. This is a local-network boundary, not user authentication: use a trusted network. API keys and token files are not served as static assets. Health inbox and local archive access are restricted to the PC. There is no public-hosting configuration.

Do not share your installed folder as a ZIP: it can contain `.env`, `.strava-tokens.json`, health tokens/payloads, backups, imports and screenshots. Share a Git checkout or a branch archive containing tracked source files. `data` is ignored except for its README and the synthetic sample. `.private-review` and test output are ignored too.

SQLite, browser recovery copies and backups are not encrypted by this app. Anyone with access to your OS account/files may access them. Clearing browser storage does not remove confirmed SQLite saves, but can erase pending saves and unfinished rides. Backups contain personal rides, profiles, settings and recovery data. An optional `APEX_BACKUP_MIRROR_DIR` copies verified snapshots to a destination you choose; a cloud-synced destination shares them according to that service's configuration. The live database stays local.

The demo uses separate storage and blocks server requests and physical device connections. Closing it does not change the ordinary app's rides or profiles.

**Git history:** removing a file in this branch does not remove earlier commits. Older screenshots or personal details may remain in history. Review historical contents before changing a private repository's visibility. This preparation does not rewrite history or delete your private files. A source-only archive of this branch avoids including Git history.
