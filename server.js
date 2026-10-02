#!/usr/bin/env node
/**
 * APEX VELO // LAB - local server.
 *
 * Serves the app on http://localhost:8080 and forwards AI Coach requests to the
 * Claude API or the Gemini API. The API keys are read here, on your computer, from the
 * ANTHROPIC_API_KEY / GEMINI_API_KEY environment variables or the .env file next to this
 * script. They are never sent to the browser, and the .env file is never served.
 *
 * Usage:  node server.js [--open]      (Node 18 or newer, no npm install needed)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

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
    // The app's own APEX_* settings always come from .env. For the API keys a key already set as an
    // environment variable wins, so you can keep it there instead of in the file.
    if (m[1].startsWith('APEX_') || !(process.env[m[1]] || '').trim()) process.env[m[1]] = val;
  }
}
const KEY_FROM_ENVIRONMENT = !!(process.env.ANTHROPIC_API_KEY || '').trim();
const GEMINI_KEY_FROM_ENVIRONMENT = !!(process.env.GEMINI_API_KEY || '').trim();
loadDotEnv(path.join(ROOT, '.env'));

/**
 * Models the coach may use. Haiku 4.5 has no adaptive thinking or effort, so it uses a fixed thinking budget.
 * For Gemini the effort setting maps to thinkingLevel (low / medium / high).
 */
const MODELS = {
  'claude-opus-5-5':           { label: 'Claude Opus 5.5', provider: 'claude', adaptive: true },
  'claude-sonnet-5':           { label: 'Claude Sonnet 5', provider: 'claude', adaptive: true },
  'claude-haiku-4-5-20251001': { label: 'Claude Haiku 4.5', provider: 'claude', adaptive: false },
  'gemini-3.8-flash':          { label: 'Gemini 3.8 Flash', provider: 'gemini', adaptive: true },
  'gemini-3.1-pro-preview':    { label: 'Gemini 3.1 Pro (preview)', provider: 'gemini', adaptive: true },
  'gemini-3.1-flash-lite':     { label: 'Gemini 3.1 Flash-Lite', provider: 'gemini', adaptive: true }
};
const PROVIDERS = {
  claude: { label: 'Claude', keyName: 'ANTHROPIC_API_KEY', fallbackModel: 'claude-opus-5-5' },
  gemini: { label: 'Gemini', keyName: 'GEMINI_API_KEY', fallbackModel: 'gemini-3.8-flash' }
};
const EFFORTS = ['low', 'medium', 'high'];

const API_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const KEYS = { claude: API_KEY, gemini: GEMINI_API_KEY };
const pickModel = (id, provider) => (MODELS[id] && MODELS[id].provider === provider ? id : PROVIDERS[provider].fallbackModel);
const DEFAULT_MODELS = {
  claude: pickModel(process.env.APEX_COACH_MODEL, 'claude'),
  gemini: pickModel(process.env.APEX_GEMINI_MODEL, 'gemini')
};
// Default provider: APEX_COACH_PROVIDER if set, otherwise whichever has a key (Claude first).
const DEFAULT_PROVIDER = PROVIDERS[process.env.APEX_COACH_PROVIDER] ? process.env.APEX_COACH_PROVIDER
  : (!API_KEY && GEMINI_API_KEY ? 'gemini' : 'claude');
const DEFAULT_MODEL = DEFAULT_MODELS[DEFAULT_PROVIDER];
const DEFAULT_EFFORT = EFFORTS.includes(process.env.APEX_COACH_EFFORT) ? process.env.APEX_COACH_EFFORT : 'low';
const PORT = parseInt(process.env.APEX_PORT || '8080', 10);
const API_BASE = (process.env.APEX_ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
const GEMINI_BASE = (process.env.APEX_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
const UPSTREAM_TIMEOUT_MS = 180000;
const MAX_BODY_BYTES = 256 * 1024;

const SYSTEM_PROMPT = 'You are an elite cycling coach and exercise physiologist. You prescribe structured indoor ERG sessions ' +
  'from the rider\'s real training data. Be specific and evidence-based, never invent data that is not in the request, ' +
  'and use the requested response format (JSON when requested, otherwise plain text or markdown). ' +
  'Explain things to a beginner in short, everyday sentences. Lead with what to do and why it helps. ' +
  'Avoid sports-science jargon and acronyms in advice: say fitness base, recent training strain, and freshness instead of CTL, ATL, and TSB. ' +
  'If a technical term is essential, explain it immediately in plain words. Use numbers only when needed to act, such as ride duration or a power target; ' +
  'do not repeat training scores, percentages, or tables of statistics in prose. Keep numeric workout fields and schema keys exact. ' +
  'Treat calculated scores as estimates, not proof of illness, overtraining, or full recovery. Be respectful and concise.';

// Ask: a separate data analyst for free questions about the rider's own training (the coach above builds workouts).
// Kept identical in start_server.ps1 (ASCII only, so Windows PowerShell 5.1 reads it unchanged).
const ASK_SYSTEM_PROMPT = 'You are the rider\'s personal cycling data analyst inside the Apex Velo Lab app. ' +
  'Answer questions about their training using only the TRAINING DATA block and what the rider tells you in this conversation. ' +
  'Never invent rides, numbers or dates. If the data cannot answer the question, say exactly what is missing and how the rider could get it ' +
  '(for example: ride with the heart-rate strap, or pick a longer period). ' +
  'Start with the direct answer in one or two sentences. Then give the evidence as up to five short bullet points with the actual numbers and dates. ' +
  'End with one practical takeaway when it helps. Keep the whole answer short unless the rider asks for detail. ' +
  'Use plain English for someone who is not a sports scientist. The first time you use an acronym, add its plain meaning in brackets, ' +
  'for example TSS (workout load score), CTL (fitness base), ATL (recent strain), TSB (freshness), NP (surge-weighted average power), ' +
  'CP (long-effort limit) or W\' (burst energy reserve). ' +
  'Treat calculated scores as estimates, not proof of illness, overtraining or full recovery, and do not diagnose health problems: suggest a professional for health worries. ' +
  'For a full workout or a training plan, point the rider to the Coach tab. ' +
  'Format with short markdown: bold the key numbers, use bullet lists, and keep any table to four columns or fewer.';
const ASK_MAX_MESSAGES = 40;
const ASK_MAX_MESSAGE_CHARS = 20000;
const ASK_MAX_CONTEXT_CHARS = 150000;
// Server-side refusal fallback (Claude Opus 5.5): a declined request is re-run on Anthropic's recommended model.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// ------------------------------------------------------------------ static --
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.fit': 'application/octet-stream', '.tcx': 'application/xml', '.csv': 'text/csv; charset=utf-8', '.md': 'text/markdown; charset=utf-8'
};
// Only app files are served: never dot-files (.env), this script, or the helper scripts.
const BLOCKED = /(^|[\\/])\.|^server\.js$|\.(ps1|cmd|bat|sh)$|^data[\\/](backups|health)([\\/]|$)/i;

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
/**
 * The real client address (not a header a client can set) must be this PC or a private home
 * network address - so even on a cafe Wi-Fi nothing outside answers. IPv4-mapped IPv6 is unwrapped.
 */
function isAllowedClient(req) {
  let ip = String((req.socket && req.socket.remoteAddress) || '');
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1' || /^127\./.test(ip)) return true;
  return /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || /^(f[cd][0-9a-f]{2}|fe80):/i.test(ip);
}

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
  const providers = {};
  for (const [id, p] of Object.entries(PROVIDERS)) providers[id] = { label: p.label, configured: !!KEYS[id], model: DEFAULT_MODELS[id] };
  return {
    provider: DEFAULT_PROVIDER,
    providers,
    configured: !!KEYS[DEFAULT_PROVIDER],
    model: DEFAULT_MODEL,
    effort: DEFAULT_EFFORT,
    models: Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label, provider: m.provider, effort: m.adaptive })),
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

