import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@/lib/supabase/admin';
import { StudyService, resolveAiVisitTemplateBaseline } from '@/services/studies/StudyService';
import { PermissionService } from '@/services/permissions/PermissionService';
import { VisitTemplateService } from '@/services/visit-templates/VisitTemplateService';
import { AuditService } from '@/services/audit/AuditService';
import { NotificationService } from '@/services/notifications/NotificationService';
import { FileService } from '@/services/files/FileService';
import { PermissionDeniedError, BusinessRuleError, DatabaseError } from '@/lib/api/errors';
import type { FileLink } from '@/types/files';

vi.mock('@/services/audit/AuditService', () => ({
  AuditService: { log: vi.fn() },
}));

vi.mock('@/services/notifications/NotificationService', () => ({
  NotificationService: { dispatch: vi.fn() },
}));

vi.mock('@/services/visit-templates/VisitTemplateService', () => ({
  VisitTemplateService: {
    hasApprovedTemplate: vi.fn(),
    createTemplate: vi.fn(),
  },
}));

const COMPANY_ID = 'company-uuid';
const STUDY_ID = 'study-uuid';
const SITE_ID = 'site-uuid';
const USER_ID = 'user-uuid';

function makeCtx() {
  return {
    user: {
      id: USER_ID,
      company_id: COMPANY_ID,
      full_name: 'Admin User',
      email: 'admin@example.com',
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

function queryStub(data: unknown, error: unknown = null, count: number | null = null) {
  const resolved = Promise.resolve({ data, error, count });
  const stub: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
    single: vi.fn().mockResolvedValue({ data, error }),
    in: vi.fn().mockReturnThis(),
    then: resolved.then.bind(resolved),
    catch: resolved.catch.bind(resolved),
    finally: resolved.finally.bind(resolved),
  };
  for (const key of [
    'select',
    'eq',
    'neq',
    'order',
    'limit',
    'insert',
    'update',
    'upsert',
    'delete',
    'in',
  ]) {
    (stub[key] as ReturnType<typeof vi.fn>).mockReturnValue(stub);
  }
  return stub;
}

function makeSupabaseClient(
  ...responses: Array<{ data: unknown; error?: unknown; count?: number | null }>
) {
  const from = vi.fn();
  for (const r of responses) {
    from.mockReturnValueOnce(queryStub(r.data, r.error ?? null, r.count ?? null));
  }
  return { from } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('StudyService.create', () => {
  it('throws PermissionDeniedError when user lacks create_study', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('create_study'),
    );

    await expect(StudyService.create({ study_name: 'Study A' }, makeCtx())).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it('creates a study and writes an audit log when permitted', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const studyRow = {
      id: STUDY_ID,
      company_id: COMPANY_ID,
      study_name: 'Study A',
      status: 'draft',
    };
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient({ data: studyRow }),
    );

    const result = await StudyService.create({ study_name: 'Study A' }, makeCtx());

    expect(result.id).toBe(STUDY_ID);
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'study.created', record_id: STUDY_ID }),
    );
  });
});

describe('StudyService.activateStudy', () => {
  it('throws BusinessRuleError when no approved visit template exists', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const studyRow = {
      id: STUDY_ID,
      company_id: COMPANY_ID,
      study_name: 'Study A',
      status: 'draft',
    };
    // getById() query
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient({ data: studyRow }),
    );
    vi.mocked(VisitTemplateService.hasApprovedTemplate).mockResolvedValue(false);

    await expect(StudyService.activateStudy(STUDY_ID, makeCtx())).rejects.toThrow(
      BusinessRuleError,
    );
  });

  it('activates the study once an approved visit template exists', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const draftStudy = {
      id: STUDY_ID,
      company_id: COMPANY_ID,
      study_name: 'Study A',
      status: 'draft',
    };
    const activatedStudy = { ...draftStudy, status: 'active' };

    // createServerSupabaseClient() is called twice in activateStudy (once inside
    // getById, once directly) — return the same client both times so its queued
    // .from() responses (1: getById study, 2: update to active, 3: document_types) resolve in order.
    const client = makeSupabaseClient({ data: draftStudy }, { data: activatedStudy }, { data: [] });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);
    vi.mocked(VisitTemplateService.hasApprovedTemplate).mockResolvedValue(true);
    vi.mocked(createAdminSupabaseClient).mockReturnValue(makeSupabaseClient({ data: [] }) as never);

    const result = await StudyService.activateStudy(STUDY_ID, makeCtx());

    expect(result.status).toBe('active');
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'study.activated' }),
    );
  });
});

