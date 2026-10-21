import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeStrava, ByoExchanger, BrokerExchanger, StravaDestination, UploadError, convertUpload } from '../src/native-strava.js';

function setup({ now = 1_800_000_000_000, exchanger } = {}) {
  const store = new Map(), requests = [], opened = [];
  const replies = [];
  const http = { async request(o) { requests.push(o); const r = replies.shift(); if (!r) throw new Error('unexpected request ' + o.url); return typeof r === 'function' ? r(o) : r; } };
  const prefs = { get: async (k) => store.get(k) ?? null, set: async (k, v) => store.set(k, v), remove: async (k) => store.delete(k) };
  const strava = new NativeStrava({ http, prefs, openUrl: async (u) => opened.push(u), now: () => now, ...(exchanger ? { exchanger: exchanger(http) } : {}) });
  return { strava, store, requests, replies, opened };
}
const SECRET = '0123456789abcdef0123456789abcdef01234567';

test('credentials are checked, and a different application signs out', async () => {
  const { strava, store } = setup();
  await assert.rejects(strava.setCredentials('abc', SECRET), /Client ID/);
  await assert.rejects(strava.setCredentials('123', 'short'), /Client Secret/);
  await strava.setCredentials(' 123 ', SECRET);
  assert.equal((await strava.status()).configured, true);
  store.set('strava_tokens', JSON.stringify({ refresh_token: 'r', scope: 'activity:write' }));
  await strava.setCredentials('123', SECRET);
  assert.equal((await strava.status()).connected, true, 'same application keeps the sign-in');
  await strava.setCredentials('456', SECRET);
  assert.equal((await strava.status()).connected, false);
});

test('sign-in: state must match and be fresh, upload permission is required', async () => {
  const { strava, replies, opened } = setup();
  await assert.rejects(strava.connect(), /Client ID/);
  await strava.setCredentials('123', SECRET);
  await strava.connect();
  const state = new URL(opened[0]).searchParams.get('state');
  assert.equal(new URL(opened[0]).searchParams.get('redirect_uri'), 'apexvelo://localhost/strava');
  assert.equal(new URL(opened[0]).searchParams.get('scope'), 'activity:write', 'upload permission only: the phone never reads Strava');
  assert.equal((await strava.handleRedirect(`apexvelo://localhost/strava?state=${state}&code=c&scope=read`)).ok, false, 'state is single-use');

  await strava.connect();
  const s2 = new URL(opened[1]).searchParams.get('state');
  const noWrite = await strava.handleRedirect(`apexvelo://localhost/strava?state=${s2}&code=c&scope=read,activity:read_all`);
  assert.match(noWrite.error, /Upload your activities/);

  await strava.connect();
  const s3 = new URL(opened[2]).searchParams.get('state');
  replies.push((o) => {
    assert.deepEqual(o.data, { client_id: '123', client_secret: SECRET, code: 'c', grant_type: 'authorization_code' });
    return { status: 200, headers: {}, data: { access_token: 'a', refresh_token: 'r', expires_at: 1_800_003_600, athlete: { firstname: 'Ana', lastname: 'B' } } };
  });
  const ok = await strava.handleRedirect(`apexvelo://localhost/strava?state=${s3}&code=c&scope=read,activity:write,activity:read_all`);
  assert.deepEqual(ok, { ok: true, athlete: 'Ana B' });
  assert.deepEqual(await strava.status(), { configured: true, connected: true, athlete: 'Ana B', canUpload: true, canCheck: false, canSync: false, uploadOnly: true, signIn: 'byo' });
});

test('an expired sign-in link is refused', async () => {
  const t = setup();
  await t.strava.setCredentials('123', SECRET);
  await t.strava.connect();
  const state = new URL(t.opened[0]).searchParams.get('state');
  t.strava.now = () => 1_800_000_000_000 + 16 * 60000;
  assert.match((await t.strava.handleRedirect(`apexvelo://localhost/strava?state=${state}&code=c&scope=activity:write`)).error, /expired/);
});

