#!/usr/bin/env node
/**
 * APEX VELO // LAB - local server.
 *
 * Serves the app on http://localhost:8080 and forwards AI Coach requests to the
 * Claude, Gemini or OpenAI (ChatGPT) API. The API keys are read here, on your computer, from the
 * ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY environment variables or the .env file next to this
 * script. They are never sent to the browser, and the .env file is never served.
 *
 * Usage:  node server.js [--open]      (Node 24 or newer, no npm install needed)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
let syncDepsCache = null;
function syncDeps() {
  if (!syncDepsCache) {
    syncDepsCache = {
      VeloSync: require('./js/velo-sync.js'),
      VeloDedupe: require('./js/velo-dedupe.js'),
      VeloHealth: require('./js/velo-health.js')
    };
  }
  return syncDepsCache;
}

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
const OPENAI_KEY_FROM_ENVIRONMENT = !!(process.env.OPENAI_API_KEY || '').trim();
const HEVY_KEY_FROM_ENVIRONMENT = !!(process.env.HEVY_API_KEY || '').trim();
loadDotEnv(path.join(ROOT, '.env'));

/**
 * Models the coach may use. Haiku 4.5 has no adaptive thinking or effort, so it uses a fixed thinking budget.
 * For Gemini the effort setting maps to thinkingLevel (low / medium / high).
 */
const MODELS = {
  'claude-opus-5-5':           { label: 'Claude Opus 5.5', provider: 'claude', adaptive: true },
  'claude-sonnet-5-5':         { label: 'Claude Sonnet 5.5', provider: 'claude', adaptive: true },
  'claude-haiku-4-5-20251001': { label: 'Claude Haiku 4.5', provider: 'claude', adaptive: false },
  'gemini-3.8-flash':          { label: 'Gemini 3.8 Flash', provider: 'gemini', adaptive: true },
  'gemini-3.1-pro-preview':    { label: 'Gemini 3.1 Pro (preview)', provider: 'gemini', adaptive: true },
  'gemini-3.1-flash-lite':     { label: 'Gemini 3.1 Flash-Lite', provider: 'gemini', adaptive: true },
  'gpt-6.1-sol':               { label: 'GPT-6.1 Sol', provider: 'openai', adaptive: true }
};
// The list above is only the starting point: at startup (and on "Re-check server") the server asks each
// provider whose key is set for its current model list, so new models appear without editing this file.
const PROVIDERS = {
  claude: { label: 'Claude', keyName: 'ANTHROPIC_API_KEY', fallbackModel: 'claude-opus-5-5' },
  gemini: { label: 'Gemini', keyName: 'GEMINI_API_KEY', fallbackModel: 'gemini-3.8-flash' },
  openai: { label: 'ChatGPT', keyName: 'OPENAI_API_KEY', fallbackModel: 'gpt-6.1-sol' }
};
const EFFORTS = ['low', 'medium', 'high'];

const API_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const KEYS = { claude: API_KEY, gemini: GEMINI_API_KEY, openai: OPENAI_API_KEY };
const pickModel = (raw, provider) => { const id = raw === 'claude-sonnet-5' ? 'claude-sonnet-5-5' : raw; return (MODELS[id] && MODELS[id].provider === provider ? id : PROVIDERS[provider].fallbackModel); };
const DEFAULT_MODELS = {
  claude: pickModel(process.env.APEX_COACH_MODEL, 'claude'),
  gemini: pickModel(process.env.APEX_GEMINI_MODEL, 'gemini'),
  openai: pickModel(process.env.APEX_OPENAI_MODEL, 'openai')
};
// Default provider: APEX_COACH_PROVIDER if set, otherwise whichever has a key (Claude first).
const DEFAULT_PROVIDER = PROVIDERS[process.env.APEX_COACH_PROVIDER] ? process.env.APEX_COACH_PROVIDER
  : (API_KEY ? 'claude' : GEMINI_API_KEY ? 'gemini' : OPENAI_API_KEY ? 'openai' : 'claude');
