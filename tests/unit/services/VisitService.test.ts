import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { VisitService } from '@/services/visits/VisitService';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import {
  PermissionDeniedError,
  BusinessRuleError,
  NotFoundError,
  ConflictError,
} from '@/lib/api/errors';

vi.mock('@/services/audit/AuditService', () => ({
  AuditService: { log: vi.fn() },
}));

const COMPANY_ID = 'company-uuid';
const SITE_ID = 'site-uuid';
const STUDY_ID = 'study-uuid';
const SUBJECT_ID = 'subject-uuid';
const VISIT_ID = 'visit-uuid';
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
    gte: vi.fn().mockReturnThis(),
    lte: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
    single: vi.fn().mockResolvedValue({ data, error }),
    then: resolved.then.bind(resolved),
    catch: resolved.catch.bind(resolved),
    finally: resolved.finally.bind(resolved),
  };
  for (const key of ['select', 'eq', 'gte', 'lte', 'not', 'in', 'order', 'insert', 'update']) {
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

function makeVisit(overrides: Record<string, unknown> = {}) {
  return {
    id: VISIT_ID,
    company_id: COMPANY_ID,
    site_id: SITE_ID,
    study_id: STUDY_ID,
    subject_id: SUBJECT_ID,
    visit_template_item_id: null,
    visit_name: 'Week 4',
    visit_type: 'scheduled',
    target_date: '2026-02-01',
    scheduled_date: null,
    window_start: '2026-01-25',
    window_end: '2026-02-08',
    status: 'scheduled',
    created_by: USER_ID,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('VisitService.confirmVisit', () => {
  it('throws PermissionDeniedError when user lacks manage_visits', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('manage_visits'),
    );

    await expect(VisitService.confirmVisit(SUBJECT_ID, VISIT_ID, makeCtx())).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it('throws NotFoundError when the visit does not exist', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(makeSupabaseClient({ data: null }));

    await expect(VisitService.confirmVisit(SUBJECT_ID, VISIT_ID, makeCtx())).rejects.toThrow(
      NotFoundError,
    );
  });

  it('throws BusinessRuleError when the visit is not Scheduled', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: makeVisit({ status: 'confirmed' }) }),
    );

    await expect(VisitService.confirmVisit(SUBJECT_ID, VISIT_ID, makeCtx())).rejects.toThrow(
      BusinessRuleError,
    );
  });

  it('confirms a Scheduled visit and writes visit_history/timeline/audit', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const visit = makeVisit({ status: 'scheduled' });
    const updated = { ...visit, status: 'confirmed' };
    const client = makeSupabaseClient(
      { data: visit }, // getVisitOrThrow
      { data: updated }, // visits update
      { data: null }, // visit_history insert
      { data: null }, // subject_timeline insert
      { data: null }, // calendar_events select (existing check)
      { data: null }, // calendar_events insert (self-heal — none existed)
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await VisitService.confirmVisit(SUBJECT_ID, VISIT_ID, makeCtx());

    expect(result.status).toBe('confirmed');
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'visit.confirmed', record_id: VISIT_ID }),
    );
  });
});

describe('VisitService.startVisit', () => {
  it('throws BusinessRuleError when the visit is not Confirmed', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: makeVisit({ status: 'scheduled' }) }),
    );

    await expect(VisitService.startVisit(SUBJECT_ID, VISIT_ID, makeCtx())).rejects.toThrow(
      BusinessRuleError,
    );
  });

  it('starts a Confirmed visit and writes visit_history/timeline/audit', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const visit = makeVisit({ status: 'confirmed' });
    const updated = { ...visit, status: 'in_progress' };
    const client = makeSupabaseClient(
      { data: visit }, // getVisitOrThrow
      { data: updated }, // visits update
      { data: null }, // visit_history insert
      { data: null }, // subject_timeline insert
      { data: null }, // calendar_events select (existing check)
      { data: null }, // calendar_events insert (self-heal — none existed)
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await VisitService.startVisit(SUBJECT_ID, VISIT_ID, makeCtx());

    expect(result.status).toBe('in_progress');
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'visit.started', record_id: VISIT_ID }),
    );
  });

  // Regression test (Sprint 4.1): startVisit used to call
  // upsertCalendarEventForVisit(visit, ctx, {}) with no status override, so a
  // self-healed calendar event landed with the pre-transition 'confirmed'
  // status — the actual root cause of "no orange in_progress color."
  it('syncs the calendar event to in_progress, not confirmed', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const visit = makeVisit({ status: 'confirmed' });
    const updated = { ...visit, status: 'in_progress' };
    const client = makeSupabaseClient(
      { data: visit }, // getVisitOrThrow
      { data: updated }, // visits update
      { data: null }, // visit_history insert
      { data: null }, // subject_timeline insert
      { data: null }, // calendar_events select (existing check) — none found
      { data: null }, // calendar_events insert (self-heal)
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await VisitService.startVisit(SUBJECT_ID, VISIT_ID, makeCtx());

    const fromMock = (client as unknown as { from: ReturnType<typeof vi.fn> }).from;
    const insertStub = fromMock.mock.results[5]?.value as { insert: ReturnType<typeof vi.fn> };
    const insertedRow = (insertStub.insert as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(insertedRow.status).toBe('in_progress');
  });
});

