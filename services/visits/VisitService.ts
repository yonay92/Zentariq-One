import { randomUUID } from 'crypto';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import {
  NotFoundError,
  DatabaseError,
  BusinessRuleError,
  ConflictError,
  databaseWriteError,
} from '@/lib/api/errors';
import { logger } from '@/lib/logger';
import type {
  RescheduleVisitInput,
  CancelVisitInput,
  ReopenVisitInput,
  CreateUnscheduledVisitInput,
  VisitNote,
  AuthorizeVisitSequenceExceptionInput,
  VisitSequenceException,
} from '@/types/visits';
import type { Visit } from '@/types/subjects';
import type { CalendarEvent, ListCalendarEventsFilters } from '@/types/calendar';
import type { RequestContext } from '@/types/api';

const VISIT_COLUMNS =
  'id, company_id, site_id, study_id, subject_id, visit_template_item_id, visit_name, visit_type, target_date, scheduled_date, window_start, window_end, status, created_by, created_at, updated_at';
const CALENDAR_EVENT_COLUMNS =
  'id, company_id, site_id, event_type, title, description, start_datetime, end_datetime, related_record_type, related_record_id, status, created_by, created_at, updated_at';
const VISIT_NOTE_COLUMNS = 'id, company_id, visit_id, note, created_by, created_at';
const SEQUENCE_EXCEPTION_COLUMNS =
  'id, company_id, site_id, subject_id, visit_id, reason, blocked_by, authorized_by, authorized_at, consumed_at, consumed_status';

async function getVisitOrThrow(
  subjectId: string,
  visitId: string,
  ctx: RequestContext,
): Promise<Visit> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from('visits')
    .select(VISIT_COLUMNS)
    .eq('id', visitId)
    .eq('subject_id', subjectId)
    .eq('company_id', ctx.company.id)
    .single();

  if (error || !data) throw new NotFoundError('Visit');
  return data as Visit;
}

async function writeVisitTransition(
  visit: Visit,
  newStatus: Visit['status'],
  ctx: RequestContext,
  options: { reason?: string | null; auditAction: string; timelineDescription: string },
): Promise<Visit> {
  const supabase = await createServerSupabaseClient();

  const { data: updated, error } = await supabase
    .from('visits')
    .update({ status: newStatus })
    .eq('id', visit.id)
    .eq('company_id', ctx.company.id)
    .select(VISIT_COLUMNS)
    .single();

  if (error || !updated) throw databaseWriteError(error, 'Failed to update visit');

  // GAP-DUP-01 three-way write, same pattern as subject_status_history /
  // subject_timeline / audit_logs for subject status changes.
  await supabase.from('visit_history').insert({
    company_id: ctx.company.id,
    visit_id: visit.id,
    old_status: visit.status,
    new_status: newStatus,
    changed_by: ctx.user.id,
    reason: options.reason ?? null,
  });

  await addSubjectTimelineEvent(
    visit.subject_id,
    ctx.company.id,
    'visit_status_changed',
    options.timelineDescription,
    ctx.user.id,
    visit.id,
  );

  await AuditService.log({
    company_id: ctx.company.id,
    site_id: visit.site_id,
    user_id: ctx.user.id,
    action: options.auditAction,
    module: 'subjects',
    record_type: 'visits',
    record_id: visit.id,
    old_value: { status: visit.status },
    new_value: { status: newStatus, reason: options.reason ?? null },
  });

  return updated as Visit;
}

// Deliberately does not import SubjectService.addTimelineEvent — VisitService must
// have zero import dependency on SubjectService so SubjectService can import
// VisitService (for createCalendarEventsForVisits) without a circular dependency.
async function addSubjectTimelineEvent(
  subjectId: string,
  companyId: string,
  eventType: string,
  description: string,
  userId: string,
  relatedRecordId?: string,
): Promise<void> {
  const supabase = await createServerSupabaseClient();
  await supabase.from('subject_timeline').insert({
    company_id: companyId,
    subject_id: subjectId,
    event_type: eventType,
    event_date: new Date().toISOString(),
    description,
    related_record_type: relatedRecordId ? 'visits' : null,
    related_record_id: relatedRecordId ?? null,
    created_by: userId,
  });
}

