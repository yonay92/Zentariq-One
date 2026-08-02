import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@/lib/supabase/admin';
import { LeadService } from '@/services/recruitment/LeadService';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import { SubjectService } from '@/services/subjects/SubjectService';
import { PermissionDeniedError, BusinessRuleError, NotFoundError } from '@/lib/api/errors';
import type { Lead } from '@/types/recruitment';

vi.mock('@/services/audit/AuditService', () => ({
  AuditService: { log: vi.fn() },
}));

vi.mock('@/services/subjects/SubjectService', () => ({
  SubjectService: { create: vi.fn() },
}));

const COMPANY_ID = 'company-uuid';
const SITE_ID = 'site-uuid';
const STUDY_ID = 'study-uuid';
const LEAD_ID = 'lead-uuid';
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

function baseLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: LEAD_ID,
    company_id: COMPANY_ID,
    site_id: SITE_ID,
    study_id: STUDY_ID,
    referral_source_id: null,
    initials: 'JD',
    status: 'prescreening',
    priority: 'medium',
    assigned_user_id: null,
    contact_attempt_count: 1,
    last_contacted_at: null,
    next_contact_at: null,
    waitlisted_at: null,
    consent_to_contact: false,
    do_not_contact: false,
    do_not_contact_reason: null,
    source_detail: null,
    notes_summary: null,
    converted_subject_id: null,
    converted_at: null,
    declined_reason: null,
    archived_at: null,
    archived_by: null,
    created_by: USER_ID,
    updated_by: USER_ID,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function queryStub(data: unknown, error: unknown = null) {
  const resolved = Promise.resolve({ data, error });
  const stub: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
    single: vi.fn().mockResolvedValue({ data, error }),
    then: resolved.then.bind(resolved),
    catch: resolved.catch.bind(resolved),
    finally: resolved.finally.bind(resolved),
  };
  for (const key of ['select', 'eq', 'in', 'is', 'order', 'limit', 'insert', 'update']) {
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
});

describe('LeadService.create', () => {
  it('throws PermissionDeniedError when the user lacks create_lead', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('create_lead'),
    );

    await expect(LeadService.create({}, makeCtx())).rejects.toThrow(PermissionDeniedError);
  });

  it('does not require site access when no site_id is provided (company-wide pool)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const requireSiteAccess = vi.spyOn(PermissionService, 'requireSiteAccess');
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: baseLead({ site_id: null, study_id: null }) }),
    );

    await LeadService.create({}, makeCtx());

    expect(requireSiteAccess).not.toHaveBeenCalled();
  });

  it('requires site access when a site_id is provided', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'requireSiteAccess').mockRejectedValue(
      new PermissionDeniedError(`site:${SITE_ID}`),
    );

    await expect(LeadService.create({ site_id: SITE_ID }, makeCtx())).rejects.toThrow(
      PermissionDeniedError,
    );
  });
});

describe('LeadService terminal-status guard', () => {
  it('logContact rejects a lead that is already converted', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: baseLead({ status: 'converted' }) }),
    );

    await expect(
      LeadService.logContact(LEAD_ID, { new_status: 'contacted' }, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('waitlist rejects a lead that has already been declined', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: baseLead({ status: 'declined' }) }),
    );

    await expect(LeadService.waitlist(LEAD_ID, makeCtx())).rejects.toThrow(BusinessRuleError);
  });
});

