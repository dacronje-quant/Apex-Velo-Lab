# Local data and sharing

Apex Velo Lab has no hosted user account or central health database. Each installation runs its own local server and uses that person's browser storage, credentials and backup folder.

The ordinary cockpit, simulator and charts load bundled assets. Optional AI calls send the chosen training/recovery context to the configured AI provider. Strava connection and sync communicate with Strava using your own credentials. Health Auto Export sends authorised metrics from the iPhone to the local inbox. Disconnecting a service does not automatically erase previously imported rides.

The server permits local/private-network clients and validates Host and Origin. This is a local-network boundary, not user authentication: use a trusted network. API keys and token files are not served as static assets. Health inbox and local archive access are restricted to the PC. There is no public-hosting configuration.

Do not share your installed folder as a ZIP: it can contain `.env`, `.strava-tokens.json`, health tokens/payloads, backups, imports and screenshots. Share a Git checkout or a branch archive containing tracked source files. `data` is ignored except for its README and the synthetic sample. `.private-review` and test output are ignored too.

Browser storage is not encrypted by this app. Anyone with access to your computer/browser profile may access it. Before intentionally clearing it, export a backup. Backups contain personal rides, profiles and recovery data and need the same care.

The demo uses separate storage and blocks server requests and physical device connections. Closing it does not change the ordinary app's rides or profiles.

**Git history:** removing a file in this branch does not remove earlier commits. Older screenshots or personal details may remain in history. Review historical contents before changing a private repository's visibility. This preparation does not rewrite history or delete your private files. A source-only archive of this branch avoids including Git history.
