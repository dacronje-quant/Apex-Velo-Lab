/**
 * The AI engine for the Android app: the routes server.js serves under /api/coach and /api/ask, answered on the phone.
 *
 * The desktop app keeps the API keys in .env and lets server.js call Claude, Gemini or ChatGPT. The app has no
 * server, so the rider's own keys are kept in Android app storage (Capacitor Preferences, never in the
 * WebView's localStorage or in exports) and the providers are called from the phone through native HTTP
 * (no CORS, no key in the page). The prompts, request bodies and reply shapes match server.js exactly
 * (tests/native-ai.test.mjs compares them with server.js's own builders), so js/velo-ai-coach.js,
 * js/app-coach.js, js/app-ask.js, js/app-insight.js and js/velo-block-planner.js run unchanged.
 */

export const API_BASES = {
  claude: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  openai: 'https://api.openai.com'
};
const KEYS_PREF = 'ai_keys';
const UPSTREAM_TIMEOUT_MS = 180000;
const LIST_TIMEOUT_MS = 10000;
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// ------------------------------------------------------- kept identical to server.js --
export const SYSTEM_PROMPT = 'You are the Apex Velo Lab sport scientist: an elite cycling coach and exercise physiologist with deep knowledge of training methodology and periodisation. ' +
  'You prescribe structured indoor ERG sessions and training blocks from the rider\'s real training data. ' +
  'Work like a sport scientist: first identify what limits this rider for the goal (needs analysis), then choose the session or block from the SPORT-SCIENCE EVIDENCE BRIEF in the request, ' +
  'giving meta-analyses and randomised trials in cyclists more weight than single studies or habit, then set an exact dose (intensity, interval and rest length, time in zone, frequency, progression), ' +
  'and finally check safety: hard days at least 48 hours apart, less intensity when fatigue or recovery readings are poor, gradual load increases, and a plan that fits the time available. ' +
  'People respond differently to the same training, so the rider\'s own data outranks population averages when they disagree. ' +
  'Never invent data, studies or citations: cite only references listed in the request. ' +
  'Use the requested response format (JSON when requested, otherwise plain text or markdown). ' +
  'Explain things to a beginner in short, everyday sentences. Lead with what to do and why it helps. ' +
  'Avoid sports-science jargon and acronyms in advice: say fitness base, recent training strain, and freshness instead of CTL, ATL, and TSB. ' +
  'If a technical term is essential, explain it immediately in plain words. Use numbers only when needed to act, such as ride duration or a power target; ' +
  'do not repeat training scores, percentages, or tables of statistics in prose. Keep numeric workout fields and schema keys exact. ' +
  'Treat calculated scores as estimates, not proof of illness, overtraining, or full recovery. Be respectful and concise.';

export const ASK_SYSTEM_PROMPT = 'You are the rider\'s personal cycling data analyst inside the Apex Velo Lab app. ' +
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

/** Built-in model list, replaced per provider by its live list once a key is saved. */
export const BUILTIN_MODELS = {
  'claude-opus-5-5':           { label: 'Claude Opus 5.5', provider: 'claude', adaptive: true },
  'claude-sonnet-5-5':         { label: 'Claude Sonnet 5.5', provider: 'claude', adaptive: true },
  'claude-haiku-4-5-20251001': { label: 'Claude Haiku 4.5', provider: 'claude', adaptive: false },
  'gemini-3.8-flash':          { label: 'Gemini 3.8 Flash', provider: 'gemini', adaptive: true },
  'gemini-3.1-pro-preview':    { label: 'Gemini 3.1 Pro (preview)', provider: 'gemini', adaptive: true },
  'gemini-3.1-flash-lite':     { label: 'Gemini 3.1 Flash-Lite', provider: 'gemini', adaptive: true },
  'gpt-6.1-sol':               { label: 'GPT-6.1 Sol', provider: 'openai', adaptive: true }
};
export const PROVIDERS = {
  claude: { label: 'Claude', keyName: 'Anthropic API key', fallbackModel: 'claude-opus-5-5' },
  gemini: { label: 'Gemini', keyName: 'Gemini API key', fallbackModel: 'gemini-3.8-flash' },
  openai: { label: 'ChatGPT', keyName: 'OpenAI API key', fallbackModel: 'gpt-6.1-sol' }
};
const EFFORTS = ['low', 'medium', 'high'];
const DEFAULT_EFFORT = 'low';