describe('StudyService.archiveStudy', () => {
  it('returns the study unchanged when it is already archived', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const archivedStudy = {
      id: STUDY_ID,
      company_id: COMPANY_ID,
      study_name: 'Study A',
      status: 'archived',
    };
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient({ data: archivedStudy }),
    );

    const result = await StudyService.archiveStudy(STUDY_ID, makeCtx());

    expect(result.status).toBe('archived');
    expect(AuditService.log).not.toHaveBeenCalled();
  });

  it('throws BusinessRuleError when subjects are enrolled and the caller lacks force_archive_study', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(false);

    const studyRow = {
      id: STUDY_ID,
      company_id: COMPANY_ID,
      study_name: 'Study A',
      status: 'active',
    };
    const client = makeSupabaseClient(
      { data: studyRow }, // getById
      { data: null, count: 3 }, // enrolled subjects count
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(StudyService.archiveStudy(STUDY_ID, makeCtx())).rejects.toThrow(BusinessRuleError);
  });

  it('archives directly when there are no enrolled subjects', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const hasPermissionSpy = vi.spyOn(PermissionService, 'hasPermission');

    const studyRow = {
      id: STUDY_ID,
      company_id: COMPANY_ID,
      study_name: 'Study A',
      status: 'active',
    };
    const archivedStudy = { ...studyRow, status: 'archived' };
    const client = makeSupabaseClient(
      { data: studyRow }, // getById
      { data: null, count: 0 }, // enrolled subjects count
      { data: archivedStudy }, // update
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await StudyService.archiveStudy(STUDY_ID, makeCtx());

    expect(result.status).toBe('archived');
    expect(hasPermissionSpy).not.toHaveBeenCalled();
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'study.archived',
        new_value: expect.objectContaining({ enrolled_subject_count: 0, forced: false }),
      }),
    );
  });

  it('throws BusinessRuleError when the caller holds force_archive_study but gives no reason', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(true);

    const studyRow = {
      id: STUDY_ID,
      company_id: COMPANY_ID,
      study_name: 'Study A',
      status: 'active',
    };
    const client = makeSupabaseClient(
      { data: studyRow }, // getById
      { data: null, count: 2 }, // enrolled subjects count
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(StudyService.archiveStudy(STUDY_ID, makeCtx())).rejects.toThrow(BusinessRuleError);
  });

  it('archives with enrolled subjects when the caller holds force_archive_study and gives a reason', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(true);

    const studyRow = {
      id: STUDY_ID,
      company_id: COMPANY_ID,
      study_name: 'Study A',
      status: 'active',
    };
    const archivedStudy = { ...studyRow, status: 'archived' };
    const client = makeSupabaseClient(
      { data: studyRow },
      { data: null, count: 2 },
      { data: archivedStudy },
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await StudyService.archiveStudy(
      STUDY_ID,
      makeCtx(),
      'Sponsor requested early termination',
    );

    expect(result.status).toBe('archived');
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'study.archived',
        new_value: expect.objectContaining({
          enrolled_subject_count: 2,
          forced: true,
          reason: 'Sponsor requested early termination',
        }),
      }),
    );
  });
});

describe('StudyService.list — archived visibility', () => {
  it('excludes archived studies by default', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const client = makeSupabaseClient({ data: [{ id: 's1', status: 'active' }] });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await StudyService.list({}, makeCtx());

    const fromMock = (client as { from: ReturnType<typeof vi.fn> }).from;
    const usedStub = fromMock.mock.results[0]?.value as { neq: ReturnType<typeof vi.fn> };
    expect(usedStub.neq).toHaveBeenCalledWith('status', 'archived');
  });

  it('returns only archived studies when view=archived', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const client = makeSupabaseClient({ data: [{ id: 's1', status: 'archived' }] });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await StudyService.list({ view: 'archived' }, makeCtx());

    const fromMock = (client as { from: ReturnType<typeof vi.fn> }).from;
    const usedStub = fromMock.mock.results[0]?.value as { eq: ReturnType<typeof vi.fn> };
    expect(usedStub.eq).toHaveBeenCalledWith('status', 'archived');
  });

  it('applies no archived filtering when view=all', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const client = makeSupabaseClient({ data: [] });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await StudyService.list({ view: 'all' }, makeCtx());

    const fromMock = (client as { from: ReturnType<typeof vi.fn> }).from;
    const usedStub = fromMock.mock.results[0]?.value as {
      eq: ReturnType<typeof vi.fn>;
      neq: ReturnType<typeof vi.fn>;
    };
    expect(usedStub.neq).not.toHaveBeenCalled();
    expect(usedStub.eq.mock.calls.some((call: unknown[]) => call[0] === 'status')).toBe(false);
  });
});