describe('LeadService.convertToSubject', () => {
  it('throws PermissionDeniedError when the user lacks convert_lead', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('convert_lead'),
    );

    await expect(
      LeadService.convertToSubject(LEAD_ID, { subject_number: '001-001' }, makeCtx()),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it('throws BusinessRuleError when the lead has no site assigned', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: baseLead({ site_id: null }) }),
    );

    await expect(
      LeadService.convertToSubject(LEAD_ID, { subject_number: '001-001' }, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('throws BusinessRuleError when the lead has no study matched', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: baseLead({ study_id: null }) }),
    );

    await expect(
      LeadService.convertToSubject(LEAD_ID, { subject_number: '001-001' }, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('throws BusinessRuleError when the latest prescreening for the matched study is not_eligible', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeSupabaseClient(
      { data: baseLead() }, // lead lookup
      { data: { computed_outcome: 'not_eligible', manual_outcome: null } }, // latest prescreening
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      LeadService.convertToSubject(LEAD_ID, { subject_number: '001-001' }, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('throws BusinessRuleError when there is no prescreening at all for the matched study', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeSupabaseClient(
      { data: baseLead() }, // lead lookup
      { data: null }, // no prescreening found
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      LeadService.convertToSubject(LEAD_ID, { subject_number: '001-001' }, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('a manual_outcome override takes precedence over computed_outcome for the eligibility gate', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeSupabaseClient(
      { data: baseLead() }, // lead lookup
      { data: { computed_outcome: 'not_eligible', manual_outcome: 'needs_review' } }, // latest prescreening
      { data: null }, // no contact info on file — fails fast before reaching SubjectService
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    // Should get past the eligibility gate (manual override says needs_review, not
    // not_eligible) and fail on the *next* guard (missing contact info) instead.
    await expect(
      LeadService.convertToSubject(LEAD_ID, { subject_number: '001-001' }, makeCtx()),
    ).rejects.toThrow('no contact information on file');
  });

  it('throws BusinessRuleError listing both missing fields when the lead has neither date of birth nor sex on file (both required by subject_contact_info)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeSupabaseClient(
      { data: baseLead() }, // lead lookup
      { data: { computed_outcome: 'potentially_eligible', manual_outcome: null } }, // latest prescreening
      {
        data: {
          first_name: 'Jane',
          last_name: 'Doe',
          date_of_birth: null,
          sex: null,
          phone_primary: '555-0100',
          phone_secondary: null,
          email: null,
          preferred_contact_method: 'phone',
        },
      }, // lead_contact_info — neither on file
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      LeadService.convertToSubject(LEAD_ID, { subject_number: '001-001' }, makeCtx()),
    ).rejects.toThrow('date of birth and sex');
    expect(SubjectService.create).not.toHaveBeenCalled();
  });

  it('throws BusinessRuleError for sex alone when date of birth is already on file', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeSupabaseClient(
      { data: baseLead() }, // lead lookup
      { data: { computed_outcome: 'potentially_eligible', manual_outcome: null } }, // latest prescreening
      {
        data: {
          first_name: 'Jane',
          last_name: 'Doe',
          date_of_birth: '1980-01-01',
          sex: null,
          phone_primary: '555-0100',
          phone_secondary: null,
          email: null,
          preferred_contact_method: 'phone',
        },
      }, // lead_contact_info — sex not on file
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      LeadService.convertToSubject(LEAD_ID, { subject_number: '001-001' }, makeCtx()),
    ).rejects.toThrow(/^This lead needs sex on file/);
    expect(SubjectService.create).not.toHaveBeenCalled();
  });

  it('converts successfully: creates the Subject, copies contact info via the admin client, and updates the lead', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(SubjectService.create).mockResolvedValue({
      id: 'subject-uuid',
      company_id: COMPANY_ID,
      site_id: SITE_ID,
      study_id: STUDY_ID,
      subject_number: '001-001',
      initials: 'JD',
      status: 'pre_screening',
      screening_date: null,
      baseline_date: null,
      randomization_date: null,
      randomization_number: null,
      end_of_study_date: null,
      created_by: USER_ID,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const contactInfo = {
      first_name: 'Jane',
      last_name: 'Doe',
      date_of_birth: '1980-01-01',
      sex: 'female',
      phone_primary: '555-0100',
      phone_secondary: null,
      email: null,
      preferred_contact_method: 'phone',
    };

    const adminInsert = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(createAdminSupabaseClient).mockReturnValue({
      from: vi.fn().mockReturnValue({ insert: adminInsert }),
    } as never);

    const client = makeSupabaseClient(
      { data: baseLead() }, // lead lookup
      { data: { computed_outcome: 'potentially_eligible', manual_outcome: null } }, // latest prescreening
      { data: contactInfo }, // lead_contact_info lookup
      { data: baseLead({ status: 'converted', converted_subject_id: 'subject-uuid' }) }, // lead update
      { data: null }, // lead_status_history insert
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await LeadService.convertToSubject(
      LEAD_ID,
      { subject_number: '001-001' },
      makeCtx(),
    );

    expect(result.subject_id).toBe('subject-uuid');
    expect(result.lead.status).toBe('converted');
    expect(SubjectService.create).toHaveBeenCalledWith(
      expect.objectContaining({ site_id: SITE_ID, study_id: STUDY_ID, subject_number: '001-001' }),
      expect.anything(),
    );
    expect(adminInsert).toHaveBeenCalledWith(
      expect.objectContaining({ subject_id: 'subject-uuid', first_name: 'Jane' }),
    );
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'lead.converted' }),
    );
  });
});

describe('LeadService.getById', () => {
  it('throws NotFoundError when the lead does not exist in this company', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(makeSupabaseClient({ data: null }));

    await expect(LeadService.getById(LEAD_ID, makeCtx())).rejects.toThrow(NotFoundError);
  });
});

describe('LeadService.assign', () => {
  it('throws PermissionDeniedError when the user lacks assign_lead', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('assign_lead'),
    );

    await expect(
      LeadService.assign(LEAD_ID, { assigned_user_id: USER_ID }, makeCtx()),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it('validates the target user exists in the company before assigning', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const validateUserExists = vi
      .spyOn(PermissionService, 'validateUserExists')
      .mockRejectedValue(new NotFoundError('User'));
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: baseLead() }),
    );

    await expect(
      LeadService.assign(LEAD_ID, { assigned_user_id: 'other-user' }, makeCtx()),
    ).rejects.toThrow(NotFoundError);
    expect(validateUserExists).toHaveBeenCalledWith('other-user', COMPANY_ID);
  });

  it('assigns the lead and audits old and new owner', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'validateUserExists').mockResolvedValue({} as never);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient(
        { data: baseLead({ assigned_user_id: null }) },
        { data: baseLead({ assigned_user_id: USER_ID }) },
      ),
    );

    const updated = await LeadService.assign(LEAD_ID, { assigned_user_id: USER_ID }, makeCtx());

    expect(updated.assigned_user_id).toBe(USER_ID);
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'lead.assigned',
        old_value: { assigned_user_id: null },
        new_value: { assigned_user_id: USER_ID },
      }),
    );
  });
});

