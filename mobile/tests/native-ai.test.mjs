// Unit tests for the Android AI engine (mobile/src/native-ai.js): same requests as server.js, keys in prefs, abort.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { NativeAi, builders, BUILTIN_MODELS, validateAsk, prettyOpenAiName, openAiChat, ASK_SYSTEM_PROMPT } from '../src/native-ai.js';

const require = createRequire(import.meta.url);
const server = require('../../server.js');

const KEY = 'sk-ant-api03-' + 'x'.repeat(40);
const memPrefs = () => { const m = new Map(); return { m, get: async (k) => (m.has(k) ? m.get(k) : null), set: async (k, v) => { m.set(k, v); }, remove: async (k) => { m.delete(k); } }; };

/** Scripted CapacitorHttp: handler(opts) -> { status, data }; every request is logged. */
function fakeHttp(handler) {
  const log = [];
  return { log, async request(opts) { log.push(opts); const r = await handler(opts); return { headers: {}, ...r }; } };
}
const claudeOk = (text, extra = {}) => ({ status: 200, data: { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 }, ...extra } });

test('request bodies are identical to server.js for every provider and model', () => {
  const b = builders(Object.fromEntries(Object.entries(BUILTIN_MODELS).map(([id, m]) => [id, { ...m }])));
  const messages = [{ role: 'user', content: 'How was my week?' }, { role: 'assistant', content: 'Good.' }, { role: 'user', content: 'And sleep?' }];
  for (const model of Object.keys(BUILTIN_MODELS)) {
    for (const effort of ['low', 'high']) {
      assert.deepEqual(b.buildClaudeRequest('PROMPT', model, effort), server.buildClaudeRequest('PROMPT', model, effort), `coach claude ${model}`);
      assert.deepEqual(b.buildGeminiRequest('PROMPT', model, effort), server.buildGeminiRequest('PROMPT', model, effort), `coach gemini ${model}`);
      assert.deepEqual(b.buildOpenAiCoachRequest('PROMPT', model, effort), server.buildOpenAiCoachRequest('PROMPT', model, effort), `coach openai ${model}`);
      for (const ctx of ['DATA', '']) {
        assert.deepEqual(b.buildClaudeAskRequest(messages, ctx, model, effort), server.buildClaudeAskRequest(messages, ctx, model, effort), `ask claude ${model}`);
        assert.deepEqual(b.buildClaudeAskRequest(messages, ctx, model, effort, false), server.buildClaudeAskRequest(messages, ctx, model, effort, false));
        assert.deepEqual(b.buildGeminiAskRequest(messages, ctx, effort, model), server.buildGeminiAskRequest(messages, ctx, effort, model), `ask gemini ${model}`);
        assert.deepEqual(b.buildOpenAiAskRequest(messages, ctx, model, effort), server.buildOpenAiAskRequest(messages, ctx, model, effort), `ask openai ${model}`);
      }
    }
  }
  assert.equal(ASK_SYSTEM_PROMPT, server.ASK_SYSTEM_PROMPT);
});

test('model list, validation and name helpers match server.js', () => {
  for (const [id, m] of Object.entries(server.MODELS)) assert.deepEqual(BUILTIN_MODELS[id], m, id);
  assert.deepEqual(Object.keys(BUILTIN_MODELS).sort(), Object.keys(server.MODELS).sort());
  for (const id of ['gpt-6.1-sol', 'o4-mini', 'chatgpt-4o-latest', 'gpt-4', 'gpt-5-2025-08-07', 'gpt-6-audio']) {
    assert.equal(openAiChat(id), server.openAiChat(id), id);
    assert.equal(prettyOpenAiName(id), server.prettyOpenAiName(id), id);
  }
  const cases = [
    { messages: [] }, { messages: [{ role: 'assistant', content: 'x' }] }, { messages: [{ role: 'user', content: 'q' }], context: 'c' },
    { messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }] }, { messages: [{ role: 'user', content: 'q' }], context: 'x'.repeat(150001) },
    { messages: [{ role: 'user', content: '  ' }] }, { messages: 'nope' }
  ];
  for (const c of cases) assert.deepEqual(validateAsk(c), server.validateAsk(c));
});

