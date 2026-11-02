import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { resolveAuthContext } from '@/lib/api/middleware';

const USER_ID = 'user-uuid';
const COMPANY_ID = 'company-uuid';

function makeClient(options: {
  authUser?: { id: string } | null;
  authError?: unknown;
  profile?: Record<string, unknown> | null;
  profileError?: unknown;
}) {
  const single = vi
    .fn()
    .mockResolvedValue({ data: options.profile ?? null, error: options.profileError ?? null });
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single,
  };
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: options.authUser ?? null },
        error: options.authError ?? null,
      }),
    },
    from: vi.fn().mockReturnValue(chain),
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveAuthContext', () => {
  it('returns ok:false when there is no authenticated session', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeClient({ authUser: null, authError: { message: 'no session' } }),
    );

    const result = await resolveAuthContext({} as never);
    expect(result.ok).toBe(false);
  });

  it('returns ok:false when the combined profile+company query finds no row', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeClient({ authUser: { id: USER_ID }, profile: null }),
    );

    const result = await resolveAuthContext({} as never);
    expect(result.ok).toBe(false);
  });

  it('classifies a zero-row lookup (PGRST116) as unauthenticated', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeClient({
        authUser: { id: USER_ID },
        profile: null,
        profileError: { code: 'PGRST116', message: 'The result contains 0 rows' },
      }),
    );

    const result = await resolveAuthContext({} as never);
    expect(result).toMatchObject({ ok: false, kind: 'unauthenticated' });
  });

  it('classifies a failed lookup (e.g. 42501 permission denied) as unavailable, not signed out', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeClient({
        authUser: { id: USER_ID },
        profile: null,
        profileError: { code: '42501', message: 'permission denied for table profiles' },
      }),
    );

    const result = await resolveAuthContext({} as never);
    expect(result).toMatchObject({ ok: false, kind: 'unavailable' });
  });

  it('fetches profile and company in a single round trip and splits them correctly', async () => {
    const profileRow = {
      id: USER_ID,
      company_id: COMPANY_ID,
      full_name: 'Alice',
      email: 'alice@example.com',
      phone: null,
      status: 'active',
      avatar_file_id: null,
      last_login_at: null,
      created_at: '',
      updated_at: '',
      companies: {
        id: COMPANY_ID,
        name: 'Acme',
        legal_name: null,
        status: 'active',
        subscription_plan: null,
        timezone: 'UTC',
        created_at: '',
        updated_at: '',
      },
    };
    const client = makeClient({ authUser: { id: USER_ID }, profile: profileRow });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await resolveAuthContext({} as never);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Exactly one .from() call — profile and company resolved together, not
    // as two sequential queries.
    expect((client as unknown as { from: ReturnType<typeof vi.fn> }).from).toHaveBeenCalledTimes(1);
    expect((client as unknown as { from: ReturnType<typeof vi.fn> }).from).toHaveBeenCalledWith(
      'profiles',
    );

    expect(result.user).toEqual({
      id: USER_ID,
      company_id: COMPANY_ID,
      full_name: 'Alice',
      email: 'alice@example.com',
      phone: null,
      status: 'active',
      avatar_file_id: null,
      last_login_at: null,
      created_at: '',
      updated_at: '',
    });
    expect(result.user).not.toHaveProperty('companies');
    expect(result.company).toEqual(profileRow.companies);
  });
});
