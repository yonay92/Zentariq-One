import { type NextRequest } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import type { Profile, Company } from '@/types/users';

export type AuthContext = {
  user: Profile;
  company: Company;
};

/**
 * `kind` distinguishes "there is no usable identity" (no session, or no
 * active profile/company — respond 401) from "the identity could not be
 * loaded" (the lookup itself failed — a server-side fault, not a sign-in
 * problem). Routes that only check `ok` keep their existing behaviour.
 */
type AuthResult =
  | { ok: true; user: Profile; company: Company }
  | { ok: false; kind: 'unauthenticated' | 'unavailable'; reason: string };

type ProfileWithCompany = Profile & { companies: Company };

// PostgREST: `.single()` matched zero rows.
const NO_ROWS = 'PGRST116';

export async function resolveAuthContext(request: NextRequest): Promise<AuthResult> {
  const supabase = await createServerSupabaseClient();

  const {
    data: { user: authUser },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !authUser) {
    return { ok: false, kind: 'unauthenticated', reason: 'No authenticated session' };
  }

  // Single round trip for both profile and company (previously two sequential
  // queries) — this runs on every API request, so the saved round trip compounds
  // across a page's whole fetch waterfall.
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select(
      `id, company_id, full_name, email, phone, status, avatar_file_id, last_login_at, created_at, updated_at,
       companies!inner(id, name, legal_name, status, subscription_plan, timezone, created_at, updated_at)`,
    )
    .eq('id', authUser.id)
    .eq('status', 'active')
    .eq('companies.status', 'active')
    .single();

  if (profileError && profileError.code !== NO_ROWS) {
    logger.error('resolveAuthContext: profile lookup failed', { code: profileError.code ?? null });
    return { ok: false, kind: 'unavailable', reason: 'User profile could not be loaded' };
  }

  if (!profile) {
    return {
      ok: false,
      kind: 'unauthenticated',
      reason: 'User profile or company not found or inactive',
    };
  }

  const { companies: company, ...user } = profile as unknown as ProfileWithCompany;

  // Attach to request headers for downstream use (avoids repeated DB calls)
  void request;

  return { ok: true, user, company };
}