function buildGeminiRequest(prompt, model, effort) {
  return {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: 16000,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingLevel: effort, includeThoughts: true }
    }
  };
}

/** Thinking settings shared by the coach and Ask: adaptive with effort, or a fixed budget (Haiku 4.5). */
function claudeThinking(body, model, effort) {
  if (MODELS[model].adaptive) {
    body.thinking = { type: 'adaptive', display: 'summarized' };
    body.output_config = { effort };
  } else {
    body.thinking = { type: 'enabled', budget_tokens: 4000 };
  }
  return body;
}

/**
 * Ask request: the analyst prompt, then the rider's data as a second system block marked for prompt caching
 * (it is identical on every follow-up question, so later turns read it from the cache), then the conversation.
 */
function buildClaudeAskRequest(messages, context, model, effort, fallback = true) {
  const body = {
    model,
    max_tokens: 16000,
    system: [
      { type: 'text', text: ASK_SYSTEM_PROMPT },
      { type: 'text', text: `TRAINING DATA\n${context || '(no data for this period)'}`, cache_control: { type: 'ephemeral' } }
    ],
    messages: messages.map(m => ({ role: m.role, content: m.content }))
  };
  claudeThinking(body, model, effort);
  if (fallback && model === 'claude-opus-5-5') body.fallbacks = 'default';
  return body;
}

/** Ask request for Gemini: plain text answers (no JSON response type), assistant turns as role "model". */
function buildGeminiAskRequest(messages, context, effort) {
  return {
    systemInstruction: { parts: [{ text: ASK_SYSTEM_PROMPT }, { text: `TRAINING DATA\n${context || '(no data for this period)'}` }] },
    contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    generationConfig: {
      maxOutputTokens: 16000,
      thinkingConfig: { thinkingLevel: effort, includeThoughts: true }
    }
  };
}

/** Calls Claude with a request body and returns the app's common reply shape. */
async function callClaude(reqBody, signal) {
  const headers = { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' };
  if (reqBody.fallbacks) headers['anthropic-beta'] = FALLBACK_BETA;
  const model = reqBody.model;
  const upstream = await fetch(`${API_BASE}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify(reqBody),
    signal
  });
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    const msg = (data && data.error && data.error.message) || `HTTP ${upstream.status}`;
    return { error: `Claude API error ${upstream.status}: ${msg}`, upstreamStatus: upstream.status, log: `${upstream.status} ${msg}` };
  }
  const blocks = Array.isArray(data.content) ? data.content : [];
  const usage = data.usage || {};
  return {
    text: blocks.filter(b => b.type === 'text').map(b => b.text).join(''),
    thinking: blocks.filter(b => b.type === 'thinking' && b.thinking).map(b => b.thinking).join('\n\n'),
    model: data.model || model,
    stopReason: data.stop_reason,
    usage: { input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0, cache_read_input_tokens: usage.cache_read_input_tokens || 0 }
  };
}

/** Calls Gemini (generateContent) with a request body and returns the app's common reply shape. */
async function callGemini(reqBody, model, signal) {
  const upstream = await fetch(`${GEMINI_BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify(reqBody),
    signal
  });
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    const msg = (data && data.error && data.error.message) || `HTTP ${upstream.status}`;
    return { error: `Gemini API error ${upstream.status}: ${msg}`, upstreamStatus: upstream.status, log: `${upstream.status} ${msg}` };
  }
  const cand = Array.isArray(data.candidates) && data.candidates[0];
  if (!cand) {
    const why = (data.promptFeedback && data.promptFeedback.blockReason) || 'no answer';
    return { error: `Gemini returned no answer (${why}).`, upstreamStatus: 502, log: `no candidates (${why})` };
  }
  const parts = (cand.content && Array.isArray(cand.content.parts)) ? cand.content.parts : [];
  const um = data.usageMetadata || {};
  return {
    text: parts.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join(''),
    thinking: parts.filter(p => p.thought && p.text).map(p => p.text).join('\n\n'),
    model: data.modelVersion || model,
    stopReason: cand.finishReason === 'MAX_TOKENS' ? 'max_tokens' : String(cand.finishReason || '').toLowerCase(),
    usage: { input_tokens: um.promptTokenCount || 0, output_tokens: (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0) }
  };
}

