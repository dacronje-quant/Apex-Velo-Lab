#!/usr/bin/env node
/**
 * Runs BOTH local servers (server.js and start_server.ps1) against mock Claude and Gemini APIs and checks
 * POST /api/ask: the analyst prompt and the rider's data as a cached system block, the conversation, thinking
 * and effort, the Opus 5.5 refusal fallback (and the retry without it), refusals, plain-text Gemini answers,
 * validation, that only the app may call it - and that both servers send the same requests.
 *
 * Nothing leaves this machine: each server runs from a temporary copy with fake keys pointed at the mocks,
 * so your real .env and API keys are never read or used.
 *
 * Usage:  node tests/ask-servers.test.js            (PowerShell server too if pwsh/powershell is found)
 *         PWSH=/path/to/pwsh node tests/ask-servers.test.js
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ASK_SYSTEM_PROMPT } = require('../server.js');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' - ' + detail : ''}`);
  if (!ok) failures++;
};
const stable = (v) => Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',')}}` : JSON.stringify(v);

// --------------------------------------------------------------- mock AI APIs --
function startMockAi() {
  const log = [];
  const state = { rejectFallback: false };
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch (e) { /* recorded as null */ }
      const u = new URL(req.url, 'http://x');
      log.push({ method: req.method, path: u.pathname, headers: req.headers, body });
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (u.pathname === '/v1/messages') {
        if (body && body.fallbacks && state.rejectFallback) return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'fallbacks: not available for this account' } });
        const last = body && body.messages ? body.messages[body.messages.length - 1] : null;
        if (last && /REFUSE/.test(last.content)) return send(200, { model: body.model, content: [], stop_reason: 'refusal', usage: { input_tokens: 10, output_tokens: 0 } });
        return send(200, {
          model: body.model, stop_reason: 'end_turn',
          content: [{ type: 'thinking', thinking: 'Looking at the weeks.' }, { type: 'text', text: 'Your load rose. **42** TSS more per week.' }],
          usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 1000 }
        });
      }
      const g = u.pathname.match(/^\/v1beta\/models\/([^/:]+):generateContent$/);
      if (g) {
        return send(200, {
          modelVersion: decodeURIComponent(g[1]),
          candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Weighing it up.', thought: true }, { text: 'Gemini says your fitness grew.' }] } }],
          usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 40, thoughtsTokenCount: 20 }
        });
      }
      return send(404, { error: { message: 'not mocked' } });
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, log, state, port: srv.address().port })));
}

