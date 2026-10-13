# Share a clean local version

The public repository's `main` branch is the shareable version. Personal credentials and health inbox files live in git-ignored files next to the code; confirmed rides, settings and backups live in the private user data folder. The maintainer can run the same source as everyone else.

1. The app is licensed under [MIT](../LICENSE). Include the licence and bundled third-party notices when sharing copies.
2. With Node 24+, run `npm test`, `npm run test:storage`, `npm run test:browser`, `npm run test:suite` and `npm run check:share` when preparing a new release. Read [local setup](LOCAL-SETUP.md) and [privacy](PRIVACY.md).
3. Commit the intended source changes. Keep `.env`, tokens, private imports, backups and `.private-review` ignored.
4. To share only the committed files without Git history, create a source archive:

```powershell
New-Item -ItemType Directory -Force release-output
git archive --format=zip --prefix=Apex-Velo-Lab/ --output=release-output/Apex-Velo-Lab-local.zip HEAD
```

Share that archive rather than zipping your entire installed folder. For GitHub distribution, push the prepared branch when ready and let users download its source ZIP. Repository history was cleaned of personal screenshots in October 2026; keep screenshots in releases synthetic (use **Explore a demo**). Do not rewrite or discard history as part of an ordinary update.

Existing installations migrate browser profiles, rides, device settings and health data into SQLite, retaining a recovery copy. Use the same browser and origin on the first upgraded launch. Legacy local archives remain supported. Review screenshots removed from public source are preserved locally under `.private-review/proposals`. Restart the local server after an update and refresh the browser.

## GitHub donations

The repository's [funding configuration](../.github/FUNDING.yml) points the Sponsor button to [PayPal.Me](https://paypal.me/divanquant). The README also links directly to PayPal. Donations through this link are handled by PayPal and do not require a GitHub Sponsors profile or approval.

1. Merge the prepared funding file into the repository's default branch when ready. GitHub reads `.github/FUNDING.yml` from the default branch; a local development branch alone cannot enable the live button.
2. In repository **Settings > General > Features**, enable **Sponsorships**.
3. Check the Sponsor button and confirm it opens `https://paypal.me/divanquant`. See [GitHub's Sponsor button guide](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/displaying-a-sponsor-button-in-your-repository).

No hosted app, payment code or API key is needed. Keep donations voluntary; using and modifying the app does not require payment.

Native GitHub Sponsors is optional. Its `github: [dacronje-quant]` setting is retained as a comment in the funding file. To enable it later, complete [GitHub Sponsors setup](https://github.com/sponsors/accounts), get the profile approved, then uncomment that setting. GitHub's [personal account guide](https://docs.github.com/en/sponsors/receiving-sponsorships-through-github-sponsors/setting-up-github-sponsors-for-your-personal-account) explains the account setup.
