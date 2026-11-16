/**
 * Apex Velo token broker: a stateless Cloudflare Worker that holds the Strava client secret, so the Android
 * app signs in with one tap and ships no secret.
 *
 *   GET  /strava/config  -> { clientId }                     (public; the app builds Strava's sign-in URL from it)
 *   POST /strava/token   { grant_type: 'authorization_code', code }
 *                        { grant_type: 'refresh_token', refresh_token }  -> Strava's token answer, minus athlete PII
 *
 * Status codes are a contract with the app (mobile/src/native-strava.js): a refused token refresh (400/401) signs
 * the rider out, so 400 and 401 only ever come from Strava itself, passed through unchanged. Everything the broker
 * refuses on its own uses other 4xx codes (403 browser or attestation, 404, 405, 413, 415, 422 bad input, 429 rate
 * limit), and its own faults (misconfiguration, Strava 5xx, timeouts, unreadable answers) are 5xx with { error }:
 * the app treats 429 and 5xx as "try again later", never as a sign-out.
 *
 * Nothing is stored and nothing secret is logged: no tokens, codes, bodies or IP addresses.
 *
 * Providers share one shape (/<provider>/config, /<provider>/token) so intervals.icu can be added later as
 * another PROVIDERS entry (/icu/config, /icu/token); see README.md.
 */

export interface Env {
  STRAVA_CLIENT_ID?: string;
  STRAVA_CLIENT_SECRET?: string;
  /** Per-IP limiters (Workers rate-limit bindings, wrangler.toml). Missing = misconfigured: the broker fails closed. */
  TOKEN_LIMITER?: RateLimit;
  CONFIG_LIMITER?: RateLimit;
  /** App attestation (Play Integrity): 'off' (default), 'report' or 'enforce'. See README.md. */
  ATTESTATION?: string;
}

export const MAX_BODY_BYTES = 2048;
export const UPSTREAM_TIMEOUT_MS = 10000;
export const ATTESTATION_HEADER = 'x-apex-attestation';
/** Strava answers a refusal of the request with these; they reach the app unchanged. */
const PASS_THROUGH = new Set([400, 401, 403, 429]);
/** The token answer the app needs; the athlete keeps only what Settings shows ("Connected as ..."). */
const TOKEN_FIELDS = ['token_type', 'access_token', 'refresh_token', 'expires_at', 'expires_in'];
const ATHLETE_FIELDS = ['id', 'firstname', 'lastname'];
const TOKEN_RE = /^[A-Za-z0-9._~-]{1,256}$/;

/**
 * Whether a Strava refusal is about the broker's own application (wrong client id or secret, e.g.
 * { errors: [{ resource: 'Application', field: 'client_secret', code: 'invalid' }] }) rather than the rider's grant.
 * That is a broker fault: passing it through as 400/401 would sign every rider out.
 */
export function refusesApplication(body: string): boolean {
  let data: unknown;
  try { data = JSON.parse(body); } catch { return false; }
  const errors = data && typeof data === 'object' ? (data as { errors?: unknown }).errors : null;
  if (!Array.isArray(errors)) return false;
  return errors.some((e) => e && typeof e === 'object' && (
    String((e as Record<string, unknown>).resource || '').toLowerCase() === 'application' ||
    ['client_id', 'client_secret'].includes(String((e as Record<string, unknown>).field || '').toLowerCase())));
}

interface Provider {
  tokenUrl: string;
  credentials(env: Env): { clientId: string; clientSecret: string } | null;
  /** The token answer stripped to what the app keeps. */
  clean(data: Record<string, unknown>): Record<string, unknown>;
}

const pick = (src: Record<string, unknown>, keys: string[]) => {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
};