describe('StudyService.unassignSite', () => {
  it('throws PermissionDeniedError when user lacks manage_studies', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('manage_studies'),
    );

    await expect(StudyService.unassignSite(STUDY_ID, SITE_ID, makeCtx())).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it('deletes the study_sites row and writes an audit log', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const studyRow = {
      id: STUDY_ID,
      company_id: COMPANY_ID,
      study_name: 'Study A',
      status: 'active',
    };
    const client = makeSupabaseClient(
      { data: studyRow }, // getById
      { data: null }, // study_sites delete
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await StudyService.unassignSite(STUDY_ID, SITE_ID, makeCtx());

    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'study.site_unassigned',
        record_id: STUDY_ID,
        new_value: { site_id: SITE_ID },
      }),
    );
  });
});

describe('StudyService.listAssignedSites', () => {
  it('maps study_sites rows joined with sites', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const studyRow = {
      id: STUDY_ID,
      company_id: COMPANY_ID,
      study_name: 'Study A',
      status: 'active',
    };
    const rows = [
      {
        id: 'ss-1',
        status: 'active',
        site_id: SITE_ID,
        sites: { name: 'Site A', site_code: '101' },
      },
    ];
    const client = makeSupabaseClient(
      { data: studyRow }, // getById
      { data: rows }, // study_sites select
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await StudyService.listAssignedSites(STUDY_ID, makeCtx());

    expect(result).toEqual([
      { id: 'ss-1', site_id: SITE_ID, name: 'Site A', site_code: '101', status: 'active' },
    ]);
  });
});

describe('StudyService.approveAIExtraction', () => {
  it('throws NotFoundError-compatible error when extraction belongs to a different study', async () => {
    vi.spyOn(PermissionService, 'requireAnyPermission').mockResolvedValue(undefined);

    const extractionRow = {
      id: 'extraction-1',
      company_id: COMPANY_ID,
      study_id: 'other-study',
      extraction_type: 'study_profile',
      extracted_data: {},
    };
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient({ data: extractionRow }),
    );

    await expect(
      StudyService.approveAIExtraction('extraction-1', makeCtx(), STUDY_ID),
    ).rejects.toThrow('AI extraction');
  });

  it('applies the new AI-extracted profile fields (indication, enrollment, etc.) to the study', async () => {
    vi.spyOn(PermissionService, 'requireAnyPermission').mockResolvedValue(undefined);

    const extractionRow = {
      id: 'extraction-1',
      company_id: COMPANY_ID,
      study_id: STUDY_ID,
      extraction_type: 'study_profile',
      extracted_data: {
        study_name: 'Study A',
        indication: 'Type 2 Diabetes',
        estimated_enrollment: 250,
        study_duration: '52 weeks',
        study_design: 'Randomized, double-blind',
        primary_endpoint: 'Change in HbA1c from baseline',
      },
    };
    const client = makeSupabaseClient(
      { data: extractionRow }, // study_ai_extractions select
      { data: null }, // studies update
      { data: { ...extractionRow, approved: true } }, // study_ai_extractions update+select
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await StudyService.approveAIExtraction('extraction-1', makeCtx(), STUDY_ID);

    const fromMock = (client as { from: ReturnType<typeof vi.fn> }).from;
    const studiesUpdateStub = fromMock.mock.results[1]?.value as {
      update: ReturnType<typeof vi.fn>;
    };
    expect(studiesUpdateStub.update).toHaveBeenCalledWith(
      expect.objectContaining({
        indication: 'Type 2 Diabetes',
        estimated_enrollment: 250,
        study_duration: '52 weeks',
        study_design: 'Randomized, double-blind',
        primary_endpoint: 'Change in HbA1c from baseline',
      }),
    );
  });

  it('auto-resolves a missing Baseline flag by visit name before creating the template', async () => {
    vi.spyOn(PermissionService, 'requireAnyPermission').mockResolvedValue(undefined);

    const extractionRow = {
      id: 'extraction-1',
      company_id: COMPANY_ID,
      study_id: STUDY_ID,
      extraction_type: 'visit_template',
      extracted_data: {
        items: [
          { visit_name: 'Screening', visit_order: 1, offset_days: -14 },
          { visit_name: 'Baseline', visit_order: 2, offset_days: 0 },
          { visit_name: 'Week 4', visit_order: 3, offset_days: 28 },
        ],
      },
    };
    const client = makeSupabaseClient(
      { data: extractionRow }, // study_ai_extractions select
      { data: { ...extractionRow, approved: true } }, // study_ai_extractions update+select
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await StudyService.approveAIExtraction('extraction-1', makeCtx(), STUDY_ID);

    expect(VisitTemplateService.createTemplate).toHaveBeenCalledWith(
      STUDY_ID,
      [
        expect.objectContaining({ visit_name: 'Screening', is_baseline: false }),
        expect.objectContaining({ visit_name: 'Baseline', is_baseline: true }),
        expect.objectContaining({ visit_name: 'Week 4', is_baseline: false }),
      ],
      expect.anything(),
      'ai_generated',
    );
  });

  it('throws BusinessRuleError instead of calling createTemplate when the baseline cannot be resolved', async () => {
    vi.spyOn(PermissionService, 'requireAnyPermission').mockResolvedValue(undefined);

    const extractionRow = {
      id: 'extraction-1',
      company_id: COMPANY_ID,
      study_id: STUDY_ID,
      extraction_type: 'visit_template',
      extracted_data: {
        items: [
          { visit_name: 'Screening', visit_order: 1, offset_days: -14 },
          { visit_name: 'Week 4', visit_order: 2, offset_days: 28 },
        ],
      },
    };
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient({ data: extractionRow }),
    );

    await expect(
      StudyService.approveAIExtraction('extraction-1', makeCtx(), STUDY_ID),
    ).rejects.toThrow(BusinessRuleError);
    expect(VisitTemplateService.createTemplate).not.toHaveBeenCalled();
  });
});