describe('VisitService.rescheduleVisit', () => {
  const RESCHEDULE_INPUT = { target_date: '2026-03-01', reason: 'Patient requested a later date' };

  it('throws BusinessRuleError when the visit is not Scheduled or Confirmed', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: makeVisit({ status: 'in_progress' }) }),
    );

    await expect(
      VisitService.rescheduleVisit(SUBJECT_ID, VISIT_ID, RESCHEDULE_INPUT, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('reschedules a Scheduled visit without changing its status, and logs a visit_notes reason', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const visit = makeVisit({ status: 'scheduled', visit_template_item_id: null });
    const updated = { ...visit, target_date: RESCHEDULE_INPUT.target_date };
    const client = makeSupabaseClient(
      { data: visit }, // getVisitOrThrow
      { data: updated }, // visits update
      { data: null }, // visit_notes insert
      { data: null }, // subject_timeline insert
      { data: null }, // calendar_events select (existing check)
      { data: null }, // calendar_events insert (self-heal — none existed)
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await VisitService.rescheduleVisit(
      SUBJECT_ID,
      VISIT_ID,
      RESCHEDULE_INPUT,
      makeCtx(),
    );

    // Status is untouched — reschedule never transitions visits.status.
    expect(result.target_date).toBe(RESCHEDULE_INPUT.target_date);
    const fromMock = (client as unknown as { from: ReturnType<typeof vi.fn> }).from;
    const visitsUpdateStub = fromMock.mock.results[1]?.value as {
      update: ReturnType<typeof vi.fn>;
    };
    const updateArg = (visitsUpdateStub.update as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(updateArg).not.toHaveProperty('status');
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'visit.rescheduled', record_id: VISIT_ID }),
    );
  });
});

describe('VisitService.cancelVisit', () => {
  const CANCEL_INPUT = { reason: 'Subject withdrew consent' };

  it('throws BusinessRuleError when the visit is already Completed', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: makeVisit({ status: 'completed' }) }),
    );

    await expect(
      VisitService.cancelVisit(SUBJECT_ID, VISIT_ID, CANCEL_INPUT, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('cancels an In Progress visit, never deleting the row, and writes visit_history/timeline/audit', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const visit = makeVisit({ status: 'in_progress' });
    const updated = { ...visit, status: 'cancelled' };
    const client = makeSupabaseClient(
      { data: visit }, // getVisitOrThrow
      { data: updated }, // visits update
      { data: null }, // visit_history insert
      { data: null }, // subject_timeline insert
      { data: null }, // calendar_events select (existing check)
      { data: null }, // calendar_events insert (self-heal — none existed)
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await VisitService.cancelVisit(SUBJECT_ID, VISIT_ID, CANCEL_INPUT, makeCtx());

    expect(result.status).toBe('cancelled');
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'visit.cancelled', record_id: VISIT_ID }),
    );
  });
});

