#!/usr/bin/env node
/**
 * APEX VELO // LAB - local server.
 *
 * Serves the app on http://localhost:8080 and forwards AI Coach requests to the
 * Claude API. The API key is read here, on your computer, from the ANTHROPIC_API_KEY
 * environment variable or the .env file next to this script. It is never sent to
 * the browser, and the .env file is never served.
 *
 * Usage:  node server.js [--open]      (Node 18 or newer, no npm install needed)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

// ------------------------------------------------------------------ config --
function loadDotEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    else val = val.replace(/\s+#.*$/, '');
    // The app's own APEX_* settings always come from .env. For ANTHROPIC_API_KEY a key already set as an
    // environment variable wins, so you can keep it there instead of in the file.
    if (m[1].startsWith('APEX_') || !(process.env[m[1]] || '').trim()) process.env[m[1]] = val;
  }
}
const KEY_FROM_ENVIRONMENT = !!(process.env.ANTHROPIC_API_KEY || '').trim();
loadDotEnv(path.join(ROOT, '.env'));

/** Models the coach may use. Haiku 4.5 has no adaptive thinking or effort, so it uses a fixed thinking budget. */
const MODELS = {
  'claude-opus-5-5':           { label: 'Claude Opus 5.5', adaptive: true },
  'claude-sonnet-5':           { label: 'Claude Sonnet 5', adaptive: true },
  'claude-haiku-4-5-20251001': { label: 'Claude Haiku 4.5', adaptive: false }
};
const EFFORTS = ['low', 'medium', 'high'];

const API_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const DEFAULT_MODEL = MODELS[process.env.APEX_COACH_MODEL] ? process.env.APEX_COACH_MODEL : 'claude-opus-5-5';
const DEFAULT_EFFORT = EFFORTS.includes(process.env.APEX_COACH_EFFORT) ? process.env.APEX_COACH_EFFORT : 'low';
const PORT = parseInt(process.env.APEX_PORT || '8080', 10);
const API_BASE = (process.env.APEX_ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
const UPSTREAM_TIMEOUT_MS = 180000;
const MAX_BODY_BYTES = 256 * 1024;

const SYSTEM_PROMPT = 'You are an elite cycling coach and exercise physiologist. You prescribe structured indoor ERG sessions ' +
  'from the rider\'s real training data. Be specific and evidence-based, never invent data that is not in the request, ' +
  'and reply with exactly the JSON object requested - no prose before or after it.';

// ------------------------------------------------------------------ static --
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.fit': 'application/octet-stream', '.tcx': 'application/xml', '.csv': 'text/csv; charset=utf-8', '.md': 'text/markdown; charset=utf-8'
};
// Only app files are served: never dot-files (.env), this script, or the helper scripts.
const BLOCKED = /(^|[\\/])\.|^server\.js$|\.(ps1|cmd|bat|sh)$/i;