describe('resolveAiVisitTemplateBaseline', () => {
  const item = (
    overrides: Partial<Parameters<typeof resolveAiVisitTemplateBaseline>[0][number]>,
  ) => ({
    visit_name: 'Visit',
    visit_order: 1,
    ...overrides,
  });

  it('returns items unchanged when exactly one is already marked is_baseline', () => {
    const items = [
      item({ visit_name: 'Screening', is_baseline: false }),
      item({ visit_name: 'Baseline', is_baseline: true }),
    ];
    expect(resolveAiVisitTemplateBaseline(items)).toBe(items);
  });

  it('resolves by exact case-insensitive visit name match when none are marked', () => {
    const items = [
      item({ visit_name: 'Screening' }),
      item({ visit_name: 'BASELINE' }),
      item({ visit_name: 'Week 4' }),
    ];
    const result = resolveAiVisitTemplateBaseline(items);
    expect(result.find((i) => i.visit_name === 'BASELINE')?.is_baseline).toBe(true);
    expect(result.filter((i) => i.is_baseline)).toHaveLength(1);
  });

  it('resolves by a unique offset_days of 0 when no visit is named Baseline', () => {
    const items = [
      item({ visit_name: 'Day 1', offset_days: 0 }),
      item({ visit_name: 'Week 4', offset_days: 28 }),
    ];
    const result = resolveAiVisitTemplateBaseline(items);
    expect(result.find((i) => i.visit_name === 'Day 1')?.is_baseline).toBe(true);
  });

  it('throws when zero items are marked and no name or offset match is unique', () => {
    const items = [
      item({ visit_name: 'Screening', offset_days: -14 }),
      item({ visit_name: 'Week 4', offset_days: 28 }),
    ];
    expect(() => resolveAiVisitTemplateBaseline(items)).toThrow(BusinessRuleError);
  });

  it('throws when multiple items are marked and no name match disambiguates them', () => {
    const items = [
      item({ visit_name: 'Visit A', is_baseline: true }),
      item({ visit_name: 'Visit B', is_baseline: true }),
    ];
    expect(() => resolveAiVisitTemplateBaseline(items)).toThrow(BusinessRuleError);
  });

  it('resolves by name even when multiple items are incorrectly marked is_baseline', () => {
    const items = [
      item({ visit_name: 'Baseline', is_baseline: true }),
      item({ visit_name: 'Week 4', is_baseline: true }),
    ];
    const result = resolveAiVisitTemplateBaseline(items);
    expect(result.find((i) => i.visit_name === 'Baseline')?.is_baseline).toBe(true);
    expect(result.filter((i) => i.is_baseline)).toHaveLength(1);
  });
});

