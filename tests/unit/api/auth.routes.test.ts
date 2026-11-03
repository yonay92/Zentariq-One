// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { AuthService } from '@/services/auth/AuthService';
import { clearSupabaseAuthCookies } from '@/lib/supabase/session';
import {
  AuthError,
  NotFoundError,
  RateLimitError,
  ServiceUnavailableError,
} from '@/lib/api/errors';
import { POST as signinPOST } from '@/app/api/auth/signin/route';
import { POST as signoutPOST } from '@/app/api/auth/signout/route';
import { GET as meGET } from '@/app/api/users/me/route';

vi.mock('@/lib/api/middleware', () => ({ resolveAuthContext: vi.fn() }));
vi.mock('@/lib/supabase/session', () => ({ clearSupabaseAuthCookies: vi.fn() }));
vi.mock('@/services/auth/AuthService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/auth/AuthService')>();
  return {
    SIGN_IN_MESSAGES: actual.SIGN_IN_MESSAGES,
    AuthService: { signIn: vi.fn(), signOut: vi.fn() },
  };
});

const USER = { id: 'user-1', full_name: 'Ada Lovelace' };
const COMPANY = { id: 'company-1', name: 'Example Research' };

function req(path: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
      : {}),
  });
}

async function json(res: Response) {
  return (await res.json()) as {
    success: boolean;
    data?: unknown;
    error?: { code: string; message: string };
  };
}

const signin = (body: unknown = { email: 'ada@example.test', password: 'pw' }) =>
  signinPOST(req('/api/auth/signin', 'POST', body));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(clearSupabaseAuthCookies).mockResolvedValue(0);
});

describe('POST /api/auth/signin', () => {
  it('200 with the profile on success', async () => {
    vi.mocked(AuthService.signIn).mockResolvedValue({ profile: USER as never, session: {} });
    const res = await signin();
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ success: true, data: { profile: USER } });
  });

  it('401 "Invalid email or password" only for invalid credentials', async () => {
    vi.mocked(AuthService.signIn).mockRejectedValue(new AuthError('Invalid email or password'));
    const res = await signin();
    expect(res.status).toBe(401);
    expect((await json(res)).error).toEqual({
      code: 'UNAUTHORIZED',
      message: 'Invalid email or password',
    });
  });

  it('503 with a load-failure message when the profile cannot be read (the G7 incident)', async () => {
    vi.mocked(AuthService.signIn).mockRejectedValue(
      new ServiceUnavailableError('Your account could not be loaded. Please try again later.'),
    );
    const res = await signin();
    expect(res.status).toBe(503);
    const body = await json(res);
    expect(body.error?.code).toBe('SERVICE_UNAVAILABLE');
    expect(body.error?.message).toBe('Your account could not be loaded. Please try again later.');
  });

  it('401 with an explicit message when no profile is linked', async () => {
    vi.mocked(AuthService.signIn).mockRejectedValue(new NotFoundError('User profile'));
    const res = await signin();
    expect(res.status).toBe(401);
    expect((await json(res)).error?.message).toMatch(/no active account/i);
  });

  it('429 when Supabase Auth rate-limits', async () => {
    vi.mocked(AuthService.signIn).mockRejectedValue(new RateLimitError('Too many attempts'));
    const res = await signin();
    expect(res.status).toBe(429);
    expect((await json(res)).error?.code).toBe('RATE_LIMITED');
  });

  it('500 with a generic message for unexpected errors — internal detail never leaks', async () => {
    vi.mocked(AuthService.signIn).mockRejectedValue(
      new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'),
    );
    const res = await signin();
    expect(res.status).toBe(500);
    const text = JSON.stringify(await json(res));
    expect(text).not.toContain('ECONNREFUSED');
    expect(text).not.toContain('hunter2');
    expect(text).toContain('temporarily unavailable');
  });

  it('400 for an invalid body without calling AuthService', async () => {
    const res = await signin({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(AuthService.signIn).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/signout', () => {
  it('with a valid profile: signs out with the actor for the audit entry', async () => {
    vi.mocked(resolveAuthContext).mockResolvedValue({
      ok: true,
      user: USER as never,
      company: COMPANY as never,
    });
    const res = await signoutPOST(req('/api/auth/signout', 'POST'));
    expect(res.status).toBe(200);
    expect(AuthService.signOut).toHaveBeenCalledWith({ userId: 'user-1', companyId: 'company-1' });
  });

  it.each(['unauthenticated', 'unavailable'] as const)(
    'with a %s profile: still ends the session (no actor, no audit)',
    async (kind) => {
      vi.mocked(resolveAuthContext).mockResolvedValue({ ok: false, kind, reason: 'x' });
      const res = await signoutPOST(req('/api/auth/signout', 'POST'));
      expect(res.status).toBe(200);
      expect(AuthService.signOut).toHaveBeenCalledWith(null);
    },
  );

  it('if sign-out itself throws: 500, and the auth cookies are still expired', async () => {
    vi.mocked(resolveAuthContext).mockResolvedValue({
      ok: false,
      kind: 'unauthenticated',
      reason: 'x',
    });
    vi.mocked(AuthService.signOut).mockRejectedValue(new Error('env missing'));
    const res = await signoutPOST(req('/api/auth/signout', 'POST'));
    expect(res.status).toBe(500);
    expect(clearSupabaseAuthCookies).toHaveBeenCalled();
  });
});

describe('GET /api/users/me', () => {
  it('200 with profile and company', async () => {
    vi.mocked(resolveAuthContext).mockResolvedValue({
      ok: true,
      user: USER as never,
      company: COMPANY as never,
    });
    const res = await meGET(req('/api/users/me'));
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ data: { profile: USER, company: COMPANY } });
  });

  it('401 when there is no usable identity', async () => {
    vi.mocked(resolveAuthContext).mockResolvedValue({
      ok: false,
      kind: 'unauthenticated',
      reason: 'x',
    });
    expect((await meGET(req('/api/users/me'))).status).toBe(401);
  });

  it('503 (not 401) when the identity lookup failed', async () => {
    vi.mocked(resolveAuthContext).mockResolvedValue({
      ok: false,
      kind: 'unavailable',
      reason: 'x',
    });
    const res = await meGET(req('/api/users/me'));
    expect(res.status).toBe(503);
    expect((await json(res)).error?.code).toBe('SERVICE_UNAVAILABLE');
  });
});