/** The model decides the provider; without a (known) model, use the requested or default provider's default model. */
function resolveEngine(input) {
  const provider = MODELS[input.model] ? MODELS[input.model].provider : (PROVIDERS[input.provider] ? input.provider : DEFAULT_PROVIDER);
  const model = MODELS[input.model] ? input.model : DEFAULT_MODELS[provider];
  const effort = EFFORTS.includes(input.effort) ? input.effort : DEFAULT_EFFORT;
  return { provider, model, effort, p: PROVIDERS[provider] };
}

/** Reads and checks a JSON request from the app (local only); returns the parsed body or sends the error. */
async function readAppJson(req, res) {
  if (!isLocalRequest(req)) { sendJson(res, 403, { error: 'Requests are only accepted from the app on localhost.' }); return null; }
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) { sendJson(res, 415, { error: 'Content-Type must be application/json.' }); return null; }
  try { return JSON.parse(await readBody(req)); } catch (e) { sendJson(res, e.status || 400, { error: e.status ? e.message : 'Invalid JSON.' }); return null; }
}

async function handleCoach(req, res) {
  const input = await readAppJson(req, res);
  if (!input) return;
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (!prompt.trim() || prompt.length > 100000) return sendJson(res, 400, { error: 'A prompt of 1-100000 characters is required.' });
  const { provider, model, effort, p } = resolveEngine(input);
  if (!KEYS[provider]) return sendJson(res, 503, { error: `No ${p.label} API key. Add ${p.keyName} to the .env file and restart the server.` });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  req.on('close', () => { if (!res.writableEnded) ac.abort(); });
  const t0 = Date.now();
  try {
    const out = provider === 'gemini'
      ? await callGemini(buildGeminiRequest(prompt, model, effort), model, ac.signal)
      : await callClaude(buildClaudeRequest(prompt, model, effort), ac.signal);
    if (out.error) {
      console.warn(`[coach] ${model} failed: ${out.log}`);
      return sendJson(res, 502, { error: out.error, upstreamStatus: out.upstreamStatus });
    }
    const shownEffort = MODELS[model].adaptive ? effort : null;
    console.log(`[coach] ${out.model} (${shownEffort || 'budget'}) ${((Date.now() - t0) / 1000).toFixed(1)} s, ${out.usage.input_tokens} in / ${out.usage.output_tokens} out tokens, stop=${out.stopReason}`);
    return sendJson(res, 200, { text: out.text, thinking: out.thinking, provider, model: out.model, effort: shownEffort, stopReason: out.stopReason, usage: out.usage });
  } catch (err) {
    const aborted = err.name === 'AbortError';
    console.warn(`[coach] ${model} ${aborted ? 'timed out / cancelled' : 'request failed: ' + err.message}`);
    return sendJson(res, aborted ? 504 : 502, { error: aborted ? `${p.label} did not answer in time.` : `Could not reach the ${p.label} API (${err.message}).` });
  } finally {
    clearTimeout(timer);
  }
}


/**
 * Checks an Ask conversation: 1-40 messages, user / assistant alternating, starting and ending with the
 * rider; each message 1-20000 characters; the data block at most 150000 characters.
 * Returns { messages, context } or { error }.
 */
function validateAsk(input) {
  const list = Array.isArray(input.messages) ? input.messages : null;
  if (!list || !list.length || list.length > ASK_MAX_MESSAGES) return { error: `Send 1-${ASK_MAX_MESSAGES} messages.` };
  const messages = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i] || {};
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : null;
    const content = typeof m.content === 'string' ? m.content.trim() : '';
    if (!role || !content || content.length > ASK_MAX_MESSAGE_CHARS) return { error: `Each message needs a role (user or assistant) and 1-${ASK_MAX_MESSAGE_CHARS} characters.` };
    if (role !== (i % 2 === 0 ? 'user' : 'assistant')) return { error: 'Messages must alternate, starting with the rider.' };
    messages.push({ role, content });
  }
  if (messages[messages.length - 1].role !== 'user') return { error: 'The last message must be the rider\'s question.' };
  const context = typeof input.context === 'string' ? input.context : '';
  if (context.length > ASK_MAX_CONTEXT_CHARS) return { error: `The training data is too long (over ${ASK_MAX_CONTEXT_CHARS} characters): pick a shorter period.` };
  return { messages, context };
}

