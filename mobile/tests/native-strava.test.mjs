import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeStrava, convertUpload, slimActivity } from '../src/native-strava.js';

function setup({ now = 1_800_000_000_000 } = {}) {
  const store = new Map(), requests = [], opened = [];
  const replies = [];
  const http = { async request(o) { requests.push(o); const r = replies.shift(); if (!r) throw new Error('unexpected request ' + o.url); return typeof r === 'function' ? r(o) : r; } };
  const prefs = { get: async (k) => store.get(k) ?? null, set: async (k, v) => store.set(k, v), remove: async (k) => store.delete(k) };
  const strava = new NativeStrava({ http, prefs, openUrl: async (u) => opened.push(u), now: () => now });
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
  assert.deepEqual(await strava.status(), { configured: true, connected: true, athlete: 'Ana B', canUpload: true, canCheck: true, canSync: true });
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
  assert.equal(convertUpload({ id: 5, error: 'Bad file' }).state, 'failed');
});

test('routes: unknown paths fall through, wrong methods are refused, not connected says so', async () => {
  const { strava } = setup();
  assert.equal(await strava.route('/api/strava/nope', 'GET', new URLSearchParams(), ''), null);
  assert.equal((await strava.route('/api/strava/upload', 'GET', new URLSearchParams(), '')).status, 405);
  const r = await strava.route('/api/strava/sync', 'GET', new URLSearchParams('after=2026-01-01&before=2026-02-01'), '');
  assert.deepEqual([r.status, r.body.needsConnect], [401, true]);
  assert.equal(slimActivity({ id: 1, start_date: '2026-01-01T00:00:00Z', description: 'x' }, false).description, undefined);
});