describe('StudyService.listCrcOptions', () => {
  it('throws PermissionDeniedError when user lacks view_studies', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('view_studies'),
    );

    await expect(StudyService.listCrcOptions(makeCtx())).rejects.toThrow(PermissionDeniedError);
  });

  it('returns distinct, sorted CRC options from active study_staff rows', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const staffRows = [
      { user_id: 'user-2', profiles: { full_name: 'Bob CRC' } },
      { user_id: 'user-1', profiles: { full_name: 'Alice CRC' } },
      { user_id: 'user-2', profiles: { full_name: 'Bob CRC' } },
    ];
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient({ data: staffRows }),
    );

    const result = await StudyService.listCrcOptions(makeCtx());

    expect(result).toEqual([
      { user_id: 'user-1', full_name: 'Alice CRC' },
      { user_id: 'user-2', full_name: 'Bob CRC' },
    ]);
  });

  it('returns an empty array when there are no active CRC assignments', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(makeSupabaseClient({ data: [] }));

    const result = await StudyService.listCrcOptions(makeCtx());
    expect(result).toEqual([]);
  });
});

// ── uploadProtocol — baseline characterization ──────────────────────────────
// Sub-Milestone 3.4 Phase A.
//
// StudyService.uploadProtocol() had ZERO test coverage before this block.
// These tests lock down CURRENT behavior — including undesirable behavior —
// BEFORE any Document Center retrofit touches it. No production code is
// changed to make these tests pass.
//
// Architectural facts this characterization establishes (see the 3.4A audit
// report for the full analysis):
//   - study_documents is a flat, per-upload table, structurally identical to
//     subject_documents: no version/is_current columns, no uniqueness
//     constraint on (study_id, document_type). A "protocol amendment"
//     (uploaded while the study is already active) does NOT replace or
//     supersede the prior study_documents row — it INSERTS ANOTHER
//     independent row and only updates studies.protocol_version (a free-text
//     label), never a file reference. There is no "current protocol file"
//     column anywhere on `studies`. This is a multi-attachment model, the
//     same as Subjects, NOT a slot+version model like Regulatory/Staff
//     Credentials.
//   - studies has NO site_id column at all — sites are many-to-many via
//     study_sites. There is no single authoritative site for a Study-level
//     document.
//   - The study_documents insert result is currently discarded (no
//     .select() at all) — the inserted row's own id is never read back.
//   - The storage key is `${company_id}/${studyId}/${Date.now()}_${file.name}`
//     — Date.now(), not a UUID — same theoretical collision risk already
//     characterized (not fixed) for Subjects.
//   - protocol-ai Edge Function invocation is best-effort: a failure there
//     is logged and swallowed, never surfaced to the caller.