export function prettyOpenAiName(id) {
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
export const openAiChat = (id) => /^(gpt-[4-9]|o[1-9]|chatgpt-)/.test(id) && !/^gpt-4(-|$)/.test(id) &&
  !/(audio|realtime|tts|transcribe|search|image|embed|moderation|instruct|codex|computer-use|deep-research|oss|-\d{4}-\d{2}-\d{2}$|-\d{4}$)/.test(id);
const openAiReasoning = (id) => /^(o[1-9]|gpt-[5-9])/.test(id) && !/chat/.test(id);

const GEMINI_BUDGETS = { low: 1024, medium: 8192, high: 24576 };
const geminiThinking = (model, effort) => /^gemini-2\./.test(model || '')
  ? { thinkingBudget: GEMINI_BUDGETS[effort] || 1024, includeThoughts: true }
  : { thinkingLevel: effort, includeThoughts: true };

/** The request bodies, as pure functions of the model list, so the test can compare them with server.js. */
export function builders(MODELS) {
  const claudeThinking = (body, model, effort) => {
    if (MODELS[model].adaptive) {
      body.thinking = { type: 'adaptive', display: 'summarized' };
      body.output_config = { effort };
    } else {
      body.thinking = { type: 'enabled', budget_tokens: 4000 };
    }
    return body;
  };
  const buildOpenAiRequest = (instructions, input, model, effort, summary = true) => {
    const body = { model, instructions, input, max_output_tokens: 16000, store: false };
    if (MODELS[model] && MODELS[model].adaptive) body.reasoning = summary ? { effort, summary: 'auto' } : { effort };
    return body;
  };
  const data = (context) => `TRAINING DATA\n${context || '(no data for this period)'}`;
  return {
    buildClaudeRequest: (prompt, model, effort) => claudeThinking({ model, max_tokens: 16000, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: prompt }] }, model, effort),
    buildGeminiRequest: (prompt, model, effort) => ({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 16000, responseMimeType: 'application/json', thinkingConfig: geminiThinking(model, effort) }
    }),
    buildClaudeAskRequest: (messages, context, model, effort, fallback = true) => {
      const body = {
        model,
        max_tokens: 16000,
        system: [{ type: 'text', text: ASK_SYSTEM_PROMPT }, { type: 'text', text: data(context), cache_control: { type: 'ephemeral' } }],
        messages: messages.map(m => ({ role: m.role, content: m.content }))
      };
      claudeThinking(body, model, effort);
      if (fallback && model === 'claude-opus-5-5') body.fallbacks = 'default';
      return body;
    },
    buildGeminiAskRequest: (messages, context, effort, model) => ({
      systemInstruction: { parts: [{ text: ASK_SYSTEM_PROMPT }, { text: data(context) }] },
      contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: 16000, thinkingConfig: geminiThinking(model, effort) }
    }),
    buildOpenAiCoachRequest: (prompt, model, effort) => buildOpenAiRequest(SYSTEM_PROMPT, [{ role: 'user', content: prompt }], model, effort),
    buildOpenAiAskRequest: (messages, context, model, effort) => buildOpenAiRequest(`${ASK_SYSTEM_PROMPT}\n\n${data(context)}`,
      messages.map(m => ({ role: m.role, content: m.content })), model, effort)
  };
}