function serveStatic(req, res, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch (e) { return send(res, 400, 'Bad request'); }
  if (rel.includes('\0')) return send(res, 400, 'Bad request');
  rel = rel.replace(/^\/+/, '') || 'index.html';
  const file = path.resolve(ROOT, rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return send(res, 403, 'Forbidden');
  if (BLOCKED.test(path.relative(ROOT, file))) return send(res, 404, 'Not found');
  fs.stat(file, (err, st) => {
    if (err) return send(res, 404, 'Not found');
    const target = st.isDirectory() ? path.join(file, 'index.html') : file;
    fs.readFile(target, (err2, data) => {
      if (err2) return send(res, 404, 'Not found');
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');

// --------------------------------------------------------------------- API --
// Private-LAN IPv4 ranges (RFC1918 + link-local), so a phone on the same home
// Wi-Fi as this PC can reach the API too - never a public/internet address.
const LAN_HOST_RE = /^(10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2})(:\d+)?$/;
/** Only pages served by this server (from this PC or another device on the same LAN) may call the API. */
function isLocalRequest(req) {
  const host = req.headers.host || '';
  const hostOk = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host) || LAN_HOST_RE.test(host);
  const origin = req.headers.origin;
  const originOk = !origin || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin) || LAN_HOST_RE.test(origin.replace(/^https?:\/\//, ''));
  return hostOk && originOk;
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    // Over the limit: stop keeping data but drain the stream, so the client gets a clean 413 instead of a reset.
    req.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on('end', () => size > limit
      ? reject(Object.assign(new Error('Request too large'), { status: 413 }))
      : resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function status() {
  return {
    provider: 'claude',
    configured: !!API_KEY,
    model: DEFAULT_MODEL,
    effort: DEFAULT_EFFORT,
    models: Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label, effort: m.adaptive })),
    efforts: EFFORTS
  };
}

function buildClaudeRequest(prompt, model, effort) {
  const body = {
    model,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }]
  };
  if (MODELS[model].adaptive) {
    body.thinking = { type: 'adaptive', display: 'summarized' };
    body.output_config = { effort };
  } else {
    body.thinking = { type: 'enabled', budget_tokens: 4000 };
  }
  return body;
}

async function handleCoach(req, res) {
  if (!isLocalRequest(req)) return sendJson(res, 403, { error: 'Requests are only accepted from the app on localhost.' });
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'Content-Type must be application/json.' });
  if (!API_KEY) return sendJson(res, 503, { error: 'No Anthropic API key. Add ANTHROPIC_API_KEY to the .env file and restart the server.' });

  let input;
  try { input = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, e.status || 400, { error: e.status ? e.message : 'Invalid JSON.' }); }
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (!prompt.trim() || prompt.length > 100000) return sendJson(res, 400, { error: 'A prompt of 1-100000 characters is required.' });
  const model = MODELS[input.model] ? input.model : DEFAULT_MODEL;
  const effort = EFFORTS.includes(input.effort) ? input.effort : DEFAULT_EFFORT;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  req.on('close', () => { if (!res.writableEnded) ac.abort(); });
  const t0 = Date.now();
  try {
    const upstream = await fetch(`${API_BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(buildClaudeRequest(prompt, model, effort)),
      signal: ac.signal
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const msg = (data && data.error && data.error.message) || `HTTP ${upstream.status}`;
      console.warn(`[coach] ${model} failed: ${upstream.status} ${msg}`);
      return sendJson(res, 502, { error: `Claude API error ${upstream.status}: ${msg}`, upstreamStatus: upstream.status });
    }
    const blocks = Array.isArray(data.content) ? data.content : [];
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
    const thinking = blocks.filter(b => b.type === 'thinking' && b.thinking).map(b => b.thinking).join('\n\n');
    const usage = data.usage || {};
    console.log(`[coach] ${data.model || model} (${MODELS[model].adaptive ? effort : 'budget'}) ${((Date.now() - t0) / 1000).toFixed(1)} s, ${usage.input_tokens || 0} in / ${usage.output_tokens || 0} out tokens, stop=${data.stop_reason}`);
    return sendJson(res, 200, { text, thinking, model: data.model || model, effort: MODELS[model].adaptive ? effort : null, stopReason: data.stop_reason, usage });
  } catch (err) {
    const aborted = err.name === 'AbortError';
    console.warn(`[coach] ${model} ${aborted ? 'timed out / cancelled' : 'request failed: ' + err.message}`);
    return sendJson(res, aborted ? 504 : 502, { error: aborted ? 'Claude did not answer in time.' : `Could not reach the Claude API (${err.message}).` });
  } finally {
    clearTimeout(timer);
  }
}


// ------------------------------------------------------------------ Strava --
// Personal Strava API application: STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET in .env.
// Tokens live in .strava-tokens.json next to this script (a dot-file, never served).
const STRAVA_CLIENT_ID = (process.env.STRAVA_CLIENT_ID || '').trim();
const STRAVA_CLIENT_SECRET = (process.env.STRAVA_CLIENT_SECRET || '').trim();
const STRAVA_BASE = (process.env.APEX_STRAVA_BASE_URL || 'https://www.strava.com').replace(/\/+$/, '');
const STRAVA_TOKEN_FILE = path.join(ROOT, '.strava-tokens.json');
const STRAVA_MAX_UPLOAD = 12 * 1024 * 1024;
const stravaStates = new Map();

function readStravaTokens() {
  try { return JSON.parse(fs.readFileSync(STRAVA_TOKEN_FILE, 'utf8')); } catch (e) { return null; }
}
function saveStravaTokens(d, scope, athlete) {
  const a = athlete || d.athlete || {};
  fs.writeFileSync(STRAVA_TOKEN_FILE, JSON.stringify({
    access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at, scope: scope || '',
    athlete: { id: a.id, firstname: a.firstname || '', lastname: a.lastname || '' }
  }, null, 2));
}
async function stravaForm(url, fields) {
  const r = await fetch(url, { method: 'POST', body: new URLSearchParams(fields) });
  const data = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, data };
}
async function stravaAccessToken() {
  const t = readStravaTokens();
  if (!t || !t.refresh_token) return null;
  if (t.access_token && Number(t.expires_at) > Date.now() / 1000 + 120) return t.access_token;
  const r = await stravaForm(`${STRAVA_BASE}/oauth/token`, { client_id: STRAVA_CLIENT_ID, client_secret: STRAVA_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: t.refresh_token });
  if (!r.ok || !r.data) { console.warn(`[strava] token refresh failed: ${r.status}`); return null; }
  saveStravaTokens(r.data, t.scope, t.athlete);
  return r.data.access_token;
}
function stravaStatus() {
  const t = readStravaTokens();
  return {
    configured: !!(STRAVA_CLIENT_ID && STRAVA_CLIENT_SECRET),
    connected: !!(t && t.refresh_token),
    athlete: t && t.athlete ? `${t.athlete.firstname || ''} ${t.athlete.lastname || ''}`.trim() : null,
    canUpload: !!(t && /activity:write/.test(t.scope || '')),
    canCheck: !!(t && /activity:read/.test(t.scope || ''))
  };
}
function sendHtml(res, status, title, body) {
  send(res, status, `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:system-ui,sans-serif;background:#090d16;color:#e2e8f0;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:520px;padding:32px;border:1px solid #1e293b;border-radius:16px;background:#0f172a}h1{font-size:20px}a{color:#fc4c02}</style></head><body><main>${body}</main></body></html>`, 'text/html; charset=utf-8');
}
const escHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Maps Strava's upload record to what the app shows. A duplicate counts as "already on Strava". */
function convertUpload(d) {
  const err = d.error ? String(d.error) : '';
  const dup = (err.match(/duplicate of[^0-9]*?(?:activities\/)?(\d+)/) || [])[1];
  let state = 'processing';
  let activity = d.activity_id ? String(d.activity_id) : null;
  if (activity) state = 'sent';
  else if (dup) { state = 'duplicate'; activity = dup; }
  else if (err) state = 'failed';
  return { uploadId: String(d.id_str || d.id || ''), state, activityId: activity, status: d.status || '', error: err || null };
}

async function handleStrava(req, res, urlPath, query) {
  if (urlPath === '/api/strava/status') {
    if (!isLocalRequest(req)) return sendJson(res, 403, { error: 'Forbidden' });
    return sendJson(res, 200, stravaStatus());
  }
  if (urlPath === '/api/strava/connect') {
    if (!isLocalRequest(req)) return send(res, 403, 'Forbidden');
    if (!STRAVA_CLIENT_ID || !STRAVA_CLIENT_SECRET) return sendHtml(res, 400, 'Strava not set up', '<h1>Strava is not set up yet</h1><p>Add <code>STRAVA_CLIENT_ID</code> and <code>STRAVA_CLIENT_SECRET</code> to the <code>.env</code> file, restart the server, then try again.</p>');
    const state = require('crypto').randomBytes(16).toString('hex');
    stravaStates.set(state, Date.now());
    const redirect = `http://localhost:${PORT}/api/strava/callback`;
    const url = `${STRAVA_BASE}/oauth/authorize?client_id=${encodeURIComponent(STRAVA_CLIENT_ID)}&response_type=code&redirect_uri=${encodeURIComponent(redirect)}&approval_prompt=auto&scope=${encodeURIComponent('read,activity:read_all,activity:write')}&state=${state}`;
    res.writeHead(302, { Location: url, 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (urlPath === '/api/strava/callback') {
    const state = query.get('state') || '';
    const created = stravaStates.get(state);
    stravaStates.delete(state);
    if (!created || Date.now() - created > 15 * 60000) return sendHtml(res, 400, 'Strava', '<h1>Link expired</h1><p>Start again from the app with <b>Connect Strava</b>.</p>');
    if (query.get('error') || !query.get('code')) return sendHtml(res, 400, 'Strava', "<h1>Strava access was not granted</h1><p>Nothing was changed. You can try again from the app.</p><p><a href='/index.html'>Back to Apex Velo Lab</a></p>");
    const scope = query.get('scope') || '';
    if (!/activity:write/.test(scope)) return sendHtml(res, 400, 'Strava', "<h1>Upload permission missing</h1><p>Please tick <b>Upload your activities</b> on the Strava screen, then connect again.</p><p><a href='/api/strava/connect'>Connect again</a></p>");
    const r = await stravaForm(`${STRAVA_BASE}/oauth/token`, { client_id: STRAVA_CLIENT_ID, client_secret: STRAVA_CLIENT_SECRET, code: query.get('code'), grant_type: 'authorization_code' });
    if (!r.ok || !r.data) return sendHtml(res, 502, 'Strava', `<h1>Could not finish connecting</h1><p>Strava answered ${r.status}. Check STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET in .env.</p>`);
    saveStravaTokens(r.data, scope);
    const who = escHtml(`${(r.data.athlete || {}).firstname || ''} ${(r.data.athlete || {}).lastname || ''}`.trim());
    console.log(`[strava] connected as ${who}`);
    return sendHtml(res, 200, 'Strava connected', `<h1>Connected to Strava</h1><p>Signed in as <b>${who}</b>. You can close this tab and go back to Apex Velo Lab.</p><script>try{window.opener&&window.opener.postMessage({apexStrava:'connected'},location.origin)}catch(e){};setTimeout(function(){window.close()},1500)</script>`);
  }
  if (urlPath === '/api/strava/disconnect') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    if (!isLocalRequest(req)) return sendJson(res, 403, { error: 'Forbidden' });
    const token = await stravaAccessToken();
    if (token) await stravaForm(`${STRAVA_BASE}/oauth/deauthorize`, { access_token: token }).catch(() => {});
    try { fs.unlinkSync(STRAVA_TOKEN_FILE); } catch (e) { /* not connected */ }
    return sendJson(res, 200, stravaStatus());
  }
  if (urlPath === '/api/strava/upload') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    if (!isLocalRequest(req)) return sendJson(res, 403, { error: 'Requests are only accepted from the app on localhost.' });
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'Content-Type must be application/json.' });
    const token = await stravaAccessToken();
    if (!token) return sendJson(res, 401, { error: 'Strava is not connected (or access was revoked). Connect Strava and try again.', needsConnect: true });
    let input;
    try { input = JSON.parse(await readBody(req, STRAVA_MAX_UPLOAD)); } catch (e) { return sendJson(res, e.status || 400, { error: e.status ? 'Ride file too large' : 'Invalid JSON.' }); }
    const fit = Buffer.from(String(input.fitBase64 || ''), 'base64');
    if (fit.length < 14) return sendJson(res, 400, { error: 'Ride file is empty.' });
    const form = new FormData();
    form.append('file', new Blob([fit], { type: 'application/octet-stream' }), 'apex-velo-ride.fit');
    const parts = { data_type: 'fit', name: input.name || '', description: input.description || '', trainer: '1', commute: '0', external_id: input.externalId || '' };
    for (const [k, v] of Object.entries(parts)) if (v !== '') form.append(k, String(v));
    let r;
    try { r = await fetch(`${STRAVA_BASE}/api/v3/uploads`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form }); }
    catch (e) { return sendJson(res, 502, { error: `Could not reach Strava (${e.message}).` }); }
    const d = await r.json().catch(() => null);
    if (r.status === 401) return sendJson(res, 401, { error: 'Strava rejected the sign-in. Connect Strava again.', needsConnect: true });
    if (r.status === 429) return sendJson(res, 429, { error: 'Strava rate limit reached - try again in 15 minutes.' });
    if (!r.ok || !d) return sendJson(res, 502, { error: `Strava upload failed: ${(d && d.message) || 'HTTP ' + r.status}` });
    const out = convertUpload(d);
    console.log(`[strava] upload ${out.uploadId}: ${out.state}`);
    return sendJson(res, 200, out);
  }
  if (urlPath === '/api/strava/activities') {
    if (!isLocalRequest(req)) return sendJson(res, 403, { error: 'Forbidden' });
    const after = query.get('after') || '', before = query.get('before') || '';
    if (!/^\d+$/.test(after) || !/^\d+$/.test(before)) return sendJson(res, 400, { error: 'after and before (unix seconds) are required' });
    const token = await stravaAccessToken();
    if (!token) return sendJson(res, 401, { error: 'Strava is not connected.', needsConnect: true });
    const out = [];
    for (let page = 1; page <= 10; page++) {
      let r;
      try { r = await fetch(`${STRAVA_BASE}/api/v3/athlete/activities?after=${after}&before=${before}&per_page=200&page=${page}`, { headers: { Authorization: `Bearer ${token}` } }); }
      catch (e) { return sendJson(res, 502, { error: `Could not reach Strava (${e.message}).` }); }
      if (r.status === 401) return sendJson(res, 401, { error: 'Strava needs permission to read your activities. Connect Strava again.', needsConnect: true });
      if (r.status === 429) return sendJson(res, 429, { error: 'Strava rate limit reached - try again in 15 minutes.' });
      if (!r.ok) return sendJson(res, 502, { error: `Strava activity list failed (HTTP ${r.status}).` });
      const items = await r.json().catch(() => []);
      for (const a of items || []) if (a && a.id != null) out.push({ id: String(a.id), name: a.name || '', start: a.start_date || '', elapsed: a.elapsed_time || 0, moving: a.moving_time || 0, sport: a.sport_type || '', trainer: !!a.trainer });
      if (!Array.isArray(items) || items.length < 200) break;
    }
    return sendJson(res, 200, { activities: out });
  }
  const m = urlPath.match(/^\/api\/strava\/upload\/(\d+)$/);
  if (m) {
    if (!isLocalRequest(req)) return sendJson(res, 403, { error: 'Forbidden' });
    const token = await stravaAccessToken();
    if (!token) return sendJson(res, 401, { error: 'Strava is not connected.', needsConnect: true });
    let r;
    try { r = await fetch(`${STRAVA_BASE}/api/v3/uploads/${m[1]}`, { headers: { Authorization: `Bearer ${token}` } }); }
    catch (e) { return sendJson(res, 502, { error: `Could not reach Strava (${e.message}).` }); }
    const d = await r.json().catch(() => null);
    if (!r.ok || !d) return sendJson(res, 502, { error: `Strava status check failed (HTTP ${r.status}).` });
    return sendJson(res, 200, convertUpload(d));
  }
  return sendJson(res, 404, { error: 'Not found' });
}

