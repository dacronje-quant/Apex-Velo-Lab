const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const srv = require('../server.js');

test('phone remote LIVE_CMDS allows interval-plus and interval-minus', () => {
  assert.equal(srv.LIVE_CMDS.has('interval-plus'), true);
  assert.equal(srv.LIVE_CMDS.has('interval-minus'), true);
});

test('loadDotEnv does not let blank APEX_* lines overwrite existing environment overrides', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-dotenv-'));
  const envFile = path.join(tmp, '.env');
  fs.writeFileSync(envFile, 'APEX_DATA_DIR=\nAPEX_PORT=9090\n');
  const prevData = process.env.APEX_DATA_DIR;
  const prevPort = process.env.APEX_PORT;
  try {
    process.env.APEX_DATA_DIR = '/tmp/isolated-data';
    process.env.APEX_PORT = '8080';
    srv.loadDotEnv(envFile);
    assert.equal(process.env.APEX_DATA_DIR, '/tmp/isolated-data');
    assert.equal(process.env.APEX_PORT, '9090');
  } finally {
    if (prevData === undefined) delete process.env.APEX_DATA_DIR; else process.env.APEX_DATA_DIR = prevData;
    if (prevPort === undefined) delete process.env.APEX_PORT; else process.env.APEX_PORT = prevPort;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('explainFetchError unwraps Node fetch cause codes into plain English', () => {
  const dnsErr = Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.anthropic.com'), { code: 'ENOTFOUND' }) });
  const timeoutErr = Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
  assert.match(srv.explainFetchError(dnsErr), /internet connection/i);
  assert.match(srv.explainFetchError(timeoutErr), /timed out/i);
});

test('aiErrorHint adds actionable guidance for auth, quota, and missing-model statuses', () => {
  assert.match(srv.aiErrorHint('claude', 401), /ANTHROPIC_API_KEY/);
  assert.match(srv.aiErrorHint('openai', 429), /quota|billing|busy/i);
  assert.match(srv.aiErrorHint('gemini', 404), /Re-check server/i);
  assert.equal(srv.aiErrorHint('claude', 500), '');
});

test('Strava description uses neutral app attribution instead of hardcoded personal devices', () => {
  const ctx = { VeloApp: function () {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'app-strava.js'), 'utf8'), ctx);
  const desc = ctx.VeloApp.prototype.stravaDescription({ avgPower: 220, np: 230, if: 0.85, tss: 72, kj: 800 });
  assert.match(desc, /Recorded with Apex Velo Lab$/);
  assert.doesNotMatch(desc, /Assioma|KICKR SHIFT/i);
});