describe('VisitService.reopenVisit', () => {
  const REOPEN_INPUT = { reason: 'Data entry error — visit was not actually completed' };

  it('throws BusinessRuleError when the visit is not Completed', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: makeVisit({ status: 'in_progress' }) }),
    );

    await expect(
      VisitService.reopenVisit(SUBJECT_ID, VISIT_ID, REOPEN_INPUT, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('throws BusinessRuleError when the caller lacks reopen_visit, even with a reason', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: makeVisit({ status: 'completed' }) }),
    );
    vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(false);

    await expect(
      VisitService.reopenVisit(SUBJECT_ID, VISIT_ID, REOPEN_INPUT, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('throws BusinessRuleError when the caller has reopen_visit but no reason', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: makeVisit({ status: 'completed' }) }),
    );
    vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(true);

    await expect(
      VisitService.reopenVisit(SUBJECT_ID, VISIT_ID, { reason: '' }, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('reopens a Completed visit back to In Progress when permitted, writing visit_history/timeline/audit', async () => {
    const visit = makeVisit({ status: 'completed' });
    const updated = { ...visit, status: 'in_progress' };
    const client = makeSupabaseClient(
      { data: visit }, // getVisitOrThrow
      { data: updated }, // visits update
      { data: null }, // visit_history insert
      { data: null }, // subject_timeline insert
      { data: null }, // calendar_events select (existing check)
      { data: null }, // calendar_events insert (self-heal — none existed)
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);
    vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(true);

    const result = await VisitService.reopenVisit(SUBJECT_ID, VISIT_ID, REOPEN_INPUT, makeCtx());

    expect(result.status).toBe('in_progress');
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'visit.reopened', record_id: VISIT_ID }),
    );
  });
});

