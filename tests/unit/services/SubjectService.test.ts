import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { SubjectService } from '@/services/subjects/SubjectService';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import { NotificationService } from '@/services/notifications/NotificationService';
import { FileService } from '@/services/files/FileService';
import {
  PermissionDeniedError,
  BusinessRuleError,
  NotFoundError,
  DatabaseError,
} from '@/lib/api/errors';
import type { FileLink } from '@/types/files';

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

// ── uploadDocument / listDocuments — baseline characterization ─────────────
// Sub-Milestone 3.3 Phase A.
//
// SubjectService.uploadDocument()/listDocuments() had ZERO test coverage
// before this block. These tests lock down CURRENT behavior — including
// undesirable behavior — BEFORE any Document Center retrofit touches them.
// No production code is changed to make these tests pass.
//
// Architectural facts this characterization establishes (see the 3.3A audit
// report for the full analysis):
//   - subject_documents is a flat, per-upload table: every call to
//     uploadDocument() inserts an independent row with its OWN file_id.
//     There is no "slot" column, no version, no is_current, no replace/
//     archive/delete method anywhere in this service. Multiple documents of
//     the same document_type for the same subject are freely allowed (no
//     uniqueness constraint), unlike Regulatory/Staff Credentials' one-slot-
//     per-scope model.
//   - subject_documents has NO site_id column of its own. The only site
//     enforcement in this path is indirect: getById()'s own RLS-backed
//     company+site scoping (subjects_select requires can_access_site).
//     uploadDocument() itself never calls PermissionService.requireSiteAccess.
//   - The storage key is `${company_id}/${subjectId}/${Date.now()}_${file.name}`
//     — Date.now() (millisecond epoch), not a UUID. A theoretical collision
//     risk (two uploads of the same filename to the same subject within the
//     same millisecond) exists and is characterized, not fixed, here.
//   - No orphan cleanup exists at any step: neither a failed storage upload
//     nor a failed subject_documents insert (after a successful files
//     insert) removes what was already written.

