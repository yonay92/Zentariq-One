import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { SubjectService } from '@/services/subjects/SubjectService';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import { NotificationService } from '@/services/notifications/NotificationService';
import { PermissionDeniedError, BusinessRuleError, NotFoundError } from '@/lib/api/errors';

vi.mock('@/services/audit/AuditService', () => ({
  AuditService: { log: vi.fn() },
}));

vi.mock('@/services/notifications/NotificationService', () => ({
  NotificationService: { dispatch: vi.fn() },
}));

const COMPANY_ID = 'company-uuid';
const STUDY_ID = 'study-uuid';
const SITE_ID = 'site-uuid';
const SUBJECT_ID = 'subject-uuid';
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

function queryStub(data: unknown, error: unknown = null) {
  const resolved = Promise.resolve({ data, error });
  const stub: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
    single: vi.fn().mockResolvedValue({ data, error }),
    then: resolved.then.bind(resolved),
    catch: resolved.catch.bind(resolved),
    finally: resolved.finally.bind(resolved),
  };
  for (const key of ['select', 'eq', 'or', 'order', 'limit', 'insert', 'update', 'upsert', 'in']) {
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

describe('SubjectService.create', () => {
  const input = { site_id: SITE_ID, study_id: STUDY_ID, subject_number: '001-001' };

  it('throws PermissionDeniedError when user lacks create_subject', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('create_subject'),
    );

    await expect(SubjectService.create(input, makeCtx())).rejects.toThrow(PermissionDeniedError);
  });

  it('throws BusinessRuleError when the study is not active', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'requireSiteAccess').mockResolvedValue(undefined);

    // Study/site/template are fetched concurrently (Promise.all), so all three
    // queries fire even though only the study result determines the thrown error.
    const draftStudy = { id: STUDY_ID, status: 'draft' };
    const client = makeSupabaseClient(
      { data: draftStudy }, // studies lookup
      { data: { id: 'study-site-uuid' } }, // study_sites lookup
      { data: { id: 'template-uuid' } }, // visit_templates lookup
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(SubjectService.create(input, makeCtx())).rejects.toThrow(BusinessRuleError);
  });

  it('throws BusinessRuleError when the site is not assigned to the study', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'requireSiteAccess').mockResolvedValue(undefined);

    const activeStudy = { id: STUDY_ID, status: 'active' };
    const client = makeSupabaseClient(
      { data: activeStudy }, // studies lookup
      { data: null }, // study_sites lookup — not assigned
      { data: { id: 'template-uuid' } }, // visit_templates lookup
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(SubjectService.create(input, makeCtx())).rejects.toThrow(BusinessRuleError);
  });

  it('throws BusinessRuleError when the study has no approved visit template (GAP-REQ-03)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'requireSiteAccess').mockResolvedValue(undefined);

    const activeStudy = { id: STUDY_ID, status: 'active' };
    const studySite = { id: 'study-site-uuid' };
    const client = makeSupabaseClient(
      { data: activeStudy }, // studies lookup
      { data: studySite }, // study_sites lookup
      { data: null }, // visit_templates lookup — no approved template
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(SubjectService.create(input, makeCtx())).rejects.toThrow(BusinessRuleError);
  });

  it('creates the subject and writes an audit log + timeline event when permitted', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'requireSiteAccess').mockResolvedValue(undefined);

    const activeStudy = { id: STUDY_ID, status: 'active' };
    const studySite = { id: 'study-site-uuid' };
    const subjectRow = {
      id: SUBJECT_ID,
      company_id: COMPANY_ID,
      site_id: SITE_ID,
      study_id: STUDY_ID,
      subject_number: '001-001',
      status: 'pre_screening',
      baseline_date: null,
    };
    const template = { id: 'template-uuid' };
    const screeningItem = {
      id: 'item-screening-uuid',
      template_id: 'template-uuid',
      visit_name: 'Screening',
      visit_order: 1,
      offset_days: -14,
      window_before: 0,
      window_after: 0,
      visit_type: 'scheduled',
      is_required: true,
      is_baseline: false,
    };
    const baselineItem = {
      id: 'item-baseline-uuid',
      template_id: 'template-uuid',
      visit_name: 'Baseline',
      visit_order: 2,
      offset_days: 0,
      window_before: 0,
      window_after: 0,
      visit_type: 'scheduled',
      is_required: true,
      is_baseline: true,
    };
    const week4Item = {
      id: 'item-week4-uuid',
      template_id: 'template-uuid',
      visit_name: 'Week 4',
      visit_order: 3,
      offset_days: 28,
      window_before: 7,
      window_after: 7,
      visit_type: 'scheduled',
      is_required: true,
      is_baseline: false,
    };

    const client = makeSupabaseClient(
      { data: activeStudy }, // studies lookup
      { data: studySite }, // study_sites lookup
      { data: template }, // visit_templates lookup (GAP-REQ-03 check, reused for items below)
      { data: subjectRow }, // subjects insert
      { data: null }, // subject_timeline insert (subject_created)
      { data: [screeningItem, baselineItem, week4Item] }, // visit_template_items (all, ordered)
      { data: null }, // visits insert (Screening + Baseline placeholders)
      {
        data: [
          { visit_name: 'Screening', target_date: null },
          { visit_name: 'Baseline', target_date: null },
        ],
      }, // visits select (createdVisits refetch for calendar events)
      { data: null }, // subject_timeline insert (baseline_visit_scheduled)
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await SubjectService.create(input, makeCtx());

    expect(result.id).toBe(SUBJECT_ID);
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'subject.created', record_id: SUBJECT_ID }),
    );

    // Everything at or before Baseline's visit_order is created now; Week 4 (after
    // Baseline) is not — it's only generated once Baseline is completed.
    const fromMock = (client as { from: ReturnType<typeof vi.fn> }).from;
    const visitsInsertStub = fromMock.mock.results[6]?.value as {
      insert: ReturnType<typeof vi.fn>;
    };
    const insertedRows = (visitsInsertStub.insert as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Array<{ visit_name: string }>;
    expect(insertedRows.map((r) => r.visit_name)).toEqual(['Screening', 'Baseline']);
  });
});