// ---------------------------------------------------------------- app servers --
function tempAppDir(kind, mockPort, appPort) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `apex-ask-${kind}-`));
  const file = kind === 'node' ? 'server.js' : 'start_server.ps1';
  fs.copyFileSync(path.join(ROOT, file), path.join(dir, file));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>test</title>');
  fs.writeFileSync(path.join(dir, '.env'), [
    'ANTHROPIC_API_KEY=test-anthropic-key', 'GEMINI_API_KEY=test-gemini-key', 'APEX_COACH_PROVIDER=claude', 'APEX_COACH_EFFORT=low',
    `APEX_ANTHROPIC_BASE_URL=http://127.0.0.1:${mockPort}`, `APEX_GEMINI_BASE_URL=http://127.0.0.1:${mockPort}`, `APEX_PORT=${appPort}`, ''
  ].join('\n'));
  return dir;
}
function findPwsh() {
  const c = [process.env.PWSH, 'pwsh', 'powershell'].filter(Boolean);
  for (const x of c) { const r = spawnSync(x, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }); if (r.status === 0) return x; }
  return null;
}
async function waitUp(port, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://localhost:${port}/api/coach/status`); if (r.ok) return true; } catch (e) { /* not yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}
function launch(kind, dir, pwsh) {
  // The real keys never reach the test servers: they read the fake ones from the temporary .env.
  const env = { ...process.env, APEX_NO_BROWSER: '1' };
  delete env.ANTHROPIC_API_KEY; delete env.GEMINI_API_KEY;
  const p = kind === 'node'
    ? spawn(process.execPath, [path.join(dir, 'server.js')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(pwsh, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'start_server.ps1')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
  p.output = () => out;
  return p;
}

const CONTEXT = 'RIDER\nFTP 204 W, weight 75 kg\nPERIOD 2026-08-21 to 2026-10-02: 18 rides, 21.5 h, TSS 1120';
const CONVO = [
  { role: 'user', content: 'How has my load changed?' },
  { role: 'assistant', content: 'It went up.' },
  { role: 'user', content: 'By how much per week?' }
];

async function runAgainst(kind, pwsh, mock, appPort) {
  const dir = tempAppDir(kind, mock.port, appPort);
  const proc = launch(kind, dir, pwsh);
  const tag = kind === 'node' ? 'server.js' : 'start_server.ps1';
  const base = `http://localhost:${appPort}`;
  const ask = async (body, headers = {}) => {
    const r = await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const seen = {};
  try {
    if (!(await waitUp(appPort))) { check(`${tag}: starts`, false, proc.output().slice(-800)); return null; }

    // 1. Claude Opus 5.5 (the default): analyst prompt, cached data block, conversation, effort, fallback.
    mock.log.length = 0;
    let r = await ask({ messages: CONVO, context: CONTEXT });
    const c1 = mock.log.find(x => x.path === '/v1/messages');
    const b = c1 && c1.body;
    seen.claude = b;
    check(`${tag}: answers a follow-up question (Claude)`, r.status === 200 && r.body.text === 'Your load rose. **42** TSS more per week.' && r.body.refused === false && r.body.model === 'claude-opus-5-5', `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    check(`${tag}: analyst prompt first, then the rider's data as a cached block`, !!b && Array.isArray(b.system) && b.system.length === 2 && b.system[0].text === ASK_SYSTEM_PROMPT && !b.system[0].cache_control &&
      b.system[1].text === `TRAINING DATA\n${CONTEXT}` && b.system[1].cache_control && b.system[1].cache_control.type === 'ephemeral');
    check(`${tag}: sends the whole conversation in order`, !!b && stable(b.messages) === stable(CONVO));
    check(`${tag}: adaptive thinking at the chosen effort, 16000 max tokens`, !!b && b.thinking.type === 'adaptive' && b.output_config.effort === 'low' && b.max_tokens === 16000);
    check(`${tag}: Opus 5.5 opts into the server-side refusal fallback`, !!b && b.fallbacks === 'default' && c1.headers['anthropic-beta'] === 'server-side-fallback-2026-07-01' && c1.headers['x-api-key'] === 'test-anthropic-key');
    check(`${tag}: reports cached input tokens`, r.status === 200 && r.body.usage && r.body.usage.cache_read_input_tokens === 1000);

    // 2. Haiku 4.5: thinking budget, no fallback option.
    mock.log.length = 0;
    r = await ask({ messages: [CONVO[0]], context: CONTEXT, model: 'claude-haiku-4-5-20251001', effort: 'high' });
    const c2 = mock.log.find(x => x.path === '/v1/messages');
    check(`${tag}: Haiku uses a thinking budget and no fallback`, r.status === 200 && c2 && c2.body.thinking.type === 'enabled' && c2.body.thinking.budget_tokens === 4000 && !('fallbacks' in c2.body) && !c2.headers['anthropic-beta'] && !c2.body.output_config && r.body.effort === null);

    // 3. An account that rejects the fallback option: same question again without it.
    mock.log.length = 0;
    mock.state.rejectFallback = true;
    r = await ask({ messages: CONVO, context: CONTEXT });
    mock.state.rejectFallback = false;
    const calls = mock.log.filter(x => x.path === '/v1/messages');
    check(`${tag}: retries without the fallback option when it is rejected`, r.status === 200 && calls.length === 2 && calls[0].body.fallbacks === 'default' && !('fallbacks' in calls[1].body) && !calls[1].headers['anthropic-beta'], `${r.status} calls ${calls.length}`);

    // 4. A declined request is a friendly answer, not an error.
    r = await ask({ messages: [{ role: 'user', content: 'REFUSE this' }], context: CONTEXT });
    check(`${tag}: a refusal comes back as a plain message`, r.status === 200 && r.body.refused === true && /can't answer that one/.test(r.body.text));

    // 5. Gemini: plain text (no JSON response type), assistant turns as "model", thoughts left out.
    mock.log.length = 0;
    r = await ask({ messages: CONVO, context: CONTEXT, model: 'gemini-3.8-flash', effort: 'medium' });
    const g = mock.log.find(x => /generateContent$/.test(x.path));
    const gb = g && g.body;
    seen.gemini = gb;
    check(`${tag}: answers with Gemini in plain text`, r.status === 200 && r.body.text === 'Gemini says your fitness grew.' && r.body.provider === 'gemini', `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    check(`${tag}: Gemini gets the analyst prompt and data, roles user/model, no JSON mode`, !!gb && gb.systemInstruction.parts[0].text === ASK_SYSTEM_PROMPT && gb.systemInstruction.parts[1].text === `TRAINING DATA\n${CONTEXT}` &&
      stable(gb.contents.map(x => x.role)) === stable(['user', 'model', 'user']) && gb.contents[2].parts[0].text === CONVO[2].content &&
      !gb.generationConfig.responseMimeType && gb.generationConfig.thinkingConfig.thinkingLevel === 'medium' && g.headers['x-goog-api-key'] === 'test-gemini-key');

    // 6. Validation.
    const bad = await Promise.all([
      ask({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }),
      ask({ messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }] }),
      ask({ messages: [{ role: 'assistant', content: 'a' }] }),
      ask({ messages: [] }),
      ask({ messages: [{ role: 'user', content: '   ' }] }),
      ask({ messages: Array.from({ length: 41 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x' })) }),
      ask({ messages: [{ role: 'user', content: 'a' }], context: 'x'.repeat(150001) }),
      ask({ messages: [{ role: 'user', content: 'x'.repeat(20001) }] })
    ]);
    check(`${tag}: rejects malformed conversations and oversized data with 400`, bad.every(x => x.status === 400 && x.body && x.body.error), bad.map(x => x.status).join('/'));
    const get = await fetch(`${base}/api/ask`);
    check(`${tag}: only POST is accepted`, get.status === 405);
    const evil = await ask({ messages: [CONVO[0]] }, { Origin: 'http://evil.example' });
    check(`${tag}: another website cannot use it`, evil.status === 403);
    const notJson = await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hi' });
    check(`${tag}: needs JSON`, notJson.status === 415);

    // 7. The coach endpoint is unchanged: one prompt, a single system string, JSON for Gemini.
    mock.log.length = 0;
    const cr = await fetch(`${base}/api/coach`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'Build me a session' }) });
    const cc = mock.log.find(x => x.path === '/v1/messages');
    check(`${tag}: coach requests are unchanged`, cr.status === 200 && cc && typeof cc.body.system === 'string' && cc.body.messages.length === 1 && !('fallbacks' in cc.body));
    return seen;
  } finally {
    proc.kill();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp */ }
  }
}

(async () => {
  const mock = await startMockAi();
  const node = await runAgainst('node', null, mock, 18741);
  const pwsh = findPwsh();
  if (!pwsh) console.log('SKIP: start_server.ps1 (no pwsh / powershell on PATH)');
  else {
    const ps = await runAgainst('ps', pwsh, mock, 18742);
    if (node && ps) {
      check('server.js and start_server.ps1 send the same Claude request', stable(node.claude) === stable(ps.claude));
      check('server.js and start_server.ps1 send the same Gemini request', stable(node.gemini) === stable(ps.gemini));
    }
  }
  mock.srv.close();
  console.log(failures ? `\n${failures} ask server check(s) FAILED` : '\nAll ask server checks passed');
  process.exit(failures ? 1 : 0);
})();