describe('SubjectService.uploadDocument — baseline characterization', () => {
  function baseSubject(overrides: Record<string, unknown> = {}) {
    return {
      id: SUBJECT_ID,
      company_id: COMPANY_ID,
      site_id: SITE_ID,
      study_id: STUDY_ID,
      subject_number: '001-001',
      initials: 'A.B.',
      status: 'active',
      screening_date: null,
      baseline_date: null,
      randomization_date: null,
      randomization_number: null,
      end_of_study_date: null,
      created_by: USER_ID,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  }

  function makeSubjectDocumentRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'subject-doc-uuid',
      company_id: COMPANY_ID,
      subject_id: SUBJECT_ID,
      file_id: 'file-uuid',
      document_type: null,
      uploaded_by: USER_ID,
      uploaded_at: new Date().toISOString(),
      notes: null,
      ...overrides,
    };
  }

  // No `storage` property on the plain queryStub-based client used
  // elsewhere in this file — cannot reach uploadDocument()'s
  // supabase.storage.from('subject-documents').upload() call. This variant
  // adds that support without touching the file's original
  // makeSupabaseClient (used, unmodified, by every pre-existing test).
  function makeSupabaseClientWithStorage(
    responses: Array<{ data: unknown; error?: unknown }>,
    storage?: { upload?: unknown },
  ) {
    const from = vi.fn();
    for (const r of responses) {
      from.mockReturnValueOnce(queryStub(r.data, r.error ?? null));
    }
    const storageBucket = {
      upload: storage?.upload ?? vi.fn().mockResolvedValue({ data: {}, error: null }),
    };
    return { from, storage: { from: vi.fn().mockReturnValue(storageBucket) } } as never;
  }

  function makeSupabaseClientWithCapture(
    responses: Array<{ data: unknown; error?: unknown }>,
    storage?: { upload?: unknown },
  ) {
    const stubs = responses.map((r) => queryStub(r.data, r.error ?? null));
    const from = vi.fn();
    for (const stub of stubs) {
      from.mockReturnValueOnce(stub);
    }
    const storageBucket = {
      upload: storage?.upload ?? vi.fn().mockResolvedValue({ data: {}, error: null }),
    };
    const client = { from, storage: { from: vi.fn().mockReturnValue(storageBucket) } } as never;
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

  it('throws PermissionDeniedError without edit_subject', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('edit_subject'),
    );

    await expect(
      SubjectService.uploadDocument(SUBJECT_ID, makeFile('consent.pdf', 'content'), makeCtx()),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it('throws NotFoundError for a subject belonging to a different company (company isolation, and the only site-isolation gate this path has)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClientWithStorage([{ data: null, error: { message: 'no rows' } }]),
    );

    await expect(
      SubjectService.uploadDocument(SUBJECT_ID, makeFile('consent.pdf', 'content'), makeCtx()),
    ).rejects.toThrow(NotFoundError);
  });

  it('does not call PermissionService.requireSiteAccess — site isolation for this path is entirely indirect, via getById()’s own RLS-backed scoping', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const requireSiteAccessSpy = vi.spyOn(PermissionService, 'requireSiteAccess');
    const newFileId = 'new-file-uuid';
    const client = makeSupabaseClientWithStorage([
      { data: baseSubject() }, // getById
      { data: { id: newFileId } }, // files insert
      { data: makeSubjectDocumentRow({ file_id: newFileId }) }, // subject_documents insert
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await SubjectService.uploadDocument(SUBJECT_ID, makeFile('consent.pdf', 'content'), makeCtx());

    expect(requireSiteAccessSpy).not.toHaveBeenCalled();
  });

  it('uploads to the subject-documents bucket at {company}/{subject}/{timestamp}_{filename}, records the file, links it to the subject, and audits it', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const newFileId = 'new-file-uuid';
    const uploadSpy = vi.fn().mockResolvedValue({ data: {}, error: null });
    const client = makeSupabaseClientWithStorage(
      [
        { data: baseSubject() }, // getById
        { data: { id: newFileId } }, // files insert
        { data: makeSubjectDocumentRow({ file_id: newFileId }) }, // subject_documents insert
      ],
      { upload: uploadSpy },
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await SubjectService.uploadDocument(
      SUBJECT_ID,
      makeFile('consent.pdf', 'content'),
      makeCtx(),
    );

    expect(uploadSpy).toHaveBeenCalled();
    const storageKey = uploadSpy.mock.calls[0]?.[0] as string;
    // Path convention: {company}/{subjectId}/{Date.now()}_{filename} — a
    // millisecond timestamp, not a UUID (characterized, not fixed, here).
    expect(storageKey).toMatch(new RegExp(`^${COMPANY_ID}/${SUBJECT_ID}/\\d+_consent\\.pdf$`));

    expect(result.file_id).toBe(newFileId);
    expect(result.subject_id).toBe(SUBJECT_ID);
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'subject.document_uploaded',
        company_id: COMPANY_ID,
        site_id: SITE_ID,
      }),
    );
  });

  it('persists company_id, subject_id, and file_id exactly as produced by this flow — never any other source', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const newFileId = 'distinct-file-uuid';
    const { client, stubs } = makeSupabaseClientWithCapture([
      { data: baseSubject() },
      { data: { id: newFileId } },
      { data: makeSubjectDocumentRow({ file_id: newFileId }) },
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await SubjectService.uploadDocument(
      SUBJECT_ID,
      makeFile('consent.pdf', 'content'),
      makeCtx(),
      'consent_form',
    );

    const fileInsertArgs = callArgsOf(stubs[1], 'insert') as Record<string, unknown>;
    expect(fileInsertArgs).toMatchObject({ company_id: COMPANY_ID });

    const docInsertArgs = callArgsOf(stubs[2], 'insert') as Record<string, unknown>;
    expect(docInsertArgs).toMatchObject({
      company_id: COMPANY_ID,
      subject_id: SUBJECT_ID,
      file_id: newFileId,
      document_type: 'consent_form',
    });
  });

  it('passes null document_type when none is supplied', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const newFileId = 'new-file-uuid';
    const { client, stubs } = makeSupabaseClientWithCapture([
      { data: baseSubject() },
      { data: { id: newFileId } },
      { data: makeSubjectDocumentRow({ file_id: newFileId }) },
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await SubjectService.uploadDocument(SUBJECT_ID, makeFile('consent.pdf', 'content'), makeCtx());

    const docInsertArgs = callArgsOf(stubs[2], 'insert') as Record<string, unknown>;
    expect(docInsertArgs).toMatchObject({ document_type: null });
  });

  it('throws DatabaseError when the storage upload itself fails, without attempting any cleanup (no files row was created yet at this point)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeSupabaseClientWithStorage([{ data: baseSubject() }], {
      upload: vi.fn().mockResolvedValue({ data: null, error: { message: 'storage down' } }),
    });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      SubjectService.uploadDocument(SUBJECT_ID, makeFile('consent.pdf', 'content'), makeCtx()),
    ).rejects.toThrow('Document upload failed');
  });

  it('throws DatabaseError when the files metadata insert fails — the storage object is left behind, uncleaned (pre-existing gap, characterized not fixed)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const uploadSpy = vi.fn().mockResolvedValue({ data: {}, error: null });
    const client = makeSupabaseClientWithStorage(
      [{ data: baseSubject() }, { data: null, error: { message: 'insert failed' } }],
      { upload: uploadSpy },
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      SubjectService.uploadDocument(SUBJECT_ID, makeFile('consent.pdf', 'content'), makeCtx()),
    ).rejects.toThrow(DatabaseError);
    // No .remove() call exists anywhere in this path — nothing to assert
    // being called; the absence itself is the characterized behavior.
    expect(uploadSpy).toHaveBeenCalled();
  });

  it('throws DatabaseError when the subject_documents insert fails after a successful files insert — both the storage object AND the files row are left orphaned (pre-existing gap, characterized not fixed)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const newFileId = 'new-file-uuid';
    const client = makeSupabaseClientWithStorage([
      { data: baseSubject() },
      { data: { id: newFileId } }, // files insert succeeds
      { data: null, error: { message: 'link insert failed' } }, // subject_documents insert fails
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      SubjectService.uploadDocument(SUBJECT_ID, makeFile('consent.pdf', 'content'), makeCtx()),
    ).rejects.toThrow('link insert failed');
  });

  it('never returns a public or signed URL — this path has no URL-issuing capability at all today', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const newFileId = 'new-file-uuid';
    const client = makeSupabaseClientWithStorage([
      { data: baseSubject() },
      { data: { id: newFileId } },
      { data: makeSubjectDocumentRow({ file_id: newFileId }) },
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await SubjectService.uploadDocument(
      SUBJECT_ID,
      makeFile('consent.pdf', 'content'),
      makeCtx(),
    );

    expect(result).not.toHaveProperty('url');
    expect(result).not.toHaveProperty('signedUrl');
    expect(result).not.toHaveProperty('publicUrl');
  });
});