export const PROVIDERS: Record<string, Provider> = {
  strava: {
    tokenUrl: 'https://www.strava.com/oauth/token',
    credentials(env) {
      const clientId = String(env.STRAVA_CLIENT_ID || '').trim(), clientSecret = String(env.STRAVA_CLIENT_SECRET || '').trim();
      return /^\d+$/.test(clientId) && clientSecret ? { clientId, clientSecret } : null;
    },
    clean(data) {
      const out = pick(data, TOKEN_FIELDS);
      if (data.athlete && typeof data.athlete === 'object') out.athlete = pick(data.athlete as Record<string, unknown>, ATHLETE_FIELDS);
      return out;
    }
  }
};

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
const fail = (status: number, error: string, extra?: Record<string, string>) => json(status, { error }, extra);

/** Status and timing only: never a token, code, body or address. */
function log(route: string, status: number, started: number, note = '') {
  console.log(JSON.stringify({ route, status, ms: Date.now() - started, ...(note ? { note } : {}) }));
}

/**
 * The app calls the broker natively (CapacitorHttp), which sends neither Origin nor Sec-Fetch-* headers. A browser
 * always sends one of them on a cross-site call, so they mark a web page trying to use the broker.
 */
function fromBrowser(request: Request) {
  return request.method === 'OPTIONS' || request.headers.has('origin') || request.headers.has('sec-fetch-mode') || request.headers.has('sec-fetch-site');
}

async function underLimit(limiter: RateLimit | undefined, request: Request, route: string) {
  if (!limiter) return null;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const { success } = await limiter.limit({ key: `${route}:${ip}` });
  return success;
}

/** The body, or null when it is larger than `max` bytes (whatever Content-Length claims). */
export async function readLimited(request: Request, max = MAX_BODY_BYTES): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(bytes);
}

type Grant = { grant_type: 'authorization_code'; code: string } | { grant_type: 'refresh_token'; refresh_token: string };

/** Exactly one of the two grant shapes, with token-like values; anything else is refused. */
export function parseGrant(text: string): Grant | null {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>, keys = Object.keys(b).sort().join(',');
  if (b.grant_type === 'authorization_code' && keys === 'code,grant_type' && typeof b.code === 'string' && TOKEN_RE.test(b.code)) {
    return { grant_type: 'authorization_code', code: b.code };
  }
  if (b.grant_type === 'refresh_token' && keys === 'grant_type,refresh_token' && typeof b.refresh_token === 'string' && TOKEN_RE.test(b.refresh_token)) {
    return { grant_type: 'refresh_token', refresh_token: b.refresh_token };
  }
  return null;
}

export type Attestation = 'valid' | 'invalid' | 'missing' | 'unverified';

/**
 * Play Integrity verification, stubbed: decoding a token needs a Google Cloud service account and the
 * decodeIntegrityToken API, which come with the Play Console setup (README.md, "App attestation"). Until then a
 * present token is 'unverified'.
 */
export async function verifyAttestation(token: string | null, _env: Env): Promise<Attestation> {
  if (!token) return 'missing';
  if (token.length > 8192) return 'invalid';
  return 'unverified';
}

/** null to go on, or the refusal. 'report' never blocks; 'enforce' refuses what is not valid. */
async function checkAttestation(request: Request, env: Env): Promise<{ refusal: Response | null; note: string }> {
  const mode = (env.ATTESTATION || 'off').toLowerCase();
  if (mode === 'off') return { refusal: null, note: '' };
  const outcome = await verifyAttestation(request.headers.get(ATTESTATION_HEADER), env);
  if (mode === 'report' || outcome === 'valid') return { refusal: null, note: `attestation:${outcome}` };
  if (mode !== 'enforce') return { refusal: fail(500, 'The sign-in service is misconfigured.'), note: 'bad ATTESTATION mode' };
  // A verifier that cannot decide is the broker's fault, not the app's: 5xx, so riders stay signed in.
  if (outcome === 'unverified') return { refusal: fail(503, 'App verification is not available right now.'), note: 'attestation:unverified' };
  return { refusal: fail(403, 'This app could not be verified.'), note: `attestation:${outcome}` };
}

