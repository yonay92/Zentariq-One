import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { LeadDuplicateService } from '@/services/recruitment/LeadDuplicateService';
import { PermissionService } from '@/services/permissions/PermissionService';
import { PermissionDeniedError } from '@/lib/api/errors';

const COMPANY_ID = 'company-uuid';
const USER_ID = 'user-uuid';

function makeCtx() {
  return {
    user: {
      id: USER_ID,
      company_id: COMPANY_ID,
      full_name: 'CRC User',
      email: 'crc@example.com',
      phone: null,
      avatar_file_id: null,
      status: 'active' as const,
      last_login_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    company: {
      id: COMPANY_ID,
      name: 'Test Company',
      legal_name: null,
      status: 'active' as const,
      subscription_plan: null,
      timezone: 'UTC',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  };
}

// Each call to .from(<table>) below returns a fresh, independently
// awaitable query stub — unlike the tests/unit/services/LeadService.test.ts
// stub (which is consumed positionally regardless of table), this one
// dispatches by table name since LeadDuplicateService issues a variable
// number of lead_contact_info queries followed by exactly one leads query,
// and the number of contact_info calls depends on which input fields are set.
function makeSupabaseClient(responses: Record<string, { data: unknown; error?: unknown }>) {
  const from = vi.fn().mockImplementation((table: string) => {
    const { data, error = null } = responses[table] ?? { data: [] };
    const stub: Record<string, unknown> = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      ilike: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
    };
    const resolved = Promise.resolve({ data, error });
    stub.then = resolved.then.bind(resolved);
    stub.catch = resolved.catch.bind(resolved);
    stub.finally = resolved.finally.bind(resolved);
    for (const key of ['select', 'eq', 'ilike', 'in']) {
      (stub[key] as ReturnType<typeof vi.fn>).mockReturnValue(stub);
    }
    return stub;
  });
  return { from } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LeadDuplicateService.checkDuplicates', () => {
  it('throws PermissionDeniedError when the user lacks view_lead_phi', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('view_lead_phi'),
    );

    await expect(
      LeadDuplicateService.checkDuplicates({ phone: '555-0100' }, makeCtx()),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it('returns no matches when nothing in lead_contact_info matches', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ lead_contact_info: { data: [] } }),
    );

    const result = await LeadDuplicateService.checkDuplicates({ phone: '555-0100' }, makeCtx());

    expect(result.possible_matches).toEqual([]);
  });

  it('matches by normalized phone and reports the lead with its match reason', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({
        lead_contact_info: { data: [{ lead_id: 'lead-1' }] },
        leads: {
          data: [
            {
              id: 'lead-1',
              initials: 'JD',
              status: 'contacted',
              site_id: 'site-1',
              study_id: null,
              archived_at: null,
            },
          ],
        },
      }),
    );

    const result = await LeadDuplicateService.checkDuplicates({ phone: '555-0100' }, makeCtx());

    expect(result.possible_matches).toEqual([
      {
        lead_id: 'lead-1',
        initials: 'JD',
        status: 'contacted',
        site_id: 'site-1',
        study_id: null,
        archived: false,
        match_reasons: ['phone_match'],
      },
    ]);
  });

  it('merges multiple match reasons for the same lead into one result entry', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({
        lead_contact_info: { data: [{ lead_id: 'lead-1' }] },
        leads: {
          data: [
            {
              id: 'lead-1',
              initials: 'JD',
              status: 'new',
              site_id: null,
              study_id: null,
              archived_at: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
      }),
    );

    const result = await LeadDuplicateService.checkDuplicates(
      { phone: '555-0100', email: 'jane@example.com' },
      makeCtx(),
    );

    expect(result.possible_matches).toHaveLength(1);
    expect(result.possible_matches[0]!.match_reasons.sort()).toEqual(
      ['email_match', 'phone_match'].sort(),
    );
    // archived leads are still surfaced — duplicate detection is not scoped
    // to active leads only (business rule: never silently merge, always warn).
    expect(result.possible_matches[0]!.archived).toBe(true);
  });

  it('does not query name+DOB or name+postal_code when only one of the pair is provided', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeSupabaseClient({ lead_contact_info: { data: [] } });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await LeadDuplicateService.checkDuplicates({ first_name: 'Jane' }, makeCtx());

    // Only phone/email/first+last+dob/first+last+postal trigger a query —
    // first_name alone matches none of those combinations.
    expect((client as unknown as { from: ReturnType<typeof vi.fn> }).from).not.toHaveBeenCalled();
  });
});