test('an expired access token is refreshed once and kept', async () => {
  const { strava, store, replies, requests } = setup();
  await strava.setCredentials('123', SECRET);
  store.set('strava_tokens', JSON.stringify({ access_token: 'old', refresh_token: 'r1', expires_at: 1_800_000_000, scope: 'activity:write', athlete: { firstname: 'A' } }));
  replies.push({ status: 200, headers: {}, data: { access_token: 'new', refresh_token: 'r2', expires_at: 1_800_007_200 } });
  assert.equal(await strava.accessToken(), 'new');
  assert.equal(await strava.accessToken(), 'new');
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(store.get('strava_tokens')).refresh_token, 'r2');
  assert.equal(JSON.parse(store.get('strava_tokens')).athlete.firstname, 'A');
});

test('upload responses map like the desktop server', () => {
  assert.deepEqual(convertUpload({ id: 5, status: 'processing' }), { uploadId: '5', state: 'processing', activityId: null, status: 'processing', error: null });
  assert.equal(convertUpload({ id: 5, activity_id: 9 }).state, 'sent');
  const dup = convertUpload({ id: 5, error: 'apex.fit duplicate of <a href="/activities/123">activity</a>' });
  assert.deepEqual([dup.state, dup.activityId], ['duplicate', '123']);
  const dupCap = convertUpload({ id: 5, error: 'Duplicate of activity 8' });
  assert.deepEqual([dupCap.state, dupCap.activityId], ['duplicate', '8']);
  assert.equal(convertUpload({ id: 5, error: 'Bad file' }).state, 'failed');
});

test('routes: only the upload routes exist; reading Strava is not answered on the phone', async () => {
  const { strava, requests } = setup();
  assert.equal(await strava.route('/api/strava/nope', 'GET', new URLSearchParams(), ''), null);
  assert.equal((await strava.route('/api/strava/upload', 'GET', new URLSearchParams(), '')).status, 405);
  assert.equal(await strava.route('/api/strava/sync', 'GET', new URLSearchParams('after=2026-01-01&before=2026-02-01'), ''), null);
  assert.equal(await strava.route('/api/strava/activities', 'GET', new URLSearchParams('after=1&before=2'), ''), null);
  assert.equal(typeof strava.sync, 'undefined');
  assert.equal(typeof strava.activities, 'undefined');
  const r = await strava.route('/api/strava/upload', 'POST', new URLSearchParams(), JSON.stringify({ fitBase64: 'x'.repeat(40) }));
  assert.deepEqual([r.status, r.body.needsConnect], [401, true]);
  assert.equal(requests.length, 0);
});

test('the broker exchanger needs no secret on the phone', async () => {
  const { strava, replies, requests, opened, store } = setup({ exchanger: (http) => new BrokerExchanger({ http, brokerUrl: 'https://broker.example/' }) });
  assert.equal((await strava.status()).configured, true);
  assert.equal(await strava.credentials(), null);
  await assert.rejects(strava.setCredentials('123', SECRET), /no API application/);
  replies.push({ status: 200, headers: {}, data: { clientId: '777' } });
  await strava.connect();
  assert.equal(requests[0].url, 'https://broker.example/strava/config');
  const auth = new URL(opened[0]);
  assert.equal(auth.origin + auth.pathname, 'https://www.strava.com/oauth/mobile/authorize');
  assert.equal(auth.searchParams.get('client_id'), '777');
  replies.push((o) => {
    assert.equal(o.url, 'https://broker.example/strava/token');
    assert.deepEqual(o.data, { grant_type: 'authorization_code', code: 'c' });
    return { status: 200, headers: {}, data: { access_token: 'a', refresh_token: 'r', expires_at: 1_799_999_000, athlete: { firstname: 'Ana' } } };
  });
  const ok = await strava.handleRedirect(`apexvelo://localhost/strava?state=${auth.searchParams.get('state')}&code=c&scope=read,activity:write`);
  assert.equal(ok.ok, true);
  replies.push((o) => {
    assert.deepEqual(o.data, { grant_type: 'refresh_token', refresh_token: 'r' });
    return { status: 200, headers: {}, data: { access_token: 'a2', refresh_token: 'r2', expires_at: 1_800_009_000 } };
  });
  assert.equal(await strava.accessToken(), 'a2');
  assert.equal([...store.values()].some((v) => /secret/i.test(v)), false);
  assert.equal(requests.some((o) => JSON.stringify(o.data || {}).includes('client_secret')), false);
});