// Reproduces the reported bug: a visit generated before calendar-event creation
// existed (or whose event was otherwise lost) has no matching calendar_events
// row, so a plain `.update()` keyed on related_record_id silently no-ops and the
// visit never appears on the Calendar. These tests prove every action self-heals
// instead, and that the backfill is idempotent.
describe('VisitService — calendar event self-healing', () => {
  it('Confirm creates the missing calendar event, matched by related_record_type/related_record_id', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const visit = makeVisit({ status: 'scheduled' });
    const updated = { ...visit, status: 'confirmed' };
    const client = makeSupabaseClient(
      { data: visit }, // getVisitOrThrow
      { data: updated }, // visits update
      { data: null }, // visit_history insert
      { data: null }, // subject_timeline insert
      { data: null }, // calendar_events select (existing check) — none found
      { data: null }, // calendar_events insert (self-heal)
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await VisitService.confirmVisit(SUBJECT_ID, VISIT_ID, makeCtx());

    const fromMock = (client as unknown as { from: ReturnType<typeof vi.fn> }).from;
    const insertStub = fromMock.mock.results[5]?.value as { insert: ReturnType<typeof vi.fn> };
    const insertedRow = (insertStub.insert as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(insertedRow.related_record_type).toBe('visits');
    expect(insertedRow.related_record_id).toBe(VISIT_ID);
    expect(insertedRow.start_datetime).toBe(`${visit.target_date}T00:00:00Z`);
    expect(insertedRow.status).toBe('confirmed');
  });

  it('Reschedule updates the correct existing calendar event instead of creating a duplicate', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const RESCHEDULE_INPUT = {
      target_date: '2026-03-01',
      reason: 'Patient requested a later date',
    };
    const visit = makeVisit({ status: 'scheduled', visit_template_item_id: null });
    const updated = { ...visit, target_date: RESCHEDULE_INPUT.target_date };
    const client = makeSupabaseClient(
      { data: visit }, // getVisitOrThrow
      { data: updated }, // visits update
      { data: null }, // visit_notes insert
      { data: null }, // subject_timeline insert
      { data: { id: 'existing-event-uuid' } }, // calendar_events select — event already exists
      { data: null }, // calendar_events update
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await VisitService.rescheduleVisit(SUBJECT_ID, VISIT_ID, RESCHEDULE_INPUT, makeCtx());

    const fromMock = (client as unknown as { from: ReturnType<typeof vi.fn> }).from;
    const eventUpdateStub = fromMock.mock.results[5]?.value as {
      update: ReturnType<typeof vi.fn>;
      insert: ReturnType<typeof vi.fn>;
      eq: ReturnType<typeof vi.fn>;
    };
    expect(eventUpdateStub.insert).not.toHaveBeenCalled();
    const updateArg = (eventUpdateStub.update as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(updateArg.start_datetime).toBe('2026-03-01T00:00:00Z');
    // Matched by the existing row's own id — proves it updates THIS visit's
    // event rather than inserting a second, duplicate row.
    expect(eventUpdateStub.eq).toHaveBeenCalledWith('id', 'existing-event-uuid');
  });
});

describe('VisitService.backfillCalendarEvents', () => {
  function makeBackfillVisit(overrides: Record<string, unknown> = {}) {
    return {
      id: 'visit-week8-uuid',
      company_id: COMPANY_ID,
      site_id: SITE_ID,
      study_id: STUDY_ID,
      subject_id: SUBJECT_ID,
      visit_template_item_id: null,
      visit_name: 'Week 8',
      visit_type: 'scheduled',
      target_date: '2026-07-14',
      scheduled_date: null,
      window_start: '2026-07-07',
      window_end: '2026-07-21',
      status: 'confirmed',
      created_by: USER_ID,
      created_at: '',
      updated_at: '',
      ...overrides,
    };
  }

  it('creates a calendar_events row for an existing visit that has none', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const visit = makeBackfillVisit();
    const client = makeSupabaseClient(
      { data: [visit] }, // visits select (candidates with a target_date)
      { data: [] }, // calendar_events select (existingEvents) — none found
      { data: null }, // upsertCalendarEventForVisit: calendar_events select (existing check)
      { data: null }, // upsertCalendarEventForVisit: calendar_events insert
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await VisitService.backfillCalendarEvents(makeCtx());

    expect(result).toEqual({ created: 1, checked: 1, failed: 0 });

    const fromMock = (client as unknown as { from: ReturnType<typeof vi.fn> }).from;
    const insertStub = fromMock.mock.results[3]?.value as { insert: ReturnType<typeof vi.fn> };
    const insertedRow = (insertStub.insert as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(insertedRow.related_record_type).toBe('visits');
    expect(insertedRow.related_record_id).toBe(visit.id);
    expect(insertedRow.start_datetime).toBe('2026-07-14T00:00:00Z');
    // visit.status is 'confirmed' -> mapped calendar status is 'confirmed'.
    expect(insertedRow.status).toBe('confirmed');
  });

  it('running the backfill again does not duplicate an event that already exists', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const visit = makeBackfillVisit();
    const client = makeSupabaseClient(
      { data: [visit] }, // visits select (candidates with a target_date)
      { data: [{ related_record_id: visit.id }] }, // calendar_events select — already backfilled
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await VisitService.backfillCalendarEvents(makeCtx());

    expect(result).toEqual({ created: 0, checked: 1, failed: 0 });
    // Only the 2 lookup queries ran — no per-visit upsert was even attempted,
    // proving a second backfill run is a true no-op, not a redundant insert.
    const fromMock = (client as unknown as { from: ReturnType<typeof vi.fn> }).from;
    expect(fromMock).toHaveBeenCalledTimes(2);
  });

  // Regression test for the bug reported against the live Week 8 visit: the
  // backfill reported "created: 16" but the calendar showed nothing, because
  // the calendar_events INSERT was silently rejected (e.g. by the
  // can_access_site RLS check on calendar_events_insert) and the unchecked
  // `error` was discarded. A rejected write must now be counted as failed,
  // never as created.
  it('does not count a rejected write (e.g. RLS-denied insert) as created', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const visit = makeBackfillVisit();
    const client = makeSupabaseClient(
      { data: [visit] }, // visits select (candidates with a target_date)
      { data: [] }, // calendar_events select (existingEvents) — none found
      { data: null }, // upsertCalendarEventForVisit: calendar_events select (existing check)
      {
        data: null,
        error: {
          message: 'new row violates row-level security policy for table "calendar_events"',
        },
      }, // upsertCalendarEventForVisit: calendar_events insert — rejected
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await VisitService.backfillCalendarEvents(makeCtx());

    // The critical assertion: a rejected write is reported honestly, not
    // silently counted as a success the caller has no way to detect.
    expect(result).toEqual({ created: 0, checked: 1, failed: 1 });
  });
});

describe('VisitService.createCalendarEventsForVisits', () => {
  it('does nothing when given no visits', async () => {
    await VisitService.createCalendarEventsForVisits([], makeCtx());
    expect(createServerSupabaseClient).not.toHaveBeenCalled();
  });

  it('skips visits with no target_date (nothing to schedule) and inserts only the rest', async () => {
    const client = makeSupabaseClient({ data: null }); // calendar_events insert
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const visits = [
      makeVisit({ id: 'v1', target_date: null }),
      makeVisit({ id: 'v2', target_date: '2026-02-01' }),
    ] as never;

    await VisitService.createCalendarEventsForVisits(visits, makeCtx());

    const fromMock = (client as unknown as { from: ReturnType<typeof vi.fn> }).from;
    const insertStub = fromMock.mock.results[0]?.value as { insert: ReturnType<typeof vi.fn> };
    const insertedRows = (insertStub.insert as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Array<{
      related_record_id: string;
    }>;
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]?.related_record_id).toBe('v2');
  });
});

describe('VisitService.listCalendarEvents', () => {
  it('throws PermissionDeniedError when user lacks view_visits', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('view_visits'),
    );

    await expect(
      VisitService.listCalendarEvents({ start: '2026-02-01', end: '2026-02-28' }, makeCtx()),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it('filters by the given date range and optional site_id', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const rows = [{ id: 'event-1' }];
    const client = makeSupabaseClient({ data: rows });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await VisitService.listCalendarEvents(
      { start: '2026-02-01', end: '2026-02-28', site_id: SITE_ID },
      makeCtx(),
    );

    expect(result).toEqual(rows);
    const fromMock = (client as unknown as { from: ReturnType<typeof vi.fn> }).from;
    const stub = fromMock.mock.results[0]?.value as { eq: ReturnType<typeof vi.fn> };
    expect(stub.eq).toHaveBeenCalledWith('site_id', SITE_ID);
  });

  it('filters directly by status', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeSupabaseClient({ data: [{ id: 'event-1' }] });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await VisitService.listCalendarEvents(
      { start: '2026-02-01', end: '2026-02-28', status: 'in_progress' },
      makeCtx(),
    );

    const fromMock = (client as unknown as { from: ReturnType<typeof vi.fn> }).from;
    const stub = fromMock.mock.results[0]?.value as { eq: ReturnType<typeof vi.fn> };
    expect(stub.eq).toHaveBeenCalledWith('status', 'in_progress');
  });

  it('filters by study_id by first resolving matching visit ids (no FK for an embedded join)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const matchingVisits = [{ id: 'visit-a' }, { id: 'visit-b' }];
    const events = [{ id: 'event-1' }];
    // `query = supabase.from('calendar_events')...` is built (call order) before
    // the study_id/crc_user_id branch runs, even though it's awaited last — the
    // mock queue must follow .from() call order, not await order.
    const client = makeSupabaseClient(
      { data: events }, // calendar_events query (built first, awaited last)
      { data: matchingVisits }, // visits query (built + awaited second)
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await VisitService.listCalendarEvents(
      { start: '2026-02-01', end: '2026-02-28', study_id: STUDY_ID },
      makeCtx(),
    );

    expect(result).toEqual(events);
    const fromMock = (client as unknown as { from: ReturnType<typeof vi.fn> }).from;
    const eventsStub = fromMock.mock.results[0]?.value as { in: ReturnType<typeof vi.fn> };
    expect(eventsStub.in).toHaveBeenCalledWith('related_record_id', ['visit-a', 'visit-b']);
    const visitsStub = fromMock.mock.results[1]?.value as { eq: ReturnType<typeof vi.fn> };
    expect(visitsStub.eq).toHaveBeenCalledWith('study_id', STUDY_ID);
  });

  it('derives crc_user_id from active study_staff assignments (same pattern as SubjectService.list)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const staffRows = [{ study_id: STUDY_ID }];
    const matchingVisits = [{ id: 'visit-a' }];
    const events = [{ id: 'event-1' }];
    // Call order: calendar_events (built first), visits (built second), then
    // study_staff (built + awaited third, before visitQuery itself is awaited).
    const client = makeSupabaseClient(
      { data: events }, // calendar_events query
      { data: matchingVisits }, // visits query
      { data: staffRows }, // study_staff lookup
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await VisitService.listCalendarEvents(
      { start: '2026-02-01', end: '2026-02-28', crc_user_id: USER_ID },
      makeCtx(),
    );

    expect(result).toEqual(events);
    const fromMock = (client as unknown as { from: ReturnType<typeof vi.fn> }).from;
    const staffStub = fromMock.mock.results[2]?.value as { eq: ReturnType<typeof vi.fn> };
    expect(staffStub.eq).toHaveBeenCalledWith('staff_role', 'crc');
    expect(staffStub.eq).toHaveBeenCalledWith('active', true);
  });

  it('returns an empty array immediately when the CRC has no active study_staff assignments', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeSupabaseClient(
      { data: null }, // calendar_events query builder (never awaited)
      { data: null }, // visits query builder (never awaited)
      { data: [] }, // study_staff lookup — no active assignments
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await VisitService.listCalendarEvents(
      { start: '2026-02-01', end: '2026-02-28', crc_user_id: USER_ID },
      makeCtx(),
    );

    expect(result).toEqual([]);
  });

  it('enriches events with related_subject_number and related_study_id via a batched lookup', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const events = [{ id: 'event-1', related_record_type: 'visits', related_record_id: 'visit-1' }];
    const client = makeSupabaseClient(
      { data: events }, // calendar_events query
      { data: [{ id: 'visit-1', subject_id: 'subject-1', study_id: STUDY_ID }] }, // visits lookup
      { data: [{ id: 'subject-1', subject_number: '001-001' }] }, // subjects lookup
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await VisitService.listCalendarEvents(
      { start: '2026-02-01', end: '2026-02-28' },
      makeCtx(),
    );

    expect(result[0]).toMatchObject({
      related_subject_id: 'subject-1',
      related_subject_number: '001-001',
      related_study_id: STUDY_ID,
    });
  });

  it('does not attempt enrichment when no events are visit-linked', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const events = [{ id: 'event-1', related_record_type: null, related_record_id: null }];
    const client = makeSupabaseClient({ data: events }); // calendar_events query only
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await VisitService.listCalendarEvents(
      { start: '2026-02-01', end: '2026-02-28' },
      makeCtx(),
    );

    expect(result).toEqual(events);
    const fromMock = (client as unknown as { from: ReturnType<typeof vi.fn> }).from;
    expect(fromMock).toHaveBeenCalledTimes(1);
  });
});