test('keys: stored in prefs only, checked, and reported by status', async () => {
  const prefs = memPrefs();
  const ai = new NativeAi({ http: fakeHttp(() => ({ status: 500, data: {} })), prefs });
  let st = await ai.status();
  assert.equal(st.configured, false);
  assert.equal(st.providers.claude.configured, false);
  await assert.rejects(ai.setKey('claude', 'short'), /paste the whole key/);
  await assert.rejects(ai.setKey('claude', 'AIza' + 'y'.repeat(30)), /starts with sk-ant-/);
  await ai.setKey('claude', `  ${KEY}  `);
  assert.equal(JSON.parse(prefs.m.get('ai_keys')).claude, KEY);
  st = await ai.status();
  assert.equal(st.provider, 'claude');
  assert.equal(st.configured, true);
  assert.equal(st.model, 'claude-opus-5-5');
  assert.ok(st.models.some((m) => m.id === 'claude-haiku-4-5-20251001' && m.effort === false));
  await ai.setKey('claude', '');
  await ai.setKey('gemini', 'AIza' + 'y'.repeat(30));
  st = await ai.status();
  assert.equal(st.provider, 'gemini');
  assert.equal(st.providers.claude.configured, false);
});

test('coach: calls Claude with the key and returns the server reply shape', async () => {
  const http = fakeHttp(() => claudeOk('{"workout":{}}'));
  const ai = new NativeAi({ http, prefs: memPrefs() });
  const none = await ai.route('/api/coach', 'POST', new URLSearchParams(), JSON.stringify({ prompt: 'Build me a session' }));
  assert.equal(none.status, 503);
  assert.match(none.body.error, /Settings > AI engine/);
  assert.equal(http.log.length, 0);

  await ai.setKey('claude', KEY);
  const r = await ai.route('/api/coach', 'POST', new URLSearchParams(), JSON.stringify({ prompt: 'Build me a session', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { text: '{"workout":{}}', thinking: 'hmm', provider: 'claude', model: 'claude-opus-5-5', effort: 'medium', stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 } });
  const call = http.log.at(-1);
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['x-api-key'], KEY);
  assert.equal(call.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(call.data, server.buildClaudeRequest('Build me a session', 'claude-sonnet-5-5', 'medium'));
  assert.equal((await ai.route('/api/coach', 'POST', new URLSearchParams(), '{"prompt":""}')).status, 400);
  assert.equal((await ai.route('/api/coach', 'GET', new URLSearchParams(), '')).status, 405);
  assert.equal(await ai.route('/api/strava/status', 'GET', new URLSearchParams(), ''), null);
});

test('ask: Opus uses the fallback beta, and retries without it when the account refuses', async () => {
  let n = 0;
  const http = fakeHttp((o) => (++n === 1 ? { status: 400, data: { error: { message: 'fallbacks: not enabled for this account' } } } : claudeOk('**12 rides**')));
  const ai = new NativeAi({ http, prefs: memPrefs() });
  await ai.setKey('claude', KEY);
  const body = { messages: [{ role: 'user', content: 'How many rides?' }], context: 'RIDES: 12', model: 'claude-opus-5-5', effort: 'low' };
  const r = await ai.route('/api/ask', 'POST', new URLSearchParams(), JSON.stringify(body));
  assert.equal(r.status, 200);
  assert.equal(r.body.text, '**12 rides**');
  assert.equal(r.body.refused, false);
  assert.equal(http.log[0].headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(http.log[0].data.fallbacks, 'default');
  assert.equal(http.log[1].headers['anthropic-beta'], undefined);
  assert.equal(http.log[1].data.fallbacks, undefined);
  assert.equal(http.log[1].data.system[1].text, 'TRAINING DATA\nRIDES: 12');
});

test('ask: a refusal and API errors come back as the server reports them', async () => {
  let next = { status: 200, data: { model: 'claude-opus-5-5', stop_reason: 'refusal', content: [], usage: {} } };
  const ai = new NativeAi({ http: fakeHttp(() => next), prefs: memPrefs() });
  await ai.setKey('claude', KEY);
  const ask = () => ai.route('/api/ask', 'POST', new URLSearchParams(), JSON.stringify({ messages: [{ role: 'user', content: 'q' }] }));
  let r = await ask();
  assert.equal(r.body.refused, true);
  assert.match(r.body.text, /can't answer that one/);
  next = { status: 401, data: { error: { message: 'invalid x-api-key' } } };
  r = await ask();
  assert.equal(r.status, 502);
  assert.equal(r.body.error, 'Claude API error 401: invalid x-api-key');
  assert.equal(r.body.upstreamStatus, 401);
  ai.http = { request: async () => { throw new Error('Unable to resolve host'); } };
  r = await ask();
  assert.equal(r.status, 502);
  assert.match(r.body.error, /Could not reach the Claude API \(Unable to resolve host\)/);
  assert.equal((await ai.route('/api/ask', 'POST', new URLSearchParams(), JSON.stringify({ messages: [] }))).status, 400);
});

test('Gemini and ChatGPT: right endpoint, key header and parsed reply; OpenAI retries without the summary', async () => {
  const http = fakeHttp((o) => {
    if (o.url.includes('generativelanguage')) return { status: 200, data: { modelVersion: 'gemini-3.8-flash', candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'think' }, { text: 'Gemini says hi' }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, thoughtsTokenCount: 1 } } };
    if (o.data.reasoning && o.data.reasoning.summary) return { status: 400, data: { error: { message: 'Your organization must be verified to generate reasoning summaries' } } };
    return { status: 200, data: { model: 'gpt-6.1-sol', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'GPT says hi' }] }], usage: { input_tokens: 3, output_tokens: 2 } } };
  });
  const ai = new NativeAi({ http, prefs: memPrefs() });
  await ai.setKey('gemini', 'AIza' + 'g'.repeat(30));
  await ai.setKey('openai', 'sk-proj-' + 'o'.repeat(30));
  const q = { messages: [{ role: 'user', content: 'Hi' }], context: '' };
  let r = await ai.route('/api/ask', 'POST', new URLSearchParams(), JSON.stringify({ ...q, model: 'gemini-3.8-flash' }));
  assert.equal(r.body.text, 'Gemini says hi');
  assert.equal(r.body.provider, 'gemini');
  assert.equal(http.log.at(-1).url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(http.log.at(-1).headers['x-goog-api-key'], 'AIza' + 'g'.repeat(30));
  r = await ai.route('/api/coach', 'POST', new URLSearchParams(), JSON.stringify({ prompt: 'p', provider: 'openai' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.text, 'GPT says hi');
  assert.equal(r.body.model, 'gpt-6.1-sol');
  assert.equal(http.log.at(-1).url, 'https://api.openai.com/v1/responses');
  assert.equal(http.log.at(-1).headers.Authorization, 'Bearer sk-proj-' + 'o'.repeat(30));
  assert.deepEqual(http.log.at(-1).data.reasoning, { effort: 'low' });
});

test('the app can cancel a request (Stop, or its own timeout)', async () => {
  const ai = new NativeAi({ http: { request: () => new Promise(() => {}) }, prefs: memPrefs() });
  await ai.setKey('claude', KEY);
  const ac = new AbortController();
  const p = ai.route('/api/ask', 'POST', new URLSearchParams(), JSON.stringify({ messages: [{ role: 'user', content: 'q' }] }), ac.signal);
  setTimeout(() => ac.abort('stop'), 10);
  await assert.rejects(p, (e) => e.name === 'AbortError');
  assert.equal(ac.signal.reason, 'stop');
});

test('Re-check keys reads the live model list; a failing provider keeps the built-in list', async () => {
  const http = fakeHttp((o) => {
    if (o.url.startsWith('https://api.anthropic.com/v1/models')) return { status: 200, data: { data: [{ id: 'claude-opus-5-6', display_name: 'Claude Opus 5.6' }, { id: 'claude-2.1', display_name: 'old' }] } };
    return { status: 403, data: { error: { message: 'API key not valid' } } };
  });
  const ai = new NativeAi({ http, prefs: memPrefs() });
  await ai.setKey('claude', KEY);
  await ai.setKey('gemini', 'AIza' + 'g'.repeat(30));
  const r = await ai.route('/api/coach/status', 'GET', new URLSearchParams('refresh=1'), '');
  const ids = r.body.models.map((m) => m.id);
  assert.ok(ids.includes('claude-opus-5-6'));
  assert.ok(ids.includes('claude-opus-5-5'), 'the default model stays selectable');
  assert.ok(!ids.includes('claude-2.1'));
  assert.ok(!ids.includes('claude-sonnet-5-5'), 'the live list replaces the built-in one');
  assert.ok(ids.includes('gemini-3.8-flash'));
  assert.equal(r.body.catalog.claude.source, 'live');
  assert.deepEqual(r.body.catalog.gemini, { source: 'built-in', error: 'API key not valid' });
  assert.equal(r.body.catalog.openai.source, 'built-in');
  // A coach request with the new live model goes to Claude with that model.
  http.log.length = 0;
  ai.http = fakeHttp(() => claudeOk('ok'));
  const c = await ai.route('/api/coach', 'POST', new URLSearchParams(), JSON.stringify({ prompt: 'p', model: 'claude-opus-5-6' }));
  assert.equal(c.status, 200);
  assert.equal(ai.http.log[0].data.model, 'claude-opus-5-6');
  assert.deepEqual(ai.http.log[0].data.output_config, { effort: 'low' });
});
