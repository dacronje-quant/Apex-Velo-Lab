import { describe, test, expect, vi, afterEach } from 'vitest';
import worker, { handle, parseGrant, readLimited, MAX_BODY_BYTES, type Env } from '../src/index';

/** In-memory stand-in for a Workers rate-limit binding: `limit` requests per key. */
function limiter(limit: number) {
  const seen = new Map<string, number>();
  return {
    keys: seen,
    async limit({ key }: { key: string }) { const n = (seen.get(key) || 0) + 1; seen.set(key, n); return { success: n <= limit }; }
  };
}

function env(over: Partial<Env> = {}): Env {
  return { STRAVA_CLIENT_ID: '777', STRAVA_CLIENT_SECRET: 's3cret', TOKEN_LIMITER: limiter(100), CONFIG_LIMITER: limiter(100), ...over } as Env;
}

const BASE = 'https://broker.example';
const tokenReq = (body: unknown, headers: Record<string, string> = {}) => new Request(`${BASE}/strava/token`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body)
});

const STRAVA_OK = {
  token_type: 'Bearer', expires_at: 1_800_003_600, expires_in: 21600, refresh_token: 'r2', access_token: 'a2',
  athlete: { id: 42, username: 'ana', firstname: 'Ana', lastname: 'B', city: 'Cape Town', sex: 'F', profile: 'https://x/p.jpg', weight: 61 }
};

/** A fetch that records Strava calls and answers with `answer`. */
function strava(answer: () => Response | Promise<Response>) {
  const calls: { url: string; body: URLSearchParams; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: new URLSearchParams(String(init.body)), init });
    return answer();
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}
const jsonRes = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('GET /strava/config', () => {
  test('answers the public client id only', async () => {
    const r = await handle(new Request(`${BASE}/strava/config`), env());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ clientId: '777' });
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('missing or malformed credentials are a 5xx broker fault', async () => {
    for (const e of [env({ STRAVA_CLIENT_ID: '' }), env({ STRAVA_CLIENT_ID: 'abc' }), env({ STRAVA_CLIENT_SECRET: undefined })]) {
      const r = await handle(new Request(`${BASE}/strava/config`), e);
      expect(r.status).toBe(500);
      expect(await r.json()).toEqual({ error: expect.any(String) });
    }
  });

  test('the default export serves the same handler', async () => {
    const r = await worker.fetch(new Request(`${BASE}/strava/config`), env());
    expect(await r.json()).toEqual({ clientId: '777' });
  });
});

describe('POST /strava/token: pass-through', () => {
  test('an authorization code is exchanged with the secret added; athlete PII is dropped', async () => {
    const s = strava(() => jsonRes(200, STRAVA_OK));
    const r = await handle(tokenReq({ grant_type: 'authorization_code', code: 'abc123' }), env(), s.fetcher);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      token_type: 'Bearer', expires_at: 1_800_003_600, expires_in: 21600, refresh_token: 'r2', access_token: 'a2',
      athlete: { id: 42, firstname: 'Ana', lastname: 'B' }
    });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].url).toBe('https://www.strava.com/oauth/token');
    expect(Object.fromEntries(s.calls[0].body)).toEqual({ client_id: '777', client_secret: 's3cret', grant_type: 'authorization_code', code: 'abc123' });
  });

  test('a refresh token is refreshed', async () => {
    const s = strava(() => jsonRes(200, { ...STRAVA_OK, athlete: undefined }));
    const r = await handle(tokenReq({ grant_type: 'refresh_token', refresh_token: 'r1' }), env(), s.fetcher);
    expect(r.status).toBe(200);
    const body = await r.json() as Record<string, unknown>;
    expect(body.access_token).toBe('a2');
    expect(body).not.toHaveProperty('athlete');
    expect(Object.fromEntries(s.calls[0].body)).toEqual({ client_id: '777', client_secret: 's3cret', grant_type: 'refresh_token', refresh_token: 'r1' });
  });

  test.each([400, 401])('Strava %i refusals reach the app unchanged', async (status) => {
    const refusal = { message: 'Bad Request', errors: [{ resource: 'RefreshToken', field: 'refresh_token', code: 'invalid' }] };
    const s = strava(() => jsonRes(status, refusal));
    const r = await handle(tokenReq({ grant_type: 'refresh_token', refresh_token: 'revoked' }), env(), s.fetcher);
    expect(r.status).toBe(status);
    expect(await r.json()).toEqual(refusal);
  });

  test('a Strava 429 stays 429 (the app retries later) and keeps Retry-After', async () => {
    const s = strava(() => jsonRes(429, { message: 'Rate Limit Exceeded' }, { 'Retry-After': '900' }));
    const r = await handle(tokenReq({ grant_type: 'refresh_token', refresh_token: 'r1' }), env(), s.fetcher);
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('900');
  });
});