/** POST /api/ask - free questions about the rider's own training data, answered by Claude or Gemini. */
async function handleAsk(req, res) {
  const input = await readAppJson(req, res);
  if (!input) return;
  const v = validateAsk(input);
  if (v.error) return sendJson(res, 400, { error: v.error });
  const { provider, model, effort, p } = resolveEngine(input);
  if (!KEYS[provider]) return sendJson(res, 503, { error: `No ${p.label} API key. Add ${p.keyName} to the .env file and restart the server.` });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  req.on('close', () => { if (!res.writableEnded) ac.abort(); });
  const t0 = Date.now();
  try {
    let out;
    if (provider === 'gemini') out = await callGemini(buildGeminiAskRequest(v.messages, v.context, effort), model, ac.signal);
    else {
      out = await callClaude(buildClaudeAskRequest(v.messages, v.context, model, effort), ac.signal);
      // An account or gateway that does not accept the fallback option gets the same question without it.
      if (out.error && out.upstreamStatus === 400 && /fallback/i.test(out.log || '')) out = await callClaude(buildClaudeAskRequest(v.messages, v.context, model, effort, false), ac.signal);
    }
    if (out.error) {
      console.warn(`[ask] ${model} failed: ${out.log}`);
      return sendJson(res, 502, { error: out.error, upstreamStatus: out.upstreamStatus });
    }
    const refused = out.stopReason === 'refusal' && !out.text.trim();
    const text = refused ? 'I can\'t answer that one. Try asking it another way, or about a specific part of your training.' : out.text;
    console.log(`[ask] ${out.model} (${MODELS[model].adaptive ? effort : 'budget'}) ${((Date.now() - t0) / 1000).toFixed(1)} s, ${out.usage.input_tokens} in (${out.usage.cache_read_input_tokens || 0} cached) / ${out.usage.output_tokens} out tokens, stop=${out.stopReason}`);
    return sendJson(res, 200, { text, refused, provider, model: out.model, effort: MODELS[model].adaptive ? effort : null, stopReason: out.stopReason, usage: out.usage });
  } catch (err) {
    const aborted = err.name === 'AbortError';
    console.warn(`[ask] ${model} ${aborted ? 'timed out / cancelled' : 'request failed: ' + err.message}`);
    return sendJson(res, aborted ? 504 : 502, { error: aborted ? `${p.label} did not answer in time.` : `Could not reach the ${p.label} API (${err.message}).` });
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
    canCheck: !!(t && /activity:read/.test(t.scope || '')),
    canSync: !!(t && /activity:read_all/.test(t.scope || ''))
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

// --------------------------------------------------------- Strava sync (READ ONLY) --
// "Sync from Strava" only ever reads: GET /api/v3/athlete/activities, GET /api/v3/activities/{id}
// and GET /api/v3/activities/{id}/streams.
// Nothing is uploaded, edited or deleted on Strava by this path.
const SYNC_MAX_PAGES = 10;        // 10 x 200 activities
const SYNC_MAX_DETAIL_IDS = 10;   // activities/{id} per request; the app batches and shows progress
const SYNC_STREAM_KEYS = 'time,watts,heartrate,cadence,velocity_smooth,distance';
const SYNC_FIELDS = ['name', 'type', 'sport_type', 'start_date', 'start_date_local', 'timezone', 'moving_time', 'elapsed_time', 'distance',
  'calories', 'average_watts', 'weighted_average_watts', 'max_watts', 'kilojoules', 'device_watts', 'average_heartrate', 'max_heartrate',
  'average_cadence', 'suffer_score', 'trainer', 'description'];

/** Strava's read rate-limit usage from the response headers: { used15, limit15, usedDay, limitDay }. */
function stravaRate(r) {
  const pick = (a, b) => (r.headers.get(a) || r.headers.get(b) || '').split(',').map(x => parseInt(x, 10));
  const used = pick('x-readratelimit-usage', 'x-ratelimit-usage');
  const lim = pick('x-readratelimit-limit', 'x-ratelimit-limit');
  return { used15: used[0] || 0, usedDay: used[1] || 0, limit15: lim[0] || 100, limitDay: lim[1] || 1000 };
}
function toIsoUtc(v) {
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString().replace('.000Z', 'Z') : '';
}
/** The compact activity the app works with. `detailed` = fetched from activities/{id} (has description/calories). */
function slimActivity(a, detailed) {
  const o = { id: String(a.id), detailed: !!detailed };
  for (const k of SYNC_FIELDS) if (a[k] !== undefined && a[k] !== null) o[k] = a[k];
  o.start_date = toIsoUtc(a.start_date);
  // start_date_local is the local wall clock labelled with a Z; keep it as that label.
  if (a.start_date_local) o.start_date_local = toIsoUtc(a.start_date_local);
  if (!detailed) { delete o.description; delete o.calories; }
  o.trainer = !!a.trainer;
  return o;
}
/** One GET to the Strava API. The sync path has no other way to reach Strava. */
async function stravaGet(pathAndQuery, token) {
  const r = await fetch(`${STRAVA_BASE}/api/v3/${pathAndQuery}`, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
  const data = await r.json().catch(() => null);
  return { status: r.status, ok: r.ok, data, rate: stravaRate(r) };
}

async function handleStravaSync(req, res, query) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
  if (!isLocalRequest(req)) return sendJson(res, 403, { error: 'Forbidden' });
  const t = readStravaTokens();
  if (!t || !t.refresh_token) return sendJson(res, 401, { error: 'Strava is not connected. Connect Strava first.', needsConnect: true });
  if (!/activity:read_all/.test(t.scope || '')) {
    return sendJson(res, 403, { error: 'Strava sync needs permission to read all your activities. Reconnect Strava (Disconnect, then Connect Strava) and allow access to your activities.', needsReconnect: true });
  }
  const token = await stravaAccessToken();
  if (!token) return sendJson(res, 401, { error: 'Strava sign-in expired or was revoked. Reconnect Strava.', needsConnect: true });

  // Second-by-second data of ONE activity, passed through as Strava sends it (the app converts it).
  const sid = query.get('streams');
  if (sid !== null) {
    if (!/^\d+$/.test(sid)) return sendJson(res, 400, { error: 'streams must be one activity id' });
    let r, text;
    try {
      r = await fetch(`${STRAVA_BASE}/api/v3/activities/${sid}/streams?keys=${SYNC_STREAM_KEYS}&key_by_type=true`, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
      text = await r.text();
    } catch (e) { return sendJson(res, 502, { error: `Could not reach Strava (${e.message}).` }); }
    const rate = stravaRate(r);
    if (r.status === 401) return sendJson(res, 401, { error: 'Strava rejected the sign-in. Reconnect Strava.', needsConnect: true });
    if (r.status === 429) return sendJson(res, 200, { id: sid, rateLimited: true, rate });
    if (r.status === 404) return sendJson(res, 200, { id: sid, missing: true, rate });
    if (!r.ok) return sendJson(res, 502, { error: `Strava streams for ${sid} failed (HTTP ${r.status}).` });
    const body = text.trim();
    const streams = body.startsWith('{') ? body : '{}';
    return send(res, 200, `{"id":"${sid}","streams":${streams},"rate":${JSON.stringify(rate)}}`, 'application/json; charset=utf-8');
  }

  const ids = query.get('ids');
  if (ids !== null) {
    if (!/^\d+(,\d+)*$/.test(ids)) return sendJson(res, 400, { error: 'ids must be a comma-separated list of activity ids' });
    const list = [...new Set(ids.split(','))];
    if (list.length > SYNC_MAX_DETAIL_IDS) return sendJson(res, 400, { error: `At most ${SYNC_MAX_DETAIL_IDS} ids per request` });
    const out = [], missing = [];
    let rate = null;
    for (const id of list) {
      let r;
      try { r = await stravaGet(`activities/${id}`, token); } catch (e) { return sendJson(res, 502, { error: `Could not reach Strava (${e.message}).`, activities: out, missing }); }
      rate = r.rate;
      if (r.status === 401) return sendJson(res, 401, { error: 'Strava rejected the sign-in. Reconnect Strava.', needsConnect: true });
      if (r.status === 429) return sendJson(res, 200, { activities: out, missing, rateLimited: true, rate });
      if (r.status === 404) { missing.push(id); continue; }
      if (!r.ok || !r.data) return sendJson(res, 502, { error: `Strava activity ${id} failed (HTTP ${r.status}).`, activities: out, missing });
      out.push(slimActivity(r.data, true));
    }
    return sendJson(res, 200, { activities: out, missing, rateLimited: false, rate });
  }

  const afterMs = Date.parse(query.get('after') || ''), beforeMs = Date.parse(query.get('before') || '');
  if (!Number.isFinite(afterMs) || !Number.isFinite(beforeMs) || beforeMs <= afterMs) {
    return sendJson(res, 400, { error: 'after and before must be ISO dates, with after before before' });
  }
  const after = Math.floor(afterMs / 1000), before = Math.ceil(beforeMs / 1000);
  const out = [];
  let rate = null, pages = 0;
  for (let page = 1; page <= SYNC_MAX_PAGES; page++) {
    let r;
    try { r = await stravaGet(`athlete/activities?after=${after}&before=${before}&per_page=200&page=${page}`, token); }
    catch (e) { return sendJson(res, 502, { error: `Could not reach Strava (${e.message}).` }); }
    rate = r.rate; pages = page;
    if (r.status === 401) return sendJson(res, 401, { error: 'Strava needs permission to read your activities. Reconnect Strava.', needsConnect: true });
    if (r.status === 429) return sendJson(res, 429, { error: 'Strava rate limit reached - try again in 15 minutes.', rate });
    if (!r.ok || !Array.isArray(r.data)) return sendJson(res, 502, { error: `Strava activity list failed (HTTP ${r.status}).` });
    for (const a of r.data) if (a && a.id != null) out.push(slimActivity(a, false));
    if (r.data.length < 200) break;
  }
  console.log(`[strava] sync list ${new Date(afterMs).toISOString().slice(0, 10)}..${new Date(beforeMs).toISOString().slice(0, 10)}: ${out.length} activities (${pages} page${pages === 1 ? '' : 's'})`);
  return sendJson(res, 200, { activities: out, after: new Date(afterMs).toISOString(), before: new Date(beforeMs).toISOString(), pages, rate });
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
  if (urlPath === '/api/strava/sync') return handleStravaSync(req, res, query);
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
// The PC app publishes a small live snapshot right after every ride tick; the phone page
// (live.html) reads it and queues simple commands. Nothing is stored on disk.
// Low latency without polling: the phone asks GET /api/live?after=<seq> and the request is
// held until the next snapshot arrives (long-poll, at most LIVE_HOLD_MS), and the PC app holds
// GET /api/live/cmds open so a tapped command reaches it at once instead of on its next publish.
// Every command has an id and stays queued until the PC confirms it (cmdAck in its next
// publish), so a command is never lost on a dropped connection and never applied twice.
const LIVE_CMDS = new Set(['toggle', 'skip', 'bias-up', 'bias-down', 'bias-reset', 'watts-up', 'watts-down', 'stand', 'spin-more', 'spin-finish',
  'connect-trainer', 'connect-pedals', 'connect-hr', 'connect-fan', 'disconnect-trainer', 'disconnect-pedals', 'disconnect-hr', 'disconnect-fan', 'connect-all', 'connect-stop', 'pair-cancel', 'calibrate-pedals',
  'fan-0', 'fan-25', 'fan-50', 'fan-75', 'fan-100', 'fan-mode-manual', 'fan-mode-hr', 'fan-mode-power']);
const LIVE_HOLD_MS = 2500;
const LIVE_CMD_HOLD_MS = 20000;
const LIVE_MAX_WAITERS = 8;
const LIVE_CMD_TTL_MS = 10000;
const live = { snapshot: null, at: 0, seq: 0, cmds: [], cmdId: Date.now(), waiters: [], cmdWaiter: null, fit: null }; // ids keep rising across restarts
const LIVE_FIT_MAX_BYTES = 16 * 1024 * 1024;

function liveState() {
  const fit = live.fit ? { id: live.fit.id, filename: live.fit.filename, url: '/api/live/fit?id=' + encodeURIComponent(live.fit.id) } : null;
  return { snapshot: live.snapshot, ageMs: live.at ? Date.now() - live.at : null, pending: live.cmds.length, seq: live.seq, fit };
}
function releaseLiveWaiters() {
  const ws = live.waiters; live.waiters = [];
  const state = liveState();
  for (const w of ws) { clearTimeout(w.timer); if (!w.res.writableEnded) sendJson(w.res, 200, state); }
}
function pendingLiveCmds(after) {
  const now = Date.now();
  live.cmds = live.cmds.filter(c => now - c.at < LIVE_CMD_TTL_MS);
  return live.cmds.filter(c => c.id > after);
}
function deliverLiveCmds() {
  const w = live.cmdWaiter;
  if (!w) return;
  const cmds = pendingLiveCmds(w.after);
  if (!cmds.length) return;
  live.cmdWaiter = null; clearTimeout(w.timer);
  if (!w.res.writableEnded && !w.res.destroyed) sendJson(w.res, 200, { cmds }); // unconfirmed ones also ride on the next publish reply
}

// ------------------------------------------------ automatic backups (this PC only) --
// The app posts its history backup (the same JSON as "Backup JSON", gzipped in the browser) after
// changes and once a day. Kept in data/backups (the newest BACKUP_KEEP), never served to anyone.
const BACKUP_DIR = path.join(ROOT, 'data', 'backups');
const BACKUP_KEEP = 14;
const BACKUP_MAX_BYTES = 200 * 1024 * 1024;
const BACKUP_NAME_RE = /^apex_velo_backup_\d{4}-\d{2}-\d{2}_\d{6}\.json\.gz$/;
const BACKUP_PREFIX = '{"app":"APEX VELO LAB"';

/** Only the app opened on this PC (not a phone on the Wi-Fi) may read or write backups. */
function isPcRequest(req) {
  const host = req.headers.host || '';
  const origin = req.headers.origin;
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host) && (!origin || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin));
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size <= limit) chunks.push(c); });
    req.on('end', () => size > limit ? reject(Object.assign(new Error('Backup too large'), { status: 413 })) : resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function listBackups() {
  try { return fs.readdirSync(BACKUP_DIR).filter(n => BACKUP_NAME_RE.test(n)).sort(); } catch (e) { return []; }
}

function backupStatus() {
  const files = listBackups();
  const last = files[files.length - 1];
  let latest = null;
  if (last) { const st = fs.statSync(path.join(BACKUP_DIR, last)); latest = { name: last, bytes: st.size, at: st.mtime.toISOString() }; }
  return { dir: BACKUP_DIR, count: files.length, keep: BACKUP_KEEP, latest };
}

async function handleBackup(req, res) {
  if (!isPcRequest(req)) return sendJson(res, 403, { error: 'Backups can only be made from the app on this PC.' });
  if (req.method === 'GET') return sendJson(res, 200, backupStatus());
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  if (!/^application\/gzip\b/i.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'Content-Type must be application/gzip.' });
  let buf;
  try { buf = await readRaw(req, BACKUP_MAX_BYTES); } catch (e) { return sendJson(res, e.status || 400, { error: e.message }); }
  // Only an Apex Velo Lab backup is accepted (gzip, and it starts like one).
  let head = '';
  try { head = zlib.gunzipSync(buf).subarray(0, BACKUP_PREFIX.length).toString('utf8'); } catch (e) { /* not gzip */ }
  if (head !== BACKUP_PREFIX) return sendJson(res, 400, { error: 'Not an Apex Velo Lab backup.' });
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const name = `apex_velo_backup_${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.json.gz`;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const tmp = path.join(BACKUP_DIR, `.${name}.tmp`);
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, path.join(BACKUP_DIR, name)); // a half-written file never looks like a backup
    const files = listBackups();
    files.slice(0, Math.max(0, files.length - BACKUP_KEEP)).forEach(f => { try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (e) { /* ignore */ } });
  } catch (e) {
    return sendJson(res, 500, { error: `Could not write the backup (${e.message}).` });
  }
  return sendJson(res, 200, { ok: true, name, bytes: buf.length, ...backupStatus() });
}

