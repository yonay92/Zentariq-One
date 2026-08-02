/**
 * Integration tests: company isolation
 *
 * Verifies that every service method scopes all queries to the authenticated
 * user's company_id and never leaks data across company boundaries.
 * Tests mock the Supabase client and assert that .eq('company_id', ...) is
 * always called before data is returned.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { UserService } from '@/services/users/UserService';
import { SiteService } from '@/services/sites/SiteService';
import { CompanyService } from '@/services/company/CompanyService';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AIDraftService } from '@/services/studies/AIDraftService';
import { SubjectService } from '@/services/subjects/SubjectService';
import { VisitService } from '@/services/visits/VisitService';
import { LeadService } from '@/services/recruitment/LeadService';
import { RegulatoryDocumentService } from '@/services/regulatory/RegulatoryDocumentService';
import { NotFoundError } from '@/lib/api/errors';

// ── helpers ────────────────────────────────────────────────────────────────

const COMPANY_A = 'company-a-uuid';
const COMPANY_B = 'company-b-uuid';
const USER_A = 'user-a-uuid';

function makeCtx(companyId: string, userId = USER_A) {
  return {
    user: {
      id: userId,
      company_id: companyId,
      full_name: 'Test User',
      email: 'test@example.com',
      phone: null,
      avatar_file_id: null,
      status: 'active' as const,
      last_login_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    company: {
      id: companyId,
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

/** Records every .eq() call so we can assert company_id scoping. */
function makeTrackingClient(data: unknown = [], error: unknown = null) {
  const eqCalls: Array<[string, unknown]> = [];

  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockImplementation((col: string, val: unknown) => {
      eqCalls.push([col, val]);
      return chain;
    }),
    neq: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    lte: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    maybeSingle: vi
      .fn()
      .mockResolvedValue({ data: Array.isArray(data) ? (data[0] ?? null) : data, error }),
    single: vi
      .fn()
      .mockResolvedValue({ data: Array.isArray(data) ? (data[0] ?? null) : data, error }),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    // resolve for list queries
    then: undefined as unknown,
  };

  // Make the chain thenable so `await supabase.from(...).select(...).eq(...)` works
  const makeThenable = () => {
    chain.then = undefined;
    const promise = Promise.resolve({ data, error });
    Object.assign(chain, {
      then: promise.then.bind(promise),
      catch: promise.catch.bind(promise),
      finally: promise.finally.bind(promise),
    });
    return chain;
  };

  makeThenable();

  const fromFn = vi.fn().mockReturnValue(chain);
  const client = { from: fromFn } as never;

  return { client, eqCalls, fromFn };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── UserService ────────────────────────────────────────────────────────────