describe('POST /strava/token: broker faults are 5xx, never 400/401', () => {
  const grant = { grant_type: 'refresh_token', refresh_token: 'r1' };

  test.each([500, 502, 503])('a Strava %i becomes a 502 with { error }', async (status) => {
    const s = strava(() => new Response('<html>oops</html>', { status }));
    const r = await handle(tokenReq(grant), env(), s.fetcher);
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: expect.stringContaining(String(status)) });
  });

  test('other unexpected Strava statuses (e.g. 404) are a 502', async () => {
    const r = await handle(tokenReq(grant), env(), strava(() => jsonRes(404, { message: 'Not found' })).fetcher);
    expect(r.status).toBe(502);
  });

  test('a network error is a 502', async () => {
    const r = await handle(tokenReq(grant), env(), strava(() => { throw new TypeError('fetch failed'); }).fetcher);
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: 'Could not reach Strava.' });
  });

  test('a Strava that never answers times out as a 504', async () => {
    vi.useFakeTimers();
    const hang = ((_url: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as unknown as typeof fetch;
    const pending = handle(tokenReq(grant), env(), hang);
    await vi.advanceTimersByTimeAsync(10_001);
    const r = await pending;
    expect(r.status).toBe(504);
  });

  test('a 200 without an access token, or not JSON, is a 502', async () => {
    for (const answer of [() => jsonRes(200, { hello: 1 }), () => new Response('not json', { status: 200 })]) {
      const r = await handle(tokenReq(grant), env(), strava(answer).fetcher);
      expect(r.status).toBe(502);
    }
  });

  test('missing secrets are a 500 and Strava is not called', async () => {
    const s = strava(() => jsonRes(200, STRAVA_OK));
    const r = await handle(tokenReq(grant), env({ STRAVA_CLIENT_SECRET: '' }), s.fetcher);
    expect(r.status).toBe(500);
    expect(s.calls).toHaveLength(0);
  });

  test('a missing rate limiter fails closed with a 500', async () => {
    const s = strava(() => jsonRes(200, STRAVA_OK));
    expect((await handle(tokenReq(grant), env({ TOKEN_LIMITER: undefined }), s.fetcher)).status).toBe(500);
    expect((await handle(new Request(`${BASE}/strava/config`), env({ CONFIG_LIMITER: undefined }))).status).toBe(500);
    expect(s.calls).toHaveLength(0);
  });
});

