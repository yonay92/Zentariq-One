import { createServerSupabaseClient } from '@/lib/supabase/server';
import { clearSupabaseAuthCookies } from '@/lib/supabase/session';
import {
  AuthError,
  NotFoundError,
  RateLimitError,
  ServiceUnavailableError,
} from '@/lib/api/errors';
import { AuditService } from '@/services/audit/AuditService';
import { logger } from '@/lib/logger';
import type { Profile } from '@/types/users';

type ServerSupabaseClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

const PROFILE_COLUMNS =
  'id, company_id, full_name, email, phone, status, avatar_file_id, last_login_at, created_at, updated_at';

export const SIGN_IN_MESSAGES = {
  invalidCredentials: 'Invalid email or password',
  rateLimited: 'Too many sign-in attempts. Please wait a few minutes and try again.',
  notPermitted: 'Sign-in is not permitted for this account. Contact your administrator.',
  unavailable: 'Sign-in is temporarily unavailable. Please try again later.',
  profileUnavailable: 'Your account could not be loaded. Please try again later.',
  deactivated: 'Your account has been deactivated. Contact your administrator.',
  companyInactive: "Your organization's account is inactive. Contact your administrator.",
} as const;

type AuthProviderError = {
  code?: string | undefined;
  status?: number | undefined;
  message: string;
};

function isInvalidCredentials(error: AuthProviderError): boolean {
  return (
    error.code === 'invalid_credentials' ||
    (error.status === 400 && /invalid login credentials/i.test(error.message))
  );
}

/**
 * Ends the Supabase session for the current request. Revocation with Supabase
 * Auth is best effort (its failure is logged by code/status only, never with
 * tokens); the auth cookies are always expired afterwards so the browser can
 * never keep a session the application has rejected. Never throws.
 */
async function endSession(
  supabase: ServerSupabaseClient,
  scope: 'global' | 'local',
): Promise<void> {
  try {
    const { error } = await supabase.auth.signOut({ scope });
    if (error) {
      logger.warn('AuthService: Supabase session revocation failed', {
        code: error.code ?? null,
        status: error.status ?? null,
      });
    }
  } catch (err) {
    logger.warn('AuthService: Supabase session revocation threw', {
      errorName: err instanceof Error ? err.name : 'unknown',
    });
  }
  try {
    await clearSupabaseAuthCookies();
  } catch (err) {
    logger.warn('AuthService: auth cookie cleanup failed', {
      errorName: err instanceof Error ? err.name : 'unknown',
    });
  }
}

export const AuthService = {
  async signIn(email: string, password: string): Promise<{ profile: Profile; session: object }> {
    const supabase = await createServerSupabaseClient();

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      if (isInvalidCredentials(error)) throw new AuthError(SIGN_IN_MESSAGES.invalidCredentials);
      if (error.status === 429 || error.code === 'over_request_rate_limit') {
        throw new RateLimitError(SIGN_IN_MESSAGES.rateLimited);
      }
      logger.error('AuthService.signIn: Supabase Auth rejected the sign-in request', {
        code: error.code ?? null,
        status: error.status ?? null,
      });
      if (error.status !== undefined && error.status >= 400 && error.status < 500) {
        throw new AuthError(SIGN_IN_MESSAGES.notPermitted);
      }
      throw new ServiceUnavailableError(SIGN_IN_MESSAGES.unavailable);
    }
    if (!data.session || !data.user) {
      logger.error('AuthService.signIn: Supabase Auth returned no session');
      throw new ServiceUnavailableError(SIGN_IN_MESSAGES.unavailable);
    }

    // From here on Supabase has issued a session (and set its cookies). Any
    // application-level rejection must end that session before throwing, or
    // the browser stays signed in behind an error message.
    const userId = data.user.id;
    const { data: row, error: profileError } = await supabase
      .from('profiles')
      .select(`${PROFILE_COLUMNS}, companies!inner(status)`)
      .eq('id', userId)
      .maybeSingle();

    if (profileError) {
      logger.error('AuthService.signIn: profile lookup failed after successful authentication', {
        code: profileError.code ?? null,
      });
      await endSession(supabase, 'local');
      throw new ServiceUnavailableError(SIGN_IN_MESSAGES.profileUnavailable);
    }

    if (!row) {
      logger.warn('AuthService.signIn: authenticated user has no profile', { userId });
      await endSession(supabase, 'local');
      throw new NotFoundError('User profile');
    }

    const { companies, ...profile } = row as unknown as Profile & {
      companies: { status: string };
    };

    if (profile.status !== 'active') {
      await endSession(supabase, 'global');
      throw new AuthError(SIGN_IN_MESSAGES.deactivated);
    }

    if (companies.status !== 'active') {
      await endSession(supabase, 'local');
      throw new AuthError(SIGN_IN_MESSAGES.companyInactive);
    }

    const { error: lastLoginError } = await supabase
      .from('profiles')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', userId);
    if (lastLoginError) {
      logger.warn('AuthService.signIn: last_login_at update failed', {
        code: lastLoginError.code ?? null,
      });
    }

    await AuditService.log({
      company_id: profile.company_id,
      user_id: userId,
      action: 'auth.login',
      module: 'auth',
      record_type: 'profile',
      record_id: userId,
    });

    return { profile, session: data.session };
  },

  /**
   * Signs the current request's user out. `actor` is the resolved
   * application identity when there is one; the logout is audited only then.
   * The session is ended regardless — sign-out must not depend on a profile
   * lookup succeeding, and an audit failure never blocks it (AuditService.log
   * does not throw).
   */
  async signOut(actor: { userId: string; companyId: string } | null): Promise<void> {
    const supabase = await createServerSupabaseClient();

    if (actor) {
      await AuditService.log({
        company_id: actor.companyId,
        user_id: actor.userId,
        action: 'auth.logout',
        module: 'auth',
        record_type: 'profile',
        record_id: actor.userId,
      });
    }

    await endSession(supabase, 'global');
  },

  async getCurrentUser(): Promise<Profile | null> {
    const supabase = await createServerSupabaseClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    const { data } = await supabase
      .from('profiles')
      .select(
        'id, company_id, full_name, email, phone, status, avatar_file_id, last_login_at, created_at, updated_at',
      )
      .eq('id', user.id)
      .eq('status', 'active')
      .single();

    return (data as Profile) ?? null;
  },

  async sendPasswordReset(email: string): Promise<void> {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/reset-password`,
    });
    if (error) {
      throw new AuthError('Failed to send password reset email');
    }
  },

  async updatePassword(newPassword: string): Promise<void> {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) {
      throw new AuthError('Failed to update password: ' + error.message);
    }
  },
};