// ── Sub-Milestone 3.3B: Document Center retrofit for uploadDocument() ──────
//
// Subjects uses a multi-attachment model (see the 3.3A audit): every
// subject_documents row is its own independent logical document, so
// record_id is the individual subject_documents row's id, NOT subject_id —
// unlike Regulatory/Staff Credentials' one-slot-per-scope model. Only
// linkForModule is ever used here; there is no replace/relink concept.

describe('SubjectService.uploadDocument — Document Center retrofit', () => {
  function baseSubject(overrides: Record<string, unknown> = {}) {
    return {
      id: SUBJECT_ID,
      company_id: COMPANY_ID,
      site_id: SITE_ID,
      study_id: STUDY_ID,
      subject_number: '001-001',
      initials: 'A.B.',
      status: 'active',
      screening_date: null,
      baseline_date: null,
      randomization_date: null,
      randomization_number: null,
      end_of_study_date: null,
      created_by: USER_ID,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  }

  function makeSubjectDocumentRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'subject-doc-uuid',
      company_id: COMPANY_ID,
      subject_id: SUBJECT_ID,
      file_id: 'file-uuid',
      document_type: null,
      uploaded_by: USER_ID,
      uploaded_at: new Date().toISOString(),
      notes: null,
      ...overrides,
    };
  }

  function makeSupabaseClientWithStorage(
    responses: Array<{ data: unknown; error?: unknown }>,
    storage?: { upload?: unknown },
  ) {
    const from = vi.fn();
    for (const r of responses) {
      from.mockReturnValueOnce(queryStub(r.data, r.error ?? null));
    }
    const storageBucket = {
      upload: storage?.upload ?? vi.fn().mockResolvedValue({ data: {}, error: null }),
    };
    return { from, storage: { from: vi.fn().mockReturnValue(storageBucket) } } as never;
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

  function successClient(subjectDocId: string, newFileId: string) {
    return makeSupabaseClientWithStorage([
      { data: baseSubject() }, // getById
      { data: { id: newFileId } }, // files insert
      { data: makeSubjectDocumentRow({ id: subjectDocId, file_id: newFileId }) }, // subject_documents insert
    ]);
  }

  it('A/C: calls linkForModule exactly once, with module=subject_documents', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const linkSpy = vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const newFileId = 'new-file-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      successClient('subject-doc-uuid', newFileId),
    );

    await SubjectService.uploadDocument(SUBJECT_ID, makeFile('consent.pdf', 'content'), makeCtx());

    expect(linkSpy).toHaveBeenCalledTimes(1);
    expect(linkSpy).toHaveBeenCalledWith(
      expect.objectContaining({ module: 'subject_documents' }),
      expect.anything(),
    );
  });

  it('B: passes the exact fileId returned by the upload flow — never a reconstructed identifier', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const linkSpy = vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const newFileId = 'distinct-file-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      successClient('subject-doc-uuid', newFileId),
    );

    await SubjectService.uploadDocument(SUBJECT_ID, makeFile('consent.pdf', 'content'), makeCtx());

    const callArgs = linkSpy.mock.calls[0]?.[0];
    expect(callArgs?.file_id).toBe(newFileId);
  });

  it('D/E: passes subjectDocument.id as record_id — never subject_id', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const linkSpy = vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const newFileId = 'new-file-uuid';
    const subjectDocId = 'distinct-subject-doc-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(successClient(subjectDocId, newFileId));

    await SubjectService.uploadDocument(SUBJECT_ID, makeFile('consent.pdf', 'content'), makeCtx());

    const callArgs = linkSpy.mock.calls[0]?.[0];
    expect(callArgs?.record_id).toBe(subjectDocId);
    expect(callArgs?.record_id).not.toBe(SUBJECT_ID);
  });

  it('F: passes the authoritative subject.site_id obtained via getById()', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const linkSpy = vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const newFileId = 'new-file-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      successClient('subject-doc-uuid', newFileId),
    );

    await SubjectService.uploadDocument(SUBJECT_ID, makeFile('consent.pdf', 'content'), makeCtx());

    expect(linkSpy).toHaveBeenCalledWith(
      expect.objectContaining({ site_id: SITE_ID }),
      expect.anything(),
    );
  });

  it('G/H: linkForModule is called only after the subject_documents insert and the existing AuditService.log call have both already succeeded', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const callOrder: string[] = [];
    vi.mocked(AuditService.log).mockImplementation(async () => {
      callOrder.push('audit');
    });
    vi.spyOn(FileService, 'linkForModule').mockImplementation(async () => {
      callOrder.push('link');
      return {} as FileLink;
    });
    const newFileId = 'new-file-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      successClient('subject-doc-uuid', newFileId),
    );

    await SubjectService.uploadDocument(SUBJECT_ID, makeFile('consent.pdf', 'content'), makeCtx());

    expect(callOrder).toEqual(['audit', 'link']);
  });

  it('I: still succeeds and returns the finalized document when linkForModule fails (failure is logged, not swallowed silently, and never rolled back)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(FileService, 'linkForModule').mockRejectedValue(new Error('file_links insert failed'));
    const newFileId = 'new-file-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      successClient('subject-doc-uuid', newFileId),
    );

    const result = await SubjectService.uploadDocument(
      SUBJECT_ID,
      makeFile('consent.pdf', 'content'),
      makeCtx(),
    );

    expect(result.file_id).toBe(newFileId);
    expect(result.subject_id).toBe(SUBJECT_ID);
  });

  it('J: the return shape is unchanged — still the plain SubjectDocument row', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const newFileId = 'new-file-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      successClient('subject-doc-uuid', newFileId),
    );

    const result = await SubjectService.uploadDocument(
      SUBJECT_ID,
      makeFile('consent.pdf', 'content'),
      makeCtx(),
    );

    expect(Object.keys(result).sort()).toEqual(
      [
        'id',
        'company_id',
        'subject_id',
        'file_id',
        'document_type',
        'uploaded_by',
        'uploaded_at',
        'notes',
      ].sort(),
    );
  });

  it('K: never exposes a public URL from the Document Center link', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(FileService, 'linkForModule').mockResolvedValue({
      id: 'link-uuid',
      company_id: COMPANY_ID,
      file_id: 'new-file-uuid',
      site_id: SITE_ID,
      module: 'subject_documents',
      record_id: 'subject-doc-uuid',
      created_by: USER_ID,
      created_at: new Date().toISOString(),
    } as FileLink);
    const newFileId = 'new-file-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      successClient('subject-doc-uuid', newFileId),
    );

    const result = await SubjectService.uploadDocument(
      SUBJECT_ID,
      makeFile('consent.pdf', 'content'),
      makeCtx(),
    );

    expect(result).not.toHaveProperty('url');
    expect(result).not.toHaveProperty('signedUrl');
    expect(result).not.toHaveProperty('publicUrl');
  });

  it('L: existing permission enforcement (edit_subject) is unaffected by the retrofit', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('edit_subject'),
    );

    await expect(
      SubjectService.uploadDocument(SUBJECT_ID, makeFile('consent.pdf', 'content'), makeCtx()),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it('multi-attachment: two uploads for the same subject produce two independent subject_documents rows, each with its own linkForModule call — no relink, no replacement', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const linkSpy = vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const relinkSpy = vi.spyOn(FileService, 'relinkForModule');

    // uploadDocument() calls createServerSupabaseClient() TWICE per
    // invocation (once inside getById(), once in its own body) — the same
    // client (and its single 3-deep `from` queue) must satisfy both calls,
    // exactly like every other test in this file. mockResolvedValue
    // (persistent, not Once) is therefore set once per upload, not once
    // per internal call.
    const fileIdA = 'file-a-uuid';
    const subjectDocIdA = 'subject-doc-a-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(successClient(subjectDocIdA, fileIdA));
    const docA = await SubjectService.uploadDocument(
      SUBJECT_ID,
      makeFile('consent.pdf', 'content A'),
      makeCtx(),
      'consent_form',
    );

    const fileIdB = 'file-b-uuid';
    const subjectDocIdB = 'subject-doc-b-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(successClient(subjectDocIdB, fileIdB));
    const docB = await SubjectService.uploadDocument(
      SUBJECT_ID,
      makeFile('lab-report.pdf', 'content B'),
      makeCtx(),
      'lab_report',
    );

    // Same subject, different logical documents.
    expect(docA.subject_id).toBe(SUBJECT_ID);
    expect(docB.subject_id).toBe(SUBJECT_ID);
    expect(docA.id).not.toBe(docB.id);
    expect(docA.file_id).not.toBe(docB.file_id);

    // Two independent linkForModule calls, each with its own record_id/file_id.
    expect(linkSpy).toHaveBeenCalledTimes(2);
    expect(linkSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        file_id: fileIdA,
        module: 'subject_documents',
        record_id: subjectDocIdA,
        site_id: SITE_ID,
      }),
      expect.anything(),
    );
    expect(linkSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        file_id: fileIdB,
        module: 'subject_documents',
        record_id: subjectDocIdB,
        site_id: SITE_ID,
      }),
      expect.anything(),
    );

    // No relink/replace semantics apply to this module.
    expect(relinkSpy).not.toHaveBeenCalled();
  });
});

