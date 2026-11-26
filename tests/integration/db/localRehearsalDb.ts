// G8 M038 local rehearsal: helpers for tests that run against a DISPOSABLE
// local database (migrations 001–038 + synthetic fixtures) through a local
// PostgREST. Enabled only when ZQ_REHEARSAL_PGRST_URL and
// ZQ_REHEARSAL_JWT_SECRET are set; the URL must be a loopback address, so these
// tests can never reach a hosted project. Tokens are minted in memory from the
// rehearsal's random local secret and never printed.
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const PGRST_URL = process.env.ZQ_REHEARSAL_PGRST_URL ?? '';
const JWT_SECRET = process.env.ZQ_REHEARSAL_JWT_SECRET ?? '';

function isLoopback(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    return protocol === 'http:' && (hostname === '127.0.0.1' || hostname === 'localhost');
  } catch {
    return false;
  }
}

export const rehearsalDbEnabled = PGRST_URL !== '' && JWT_SECRET !== '' && isLoopback(PGRST_URL);

if (PGRST_URL !== '' && !isLoopback(PGRST_URL)) {
  throw new Error('ZQ_REHEARSAL_PGRST_URL must be a loopback http URL');
}

/** Synthetic fixture ids: md5(name) formatted as a uuid (fx.id in fixtures_038.sql). */
export function fxId(name: string): string {
  const h = crypto.createHash('md5').update(name).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

function sign(claims: Record<string, unknown>): string {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ ...claims, exp: Math.floor(Date.now() / 1000) + 600 });
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

function verify(token: string): Record<string, unknown> | null {
  const [head, body, sig] = token.split('.');
  if (!head || !body || !sig) return null;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
}

export type Caller = string | 'service_role' | 'anon';

export function tokenFor(caller: Caller): string {
  if (caller === 'anon' || caller === 'service_role') return sign({ role: caller });
  return sign({ sub: fxId(caller), role: 'authenticated', aud: 'authenticated' });
}

export type ProxyLogEntry = { role: string; method: string; path: string; status: number };

/**
 * Loopback proxy exposing the two Supabase paths the app uses, mapped onto the
 * local PostgREST: /rest/v1/* → PostgREST, GET /auth/v1/user → the verified
 * token's subject (stands in for GoTrue). Every request is logged with the
 * caller's role so tests can assert which client wrote what.
 */
export async function startProxy(): Promise<{
  url: string;
  log: ProxyLogEntry[];
  close: () => Promise<void>;
}> {
  const log: ProxyLogEntry[] = [];
  const upstream = new URL(PGRST_URL);
  const server = http.createServer((req, res) => {
    const auth = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const claims = verify(auth);
    const role = typeof claims?.role === 'string' ? claims.role : 'invalid';
    const path = req.url ?? '/';

    if (path.startsWith('/auth/v1/user')) {
      const status = claims && typeof claims.sub === 'string' ? 200 : 401;
      log.push({ role, method: req.method ?? '', path, status });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          status === 200
            ? {
                id: claims?.sub,
                aud: 'authenticated',
                role: 'authenticated',
                email: 'synthetic@example.test',
              }
            : { code: 401, msg: 'invalid token' },
        ),
      );
      return;
    }
    if (!path.startsWith('/rest/v1/')) {
      res.writeHead(404).end();
      return;
    }
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: upstream.host };
    delete headers.apikey;
    const fwd = http.request(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: path.slice('/rest/v1'.length),
        headers,
      },
      (up) => {
        log.push({ role, method: req.method ?? '', path, status: up.statusCode ?? 0 });
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    fwd.on('error', () => res.writeHead(502).end());
    req.pipe(fwd);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    log,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A supabase-js client (the app's own library) acting as `caller`. */
export function clientFor(proxyUrl: string, caller: Caller): SupabaseClient {
  return createClient(proxyUrl, tokenFor('anon'), {
    global: { headers: { Authorization: `Bearer ${tokenFor(caller)}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Stand-in for createServerSupabaseClient(): the session client of a signed-in
 * `caller`. Only auth.getUser() is adapted (no cookie session exists here); it
 * still goes through GoTrue-js and the proxy's /auth/v1/user.
 */
export function sessionClientFor(proxyUrl: string, caller: string): SupabaseClient {
  const client = clientFor(proxyUrl, caller);
  const token = tokenFor(caller);
  const getUser = client.auth.getUser.bind(client.auth);
  client.auth.getUser = ((jwt?: string) => getUser(jwt ?? token)) as typeof client.auth.getUser;
  return client;
}
