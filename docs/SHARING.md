# Share a clean local version

This branch prepares the app for people to download and run themselves. It does not deploy a service, publish a GitHub branch or change repository visibility.

1. Choose a repository licence before describing the project as open source. No licence has been assigned automatically.
2. Run `npm test`, `npm run test:browser`, `npm run test:suite` and `npm run check:share` when preparing a new release. Read [local setup](LOCAL-SETUP.md) and [privacy](PRIVACY.md).
3. Commit the intended source changes. Keep `.env`, tokens, private imports, backups and `.private-review` ignored.
4. To share only the committed files without Git history, create a source archive:

```powershell
New-Item -ItemType Directory -Force release-output
git archive --format=zip --prefix=Apex-Velo-Lab/ --output=release-output/Apex-Velo-Lab-local.zip HEAD
```

Share that archive rather than zipping your entire installed folder. For GitHub distribution, push the prepared branch when ready and let users download its source ZIP. If making a private repository public, review historical commits first: earlier personal screenshots may still exist there. Do not rewrite or discard history as part of an ordinary update.

Existing installations retain browser profiles, rides, device settings and health data at the same origin. Legacy local archives remain supported. Review screenshots removed from public source are preserved locally under `.private-review/proposals`. Restart the local server after an update so the new private-archive endpoint is available.