// ------------------------------------------------ Apple Health (Health Auto Export) --
// The Health Auto Export iPhone app POSTs its JSON to /api/health with "Authorization: Bearer <token>".
// Payloads are stored as-is in data/health/inbox; the app on this PC reads them (parsing lives in
// js/velo-health.js), then acknowledges them so they are deleted. data/health is never served.
const HEALTH_DIR = path.join(ROOT, 'data', 'health');
const HEALTH_INBOX = path.join(HEALTH_DIR, 'inbox');
const HEALTH_TOKEN_FILE = path.join(HEALTH_DIR, 'token.txt');
const HEALTH_META_FILE = path.join(HEALTH_DIR, 'status.json');
const HEALTH_MAX_BYTES = 50 * 1024 * 1024;
const HEALTH_INBOX_KEEP = 500;
const HEALTH_NAME_RE = /^hae_\d{8}_\d{6}_[0-9a-f]{6}\.json$/;

function healthToken(renew = false) {
  if (!renew) { try { const t = fs.readFileSync(HEALTH_TOKEN_FILE, 'utf8').trim(); if (/^[0-9a-f]{32,}$/.test(t)) return t; } catch (e) { /* none yet */ } }
  const t = require('crypto').randomBytes(24).toString('hex');
  fs.mkdirSync(HEALTH_DIR, { recursive: true });
  fs.writeFileSync(HEALTH_TOKEN_FILE, t);
  return t;
}

