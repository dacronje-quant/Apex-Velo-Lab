/**
 * Strava for the Android app: upload only.
 *
 * The phone never reads Strava activities (no listing, details or streams): that keeps the app clear of
 * Strava's read rate limits and its API-agreement limits on AI use. A rider's history comes from their own
 * export files instead. The desktop's "Sync from Strava" (server.js, js/app-strava-sync.js) is unchanged.
 * Whether a ride is already on Strava comes from the local sync ledger (native-outbox.js), which records the
 * activity id each upload returns.
 *
 * The routes answered here are the upload subset of server.js under /api/strava/ (status, upload, upload
 * status, disconnect), with the same response shapes, so js/app-strava.js runs unchanged.
 *
 * Tokens are kept in Capacitor Preferences (never in the WebView's localStorage or in exports). How a sign-in
 * code or refresh token becomes an access token is a TokenExchanger:
 *   - ByoExchanger: the rider's own Strava API application (client id + secret, Settings > Strava), today's path;
 *   - BrokerExchanger: the token broker (workstream H) holds the secret; the phone only knows the broker URL.
 *
 * Sign-in uses Strava's mobile OAuth page and returns to apexvelo://localhost/strava. "localhost" is the
 * Authorization Callback Domain the desktop setup already uses, so one Strava API application serves both.
 */

export const STRAVA_BASE = 'https://www.strava.com';
export const REDIRECT_URI = 'apexvelo://localhost/strava';
export const SCOPE = 'activity:write';
const KEYS = { creds: 'strava_credentials', tokens: 'strava_tokens', state: 'strava_oauth_state' };
const TIMEOUT_MS = 30000, UPLOAD_TIMEOUT_MS = 120000;
const POLL_MS = 2000, POLL_MAX = 45; // ~90 s; Strava usually needs 5-20 s

export function convertUpload(d) {
  const err = d.error ? String(d.error) : '';
  const dup = (err.match(/duplicate of[^0-9]*?(?:activities\/)?(\d+)/i) || [])[1];
  let state = 'processing';
  let activity = d.activity_id ? String(d.activity_id) : null;
  if (activity) state = 'sent';
  else if (dup) { state = 'duplicate'; activity = dup; }
  else if (err) state = 'failed';
  return { uploadId: String(d.id_str || d.id || ''), state, activityId: activity, status: d.status || '', error: err || null };
}

const reply = (status, body) => ({ status, body });

/** CapacitorHttp request with JSON decoding and lower-case headers: { status, ok, data, headers }. */
async function request(http, opts) {
  const r = await http.request({ readTimeout: TIMEOUT_MS, connectTimeout: TIMEOUT_MS, ...opts });
  let data = r.data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { /* not JSON */ } }
  const headers = {};
  for (const [k, v] of Object.entries(r.headers || {})) headers[k.toLowerCase()] = v;
  return { status: r.status, ok: r.status >= 200 && r.status < 300, data, headers };
}

const form = (http, url, fields) => request(http, { url, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, data: fields });

/**
 * TokenExchanger interface (both classes below implement it):
 *   kind                                  'byo' | 'broker'
 *   isConfigured() -> boolean
 *   identity() -> string                  tokens belong to it: a different identity signs out
 *   authorizeUrl({ state, redirectUri, scope }) -> string
 *   exchangeCode(code) -> { status, ok, data }      data: Strava's token answer
 *   refresh(refreshToken) -> { status, ok, data }
 */

/** The rider's own Strava API application; the client secret stays in Capacitor Preferences. */
export class ByoExchanger {
  constructor({ http, prefs, base = STRAVA_BASE }) {
    Object.assign(this, { http, prefs, base, kind: 'byo' });
  }

  async credentials() { try { return JSON.parse((await this.prefs.get(KEYS.creds)) || 'null'); } catch (e) { return null; } }

  async setCredentials(clientId, clientSecret) {
    clientId = String(clientId || '').trim(); clientSecret = String(clientSecret || '').trim();
    if (!/^\d+$/.test(clientId)) throw new Error('The Client ID is the number shown on strava.com/settings/api.');
    if (!/^[0-9a-f]{20,}$/i.test(clientSecret)) throw new Error('The Client Secret is the long letters-and-numbers code on strava.com/settings/api.');
    await this.prefs.set(KEYS.creds, JSON.stringify({ clientId, clientSecret }));
  }