// -------------------------------------------------------------- phone view --
// The PC app publishes a small live snapshot about once a second; the phone page
// (live.html) reads it and queues simple commands, which the PC app picks up on
// its next publish. Nothing is stored on disk.
const LIVE_CMDS = new Set(['toggle', 'skip', 'bias-up', 'bias-down', 'bias-reset']);
const live = { snapshot: null, at: 0, cmds: [] };

async function handleLive(req, res, urlPath) {
  if (!isLocalRequest(req)) return sendJson(res, 403, { error: 'Forbidden' });
  if (urlPath === '/api/live') {
    if (req.method === 'GET') {
      return sendJson(res, 200, { snapshot: live.snapshot, ageMs: live.at ? Date.now() - live.at : null, pending: live.cmds.length });
    }
    if (req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req, 64 * 1024)); } catch (e) { return sendJson(res, e.status || 400, { error: e.status ? e.message : 'Invalid JSON.' }); }
      live.snapshot = body && typeof body === 'object' ? body : null;
      live.at = Date.now();
      const cmds = live.cmds; live.cmds = [];
      return sendJson(res, 200, { cmds });
    }
    return sendJson(res, 405, { error: 'Method not allowed' });
  }
  if (urlPath === '/api/live/cmd') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    let body;
    try { body = JSON.parse(await readBody(req, 1024)); } catch (e) { return sendJson(res, 400, { error: 'Invalid JSON.' }); }
    const cmd = body && body.cmd;
    if (!LIVE_CMDS.has(cmd)) return sendJson(res, 400, { error: 'Unknown command' });
    if (!live.at || Date.now() - live.at > 10000) return sendJson(res, 409, { error: 'The app on the PC is not open.' });
    if (live.cmds.length < 20) live.cmds.push({ cmd, at: Date.now() });
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { error: 'Not found' });
}