async function getSubjectSiteContext(
  subjectId: string,
  ctx: RequestContext,
): Promise<{ site_id: string; study_id: string }> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from('subjects')
    .select('site_id, study_id')
    .eq('id', subjectId)
    .eq('company_id', ctx.company.id)
    .single();

  if (error || !data) throw new NotFoundError('Subject');
  return data as { site_id: string; study_id: string };
}

// calendar_events.status only models 4 states (scheduled/confirmed/completed/
// cancelled) — narrower than visits.status. Used only as the self-heal default
// when an action that doesn't own calendar status itself (Start) has to create
// a missing event; actions that do own a status (Confirm/Cancel/Reopen/
// Complete) always pass an explicit override instead.
function mapVisitStatusToCalendarStatus(status: Visit['status']): CalendarEvent['status'] {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'confirmed':
      return 'confirmed';
    case 'in_progress':
      return 'in_progress';
    default:
      return 'scheduled';
  }
}

type CalendarEventSync = {
  status?: CalendarEvent['status'];
  target_date?: string;
};

// Ensures a calendar_events row exists for this visit — matched by
// related_record_type='visits' + related_record_id=visit.id, scoped to
// company_id — and applies any given overrides. Visits generated before
// calendar-event creation existed (or whose event was otherwise lost) have no
// matching row, so a plain `.update()` keyed on related_record_id silently
// matches zero rows and the visit never appears on the Calendar. This upsert
// creates the missing row from the visit's current data instead, so every
// lifecycle action self-heals rather than propagating the gap. Never touches
// an existing row when `overrides` is empty (e.g. Start, which doesn't own
// calendar status when the row already exists).
async function upsertCalendarEventForVisit(
  visit: Visit,
  ctx: RequestContext,
  overrides: CalendarEventSync = {},
): Promise<void> {
  const supabase = await createServerSupabaseClient();
  const { data: existing, error: selectError } = await supabase
    .from('calendar_events')
    .select('id')
    .eq('related_record_type', 'visits')
    .eq('related_record_id', visit.id)
    .eq('company_id', ctx.company.id)
    .maybeSingle();

  // Every write below must be checked — an RLS rejection (e.g. can_access_site
  // failing on calendar_events_insert) returns an error object rather than
  // throwing, and a caller (backfillCalendarEvents in particular) that doesn't
  // check it will report a successful write that never actually happened.
  if (selectError) throw new DatabaseError(selectError.message);

  if (existing) {
    const patch: Record<string, unknown> = {};
    if (overrides.status) patch.status = overrides.status;
    if (overrides.target_date) {
      patch.start_datetime = `${overrides.target_date}T00:00:00Z`;
      patch.end_datetime = `${overrides.target_date}T00:00:00Z`;
    }
    if (Object.keys(patch).length === 0) return;

    const { error: updateError } = await supabase
      .from('calendar_events')
      .update(patch)
      .eq('id', (existing as { id: string }).id)
      .eq('company_id', ctx.company.id);
    if (updateError) throw new DatabaseError(updateError.message);
    return;
  }

  const targetDate = overrides.target_date ?? visit.target_date;
  // Still unanchored (e.g. a Screening/Baseline placeholder with no date yet)
  // — genuinely nothing to schedule, same rule as createCalendarEventsForVisits.
  if (!targetDate) return;

  const { error: insertError } = await supabase.from('calendar_events').insert({
    company_id: ctx.company.id,
    site_id: visit.site_id,
    event_type: 'patient_visit',
    title: visit.visit_name,
    description: null,
    start_datetime: `${targetDate}T00:00:00Z`,
    end_datetime: `${targetDate}T00:00:00Z`,
    related_record_type: 'visits',
    related_record_id: visit.id,
    status: overrides.status ?? mapVisitStatusToCalendarStatus(visit.status),
    created_by: ctx.user.id,
  });
  if (insertError) throw new DatabaseError(insertError.message);
}

