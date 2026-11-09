// @vitest-environment node
/**
 * AuthService — sign-in outcome mapping and session cleanup (G7 remediation).
 *
 * Regression net for the production incident where Supabase accepted the
 * password, the post-login profile read failed (42501), the user was told
 * "Invalid email or password", and the session cookies were left behind.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cookies } from 'next/headers';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { AuthService, SIGN_IN_MESSAGES } from '@/services/auth/AuthService';
import { AuditService } from '@/services/audit/AuditService';
import { logger } from '@/lib/logger';
import {
  AuthError,
  NotFoundError,
  RateLimitError,
  ServiceUnavailableError,
} from '@/lib/api/errors';

vi.mock('@/services/audit/AuditService', () => ({ AuditService: { log: vi.fn() } }));

const USER_ID = '11111111-1111-4111-8111-111111111111';
const COMPANY_ID = '22222222-2222-4222-8222-222222222222';
const SESSION = { access_token: 'redacted-test-token' };

const PROFILE = {
  id: USER_ID,
  company_id: COMPANY_ID,
  full_name: 'Ada Lovelace',
  email: 'ada@example.test',
  phone: null,
  status: 'active',
  avatar_file_id: null,
  last_login_at: null,
  created_at: '',
  updated_at: '',
};

type AuthErr = { code?: string; status?: number; message: string } | null;

function makeClient(opts: {
  signInError?: AuthErr;
  session?: object | null;
  profileRow?: Record<string, unknown> | null;
  profileError?: { code: string; message: string } | null;
  signOutError?: { code?: string; status?: number } | null;
  signOutThrows?: boolean;
}) {
  const maybeSingle = vi
    .fn()
    .mockResolvedValue({ data: opts.profileRow ?? null, error: opts.profileError ?? null });
  const selectChain = { eq: vi.fn().mockReturnValue({ maybeSingle }) };
  const updateEq = vi.fn().mockResolvedValue({ error: null });
  const from = vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue(selectChain),
    update: vi.fn().mockReturnValue({ eq: updateEq }),
  });
  const signOut = opts.signOutThrows
    ? vi.fn().mockRejectedValue(new Error('network down'))
    : vi.fn().mockResolvedValue({ error: opts.signOutError ?? null });
  const signInWithPassword = vi.fn().mockResolvedValue(
    opts.signInError
      ? { data: { session: null, user: null }, error: opts.signInError }
      : {
          data: {
            session: opts.session === undefined ? SESSION : opts.session,
            user: { id: USER_ID },
          },
          error: null,
        },
  );
  const client = { auth: { signInWithPassword, signOut }, from };
  vi.mocked(createServerSupabaseClient).mockResolvedValue(client as never);
  return { client, signOut, signInWithPassword, from, maybeSingle, updateEq };
}

// Supabase auth cookies present on the request (values are never inspected).
const cookieDelete = vi.fn();
function withAuthCookies() {
  vi.mocked(cookies).mockReturnValue({
    getAll: () => [
      { name: 'sb-abcdefghijklmnopqrst-auth-token.0', value: 'x' },
      { name: 'sb-abcdefghijklmnopqrst-auth-token.1', value: 'x' },
      { name: 'theme', value: 'dark' },
    ],
    delete: cookieDelete,
    get: vi.fn(),
    set: vi.fn(),
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  withAuthCookies();
});

describe('AuthService.signIn', () => {
  it('correct password + active profile: returns the profile, audits, updates last_login_at', async () => {
    const { signOut, updateEq } = makeClient({
      profileRow: { ...PROFILE, companies: { status: 'active' } },
    });

    const result = await AuthService.signIn('ada@example.test', 'correct-horse');

    expect(result.profile).toEqual(PROFILE);
    expect(result.profile).not.toHaveProperty('companies');
    expect(updateEq).toHaveBeenCalledWith('id', USER_ID);
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.login', company_id: COMPANY_ID, user_id: USER_ID }),
    );
    expect(signOut).not.toHaveBeenCalled();
    expect(cookieDelete).not.toHaveBeenCalled();
  });

  it('incorrect password: "Invalid email or password", no profile query, nothing to clean up', async () => {
    const { from, signOut } = makeClient({
      signInError: {
        code: 'invalid_credentials',
        status: 400,
        message: 'Invalid login credentials',
      },
    });

    await expect(AuthService.signIn('ada@example.test', 'wrong')).rejects.toEqual(
      new AuthError(SIGN_IN_MESSAGES.invalidCredentials),
    );
    expect(from).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(AuditService.log).not.toHaveBeenCalled();
  });

  it('recognises invalid credentials from older Auth servers without an error code', async () => {
    makeClient({ signInError: { status: 400, message: 'Invalid login credentials' } });
    await expect(AuthService.signIn('a@example.test', 'x')).rejects.toBeInstanceOf(AuthError);
  });

  it('correct password + profile lookup denied (42501): ends the session and reports a load failure', async () => {
    const { signOut } = makeClient({
      profileError: { code: '42501', message: 'permission denied for table profiles' },
    });

    const err = await AuthService.signIn('ada@example.test', 'correct-horse').catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect((err as Error).message).toBe(SIGN_IN_MESSAGES.profileUnavailable);
    expect((err as Error).message).not.toMatch(/invalid email or password/i);
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(cookieDelete).toHaveBeenCalledTimes(2);
    expect(cookieDelete).toHaveBeenCalledWith('sb-abcdefghijklmnopqrst-auth-token.0');
    expect(cookieDelete).not.toHaveBeenCalledWith('theme');
    expect(AuditService.log).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), { code: '42501' });
  });

  it('never logs credentials or tokens on failure', async () => {
    makeClient({ profileError: { code: '42501', message: 'denied' } });
    await AuthService.signIn('ada@example.test', 'correct-horse').catch(() => undefined);
    const logged = JSON.stringify([
      vi.mocked(logger.error).mock.calls,
      vi.mocked(logger.warn).mock.calls,
    ]);
    expect(logged).not.toContain('correct-horse');
    expect(logged).not.toContain('redacted-test-token');
    expect(logged).not.toContain('ada@example.test');
  });

  it('still clears the auth cookies when Supabase session revocation fails', async () => {
    makeClient({ profileError: { code: '42501', message: 'denied' }, signOutThrows: true });
    await expect(AuthService.signIn('a@example.test', 'pw')).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    expect(cookieDelete).toHaveBeenCalledTimes(2);
  });

  it('correct password + no profile row: ends the session and throws NotFoundError', async () => {
    const { signOut } = makeClient({ profileRow: null });
    await expect(AuthService.signIn('a@example.test', 'pw')).rejects.toBeInstanceOf(NotFoundError);
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(cookieDelete).toHaveBeenCalled();
  });

  it('deactivated profile: ends every session of that user (global) and says so', async () => {
    const { signOut } = makeClient({
      profileRow: { ...PROFILE, status: 'inactive', companies: { status: 'active' } },
    });
    await expect(AuthService.signIn('a@example.test', 'pw')).rejects.toEqual(
      new AuthError(SIGN_IN_MESSAGES.deactivated),
    );
    expect(signOut).toHaveBeenCalledWith({ scope: 'global' });
    expect(AuditService.log).not.toHaveBeenCalled();
  });

  it('inactive company: ends the session instead of leaving a half-signed-in browser', async () => {
    const { signOut } = makeClient({
      profileRow: { ...PROFILE, companies: { status: 'suspended' } },
    });
    await expect(AuthService.signIn('a@example.test', 'pw')).rejects.toEqual(
      new AuthError(SIGN_IN_MESSAGES.companyInactive),
    );
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('rate limited by Supabase Auth: RateLimitError', async () => {
    makeClient({
      signInError: { code: 'over_request_rate_limit', status: 429, message: 'slow down' },
    });
    await expect(AuthService.signIn('a@example.test', 'pw')).rejects.toBeInstanceOf(RateLimitError);
  });

  it('unexpected Auth server error during login: ServiceUnavailableError, not "invalid credentials"', async () => {
    const { from } = makeClient({
      signInError: { code: 'unexpected_failure', status: 500, message: 'boom' },
    });
    await expect(AuthService.signIn('a@example.test', 'pw')).rejects.toEqual(
      new ServiceUnavailableError(SIGN_IN_MESSAGES.unavailable),
    );
    expect(from).not.toHaveBeenCalled();
  });

  it('other 4xx from Supabase Auth (e.g. unconfirmed email): generic not-permitted message', async () => {
    makeClient({
      signInError: { code: 'email_not_confirmed', status: 400, message: 'Email not confirmed' },
    });
    await expect(AuthService.signIn('a@example.test', 'pw')).rejects.toEqual(
      new AuthError(SIGN_IN_MESSAGES.notPermitted),
    );
  });
});

describe('AuthService.signOut', () => {
  it('with a resolved profile: audits auth.logout, then ends the session globally', async () => {
    const { signOut } = makeClient({});
    await AuthService.signOut({ userId: USER_ID, companyId: COMPANY_ID });

    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.logout', user_id: USER_ID, company_id: COMPANY_ID }),
    );
    expect(signOut).toHaveBeenCalledWith({ scope: 'global' });
    const auditOrder = vi.mocked(AuditService.log).mock.invocationCallOrder[0]!;
    expect(auditOrder).toBeLessThan(signOut.mock.invocationCallOrder[0]!);
    expect(cookieDelete).toHaveBeenCalledTimes(2);
  });

  it('without a profile (missing or inaccessible): no audit, session still ended', async () => {
    const { signOut } = makeClient({});
    await AuthService.signOut(null);

    expect(AuditService.log).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledWith({ scope: 'global' });
    expect(cookieDelete).toHaveBeenCalledTimes(2);
  });

  it('Supabase revocation error: still resolves and clears the cookies', async () => {
    makeClient({ signOutError: { code: 'unexpected_failure', status: 500 } });
    await expect(AuthService.signOut(null)).resolves.toBeUndefined();
    expect(cookieDelete).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), {
      code: 'unexpected_failure',
      status: 500,
    });
  });
});