function healthInboxFiles() {
  try { return fs.readdirSync(HEALTH_INBOX).filter(n => HEALTH_NAME_RE.test(n)).sort(); } catch (e) { return []; }
}

function lanAddresses() {
  const out = [];
  try {
    const nets = require('os').networkInterfaces();
    for (const name of Object.keys(nets)) for (const n of nets[name] || []) if (n.family === 'IPv4' && !n.internal && LAN_HOST_RE.test(n.address)) out.push(n.address);
  } catch (e) { /* best effort */ }
  return out;
}

function healthStatus() {
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(HEALTH_META_FILE, 'utf8')) || {}; } catch (e) { /* none yet */ }
  const ips = lanAddresses();
  return { token: healthToken(), port: PORT, urls: ips.map(ip => `http://${ip}:${PORT}/api/health`), phoneUrls: ips.map(ip => `http://${ip}:${PORT}/live.html`), inbox: healthInboxFiles().length, lastReceived: meta.lastReceived || null, lastBytes: meta.lastBytes || 0, received: meta.received || 0 };
}

function tokenMatches(given) {
  const want = Buffer.from(healthToken());
  const got = Buffer.from(String(given || ''));
  return got.length === want.length && require('crypto').timingSafeEqual(got, want);
}

async function handleHealth(req, res, urlPath, query) {
  if (urlPath === '/api/health' && req.method === 'POST') {
    // From the phone: the bearer token is the gate (the address check already limits it to this PC / home Wi-Fi).
    const auth = String(req.headers.authorization || '');
    const given = auth.replace(/^Bearer\s+/i, '').trim() || query.get('token');
    if (!tokenMatches(given)) return sendJson(res, 401, { error: 'Missing or wrong token - copy it from Settings > Apple Health in the app.' });
    let buf;
    try { buf = await readRaw(req, HEALTH_MAX_BYTES); } catch (e) { return sendJson(res, e.status || 400, { error: e.status === 413 ? 'Over 50 MB - export a shorter date range.' : e.message }); }
    let body;
    try { body = JSON.parse(buf.toString('utf8')); } catch (e) { return sendJson(res, 400, { error: 'Invalid JSON.' }); }
    if (!body || typeof body !== 'object' || !(body.data || body.metrics)) return sendJson(res, 400, { error: 'Not a Health Auto Export payload (no "data").' });
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const name = `hae_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}_${require('crypto').randomBytes(3).toString('hex')}.json`;
    try {
      fs.mkdirSync(HEALTH_INBOX, { recursive: true });
      const tmp = path.join(HEALTH_INBOX, `.${name}.tmp`);
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, path.join(HEALTH_INBOX, name));
      const files = healthInboxFiles();
      files.slice(0, Math.max(0, files.length - HEALTH_INBOX_KEEP)).forEach(f => { try { fs.unlinkSync(path.join(HEALTH_INBOX, f)); } catch (e) { /* ignore */ } });
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(HEALTH_META_FILE, 'utf8')) || {}; } catch (e) { /* first */ }
      fs.writeFileSync(HEALTH_META_FILE, JSON.stringify({ lastReceived: d.toISOString(), lastBytes: buf.length, received: (meta.received || 0) + 1 }));
    } catch (e) {
      return sendJson(res, 500, { error: `Could not save the data (${e.message}).` });
    }
    return sendJson(res, 200, { ok: true, stored: name });
  }
  // Everything else - the token, the stored data - only for the app on this PC.
  if (!isPcRequest(req)) return sendJson(res, 403, { error: 'Only the app on this PC can read Apple Health data.' });
  if (urlPath === '/api/health/status' && req.method === 'GET') return sendJson(res, 200, healthStatus());
  if (urlPath === '/api/health/token' && req.method === 'POST') { healthToken(true); return sendJson(res, 200, healthStatus()); }
  if (urlPath === '/api/health/inbox' && req.method === 'GET') {
    const names = healthInboxFiles().slice(0, 20);
    const files = [];
    for (const n of names) {
      try { files.push({ name: n, body: JSON.parse(fs.readFileSync(path.join(HEALTH_INBOX, n), 'utf8')) }); } catch (e) { files.push({ name: n, body: null }); }
    }
    return sendJson(res, 200, { files, remaining: Math.max(0, healthInboxFiles().length - names.length) });
  }
  if (urlPath === '/api/health/ack' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req, 64 * 1024)); } catch (e) { return sendJson(res, 400, { error: 'Invalid JSON.' }); }
    const names = Array.isArray(body && body.names) ? body.names.filter(n => HEALTH_NAME_RE.test(String(n))) : [];
    let removed = 0;
    for (const n of names) { try { fs.unlinkSync(path.join(HEALTH_INBOX, n)); removed++; } catch (e) { /* already gone */ } }
    return sendJson(res, 200, { ok: true, removed });
  }
  return sendJson(res, req.method === 'GET' || req.method === 'POST' ? 404 : 405, { error: 'Not found' });
}