  clearCredentials() { return this.prefs.remove(KEYS.creds); }

  async isConfigured() { const c = await this.credentials(); return !!(c && c.clientId && c.clientSecret); }
  async identity() { const c = await this.credentials(); return c ? `byo:${c.clientId}` : ''; }

  async authorizeUrl({ state, redirectUri, scope }) {
    const c = await this.credentials();
    if (!c) throw new Error('Add your Strava Client ID and Secret first (Settings > Strava).');
    return `${this.base}/oauth/mobile/authorize?client_id=${encodeURIComponent(c.clientId)}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&approval_prompt=auto&scope=${encodeURIComponent(scope)}&state=${state}`;
  }

  async exchangeCode(code) {
    const c = await this.credentials();
    if (!c) return { status: 0, ok: false, data: null };
    return form(this.http, `${this.base}/oauth/token`, { client_id: c.clientId, client_secret: c.clientSecret, code, grant_type: 'authorization_code' });
  }

  async refresh(refreshToken) {
    const c = await this.credentials();
    if (!c) return { status: 0, ok: false, data: null };
    return form(this.http, `${this.base}/oauth/token`, { client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken });
  }
}

/**
 * Stub for the token broker (workstream H): the broker adds the client secret, so the phone holds none.
 * Provisional broker API, to be fixed by H:
 *   GET  {brokerUrl}/strava/config   -> { clientId }       (public; used to build Strava's sign-in URL)
 *   POST {brokerUrl}/strava/token    { grant_type: 'authorization_code', code }
 *                                    { grant_type: 'refresh_token', refresh_token }  -> Strava's token answer
 */
export class BrokerExchanger {
  constructor({ http, brokerUrl, clientId = '', base = STRAVA_BASE }) {
    Object.assign(this, { http, brokerUrl: String(brokerUrl || '').replace(/\/+$/, ''), base, kind: 'broker' });
    this._clientId = clientId ? String(clientId) : '';
  }

  async clientId() {
    if (!this._clientId && this.brokerUrl) {
      const r = await request(this.http, { url: `${this.brokerUrl}/strava/config`, method: 'GET' });
      if (r.ok && r.data && r.data.clientId) this._clientId = String(r.data.clientId);
    }
    return this._clientId;
  }

  async isConfigured() { return !!this.brokerUrl; }
  async identity() { return this.brokerUrl ? `broker:${this.brokerUrl}` : ''; }

  async authorizeUrl({ state, redirectUri, scope }) {
    const id = await this.clientId();
    if (!id) throw new Error('Could not reach the Apex Velo sign-in service. Check your internet connection and try again.');
    return `${this.base}/oauth/mobile/authorize?client_id=${encodeURIComponent(id)}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&approval_prompt=auto&scope=${encodeURIComponent(scope)}&state=${state}`;
  }

  exchangeCode(code) {
    return request(this.http, { url: `${this.brokerUrl}/strava/token`, method: 'POST', headers: { 'Content-Type': 'application/json' }, data: { grant_type: 'authorization_code', code } });
  }

  refresh(refreshToken) {
    return request(this.http, { url: `${this.brokerUrl}/strava/token`, method: 'POST', headers: { 'Content-Type': 'application/json' }, data: { grant_type: 'refresh_token', refresh_token: refreshToken } });
  }
}

/**
 * http.request({ url, method, headers, data, dataType, readTimeout }) -> { status, headers, data } (CapacitorHttp).
 * prefs: { get(key) -> string|null, set(key, value), remove(key) }.
 * exchanger: a TokenExchanger; defaults to the rider's own application (ByoExchanger).
 */
export class NativeStrava {
  constructor({ http, prefs, openUrl, exchanger, base = STRAVA_BASE, now = () => Date.now() }) {
    Object.assign(this, { http, prefs, openUrl, base, now });
    this.exchanger = exchanger || new ByoExchanger({ http, prefs, base });
  }