describe('SubjectService.completeBaselineVisit', () => {
  const BASELINE_DATE = '2026-01-15';

  function makeBaselineItem() {
    return {
      id: 'item-baseline-uuid',
      template_id: 'template-uuid',
      visit_name: 'Baseline',
      visit_order: 1,
      offset_days: 0,
      window_before: 0,
      window_after: 0,
      visit_type: 'scheduled',
      is_required: true,
      is_baseline: true,
    };
  }

  it('throws BusinessRuleError when the baseline visit was already completed (and not reopened)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    // Guarded solely by the visit's own status now, not subject.baseline_date —
    // a completed Baseline visit's status is 'completed', which is not
    // 'in_progress', so re-completing without first Reopening still fails.
    const subjectRow = {
      id: SUBJECT_ID,
      company_id: COMPANY_ID,
      site_id: SITE_ID,
      study_id: STUDY_ID,
      subject_number: '001-001',
      status: 'screening',
      baseline_date: '2026-01-01',
    };
    const baselineItem = makeBaselineItem();
    const baselineVisit = {
      id: 'visit-uuid',
      visit_template_item_id: baselineItem.id,
      status: 'completed',
    };
    const client = makeSupabaseClient(
      { data: subjectRow }, // getById
      { data: { id: 'template-uuid' } }, // visit_templates lookup
      { data: [baselineItem] }, // visit_template_items
      { data: [baselineVisit] }, // visits (current)
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      SubjectService.completeBaselineVisit(SUBJECT_ID, { baseline_date: BASELINE_DATE }, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('allows completing the Baseline visit again after it was Reopened, recalculating pending downstream visits without duplicating them', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const NEW_BASELINE_DATE = '2026-01-20';
    const subjectRow = {
      id: SUBJECT_ID,
      company_id: COMPANY_ID,
      site_id: SITE_ID,
      study_id: STUDY_ID,
      subject_number: '001-001',
      status: 'screening',
      baseline_date: '2026-01-15', // set by the original completion
    };
    const updatedSubjectRow = { ...subjectRow, baseline_date: NEW_BASELINE_DATE };
    const baselineItem = makeBaselineItem();
    // Reopened — status is back to in_progress, so re-completion is allowed.
    const baselineVisit = {
      id: 'visit-baseline-uuid',
      visit_template_item_id: baselineItem.id,
      status: 'in_progress',
    };
    const week4Item = {
      id: 'item-week4-uuid',
      template_id: 'template-uuid',
      visit_name: 'Week 4',
      visit_order: 2,
      offset_days: 28,
      window_before: 7,
      window_after: 7,
      visit_type: 'scheduled',
      is_required: true,
      is_baseline: false,
    };
    // Already generated by the first completion, still pending — must be
    // recalculated in place, not duplicated.
    const existingWeek4Visit = {
      id: 'visit-week4-uuid',
      visit_template_item_id: week4Item.id,
      status: 'scheduled',
      target_date: '2026-02-12',
      window_start: '2026-02-05',
      window_end: '2026-02-19',
    };
    const recalculatedWeek4Visit = {
      ...existingWeek4Visit,
      target_date: '2026-02-17',
      window_start: '2026-02-10',
      window_end: '2026-02-24',
    };

    const client = makeSupabaseClient(
      { data: subjectRow }, // getById
      { data: { id: 'template-uuid' } }, // visit_templates lookup (getVisitScheduleContext)
      { data: [baselineItem, week4Item] }, // visit_template_items
      { data: [baselineVisit] }, // visits (current, for lock check — Week 4 doesn't exist for this subject's current-visits query used by the lock check)
      { data: null }, // visits update (mark Baseline completed again)
      { data: null }, // visit_history insert
      { data: null }, // calendar_events select (Baseline's own event — existing check)
      { data: null }, // calendar_events insert (self-heal — none existed)
      { data: updatedSubjectRow }, // subjects update (new baseline_date)
      { data: null }, // subject_timeline insert (baseline_visit_completed)
      { data: { id: 'template-uuid' } }, // generateVisitSchedule: visit_templates lookup
      { data: [baselineItem, week4Item] }, // generateVisitSchedule: visit_template_items
      { data: [existingWeek4Visit] }, // generateVisitSchedule: existing visits for downstream items
      { data: recalculatedWeek4Visit }, // generateVisitSchedule: visits update (recalculate Week 4)
      { data: { id: 'event-week4-uuid' } }, // calendar_events select (Week 4's event — already exists)
      { data: null }, // calendar_events update (recalculate Week 4's date)
      { data: null }, // generateVisitSchedule: subject_timeline insert
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await SubjectService.completeBaselineVisit(
      SUBJECT_ID,
      { baseline_date: NEW_BASELINE_DATE },
      makeCtx(),
    );

    expect(result.baseline_date).toBe(NEW_BASELINE_DATE);

    // Exactly 4 `.from('visits')` calls: the lock-check read, the mark-Baseline-
    // completed update, generateVisitSchedule's existing-visits read, and the
    // Week 4 recalculation update — notably NOT a 5th "insert a new Week 4" call,
    // which is what would happen if it were duplicated instead of recalculated.
    const fromMock = (client as unknown as { from: ReturnType<typeof vi.fn> }).from;
    const visitsCalls = fromMock.mock.calls.filter(([table]) => table === 'visits');
    expect(visitsCalls).toHaveLength(4);

    const week4UpdateStub = fromMock.mock.results[13]?.value as {
      update: ReturnType<typeof vi.fn>;
      insert: ReturnType<typeof vi.fn>;
    };
    expect(week4UpdateStub.insert).not.toHaveBeenCalled();
    const updateArg = (week4UpdateStub.update as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(updateArg.target_date).toBe('2026-02-17');

    // Week 4's calendar event was recalculated in place (matched by
    // related_record_type='visits' + related_record_id), not duplicated.
    const week4CalendarUpdateStub = fromMock.mock.results[15]?.value as {
      update: ReturnType<typeof vi.fn>;
      insert: ReturnType<typeof vi.fn>;
    };
    expect(week4CalendarUpdateStub.insert).not.toHaveBeenCalled();
    const calendarUpdateArg = (week4CalendarUpdateStub.update as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(calendarUpdateArg.start_datetime).toBe('2026-02-17T00:00:00Z');
  });

  it('throws BusinessRuleError when the approved template has no Baseline item configured', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const subjectRow = {
      id: SUBJECT_ID,
      company_id: COMPANY_ID,
      site_id: SITE_ID,
      study_id: STUDY_ID,
      subject_number: '001-001',
      status: 'screening',
      baseline_date: null,
    };
    const client = makeSupabaseClient(
      { data: subjectRow }, // getById
      { data: { id: 'template-uuid' } }, // visit_templates lookup
      { data: [] }, // visit_template_items (no is_baseline item)
      { data: [] }, // visits (subject's current visits)
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      SubjectService.completeBaselineVisit(SUBJECT_ID, { baseline_date: BASELINE_DATE }, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('throws NotFoundError when the subject has no placeholder Baseline visit', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const subjectRow = {
      id: SUBJECT_ID,
      company_id: COMPANY_ID,
      site_id: SITE_ID,
      study_id: STUDY_ID,
      subject_number: '001-001',
      status: 'screening',
      baseline_date: null,
    };
    const client = makeSupabaseClient(
      { data: subjectRow }, // getById
      { data: { id: 'template-uuid' } }, // visit_templates lookup
      { data: [makeBaselineItem()] }, // visit_template_items
      { data: [] }, // visits (no placeholder found)
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      SubjectService.completeBaselineVisit(SUBJECT_ID, { baseline_date: BASELINE_DATE }, makeCtx()),
    ).rejects.toThrow(NotFoundError);
  });

  it('throws BusinessRuleError when a required predecessor visit has not been completed', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const subjectRow = {
      id: SUBJECT_ID,
      company_id: COMPANY_ID,
      site_id: SITE_ID,
      study_id: STUDY_ID,
      subject_number: '001-001',
      status: 'screening',
      baseline_date: null,
    };
    const screeningItem = {
      id: 'item-screening-uuid',
      template_id: 'template-uuid',
      visit_name: 'Screening',
      visit_order: 1,
      offset_days: -14,
      window_before: 0,
      window_after: 0,
      visit_type: 'scheduled',
      is_required: true,
      is_baseline: false,
    };
    const baselineItem = { ...makeBaselineItem(), visit_order: 2 };
    const screeningVisit = {
      id: 'visit-screening-uuid',
      visit_template_item_id: screeningItem.id,
      status: 'scheduled',
    };
    const baselineVisit = {
      id: 'visit-baseline-uuid',
      visit_template_item_id: baselineItem.id,
      // in_progress so this test still exercises the predecessor-lock check
      // rather than being short-circuited by the Complete-precondition check.
      status: 'in_progress',
    };

    const client = makeSupabaseClient(
      { data: subjectRow }, // getById
      { data: { id: 'template-uuid' } }, // visit_templates lookup
      { data: [screeningItem, baselineItem] }, // visit_template_items
      { data: [screeningVisit, baselineVisit] }, // visits
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      SubjectService.completeBaselineVisit(SUBJECT_ID, { baseline_date: BASELINE_DATE }, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('completes the Baseline visit, records baseline_date, and generates the rest of the schedule', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const subjectRow = {
      id: SUBJECT_ID,
      company_id: COMPANY_ID,
      site_id: SITE_ID,
      study_id: STUDY_ID,
      subject_number: '001-001',
      status: 'screening',
      baseline_date: null,
    };
    const updatedSubjectRow = { ...subjectRow, baseline_date: BASELINE_DATE };
    const baselineItem = makeBaselineItem();
    const baselineVisit = {
      id: 'visit-uuid',
      visit_template_item_id: baselineItem.id,
      status: 'in_progress',
    };

    const client = makeSupabaseClient(
      { data: subjectRow }, // getById
      { data: { id: 'template-uuid' } }, // visit_templates lookup
      { data: [baselineItem] }, // visit_template_items (only item — no predecessors)
      { data: [baselineVisit] }, // visits (subject's current visits)
      { data: null }, // visits update (mark completed)
      { data: null }, // visit_history insert
      { data: null }, // calendar_events select (existing check)
      { data: null }, // calendar_events insert (self-heal — none existed)
      { data: updatedSubjectRow }, // subjects update (baseline_date)
      { data: null }, // subject_timeline insert (baseline_visit_completed)
      { data: null }, // generateVisitSchedule: visit_templates lookup -> none, short-circuits
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await SubjectService.completeBaselineVisit(
      SUBJECT_ID,
      { baseline_date: BASELINE_DATE },
      makeCtx(),
    );

    expect(result.baseline_date).toBe(BASELINE_DATE);
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'subject.baseline_completed', record_id: SUBJECT_ID }),
    );
  });
});

describe('SubjectService.randomize', () => {
  const RANDOMIZATION_INPUT = { randomization_number: 'R-0001', randomization_date: '2026-02-01' };

  it('throws BusinessRuleError when the subject was already randomized', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const subjectRow = {
      id: SUBJECT_ID,
      company_id: COMPANY_ID,
      site_id: SITE_ID,
      subject_number: '001-001',
      status: 'randomized',
      randomization_date: '2026-01-01',
    };
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient({ data: subjectRow }),
    );

    await expect(
      SubjectService.randomize(SUBJECT_ID, RANDOMIZATION_INPUT, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('throws BusinessRuleError when the subject status does not allow randomization', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const subjectRow = {
      id: SUBJECT_ID,
      company_id: COMPANY_ID,
      site_id: SITE_ID,
      subject_number: '001-001',
      status: 'active',
      baseline_date: '2026-01-01',
      randomization_date: null,
    };
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient({ data: subjectRow }),
    );

    await expect(
      SubjectService.randomize(SUBJECT_ID, RANDOMIZATION_INPUT, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('throws BusinessRuleError when the Baseline visit has not been completed', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const subjectRow = {
      id: SUBJECT_ID,
      company_id: COMPANY_ID,
      site_id: SITE_ID,
      subject_number: '001-001',
      status: 'screening',
      baseline_date: null,
      randomization_date: null,
    };
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient({ data: subjectRow }),
    );

    await expect(
      SubjectService.randomize(SUBJECT_ID, RANDOMIZATION_INPUT, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('records randomization, changes status, and notifies pi/crc', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const subjectRow = {
      id: SUBJECT_ID,
      company_id: COMPANY_ID,
      site_id: SITE_ID,
      subject_number: '001-001',
      status: 'screening',
      baseline_date: '2026-01-01',
      randomization_date: null,
    };
    const updatedRow = {
      ...subjectRow,
      status: 'randomized',
      randomization_number: RANDOMIZATION_INPUT.randomization_number,
      randomization_date: RANDOMIZATION_INPUT.randomization_date,
    };

    const client = makeSupabaseClient(
      { data: subjectRow }, // getById
      { data: updatedRow }, // subjects update
      { data: null }, // subject_status_history insert
      { data: null }, // subject_timeline insert
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await SubjectService.randomize(SUBJECT_ID, RANDOMIZATION_INPUT, makeCtx());

    expect(result.status).toBe('randomized');
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'subject.randomized', record_id: SUBJECT_ID }),
    );
    expect(NotificationService.dispatch).toHaveBeenCalledTimes(2);
  });
});

describe('SubjectService.completeVisit', () => {
  const VISIT_ID = 'visit-week4-uuid';
  const COMPLETE_INPUT = { scheduled_date: '2026-02-12' };

  function makeSubjectRow() {
    return {
      id: SUBJECT_ID,
      company_id: COMPANY_ID,
      site_id: SITE_ID,
      study_id: STUDY_ID,
      subject_number: '001-001',
      status: 'active',
      baseline_date: '2026-01-15',
    };
  }

  it('throws PermissionDeniedError when user lacks edit_subject', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('edit_subject'),
    );

    await expect(
      SubjectService.completeVisit(SUBJECT_ID, VISIT_ID, COMPLETE_INPUT, makeCtx()),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it('throws NotFoundError when the visit does not exist', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const client = makeSupabaseClient(
      { data: makeSubjectRow() }, // getById
      { data: null }, // visits select -> not found
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      SubjectService.completeVisit(SUBJECT_ID, VISIT_ID, COMPLETE_INPUT, makeCtx()),
    ).rejects.toThrow(NotFoundError);
  });

  it('throws BusinessRuleError when the visit is already completed', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const client = makeSupabaseClient(
      { data: makeSubjectRow() }, // getById
      { data: { id: VISIT_ID, status: 'completed', visit_template_item_id: 'item-week4' } }, // visits select
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      SubjectService.completeVisit(SUBJECT_ID, VISIT_ID, COMPLETE_INPUT, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('throws BusinessRuleError when attempting to complete the Baseline visit through this action', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const baselineItem = {
      id: 'item-baseline',
      template_id: 'template-uuid',
      visit_name: 'Baseline',
      visit_order: 1,
      is_required: true,
      is_baseline: true,
    };
    const baselineVisit = {
      id: VISIT_ID,
      // in_progress so this test still exercises the is_baseline guard rather
      // than being short-circuited by the Complete-precondition check.
      status: 'in_progress',
      visit_template_item_id: baselineItem.id,
    };

    const client = makeSupabaseClient(
      { data: makeSubjectRow() }, // getById
      { data: baselineVisit }, // visits select
      { data: { id: 'template-uuid' } }, // visit_templates lookup
      { data: [baselineItem] }, // visit_template_items
      { data: [baselineVisit] }, // visits (all)
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      SubjectService.completeVisit(SUBJECT_ID, VISIT_ID, COMPLETE_INPUT, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('throws BusinessRuleError when a required predecessor visit has not been completed', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const week4Item = {
      id: 'item-week4',
      template_id: 'template-uuid',
      visit_name: 'Week 4',
      visit_order: 2,
      is_required: true,
      is_baseline: false,
    };
    const baselineItem = {
      id: 'item-baseline',
      template_id: 'template-uuid',
      visit_name: 'Baseline',
      visit_order: 1,
      is_required: true,
      is_baseline: true,
    };
    // in_progress so this test still exercises the predecessor-lock check rather
    // than being short-circuited by the Complete-precondition check.
    const week4Visit = {
      id: VISIT_ID,
      status: 'in_progress',
      visit_template_item_id: week4Item.id,
    };
    const baselineVisit = {
      id: 'visit-baseline',
      status: 'scheduled', // not yet completed
      visit_template_item_id: baselineItem.id,
    };

    const client = makeSupabaseClient(
      { data: makeSubjectRow() }, // getById
      { data: week4Visit }, // visits select (target visit)
      { data: { id: 'template-uuid' } }, // visit_templates lookup
      { data: [baselineItem, week4Item] }, // visit_template_items
      { data: [baselineVisit, week4Visit] }, // visits (all)
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      SubjectService.completeVisit(SUBJECT_ID, VISIT_ID, COMPLETE_INPUT, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('completes a non-Baseline visit and writes an audit log + timeline event when unlocked', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const week4Item = {
      id: 'item-week4',
      template_id: 'template-uuid',
      visit_name: 'Week 4',
      visit_order: 1,
      is_required: true,
      is_baseline: false,
    };
    const week4Visit = {
      id: VISIT_ID,
      status: 'in_progress',
      visit_name: 'Week 4',
      visit_template_item_id: week4Item.id,
    };
    const completedVisit = {
      ...week4Visit,
      status: 'completed',
      scheduled_date: COMPLETE_INPUT.scheduled_date,
    };

    const client = makeSupabaseClient(
      { data: makeSubjectRow() }, // getById
      { data: week4Visit }, // visits select (target visit)
      { data: { id: 'template-uuid' } }, // visit_templates lookup
      { data: [week4Item] }, // visit_template_items (no predecessors)
      { data: [week4Visit] }, // visits (all)
      { data: completedVisit }, // visits update
      { data: null }, // visit_history insert
      { data: null }, // calendar_events select (existing check)
      { data: null }, // calendar_events insert (self-heal — none existed)
      { data: null }, // subject_timeline insert
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await SubjectService.completeVisit(
      SUBJECT_ID,
      VISIT_ID,
      COMPLETE_INPUT,
      makeCtx(),
    );

    expect(result.status).toBe('completed');
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'visit.completed', record_id: VISIT_ID }),
    );
  });

  describe('Out of Window (BUSINESS_RULES_04_Visits.md)', () => {
    const WINDOW_START = '2026-02-10';
    const WINDOW_END = '2026-02-14';

    function makeWindowedVisit() {
      const item = {
        id: 'item-week4',
        template_id: 'template-uuid',
        visit_name: 'Week 4',
        visit_order: 1,
        is_required: true,
        is_baseline: false,
      };
      const visit = {
        id: VISIT_ID,
        status: 'in_progress',
        visit_name: 'Week 4',
        visit_template_item_id: item.id,
        window_start: WINDOW_START,
        window_end: WINDOW_END,
      };
      return { item, visit };
    }

    function mockClientFor(scheduledDate: string) {
      const { item, visit } = makeWindowedVisit();
      const finalStatus =
        scheduledDate < WINDOW_START || scheduledDate > WINDOW_END ? 'out_of_window' : 'completed';
      const completedVisit = { ...visit, status: finalStatus, scheduled_date: scheduledDate };

      const client = makeSupabaseClient(
        { data: makeSubjectRow() }, // getById
        { data: visit }, // visits select (target visit)
        { data: { id: 'template-uuid' } }, // visit_templates lookup
        { data: [item] }, // visit_template_items (no predecessors)
        { data: [visit] }, // visits (all)
        { data: completedVisit }, // visits update
        { data: null }, // visit_history insert
        { data: null }, // calendar_events select (existing check)
        { data: null }, // calendar_events insert (self-heal — none existed)
        { data: null }, // subject_timeline insert
      );
      vi.mocked(createServerSupabaseClient).mockResolvedValue(client);
      return completedVisit;
    }

    beforeEach(() => {
      vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    });

    it('completes normally when the date is inside the window', async () => {
      mockClientFor('2026-02-12');

      const result = await SubjectService.completeVisit(
        SUBJECT_ID,
        VISIT_ID,
        { scheduled_date: '2026-02-12' },
        makeCtx(),
      );

      expect(result.status).toBe('completed');
      expect(AuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'visit.completed' }),
      );
      expect(NotificationService.dispatch).not.toHaveBeenCalled();
    });

    it('treats a date exactly on the window boundary as in-window (inclusive)', async () => {
      mockClientFor(WINDOW_END);

      const result = await SubjectService.completeVisit(
        SUBJECT_ID,
        VISIT_ID,
        { scheduled_date: WINDOW_END },
        makeCtx(),
      );

      expect(result.status).toBe('completed');
      expect(AuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'visit.completed' }),
      );
      expect(NotificationService.dispatch).not.toHaveBeenCalled();
    });

    it('marks out_of_window and notifies the CRC when the date is before the window', async () => {
      const beforeDate = '2026-02-05';
      mockClientFor(beforeDate);

      const result = await SubjectService.completeVisit(
        SUBJECT_ID,
        VISIT_ID,
        { scheduled_date: beforeDate },
        makeCtx(),
      );

      expect(result.status).toBe('out_of_window');
      expect(AuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'visit.out_of_window', record_id: VISIT_ID }),
      );
      expect(NotificationService.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'visit_out_of_window',
          recipientRole: 'crc',
          relatedRecordId: VISIT_ID,
        }),
      );
    });

    it('marks out_of_window and notifies the CRC when the date is after the window', async () => {
      const afterDate = '2026-02-20';
      mockClientFor(afterDate);

      const result = await SubjectService.completeVisit(
        SUBJECT_ID,
        VISIT_ID,
        { scheduled_date: afterDate },
        makeCtx(),
      );

      expect(result.status).toBe('out_of_window');
      expect(AuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'visit.out_of_window', record_id: VISIT_ID }),
      );
      expect(NotificationService.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'visit_out_of_window',
          recipientRole: 'crc',
          relatedRecordId: VISIT_ID,
        }),
      );
    });
  });
});

describe('SubjectService.updateStatus', () => {
  it('throws BusinessRuleError for a transition that skips the forward flow', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const subjectRow = {
      id: SUBJECT_ID,
      company_id: COMPANY_ID,
      site_id: SITE_ID,
      subject_number: '001-001',
      status: 'pre_screening',
    };
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient({ data: subjectRow }),
    );

    await expect(SubjectService.updateStatus(SUBJECT_ID, 'active', makeCtx())).rejects.toThrow(
      BusinessRuleError,
    );
  });

  it('throws BusinessRuleError when changing status from a terminal state', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const subjectRow = {
      id: SUBJECT_ID,
      company_id: COMPANY_ID,
      site_id: SITE_ID,
      subject_number: '001-001',
      status: 'completed',
    };
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient({ data: subjectRow }),
    );

    await expect(SubjectService.updateStatus(SUBJECT_ID, 'active', makeCtx())).rejects.toThrow(
      BusinessRuleError,
    );
  });

  it('writes status_history, timeline, audit log, and dispatches notifications on a valid transition', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const subjectRow = {
      id: SUBJECT_ID,
      company_id: COMPANY_ID,
      site_id: SITE_ID,
      subject_number: '001-001',
      status: 'pre_screening',
    };
    const updatedRow = { ...subjectRow, status: 'screening' };

    const client = makeSupabaseClient(
      { data: subjectRow }, // getById
      { data: updatedRow }, // subjects update
      { data: null }, // subject_status_history insert
      { data: null }, // subject_timeline insert
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await SubjectService.updateStatus(SUBJECT_ID, 'screening', makeCtx());

    expect(result.status).toBe('screening');
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'subject.status_changed', record_id: SUBJECT_ID }),
    );
    expect(NotificationService.dispatch).toHaveBeenCalledTimes(2);
  });

  it('closes remaining scheduled visits when the subject is marked completed', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const subjectRow = {
      id: SUBJECT_ID,
      company_id: COMPANY_ID,
      site_id: SITE_ID,
      subject_number: '001-001',
      status: 'active',
    };
    const completedRow = { ...subjectRow, status: 'completed' };

    const client = makeSupabaseClient(
      { data: subjectRow }, // getById
      { data: completedRow }, // subjects update
      { data: null }, // subject_status_history insert
      { data: null }, // subject_timeline insert
      { data: null }, // visits update (closeRemainingVisits)
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await SubjectService.updateStatus(SUBJECT_ID, 'completed', makeCtx());

    expect(result.status).toBe('completed');
  });
});