async function token(provider: Provider, request: Request, env: Env, fetcher: typeof fetch): Promise<[Response, string]> {
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return [fail(415, 'Send JSON.'), ''];
  const text = await readLimited(request);
  if (text === null) return [fail(413, 'Request too large.'), ''];
  const grant = parseGrant(text);
  if (!grant) return [fail(422, 'Invalid token request.'), ''];
  const creds = provider.credentials(env);
  if (!creds) return [fail(500, 'The sign-in service is misconfigured.'), 'missing client credentials'];

  const form = new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, ...grant });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetcher(provider.tokenUrl, {
      method: 'POST', body: form, signal: abort.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
    });
  } catch {
    const timedOut = abort.signal.aborted;
    return [fail(timedOut ? 504 : 502, timedOut ? 'Strava did not answer in time.' : 'Could not reach Strava.'), timedOut ? 'upstream timeout' : 'upstream unreachable'];
  } finally { clearTimeout(timer); }

  if (PASS_THROUGH.has(upstream.status)) {
    const text = await upstream.text();
    if ((upstream.status === 400 || upstream.status === 401) && refusesApplication(text)) {
      return [fail(502, 'The sign-in service is misconfigured.'), `strava refused the application (${upstream.status})`];
    }
    // Strava's refusal of the rider's grant, unchanged: the app decides (400/401 sign out, 429 retries later).
    const headers: Record<string, string> = { ...HEADERS, 'Content-Type': upstream.headers.get('content-type') || 'application/json' };
    const retry = upstream.headers.get('retry-after');
    if (retry) headers['Retry-After'] = retry;
    return [new Response(text, { status: upstream.status, headers }), 'strava refused'];
  }
  if (!upstream.ok) return [fail(502, `Strava sign-in is unavailable (HTTP ${upstream.status}).`), `upstream ${upstream.status}`];
  let data: unknown;
  try { data = await upstream.json(); } catch { data = null; }
  if (!data || typeof data !== 'object' || typeof (data as Record<string, unknown>).access_token !== 'string') {
    return [fail(502, 'Strava sent an answer the sign-in service could not read.'), 'unreadable upstream answer'];
  }
  return [json(200, provider.clean(data as Record<string, unknown>)), ''];
}

export async function handle(request: Request, env: Env, fetcher: typeof fetch = fetch): Promise<Response> {
  const started = Date.now();
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/([a-z]+)\/(config|token)$/);
  const provider = m ? PROVIDERS[m[1]] : undefined;
  const route = provider && m ? `${m[1]}/${m[2]}` : 'unknown';
  const done = (r: Response, note = '') => { log(route, r.status, started, note); return r; };
  try {
    if (fromBrowser(request)) return done(fail(403, 'This service is for the Apex Velo app only.'));
    if (!provider || !m) return done(fail(404, 'Not found.'));
    const isToken = m[2] === 'token';
    if (request.method !== (isToken ? 'POST' : 'GET')) return done(fail(405, 'Method not allowed.', { Allow: isToken ? 'POST' : 'GET' }));
    const limiter = isToken ? env.TOKEN_LIMITER : env.CONFIG_LIMITER;
    if (!limiter) return done(fail(500, 'The sign-in service is misconfigured.'), 'missing rate limiter');
    if (!(await underLimit(limiter, request, route))) return done(fail(429, 'Too many requests. Try again in a minute.', { 'Retry-After': '60' }));
    const attest = await checkAttestation(request, env);
    if (attest.refusal) return done(attest.refusal, attest.note);
    if (!isToken) {
      const creds = provider.credentials(env);
      return creds ? done(json(200, { clientId: creds.clientId })) : done(fail(500, 'The sign-in service is misconfigured.'), 'missing client credentials');
    }
    const [r, note] = await token(provider, request, env, fetcher);
    return done(r, [attest.note, note].filter(Boolean).join(' '));
  } catch {
    return done(fail(500, 'The sign-in service had a problem. Try again.'), 'unexpected error');
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> { return handle(request, env); }
} satisfies ExportedHandler<Env>;