describe('input validation', () => {
  const bad = async (req: Request) => {
    const s = strava(() => jsonRes(200, STRAVA_OK));
    const r = await handle(req, env(), s.fetcher);
    expect(s.calls).toHaveLength(0);
    expect([400, 401]).not.toContain(r.status);
    return r.status;
  };

  test('only the grant shapes are accepted (422)', async () => {
    for (const body of [
      {}, [], 'null', '{', { grant_type: 'password', username: 'x' }, { grant_type: 'authorization_code' },
      { grant_type: 'authorization_code', code: 'c', client_secret: 'x' }, { grant_type: 'refresh_token', refresh_token: 5 },
      { grant_type: 'refresh_token', refresh_token: 'a b' }, { grant_type: 'authorization_code', code: 'x'.repeat(257) },
      { grant_type: 'authorization_code', code: 'c&client_id=1' }
    ]) expect(await bad(tokenReq(body))).toBe(422);
  });

  test('JSON only (415)', async () => {
    expect(await bad(tokenReq('code=c&grant_type=authorization_code', { 'Content-Type': 'application/x-www-form-urlencoded' }))).toBe(415);
  });

  test('bodies over the size limit are refused (413), even without Content-Length', async () => {
    const big = JSON.stringify({ grant_type: 'authorization_code', code: 'c', pad: 'x'.repeat(MAX_BODY_BYTES) });
    expect(await bad(tokenReq(big))).toBe(413);
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
    const chunked = new Request(`${BASE}/strava/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit);
    expect(chunked.headers.get('content-length')).toBeNull();
    expect(await bad(chunked)).toBe(413);
  });

  test('wrong method (405) and unknown routes (404), including intervals.icu for now', async () => {
    expect(await bad(new Request(`${BASE}/strava/token`))).toBe(405);
    expect(await bad(new Request(`${BASE}/strava/config`, { method: 'POST', body: '{}' }))).toBe(405);
    expect(await bad(new Request(`${BASE}/`))).toBe(404);
    expect(await bad(new Request(`${BASE}/icu/config`))).toBe(404);
    expect(await bad(new Request(`${BASE}/icu/token`, { method: 'POST' }))).toBe(404);
  });

  test('browsers are denied (403) and get no CORS headers', async () => {
    const grant = { grant_type: 'refresh_token', refresh_token: 'r1' };
    for (const req of [
      tokenReq(grant, { Origin: 'https://evil.example' }),
      tokenReq(grant, { 'Sec-Fetch-Mode': 'cors' }),
      new Request(`${BASE}/strava/config`, { headers: { 'Sec-Fetch-Site': 'cross-site' } }),
      new Request(`${BASE}/strava/token`, { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST' } })
    ]) {
      const s = strava(() => jsonRes(200, STRAVA_OK));
      const r = await handle(req, env(), s.fetcher);
      expect(r.status).toBe(403);
      expect(r.headers.get('access-control-allow-origin')).toBeNull();
      expect(s.calls).toHaveLength(0);
    }
  });

  test('parseGrant and readLimited directly', async () => {
    expect(parseGrant('{"grant_type":"authorization_code","code":"abc"}')).toEqual({ grant_type: 'authorization_code', code: 'abc' });
    expect(parseGrant('{"grant_type":"refresh_token","refresh_token":"abc","code":"x"}')).toBeNull();
    expect(await readLimited(new Request(BASE, { method: 'POST', body: 'hello' }), 5)).toBe('hello');
    expect(await readLimited(new Request(BASE, { method: 'POST', body: 'hello!' }), 5)).toBeNull();
  });
});

describe('rate limit', () => {
  test('per IP and per route: the 11th token request in a window is a 429 with Retry-After', async () => {
    const e = env({ TOKEN_LIMITER: limiter(10) });
    const s = strava(() => jsonRes(200, STRAVA_OK));
    const grant = { grant_type: 'refresh_token', refresh_token: 'r1' };
    for (let i = 0; i < 10; i++) expect((await handle(tokenReq(grant), e, s.fetcher)).status).toBe(200);
    const r = await handle(tokenReq(grant), e, s.fetcher);
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('60');
    expect(await r.json()).toEqual({ error: expect.any(String) });
    expect(s.calls).toHaveLength(10);
    // Another address has its own allowance; config has its own limiter.
    expect((await handle(tokenReq(grant, { 'CF-Connecting-IP': '198.51.100.1' }), e, s.fetcher)).status).toBe(200);
    expect((await handle(new Request(`${BASE}/strava/config`, { headers: { 'CF-Connecting-IP': '203.0.113.7' } }), e)).status).toBe(200);
  });

  test('the limiter key names the route and address, nothing else', async () => {
    const t = limiter(100);
    await handle(tokenReq({ grant_type: 'refresh_token', refresh_token: 'secret-refresh' }), env({ TOKEN_LIMITER: t }), strava(() => jsonRes(200, STRAVA_OK)).fetcher);
    expect([...t.keys.keys()]).toEqual(['strava/token:203.0.113.7']);
  });
});

describe('attestation (stubbed)', () => {
  const grant = { grant_type: 'refresh_token', refresh_token: 'r1' };
  const ok = () => strava(() => jsonRes(200, STRAVA_OK)).fetcher;

  test('off (default) ignores the header', async () => {
    expect((await handle(tokenReq(grant), env(), ok())).status).toBe(200);
  });

  test('report never blocks', async () => {
    expect((await handle(tokenReq(grant), env({ ATTESTATION: 'report' }), ok())).status).toBe(200);
    expect((await handle(tokenReq(grant, { 'X-Apex-Attestation': 'tok' }), env({ ATTESTATION: 'report' }), ok())).status).toBe(200);
  });

  test('enforce refuses a missing token (403) and, with the stub verifier, answers 503 rather than signing riders out', async () => {
    expect((await handle(tokenReq(grant), env({ ATTESTATION: 'enforce' }), ok())).status).toBe(403);
    expect((await handle(tokenReq(grant, { 'X-Apex-Attestation': 'tok' }), env({ ATTESTATION: 'enforce' }), ok())).status).toBe(503);
  });

  test('an unknown mode is a 500 misconfiguration', async () => {
    expect((await handle(tokenReq(grant), env({ ATTESTATION: 'maybe' }), ok())).status).toBe(500);
  });
});

describe('logging', () => {
  test('logs carry no tokens, codes, secrets or addresses', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    const answers = [() => jsonRes(200, STRAVA_OK), () => jsonRes(400, { message: 'code-xyz invalid' }), () => { throw new Error('boom r-secret'); }];
    for (const a of answers) {
      await handle(tokenReq({ grant_type: 'authorization_code', code: 'code-xyz' }), env(), strava(a).fetcher);
      await handle(tokenReq({ grant_type: 'refresh_token', refresh_token: 'r-secret' }), env(), strava(a).fetcher);
    }
    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join('\n');
    for (const s of ['code-xyz', 'r-secret', 'a2', 's3cret', '203.0.113.7', 'boom']) expect(all).not.toContain(s);
  });
});