const DEFAULT_MODEL = DEFAULT_MODELS[DEFAULT_PROVIDER];
const DEFAULT_EFFORT = EFFORTS.includes(process.env.APEX_COACH_EFFORT) ? process.env.APEX_COACH_EFFORT : 'low';
const PORT = parseInt(process.env.APEX_PORT || '8080', 10);
const API_BASE = (process.env.APEX_ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
const GEMINI_BASE = (process.env.APEX_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
const OPENAI_BASE = (process.env.APEX_OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/+$/, '');
const HEVY_API_KEY = (process.env.HEVY_API_KEY || '').trim();
const HEVY_BASE = (process.env.APEX_HEVY_BASE_URL || 'https://api.hevyapp.com').replace(/\/+$/, '');
const HEVY_TIMEOUT_MS = 20000;
const HEVY_MAX_PAGES = 50;
const HEVY_PAGE_SIZE = 10;
const UPSTREAM_TIMEOUT_MS = 180000;
const MAX_BODY_BYTES = 256 * 1024;

const SYSTEM_PROMPT = 'You are the Apex Velo Lab sport scientist: an elite cycling coach and exercise physiologist with deep knowledge of training methodology and periodisation. ' +
  'You build structured indoor ERG sessions and training blocks from the rider\'s real training data, and you review the rides they have done. ' +
  'Reason like a coach who knows this rider: work out what limits them for the goal, choose the session or block that addresses it, set an exact dose (intensity, interval and rest length, time in zone, frequency, progression), ' +
  'then check it against recent hard days, fatigue, recovery readings and the time available. ' +
  'A SPORT-SCIENCE EVIDENCE BRIEF in the request is your reference, not a script: give meta-analyses and randomised trials in cyclists more weight than single studies or habit, and use established physiology and coaching practice where it is silent. ' +
  'People respond differently to the same training, so the rider\'s own data outranks population averages when they disagree. ' +
  'The rider is an adult who makes their own training decisions. When they ask for something specific, build that; if their data argues against it, say so once, plainly, and name what you would do instead, ' +
  'but do not quietly swap in a different session or water the request down. Spacing hard days about 48 hours apart, easing off when fatigue or recovery is poor and raising load gradually are strong defaults, not absolute rules. ' +
  'Never invent data, studies or citations: cite only references listed in the request. ' +
  'Use the requested response format (JSON when requested, otherwise plain text or markdown). Keep numeric workout fields and schema keys exact. ' +
  'Write clearly and directly, like a good coach talking to a committed amateur: lead with what to do and why, back it with the numbers, rides and dates from their data that matter, and leave out filler and advice that would fit anyone. ' +
  'Use the app\'s words fitness (CTL), fatigue (ATL) and form (TSB), and give a few plain words the first time you use a less common term. ' +
  'Treat calculated scores as estimates, not proof of illness, overtraining or full recovery.';

// Ask: free conversation about the rider's own training - analysis, opinions and what to do next (the coach above builds the trainer workouts).
// Kept identical in start_server.ps1 (ASCII only, so Windows PowerShell 5.1 reads it unchanged).
const ASK_SYSTEM_PROMPT = 'You are the rider\'s personal cycling coach and data analyst inside the Apex Velo Lab app. ' +
  'The TRAINING DATA block holds their rides, fitness and recovery for the period they picked; what they tell you in this conversation counts as well. ' +
  'Anything you state about this rider\'s own training must come from there: never invent rides, numbers or dates, and when the data cannot answer something, say what is missing and how the rider could get it ' +
  '(for example: ride with the heart-rate strap, or pick a longer period). ' +
  'Beyond that, use everything you know about training, physiology, nutrition, pacing, equipment and racing: explain, compare, give your own view, and make it clear when a point is general knowledge rather than something seen in their data. ' +
  'Do real analysis: look for patterns, trends, outliers and links across rides, weeks and recovery, do the arithmetic, and commit to a conclusion with the numbers and dates behind it. Say how sure you are when the data is thin. ' +
  'Match the answer to the question: a quick question gets a couple of sentences, a request for analysis gets a thorough one. Lead with the answer, then the reasoning. ' +
  'When the rider asks what to do next, tell them: describe sessions with real targets (duration, intervals, percent of FTP or watts, cadence), sketch a week, or adjust their plan. ' +
  'You may add that ticking Create a workout in this chat (or pressing Make it a workout under your answer) turns a session into a workout for the trainer, but answer the question yourself first. ' +
  'Write plain, direct English. The first time you use an acronym, add its plain meaning in brackets, ' +
  'for example TSS (workout load score), CTL (fitness), ATL (fatigue), TSB (form), NP (surge-weighted average power), ' +
  'CP (long-effort limit) or W\' (burst energy reserve). ' +
  'Treat calculated scores as estimates, not proof of illness, overtraining or full recovery. You can explain what heart rate, HRV, sleep and symptoms usually mean for training, ' +
  'but you are not a doctor: when something sounds like a medical problem, say so and suggest seeing one. ' +
  'Format with markdown: bold the key numbers, use lists, and add a small table when it makes a comparison easier to read (five columns at most, so it fits a phone).';
const ASK_MAX_MESSAGES = 40;
const ASK_MAX_MESSAGE_CHARS = 20000;
const ASK_MAX_CONTEXT_CHARS = 150000;
const ASK_MAX_TOOL_ROUNDS = 8;
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
const BLOCKED = /(^|[\\/])\.|^server\.js$|^scripts[\\/]|\.(ps1|cmd|bat|sh|sqlite|sqlite-wal|sqlite-shm)$|^data[\\/](?!sample_sweetspot_ride\.tcx$|README\.md$)/i;

function serveStatic(req, res, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch (e) { return send(res, 400, 'Bad request'); }
  if (rel.includes('\0')) return send(res, 400, 'Bad request');
  // Windows would otherwise resolve 8.3 short names (/ENV~1 = .env) and alternate data streams (file::$DATA)
  // to files the name check below never sees. No app file uses either character.
  if (/[~:]/.test(rel)) return send(res, 404, 'Not found');
  rel = rel.replace(/^\/+/, '') || 'index.html';
  const file = path.resolve(ROOT, rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return send(res, 403, 'Forbidden');
  const privateDirs = [localStore?.dir, process.env.APEX_DATA_DIR, process.env.APEX_BACKUP_MIRROR_DIR].filter(Boolean).map(d => path.resolve(d));
  if (privateDirs.some(d => file === d || file.startsWith(d + path.sep))) return send(res, 404, 'Not found');
  if (BLOCKED.test(path.relative(ROOT, file))) return send(res, 404, 'Not found');
  fs.stat(file, (err, st) => {
    if (err) return send(res, 404, 'Not found');
    const target = st.isDirectory() ? path.join(file, 'index.html') : file;
    // Check the name the file system really opens too (case, short names, links), not only the requested one.
    let real;
    try { real = fs.realpathSync.native(target); } catch (e) { return send(res, 404, 'Not found'); }
    const realRoot = realRootDir();
    if (!real.startsWith(realRoot + path.sep) || BLOCKED.test(path.relative(realRoot, real))) return send(res, 404, 'Not found');
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

let realRootCache = null;
function realRootDir() {
  if (!realRootCache) { try { realRootCache = fs.realpathSync.native(ROOT); } catch (e) { realRootCache = ROOT; } }
  return realRootCache;
}

/** Writes a small private file (tokens, status) atomically and readable only by this user where the OS supports it. */
function writePrivateFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
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
const tailscaleAllowed = () => /^(1|true|yes)$/i.test((process.env.APEX_ALLOW_TAILSCALE || '').trim());
const tailscaleHosts = () => (process.env.APEX_TAILSCALE_HOST || '').split(',').map(s => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean);
function isTailscaleIp(ip) {
  const clean = String(ip || '').replace(/^::ffff:/, '').replace(/^\[|\]$/g, '');
  const m = clean.match(/^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const b = Number(m[1]);
    return b >= 64 && b <= 127 && Number(m[2]) <= 255 && Number(m[3]) <= 255;
  }
  return /^fd7a:115c:a1e0:/i.test(clean);
}
function isTrustedTailscaleHost(host) {
  const h = String(host || '').trim().toLowerCase();
  if (!h) return false;
  const configured = tailscaleHosts();
  if (!tailscaleAllowed() && !configured.length) return false;
  const hostOnly = h.replace(/:\d+$/, '');
  if (configured.includes(h) || configured.includes(hostOnly)) return true;
  if (!tailscaleAllowed()) return false;
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$/.test(hostOnly) || isTailscaleIp(hostOnly);
}
/** Only pages served by this server (from this PC or another device on the same LAN) may call the API. */
/**
 * The real client address (not a header a client can set) must be this PC or a private home
 * network address - so even on a cafe Wi-Fi nothing outside answers. IPv4-mapped IPv6 is unwrapped.
 */
function isAllowedClient(req) {
  let ip = String((req.socket && req.socket.remoteAddress) || '');
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1' || /^127\./.test(ip)) return true;
  if (/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || /^(f[cd][0-9a-f]{2}|fe80):/i.test(ip)) return true;
  return (tailscaleAllowed() || tailscaleHosts().length > 0) && isTailscaleIp(ip);
}

function isLocalRequest(req) {
  const host = req.headers.host || '';
  const tsHost = isTrustedTailscaleHost(host);
  const hostOk = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host) || LAN_HOST_RE.test(host) || tsHost;
  const origin = req.headers.origin;
  const originOk = !origin || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin) || LAN_HOST_RE.test(origin.replace(/^https?:\/\//, ''))
    || (tsHost && (origin === `https://${host}` || origin === `http://${host}`));
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

// ----------------------------------------------------------- model catalog --
// Each provider's /models list, filtered to chat models the coach can use. Rules are kept identical in start_server.ps1.
const CATALOG = { claude: { source: 'built-in' }, gemini: { source: 'built-in' }, openai: { source: 'built-in' } };
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
let catalogAt = 0;
let catalogRefresh = null;

/** 'gpt-6.1-sol' -> 'GPT-6.1 Sol', 'o4-mini' -> 'o4 Mini'. */
function prettyOpenAiName(id) {
  const parts = id.split('-');
  let head = parts.shift();
  if (head === 'gpt' && parts.length) head = 'GPT-' + parts.shift();
  else if (head === 'chatgpt') head = 'ChatGPT' + (parts.length ? '-' + parts.shift() : '');
  return [head].concat(parts.map(w => w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}
const claudeChat = (id) => /^claude-/.test(id) && !/^claude-(2|instant|3-(?!7))/.test(id);
const claudeAdaptive = (id) => /^claude-(opus|sonnet|haiku)-([5-9]|4-[6-9])/.test(id);
const geminiChat = (id, methods) => /^gemini-/.test(id) && !/^gemini-(1\.|2\.0)/.test(id) && (methods || []).includes('generateContent') &&
  !/(embedding|tts|image|live|audio|native|aqa|vision|robotics|computer-use|learnlm)/.test(id);
const openAiChat = (id) => /^(gpt-[4-9]|o[1-9]|chatgpt-)/.test(id) && !/^gpt-4(-|$)/.test(id) &&
  !/(audio|realtime|tts|transcribe|search|image|embed|moderation|instruct|codex|computer-use|deep-research|oss|-\d{4}-\d{2}-\d{2}$|-\d{4}$)/.test(id);
const openAiReasoning = (id) => /^(o[1-9]|gpt-[5-9])/.test(id) && !/chat/.test(id);

async function getJson(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data && data.error && data.error.message) || `HTTP ${r.status}`);
  return data;
}

/** Live model list for one provider: [{ id, label, adaptive }], newest first. */
async function listProviderModels(provider) {
  if (provider === 'claude') {
    const d = await getJson(`${API_BASE}/v1/models?limit=1000`, { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' });
    return (d.data || []).filter(m => claudeChat(m.id)).map(m => ({ id: m.id, label: m.display_name || m.id, adaptive: claudeAdaptive(m.id) }));
  }
  if (provider === 'gemini') {
    const d = await getJson(`${GEMINI_BASE}/v1beta/models?pageSize=1000`, { 'x-goog-api-key': GEMINI_API_KEY });
    return (d.models || []).map(m => ({ ...m, id: String(m.name || '').replace(/^models\//, '') }))
      .filter(m => geminiChat(m.id, m.supportedGenerationMethods))
      .map(m => ({ id: m.id, label: m.displayName || m.id, adaptive: true }))
      .sort((a, b) => b.id.localeCompare(a.id, 'en', { numeric: true }));
  }
  const d = await getJson(`${OPENAI_BASE}/v1/models`, { authorization: `Bearer ${OPENAI_API_KEY}` });
  return (d.data || []).filter(m => openAiChat(m.id)).sort((a, b) => (b.created || 0) - (a.created || 0))
    .map(m => ({ id: m.id, label: (MODELS[m.id] && MODELS[m.id].label) || prettyOpenAiName(m.id), adaptive: openAiReasoning(m.id) }));
}

/** Refreshes MODELS from every provider that has a key. A provider that fails keeps its current list. */
function refreshModelCatalog(force = false) {
  if (!force && Date.now() - catalogAt < CATALOG_TTL_MS) return Promise.resolve();
  if (catalogRefresh) return catalogRefresh;
  catalogRefresh = Promise.all(Object.keys(PROVIDERS).filter(p => KEYS[p]).map(async (provider) => {
    try {
      const list = await listProviderModels(provider);
      if (!list.length) throw new Error('no chat models returned');
      // Rebuild this provider's entries in the live order; keep the default model even if the list omits it.
      const keep = {};
      for (const [id, m] of Object.entries(MODELS)) if (m.provider === provider && id === DEFAULT_MODELS[provider] && !list.some(x => x.id === id)) keep[id] = m;
      for (const id of Object.keys(MODELS)) if (MODELS[id].provider === provider) delete MODELS[id];
      for (const m of list) MODELS[m.id] = { label: m.label, provider, adaptive: m.adaptive };
      Object.assign(MODELS, keep);
      CATALOG[provider] = { source: 'live', count: list.length, at: new Date().toISOString() };
    } catch (e) {
      CATALOG[provider] = { source: 'built-in', error: e.message };
      console.warn(`[models] ${PROVIDERS[provider].label} model list unavailable (${e.message}); using the built-in list.`);
    }
  })).then(() => { catalogAt = Date.now(); }).finally(() => { catalogRefresh = null; });
  return catalogRefresh;
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
    efforts: EFFORTS,
    catalog: CATALOG
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

/** Gemini 3+ takes a thinking level; Gemini 2.5 takes a token budget instead. */
const GEMINI_BUDGETS = { low: 1024, medium: 8192, high: 24576 };
function geminiThinking(model, effort) {
  return /^gemini-2\./.test(model || '') ? { thinkingBudget: GEMINI_BUDGETS[effort] || 1024, includeThoughts: true } : { thinkingLevel: effort, includeThoughts: true };
}

function buildGeminiRequest(prompt, model, effort) {
  return {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: 16000,
      responseMimeType: 'application/json',
      thinkingConfig: geminiThinking(model, effort)
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
function buildGeminiAskRequest(messages, context, effort, model) {
  return {
    systemInstruction: { parts: [{ text: ASK_SYSTEM_PROMPT }, { text: `TRAINING DATA\n${context || '(no data for this period)'}` }] },
    contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    generationConfig: {
      maxOutputTokens: 16000,
      thinkingConfig: geminiThinking(model, effort)
    }
  };
}

/**
 * OpenAI Responses API request. Reasoning models (o-series, GPT-5 and later) get the effort setting and a
 * reasoning summary (shown like Claude's thinking); other models get neither.
 */
function buildOpenAiRequest(instructions, input, model, effort, summary = true) {
  const body = { model, instructions, input, max_output_tokens: 16000, store: false };
  if (MODELS[model] && MODELS[model].adaptive) body.reasoning = summary ? { effort, summary: 'auto' } : { effort };
  return body;
}
const buildOpenAiCoachRequest = (prompt, model, effort) => buildOpenAiRequest(SYSTEM_PROMPT, [{ role: 'user', content: prompt }], model, effort);
const buildOpenAiAskRequest = (messages, context, model, effort) => buildOpenAiRequest(
  `${ASK_SYSTEM_PROMPT}\n\nTRAINING DATA\n${context || '(no data for this period)'}`,
  messages.map(m => ({ role: m.role, content: m.content })), model, effort);

/** Calls OpenAI (Responses API); retries once without the reasoning summary if the account cannot use it. */
async function callOpenAi(reqBody, signal) {
  const post = (b) => fetch(`${OPENAI_BASE}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(b),
    signal
  });
  let upstream = await post(reqBody);
  let data = await upstream.json().catch(() => ({}));
  if (upstream.status === 400 && reqBody.reasoning && reqBody.reasoning.summary && /summar|verif/i.test((data.error && data.error.message) || '')) {
    reqBody = { ...reqBody, reasoning: { effort: reqBody.reasoning.effort } };
    upstream = await post(reqBody);
    data = await upstream.json().catch(() => ({}));
  }
  if (!upstream.ok) {
    const msg = (data && data.error && data.error.message) || `HTTP ${upstream.status}`;
    return { error: `OpenAI API error ${upstream.status}: ${msg}`, upstreamStatus: upstream.status, log: `${upstream.status} ${msg}` };
  }
  const items = Array.isArray(data.output) ? data.output : [];
  let text = '', refusal = '';
  const thinking = [];
  for (const it of items) {
    if (it.type === 'message') for (const c of it.content || []) {
      if (c.type === 'output_text') text += c.text || '';
      else if (c.type === 'refusal') refusal += c.refusal || '';
    } else if (it.type === 'reasoning') for (const s of it.summary || []) if (s.text) thinking.push(s.text);
  }
  const u = data.usage || {};
  const incomplete = data.status === 'incomplete' && data.incomplete_details && data.incomplete_details.reason;
  return {
    text,
    thinking: thinking.join('\n\n'),
    model: data.model || reqBody.model,
    stopReason: refusal && !text ? 'refusal' : incomplete === 'max_output_tokens' ? 'max_tokens' : (incomplete || 'end_turn'),
    usage: { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0, cache_read_input_tokens: (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0 },
    rawOutput: items
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
    usage: { input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0, cache_read_input_tokens: usage.cache_read_input_tokens || 0 },
    contentBlocks: blocks
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
    usage: { input_tokens: um.promptTokenCount || 0, output_tokens: (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0) },
    rawParts: parts
  };
}

/** The model decides the provider; without a (known) model, use the requested or default provider's default model. */
function resolveEngine(input) {
  const provider = MODELS[input.model] ? MODELS[input.model].provider : (PROVIDERS[input.provider] ? input.provider : DEFAULT_PROVIDER);
  const model = MODELS[input.model] ? input.model : DEFAULT_MODELS[provider];
  const effort = EFFORTS.includes(input.effort) ? input.effort : DEFAULT_EFFORT;
  return { provider, model, effort, p: PROVIDERS[provider] };
}

/** Reads and checks a JSON request from the app (local PC, or a paired sync client when allowed). */
async function readAppJson(req, res, { allowPairedSync = false } = {}) {
  const ok = isPcRequest(req) || (allowPairedSync && isPairedSyncClient(req));
  if (!ok) { sendJson(res, 403, { error: 'Requests are only accepted from the app on this PC.' }); return null; }
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) { sendJson(res, 415, { error: 'Content-Type must be application/json.' }); return null; }
  try { return JSON.parse(await readBody(req)); } catch (e) { sendJson(res, e.status || 400, { error: e.status ? e.message : 'Invalid JSON.' }); return null; }
}

async function handleCoach(req, res) {
  const input = await readAppJson(req, res, { allowPairedSync: true });
  if (!input) return;
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (!prompt.trim() || prompt.length > 100000) return sendJson(res, 400, { error: 'A prompt of 1-100000 characters is required.' });
  const { provider, model, effort, p } = resolveEngine(input);
  if (!KEYS[provider]) return sendJson(res, 503, { error: `No ${p.label} API key. Add ${p.keyName} to the .env file and restart the server.` });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  // res, not req: the request's 'close' has already fired once its body was read, so it never reports a cancel.
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  const t0 = Date.now();
  try {
    const out = provider === 'gemini'
      ? await callGemini(buildGeminiRequest(prompt, model, effort), model, ac.signal)
      : provider === 'openai' ? await callOpenAi(buildOpenAiCoachRequest(prompt, model, effort), ac.signal)
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
  return { messages, context, useTools: input.useTools === true };
}

let aiToolsCache = null;
function tryLoadDbTools() {
  try {
    const store = storage();
    if (!store || !store.initialized) return null;
    if (!aiToolsCache) aiToolsCache = require('./scripts/ai-tools.cjs');
    return { store, aiTools: aiToolsCache };
  } catch {
    return null;
  }
}

function addAskUsage(acc, u) {
  if (!u) return acc;
  acc.input_tokens += u.input_tokens || 0;
  acc.output_tokens += u.output_tokens || 0;
  acc.cache_read_input_tokens += u.cache_read_input_tokens || 0;
  return acc;
}

async function runClaudeAskWithTools(v, model, effort, dbTools, signal) {
  const { store, aiTools } = dbTools;
  let allowFallback = true;
  const reqBody = buildClaudeAskRequest(v.messages, v.context, model, effort, allowFallback);
  reqBody.system.push({ type: 'text', text: aiTools.AI_TOOLS_PROMPT });
  reqBody.tools = aiTools.claudeTools();
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  const toolsUsed = [];

  for (let round = 0; round <= ASK_MAX_TOOL_ROUNDS; round++) {
    if (round === ASK_MAX_TOOL_ROUNDS) reqBody.tool_choice = { type: 'none' };
    let out = await callClaude(reqBody, signal);
    if (round === 0 && out.error && out.upstreamStatus === 400 && /fallback/i.test(out.log || '')) {
      allowFallback = false;
      delete reqBody.fallbacks;
      out = await callClaude(reqBody, signal);
    }
    if (out.error) return out;
    addAskUsage(usage, out.usage);
    const calls = (out.contentBlocks || []).filter(b => b && b.type === 'tool_use');
    if (!calls.length || round === ASK_MAX_TOOL_ROUNDS) {
      return { ...out, usage, toolsUsed };
    }
    reqBody.messages.push({ role: 'assistant', content: out.contentBlocks });
    const results = [];
    for (const tc of calls) {
      const result = aiTools.executeTool(store, tc.name, tc.input || {});
      toolsUsed.push({ name: tc.name });
      results.push({ type: 'tool_result', tool_use_id: tc.id, content: JSON.stringify(result) });
    }
    reqBody.messages.push({ role: 'user', content: results });
  }
}

async function runGeminiAskWithTools(v, model, effort, dbTools, signal) {
  const { store, aiTools } = dbTools;
  const reqBody = buildGeminiAskRequest(v.messages, v.context, effort, model);
  reqBody.systemInstruction.parts.push({ text: aiTools.AI_TOOLS_PROMPT });
  reqBody.tools = aiTools.geminiTools();
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  const toolsUsed = [];

  for (let round = 0; round <= ASK_MAX_TOOL_ROUNDS; round++) {
    if (round === ASK_MAX_TOOL_ROUNDS) reqBody.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
    const out = await callGemini(reqBody, model, signal);
    if (out.error) return out;
    addAskUsage(usage, out.usage);
    const calls = (out.rawParts || []).filter(p => p && p.functionCall);
    if (!calls.length || round === ASK_MAX_TOOL_ROUNDS) {
      return { ...out, usage, toolsUsed };
    }
    reqBody.contents.push({ role: 'model', parts: out.rawParts });
    const responses = [];
    for (const p of calls) {
      const fc = p.functionCall;
      const result = aiTools.executeTool(store, fc.name, fc.args || {});
      toolsUsed.push({ name: fc.name });
      responses.push({ functionResponse: { name: fc.name, response: { result } } });
    }
    reqBody.contents.push({ role: 'user', parts: responses });
  }
}

async function runOpenAiAskWithTools(v, model, effort, dbTools, signal) {
  const { store, aiTools } = dbTools;
  const reqBody = buildOpenAiAskRequest(v.messages, v.context, model, effort);
  reqBody.instructions = `${reqBody.instructions}\n\n${aiTools.AI_TOOLS_PROMPT}`;
  reqBody.tools = aiTools.openaiTools();
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  const toolsUsed = [];

  for (let round = 0; round <= ASK_MAX_TOOL_ROUNDS; round++) {
    if (round === ASK_MAX_TOOL_ROUNDS) reqBody.tool_choice = 'none';
    const out = await callOpenAi(reqBody, signal);
    if (out.error) return out;
    addAskUsage(usage, out.usage);
    const calls = (out.rawOutput || []).filter(it => it && it.type === 'function_call');
    if (!calls.length || round === ASK_MAX_TOOL_ROUNDS) {
      return { ...out, usage, toolsUsed };
    }
    for (const it of out.rawOutput) reqBody.input.push(it);
    for (const fc of calls) {
      let args = {};
      try { args = typeof fc.arguments === 'string' ? JSON.parse(fc.arguments || '{}') : (fc.arguments || {}); } catch {}
      const result = aiTools.executeTool(store, fc.name, args);
      toolsUsed.push({ name: fc.name });
      reqBody.input.push({ type: 'function_call_output', call_id: fc.call_id, output: JSON.stringify(result) });
    }
  }
}

/** POST /api/ask - free questions about the rider's own training data, answered by Claude, Gemini or ChatGPT. */
async function handleAsk(req, res) {
  const input = await readAppJson(req, res, { allowPairedSync: true });
  if (!input) return;
  const v = validateAsk(input);
  if (v.error) return sendJson(res, 400, { error: v.error });
  const { provider, model, effort, p } = resolveEngine(input);
  if (!KEYS[provider]) return sendJson(res, 503, { error: `No ${p.label} API key. Add ${p.keyName} to the .env file and restart the server.` });

  const wantTools = v.useTools || (isPairedSyncClient(req) && input.useTools !== false);
  const dbTools = wantTools ? tryLoadDbTools() : null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  // res, not req: the request's 'close' has already fired once its body was read, so it never reports a cancel.
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  const t0 = Date.now();
  try {
    let out;
    if (dbTools) {
      if (provider === 'gemini') out = await runGeminiAskWithTools(v, model, effort, dbTools, ac.signal);
      else if (provider === 'openai') out = await runOpenAiAskWithTools(v, model, effort, dbTools, ac.signal);
      else out = await runClaudeAskWithTools(v, model, effort, dbTools, ac.signal);
    } else if (provider === 'gemini') out = await callGemini(buildGeminiAskRequest(v.messages, v.context, effort, model), model, ac.signal);
    else if (provider === 'openai') out = await callOpenAi(buildOpenAiAskRequest(v.messages, v.context, model, effort), ac.signal);
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
    const toolsUsed = Array.isArray(out.toolsUsed) ? out.toolsUsed : [];
    console.log(`[ask] ${out.model} (${MODELS[model].adaptive ? effort : 'budget'}) ${((Date.now() - t0) / 1000).toFixed(1)} s, ${out.usage.input_tokens} in (${out.usage.cache_read_input_tokens || 0} cached) / ${out.usage.output_tokens} out tokens${toolsUsed.length ? `, tools=${toolsUsed.length}` : ''}, stop=${out.stopReason}`);
    return sendJson(res, 200, { text, refused, provider, model: out.model, effort: MODELS[model].adaptive ? effort : null, stopReason: out.stopReason, usage: out.usage, ...(toolsUsed.length ? { toolsUsed } : {}) });
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
const STRAVA_TIMEOUT_MS = 30000;
const STRAVA_UPLOAD_TIMEOUT_MS = 120000;
const stravaStates = new Map();

function readStravaTokens() {
  try { return JSON.parse(fs.readFileSync(STRAVA_TOKEN_FILE, 'utf8')); } catch (e) { return null; }
}
function saveStravaTokens(d, scope, athlete) {
  const a = athlete || d.athlete || {};
  writePrivateFile(STRAVA_TOKEN_FILE, JSON.stringify({
    access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at, scope: scope || '',
    athlete: { id: a.id, firstname: a.firstname || '', lastname: a.lastname || '' }
  }, null, 2));
}
async function stravaForm(url, fields) {
  const r = await fetch(url, { method: 'POST', body: new URLSearchParams(fields), signal: AbortSignal.timeout(STRAVA_TIMEOUT_MS) });
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
  const r = await fetch(`${STRAVA_BASE}/api/v3/${pathAndQuery}`, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(STRAVA_TIMEOUT_MS) });
  const data = await r.json().catch(() => null);
  return { status: r.status, ok: r.ok, data, rate: stravaRate(r) };
}

async function handleStravaSync(req, res, query) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
  if (!isPcRequest(req)) return sendJson(res, 403, { error: 'Forbidden' });
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
      r = await fetch(`${STRAVA_BASE}/api/v3/activities/${sid}/streams?keys=${SYNC_STREAM_KEYS}&key_by_type=true`, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(STRAVA_TIMEOUT_MS) });
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
    if (!isPcRequest(req)) return sendJson(res, 403, { error: 'Forbidden' });
    return sendJson(res, 200, stravaStatus());
  }
  if (urlPath === '/api/strava/connect') {
    if (!isPcRequest(req)) return send(res, 403, 'Forbidden');
    if (!STRAVA_CLIENT_ID || !STRAVA_CLIENT_SECRET) return sendHtml(res, 400, 'Strava not set up', '<h1>Strava is not set up yet</h1><p>Add <code>STRAVA_CLIENT_ID</code> and <code>STRAVA_CLIENT_SECRET</code> to the <code>.env</code> file, restart the server, then try again.</p>');
    const state = require('crypto').randomBytes(16).toString('hex');
    stravaStates.set(state, Date.now());
    const host = String(req.headers.host || '');
    const redirect = isTrustedTailscaleHost(host) ? `https://${host}/api/strava/callback` : `http://localhost:${PORT}/api/strava/callback`;
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
    if (!isPcRequest(req)) return sendJson(res, 403, { error: 'Forbidden' });
    const token = await stravaAccessToken();
    if (token) await stravaForm(`${STRAVA_BASE}/oauth/deauthorize`, { access_token: token }).catch(() => {});
    try { fs.unlinkSync(STRAVA_TOKEN_FILE); } catch (e) { /* not connected */ }
    return sendJson(res, 200, stravaStatus());
  }
  if (urlPath === '/api/strava/upload') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    if (!isPcRequest(req)) return sendJson(res, 403, { error: 'Requests are only accepted from the app on this PC.' });
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
    try { r = await fetch(`${STRAVA_BASE}/api/v3/uploads`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.timeout(STRAVA_UPLOAD_TIMEOUT_MS) }); }
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
    if (!isPcRequest(req)) return sendJson(res, 403, { error: 'Forbidden' });
    const after = query.get('after') || '', before = query.get('before') || '';
    if (!/^\d+$/.test(after) || !/^\d+$/.test(before)) return sendJson(res, 400, { error: 'after and before (unix seconds) are required' });
    const token = await stravaAccessToken();
    if (!token) return sendJson(res, 401, { error: 'Strava is not connected.', needsConnect: true });
    const out = [];
    for (let page = 1; page <= 10; page++) {
      let r;
      try { r = await fetch(`${STRAVA_BASE}/api/v3/athlete/activities?after=${after}&before=${before}&per_page=200&page=${page}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(STRAVA_TIMEOUT_MS) }); }
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
    if (!isPcRequest(req)) return sendJson(res, 403, { error: 'Forbidden' });
    const token = await stravaAccessToken();
    if (!token) return sendJson(res, 401, { error: 'Strava is not connected.', needsConnect: true });
    let r;
    try { r = await fetch(`${STRAVA_BASE}/api/v3/uploads/${m[1]}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(STRAVA_TIMEOUT_MS) }); }
    catch (e) { return sendJson(res, 502, { error: `Could not reach Strava (${e.message}).` }); }
    const d = await r.json().catch(() => null);
    if (!r.ok || !d) return sendJson(res, 502, { error: `Strava status check failed (HTTP ${r.status}).` });
    return sendJson(res, 200, convertUpload(d));
  }
  return sendJson(res, 404, { error: 'Not found' });
}

// ------------------------------------------------------------ Hevy (READ ONLY) --
function slimHevyWorkout(w) {
  if (!w || typeof w !== 'object') return null;
  const exercises = Array.isArray(w.exercises) ? w.exercises.filter(Boolean).map((ex) => ({
    title: String(ex.title || '').trim(),
    notes: ex.notes ? String(ex.notes).trim() : '',
    sets: Array.isArray(ex.sets) ? ex.sets.filter(Boolean).map((s) => ({
      type: s.type || 'normal',
      weight_kg: s.weight_kg ?? null,
      reps: s.reps ?? null,
      distance_meters: s.distance_meters ?? null,
      duration_seconds: s.duration_seconds ?? null,
      rpe: s.rpe ?? null
    })) : []
  })) : [];
  return {
    id: String(w.id),
    title: String(w.title || '').trim(),
    description: w.description ? String(w.description).trim() : '',
    start_time: toIsoUtc(w.start_time),
    end_time: toIsoUtc(w.end_time),
    updated_at: toIsoUtc(w.updated_at),
    exercises
  };
}

async function handleHevy(req, res, urlPath, query) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
  if (!isPcRequest(req)) return sendJson(res, 403, { error: 'Forbidden' });
  if (urlPath === '/api/hevy/status') {
    return sendJson(res, 200, {
      configured: !!HEVY_API_KEY,
      keySource: HEVY_KEY_FROM_ENVIRONMENT ? 'env' : (HEVY_API_KEY ? 'dotenv' : null)
    });
  }
  if (urlPath === '/api/hevy/workouts') {
    if (!HEVY_API_KEY) {
      return sendJson(res, 400, { error: 'Hevy is not set up yet. Add HEVY_API_KEY to .env and restart the server.', needsKey: true });
    }
    const rawAfter = query.get('after'), rawBefore = query.get('before');
    let afterMs = null, beforeMs = null;
    if (rawAfter !== null || rawBefore !== null) {
      afterMs = Date.parse(rawAfter || '');
      beforeMs = Date.parse(rawBefore || '');
      if (!Number.isFinite(afterMs) || !Number.isFinite(beforeMs) || beforeMs <= afterMs) {
        return sendJson(res, 400, { error: 'after and before must be ISO dates, with after before before' });
      }
    }
    const out = [];
    let pages = 0;
    for (let page = 1; page <= HEVY_MAX_PAGES; page++) {
      let r, data;
      try {
        r = await fetch(`${HEVY_BASE}/v1/workouts?page=${page}&pageSize=${HEVY_PAGE_SIZE}`, {
          method: 'GET',
          headers: { 'api-key': HEVY_API_KEY, Accept: 'application/json' },
          signal: AbortSignal.timeout(HEVY_TIMEOUT_MS)
        });
        data = await r.json().catch(() => null);
      } catch (e) {
        return sendJson(res, 502, { error: `Could not reach Hevy (${e.message}).` });
      }
      if (r.status === 401 || r.status === 403) {
        return sendJson(res, 401, { error: 'Hevy rejected the API key. Check HEVY_API_KEY in .env and restart the server.', invalidKey: true });
      }
      if (r.status === 429) {
        return sendJson(res, 429, { error: 'Hevy rate limit reached - try again in a minute.' });
      }
      if (r.status === 404 && page > 1) break;
      if (!r.ok || !data || !Array.isArray(data.workouts)) {
        return sendJson(res, 502, { error: `Hevy workout list failed (HTTP ${r.status}).` });
      }
      pages = page;
      const list = data.workouts;
      if (!list.length) break;
      let allOlderThanAfter = afterMs !== null;
      for (const raw of list) {
        const w = slimHevyWorkout(raw);
        if (!w || !w.id || !w.start_time) continue;
        const t = Date.parse(w.start_time);
        if (afterMs === null || t >= afterMs) allOlderThanAfter = false;
        if (afterMs !== null && t < afterMs) continue;
        if (beforeMs !== null && t >= beforeMs) continue;
        out.push(w);
      }
      if (allOlderThanAfter || (data.page_count && page >= Number(data.page_count)) || list.length < HEVY_PAGE_SIZE) break;
    }
    return sendJson(res, 200, {
      workouts: out,
      after: afterMs !== null ? new Date(afterMs).toISOString() : null,
      before: beforeMs !== null ? new Date(beforeMs).toISOString() : null,
      pages
    });
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
const live = { snapshot: null, at: 0, seq: 0, cmds: [], cmdId: Date.now(), waiters: [], cmdWaiter: null, fit: null, cards: null }; // ids keep rising across restarts
const LIVE_FIT_MAX_BYTES = 16 * 1024 * 1024;
const LIVE_CARD_MAX_BYTES = 12 * 1024 * 1024;
const LIVE_CARD_STYLES = new Set(['full', 'minimal']);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

function liveState() {
  const fit = live.fit ? { id: live.fit.id, filename: live.fit.filename, url: '/api/live/fit?id=' + encodeURIComponent(live.fit.id) } : null;
  const cards = live.cards ? { id: live.cards.id, styles: Object.keys(live.cards.images) } : null;
  return { snapshot: live.snapshot, ageMs: live.at ? Date.now() - live.at : null, pending: live.cmds.length, seq: live.seq, fit, cards };
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

// SQLite is opened lazily, so API-only tests and old standalone server copies do not touch user data.
let localStore = null;
function storage() {
  if (!localStore) {
    const { LocalStore } = require('./scripts/sqlite-store.cjs');
    localStore = new LocalStore({ legacyDir: path.join(ROOT, 'data', 'backups') });
    localStore.startDailyBackups();
  }
  return localStore;
}
async function handleStorage(req, res, urlPath) {
  if (!isPcRequest(req)) return sendJson(res, 403, { error: 'Saved data is available only on this PC.' });
  // Require the exact origin for browser writes, including its port (other local sites are unrelated).
  const host = String(req.headers.host || '');
  const allowHttps = isTrustedTailscaleHost(host) || req.headers['x-forwarded-proto'] === 'https';
  const originOk = !req.headers.origin || req.headers.origin === `http://${host}` || (allowHttps && req.headers.origin === `https://${host}`);
  if (!originOk) return sendJson(res, 403, { error: 'Open Apex on this server to save data.' });
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return sendJson(res, 403, { error: 'Cross-origin storage request refused.' });
  try {
    const store = storage();
    if (req.method === 'GET') {
      if (urlPath === '/api/storage') return sendJson(res, 200, store.state());
      if (urlPath === '/api/storage/rides') return sendJson(res, 200, { ok: true, rides: store.rides(), revision: store.revision });
      if (urlPath === '/api/storage/db-settings') return sendJson(res, 200, { ok: true, settings: store.dbSettings(), revision: store.revision });
      if (urlPath === '/api/storage/backups') return sendJson(res, 200, store.backups());
      if (urlPath === '/api/storage/analytics-status') return sendJson(res, 200, { ok: true, ...store.analyticsStatus() });
      return sendJson(res, 404, { error: 'Not found' });
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'Content-Type must be application/json.' });
    const text = await readBody(req, 200 * 1024 * 1024);
    let input; try { input = JSON.parse(text); } catch { return sendJson(res, 400, { error: 'Invalid JSON.' }); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return sendJson(res, 400, { error: 'Invalid request.' });
    if (urlPath === '/api/storage/migrate') return sendJson(res, 200, store.migrate(input));
    if (urlPath === '/api/storage/save') return sendJson(res, 200, store.update(input));
    if (urlPath === '/api/storage/wellness') {
      store.putWellnessDays(input.source || 'apple', input.days || {});
      return sendJson(res, 200, { ok: true, revision: store.revision });
    }
    if (urlPath === '/api/storage/backup') return sendJson(res, 200, { ok: true, ...store.backup() });
    if (urlPath === '/api/storage/import-backup') return sendJson(res, 200, { ok: true, ...store.importSnapshot(input.backup) });
    if (urlPath === '/api/storage/preview') {
      const { payload, reason, verified } = store.readSnapshot(store.snapshotFile(input.name));
      return sendJson(res, 200, { ok: true, name: input.name, at: payload.exportedAt, rides: payload.history.length,
        samples: payload.history.reduce((n,r) => n + (r.samples?.length || 0), 0), profiles: payload.profiles?.length || 0,
        reason, verified, settings: Object.keys(payload.settings || {}).length });
    }
    if (urlPath === '/api/storage/restore') return sendJson(res, 200, store.restore(input));
    return sendJson(res, 404, { error: 'Not found' });
  } catch (e) { return sendJson(res, e.status || 503, { error: e.message }); }
}

// ------------------------------------------------ legacy backups (this PC only) --
// The app posts its history backup (the same JSON as "Backup JSON", gzipped in the browser) after
// changes and once a day. Kept in data/backups (the newest BACKUP_KEEP), never served to anyone.
const BACKUP_DIR = path.join(ROOT, 'data', 'backups');
const BACKUP_KEEP = 14;
const BACKUP_MAX_BYTES = 200 * 1024 * 1024;
const BACKUP_NAME_RE = /^apex_velo_backup_\d{4}-\d{2}-\d{2}_\d{6}\.json\.gz$/;
const BACKUP_PREFIX = '{"app":"APEX VELO LAB"';

/** Only the app opened on this PC (or via trusted Tailscale host when enabled). */
function isPcRequest(req) {
  const host = req.headers.host || '';
  const origin = req.headers.origin;
  const ip = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  const loopback = ip === '::1' || /^127\./.test(ip);
  if (loopback && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host) && (!origin || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin))) {
    return true;
  }
  if ((loopback || isTailscaleIp(ip)) && isTrustedTailscaleHost(host)) {
    return !origin || origin === `https://${host}` || origin === `http://${host}`;
  }
  return false;
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
  writePrivateFile(HEALTH_TOKEN_FILE, t);
  return t;
}

// The phone remote is paired by opening the address shown on this PC (Settings > Phone view), which carries
// this token in its #fragment. live.html keeps it and sends it with every request, so another device on the
// same Wi-Fi cannot drive the trainer, read the live screen or download rides.
const PHONE_TOKEN_FILE = path.join(ROOT, 'data', 'phone-token.txt');
function phoneToken(renew = false) {
  if (!renew) { try { const t = fs.readFileSync(PHONE_TOKEN_FILE, 'utf8').trim(); if (/^[0-9a-f]{20,}$/.test(t)) return t; } catch (e) { /* none yet */ } }
  const t = require('crypto').randomBytes(10).toString('hex');
  writePrivateFile(PHONE_TOKEN_FILE, t);
  return t;
}
function safeEqual(given, want) {
  const a = Buffer.from(String(given || '')), b = Buffer.from(want);
  return a.length === b.length && require('crypto').timingSafeEqual(a, b);
}
/** The app on this PC, or a phone that was paired with the token. */
function isPairedPhone(req, query) {
  if (isPcRequest(req)) return true;
  return safeEqual(req.headers['x-apex-phone'] || query.get('k'), phoneToken());
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

function healthStatus(req = null) {
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(HEALTH_META_FILE, 'utf8')) || {}; } catch (e) { /* none yet */ }
  const ips = lanAddresses();
  const pair = phoneToken();
  const tsList = [];
  const reqHost = req && String(req.headers.host || '');
  if (reqHost && isTrustedTailscaleHost(reqHost)) tsList.push(`https://${reqHost}`);
  for (const h of tailscaleHosts()) {
    const u = `https://${h}`;
    if (!tsList.includes(u)) tsList.push(u);
  }
  return {
    token: healthToken(),
    port: PORT,
    urls: [...tsList.map(u => `${u}/api/health`), ...ips.map(ip => `http://${ip}:${PORT}/api/health`)],
    phoneUrls: ips.map(ip => `http://${ip}:${PORT}/live.html#pair=${pair}`),
    inbox: healthInboxFiles().length,
    lastReceived: meta.lastReceived || null,
    lastBytes: meta.lastBytes || 0,
    received: meta.received || 0
  };
}

function tokenMatches(given) {
  return safeEqual(given, healthToken());
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
    if (healthInboxFiles().length >= HEALTH_INBOX_KEEP) return sendJson(res, 429, { error: 'Health inbox is full. Open the app on this computer to collect existing exports, then retry.' });
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const name = `hae_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}_${require('crypto').randomBytes(3).toString('hex')}.json`;
    try {
      fs.mkdirSync(HEALTH_INBOX, { recursive: true });
      const tmp = path.join(HEALTH_INBOX, `.${name}.tmp`);
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, path.join(HEALTH_INBOX, name));
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(HEALTH_META_FILE, 'utf8')) || {}; } catch (e) { /* first */ }
      writePrivateFile(HEALTH_META_FILE, JSON.stringify({ lastReceived: d.toISOString(), lastBytes: buf.length, received: (meta.received || 0) + 1 }));
    } catch (e) {
      return sendJson(res, 500, { error: `Could not save the data (${e.message}).` });
    }
    if (fs.existsSync(path.join(ROOT, 'scripts', 'sqlite-store.cjs'))) {
      try {
        const store = storage();
        if (store.initialized) {
          const rawStats = store.ingestHealthAutoExport(body);
          if (rawStats && (rawStats.readings || rawStats.sleepSessions)) {
            console.log(`[health] stored ${rawStats.readings} readings (${rawStats.metrics.length} metrics) & ${rawStats.sleepSessions} sleep records into SQLite`);
          }
        }
      } catch (e) {
        console.warn('[health] raw SQLite capture skipped:', e.message);
      }
    }
    return sendJson(res, 200, { ok: true, stored: name });
  }
  // Everything else - the token, the stored data - only for the app on this PC.
  if (!isPcRequest(req)) return sendJson(res, 403, { error: 'Only the app on this PC can read Apple Health data.' });
  if (urlPath === '/api/health/status' && req.method === 'GET') return sendJson(res, 200, healthStatus(req));
  if (urlPath === '/api/health/token' && req.method === 'POST') { healthToken(true); return sendJson(res, 200, healthStatus(req)); }
  if (urlPath === '/api/health/phone-token' && req.method === 'POST') { phoneToken(true); return sendJson(res, 200, healthStatus(req)); }
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
  const query = new URL(req.url, 'http://localhost').searchParams;
  // Publishing the live screen and collecting commands is for the PC app; reading it and sending commands
  // needs the PC or a paired phone.
  const pcOnly = (urlPath === '/api/live' && req.method === 'POST') || urlPath === '/api/live/cmds' || ((urlPath === '/api/live/fit' || urlPath === '/api/live/card') && req.method === 'POST');
  if (pcOnly ? !isPcRequest(req) : !isPairedPhone(req, query)) {
    return pcOnly ? sendJson(res, 403, { error: 'Only the app on this PC can do this.' })
      : sendJson(res, 401, { error: 'This phone is not paired. Open the address from Settings > Phone view on the PC.', needsPairing: true });
  }
  if (urlPath === '/api/live/fit') {
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
  if (urlPath === '/api/live/card') {
    // The ride's share card (JPEG or PNG) drawn by the PC app, so the phone can save or share it.
    const id = query.get('id'), style = query.get('style');
    if (req.method === 'GET' || req.method === 'HEAD') {
      const img = live.cards && live.cards.id === id ? live.cards.images[style] : null;
      if (!img) return sendJson(res, 404, { error: 'This ride card is no longer available. Keep the PC app open until saved.' });
      res.writeHead(200, {
        'Content-Type': img.type, 'Content-Length': img.bytes.length,
        'Content-Disposition': `${query.get('download') === '1' ? 'attachment' : 'inline'}; filename="${img.filename}"`,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      });
      return res.end(req.method === 'HEAD' ? undefined : img.bytes);
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    const filename = query.get('filename');
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id || '') || !LIVE_CARD_STYLES.has(style) || !/^[a-zA-Z0-9_-]{1,120}\.(png|jpg)$/.test(filename || '')) return sendJson(res, 400, { error: 'Invalid card name, style or ride id.' });
    if (Number(req.headers['content-length']) > LIVE_CARD_MAX_BYTES) return sendJson(res, 413, { error: 'Card image too large' });
    let bytes;
    try { bytes = await readRaw(req, LIVE_CARD_MAX_BYTES); }
    catch (e) { return sendJson(res, e.status || 400, { error: e.status === 413 ? 'Card image too large' : 'Could not read the card image.' }); }
    const type = filename.endsWith('.png') ? 'image/png' : 'image/jpeg';
    const sig = type === 'image/png' ? PNG_SIGNATURE : JPEG_SIGNATURE;
    if (bytes.length < 64 || !bytes.subarray(0, sig.length).equals(sig)) return sendJson(res, 400, { error: 'Invalid card image.' });
    if (!live.cards || live.cards.id !== id) live.cards = { id, images: {} };
    live.cards.images[style] = { filename, type, bytes };
    live.seq++;
    sendJson(res, 200, { ok: true });
    releaseLiveWaiters();
    return;
  }
  if (urlPath === '/api/live') {
    if (req.method === 'GET') {
      const after = query.get('after');
      // Nothing newer than what the phone already has: hold the request until the next snapshot.
      if (after !== null && Number(after) === live.seq) {
        if (live.waiters.length >= LIVE_MAX_WAITERS) { const old = live.waiters.shift(); clearTimeout(old.timer); if (!old.res.writableEnded) sendJson(old.res, 200, liveState()); }
        const w = { res, timer: null };
        w.timer = setTimeout(() => { live.waiters = live.waiters.filter(x => x !== w); if (!res.writableEnded) sendJson(res, 200, liveState()); }, LIVE_HOLD_MS);
        live.waiters.push(w);
        res.on('close', () => { clearTimeout(w.timer); live.waiters = live.waiters.filter(x => x !== w); });
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
      sendJson(res, 200, { cmds, fitId: live.fit ? live.fit.id : null, cards: live.cards ? { id: live.cards.id, styles: Object.keys(live.cards.images) } : null });
      releaseLiveWaiters();
      return;
    }
    return sendJson(res, 405, { error: 'Method not allowed' });
  }
  if (urlPath === '/api/live/cmds') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
    const after = Number(query.get('after')) || 0;
    const ready = pendingLiveCmds(after);
    if (ready.length) return sendJson(res, 200, { cmds: ready });
    if (live.cmdWaiter) { const old = live.cmdWaiter; clearTimeout(old.timer); if (!old.res.writableEnded) sendJson(old.res, 200, { cmds: [] }); }
    const w = { res, after, timer: null };
    w.timer = setTimeout(() => { if (live.cmdWaiter === w) live.cmdWaiter = null; if (!res.writableEnded) sendJson(res, 200, { cmds: [] }); }, LIVE_CMD_HOLD_MS);
    live.cmdWaiter = w;
    res.on('close', () => { clearTimeout(w.timer); if (live.cmdWaiter === w) live.cmdWaiter = null; });
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

// -------------------------------------------------------- Home Server Sync --
const SYNC_TOKEN_FILE = path.join(ROOT, 'data', 'sync-token.txt');
const SYNC_META_FILE = path.join(ROOT, 'data', 'sync-meta.json');
const syncSseClients = new Set();

function syncToken(renew = false) {
  if (!renew) {
    try {
      const t = fs.readFileSync(SYNC_TOKEN_FILE, 'utf8').trim();
      if (/^[0-9a-f]{32,}$/.test(t)) return t;
    } catch (e) { /* none yet */ }
  }
  const t = crypto.randomBytes(24).toString('hex');
  writePrivateFile(SYNC_TOKEN_FILE, t);
  return t;
}

function isPairedSyncClient(req) {
  const auth = String(req.headers.authorization || '');
  const bearer = auth.replace(/^Bearer\s+/i, '').trim();
  const given = bearer || String(req.headers['x-apex-sync-token'] || '').trim();
  return !!(given && safeEqual(given, syncToken()));
}

function tailscaleIps() {
  const out = [];
  try {
    const nets = require('os').networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const n of nets[name] || []) if (!n.internal && n.family === 'IPv4' && isTailscaleIp(n.address)) out.push(n.address);
    }
  } catch (e) { /* best effort */ }
  return out;
}

function syncServerUrls(req) {
  const urls = [];
  const add = (u) => { if (u && !urls.includes(u)) urls.push(u); };
  const reqHost = req && String(req.headers.host || '');
  if (reqHost && isTrustedTailscaleHost(reqHost)) add(`https://${reqHost}`);
  for (const h of tailscaleHosts()) add(`https://${h}`);
  for (const ip of tailscaleIps()) add(`http://${ip}:${PORT}`);
  for (const ip of lanAddresses()) add(`http://${ip}:${PORT}`);
  if (!urls.length) add(`http://localhost:${PORT}`);
  return urls;
}

function readSyncMeta() {
  try { return JSON.parse(fs.readFileSync(SYNC_META_FILE, 'utf8')) || {}; } catch (e) { return {}; }
}

function writeSyncMeta(meta) {
  try { writePrivateFile(SYNC_META_FILE, JSON.stringify(meta)); } catch (e) { /* best effort */ }
}

function broadcastSyncEvent(payload) {
  const frame = `event: sync\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of syncSseClients) {
    try {
      if (!res.writableEnded) res.write(frame);
    } catch (e) {
      syncSseClients.delete(res);
    }
  }
}

function buildSyncStatus(req, includeSecret = false) {
  const store = storage();
  const manifest = store.syncManifest();
  const meta = readSyncMeta();
  const token = syncToken();
  const urls = syncServerUrls(req);
  const st = status();
  return {
    ok: true,
    storeId: manifest.storeId,
    revision: manifest.revision,
    tailscaleEnabled: tailscaleAllowed() || tailscaleHosts().length > 0,
    tailscaleHosts: tailscaleHosts(),
    urls,
    ...(includeSecret ? {
      token,
      pairingUris: urls.map(u => `apexvelo://sync?url=${encodeURIComponent(u)}&token=${encodeURIComponent(token)}`)
    } : {}),
    lastSyncAt: meta.lastSyncAt || null,
    lastClient: meta.lastClient || null,
    ridesCount: manifest.rides.length,
    wellnessDaysCount: manifest.wellness.length,
    ai: { configured: st.configured, provider: st.provider, providers: st.providers }
  };
}

async function handleSync(req, res, urlPath) {
  const pc = isPcRequest(req);
  const paired = isPairedSyncClient(req);
  if (urlPath === '/api/sync/events') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
    if (!pc) return sendJson(res, 403, { error: 'Forbidden' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff'
    });
    res.write(': connected\n\n');
    syncSseClients.add(res);
    const keepalive = setInterval(() => {
      if (res.writableEnded) { clearInterval(keepalive); syncSseClients.delete(res); return; }
      try { res.write(': ping\n\n'); } catch { clearInterval(keepalive); syncSseClients.delete(res); }
    }, 25000);
    if (keepalive.unref) keepalive.unref();
    req.on('close', () => { clearInterval(keepalive); syncSseClients.delete(res); });
    return;
  }
  if (urlPath === '/api/sync/token') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    if (!pc) return sendJson(res, 403, { error: 'Forbidden' });
    syncToken(true);
    return sendJson(res, 200, buildSyncStatus(req, true));
  }
  if (urlPath === '/api/sync/status') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
    if (!pc && !paired) return sendJson(res, 401, { error: 'Sync token required.' });
    return sendJson(res, 200, buildSyncStatus(req, pc));
  }
  if (urlPath === '/api/sync/ping') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
    if (!pc && !paired) return sendJson(res, 401, { error: 'Sync token required.' });
    const store = storage();
    const st = status();
    return sendJson(res, 200, {
      ok: true,
      storeId: store.meta('storeId'),
      revision: store.revision,
      serverTime: Date.now(),
      ai: { configured: st.configured, provider: st.provider, providers: st.providers }
    });
  }
  if (!paired) return sendJson(res, 401, { error: 'Invalid or missing sync token.' });
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'Content-Type must be application/json.' });

  if (urlPath === '/api/sync/manifest') {
    let input;
    try { input = JSON.parse(await readBody(req, 16 * 1024 * 1024)); } catch (e) { return sendJson(res, e.status || 400, { error: e.status ? e.message : 'Invalid JSON.' }); }
    const { VeloSync } = syncDeps();
    const store = storage();
    const serverManifest = store.syncManifest();
    const delta = VeloSync.planDelta(input || {}, serverManifest);
    return sendJson(res, 200, {
      ok: true,
      storeId: serverManifest.storeId,
      revision: serverManifest.revision,
      serverTime: Date.now(),
      wantRideIds: delta.pushRideIds,
      wantSettingKeys: delta.pushSettingKeys,
      wantWellnessKeys: delta.pushWellnessKeys,
      tombstones: serverManifest.tombstones
    });
  }
  if (urlPath === '/api/sync/push') {
    let input;
    try { input = JSON.parse(await readBody(req, 200 * 1024 * 1024)); } catch (e) { return sendJson(res, e.status || 400, { error: e.status ? e.message : 'Invalid JSON.' }); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return sendJson(res, 400, { error: 'Invalid sync payload.' });
    const { VeloSync, VeloDedupe, VeloHealth } = syncDeps();
    const now = Date.now();
    const store = storage();
    const serverManifest = store.syncManifest();
    const serverRides = store.ridesByIds(serverManifest.rides.map(r => r.id));
    const serverSettings = store.settingsWithMeta();
    const serverWellness = store.listWellnessDays();
    const allTombs = [...serverManifest.tombstones, ...(Array.isArray(input.tombstones) ? input.tombstones : [])];

    const mergedRides = VeloSync.mergeRides(serverRides, Array.isArray(input.rides) ? input.rides : [], allTombs, VeloDedupe, now);
    const mergedWellness = VeloSync.mergeWellnessRows(serverWellness, Array.isArray(input.wellness) ? input.wellness : [], mergedRides.tombstones);
    const mergedSettings = VeloSync.mergeSettings(serverSettings, input.settings && typeof input.settings === 'object' ? input.settings : {}, mergedWellness.tombstones);
    if (mergedWellness.rows.length) {
      const rebuiltJson = JSON.stringify(VeloSync.buildHealthStore(mergedWellness.rows, {}, VeloHealth));
      const prevHealth = mergedSettings.settings.apex_health_v1;
      const maxWellAt = mergedWellness.rows.reduce((m, r) => Math.max(m, Number(r.updatedAt) || 0), 0);
      mergedSettings.settings.apex_health_v1 = {
        value: rebuiltJson,
        updatedAt: prevHealth && prevHealth.value === rebuiltJson
          ? Math.max(prevHealth.updatedAt || 0, maxWellAt)
          : Math.max(maxWellAt, prevHealth?.updatedAt || 0, now)
      };
    }

    const keepRideIds = new Set(mergedRides.rides.map(r => String(r.ride.id)));
    const delRideIds = serverManifest.rides.map(r => String(r.id)).filter(id => !keepRideIds.has(id));
    const delSettingKeys = Object.keys(serverSettings).filter(k => !mergedSettings.settings[k]);
    const finalTombs = [...mergedRides.tombstones, ...mergedWellness.tombstones, ...mergedSettings.tombstones];

    const batch = store.applySyncBatch({
      putRides: mergedRides.rides,
      delRideIds,
      putSettings: mergedSettings.settings,
      delSettingKeys,
      putWellness: mergedWellness.rows,
      tombstones: finalTombs,
      now
    });

    const afterManifest = store.syncManifest();
    const haveRides = input.haveRideHashes && typeof input.haveRideHashes === 'object' ? input.haveRideHashes : {};
    const haveWellness = input.haveWellnessHashes && typeof input.haveWellnessHashes === 'object' ? input.haveWellnessHashes : {};
    const sendRideIds = afterManifest.rides.filter(r => haveRides[r.id] !== r.contentHash).map(r => r.id);
    const sendWellnessKeys = afterManifest.wellness.filter(w => haveWellness[`${w.day}|${w.source}`] !== w.hash).map(w => ({ day: w.day, source: w.source }));

    writeSyncMeta({ lastSyncAt: new Date(now).toISOString(), lastClient: String(input.clientName || input.clientId || 'Android').slice(0, 80) });
    if (batch.changed) broadcastSyncEvent({ revision: batch.revision, storeId: batch.storeId, at: now });

    return sendJson(res, 200, {
      ok: true,
      changed: batch.changed,
      revision: batch.revision,
      storeId: batch.storeId,
      serverTime: now,
      rides: store.ridesByIds(sendRideIds),
      settings: store.settingsWithMeta(),
      wellness: store.wellnessByKeys(sendWellnessKeys),
      tombstones: afterManifest.tombstones
    });
  }
  return sendJson(res, 404, { error: 'Not found' });
}

// ------------------------------------------------------------------ server --
function createServer() {
  return http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    if (!isAllowedClient(req)) return send(res, 403, 'Forbidden');
    if (urlPath === '/api/local-history') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      if (!isPcRequest(req)) return sendJson(res, 403, { error: 'Local archives can only be read on this computer.' });
      // Preserve old installations; never evaluate private JavaScript as server code.
      const names = ['local-history.json', 'divan_cycling_history.json', 'local-history.js', 'divan_cycling_history.js'];
      const file = names.map(n => path.join(ROOT, 'data', n)).find(f => fs.existsSync(f));
      if (!file) return sendJson(res, 200, null);
      try {
        let raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
        if (file.endsWith('.js')) raw = raw.replace(/^(?:window\.)?(?:APEX_LOCAL_HISTORY|DIVAN_HEALTHFIT_DATA)\s*=\s*/, '').replace(/;\s*$/, '');
        const data = JSON.parse(raw);
        if (!data || !Array.isArray(data.rides)) throw new Error('Invalid archive');
        return sendJson(res, 200, data);
      } catch (e) { return sendJson(res, 500, { error: 'Could not read the local archive. The file has been left untouched.' }); }
    }
    if (urlPath === '/api/backup') {
      return handleBackup(req, res).catch((e) => { if (!res.headersSent) sendJson(res, 500, { error: e.message }); });
    }
    if (urlPath === '/api/storage' || urlPath.startsWith('/api/storage/')) return handleStorage(req, res, urlPath);
    if (urlPath === '/api/health' || urlPath.startsWith('/api/health/')) {
      const query = new URL(req.url, 'http://localhost').searchParams;
      return handleHealth(req, res, urlPath, query).catch((e) => { if (!res.headersSent) sendJson(res, 500, { error: e.message }); });
    }
    if (urlPath === '/api/live' || urlPath === '/api/live/cmd' || urlPath === '/api/live/cmds' || urlPath === '/api/live/fit' || urlPath === '/api/live/card') {
      return handleLive(req, res, urlPath).catch((e) => { if (!res.headersSent) sendJson(res, 500, { error: e.message }); });
    }
    if (urlPath.startsWith('/api/sync/')) {
      return handleSync(req, res, urlPath).catch((e) => { if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message }); });
    }
    if (urlPath === '/api/coach/status') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      if (!isPcRequest(req) && !isPairedSyncClient(req)) return sendJson(res, 403, { error: 'Forbidden' });
      const q = new URL(req.url, 'http://localhost').searchParams;
      return refreshModelCatalog(q.get('refresh') === '1').then(() => sendJson(res, 200, status()), () => sendJson(res, 200, status()));
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
    if (urlPath.startsWith('/api/hevy/')) {
      const query = new URL(req.url, 'http://localhost').searchParams;
      return handleHevy(req, res, urlPath, query).catch((e) => { if (!res.headersSent) sendJson(res, 500, { error: e.message }); });
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
  if (major < 24) { console.error(`Node 24 or newer is required. On Windows, use Launch-Apex-Velo.bat for automatic setup (found ${process.versions.node}).`); process.exit(1); }
  const server = createServer();
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use - is Apex Velo Lab already running? Set APEX_PORT in .env to change it.` : e.message);
    process.exit(1);
  });
  server.listen(PORT, '0.0.0.0', () => {
    const url = `http://localhost:${PORT}/`;
    console.log(`Apex Velo Lab running at ${url}`);
    try { console.log(`Saved data: ${storage().file}`); }
    catch (e) { console.error(`Storage unavailable: ${e.message}. Existing data has not been reset.`); }
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
        console.log(`Phone view (same Wi-Fi as this PC): pair the phone from the app's Settings > Phone view (${lanIps.map(ip => `http://${ip}:${PORT}/live.html`).join(', ')}).`);
      }
    } catch { /* ignore - LAN IP display is best-effort */ }
    const keySrc = (fromEnv, name) => (fromEnv ? `the ${name} environment variable` : '.env');
    console.log(API_KEY ? `AI Coach - Claude: ready, key from ${keySrc(KEY_FROM_ENVIRONMENT, 'ANTHROPIC_API_KEY')}` : 'AI Coach - Claude: no ANTHROPIC_API_KEY in .env');
    console.log(GEMINI_API_KEY ? `AI Coach - Gemini: ready, key from ${keySrc(GEMINI_KEY_FROM_ENVIRONMENT, 'GEMINI_API_KEY')}` : 'AI Coach - Gemini: no GEMINI_API_KEY in .env');
    console.log(OPENAI_API_KEY ? `AI Coach - ChatGPT: ready, key from ${keySrc(OPENAI_KEY_FROM_ENVIRONMENT, 'OPENAI_API_KEY')}` : 'AI Coach - ChatGPT: no OPENAI_API_KEY in .env');
    if (HEVY_API_KEY) console.log(`Hevy: ready, key from ${keySrc(HEVY_KEY_FROM_ENVIRONMENT, 'HEVY_API_KEY')}`);
    refreshModelCatalog(true).then(() => {
      for (const [p, c] of Object.entries(CATALOG)) if (c.source === 'live') console.log(`AI models - ${PROVIDERS[p].label}: ${c.count} models from the API`);
    });
    console.log(KEYS[DEFAULT_PROVIDER]
      ? `AI Coach default: ${MODELS[DEFAULT_MODEL].label}, ${DEFAULT_EFFORT} effort (switch provider in the app's AI engine card)`
      : 'AI Coach: no API key for the default provider - the offline engine is used until you add one.');
    console.log('Press Ctrl+C to stop.');
    if (process.argv.includes('--open') && !process.env.APEX_NO_BROWSER) {
      const { spawn } = require('child_process');
      let cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      if (process.platform === 'win32') {
        // Preserve the Windows launcher's Web Bluetooth browser preference.
        const bases = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
        const candidates = [...bases.map(b => path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe')),
          ...bases.map(b => path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))];
        const browser = candidates.find(f => fs.existsSync(f)); if (browser) cmd = [browser, [url]];
      }
      try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch (e) { /* open it manually */ }
    }
  });
}

module.exports = { createServer, buildClaudeRequest, buildGeminiRequest, buildClaudeAskRequest, buildGeminiAskRequest, buildOpenAiCoachRequest, buildOpenAiAskRequest, prettyOpenAiName, openAiChat, refreshModelCatalog, validateAsk, ASK_SYSTEM_PROMPT, loadDotEnv, slimActivity, slimHevyWorkout, MODELS, PROVIDERS };