describe('SubjectService.listDocuments — baseline characterization', () => {
  it('throws PermissionDeniedError without view_subjects', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('view_subjects'),
    );

    await expect(SubjectService.listDocuments(SUBJECT_ID, makeCtx())).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it('throws NotFoundError for a subject belonging to a different company', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: null, error: { message: 'no rows' } }),
    );

    await expect(SubjectService.listDocuments(SUBJECT_ID, makeCtx())).rejects.toThrow(
      NotFoundError,
    );
  });

  it("returns every document row for the subject, scoped to the caller's company", async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const subjectRow = {
      id: SUBJECT_ID,
      company_id: COMPANY_ID,
      site_id: SITE_ID,
      study_id: STUDY_ID,
      subject_number: '001-001',
      status: 'active',
    };
    const docs = [
      { id: 'doc-1', company_id: COMPANY_ID, subject_id: SUBJECT_ID, file_id: 'file-1' },
      { id: 'doc-2', company_id: COMPANY_ID, subject_id: SUBJECT_ID, file_id: 'file-2' },
    ];
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: subjectRow }, { data: docs }),
    );

    const result = await SubjectService.listDocuments(SUBJECT_ID, makeCtx());
    expect(result).toHaveLength(2);
  });

  it('returns an empty array when the subject has no documents', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const subjectRow = {
      id: SUBJECT_ID,
      company_id: COMPANY_ID,
      site_id: SITE_ID,
      study_id: STUDY_ID,
      subject_number: '001-001',
      status: 'active',
    };
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: subjectRow }, { data: [] }),
    );

    const result = await SubjectService.listDocuments(SUBJECT_ID, makeCtx());
    expect(result).toEqual([]);
  });
});