async function handleLive(req, res, urlPath) {
  if (!isLocalRequest(req)) return sendJson(res, 403, { error: 'Forbidden' });
  if (urlPath === '/api/live/fit') {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const id = query.get('id');
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!live.fit || live.fit.id !== id) return sendJson(res, 404, { error: 'This FIT file is no longer available. Keep the PC app open until downloaded.' });
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream', 'Content-Length': live.fit.bytes.length,
        'Content-Disposition': `attachment; filename="${live.fit.filename}"`,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      });
      return res.end(req.method === 'HEAD' ? undefined : live.fit.bytes);
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    if (!isPcRequest(req)) return sendJson(res, 403, { error: 'Only the app on this PC can publish FIT files.' });
    const filename = query.get('filename');
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id || '') || !/^[a-zA-Z0-9_-]{1,120}\.fit$/.test(filename || '')) return sendJson(res, 400, { error: 'Invalid FIT file name or ride id.' });
    if (Number(req.headers['content-length']) > LIVE_FIT_MAX_BYTES) return sendJson(res, 413, { error: 'FIT file too large' });
    let bytes;
    try { bytes = await readRaw(req, LIVE_FIT_MAX_BYTES); }
    catch (e) { return sendJson(res, e.status || 400, { error: e.status === 413 ? 'FIT file too large' : 'Could not read the FIT file.' }); }
    if (bytes.length < 14 || ![12, 14].includes(bytes[0]) || bytes.toString('ascii', 8, 12) !== '.FIT' || bytes[0] + bytes.readUInt32LE(4) + 2 !== bytes.length) return sendJson(res, 400, { error: 'Invalid FIT activity file.' });
    live.fit = { id, filename, bytes };
    live.seq++;
    sendJson(res, 200, { ok: true });
    releaseLiveWaiters();
    return;
  }
  if (urlPath === '/api/live') {
    if (req.method === 'GET') {
      const after = new URL(req.url, 'http://localhost').searchParams.get('after');
      // Nothing newer than what the phone already has: hold the request until the next snapshot.
      if (after !== null && Number(after) === live.seq) {
        if (live.waiters.length >= LIVE_MAX_WAITERS) { const old = live.waiters.shift(); clearTimeout(old.timer); if (!old.res.writableEnded) sendJson(old.res, 200, liveState()); }
        const w = { res, timer: null };
        w.timer = setTimeout(() => { live.waiters = live.waiters.filter(x => x !== w); if (!res.writableEnded) sendJson(res, 200, liveState()); }, LIVE_HOLD_MS);
        live.waiters.push(w);
        req.on('close', () => { clearTimeout(w.timer); live.waiters = live.waiters.filter(x => x !== w); });
        return;
      }
      return sendJson(res, 200, liveState());
    }
    if (req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req, 64 * 1024)); } catch (e) { return sendJson(res, e.status || 400, { error: e.status ? e.message : 'Invalid JSON.' }); }
      live.snapshot = body && typeof body === 'object' ? body : null;
      live.at = Date.now();
      live.seq++;
      const ack = body && Number.isFinite(body.cmdAck) ? body.cmdAck : null;
      if (ack !== null) live.cmds = live.cmds.filter(c => c.id > ack);
      const cmds = ack !== null ? pendingLiveCmds(ack) : live.cmds.splice(0); // no ack: an older app, hand over once
      sendJson(res, 200, { cmds, fitId: live.fit ? live.fit.id : null });
      releaseLiveWaiters();
      return;
    }
    return sendJson(res, 405, { error: 'Method not allowed' });
  }
  if (urlPath === '/api/live/cmds') {
    // Only the app on this PC collects commands.
    if (!isPcRequest(req)) return sendJson(res, 403, { error: 'Forbidden' });
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
    const after = Number(new URL(req.url, 'http://localhost').searchParams.get('after')) || 0;
    const ready = pendingLiveCmds(after);
    if (ready.length) return sendJson(res, 200, { cmds: ready });
    if (live.cmdWaiter) { const old = live.cmdWaiter; clearTimeout(old.timer); if (!old.res.writableEnded) sendJson(old.res, 200, { cmds: [] }); }
    const w = { res, after, timer: null };
    w.timer = setTimeout(() => { if (live.cmdWaiter === w) live.cmdWaiter = null; if (!res.writableEnded) sendJson(res, 200, { cmds: [] }); }, LIVE_CMD_HOLD_MS);
    live.cmdWaiter = w;
    req.on('close', () => { clearTimeout(w.timer); if (live.cmdWaiter === w) live.cmdWaiter = null; });
    return;
  }
  if (urlPath === '/api/live/cmd') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    let body;
    try { body = JSON.parse(await readBody(req, 1024)); } catch (e) { return sendJson(res, 400, { error: 'Invalid JSON.' }); }
    const cmd = body && body.cmd;
    if (!LIVE_CMDS.has(cmd)) return sendJson(res, 400, { error: 'Unknown command' });
    if (!live.at || Date.now() - live.at > 10000) return sendJson(res, 409, { error: 'The app on the PC is not open.' });
    let id = null;
    if (live.cmds.length < 20) { id = ++live.cmdId; live.cmds.push({ id, cmd, at: Date.now() }); }
    deliverLiveCmds();
    return sendJson(res, 200, { ok: true, id }); // the phone shows the result at once and knows when the PC has applied it (cmdAck)
  }
  return sendJson(res, 404, { error: 'Not found' });
}