describe('VisitService.listVisitNotes', () => {
  it('throws PermissionDeniedError when user lacks view_visits', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('view_visits'),
    );

    await expect(VisitService.listVisitNotes(SUBJECT_ID, VISIT_ID, makeCtx())).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it('throws NotFoundError when the visit does not belong to the subject/company', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(makeSupabaseClient({ data: null }));

    await expect(VisitService.listVisitNotes(SUBJECT_ID, VISIT_ID, makeCtx())).rejects.toThrow(
      NotFoundError,
    );
  });

  it('returns notes scoped to company_id and visit_id, ordered newest-first', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const visit = makeVisit();
    const notes = [
      { id: 'note-2', note: 'second' },
      { id: 'note-1', note: 'first' },
    ];
    const client = makeSupabaseClient(
      { data: visit }, // getVisitOrThrow
      { data: notes }, // visit_notes select
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await VisitService.listVisitNotes(SUBJECT_ID, VISIT_ID, makeCtx());

    expect(result).toEqual(notes);
    const fromMock = (client as unknown as { from: ReturnType<typeof vi.fn> }).from;
    const notesStub = fromMock.mock.results[1]?.value as {
      eq: ReturnType<typeof vi.fn>;
      order: ReturnType<typeof vi.fn>;
    };
    expect(notesStub.eq).toHaveBeenCalledWith('visit_id', VISIT_ID);
    expect(notesStub.eq).toHaveBeenCalledWith('company_id', COMPANY_ID);
    expect(notesStub.order).toHaveBeenCalledWith('created_at', { ascending: false });
  });
});

