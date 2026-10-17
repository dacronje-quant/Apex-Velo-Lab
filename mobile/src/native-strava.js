/**
 * Strava for the Android app: the routes server.js serves under /api/strava/, answered on the phone.
 *
 * The desktop app keeps the Strava keys in the local server. The app has no server, so the rider's own
 * Strava API application (client id + secret) and the tokens are kept in Android app storage
 * (Capacitor Preferences, never in the WebView's localStorage or in exports). Requests go out through
 * native HTTP, so Strava's CORS rules do not apply. The response shapes match server.js, so
 * js/app-strava.js and js/app-strava-sync.js run unchanged.
 *
 * Sign-in uses Strava's mobile OAuth page and returns to apexvelo://localhost/strava. "localhost" is the
 * Authorization Callback Domain the desktop setup already uses, so one Strava API application serves both.
 */

export const STRAVA_BASE = 'https://www.strava.com';
export const REDIRECT_URI = 'apexvelo://localhost/strava';
const SCOPE = 'read,activity:read_all,activity:write';
const KEYS = { creds: 'strava_credentials', tokens: 'strava_tokens', state: 'strava_oauth_state' };
const TIMEOUT_MS = 30000, UPLOAD_TIMEOUT_MS = 120000;

const SYNC_MAX_PAGES = 10;
const SYNC_MAX_DETAIL_IDS = 10;
const SYNC_STREAM_KEYS = 'time,watts,heartrate,cadence,velocity_smooth,distance';
const SYNC_FIELDS = ['name', 'type', 'sport_type', 'start_date', 'start_date_local', 'timezone', 'moving_time', 'elapsed_time', 'distance',
  'calories', 'average_watts', 'weighted_average_watts', 'max_watts', 'kilojoules', 'device_watts', 'average_heartrate', 'max_heartrate',
  'average_cadence', 'suffer_score', 'trainer', 'description'];

const toIsoUtc = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString().replace('.000Z', 'Z') : ''; };

export function slimActivity(a, detailed) {
  const o = { id: String(a.id), detailed: !!detailed };
  for (const k of SYNC_FIELDS) if (a[k] !== undefined && a[k] !== null) o[k] = a[k];
  o.start_date = toIsoUtc(a.start_date);
  if (a.start_date_local) o.start_date_local = toIsoUtc(a.start_date_local);
  if (!detailed) { delete o.description; delete o.calories; }
  o.trainer = !!a.trainer;
  return o;
}

export function convertUpload(d) {
  const err = d.error ? String(d.error) : '';
  const dup = (err.match(/duplicate of[^0-9]*?(?:activities\/)?(\d+)/) || [])[1];
  let state = 'processing';
  let activity = d.activity_id ? String(d.activity_id) : null;
  if (activity) state = 'sent';
  else if (dup) { state = 'duplicate'; activity = dup; }
  else if (err) state = 'failed';
  return { uploadId: String(d.id_str || d.id || ''), state, activityId: activity, status: d.status || '', error: err || null };
}

function rateOf(headers) {
  const h = headers || {};
  const pick = (a, b) => String(h[a] || h[b] || '').split(',').map((x) => parseInt(x, 10));
  const used = pick('x-readratelimit-usage', 'x-ratelimit-usage');
  const lim = pick('x-readratelimit-limit', 'x-ratelimit-limit');
  return { used15: used[0] || 0, usedDay: used[1] || 0, limit15: lim[0] || 100, limitDay: lim[1] || 1000 };
}

const reply = (status, body) => ({ status, body });

/**
 * http.request({ url, method, headers, data, dataType, readTimeout }) -> { status, headers, data } (CapacitorHttp).
 * prefs: { get(key) -> string|null, set(key, value), remove(key) }.
 */
export class NativeStrava {
  constructor({ http, prefs, openUrl, base = STRAVA_BASE, now = () => Date.now() }) {
    Object.assign(this, { http, prefs, openUrl, base, now });
  }

  async _json(key) { try { return JSON.parse((await this.prefs.get(key)) || 'null'); } catch (e) { return null; } }
  credentials() { return this._json(KEYS.creds); }
  tokens() { return this._json(KEYS.tokens); }