test('the own-application exchanger is the default', () => {
  const { strava } = setup();
  assert.ok(strava.exchanger instanceof ByoExchanger);
  assert.equal(strava.exchanger.kind, 'byo');
});

function destination(answers) {
  const calls = [];
  const strava = {
    async status() { return { connected: true, canUpload: true }; },
    async upload(input) { calls.push(['upload', input]); return answers.shift(); },
    async uploadStatus(id) { calls.push(['status', id]); return answers.shift(); }
  };
  return { dest: new StravaDestination({ strava, describe: (r) => `TSS ${r.tss}`, sleep: async () => {}, pollMax: 3 }), calls };
}

test('Strava destination: uploads the FIT, waits for the activity, returns its id', async () => {
  const { dest, calls } = destination([
    { status: 200, body: { uploadId: '9', state: 'processing' } },
    { status: 502, body: { error: 'blip' } },
    { status: 200, body: { uploadId: '9', state: 'sent', activityId: '42' } }
  ]);
  assert.deepEqual([dest.id, dest.label, await dest.isConnected()], ['strava', 'Strava', true]);
  const out = await dest.upload({ id: 'r1', title: 'Sweet spot', tss: 80 }, new Uint8Array([1, 2, 3]));
  assert.deepEqual(out, { externalId: '42', duplicate: false });
  assert.deepEqual(calls[0][1], { fitBase64: 'AQID', name: 'Sweet spot', description: 'TSS 80', externalId: 'apexvelo-r1' });
  assert.equal(calls.filter((c) => c[0] === 'status').length, 2);
});

test('Strava destination: duplicates link, errors say whether to retry', async () => {
  let d = destination([{ status: 200, body: { state: 'duplicate', activityId: '7' } }]);
  assert.deepEqual(await d.dest.upload({ id: 'r' }, new Uint8Array(4)), { externalId: '7', duplicate: true });
  const err = async (answers) => { const x = destination(answers); try { await x.dest.upload({ id: 'r' }, new Uint8Array(4)); } catch (e) { return e; } assert.fail('no error'); };
  let e = await err([{ status: 502, body: { error: 'Could not reach Strava (offline).' } }]);
  assert.ok(e instanceof UploadError); assert.deepEqual([e.retryable, e.needsConnect], [true, false]);
  e = await err([{ status: 429, body: { error: 'rate' } }]);
  assert.equal(e.retryable, true);
  e = await err([{ status: 401, body: { error: 'sign in', needsConnect: true } }]);
  assert.equal(e.needsConnect, true);
  e = await err([{ status: 200, body: { state: 'failed', error: 'Bad file' } }]);
  assert.deepEqual([e.message, e.retryable], ['Bad file', false]);
  e = await err([{ status: 200, body: { uploadId: '1', state: 'processing' } }, ...Array(3).fill({ status: 200, body: { uploadId: '1', state: 'processing' } })]);
  assert.equal(e.retryable, true, 'still processing: sent again later, Strava then answers "duplicate of N"');
});

test('offline with an expired token: the upload is retryable, not a sign-out', async () => {
  const { strava, store, replies } = setup();
  await strava.setCredentials('123', SECRET);
  store.set('strava_tokens', JSON.stringify({ access_token: 'old', refresh_token: 'r1', expires_at: 1, scope: 'activity:write' }));
  replies.push(() => { throw new Error('Unable to resolve host'); });
  const r = await strava.upload({ fitBase64: 'x'.repeat(40) });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /Could not reach Strava/);
  assert.equal(r.body.needsConnect, undefined);
});