describe('StudyService.uploadProtocol — baseline characterization', () => {
  const FILE_ID = 'new-file-uuid';

  function baseStudy(overrides: Record<string, unknown> = {}) {
    return {
      id: STUDY_ID,
      company_id: COMPANY_ID,
      study_name: 'Test Study',
      protocol_number: 'PN-001',
      sponsor: 'Acme Pharma',
      cro: null,
      phase: 'Phase 2',
      therapeutic_area: null,
      status: 'draft',
      start_date: null,
      end_date: null,
      protocol_version: '1.0',
      ai_generated: false,
      created_by: USER_ID,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  }

  function makeSupabaseClientWithStorage(
    responses: Array<{ data: unknown; error?: unknown }>,
    options: {
      uploadError?: { message: string } | null;
      invokeError?: { message: string } | null;
      invokeData?: unknown;
    } = {},
  ) {
    const from = vi.fn();
    for (const r of responses) {
      from.mockReturnValueOnce(queryStub(r.data, r.error ?? null));
    }
    return {
      from,
      storage: {
        from: vi.fn().mockReturnValue({
          upload: vi.fn().mockResolvedValue({ error: options.uploadError ?? null }),
        }),
      },
      functions: {
        invoke: vi.fn().mockResolvedValue({
          data: options.invokeData ?? {},
          error: options.invokeError ?? null,
        }),
      },
    } as never;
  }

  function makeSupabaseClientWithCapture(
    responses: Array<{ data: unknown; error?: unknown }>,
    options: { invokeData?: unknown } = {},
  ) {
    const stubs = responses.map((r) => queryStub(r.data, r.error ?? null));
    const from = vi.fn();
    for (const stub of stubs) {
      from.mockReturnValueOnce(stub);
    }
    const client = {
      from,
      storage: {
        from: vi.fn().mockReturnValue({ upload: vi.fn().mockResolvedValue({ error: null }) }),
      },
      functions: {
        invoke: vi.fn().mockResolvedValue({ data: options.invokeData ?? {}, error: null }),
      },
    } as never;
    return { client, stubs };
  }

  function callArgsOf(
    stub: Record<string, unknown> | undefined,
    method: 'insert' | 'update',
    callIndex = 0,
  ): unknown {
    const fn = stub?.[method] as ReturnType<typeof vi.fn> | undefined;
    return fn?.mock.calls[callIndex]?.[0];
  }

  function makeFile(name: string, content: string, type = 'application/pdf'): File {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(content);
    return {
      name,
      type,
      size: bytes.byteLength,
      arrayBuffer: async () => bytes.buffer,
    } as unknown as File;
  }

  const STUDY_DOCUMENT_ID = 'study-document-uuid';

  it('throws PermissionDeniedError without create_study/edit_study/manage_studies', async () => {
    vi.spyOn(PermissionService, 'requireAnyPermission').mockRejectedValue(
      new PermissionDeniedError('create_study or edit_study or manage_studies'),
    );

    await expect(
      StudyService.uploadProtocol(STUDY_ID, makeFile('protocol.pdf', 'content'), makeCtx()),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it('throws NotFoundError for a study belonging to a different company (company isolation)', async () => {
    vi.spyOn(PermissionService, 'requireAnyPermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClientWithStorage([{ data: null, error: { message: 'no rows' } }]),
    );

    await expect(
      StudyService.uploadProtocol(STUDY_ID, makeFile('protocol.pdf', 'content'), makeCtx()),
    ).rejects.toThrow('Study');
  });

  it("uploads to the protocols bucket at {company}/{study}/{timestamp}_{filename}, records the file, captures the study_documents row id via .select('id').single(), and audits it (initial upload, not an amendment)", async () => {
    vi.spyOn(PermissionService, 'requireAnyPermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const client = makeSupabaseClientWithStorage([
      { data: baseStudy({ status: 'draft' }) }, // getById
      { data: { id: FILE_ID } }, // files insert
      { data: { id: STUDY_DOCUMENT_ID } }, // study_documents insert — now captured via .select('id').single()
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await StudyService.uploadProtocol(
      STUDY_ID,
      makeFile('protocol.pdf', 'content'),
      makeCtx(),
    );

    const uploadSpy = (
      client as unknown as { storage: { from: ReturnType<typeof vi.fn> } }
    ).storage.from().upload as ReturnType<typeof vi.fn>;
    expect(uploadSpy).toHaveBeenCalled();
    const storageKey = uploadSpy.mock.calls[0]?.[0] as string;
    expect(storageKey).toMatch(new RegExp(`^${COMPANY_ID}/${STUDY_ID}/\\d+_protocol\\.pdf$`));

    expect(result.file.id).toBe(FILE_ID);
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'study.protocol_uploaded', record_id: STUDY_ID }),
    );
  });

  it('throws DatabaseError when the study_documents insert fails to return a row (no reconstructed/inferred id is ever used)', async () => {
    vi.spyOn(PermissionService, 'requireAnyPermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeSupabaseClientWithStorage([
      { data: baseStudy({ status: 'draft' }) },
      { data: { id: FILE_ID } },
      { data: null, error: { message: 'insert failed' } },
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      StudyService.uploadProtocol(STUDY_ID, makeFile('protocol.pdf', 'content'), makeCtx()),
    ).rejects.toThrow(DatabaseError);
  });

  it('treats an upload to an active study as an amendment: inserts an ADDITIONAL study_documents row (never replaces the prior one) and updates protocol_version, not a file reference', async () => {
    vi.spyOn(PermissionService, 'requireAnyPermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const { client, stubs } = makeSupabaseClientWithCapture([
      { data: baseStudy({ status: 'active', protocol_version: '1.0' }) }, // getById
      { data: { id: FILE_ID } }, // files insert
      { data: { id: STUDY_DOCUMENT_ID } }, // study_documents insert (the amendment — independent row)
      { data: null }, // studies update — protocol_version only
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);
    // notifyAssignedSites uses the ADMIN client, not createServerSupabaseClient.
    vi.mocked(createAdminSupabaseClient).mockReturnValue({
      from: vi.fn().mockReturnValue(queryStub([])),
    } as never);

    const result = await StudyService.uploadProtocol(
      STUDY_ID,
      makeFile('protocol-v2.pdf', 'content'),
      makeCtx(),
    );

    const docInsertArgs = callArgsOf(stubs[2], 'insert') as Record<string, unknown>;
    expect(docInsertArgs).toMatchObject({
      company_id: COMPANY_ID,
      study_id: STUDY_ID,
      file_id: FILE_ID,
      document_type: 'protocol',
    });

    const studyUpdateArgs = callArgsOf(stubs[3], 'update') as Record<string, unknown>;
    expect(studyUpdateArgs).toHaveProperty('protocol_version');
    expect(studyUpdateArgs).not.toHaveProperty('file_id'); // no such column exists on studies

    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'study.protocol_amended', record_id: STUDY_ID }),
    );
    expect(result.file.id).toBe(FILE_ID);
  });

  it('persists company_id, study_id, file_id, and document_type: "protocol" exactly as produced by this flow', async () => {
    vi.spyOn(PermissionService, 'requireAnyPermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const { client, stubs } = makeSupabaseClientWithCapture([
      { data: baseStudy({ status: 'draft' }) },
      { data: { id: 'distinct-file-uuid' } },
      { data: { id: STUDY_DOCUMENT_ID } },
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await StudyService.uploadProtocol(STUDY_ID, makeFile('protocol.pdf', 'content'), makeCtx());

    const docInsertArgs = callArgsOf(stubs[2], 'insert') as Record<string, unknown>;
    expect(docInsertArgs).toMatchObject({
      company_id: COMPANY_ID,
      study_id: STUDY_ID,
      file_id: 'distinct-file-uuid',
      document_type: 'protocol',
    });
  });

  it('does not fail the upload when the protocol-ai invocation errors — extraction_id is null and the upload still succeeds', async () => {
    vi.spyOn(PermissionService, 'requireAnyPermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const client = makeSupabaseClientWithStorage(
      [
        { data: baseStudy({ status: 'draft' }) },
        { data: { id: FILE_ID } },
        { data: { id: STUDY_DOCUMENT_ID } },
      ],
      { invokeError: { message: 'extraction service down' } },
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await StudyService.uploadProtocol(
      STUDY_ID,
      makeFile('protocol.pdf', 'content'),
      makeCtx(),
    );

    expect(result.extraction_id).toBeNull();
    expect(result.file.id).toBe(FILE_ID);
  });

  it('throws DatabaseError when the storage upload itself fails, without attempting any cleanup', async () => {
    vi.spyOn(PermissionService, 'requireAnyPermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeSupabaseClientWithStorage([{ data: baseStudy({ status: 'draft' }) }], {
      uploadError: { message: 'storage down' },
    });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      StudyService.uploadProtocol(STUDY_ID, makeFile('protocol.pdf', 'content'), makeCtx()),
    ).rejects.toThrow('Protocol upload failed');
  });

  it('never returns a public or signed URL', async () => {
    vi.spyOn(PermissionService, 'requireAnyPermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const client = makeSupabaseClientWithStorage([
      { data: baseStudy({ status: 'draft' }) },
      { data: { id: FILE_ID } },
      { data: { id: STUDY_DOCUMENT_ID } },
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await StudyService.uploadProtocol(
      STUDY_ID,
      makeFile('protocol.pdf', 'content'),
      makeCtx(),
    );

    expect(result).not.toHaveProperty('url');
    expect(result.file).not.toHaveProperty('url');
    expect(result.file).not.toHaveProperty('signedUrl');
  });
});