describe('UserService — company isolation', () => {
  it('list() always filters by company_id from context', async () => {
    const { client, eqCalls } = makeTrackingClient([]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await UserService.list(makeCtx(COMPANY_A));

    const companyEq = eqCalls.find(([col]) => col === 'company_id');
    expect(companyEq).toBeDefined();
    expect(companyEq![1]).toBe(COMPANY_A);
  });

  it('list() uses context company_id, not a client-supplied one', async () => {
    const { client, eqCalls } = makeTrackingClient([]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    // Even if caller passes company B context, only B's data is queried
    await UserService.list(makeCtx(COMPANY_B));

    const companyEq = eqCalls.find(([col]) => col === 'company_id');
    expect(companyEq![1]).toBe(COMPANY_B);
    expect(companyEq![1]).not.toBe(COMPANY_A);
  });

  it('getById() scopes query to company_id from context', async () => {
    const userRow = {
      id: 'u1',
      company_id: COMPANY_A,
      full_name: 'Alice',
      email: 'a@a.com',
      phone: null,
      avatar_file_id: null,
      status: 'active',
      last_login_at: null,
      created_at: '',
      updated_at: '',
    };
    const { client, eqCalls } = makeTrackingClient(userRow);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await UserService.getById('u1', makeCtx(COMPANY_A));

    const companyEq = eqCalls.find(([col]) => col === 'company_id');
    expect(companyEq![1]).toBe(COMPANY_A);
  });

  it('getById() throws NotFoundError when record belongs to different company', async () => {
    // Simulate DB returning no row (RLS / company_id filter zeroed the result)
    const { client } = makeTrackingClient(null, null);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(UserService.getById('u-other-company', makeCtx(COMPANY_A))).rejects.toThrow(
      NotFoundError,
    );
  });
});

// ── SiteService ────────────────────────────────────────────────────────────

describe('SiteService — company isolation', () => {
  it('list() with view_all_sites filters by company_id', async () => {
    // Call 1: SiteService.list()'s own supabase → sites query (tracked for company_id eq)
    const { client, eqCalls } = makeTrackingClient([]);
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(client);
    // Call 2: hasPermission's supabase → rpc → true
    const rpcClient = { rpc: vi.fn().mockResolvedValue({ data: true }) };
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(rpcClient as never);

    await SiteService.list(makeCtx(COMPANY_A));

    const companyEq = eqCalls.find(([col]) => col === 'company_id');
    expect(companyEq).toBeDefined();
    expect(companyEq![1]).toBe(COMPANY_A);
  });

  it('getById() throws NotFoundError when site belongs to different company', async () => {
    // Call 1: canAccessSite's own client (placeholder — .from() not reached since hasAllSites=true)
    const { client: placeholder } = makeTrackingClient(null);
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(placeholder);
    // Call 2: hasPermission → rpc → true
    const rpcClient = { rpc: vi.fn().mockResolvedValue({ data: true }) };
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(rpcClient as never);
    // Call 3: SiteService.getById → site query → null (company_id filter excludes it)
    const { client } = makeTrackingClient(null);
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(client);

    await expect(SiteService.getById('site-other', makeCtx(COMPANY_A))).rejects.toThrow(
      NotFoundError,
    );
  });
});

// ── CompanyService ─────────────────────────────────────────────────────────

describe('CompanyService — company isolation', () => {
  it('getCurrent() queries by the exact company_id provided', async () => {
    const row = {
      id: COMPANY_A,
      name: 'Acme',
      legal_name: null,
      status: 'active',
      subscription_plan: null,
      timezone: 'UTC',
      created_at: '',
      updated_at: '',
    };
    const { client, eqCalls } = makeTrackingClient(row);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await CompanyService.getCurrent(COMPANY_A);

    const idEq = eqCalls.find(([col]) => col === 'id');
    expect(idEq![1]).toBe(COMPANY_A);
  });

  it('getCurrent() throws NotFoundError when company does not exist', async () => {
    const { client } = makeTrackingClient(null);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(CompanyService.getCurrent('nonexistent-company')).rejects.toThrow(NotFoundError);
  });

  it('getSettings() scopes query to the provided company_id', async () => {
    const { client, eqCalls } = makeTrackingClient(null);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await CompanyService.getSettings(COMPANY_A);

    const companyEq = eqCalls.find(([col]) => col === 'company_id');
    expect(companyEq![1]).toBe(COMPANY_A);
  });
});

// ── PermissionService — cross-company guard ────────────────────────────────

describe('PermissionService — company isolation', () => {
  it('validateUserExists() throws NotFoundError for user in a different company', async () => {
    // DB returns null row (company_id filter excludes cross-company user)
    const { client } = makeTrackingClient(null);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(PermissionService.validateUserExists(USER_A, COMPANY_B)).rejects.toThrow(
      NotFoundError,
    );
  });

  it('validateUserExists() scopes query to the provided company_id', async () => {
    const row = { id: USER_A, company_id: COMPANY_A };
    const { client, eqCalls } = makeTrackingClient(row);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await PermissionService.validateUserExists(USER_A, COMPANY_A);

    const companyEq = eqCalls.find(([col]) => col === 'company_id');
    expect(companyEq![1]).toBe(COMPANY_A);
  });
});

// ── SubjectService ──────────────────────────────────────────────────────────

describe('SubjectService — company isolation', () => {
  it('list() always filters by company_id from context', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const { client, eqCalls } = makeTrackingClient([]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await SubjectService.list({}, makeCtx(COMPANY_A));

    const companyEq = eqCalls.find(([col]) => col === 'company_id');
    expect(companyEq).toBeDefined();
    expect(companyEq![1]).toBe(COMPANY_A);
  });

  it('list() uses context company_id, not a client-supplied one', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const { client, eqCalls } = makeTrackingClient([]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await SubjectService.list({}, makeCtx(COMPANY_B));

    const companyEq = eqCalls.find(([col]) => col === 'company_id');
    expect(companyEq![1]).toBe(COMPANY_B);
    expect(companyEq![1]).not.toBe(COMPANY_A);
  });

  it('getById() scopes query to company_id from context', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const subjectRow = {
      id: 'subject-1',
      company_id: COMPANY_A,
      site_id: 'site-1',
      study_id: 'study-1',
      subject_number: '001-001',
      initials: null,
      status: 'pre_screening',
      screening_date: null,
      baseline_date: null,
      randomization_date: null,
      randomization_number: null,
      end_of_study_date: null,
      created_by: null,
      created_at: '',
      updated_at: '',
    };
    const { client, eqCalls } = makeTrackingClient(subjectRow);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await SubjectService.getById('subject-1', makeCtx(COMPANY_A));

    const companyEq = eqCalls.find(([col]) => col === 'company_id');
    expect(companyEq![1]).toBe(COMPANY_A);
  });

  it('getById() throws NotFoundError when the subject belongs to a different company', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const { client } = makeTrackingClient(null, null);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      SubjectService.getById('subject-other-company', makeCtx(COMPANY_A)),
    ).rejects.toThrow(NotFoundError);
  });

  it('completeVisit() scopes the initial subject lookup to company_id from context', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const { client, eqCalls } = makeTrackingClient(null, null);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      SubjectService.completeVisit(
        'subject-other-company',
        'visit-1',
        { scheduled_date: '2026-02-01' },
        makeCtx(COMPANY_A),
      ),
    ).rejects.toThrow(NotFoundError);

    const companyEq = eqCalls.find(([col]) => col === 'company_id');
    expect(companyEq).toBeDefined();
    expect(companyEq![1]).toBe(COMPANY_A);
  });
});