describe('SubjectService.list', () => {
  it('throws PermissionDeniedError when user lacks view_subjects', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('view_subjects'),
    );

    await expect(SubjectService.list({}, makeCtx())).rejects.toThrow(PermissionDeniedError);
  });

  it('applies a combined search filter across subject_number and initials', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const rows = [{ id: SUBJECT_ID, subject_number: '001-001', initials: 'AB' }];
    const client = makeSupabaseClient({ data: rows });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await SubjectService.list({ search: 'AB' }, makeCtx());

    expect(result).toHaveLength(1);
    const fromMock = (client as { from: ReturnType<typeof vi.fn> }).from;
    const subjectsStub = fromMock.mock.results[0]?.value as { or: ReturnType<typeof vi.fn> };
    expect(subjectsStub.or).toHaveBeenCalledWith(
      expect.stringContaining('subject_number.ilike.%AB%'),
    );
  });

  it('resolves assigned_crc via study_staff before returning subjects', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const subjectRows = [{ id: SUBJECT_ID, subject_number: '001-001', study_id: STUDY_ID }];
    const staffRows = [{ study_id: STUDY_ID }];
    // 1st .from() builds the `subjects` query chain (resolved last, via .order());
    // 2nd .from() is the study_staff lookup, awaited directly inside the filter branch.
    const client = makeSupabaseClient({ data: subjectRows }, { data: staffRows });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await SubjectService.list({ assigned_crc: USER_ID }, makeCtx());

    expect(result).toHaveLength(1);
    const fromMock = (client as { from: ReturnType<typeof vi.fn> }).from;
    expect(fromMock).toHaveBeenNthCalledWith(1, 'subjects');
    expect(fromMock).toHaveBeenNthCalledWith(2, 'study_staff');
  });

  it('short-circuits to an empty array when the CRC has no active study assignments', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const client = makeSupabaseClient({ data: null }, { data: [] });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await SubjectService.list({ assigned_crc: USER_ID }, makeCtx());
    expect(result).toEqual([]);
  });
});