  async _json(key) { try { return JSON.parse((await this.prefs.get(key)) || 'null'); } catch (e) { return null; } }
  tokens() { return this._json(KEYS.tokens); }

  /** Own-application credentials (Settings > Strava); null with the broker. */
  credentials() { return this.exchanger.credentials ? this.exchanger.credentials() : Promise.resolve(null); }

  async setCredentials(clientId, clientSecret) {
    if (!this.exchanger.setCredentials) throw new Error('Strava sign-in is handled by Apex Velo; no API application is needed.');
    const before = await this.exchanger.identity();
    await this.exchanger.setCredentials(clientId, clientSecret);
    // Tokens belong to one API application: changing it signs out.
    if (before && before !== (await this.exchanger.identity())) await this.prefs.remove(KEYS.tokens);
  }

  async clearCredentials() {
    await this.disconnect();
    if (this.exchanger.clearCredentials) await this.exchanger.clearCredentials();
  }

  async _saveTokens(d, scope, athlete) {
    const a = athlete || d.athlete || {};
    await this.prefs.set(KEYS.tokens, JSON.stringify({
      access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at, scope: scope || '',
      athlete: { id: a.id, firstname: a.firstname || '', lastname: a.lastname || '' }
    }));
  }

  async accessToken() {
    const t = await this.tokens();
    if (!t || !t.refresh_token || !(await this.exchanger.isConfigured())) return null;
    if (t.access_token && Number(t.expires_at) > this.now() / 1000 + 120) return t.access_token;
    // Single flight: concurrent callers share one refresh (Strava rotates the refresh token on each one).
    if (!this._refreshing) this._refreshing = this._refresh(t).finally(() => { this._refreshing = null; });
    return this._refreshing;
  }

  async _refresh(t) {
    const r = await this.exchanger.refresh(t.refresh_token);
    if (r.ok && r.data && r.data.access_token) {
      await this._saveTokens(r.data, t.scope, t.athlete);
      return r.data.access_token;
    }
    // Revoked or expired sign-in: forget it, so Settings offers Connect Strava instead of "Connected as ...".
    // Only if the stored sign-in is still the refused one (a new Connect may have replaced it meanwhile).
    if (r.status === 400 || r.status === 401) {
      const now = await this.tokens();
      if (now && now.refresh_token === t.refresh_token) await this.prefs.remove(KEYS.tokens);
      return null;
    }
    // An outage of the token endpoint is not a sign-out: the caller retries later.
    if (r.status >= 500 || r.status === 429) throw Object.assign(new Error(`Strava sign-in is temporarily unavailable (HTTP ${r.status}).`), { outage: true });
    return null;
  }

  async status() {
    const t = await this.tokens();
    return {
      configured: await this.exchanger.isConfigured(),
      connected: !!(t && t.refresh_token),
      athlete: t && t.athlete ? `${t.athlete.firstname || ''} ${t.athlete.lastname || ''}`.trim() : null,
      canUpload: !!(t && /activity:write/.test(t.scope || '')),
      // The phone never reads Strava: no activity checks, no sync.
      canCheck: false,
      canSync: false,
      uploadOnly: true,
      signIn: this.exchanger.kind
    };
  }

  /** Opens Strava's sign-in page; the answer comes back through handleRedirect(). */
  async connect() {
    if (!(await this.exchanger.isConfigured())) {
      throw new Error(this.exchanger.kind === 'broker' ? 'Strava sign-in is not available right now. Try again later.' : 'Add your Strava Client ID and Secret first (Settings > Strava).');
    }
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const state = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    const url = await this.exchanger.authorizeUrl({ state, redirectUri: REDIRECT_URI, scope: SCOPE });
    await this.prefs.set(KEYS.state, JSON.stringify({ state, at: this.now() }));
    await this.openUrl(url);
    return url;
  }

  isRedirect(url) { return typeof url === 'string' && url.toLowerCase().startsWith(REDIRECT_URI); }