async function connectedUpload(answer) {
  const { strava, store, replies } = setup();
  await strava.setCredentials('123', SECRET);
  store.set('strava_tokens', JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: 1_900_000_000, scope: 'activity:write' }));
  replies.push(answer);
  return strava.upload({ fitBase64: 'x'.repeat(40), externalId: 'apexvelo-1' });
}

test('upload: a refused duplicate links to the existing activity; other refusals keep their status', async () => {
  const dup = await connectedUpload({ status: 409, headers: {}, data: { id: 3, error: 'x.fit duplicate of activity 777' } });
  assert.deepEqual([dup.status, dup.body.state, dup.body.activityId], [200, 'duplicate', '777']);
  const bad = await connectedUpload({ status: 400, headers: {}, data: { message: 'Bad Request', errors: [{ field: 'file' }] } });
  assert.deepEqual([bad.status, bad.body.error], [400, 'Strava upload failed: Bad Request']);
  assert.equal((await connectedUpload({ status: 403, headers: {}, data: { message: 'Forbidden' } })).status, 403);
  assert.equal((await connectedUpload({ status: 503, headers: {}, data: 'down' })).status, 502);
});

test('Strava destination: a 409 duplicate resolves, a 400 is not retried', async () => {
  const { strava, store, replies } = setup();
  await strava.setCredentials('123', SECRET);
  store.set('strava_tokens', JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: 1_900_000_000, scope: 'activity:write' }));
  const dest = new StravaDestination({ strava, sleep: async () => {} });
  replies.push({ status: 409, headers: {}, data: { error: 'Duplicate of activity 777' } });
  assert.deepEqual(await dest.upload({ id: '1' }, new Uint8Array(30)), { externalId: '777', duplicate: true });
  replies.push({ status: 400, headers: {}, data: { message: 'Bad Request' } });
  await assert.rejects(dest.upload({ id: '1' }, new Uint8Array(30)), (e) => e instanceof UploadError && e.retryable === false && !e.needsConnect);
});

test('connect: broker wording when the sign-in service is not set up', async () => {
  const { strava } = setup({ exchanger: (http) => new BrokerExchanger({ http, brokerUrl: '' }) });
  await assert.rejects(strava.connect(), /sign-in is not available/);
});

async function expiredSetup() {
  const t = setup();
  await t.strava.setCredentials('123', SECRET);
  t.store.set('strava_tokens', JSON.stringify({ access_token: 'old', refresh_token: 'r1', expires_at: 1, scope: 'activity:write', athlete: { firstname: 'Ana' } }));
  return t;
}

test('a refused token refresh (400/401) signs out, so Settings offers Connect Strava', async () => {
  for (const status of [400, 401]) {
    const { strava, replies } = await expiredSetup();
    replies.push({ status, headers: {}, data: { message: 'Bad Request', errors: [{ resource: 'RefreshToken', code: 'invalid' }] } });
    const r = await strava.upload({ fitBase64: 'x'.repeat(40) });
    assert.deepEqual([r.status, r.body.needsConnect], [401, true]);
    const st = await strava.status();
    assert.deepEqual([st.connected, st.athlete, st.configured], [false, null, true], `refresh ${status}`);
  }
});

test('a token-endpoint outage (5xx) is a retryable 502 and keeps the sign-in', async () => {
  const { strava, replies } = await expiredSetup();
  replies.push({ status: 503, headers: {}, data: 'Service Unavailable' });
  const r = await strava.upload({ fitBase64: 'x'.repeat(40) });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /temporarily unavailable \(HTTP 503\)/);
  assert.equal(r.body.needsConnect, undefined);
  assert.equal((await strava.status()).connected, true);
  const dest = new StravaDestination({ strava, sleep: async () => {} });
  replies.push({ status: 502, headers: {}, data: '' });
  await assert.rejects(dest.upload({ id: '1' }, new Uint8Array(30)), (e) => e.retryable === true && !e.needsConnect);
});