// ── VisitService ─────────────────────────────────────────────────────────────

describe('VisitService — company isolation', () => {
  it('confirmVisit() scopes the visit lookup to company_id from context', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const { client, eqCalls } = makeTrackingClient(null, null);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      VisitService.confirmVisit('subject-other-company', 'visit-other-company', makeCtx(COMPANY_A)),
    ).rejects.toThrow(NotFoundError);

    const companyEq = eqCalls.find(([col]) => col === 'company_id');
    expect(companyEq).toBeDefined();
    expect(companyEq![1]).toBe(COMPANY_A);
  });

  it('listCalendarEvents() scopes the range query to company_id from context', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const { client, eqCalls } = makeTrackingClient([]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await VisitService.listCalendarEvents(
      { start: '2026-02-01', end: '2026-02-28' },
      makeCtx(COMPANY_A),
    );

    const companyEq = eqCalls.find(([col]) => col === 'company_id');
    expect(companyEq).toBeDefined();
    expect(companyEq![1]).toBe(COMPANY_A);
  });

  it('listCalendarEvents() with a study_id filter scopes the visit-id resolution to company_id too, not just the final query', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const { client, eqCalls } = makeTrackingClient([]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await VisitService.listCalendarEvents(
      { start: '2026-02-01', end: '2026-02-28', study_id: 'study-x' },
      makeCtx(COMPANY_A),
    );

    // Study/CRC filters resolve through a separate `visits` (and, for CRC,
    // `study_staff`) query before narrowing calendar_events — every one of
    // those must stay scoped to the caller's company, not just the final read.
    const companyEqCalls = eqCalls.filter(([col]) => col === 'company_id');
    expect(companyEqCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of companyEqCalls) {
      expect(call[1]).toBe(COMPANY_A);
    }
  });

  it('listCalendarEvents() with a crc_user_id filter scopes the study_staff lookup to company_id', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const { client, eqCalls } = makeTrackingClient([]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await VisitService.listCalendarEvents(
      { start: '2026-02-01', end: '2026-02-28', crc_user_id: 'user-x' },
      makeCtx(COMPANY_A),
    );

    const companyEqCalls = eqCalls.filter(([col]) => col === 'company_id');
    expect(companyEqCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of companyEqCalls) {
      expect(call[1]).toBe(COMPANY_A);
    }
  });
});

// ── LeadService ──────────────────────────────────────────────────────────────