  /** Finishes sign-in from the apexvelo:// redirect. Resolves { ok, athlete } or { ok: false, error }. */
  async handleRedirect(url) {
    const q = new URL(url.replace(/^apexvelo:/i, 'https:')).searchParams;
    const pending = await this._json(KEYS.state);
    await this.prefs.remove(KEYS.state);
    if (!pending || pending.state !== q.get('state') || this.now() - pending.at > 15 * 60000) return { ok: false, error: 'The Strava sign-in link expired. Press Connect Strava again.' };
    if (q.get('error') || !q.get('code')) return { ok: false, error: 'Strava access was not granted. Nothing was changed.' };
    const scope = q.get('scope') || '';
    if (!/activity:write/.test(scope)) return { ok: false, error: 'Tick "Upload your activities" on the Strava screen, then connect again.' };
    if (!(await this.exchanger.isConfigured())) return { ok: false, error: this.exchanger.kind === 'broker' ? 'Strava sign-in is not available right now. Try again later.' : 'Strava is not set up. Add your Client ID and Secret first.' };
    let r;
    try { r = await this.exchanger.exchangeCode(q.get('code')); }
    catch (e) { return { ok: false, error: `Could not reach Strava (${e.message}).` }; }
    if (!r.ok || !r.data || !r.data.refresh_token) {
      return { ok: false, error: this.exchanger.kind === 'byo' ? `Could not finish connecting (Strava answered ${r.status}). Check the Client ID and Secret.` : `Could not finish connecting (sign-in service answered ${r.status}). Try again.` };
    }
    await this._saveTokens(r.data, scope);
    return { ok: true, athlete: (await this.status()).athlete };
  }

  async disconnect() {
    const token = await this.accessToken().catch(() => null);
    if (token) await form(this.http, `${this.base}/oauth/deauthorize`, { access_token: token }).catch(() => {});
    await this.prefs.remove(KEYS.tokens);
  }

  /** The access token, or a retryable 502 reply when refreshing it failed for now (offline, or a token-endpoint outage). */
  async _token() {
    try { return { token: await this.accessToken() }; } catch (e) {
      return { fail: reply(502, { error: e.outage ? `${e.message} The ride is sent again later.` : `Could not reach Strava (${e.message}).` }) };
    }
  }

  async upload(input) {
    const { token, fail } = await this._token();
    if (fail) return fail;
    if (!token) return reply(401, { error: 'Strava is not connected (or access was revoked). Connect Strava and try again.', needsConnect: true });
    const fit = String((input && input.fitBase64) || '');
    if (fit.length < 20) return reply(400, { error: 'Ride file is empty.' });
    const data = [{ key: 'file', value: fit, type: 'base64File', fileName: 'apex-velo-ride.fit', contentType: 'application/octet-stream' }];
    const parts = { data_type: 'fit', name: input.name || '', description: input.description || '', trainer: '1', commute: '0', external_id: input.externalId || '' };
    for (const [k, v] of Object.entries(parts)) if (v !== '') data.push({ key: k, value: String(v), type: 'string' });
    let r;
    try {
      r = await request(this.http, { url: `${this.base}/api/v3/uploads`, method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'multipart/form-data' },
        data, dataType: 'formData', readTimeout: UPLOAD_TIMEOUT_MS });
    } catch (e) { return reply(502, { error: `Could not reach Strava (${e.message}).` }); }
    if (r.status === 401) return reply(401, { error: 'Strava rejected the sign-in. Connect Strava again.', needsConnect: true });
    if (r.status === 429) return reply(429, { error: 'Strava rate limit reached - try again in 15 minutes.' });
    // Strava may refuse a file it already has (e.g. 409): that is a link to the existing activity, not a failure.
    const body = r.data && typeof r.data === 'object' ? r.data : null;
    if (body && body.error && convertUpload(body).state === 'duplicate') return reply(200, convertUpload(body));
    const why = `Strava upload failed: ${(body && (body.error || body.message)) || 'HTTP ' + r.status}`;
    if (r.status >= 500) return reply(502, { error: why });
    if (!r.ok) return reply(r.status, { error: why }); // 400/403/404/409...: sending the same file again will not help
    if (!body) return reply(502, { error: why });
    return reply(200, convertUpload(body));
  }

  /** The status of one of our own uploads (not an activity read). */
  async uploadStatus(id) {
    const { token, fail } = await this._token();
    if (fail) return fail;
    if (!token) return reply(401, { error: 'Strava is not connected.', needsConnect: true });
    let r;
    try { r = await request(this.http, { url: `${this.base}/api/v3/uploads/${id}`, method: 'GET', headers: { Authorization: `Bearer ${token}` } }); }
    catch (e) { return reply(502, { error: `Could not reach Strava (${e.message}).` }); }
    if (r.status === 401) return reply(401, { error: 'Strava rejected the sign-in. Connect Strava again.', needsConnect: true });
    if (!r.ok || !r.data) return reply(502, { error: `Strava status check failed (HTTP ${r.status}).` });
    return reply(200, convertUpload(r.data));
  }

  /**
   * Answers one /api/strava/ request: { status, body } or null when the path is not a route on the phone.
   * /api/strava/activities and /api/strava/sync (reading Strava) are not answered: the phone is upload-only.
   */
  async route(pathname, method, query, bodyText) {
    if (pathname === '/api/strava/status') return reply(200, await this.status());
    if (pathname === '/api/strava/disconnect') { if (method !== 'POST') return reply(405, { error: 'Method not allowed' }); await this.disconnect(); return reply(200, await this.status()); }
    if (pathname === '/api/strava/upload') {
      if (method !== 'POST') return reply(405, { error: 'Method not allowed' });
      let input; try { input = JSON.parse(bodyText || '{}'); } catch (e) { return reply(400, { error: 'Invalid JSON.' }); }
      return this.upload(input);
    }
    const m = pathname.match(/^\/api\/strava\/upload\/(\d+)$/);
    if (m) return this.uploadStatus(m[1]);
    return null;
  }
}

