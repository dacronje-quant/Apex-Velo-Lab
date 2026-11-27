'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise(r => s.close(r));
  return port;
}

function startMockAi() {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const u = new URL(req.url, 'http://x');
      calls.push({ path: u.pathname, body });
      const send = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

      // Claude
      if (u.pathname === '/v1/messages') {
        const last = body.messages[body.messages.length - 1];
        const hasToolResult = Array.isArray(last.content) && last.content.some(b => b.type === 'tool_result');
        if (!hasToolResult && body.tools && body.tools.length) {
          return send({
            model: body.model, stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'tu_1', name: 'get_ride_detail', input: { ride_id: 'ride_fit_1' } }],
            usage: { input_tokens: 100, output_tokens: 20 }
          });
        }
        const toolOut = hasToolResult ? JSON.parse(last.content[0].content) : null;
        return send({
          model: body.model, stop_reason: 'end_turn',
          content: [{ type: 'text', text: toolOut ? `Claude saw ${toolOut.ride.title} with ${toolOut.laps.length} laps.` : 'No tools.' }],
          usage: { input_tokens: 150, output_tokens: 30, cache_read_input_tokens: 80 }
        });
      }

      // Gemini
      if (/\/v1beta\/models\/[^/:]+:generateContent$/.test(u.pathname)) {
        const last = body.contents[body.contents.length - 1];
        const fnResp = (last.parts || []).find(p => p.functionResponse);
        if (!fnResp && body.tools && body.tools.length) {
          return send({
            modelVersion: 'gemini-3.8-flash',
            candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'get_strength_history', args: { exercise: 'squat' } } }] } }],
            usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 15 }
          });
        }
        const resObj = fnResp ? fnResp.functionResponse.response.result : null;
        return send({
          modelVersion: 'gemini-3.8-flash',
          candidates: [{ finishReason: 'STOP', content: { parts: [{ text: resObj ? `Gemini saw ${resObj.exercises[0].max_weight_kg} kg squat.` : 'No tools.' }] } }],
          usageMetadata: { promptTokenCount: 140, candidatesTokenCount: 25 }
        });
      }

      // OpenAI Responses
      if (u.pathname === '/v1/responses') {
        const fnOut = Array.isArray(body.input) ? body.input.find(it => it.type === 'function_call_output') : null;
        if (!fnOut && body.tools && body.tools.length) {
          return send({
            model: body.model, status: 'completed',
            output: [{ type: 'function_call', call_id: 'call_1', name: 'get_ride_segment', arguments: JSON.stringify({ ride_id: 'ride_fit_1', start_s: 0, end_s: 59, bucket_s: 30 }) }],
            usage: { input_tokens: 80, output_tokens: 12 }
          });
        }
        const seg = fnOut ? JSON.parse(fnOut.output) : null;
        return send({
          model: body.model, status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: seg ? `OpenAI saw ${seg.bucketCount} buckets at ${seg.buckets[0].avg_power} W.` : 'No tools.' }] }],
          usage: { input_tokens: 130, output_tokens: 22 }
        });
      }

      res.writeHead(404); res.end('{}');
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, calls, port: srv.address().port })));
}