// Owner decision M4-D5 / migration 039: authorized visit sequence exceptions.
describe('VisitService.authorizeSequenceException', () => {
  const INPUT = { reason: '  Screening performed at the partner site on the same day  ' };
  const REASON = 'Screening performed at the partner site on the same day';

  it('requires override_visit_sequence', async () => {
    const spy = vi
      .spyOn(PermissionService, 'requirePermission')
      .mockRejectedValue(new PermissionDeniedError('override_visit_sequence'));

    await expect(
      VisitService.authorizeSequenceException(SUBJECT_ID, VISIT_ID, INPUT, makeCtx()),
    ).rejects.toThrow(PermissionDeniedError);
    expect(spy).toHaveBeenCalledWith(USER_ID, 'override_visit_sequence');
    expect(createServerSupabaseClient).not.toHaveBeenCalled();
  });

  it('throws NotFoundError when the visit is not visible', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(makeSupabaseClient({ data: null }));

    await expect(
      VisitService.authorizeSequenceException(SUBJECT_ID, VISIT_ID, INPUT, makeCtx()),
    ).rejects.toThrow(NotFoundError);
  });

  it('refuses a visit that is no longer open', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: makeVisit({ status: 'completed' }) }),
    );

    await expect(
      VisitService.authorizeSequenceException(SUBJECT_ID, VISIT_ID, INPUT, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('maps the database rule "not blocked" (23514) to ConflictError', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient(
        { data: makeVisit({ status: 'in_progress' }) },
        {
          data: null,
          error: {
            code: '23514',
            message: 'visit_sequence_exceptions: the visit is not blocked by earlier visits',
          },
        },
      ),
    );

    await expect(
      VisitService.authorizeSequenceException(SUBJECT_ID, VISIT_ID, INPUT, makeCtx()),
    ).rejects.toThrow('The visit is not blocked by earlier visits.');
    expect(AuditService.log).not.toHaveBeenCalled();
  });

  it('maps a second open exception (23505) to ConflictError', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient(
        { data: makeVisit({ status: 'in_progress' }) },
        { data: null, error: { code: '23505', message: 'duplicate key value' } },
      ),
    );

    await expect(
      VisitService.authorizeSequenceException(SUBJECT_ID, VISIT_ID, INPUT, makeCtx()),
    ).rejects.toThrow(ConflictError);
  });

  it('records the exception without client-supplied attribution, then writes timeline and audit', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const visit = makeVisit({ status: 'in_progress' });
    const stored = {
      id: 'exception-uuid',
      company_id: COMPANY_ID,
      site_id: SITE_ID,
      subject_id: SUBJECT_ID,
      visit_id: VISIT_ID,
      reason: REASON,
      blocked_by: ['Screening'],
      authorized_by: USER_ID,
      authorized_at: '2026-11-21T00:00:00Z',
      consumed_at: null,
      consumed_status: null,
    };
    const client = makeSupabaseClient(
      { data: visit }, // getVisitOrThrow
      { data: null }, // visit_sequence_exceptions insert (no RETURNING)
      { data: stored }, // read back
      { data: null }, // subject_timeline insert
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await VisitService.authorizeSequenceException(
      SUBJECT_ID,
      VISIT_ID,
      INPUT,
      makeCtx(),
    );

    expect(result.blocked_by).toEqual(['Screening']);
    const from = (client as unknown as { from: ReturnType<typeof vi.fn> }).from;
    expect(from.mock.calls.map((c) => c[0])).toEqual([
      'visits',
      'visit_sequence_exceptions',
      'visit_sequence_exceptions',
      'subject_timeline',
    ]);
    const insertStub = from.mock.results[1]?.value as { insert: ReturnType<typeof vi.fn> };
    const row = insertStub.insert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      company_id: COMPANY_ID,
      site_id: SITE_ID,
      subject_id: SUBJECT_ID,
      visit_id: VISIT_ID,
      reason: REASON,
    });
    expect(row).not.toHaveProperty('authorized_by');
    expect(row).not.toHaveProperty('blocked_by');
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'visit.sequence_exception_authorized',
        record_type: 'visit_sequence_exceptions',
        site_id: SITE_ID,
        new_value: { visit_id: VISIT_ID, reason: REASON, blocked_by: ['Screening'] },
      }),
    );
  });

  it('still succeeds (blocked_by null) when the caller cannot read the row back', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient(
        { data: makeVisit({ status: 'scheduled' }) },
        { data: null },
        { data: null },
        { data: null },
      ),
    );

    const result = await VisitService.authorizeSequenceException(
      SUBJECT_ID,
      VISIT_ID,
      INPUT,
      makeCtx(),
    );
    expect(result).toMatchObject({ visit_id: VISIT_ID, reason: REASON, blocked_by: null });
  });
});