describe('LeadService — company isolation', () => {
  it('getById() scopes the lead lookup to company_id from context', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const { client, eqCalls } = makeTrackingClient(null, null);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(LeadService.getById('lead-other-company', makeCtx(COMPANY_A))).rejects.toThrow(
      NotFoundError,
    );

    const companyEq = eqCalls.find(([col]) => col === 'company_id');
    expect(companyEq).toBeDefined();
    expect(companyEq![1]).toBe(COMPANY_A);
  });

  it('list() scopes the pipeline query to company_id from context', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const { client, eqCalls } = makeTrackingClient([]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await LeadService.list({}, makeCtx(COMPANY_A));

    const companyEq = eqCalls.find(([col]) => col === 'company_id');
    expect(companyEq).toBeDefined();
    expect(companyEq![1]).toBe(COMPANY_A);
  });

  it('logContact() scopes the lead lookup to company_id from context, not just the update', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const { client, eqCalls } = makeTrackingClient(null, null);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      LeadService.logContact('lead-other-company', { new_status: 'contacted' }, makeCtx(COMPANY_A)),
    ).rejects.toThrow(NotFoundError);

    const companyEqCalls = eqCalls.filter(([col]) => col === 'company_id');
    expect(companyEqCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of companyEqCalls) {
      expect(call[1]).toBe(COMPANY_A);
    }
  });

  // do_not_contact: false so guardDangerousOperation short-circuits before
  // ever calling PermissionService.hasPermission — not what these tests are
  // checking (see the dedicated DNC-guard coverage in LeadService.test.ts).
  const scopedLead = {
    id: 'lead-other-company',
    site_id: null,
    study_id: null,
    status: 'new',
    do_not_contact: false,
  };

  it('addNote() scopes the lead lookup to company_id from context', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const { client, eqCalls } = makeTrackingClient(scopedLead);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await LeadService.addNote('lead-other-company', { body: 'note' }, makeCtx(COMPANY_A));

    const companyEqCalls = eqCalls.filter(([col]) => col === 'company_id');
    expect(companyEqCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of companyEqCalls) expect(call[1]).toBe(COMPANY_A);
  });

  it('logCall() scopes the lead lookup to company_id from context', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const { client, eqCalls } = makeTrackingClient(scopedLead);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await LeadService.logCall(
      'lead-other-company',
      { direction: 'outbound', outcome: 'answered', started_at: new Date().toISOString() },
      makeCtx(COMPANY_A),
    );

    const companyEqCalls = eqCalls.filter(([col]) => col === 'company_id');
    expect(companyEqCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of companyEqCalls) expect(call[1]).toBe(COMPANY_A);
  });

  it('createTask() scopes the lead lookup to company_id from context', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const { client, eqCalls } = makeTrackingClient(scopedLead);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await LeadService.createTask('lead-other-company', { title: 'Follow up' }, makeCtx(COMPANY_A));

    const companyEqCalls = eqCalls.filter(([col]) => col === 'company_id');
    expect(companyEqCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of companyEqCalls) expect(call[1]).toBe(COMPANY_A);
  });

  it('getStatusHistory() scopes the query to company_id from context', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const { client, eqCalls } = makeTrackingClient(scopedLead);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await LeadService.getStatusHistory('lead-other-company', makeCtx(COMPANY_A));

    const companyEqCalls = eqCalls.filter(([col]) => col === 'company_id');
    expect(companyEqCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of companyEqCalls) expect(call[1]).toBe(COMPANY_A);
  });
});

// ── RegulatoryDocumentService ─────────────────────────────────────────────────

describe('RegulatoryDocumentService — company isolation', () => {
  it('getById() scopes the document lookup to company_id from context', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const { client, eqCalls } = makeTrackingClient(null, null);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      RegulatoryDocumentService.getById('doc-other-company', makeCtx(COMPANY_A)),
    ).rejects.toThrow(NotFoundError);

    const companyEq = eqCalls.find(([col]) => col === 'company_id');
    expect(companyEq).toBeDefined();
    expect(companyEq![1]).toBe(COMPANY_A);
  });

  it('list() scopes the binder query to company_id from context, not a client-supplied one', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const { client, eqCalls } = makeTrackingClient([]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await RegulatoryDocumentService.list({}, makeCtx(COMPANY_B));

    const companyEq = eqCalls.find(([col]) => col === 'company_id');
    expect(companyEq).toBeDefined();
    expect(companyEq![1]).toBe(COMPANY_B);
    expect(companyEq![1]).not.toBe(COMPANY_A);
  });
});

// ── AIDraftService ──────────────────────────────────────────────────────────

describe('AIDraftService — company isolation', () => {
  it('getDraft() scopes query to company_id from context', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const draftRow = {
      id: 'draft-1',
      company_id: COMPANY_A,
      file_id: 'file-1',
      status: 'ready',
      confidence: 0.9,
      uncertain_fields: [],
      extracted_profile: {},
      extracted_visit_items: [],
      extracted_extra: {},
      error_message: null,
      study_id: null,
      created_by: USER_A,
      created_at: '',
      updated_at: '',
    };
    const { client, eqCalls } = makeTrackingClient(draftRow);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await AIDraftService.getDraft('draft-1', makeCtx(COMPANY_A));

    const companyEq = eqCalls.find(([col]) => col === 'company_id');
    expect(companyEq).toBeDefined();
    expect(companyEq![1]).toBe(COMPANY_A);
  });

  it('getDraft() throws NotFoundError when the draft belongs to a different company', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const { client } = makeTrackingClient(null);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      AIDraftService.getDraft('draft-other-company', makeCtx(COMPANY_A)),
    ).rejects.toThrow(NotFoundError);
  });
});