// ── Sub-Milestone 3.4B: Document Center retrofit for uploadProtocol() ──────

describe('StudyService.uploadProtocol — Document Center retrofit', () => {
  const FILE_ID = 'new-file-uuid';
  const STUDY_DOCUMENT_ID = 'study-document-uuid';

  function baseStudy(overrides: Record<string, unknown> = {}) {
    return {
      id: STUDY_ID,
      company_id: COMPANY_ID,
      study_name: 'Test Study',
      protocol_number: 'PN-001',
      sponsor: 'Acme Pharma',
      cro: null,
      phase: 'Phase 2',
      therapeutic_area: null,
      status: 'draft',
      start_date: null,
      end_date: null,
      protocol_version: '1.0',
      ai_generated: false,
      created_by: USER_ID,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  }

  function makeFile(name: string, content: string, type = 'application/pdf'): File {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(content);
    return {
      name,
      type,
      size: bytes.byteLength,
      arrayBuffer: async () => bytes.buffer,
    } as unknown as File;
  }

  function successClient(fileId: string, studyDocumentId: string, status = 'draft') {
    const from = vi.fn();
    for (const stub of [
      queryStub(baseStudy({ status })),
      queryStub({ id: fileId }),
      queryStub({ id: studyDocumentId }),
      queryStub(null), // studies update — only consumed when status === 'active' (amendment)
    ]) {
      from.mockReturnValueOnce(stub);
    }
    return {
      from,
      storage: {
        from: vi.fn().mockReturnValue({ upload: vi.fn().mockResolvedValue({ error: null }) }),
      },
      functions: { invoke: vi.fn().mockResolvedValue({ data: {}, error: null }) },
    } as never;
  }

  beforeEach(() => {
    vi.spyOn(PermissionService, 'requireAnyPermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
  });

  it('calls linkForModule exactly once, with the correct module and the exact inserted study_documents.id as record_id', async () => {
    const linkSpy = vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      successClient(FILE_ID, STUDY_DOCUMENT_ID),
    );

    await StudyService.uploadProtocol(STUDY_ID, makeFile('protocol.pdf', 'content'), makeCtx());

    expect(linkSpy).toHaveBeenCalledTimes(1);
    expect(linkSpy).toHaveBeenCalledWith(
      {
        file_id: FILE_ID,
        module: 'study_documents',
        record_id: STUDY_DOCUMENT_ID,
        site_id: null,
      },
      expect.anything(),
    );
  });

  it("passes the exact fileId from the upload flow and the exact study_documents.id returned by .select('id').single() — never reconstructed identifiers", async () => {
    const linkSpy = vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const distinctFileId = 'distinct-file-uuid';
    const distinctDocId = 'distinct-study-document-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      successClient(distinctFileId, distinctDocId),
    );

    await StudyService.uploadProtocol(STUDY_ID, makeFile('protocol.pdf', 'content'), makeCtx());

    const callArgs = linkSpy.mock.calls[0]?.[0];
    expect(callArgs?.file_id).toBe(distinctFileId);
    expect(callArgs?.record_id).toBe(distinctDocId);
  });

  it('still succeeds and returns the finalized result when linkForModule fails (failure is logged, not swallowed silently, and never rolled back)', async () => {
    vi.spyOn(FileService, 'linkForModule').mockRejectedValue(new Error('file_links insert failed'));
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      successClient(FILE_ID, STUDY_DOCUMENT_ID),
    );

    const result = await StudyService.uploadProtocol(
      STUDY_ID,
      makeFile('protocol.pdf', 'content'),
      makeCtx(),
    );

    expect(result.file.id).toBe(FILE_ID);
  });

  it('never exposes a public URL from the Document Center link', async () => {
    vi.spyOn(FileService, 'linkForModule').mockResolvedValue({
      id: 'link-uuid',
      company_id: COMPANY_ID,
      file_id: FILE_ID,
      site_id: null,
      module: 'study_documents',
      record_id: STUDY_DOCUMENT_ID,
      created_by: USER_ID,
      created_at: new Date().toISOString(),
    } as FileLink);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      successClient(FILE_ID, STUDY_DOCUMENT_ID),
    );

    const result = await StudyService.uploadProtocol(
      STUDY_ID,
      makeFile('protocol.pdf', 'content'),
      makeCtx(),
    );

    expect(result).not.toHaveProperty('url');
    expect(result.file).not.toHaveProperty('url');
    expect(result.file).not.toHaveProperty('signedUrl');
  });

  it('existing permission enforcement is unaffected by the retrofit', async () => {
    vi.spyOn(PermissionService, 'requireAnyPermission').mockRejectedValue(
      new PermissionDeniedError('create_study or edit_study or manage_studies'),
    );

    await expect(
      StudyService.uploadProtocol(STUDY_ID, makeFile('protocol.pdf', 'content'), makeCtx()),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it('amendment: two protocol uploads to the same study produce two independent study_documents rows, each with its own linkForModule call — no relink, no collapsing', async () => {
    const linkSpy = vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const relinkSpy = vi.spyOn(FileService, 'relinkForModule');

    const fileIdA = 'file-a-uuid';
    const docIdA = 'study-document-a-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      successClient(fileIdA, docIdA, 'draft'),
    );
    await StudyService.uploadProtocol(
      STUDY_ID,
      makeFile('protocol-v1.pdf', 'content A'),
      makeCtx(),
    );

    const fileIdB = 'file-b-uuid';
    const docIdB = 'study-document-b-uuid';
    vi.mocked(createAdminSupabaseClient).mockReturnValue({
      from: vi.fn().mockReturnValue(queryStub([])),
    } as never);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      successClient(fileIdB, docIdB, 'active'),
    );
    await StudyService.uploadProtocol(
      STUDY_ID,
      makeFile('protocol-v2.pdf', 'content B'),
      makeCtx(),
    );

    expect(linkSpy).toHaveBeenCalledTimes(2);
    expect(linkSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ file_id: fileIdA, record_id: docIdA, module: 'study_documents' }),
      expect.anything(),
    );
    expect(linkSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ file_id: fileIdB, record_id: docIdB, module: 'study_documents' }),
      expect.anything(),
    );
    expect(relinkSpy).not.toHaveBeenCalled();
  });
});