describe('LeadService.archive', () => {
  it('throws PermissionDeniedError when the user lacks archive_lead', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('archive_lead'),
    );

    await expect(LeadService.archive(LEAD_ID, {}, makeCtx())).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it('throws BusinessRuleError when the lead is already archived', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: baseLead({ archived_at: new Date().toISOString() }) }),
    );

    await expect(LeadService.archive(LEAD_ID, {}, makeCtx())).rejects.toThrow(BusinessRuleError);
  });

  it('archives a terminal lead without being blocked by assertNotTerminal (administrative action)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient(
        { data: baseLead({ status: 'converted', archived_at: null }) },
        { data: baseLead({ status: 'converted', archived_at: new Date().toISOString() }) },
      ),
    );

    const archived = await LeadService.archive(LEAD_ID, { reason: 'cleanup' }, makeCtx());

    expect(archived.archived_at).not.toBeNull();
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'lead.archived', new_value: { reason: 'cleanup' } }),
    );
  });
});

describe('LeadService.changeStatus', () => {
  it('rejects a no-op transition to the same status', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: baseLead({ status: 'new' }) }),
    );

    await expect(
      LeadService.changeStatus(LEAD_ID, { new_status: 'new' }, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('never allows "converted" as a changeStatus target, even with a reason', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: baseLead({ status: 'screened' }) }),
    );

    await expect(
      LeadService.changeStatus(
        LEAD_ID,
        { new_status: 'converted', reason: 'trying to bypass conversion' },
        makeCtx(),
      ),
    ).rejects.toThrow(/Convert to Subject action/);
  });

  it('allows a normal transition without requiring a reason', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient(
        { data: baseLead({ status: 'new' }) },
        { data: baseLead({ status: 'contacted' }) },
        { data: null }, // lead_status_history insert
      ),
    );

    const updated = await LeadService.changeStatus(LEAD_ID, { new_status: 'contacted' }, makeCtx());

    expect(updated.status).toBe('contacted');
  });

  it('rejects an exceptional (non-normal) transition without a reason', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: baseLead({ status: 'new' }) }),
    );

    await expect(
      LeadService.changeStatus(LEAD_ID, { new_status: 'screened' }, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('allows an exceptional transition when a reason is supplied, and records it in history', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeSupabaseClient(
      { data: baseLead({ status: 'new' }) },
      { data: baseLead({ status: 'screened' }) },
      { data: null }, // lead_status_history insert
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const updated = await LeadService.changeStatus(
      LEAD_ID,
      { new_status: 'screened', reason: 'sponsor fast-tracked this participant' },
      makeCtx(),
    );

    expect(updated.status).toBe('screened');
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'lead.status_changed',
        new_value: { status: 'screened', exceptional: true },
      }),
    );
  });
});