  async setCredentials(clientId, clientSecret) {
    clientId = String(clientId || '').trim(); clientSecret = String(clientSecret || '').trim();
    if (!/^\d+$/.test(clientId)) throw new Error('The Client ID is the number shown on strava.com/settings/api.');
    if (!/^[0-9a-f]{20,}$/i.test(clientSecret)) throw new Error('The Client Secret is the long letters-and-numbers code on strava.com/settings/api.');
    const old = await this.credentials();
    // Tokens belong to one API application: changing it signs out.
    if (old && old.clientId !== clientId) await this.prefs.remove(KEYS.tokens);
    await this.prefs.set(KEYS.creds, JSON.stringify({ clientId, clientSecret }));
  }

  async clearCredentials() {
    await this.disconnect();
    await this.prefs.remove(KEYS.creds);
  }

  _headers(h) {
    const out = {};
    for (const [k, v] of Object.entries(h || {})) out[k.toLowerCase()] = v;
    return out;
  }

  async _request(opts) {
    const r = await this.http.request({ readTimeout: TIMEOUT_MS, connectTimeout: TIMEOUT_MS, ...opts });
    let data = r.data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { /* not JSON */ } }
    return { status: r.status, ok: r.status >= 200 && r.status < 300, data, headers: this._headers(r.headers) };
  }

  _form(url, fields) {
    return this._request({ url, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, data: fields });
  }

  async _saveTokens(d, scope, athlete) {
    const a = athlete || d.athlete || {};
    await this.prefs.set(KEYS.tokens, JSON.stringify({
      access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at, scope: scope || '',
      athlete: { id: a.id, firstname: a.firstname || '', lastname: a.lastname || '' }
    }));
  }

  async accessToken() {
    const t = await this.tokens(), c = await this.credentials();
    if (!t || !t.refresh_token || !c) return null;
    if (t.access_token && Number(t.expires_at) > this.now() / 1000 + 120) return t.access_token;
    const r = await this._form(`${this.base}/oauth/token`, { client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'refresh_token', refresh_token: t.refresh_token });
    if (!r.ok || !r.data || !r.data.access_token) return null;
    await this._saveTokens(r.data, t.scope, t.athlete);
    return r.data.access_token;
  }

  async status() {
    const t = await this.tokens(), c = await this.credentials();
    return {
      configured: !!(c && c.clientId && c.clientSecret),
      connected: !!(t && t.refresh_token),
      athlete: t && t.athlete ? `${t.athlete.firstname || ''} ${t.athlete.lastname || ''}`.trim() : null,
      canUpload: !!(t && /activity:write/.test(t.scope || '')),
      canCheck: !!(t && /activity:read/.test(t.scope || '')),
      canSync: !!(t && /activity:read_all/.test(t.scope || ''))
    };
  }

  /** Opens Strava's sign-in page; the answer comes back through handleRedirect(). */
  async connect() {
    const c = await this.credentials();
    if (!c) throw new Error('Add your Strava Client ID and Secret first (Settings > Strava).');
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const state = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    await this.prefs.set(KEYS.state, JSON.stringify({ state, at: this.now() }));
    const url = `${this.base}/oauth/mobile/authorize?client_id=${encodeURIComponent(c.clientId)}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&approval_prompt=auto&scope=${encodeURIComponent(SCOPE)}&state=${state}`;
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
    const c = await this.credentials();
    if (!c) return { ok: false, error: 'Strava is not set up. Add your Client ID and Secret first.' };
    let r;
    try { r = await this._form(`${this.base}/oauth/token`, { client_id: c.clientId, client_secret: c.clientSecret, code: q.get('code'), grant_type: 'authorization_code' }); }
    catch (e) { return { ok: false, error: `Could not reach Strava (${e.message}).` }; }
    if (!r.ok || !r.data || !r.data.refresh_token) return { ok: false, error: `Could not finish connecting (Strava answered ${r.status}). Check the Client ID and Secret.` };
    await this._saveTokens(r.data, scope);
    return { ok: true, athlete: (await this.status()).athlete };
  }

  async disconnect() {
    const token = await this.accessToken().catch(() => null);
    if (token) await this._form(`${this.base}/oauth/deauthorize`, { access_token: token }).catch(() => {});
    await this.prefs.remove(KEYS.tokens);
  }

  _get(pathAndQuery, token) {
    return this._request({ url: `${this.base}/api/v3/${pathAndQuery}`, method: 'GET', headers: { Authorization: `Bearer ${token}` } });
  }

  async upload(input) {
    const token = await this.accessToken();
    if (!token) return reply(401, { error: 'Strava is not connected (or access was revoked). Connect Strava and try again.', needsConnect: true });
    const fit = String((input && input.fitBase64) || '');
    if (fit.length < 20) return reply(400, { error: 'Ride file is empty.' });
    const data = [{ key: 'file', value: fit, type: 'base64File', fileName: 'apex-velo-ride.fit', contentType: 'application/octet-stream' }];
    const parts = { data_type: 'fit', name: input.name || '', description: input.description || '', trainer: '1', commute: '0', external_id: input.externalId || '' };
    for (const [k, v] of Object.entries(parts)) if (v !== '') data.push({ key: k, value: String(v), type: 'string' });
    let r;
    try {
      r = await this._request({ url: `${this.base}/api/v3/uploads`, method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'multipart/form-data' },
        data, dataType: 'formData', readTimeout: UPLOAD_TIMEOUT_MS });
    } catch (e) { return reply(502, { error: `Could not reach Strava (${e.message}).` }); }
    if (r.status === 401) return reply(401, { error: 'Strava rejected the sign-in. Connect Strava again.', needsConnect: true });
    if (r.status === 429) return reply(429, { error: 'Strava rate limit reached - try again in 15 minutes.' });
    if (!r.ok || !r.data || typeof r.data !== 'object') return reply(502, { error: `Strava upload failed: ${(r.data && r.data.message) || 'HTTP ' + r.status}` });
    return reply(200, convertUpload(r.data));
  }

  async uploadStatus(id) {
    const token = await this.accessToken();
    if (!token) return reply(401, { error: 'Strava is not connected.', needsConnect: true });
    let r;
    try { r = await this._get(`uploads/${id}`, token); } catch (e) { return reply(502, { error: `Could not reach Strava (${e.message}).` }); }
    if (!r.ok || !r.data) return reply(502, { error: `Strava status check failed (HTTP ${r.status}).` });
    return reply(200, convertUpload(r.data));
  }

  async activities(query) {
    const after = query.get('after') || '', before = query.get('before') || '';
    if (!/^\d+$/.test(after) || !/^\d+$/.test(before)) return reply(400, { error: 'after and before (unix seconds) are required' });
    const token = await this.accessToken();
    if (!token) return reply(401, { error: 'Strava is not connected.', needsConnect: true });
    const out = [];
    for (let page = 1; page <= 10; page++) {
      let r;
      try { r = await this._get(`athlete/activities?after=${after}&before=${before}&per_page=200&page=${page}`, token); }
      catch (e) { return reply(502, { error: `Could not reach Strava (${e.message}).` }); }
      if (r.status === 401) return reply(401, { error: 'Strava needs permission to read your activities. Connect Strava again.', needsConnect: true });
      if (r.status === 429) return reply(429, { error: 'Strava rate limit reached - try again in 15 minutes.' });
      if (!r.ok) return reply(502, { error: `Strava activity list failed (HTTP ${r.status}).` });
      const items = Array.isArray(r.data) ? r.data : [];
      for (const a of items) if (a && a.id != null) out.push({ id: String(a.id), name: a.name || '', start: a.start_date || '', elapsed: a.elapsed_time || 0, moving: a.moving_time || 0, sport: a.sport_type || '', trainer: !!a.trainer });
      if (items.length < 200) break;
    }
    return reply(200, { activities: out });
  }

  /** "Sync from Strava": read-only, like server.js handleStravaSync. */
  async sync(query) {
    const t = await this.tokens();
    if (!t || !t.refresh_token) return reply(401, { error: 'Strava is not connected. Connect Strava first.', needsConnect: true });
    if (!/activity:read_all/.test(t.scope || '')) return reply(403, { error: 'Strava sync needs permission to read all your activities. Reconnect Strava (Disconnect, then Connect Strava) and allow access to your activities.', needsReconnect: true });
    const token = await this.accessToken();
    if (!token) return reply(401, { error: 'Strava sign-in expired or was revoked. Reconnect Strava.', needsConnect: true });

    const sid = query.get('streams');
    if (sid !== null) {
      if (!/^\d+$/.test(sid)) return reply(400, { error: 'streams must be one activity id' });
      let r;
      try { r = await this._get(`activities/${sid}/streams?keys=${SYNC_STREAM_KEYS}&key_by_type=true`, token); }
      catch (e) { return reply(502, { error: `Could not reach Strava (${e.message}).` }); }
      const rate = rateOf(r.headers);
      if (r.status === 401) return reply(401, { error: 'Strava rejected the sign-in. Reconnect Strava.', needsConnect: true });
      if (r.status === 429) return reply(200, { id: sid, rateLimited: true, rate });
      if (r.status === 404) return reply(200, { id: sid, missing: true, rate });
      if (!r.ok) return reply(502, { error: `Strava streams for ${sid} failed (HTTP ${r.status}).` });
      const streams = r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : {};
      return reply(200, { id: sid, streams, rate });
    }

    const ids = query.get('ids');
    if (ids !== null) {
      if (!/^\d+(,\d+)*$/.test(ids)) return reply(400, { error: 'ids must be a comma-separated list of activity ids' });
      const list = [...new Set(ids.split(','))];
      if (list.length > SYNC_MAX_DETAIL_IDS) return reply(400, { error: `At most ${SYNC_MAX_DETAIL_IDS} ids per request` });
      const out = [], missing = [];
      let rate = null;
      for (const id of list) {
        let r;
        try { r = await this._get(`activities/${id}`, token); } catch (e) { return reply(502, { error: `Could not reach Strava (${e.message}).`, activities: out, missing }); }
        rate = rateOf(r.headers);
        if (r.status === 401) return reply(401, { error: 'Strava rejected the sign-in. Reconnect Strava.', needsConnect: true });
        if (r.status === 429) return reply(200, { activities: out, missing, rateLimited: true, rate });
        if (r.status === 404) { missing.push(id); continue; }
        if (!r.ok || !r.data) return reply(502, { error: `Strava activity ${id} failed (HTTP ${r.status}).`, activities: out, missing });
        out.push(slimActivity(r.data, true));
      }
      return reply(200, { activities: out, missing, rateLimited: false, rate });
    }

    const afterMs = Date.parse(query.get('after') || ''), beforeMs = Date.parse(query.get('before') || '');
    if (!Number.isFinite(afterMs) || !Number.isFinite(beforeMs) || beforeMs <= afterMs) return reply(400, { error: 'after and before must be ISO dates, with after before before' });
    const after = Math.floor(afterMs / 1000), before = Math.ceil(beforeMs / 1000);
    const out = [];
    let rate = null, pages = 0;
    for (let page = 1; page <= SYNC_MAX_PAGES; page++) {
      let r;
      try { r = await this._get(`athlete/activities?after=${after}&before=${before}&per_page=200&page=${page}`, token); }
      catch (e) { return reply(502, { error: `Could not reach Strava (${e.message}).` }); }
      rate = rateOf(r.headers); pages = page;
      if (r.status === 401) return reply(401, { error: 'Strava needs permission to read your activities. Reconnect Strava.', needsConnect: true });
      if (r.status === 429) return reply(429, { error: 'Strava rate limit reached - try again in 15 minutes.', rate });
      if (!r.ok || !Array.isArray(r.data)) return reply(502, { error: `Strava activity list failed (HTTP ${r.status}).` });
      for (const a of r.data) if (a && a.id != null) out.push(slimActivity(a, false));
      if (r.data.length < 200) break;
    }
    return reply(200, { activities: out, after: new Date(afterMs).toISOString(), before: new Date(beforeMs).toISOString(), pages, rate });
  }

  /** Answers one /api/strava/ request: { status, body } or null when the path is not a Strava route. */
  async route(pathname, method, query, bodyText) {
    if (pathname === '/api/strava/status') return reply(200, await this.status());
    if (pathname === '/api/strava/disconnect') { if (method !== 'POST') return reply(405, { error: 'Method not allowed' }); await this.disconnect(); return reply(200, await this.status()); }
    if (pathname === '/api/strava/upload') {
      if (method !== 'POST') return reply(405, { error: 'Method not allowed' });
      let input; try { input = JSON.parse(bodyText || '{}'); } catch (e) { return reply(400, { error: 'Invalid JSON.' }); }
      return this.upload(input);
    }
    if (pathname === '/api/strava/activities') return this.activities(query);
    if (pathname === '/api/strava/sync') return this.sync(query);
    const m = pathname.match(/^\/api\/strava\/upload\/(\d+)$/);
    if (m) return this.uploadStatus(m[1]);
    return null;
  }
}