test('POST /api/ask executes multi-turn SQLite tools for Claude, Gemini, and OpenAI when useTools=true', { timeout: 30000 }, async (t) => {
  const mock = await startMockAi();
  t.after(() => mock.srv.close());

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-ask-tools-'));
  const appDir = path.join(tmp, 'app');
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(appDir);
  for (const name of ['index.html', 'server.js', 'js', 'scripts']) {
    fs.cpSync(path.join(ROOT, name), path.join(appDir, name), { recursive: true });
  }
  fs.mkdirSync(path.join(appDir, 'data'));
  const port = await freePort();
  fs.writeFileSync(path.join(appDir, '.env'), [
    `APEX_PORT=${port}`,
    'ANTHROPIC_API_KEY=test-claude',
    'GEMINI_API_KEY=test-gemini',
    'OPENAI_API_KEY=test-openai',
    `APEX_ANTHROPIC_BASE_URL=http://127.0.0.1:${mock.port}`,
    `APEX_GEMINI_BASE_URL=http://127.0.0.1:${mock.port}`,
    `APEX_OPENAI_BASE_URL=http://127.0.0.1:${mock.port}`,
    ''
  ].join('\n'));

  const child = spawn(process.execPath, ['server.js'], {
    cwd: appDir,
    env: { ...process.env, APEX_DATA_DIR: dataDir, APEX_NO_BROWSER: '1', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', OPENAI_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await new Promise(r => child.once('exit', r)); }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const base = `http://localhost:${port}`;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${base}/api/storage`); if (r.ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }

  // Seed SQLite via /api/storage/migrate
  const samples = Array.from({ length: 60 }, (_, i) => ({ time: i, power: 255, hr: 158, cadence: 92 }));
  const rides = [
    {
      id: 'ride_fit_1', date: '2026-10-15T07:00:00.000Z', title: 'Threshold Laps', source: 'FIT Import',
      duration: 60, avgWatts: 255, maxWatts: 265, np: 255, tss: 10, ftpAtRide: 250, samples,
      laps: [{ lapIdx: 1, startSec: 0, durationSec: 60, avgWatts: 255, maxWatts: 265, avgHr: 158, maxHr: 162, avgCadence: 92, trigger: 'manual' }]
    },
    {
      id: 'hevy_9', date: '2026-10-14T18:00:00.000Z', title: 'Lower Strength', source: 'Hevy',
      activityType: 'strength', duration: 1800, strengthTss: 45, heavyLegs: true,
      exercises: ['Squat (Barbell): 3x5 @ 120 kg (RPE 8.5)']
    }
  ];
  const mig = await fetch(`${base}/api/storage/migrate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ revision: 0, operationId: 'seed_tools_123456', rides, settings: { apex_velo_profiles: JSON.stringify([{ id: 'p1', ftp: 250, maxHr: 180 }]), apex_velo_active_prof_id: 'p1' }, dbSettings: [] })
  });
  assert.equal(mig.status, 200);

  const statusRes = await (await fetch(`${base}/api/storage/analytics-status`)).json();
  assert.equal(statusRes.ok, true);
  assert.equal(statusRes.indexedRides, 2);
  assert.equal(statusRes.totalSamples, 60);

  const ask = async (payload) => {
    const r = await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(payload) });
    return { status: r.status, body: await r.json() };
  };

  // Without useTools: no tools attached
  mock.calls.length = 0;
  const plain = await ask({ messages: [{ role: 'user', content: 'Hi' }], context: 'ctx', provider: 'claude' });
  assert.equal(plain.status, 200);
  assert.equal(plain.body.text, 'No tools.');
  assert.equal(plain.body.toolsUsed, undefined);
  assert.equal(mock.calls[0].body.tools, undefined);

  // Claude with useTools
  const cRes = await ask({ messages: [{ role: 'user', content: 'Analyze ride_fit_1' }], context: 'ctx', provider: 'claude', useTools: true });
  assert.equal(cRes.status, 200);
  assert.equal(cRes.body.text, 'Claude saw Threshold Laps with 1 laps.');
  assert.deepEqual(cRes.body.toolsUsed, [{ name: 'get_ride_detail' }]);
  assert.equal(cRes.body.usage.input_tokens, 250);

  // Gemini with useTools
  const gRes = await ask({ messages: [{ role: 'user', content: 'How heavy did I squat?' }], context: 'ctx', provider: 'gemini', model: 'gemini-3.8-flash', useTools: true });
  assert.equal(gRes.status, 200);
  assert.equal(gRes.body.text, 'Gemini saw 120 kg squat.');
  assert.deepEqual(gRes.body.toolsUsed, [{ name: 'get_strength_history' }]);

  // OpenAI with useTools
  const oRes = await ask({ messages: [{ role: 'user', content: 'Inspect segments' }], context: 'ctx', provider: 'openai', model: 'gpt-6.1-sol', useTools: true });
  assert.equal(oRes.status, 200);
  assert.equal(oRes.body.text, 'OpenAI saw 2 buckets at 255 W.');
  assert.deepEqual(oRes.body.toolsUsed, [{ name: 'get_ride_segment' }]);
});