// ------------------------------------------------------------------ server --
function createServer() {
  return http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    if (!isAllowedClient(req)) return send(res, 403, 'Forbidden');
    if (urlPath === '/api/backup') {
      return handleBackup(req, res).catch((e) => { if (!res.headersSent) sendJson(res, 500, { error: e.message }); });
    }
    if (urlPath === '/api/health' || urlPath.startsWith('/api/health/')) {
      const query = new URL(req.url, 'http://localhost').searchParams;
      return handleHealth(req, res, urlPath, query).catch((e) => { if (!res.headersSent) sendJson(res, 500, { error: e.message }); });
    }
    if (urlPath === '/api/live' || urlPath === '/api/live/cmd' || urlPath === '/api/live/cmds' || urlPath === '/api/live/fit') {
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
    if (urlPath === '/api/ask') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
      return handleAsk(req, res).catch((e) => { if (!res.headersSent) sendJson(res, 500, { error: e.message }); });
    }
    if (urlPath.startsWith('/api/strava/')) {
      const query = new URL(req.url, 'http://localhost').searchParams;
      return handleStrava(req, res, urlPath, query).catch((e) => { if (!res.headersSent) sendJson(res, 500, { error: e.message }); });
    }
    if (urlPath.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    // Pages and data files (your ride history) too: a website cannot read them via DNS rebinding.
    if (!isLocalRequest(req)) return send(res, 403, 'Forbidden');
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
    const keySrc = (fromEnv, name) => (fromEnv ? `the ${name} environment variable` : '.env');
    console.log(API_KEY ? `AI Coach - Claude: ready, key from ${keySrc(KEY_FROM_ENVIRONMENT, 'ANTHROPIC_API_KEY')}` : 'AI Coach - Claude: no ANTHROPIC_API_KEY in .env');
    console.log(GEMINI_API_KEY ? `AI Coach - Gemini: ready, key from ${keySrc(GEMINI_KEY_FROM_ENVIRONMENT, 'GEMINI_API_KEY')}` : 'AI Coach - Gemini: no GEMINI_API_KEY in .env');
    console.log(KEYS[DEFAULT_PROVIDER]
      ? `AI Coach default: ${MODELS[DEFAULT_MODEL].label}, ${DEFAULT_EFFORT} effort (switch provider in the app's AI engine card)`
      : 'AI Coach: no API key for the default provider - the offline engine is used until you add one.');
    console.log('Press Ctrl+C to stop.');
    if (process.argv.includes('--open')) {
      const { spawn } = require('child_process');
      const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch (e) { /* open it manually */ }
    }
  });
}

module.exports = { createServer, buildClaudeRequest, buildGeminiRequest, buildClaudeAskRequest, buildGeminiAskRequest, validateAsk, ASK_SYSTEM_PROMPT, loadDotEnv, slimActivity, MODELS, PROVIDERS };