/** Same checks as server.js validateAsk: { messages, context } or { error }. */
export function validateAsk(input) {
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

// ------------------------------------------------------------------ reply parsing --
const errMsg = (data, status) => (data && data.error && data.error.message) || `HTTP ${status}`;

export function parseClaude(status, data, model) {
  if (status < 200 || status >= 300) return { error: `Claude API error ${status}: ${errMsg(data, status)}`, upstreamStatus: status, log: `${status} ${errMsg(data, status)}` };
  const blocks = Array.isArray(data && data.content) ? data.content : [];
  const usage = (data && data.usage) || {};
  return {
    text: blocks.filter(b => b.type === 'text').map(b => b.text).join(''),
    thinking: blocks.filter(b => b.type === 'thinking' && b.thinking).map(b => b.thinking).join('\n\n'),
    model: data.model || model,
    stopReason: data.stop_reason,
    usage: { input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0, cache_read_input_tokens: usage.cache_read_input_tokens || 0 }
  };
}

export function parseGemini(status, data, model) {
  if (status < 200 || status >= 300) return { error: `Gemini API error ${status}: ${errMsg(data, status)}`, upstreamStatus: status, log: `${status} ${errMsg(data, status)}` };
  const cand = Array.isArray(data && data.candidates) && data.candidates[0];
  if (!cand) {
    const why = (data && data.promptFeedback && data.promptFeedback.blockReason) || 'no answer';
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

export function parseOpenAi(status, data, model) {
  if (status < 200 || status >= 300) return { error: `OpenAI API error ${status}: ${errMsg(data, status)}`, upstreamStatus: status, log: `${status} ${errMsg(data, status)}` };
  const items = Array.isArray(data && data.output) ? data.output : [];
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
    model: data.model || model,
    stopReason: refusal && !text ? 'refusal' : incomplete === 'max_output_tokens' ? 'max_tokens' : (incomplete || 'end_turn'),
    usage: { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0, cache_read_input_tokens: (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0 }
  };
}

const reply = (status, body) => ({ status, body });
const abortError = (signal) => (signal && signal.reason instanceof Error) ? signal.reason : Object.assign(new Error('The request was cancelled.'), { name: 'AbortError' });

/** Resolves with the request, or rejects as soon as `signal` aborts (native HTTP itself cannot be cancelled). */
function raceSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

/**
 * http.request({ url, method, headers, data, readTimeout, connectTimeout }) -> { status, headers, data } (CapacitorHttp).
 * prefs: { get(key) -> string|null, set(key, value), remove(key) }.
 */
export class NativeAi {
  constructor({ http, prefs, bases = API_BASES, now = () => Date.now() }) {
    Object.assign(this, { http, prefs, bases, now });
    this.MODELS = Object.fromEntries(Object.entries(BUILTIN_MODELS).map(([id, m]) => [id, { ...m }]));
    this.catalog = { claude: { source: 'built-in' }, gemini: { source: 'built-in' }, openai: { source: 'built-in' } };
    this.catalogAt = 0;
    this._refresh = null;
    this.build = builders(this.MODELS);
  }

  // ------------------------------------------------------------------------ keys --
  async keys() {
    let k = null;
    try { k = JSON.parse((await this.prefs.get(KEYS_PREF)) || 'null'); } catch (e) { /* unreadable: no keys */ }
    const out = {};
    for (const p of Object.keys(PROVIDERS)) out[p] = k && typeof k[p] === 'string' ? k[p] : '';
    return out;
  }

  /** Saves (or with an empty value removes) one provider's key. Throws a readable message when it cannot be a key. */
  async setKey(provider, value) {
    if (!PROVIDERS[provider]) throw new Error('Unknown AI provider.');
    const key = String(value || '').trim();
    if (key && (key.length < 20 || /\s/.test(key))) throw new Error(`That does not look like a valid ${PROVIDERS[provider].keyName}: paste the whole key, without spaces.`);
    if (key && provider === 'claude' && !/^sk-ant-/.test(key)) throw new Error('An Anthropic API key starts with sk-ant-. Create one at platform.claude.com/settings/keys.');
    const all = await this.keys();
    all[provider] = key;
    await this.prefs.set(KEYS_PREF, JSON.stringify(all));
    // The live model list belongs to the key: re-read it next time.
    this.catalogAt = 0;
    this._resetProvider(provider);
  }

  _resetProvider(provider) {
    for (const id of Object.keys(this.MODELS)) if (this.MODELS[id].provider === provider) delete this.MODELS[id];
    for (const [id, m] of Object.entries(BUILTIN_MODELS)) if (m.provider === provider) this.MODELS[id] = { ...m };
    this.catalog[provider] = { source: 'built-in' };
  }

  defaultProvider(keys) { return keys.claude ? 'claude' : keys.gemini ? 'gemini' : keys.openai ? 'openai' : 'claude'; }

  // ---------------------------------------------------------------------- transport --
  async _request(opts, signal) {
    const r = await raceSignal(this.http.request({ readTimeout: UPSTREAM_TIMEOUT_MS, connectTimeout: 30000, ...opts }), signal);
    let data = r.data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = { error: { message: data.slice(0, 300) } }; } }
    return { status: r.status, data: data || {} };
  }

  _post(url, headers, body, signal) {
    return this._request({ url, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, data: body }, signal);
  }

  async callClaude(body, key, signal) {
    const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    if (body.fallbacks) headers['anthropic-beta'] = FALLBACK_BETA;
    const r = await this._post(`${this.bases.claude}/v1/messages`, headers, body, signal);
    return parseClaude(r.status, r.data, body.model);
  }

  async callGemini(body, model, key, signal) {
    const r = await this._post(`${this.bases.gemini}/v1beta/models/${encodeURIComponent(model)}:generateContent`, { 'x-goog-api-key': key }, body, signal);
    return parseGemini(r.status, r.data, model);
  }

  /** Retries once without the reasoning summary if the account cannot use it (as server.js does). */
  async callOpenAi(body, key, signal) {
    const post = (b) => this._post(`${this.bases.openai}/v1/responses`, { Authorization: `Bearer ${key}` }, b, signal);
    let r = await post(body);
    if (r.status === 400 && body.reasoning && body.reasoning.summary && /summar|verif/i.test(errMsg(r.data, 400))) {
      body = { ...body, reasoning: { effort: body.reasoning.effort } };
      r = await post(body);
    }
    return parseOpenAi(r.status, r.data, body.model);
  }

  // ------------------------------------------------------------------------ catalog --
  async _listModels(provider, key) {
    const get = (url, headers) => this._request({ url, method: 'GET', headers, readTimeout: LIST_TIMEOUT_MS, connectTimeout: LIST_TIMEOUT_MS });
    const check = (r) => { if (r.status < 200 || r.status >= 300) throw new Error(errMsg(r.data, r.status)); return r.data; };
    if (provider === 'claude') {
      const d = check(await get(`${this.bases.claude}/v1/models?limit=1000`, { 'x-api-key': key, 'anthropic-version': '2023-06-01' }));
      return (d.data || []).filter(m => claudeChat(m.id)).map(m => ({ id: m.id, label: m.display_name || m.id, adaptive: claudeAdaptive(m.id) }));
    }
    if (provider === 'gemini') {
      const d = check(await get(`${this.bases.gemini}/v1beta/models?pageSize=1000`, { 'x-goog-api-key': key }));
      return (d.models || []).map(m => ({ ...m, id: String(m.name || '').replace(/^models\//, '') }))
        .filter(m => geminiChat(m.id, m.supportedGenerationMethods))
        .map(m => ({ id: m.id, label: m.displayName || m.id, adaptive: true }))
        .sort((a, b) => b.id.localeCompare(a.id, 'en', { numeric: true }));
    }
    const d = check(await get(`${this.bases.openai}/v1/models`, { Authorization: `Bearer ${key}` }));
    return (d.data || []).filter(m => openAiChat(m.id)).sort((a, b) => (b.created || 0) - (a.created || 0))
      .map(m => ({ id: m.id, label: (BUILTIN_MODELS[m.id] && BUILTIN_MODELS[m.id].label) || prettyOpenAiName(m.id), adaptive: openAiReasoning(m.id) }));
  }

  /** Re-reads the model list of every provider that has a key; one that fails keeps its list and reports why. */
  refreshCatalog(force = false) {
    if (!force && this.now() - this.catalogAt < CATALOG_TTL_MS) return Promise.resolve();
    if (this._refresh) return this._refresh;
    this._refresh = (async () => {
      const keys = await this.keys();
      await Promise.all(Object.keys(PROVIDERS).filter(p => keys[p]).map(async (provider) => {
        try {
          const list = await this._listModels(provider, keys[provider]);
          if (!list.length) throw new Error('no chat models returned');
          const fallback = PROVIDERS[provider].fallbackModel;
          const keep = !list.some(x => x.id === fallback) && this.MODELS[fallback] ? { [fallback]: this.MODELS[fallback] } : {};
          for (const id of Object.keys(this.MODELS)) if (this.MODELS[id].provider === provider) delete this.MODELS[id];
          for (const m of list) this.MODELS[m.id] = { label: m.label, provider, adaptive: m.adaptive };
          Object.assign(this.MODELS, keep);
          this.catalog[provider] = { source: 'live', count: list.length, at: new Date(this.now()).toISOString() };
        } catch (e) {
          this.catalog[provider] = { source: 'built-in', error: (e && e.message) || String(e) };
        }
      }));
      this.catalogAt = this.now();
    })().finally(() => { this._refresh = null; });
    return this._refresh;
  }

  // ------------------------------------------------------------------------- routes --
  async status(refresh = false) {
    // A refresh ("Re-check keys") waits for the lists; otherwise answer at once and update in the background,
    // so the app's quick start-up check never waits on the phone's network.
    if (refresh) await this.refreshCatalog(true);
    else this.refreshCatalog(false).catch(() => {});
    const keys = await this.keys();
    const provider = this.defaultProvider(keys);
    const providers = {};
    for (const [id, p] of Object.entries(PROVIDERS)) providers[id] = { label: p.label, configured: !!keys[id], model: p.fallbackModel };
    return {
      provider,
      providers,
      configured: !!keys[provider],
      model: PROVIDERS[provider].fallbackModel,
      effort: DEFAULT_EFFORT,
      models: Object.entries(this.MODELS).map(([id, m]) => ({ id, label: m.label, provider: m.provider, effort: m.adaptive })),
      efforts: EFFORTS,
      catalog: this.catalog,
      onDevice: true
    };
  }

  /** Same rule as server.js resolveEngine: the model decides the provider. */
  _engine(input, keys) {
    const MODELS = this.MODELS;
    const provider = MODELS[input.model] ? MODELS[input.model].provider : (PROVIDERS[input.provider] ? input.provider : this.defaultProvider(keys));
    const model = MODELS[input.model] ? input.model : PROVIDERS[provider].fallbackModel;
    if (!MODELS[model]) MODELS[model] = { ...BUILTIN_MODELS[model] };
    const effort = EFFORTS.includes(input.effort) ? input.effort : DEFAULT_EFFORT;
    return { provider, model, effort, p: PROVIDERS[provider], key: keys[provider] };
  }

  _noKey(p) { return reply(503, { error: `No ${p.label} API key. Add your ${p.keyName} in You > Connections > AI coach.` }); }

  _failed(err, p) {
    const aborted = err && err.name === 'AbortError';
    if (aborted) throw err; // the app cancelled (Stop / timeout): let its fetch reject like a real one
    const msg = (err && err.message) || String(err);
    if (/timed? ?out|timeout/i.test(msg)) return reply(504, { error: `${p.label} did not answer in time.` });
    return reply(502, { error: `Could not reach the ${p.label} API (${msg}). Check your internet connection.` });
  }

  async coach(input, signal) {
    const prompt = typeof input.prompt === 'string' ? input.prompt : '';
    if (!prompt.trim() || prompt.length > 100000) return reply(400, { error: 'A prompt of 1-100000 characters is required.' });
    const { provider, model, effort, p, key } = this._engine(input, await this.keys());
    if (!key) return this._noKey(p);
    let out;
    try {
      out = provider === 'gemini' ? await this.callGemini(this.build.buildGeminiRequest(prompt, model, effort), model, key, signal)
        : provider === 'openai' ? await this.callOpenAi(this.build.buildOpenAiCoachRequest(prompt, model, effort), key, signal)
          : await this.callClaude(this.build.buildClaudeRequest(prompt, model, effort), key, signal);
    } catch (e) { return this._failed(e, p); }
    if (out.error) return reply(502, { error: out.error, upstreamStatus: out.upstreamStatus });
    const shownEffort = this.MODELS[model].adaptive ? effort : null;
    return reply(200, { text: out.text, thinking: out.thinking, provider, model: out.model, effort: shownEffort, stopReason: out.stopReason, usage: out.usage });
  }

  async ask(input, signal) {
    const v = validateAsk(input);
    if (v.error) return reply(400, { error: v.error });
    const { provider, model, effort, p, key } = this._engine(input, await this.keys());
    if (!key) return this._noKey(p);
    let out;
    try {
      if (provider === 'gemini') out = await this.callGemini(this.build.buildGeminiAskRequest(v.messages, v.context, effort, model), model, key, signal);
      else if (provider === 'openai') out = await this.callOpenAi(this.build.buildOpenAiAskRequest(v.messages, v.context, model, effort), key, signal);
      else {
        out = await this.callClaude(this.build.buildClaudeAskRequest(v.messages, v.context, model, effort), key, signal);
        // An account that does not accept the fallback option gets the same question without it.
        if (out.error && out.upstreamStatus === 400 && /fallback/i.test(out.log || '')) out = await this.callClaude(this.build.buildClaudeAskRequest(v.messages, v.context, model, effort, false), key, signal);
      }
    } catch (e) { return this._failed(e, p); }
    if (out.error) return reply(502, { error: out.error, upstreamStatus: out.upstreamStatus });
    const refused = out.stopReason === 'refusal' && !out.text.trim();
    const text = refused ? 'I can\'t answer that one. Try asking it another way, or about a specific part of your training.' : out.text;
    return reply(200, { text, refused, provider, model: out.model, effort: this.MODELS[model].adaptive ? effort : null, stopReason: out.stopReason, usage: out.usage });
  }

  /** Answers one AI request: { status, body } or null when the path is not an AI route. Rejects when `signal` aborts. */
  async route(pathname, method, query, bodyText, signal) {
    if (pathname === '/api/coach/status') {
      if (method !== 'GET') return reply(405, { error: 'Method not allowed' });
      return reply(200, await raceSignal(this.status(query.get('refresh') === '1'), signal));
    }
    if (pathname !== '/api/coach' && pathname !== '/api/ask') return null;
    if (method !== 'POST') return reply(405, { error: 'Method not allowed' });
    let input;
    try { input = JSON.parse(bodyText || '{}'); } catch (e) { return reply(400, { error: 'Invalid JSON.' }); }
    if (!input || typeof input !== 'object') return reply(400, { error: 'Invalid JSON.' });
    return pathname === '/api/ask' ? this.ask(input, signal) : this.coach(input, signal);
  }
}