export const VisitService = {
  async confirmVisit(subjectId: string, visitId: string, ctx: RequestContext): Promise<Visit> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_visits');

    const visit = await getVisitOrThrow(subjectId, visitId, ctx);
    if (visit.status !== 'scheduled') {
      throw new BusinessRuleError('Only a Scheduled visit can be confirmed');
    }

    const updated = await writeVisitTransition(visit, 'confirmed', ctx, {
      auditAction: 'visit.confirmed',
      timelineDescription: `${visit.visit_name} visit confirmed`,
    });

    await upsertCalendarEventForVisit(visit, ctx, { status: 'confirmed' });

    return updated;
  },

  async startVisit(subjectId: string, visitId: string, ctx: RequestContext): Promise<Visit> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_visits');

    const visit = await getVisitOrThrow(subjectId, visitId, ctx);
    if (visit.status !== 'confirmed') {
      throw new BusinessRuleError('Only a Confirmed visit can be started');
    }

    const updated = await writeVisitTransition(visit, 'in_progress', ctx, {
      auditAction: 'visit.started',
      timelineDescription: `${visit.visit_name} visit started`,
    });

    await upsertCalendarEventForVisit(visit, ctx, { status: 'in_progress' });

    return updated;
  },

  async rescheduleVisit(
    subjectId: string,
    visitId: string,
    input: RescheduleVisitInput,
    ctx: RequestContext,
  ): Promise<Visit> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_visits');

    const visit = await getVisitOrThrow(subjectId, visitId, ctx);
    if (visit.status !== 'scheduled' && visit.status !== 'confirmed') {
      throw new BusinessRuleError('Only a Scheduled or Confirmed visit can be rescheduled');
    }

    const supabase = await createServerSupabaseClient();

    let windowBefore = 0;
    let windowAfter = 0;
    if (visit.visit_template_item_id) {
      const { data: item } = await supabase
        .from('visit_template_items')
        .select('window_before, window_after')
        .eq('id', visit.visit_template_item_id)
        .maybeSingle();
      if (item) {
        const row = item as { window_before: number; window_after: number };
        windowBefore = row.window_before;
        windowAfter = row.window_after;
      }
    } else if (visit.window_start && visit.target_date) {
      windowBefore = Math.round(
        (new Date(visit.target_date).getTime() - new Date(visit.window_start).getTime()) /
          86_400_000,
      );
    } else if (visit.window_end && visit.target_date) {
      windowAfter = Math.round(
        (new Date(visit.window_end).getTime() - new Date(visit.target_date).getTime()) / 86_400_000,
      );
    }

    const targetDate = input.target_date;
    const toDateString = (base: string, days: number): string => {
      const d = new Date(`${base}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    };

    const { data: updated, error } = await supabase
      .from('visits')
      .update({
        target_date: targetDate,
        window_start: toDateString(targetDate, -windowBefore),
        window_end: toDateString(targetDate, windowAfter),
      })
      .eq('id', visitId)
      .eq('company_id', ctx.company.id)
      .select(VISIT_COLUMNS)
      .single();

    if (error || !updated) throw new DatabaseError(error?.message ?? 'Failed to reschedule visit');

    await supabase.from('visit_notes').insert({
      company_id: ctx.company.id,
      visit_id: visitId,
      note: `Rescheduled from ${visit.target_date ?? 'unset'} to ${targetDate}: ${input.reason}`,
      created_by: ctx.user.id,
    });

    await addSubjectTimelineEvent(
      subjectId,
      ctx.company.id,
      'visit_rescheduled',
      `${visit.visit_name} visit rescheduled to ${targetDate}: ${input.reason}`,
      ctx.user.id,
      visitId,
    );

    await AuditService.log({
      company_id: ctx.company.id,
      site_id: visit.site_id,
      user_id: ctx.user.id,
      action: 'visit.rescheduled',
      module: 'subjects',
      record_type: 'visits',
      record_id: visitId,
      old_value: { target_date: visit.target_date },
      new_value: { target_date: targetDate, reason: input.reason },
    });

    await upsertCalendarEventForVisit(visit, ctx, { target_date: targetDate });

    return updated as Visit;
  },

  async cancelVisit(
    subjectId: string,
    visitId: string,
    input: CancelVisitInput,
    ctx: RequestContext,
  ): Promise<Visit> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_visits');

    const visit = await getVisitOrThrow(subjectId, visitId, ctx);
    if (!['scheduled', 'confirmed', 'in_progress'].includes(visit.status)) {
      throw new BusinessRuleError(
        'Only a Scheduled, Confirmed, or In Progress visit can be cancelled',
      );
    }

    const updated = await writeVisitTransition(visit, 'cancelled', ctx, {
      reason: input.reason,
      auditAction: 'visit.cancelled',
      timelineDescription: `${visit.visit_name} visit cancelled: ${input.reason}`,
    });

    await upsertCalendarEventForVisit(visit, ctx, { status: 'cancelled' });

    return updated;
  },

  async reopenVisit(
    subjectId: string,
    visitId: string,
    input: ReopenVisitInput,
    ctx: RequestContext,
  ): Promise<Visit> {
    const visit = await getVisitOrThrow(subjectId, visitId, ctx);
    if (visit.status !== 'completed') {
      throw new BusinessRuleError('Only a Completed visit can be reopened');
    }

    // Reopening a completed visit is always the dangerous case — unlike
    // archiveStudy/archiveSite (conditionally blocked on enrolled-subject count),
    // there is no "safe" path here, so `blocked` is unconditionally true.
    await PermissionService.guardDangerousOperation(ctx.user.id, 'reopen_visit', {
      blocked: true,
      reason: input.reason,
      blockedMessage:
        'Reopening a completed visit requires the Reopen Visit permission and a reason.',
    });

    const updated = await writeVisitTransition(visit, 'in_progress', ctx, {
      reason: input.reason,
      auditAction: 'visit.reopened',
      timelineDescription: `${visit.visit_name} visit reopened: ${input.reason}`,
    });

    await upsertCalendarEventForVisit(visit, ctx, { status: 'scheduled' });

    return updated;
  },

  // Owner decision M4-D5 / migration 039: an authorized user may record a
  // justified exception so that ONE completion of this visit may proceed
  // although required earlier visits are not done. The database decides
  // whether the visit is actually blocked (and records which visits block
  // it), derives the author and time, allows one open exception per visit
  // and consumes it atomically when the visit is completed. The application
  // writes the timeline and audit entries (Clinical Research Domain Rules).
  async authorizeSequenceException(
    subjectId: string,
    visitId: string,
    input: AuthorizeVisitSequenceExceptionInput,
    ctx: RequestContext,
  ): Promise<VisitSequenceException> {
    await PermissionService.requirePermission(ctx.user.id, 'override_visit_sequence');

    const visit = await getVisitOrThrow(subjectId, visitId, ctx);
    if (!['scheduled', 'confirmed', 'in_progress'].includes(visit.status)) {
      throw new BusinessRuleError(
        `A sequence exception can only be recorded for an open visit (current status: ${visit.status})`,
      );
    }

    const reason = input.reason.trim();
    const supabase = await createServerSupabaseClient();
    // Insert without RETURNING: the row is read back separately, so a caller
    // whose SELECT policy would hide it still gets a clear result (038 lesson).
    const id = randomUUID();
    const { error } = await supabase.from('visit_sequence_exceptions').insert({
      id,
      company_id: ctx.company.id,
      site_id: visit.site_id,
      subject_id: visit.subject_id,
      visit_id: visit.id,
      reason,
    });
    if (error) {
      if (error.code === '23505') {
        throw new ConflictError(
          'This visit already has an open sequence exception. Complete the visit or ask an administrator to review it.',
        );
      }
      throw databaseWriteError(error, 'Failed to record the sequence exception');
    }

    const { data: stored } = await supabase
      .from('visit_sequence_exceptions')
      .select(SEQUENCE_EXCEPTION_COLUMNS)
      .eq('id', id)
      .eq('company_id', ctx.company.id)
      .maybeSingle();
    const exception: VisitSequenceException = stored
      ? (stored as VisitSequenceException)
      : {
          id,
          company_id: ctx.company.id,
          site_id: visit.site_id,
          subject_id: visit.subject_id,
          visit_id: visit.id,
          reason,
          blocked_by: null,
          authorized_by: ctx.user.id,
          authorized_at: null,
          consumed_at: null,
          consumed_status: null,
        };

    await addSubjectTimelineEvent(
      visit.subject_id,
      ctx.company.id,
      'visit_sequence_exception',
      `Sequence exception recorded for ${visit.visit_name}: ${reason}`,
      ctx.user.id,
      visit.id,
    );

    await AuditService.log({
      company_id: ctx.company.id,
      site_id: visit.site_id,
      user_id: ctx.user.id,
      action: 'visit.sequence_exception_authorized',
      module: 'subjects',
      record_type: 'visit_sequence_exceptions',
      record_id: id,
      old_value: null,
      new_value: {
        visit_id: visit.id,
        reason,
        blocked_by: exception.blocked_by,
      },
    });

    return exception;
  },

  async createUnscheduledVisit(
    subjectId: string,
    input: CreateUnscheduledVisitInput,
    ctx: RequestContext,
  ): Promise<Visit> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_visits');

    const subject = await getSubjectSiteContext(subjectId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('visits')
      .insert({
        company_id: ctx.company.id,
        site_id: subject.site_id,
        study_id: subject.study_id,
        subject_id: subjectId,
        visit_template_item_id: null,
        visit_name: input.visit_name,
        visit_type: 'unscheduled',
        target_date: input.target_date,
        window_start: input.target_date,
        window_end: input.target_date,
        status: 'scheduled',
        created_by: ctx.user.id,
      })
      .select(VISIT_COLUMNS)
      .single();

    if (error || !data) {
      throw databaseWriteError(error, 'Failed to create unscheduled visit');
    }

    const visit = data as Visit;

    if (input.notes?.trim()) {
      await supabase.from('visit_notes').insert({
        company_id: ctx.company.id,
        visit_id: visit.id,
        note: input.notes.trim(),
        created_by: ctx.user.id,
      });
    }

    await this.createCalendarEventsForVisits([visit], ctx);

    await addSubjectTimelineEvent(
      subjectId,
      ctx.company.id,
      'unscheduled_visit_created',
      `Unscheduled visit "${visit.visit_name}" added for ${input.target_date}`,
      ctx.user.id,
      visit.id,
    );

    await AuditService.log({
      company_id: ctx.company.id,
      site_id: subject.site_id,
      user_id: ctx.user.id,
      action: 'visit.unscheduled_created',
      module: 'subjects',
      record_type: 'visits',
      record_id: visit.id,
      new_value: { visit_name: visit.visit_name, target_date: input.target_date },
    });

    // Chart/Task creation on completion (docs/BUSINESS_RULES_04_Visits.md) is
    // deferred — Charts and Task Engine ship in Sprint 5/8, same as the
    // equivalent deferred-comments in SubjectService.

    return visit;
  },

  // Resolves a bare visit ID with no subject in the path — needed by the Calendar
  // page, which only has calendar_events.related_record_id (a visit ID) to work
  // from, not the owning subject. Every subject-scoped visit action route requires
  // a subjectId, so the Calendar detail panel fetches the full visit (including
  // its subject_id) once here before delegating to those same routes.
  async getVisitById(visitId: string, ctx: RequestContext): Promise<Visit> {
    await PermissionService.requirePermission(ctx.user.id, 'view_visits');

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('visits')
      .select(VISIT_COLUMNS)
      .eq('id', visitId)
      .eq('company_id', ctx.company.id)
      .single();

    if (error || !data) throw new NotFoundError('Visit');
    return data as Visit;
  },

  // Powers the Calendar detail panel's "Notes" section — visit_notes has existed
  // since 010_visit_calendar.sql (written by rescheduleVisit) but had no reader
  // until now.
  async listVisitNotes(
    subjectId: string,
    visitId: string,
    ctx: RequestContext,
  ): Promise<VisitNote[]> {
    await PermissionService.requirePermission(ctx.user.id, 'view_visits');
    await getVisitOrThrow(subjectId, visitId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('visit_notes')
      .select(VISIT_NOTE_COLUMNS)
      .eq('visit_id', visitId)
      .eq('company_id', ctx.company.id)
      .order('created_at', { ascending: false });

    if (error) throw new DatabaseError(error.message);
    return (data as VisitNote[]) ?? [];
  },

  // Shared by SubjectService.create/generateVisitSchedule (scheduled visits) and
  // createUnscheduledVisit — no dependency on anything else in this service.
  async createCalendarEventsForVisits(visits: Visit[], ctx: RequestContext): Promise<void> {
    if (visits.length === 0) return;

    const supabase = await createServerSupabaseClient();
    // calendar_events.start_datetime is NOT NULL — a placeholder visit with no
    // target_date yet (e.g. Screening/Baseline before the Baseline visit is
    // completed) genuinely has nothing to schedule on the calendar. Its event is
    // created once generateVisitSchedule anchors it to a real date.
    const rows = visits
      .filter((v) => v.target_date)
      .map((v) => ({
        company_id: ctx.company.id,
        site_id: v.site_id,
        event_type: 'patient_visit' as const,
        title: v.visit_name,
        description: null,
        start_datetime: `${v.target_date}T00:00:00Z`,
        end_datetime: `${v.target_date}T00:00:00Z`,
        related_record_type: 'visits',
        related_record_id: v.id,
        status: 'scheduled' as const,
        created_by: ctx.user.id,
      }));

    if (rows.length === 0) return;

    const { error } = await supabase.from('calendar_events').insert(rows);
    if (error) throw new DatabaseError(error.message);
  },

  // Exposed so SubjectService (Complete/generateVisitSchedule) and the
  // backfill route below can reuse the exact same self-healing upsert that
  // every VisitService action already uses — one implementation, no
  // duplicated "does the event exist" logic.
  upsertCalendarEventForVisit,

  // Idempotent, company-scoped backfill for visits whose calendar_events row
  // was never created (e.g. generated before calendar-event creation existed)
  // or was otherwise lost. Safe to run repeatedly — upsertCalendarEventForVisit
  // only inserts when no matching row exists, so re-running never duplicates.
  async backfillCalendarEvents(
    ctx: RequestContext,
  ): Promise<{ created: number; checked: number; failed: number }> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_visits');

    const supabase = await createServerSupabaseClient();
    const { data: visits, error } = await supabase
      .from('visits')
      .select(VISIT_COLUMNS)
      .eq('company_id', ctx.company.id)
      .not('target_date', 'is', null);

    if (error) throw new DatabaseError(error.message);

    const candidates = (visits as Visit[]) ?? [];
    if (candidates.length === 0) return { created: 0, checked: 0, failed: 0 };

    const { data: existingEvents, error: existingError } = await supabase
      .from('calendar_events')
      .select('related_record_id')
      .eq('company_id', ctx.company.id)
      .eq('related_record_type', 'visits')
      .in(
        'related_record_id',
        candidates.map((v) => v.id),
      );

    if (existingError) throw new DatabaseError(existingError.message);

    const existingIds = new Set(
      ((existingEvents as Array<{ related_record_id: string }>) ?? []).map(
        (e) => e.related_record_id,
      ),
    );
    const missing = candidates.filter((v) => !existingIds.has(v.id));

    // Each visit is upserted independently — one rejected write (e.g. an RLS
    // can_access_site failure for that visit's site) must not abort the whole
    // backfill, but it must be counted honestly rather than reported as a
    // success the caller can't distinguish from a real one.
    let created = 0;
    let failed = 0;
    for (const visit of missing) {
      try {
        await upsertCalendarEventForVisit(visit, ctx);
        created += 1;
      } catch (err) {
        failed += 1;
        logger.error('backfillCalendarEvents: failed to create calendar_events row', {
          visitId: visit.id,
          siteId: visit.site_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { created, checked: candidates.length, failed };
  },

  async listCalendarEvents(
    filters: ListCalendarEventsFilters,
    ctx: RequestContext,
  ): Promise<CalendarEvent[]> {
    await PermissionService.requirePermission(ctx.user.id, 'view_visits');

    const supabase = await createServerSupabaseClient();
    let query = supabase
      .from('calendar_events')
      .select(CALENDAR_EVENT_COLUMNS)
      .eq('company_id', ctx.company.id)
      .gte('start_datetime', `${filters.start}T00:00:00Z`)
      .lte('start_datetime', `${filters.end}T23:59:59Z`);

    if (filters.site_id) query = query.eq('site_id', filters.site_id);
    if (filters.status) query = query.eq('status', filters.status);

    // calendar_events.related_record_id is deliberately polymorphic (no FK to
    // visits), so Study/CRC filtering can't be an embedded join — resolve to a
    // set of matching visit ids first, same derivation SubjectService.list()
    // already uses for assigned_crc (study_staff, staff_role='crc', active=true).
    if (filters.study_id || filters.crc_user_id) {
      let visitQuery = supabase.from('visits').select('id').eq('company_id', ctx.company.id);

      if (filters.study_id) visitQuery = visitQuery.eq('study_id', filters.study_id);

      if (filters.crc_user_id) {
        const { data: staffRows, error: staffError } = await supabase
          .from('study_staff')
          .select('study_id')
          .eq('company_id', ctx.company.id)
          .eq('user_id', filters.crc_user_id)
          .eq('staff_role', 'crc')
          .eq('active', true);
        if (staffError) throw new DatabaseError(staffError.message);

        const studyIds = [
          ...new Set(
            ((staffRows as Array<{ study_id: string }> | null) ?? []).map((r) => r.study_id),
          ),
        ];
        if (studyIds.length === 0) return [];
        visitQuery = visitQuery.in('study_id', studyIds);
      }

      const { data: matchingVisits, error: visitError } = await visitQuery;
      if (visitError) throw new DatabaseError(visitError.message);

      const visitIds = ((matchingVisits as Array<{ id: string }> | null) ?? []).map((v) => v.id);
      if (visitIds.length === 0) return [];
      query = query.eq('related_record_type', 'visits').in('related_record_id', visitIds);
    }

    const { data, error } = await query.order('start_datetime', { ascending: true });
    if (error) throw new DatabaseError(error.message);

    const events = (data as CalendarEvent[]) ?? [];
    return this.enrichCalendarEvents(events, ctx);
  },

  // Batched (not per-event) Subject/Study enrichment for the Calendar's hover
  // tooltip and filter display — calendar_events has no FK to visits, so this
  // is the one place that resolves it, in two bounded queries regardless of
  // how many events are returned.
  async enrichCalendarEvents(
    events: CalendarEvent[],
    ctx: RequestContext,
  ): Promise<CalendarEvent[]> {
    const visitIds = [
      ...new Set(
        events
          .filter((e) => e.related_record_type === 'visits' && e.related_record_id)
          .map((e) => e.related_record_id as string),
      ),
    ];
    if (visitIds.length === 0) return events;

    const supabase = await createServerSupabaseClient();
    const { data: visits, error: visitsError } = await supabase
      .from('visits')
      .select('id, subject_id, study_id')
      .eq('company_id', ctx.company.id)
      .in('id', visitIds);
    if (visitsError) throw new DatabaseError(visitsError.message);

    const visitRows = (visits as Array<{ id: string; subject_id: string; study_id: string }>) ?? [];
    const visitById = new Map(visitRows.map((v) => [v.id, v]));

    const subjectIds = [...new Set(visitRows.map((v) => v.subject_id))];
    let subjectNumberById = new Map<string, string>();
    if (subjectIds.length > 0) {
      const { data: subjects, error: subjectsError } = await supabase
        .from('subjects')
        .select('id, subject_number')
        .eq('company_id', ctx.company.id)
        .in('id', subjectIds);
      if (subjectsError) throw new DatabaseError(subjectsError.message);

      subjectNumberById = new Map(
        ((subjects as Array<{ id: string; subject_number: string }>) ?? []).map((s) => [
          s.id,
          s.subject_number,
        ]),
      );
    }

    return events.map((event) => {
      const visit = event.related_record_id ? visitById.get(event.related_record_id) : undefined;
      if (!visit) return event;
      return {
        ...event,
        related_subject_id: visit.subject_id,
        related_subject_number: subjectNumberById.get(visit.subject_id),
        related_study_id: visit.study_id,
      };
    });
  },
};