// ------------------------------------------------------------------ server --
function createServer() {
  return http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    if (urlPath === '/api/live' || urlPath === '/api/live/cmd') {
      return handleLive(req, res, urlPath).catch((e) => { if (!res.headersSent) sendJson(res, 500, { error: e.message }); });
    }
    if (urlPath === '/api/coach/status') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      if (!isLocalRequest(req)) return sendJson(res, 403, { error: 'Forbidden' });
      return sendJson(res, 200, status());
    }
    if (urlPath === '/api/coach') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
      return handleCoach(req, res).catch((e) => { if (!res.headersSent) sendJson(res, 500, { error: e.message }); });
    }
    if (urlPath.startsWith('/api/strava/')) {
      const query = new URL(req.url, 'http://localhost').searchParams;
      return handleStrava(req, res, urlPath, query).catch((e) => { if (!res.headersSent) sendJson(res, 500, { error: e.message }); });
    }
    if (urlPath.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, urlPath);
  });
}

if (require.main === module) {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 18) { console.error(`Node 18 or newer is required (found ${process.versions.node}).`); process.exit(1); }
  const server = createServer();
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use - is Apex Velo Lab already running? Set APEX_PORT in .env to change it.` : e.message);
    process.exit(1);
  });
  server.listen(PORT, '0.0.0.0', () => {
    const url = `http://localhost:${PORT}/`;
    console.log(`Apex Velo Lab running at ${url}`);
    try {
      const os = require('os');
      const nets = os.networkInterfaces();
      const lanIps = [];
      for (const name of Object.keys(nets)) {
        for (const net of nets[name] || []) {
          if (net.family === 'IPv4' && !net.internal) lanIps.push(net.address);
        }
      }
      if (lanIps.length) {
        console.log('Phone view (same Wi-Fi as this PC) - open in Safari:');
        for (const ip of lanIps) console.log(`  http://${ip}:${PORT}/live.html`);
      }
    } catch { /* ignore - LAN IP display is best-effort */ }
    console.log(API_KEY
      ? `AI Coach: ${MODELS[DEFAULT_MODEL].label}, ${DEFAULT_EFFORT} effort (key from ${KEY_FROM_ENVIRONMENT ? 'the ANTHROPIC_API_KEY environment variable' : '.env'})`
      : 'AI Coach: no ANTHROPIC_API_KEY found - add it to .env to enable Claude. The offline engine still works.');
    console.log('Press Ctrl+C to stop.');
    if (process.argv.includes('--open')) {
      const { spawn } = require('child_process');
      const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch (e) { /* open it manually */ }
    }
  });
}

module.exports = { createServer, buildClaudeRequest, loadDotEnv, MODELS };