/** An upload that did not go through. `retryable`: try again later; `needsConnect`: wait for a new sign-in. */
export class UploadError extends Error {
  constructor(message, { retryable = false, needsConnect = false } = {}) {
    super(message);
    Object.assign(this, { name: 'UploadError', retryable, needsConnect });
  }
}

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Strava as an outbound destination (docs/ANDROID-CONTRACTS.md): { id, label, isConnected(), upload(ride, fitBytes) }.
 * upload() waits until Strava has made the activity and resolves { externalId, duplicate }, or throws an UploadError.
 * An upload still processing when the wait ends is retryable: sending the same file again gets Strava's
 * "duplicate of activity N" answer, which also gives the activity id.
 */
export class StravaDestination {
  constructor({ strava, describe = () => '', sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = POLL_MS, pollMax = POLL_MAX }) {
    Object.assign(this, { strava, describe, sleep, pollMs, pollMax, id: 'strava', label: 'Strava' });
  }

  async isConnected() {
    const s = await this.strava.status();
    return !!(s.connected && s.canUpload);
  }

  async upload(ride, fitBytes) {
    const r = await this.strava.upload({ fitBase64: toBase64(fitBytes), name: ride.title || 'Indoor ride', description: this.describe(ride) || '', externalId: `apexvelo-${ride.id}` });
    let res = this._result(r);
    for (let i = 0; res.state === 'processing' && i < this.pollMax; i++) {
      await this.sleep(i === 0 ? 1200 : this.pollMs);
      const s = await this.strava.uploadStatus(res.uploadId);
      if (s.status >= 500) continue; // a dropped status check; the upload itself is fine
      res = this._result(s);
    }
    if (res.state === 'sent' || res.state === 'duplicate') return { externalId: String(res.activityId), duplicate: res.state === 'duplicate' };
    if (res.state === 'processing') throw new UploadError('Strava is still processing the ride.', { retryable: true });
    throw new UploadError(res.error || 'Strava could not read the ride file.');
  }

  _result(r) {
    const b = r.body || {};
    if (r.status === 401) throw new UploadError(b.error || 'Connect Strava again.', { needsConnect: true });
    if (r.status === 429 || r.status >= 500) throw new UploadError(b.error || `Strava answered ${r.status}.`, { retryable: true });
    if (r.status !== 200) throw new UploadError(b.error || `Strava answered ${r.status}.`);
    return b;
  }
}
