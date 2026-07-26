import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { RegulatoryHealthService } from '@/services/regulatory/RegulatoryHealthService';
import { PermissionService } from '@/services/permissions/PermissionService';

const COMPANY_ID = 'company-uuid';
const USER_ID = 'user-uuid';

function makeCtx() {
  return {
    user: {
      id: USER_ID,
      company_id: COMPANY_ID,
      full_name: 'Regulatory User',
      email: 'reg@example.com',
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

function queryStub(data: unknown, error: unknown = null) {
  const resolved = Promise.resolve({ data, error });
  const stub: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    then: resolved.then.bind(resolved),
    catch: resolved.catch.bind(resolved),
    finally: resolved.finally.bind(resolved),
  };
  for (const key of ['select', 'eq', 'neq', 'or']) {
    (stub[key] as ReturnType<typeof vi.fn>).mockReturnValue(stub);
  }
  return stub;
}

function makeSupabaseClient(...responses: Array<{ data: unknown; error?: unknown }>) {
  const from = vi.fn();
  for (const r of responses) {
    from.mockReturnValueOnce(queryStub(r.data, r.error ?? null));
  }
  return { from } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
});

describe('RegulatoryHealthService.compute — company scope', () => {
  it('returns null score with a zero denominator when nothing is required', async () => {
    const client = makeSupabaseClient({ data: [] }, { data: [] });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await RegulatoryHealthService.compute('company', null, makeCtx());
    expect(result.score).toBeNull();
    expect(result.denominator).toBe(0);
  });

  it('computes a partial score and full breakdown across current/missing/expired', async () => {
    const requirements = [
      { document_type_id: 'type-a', study_id: null, site_id: null },
      { document_type_id: 'type-b', study_id: null, site_id: null },
      { document_type_id: 'type-c', study_id: null, site_id: null },
      { document_type_id: 'type-d', study_id: null, site_id: null },
    ];
    const documents = [
      { document_type_id: 'type-a', study_id: null, site_id: null, status: 'current' },
      { document_type_id: 'type-b', study_id: null, site_id: null, status: 'expiring_soon' },
      { document_type_id: 'type-c', study_id: null, site_id: null, status: 'expired' },
      // type-d has no matching document at all -> missing
    ];
    const client = makeSupabaseClient({ data: requirements }, { data: documents });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await RegulatoryHealthService.compute('company', null, makeCtx());
    expect(result.denominator).toBe(4);
    expect(result.numerator).toBe(2); // current + expiring_soon
    expect(result.score).toBe(50);
    expect(result.breakdown).toEqual({
      current: 1,
      expiring_soon: 1,
      expired: 1,
      missing: 1,
      pending_review: 0,
      rejected: 0,
    });
  });

  it('never reports 100% when denominator is zero even if numerator would also be zero', async () => {
    const client = makeSupabaseClient({ data: [] }, { data: [] });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await RegulatoryHealthService.compute('company', 'ignored-scope-id', makeCtx());
    expect(result.score).not.toBe(100);
    expect(result.score).toBeNull();
  });
});

describe('RegulatoryHealthService.compute — staff scope', () => {
  it('scores required document types against a specific user credentials', async () => {
    const requiredTypes = [{ id: 'gcp-type' }, { id: 'license-type' }];
    const staffDocs = [{ document_type_id: 'gcp-type', status: 'current' }];
    const client = makeSupabaseClient({ data: requiredTypes }, { data: staffDocs });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await RegulatoryHealthService.compute('staff', USER_ID, makeCtx());
    expect(result.scope).toBe('staff');
    expect(result.denominator).toBe(2);
    expect(result.numerator).toBe(1);
    expect(result.breakdown.missing).toBe(1);
  });
});