describe('LeadService.logContact — do_not_contact guard', () => {
  it('blocks logging a contact attempt on a do_not_contact lead without an override', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    // guardDangerousOperation calls hasPermission (not requirePermission) to
    // check the override key — mocked false here to isolate the DNC-gate
    // behavior from PermissionService's own RPC/fallback internals, which
    // have their own dedicated coverage in tests/unit/PermissionService.test.ts.
    vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(false);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: baseLead({ do_not_contact: true }) }),
    );

    await expect(
      LeadService.logContact(LEAD_ID, { new_status: 'contacted' }, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('allows logging a contact attempt on a do_not_contact lead with override permission and a reason', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(true);
    const client = makeSupabaseClient(
      { data: baseLead({ do_not_contact: true, status: 'new' }) },
      { data: baseLead({ do_not_contact: true, status: 'contacted' }) },
      { data: null }, // lead_contact_log insert
      { data: null }, // lead_status_history insert
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const updated = await LeadService.logContact(
      LEAD_ID,
      { new_status: 'contacted', override_reason: 'family member confirmed it is OK to call' },
      makeCtx(),
    );

    expect(updated.status).toBe('contacted');
  });
});

describe('LeadService notes — author-only edit', () => {
  it('addNote requires create_lead_note', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('create_lead_note'),
    );

    await expect(
      LeadService.addNote(LEAD_ID, { body: 'Called, left voicemail' }, makeCtx()),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it('updateNote throws NotFoundError when the note does not exist in this lead/company', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(makeSupabaseClient({ data: null }));

    await expect(
      LeadService.updateNote(LEAD_ID, 'note-uuid', { body: 'edited' }, makeCtx()),
    ).rejects.toThrow(NotFoundError);
  });

  it('updateNote rejects editing a note created by a different user', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: { id: 'note-uuid', created_by: 'someone-else' } }),
    );

    await expect(
      LeadService.updateNote(LEAD_ID, 'note-uuid', { body: 'edited' }, makeCtx()),
    ).rejects.toThrow(/only edit your own notes/);
  });
});

describe('LeadService.list', () => {
  it('excludes archived leads by default', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeSupabaseClient({ data: [] });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await LeadService.list({}, makeCtx());

    const queryStubInstance = (client as unknown as { from: ReturnType<typeof vi.fn> }).from.mock
      .results[0]!.value as { is: ReturnType<typeof vi.fn> };
    expect(queryStubInstance.is).toHaveBeenCalledWith('archived_at', null);
  });

  it('does not filter out archived leads when include_archived is set', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeSupabaseClient({ data: [] });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await LeadService.list({ include_archived: true }, makeCtx());

    const queryStubInstance = (client as unknown as { from: ReturnType<typeof vi.fn> }).from.mock
      .results[0]!.value as { is: ReturnType<typeof vi.fn> };
    expect(queryStubInstance.is).not.toHaveBeenCalled();
  });
});