describe('SubjectService.getById', () => {
  it('throws PermissionDeniedError when user lacks view_subjects', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('view_subjects'),
    );

    await expect(SubjectService.getById(SUBJECT_ID, makeCtx())).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it('throws NotFoundError when the subject does not belong to the caller company', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeSupabaseClient({ data: null });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(SubjectService.getById(SUBJECT_ID, makeCtx())).rejects.toThrow(NotFoundError);
  });
});

describe('SubjectService.listVisits', () => {
  it('returns visits ordered by visit_order, not target_date, so Screening (no target_date) is not pushed last', async () => {
    vi.spyOn(PermissionService, 'requireAnyPermission').mockResolvedValue(undefined);

    const subjectRow = {
      id: SUBJECT_ID,
      company_id: COMPANY_ID,
      site_id: SITE_ID,
      study_id: STUDY_ID,
      subject_number: '001-001',
      status: 'active',
    };
    const screeningItem = {
      id: 'item-screening',
      template_id: 'template-uuid',
      visit_name: 'Screening',
      visit_order: 1,
      is_required: true,
      is_baseline: false,
    };
    const baselineItem = {
      id: 'item-baseline',
      template_id: 'template-uuid',
      visit_name: 'Baseline',
      visit_order: 2,
      is_required: true,
      is_baseline: true,
    };
    // Rows returned out of visit_order and with a null target_date on Screening —
    // exactly the shape that a target_date ASC sort would push to the end.
    const baselineVisit = {
      id: 'visit-baseline',
      visit_template_item_id: 'item-baseline',
      visit_name: 'Baseline',
      target_date: null,
      status: 'scheduled',
    };
    const screeningVisit = {
      id: 'visit-screening',
      visit_template_item_id: 'item-screening',
      visit_name: 'Screening',
      target_date: null,
      status: 'scheduled',
    };

    const client = makeSupabaseClient(
      { data: subjectRow }, // getById
      { data: [baselineVisit, screeningVisit] }, // visits select
      { data: { id: 'template-uuid' } }, // visit_templates lookup
      { data: [screeningItem, baselineItem] }, // visit_template_items
      { data: [baselineVisit, screeningVisit] }, // visits (inside getVisitScheduleContext)
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await SubjectService.listVisits(SUBJECT_ID, makeCtx());

    expect(result.map((v) => v.visit_name)).toEqual(['Screening', 'Baseline']);
  });

  it('returns an empty array without looking up the template when the subject has no visits', async () => {
    vi.spyOn(PermissionService, 'requireAnyPermission').mockResolvedValue(undefined);

    const subjectRow = {
      id: SUBJECT_ID,
      company_id: COMPANY_ID,
      site_id: SITE_ID,
      study_id: STUDY_ID,
      subject_number: '001-001',
      status: 'active',
    };

    const client = makeSupabaseClient(
      { data: subjectRow }, // getById
      { data: [] }, // visits select -> empty
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await SubjectService.listVisits(SUBJECT_ID, makeCtx());
    expect(result).toEqual([]);
  });
});
