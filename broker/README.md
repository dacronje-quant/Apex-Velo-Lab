# Apex Velo token broker

A small, stateless Cloudflare Worker that lets the Android app connect to Strava with one tap. Strava's token
endpoint needs the API application's client secret, and a secret shipped in an APK is not a secret. The broker
holds it instead: the phone sends the sign-in code (or a refresh token), the broker adds the client id and secret,
asks Strava, and hands Strava's answer back.

It stores nothing (no database, no KV, no tokens, no user data) and logs only the route, status and timing of a
request: never tokens, codes, bodies or IP addresses.

## API

| Route | Body | Answer |
|---|---|---|
| `GET /strava/config` | - | `{ "clientId": "12345" }` (public; the app builds Strava's sign-in URL from it) |
| `POST /strava/token` | `{ "grant_type": "authorization_code", "code": "..." }` | Strava's token answer |
| `POST /strava/token` | `{ "grant_type": "refresh_token", "refresh_token": "..." }` | Strava's token answer |

The token answer keeps `token_type`, `access_token`, `refresh_token`, `expires_at`, `expires_in` and
`athlete: { id, firstname, lastname }` (shown as "Connected as ..." in the app); the rest of Strava's athlete
profile (city, photo, weight and so on) is dropped. The app side is `BrokerExchanger` in
[`mobile/src/native-strava.js`](../mobile/src/native-strava.js).

### Status codes (a contract with the app)

The app signs a rider out when a token refresh is refused with **400 or 401**, and retries later on **429 or
5xx**. So:

| Status | Meaning |
|---|---|
| 200 | Tokens |
| 400, 401 | **Only Strava's own refusals**, body passed through unchanged (expired or revoked sign-in, bad code) |
| 403 | Strava's 403, passed through; or the broker refusing a browser (`Origin` / `Sec-Fetch-*` / `OPTIONS`) or, with attestation enforced, an unverified app |
| 404, 405 | Unknown route, wrong method |
| 413 | Body over 2 KB |
| 415 | Not `application/json` |
| 422 | Not exactly one of the two grant shapes above, or a malformed code/token |
| 429 | Rate limit (the broker's own, `Retry-After: 60`, or Strava's, passed through) |
| 500 | Broker misconfigured (missing secrets or rate-limit bindings, bad `ATTESTATION` value) |
| 502 | Strava 5xx or another unexpected status, network error, unreadable answer |
| 503 | Attestation enforced but the verifier cannot decide |
| 504 | Strava did not answer within 10 s |

Every non-Strava answer is `{ "error": "..." }`. The broker never answers 400 or 401 itself, so a broker problem
never signs riders out.

### Abuse protection

- Per-IP rate limits with the Workers rate-limit binding (`wrangler.toml`): 10 token requests and 30 config
  requests per minute per address. A missing binding fails closed (500).
- Strict input: JSON only, at most 2 KB (checked while reading, whatever `Content-Length` says), exactly the two
  grant shapes, codes and tokens limited to `[A-Za-z0-9._~-]{1,256}`.
- No CORS: the app calls the broker natively (CapacitorHttp sends neither `Origin` nor `Sec-Fetch-*`), so any
  request carrying those, and every preflight, is refused with 403 and no CORS headers.
- `Cache-Control: no-store` on every answer.

## Deploy (owner)

You need a Cloudflare account (the free plan is enough) and the Strava API application for the app.

1. **Strava application.** At [strava.com/settings/api](https://www.strava.com/settings/api), create the app's
   application (name "Apex Velo", website, icon). Set **Authorization Callback Domain** to `localhost`. The broker
   never sees the redirect: Strava sends the rider back to the app at `apexvelo://localhost/strava`, and Strava
   checks that address's host (`localhost`) against the callback domain, not the broker's domain.
   New applications are limited to one connected athlete until Strava's review: apply for the athlete-limit
   increase before release.
2. **Install and log in.**
   ```bash
   cd broker
   npm ci
   npx wrangler login
   ```
3. **Secrets** (asked for interactively; never put them in `wrangler.toml` or the repository):
   ```bash
   npx wrangler secret put STRAVA_CLIENT_ID
   npx wrangler secret put STRAVA_CLIENT_SECRET
   ```
4. **Deploy.**
   ```bash
   npx wrangler deploy
   ```
   It prints the URL, e.g. `https://apex-velo-broker.<your-subdomain>.workers.dev`. Check it:
   `curl https://apex-velo-broker.<your-subdomain>.workers.dev/strava/config` answers `{"clientId":"..."}`.
   (A custom domain works too: Workers > the worker > Settings > Domains & Routes.)
5. **Point the app at it.** Set the GitHub repository variable `APEX_BROKER_URL` to that URL
   (Settings > Secrets and variables > Actions > **Variables**; it is public, not a secret), or put it in
   `mobile/app-config.json` as `brokerUrl`. Builds with a broker URL sign in with one tap; the rider's own API
   application stays available under Settings > Strava > Advanced.

Rotating the secret: regenerate it on strava.com/settings/api, then `npx wrangler secret put STRAVA_CLIENT_SECRET`.
Riders stay signed in (their tokens belong to the application, not the secret).

The rate limits are in `wrangler.toml` (`[[ratelimits]]`; `period` is 10 or 60 seconds). `namespace_id` only
has to be unique within the Cloudflare account.

## Develop

```bash
npm test        # vitest: pass-through, error mapping, validation, browser denial, rate limit, attestation, logs
npm run check   # typecheck + wrangler bundle (dry run, no account needed)
npm run dev     # local server; put STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET in .dev.vars (git-ignored)
```

The **Token broker** GitHub workflow runs `npm test` and `npm run check`. Nothing is deployed from CI.

## App attestation (decision)

**Decision: the hook is in place, verification is off until the Play Console exists.**

The app can send a Play Integrity token in the `X-Apex-Attestation` header (`BrokerExchanger`'s `attest`
option; nothing supplies one yet), and the Worker has an `ATTESTATION` variable:

- `off` (default): the header is ignored.
- `report`: the token is checked and the outcome logged (`attestation:valid|invalid|missing|unverified`), never
  blocking. Use this first, to see what share of real installs pass.
- `enforce`: requests without a valid token get 403. If the verifier cannot decide (as the stub always does), the
  answer is 503, a broker fault, so riders are never signed out because verification is unavailable.

Why not now: verifying a Play Integrity token means calling Google's `decodeIntegrityToken` API with a Google
Cloud service account linked to the Play Console app, which does not exist yet; and sideloaded or debug builds
would fail it. Rate limits, strict input and the browser block cover the main abuse (someone using the broker as a
free Strava token service) until then; the worst case is spending this application's Strava rate limit, not
access to anyone's data, since the broker only exchanges codes and tokens the caller already holds. To finish
it: add a Kotlin plugin requesting a Standard Integrity token (request hash = SHA-256 of the request body), pass
it as `attest` in `mobile/src/index.js`, and implement `verifyAttestation` in `src/index.ts` (decode, check the
package name, certificate digest, request hash and `MEETS_DEVICE_INTEGRITY`), with the service-account key as a
Worker secret.

## Adding intervals.icu later

Same shape: `/icu/config` and `/icu/token`, as another entry in `PROVIDERS` in `src/index.ts` (intervals.icu's OAuth token URL, check their
OAuth docs when adding it, `ICU_CLIENT_ID` / `ICU_CLIENT_SECRET` secrets, and its own `clean()`
keeping only what the app needs). Routing, validation, rate limits, logging and the status contract are shared.
Until then `/icu/*` answers 404.
