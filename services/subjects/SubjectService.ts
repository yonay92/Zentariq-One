import { createServerSupabaseClient } from '@/lib/supabase/server';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import { NotificationService } from '@/services/notifications/NotificationService';
import { VisitService } from '@/services/visits/VisitService';
import { FileService } from '@/services/files/FileService';
import { ChartService } from '@/services/charts/ChartService';
import { getVisitLockStatus, sortVisitsByOrder } from '@/lib/utils/visitSequencing';
import {
  NotFoundError,
  DatabaseError,
  BusinessRuleError,
  DuplicateRecordError,
} from '@/lib/api/errors';
import { logger } from '@/lib/logger';
import type {
  Subject,
  SubjectStatus,
  CreateSubjectInput,
  UpdateSubjectInput,
  CompleteBaselineVisitInput,
  CompleteVisitInput,
  RandomizeSubjectInput,
  SubjectStatusHistory,
  SubjectNote,
  SubjectNoteVisibility,
  SubjectDocument,
  SubjectTimelineEvent,
  Visit,
  VisitStatus,
} from '@/types/subjects';
import type { VisitTemplateItem } from '@/types/studies';
import type { RequestContext } from '@/types/api';

const SUBJECT_COLUMNS =
  'id, company_id, site_id, study_id, subject_number, initials, status, screening_date, baseline_date, randomization_date, randomization_number, end_of_study_date, created_by, created_at, updated_at';
const VISIT_COLUMNS =
  'id, company_id, site_id, study_id, subject_id, visit_template_item_id, visit_name, visit_type, target_date, scheduled_date, window_start, window_end, status, created_by, created_at, updated_at';
const TEMPLATE_ITEM_COLUMNS =
  'id, template_id, visit_name, visit_order, offset_days, window_before, window_after, visit_type, is_required, is_baseline, notes, created_at, updated_at';
const STATUS_HISTORY_COLUMNS =
  'id, company_id, subject_id, old_status, new_status, changed_by, changed_at, reason';
const NOTE_COLUMNS = 'id, company_id, subject_id, note, visibility, created_by, created_at';
const DOCUMENT_COLUMNS =
  'id, company_id, subject_id, file_id, document_type, uploaded_by, uploaded_at, notes';
const TIMELINE_COLUMNS =
  'id, company_id, subject_id, event_type, event_date, description, related_record_type, related_record_id, created_by, created_at';

export type SubjectListFilters = {
  study_id?: string | undefined;
  site_id?: string | undefined;
  status?: SubjectStatus | undefined;
  subject_number?: string | undefined;
  // Free-text search across subject_number and initials.
  search?: string | undefined;
  // A user_id — resolved via study_staff (staff_role = 'crc') rather than a
  // direct ownership column. Subjects are not assigned to a fixed CRC
  // (docs/DATABASE_Part_03_Subjects_Visits_Calendar.md); this filters to
  // subjects whose study currently has that user as an active CRC.
  assigned_crc?: string | undefined;
};

// BUSINESS_RULES_03: Pre-Screening -> Screening -> Randomized -> Active -> Completed,
// with Screen Failed / Early Terminated / Lost to Follow Up as alternate exits.
const FORWARD_FLOW: SubjectStatus[] = [
  'pre_screening',
  'screening',
  'randomized',
  'active',
  'completed',
];
const TERMINAL_STATUSES: SubjectStatus[] = [
  'screen_failed',
  'completed',
  'early_terminated',
  'lost_to_follow_up',
];

function isValidStatusTransition(from: SubjectStatus, to: SubjectStatus): boolean {
  if (from === to) return false;
  if (TERMINAL_STATUSES.includes(from)) return false;

  if (to === 'screen_failed') return from === 'pre_screening' || from === 'screening';
  if (to === 'early_terminated' || to === 'lost_to_follow_up') {
    return from === 'screening' || from === 'randomized' || from === 'active';
  }

  const fromIndex = FORWARD_FLOW.indexOf(from);
  const toIndex = FORWARD_FLOW.indexOf(to);
  return fromIndex !== -1 && toIndex === fromIndex + 1;
}

function addDaysToDateString(dateStr: string, days: number): string {
  const parts = dateStr.split('-').map(Number);
  const year = parts[0] ?? 0;
  const month = parts[1] ?? 1;
  const day = parts[2] ?? 1;
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Best-effort Document Center visibility — never blocks the primary Subject
// document upload. Same failure semantics as
// RegulatoryDocumentService.linkToDocumentCenter/StaffCredentialService.linkToDocumentCenter
// (see those functions' comments for the full rationale). Subjects uses a
// multi-attachment model (see 3.3A audit): every subject_documents row is
// its own independent logical document, so record_id is the individual
// subject_documents row's id — NOT subject_id — and each upload produces
// its own, separate file_links association. There is no replace/version
// concept here, so only linkForModule is ever used; relinkForModule does
// not apply.
async function linkToDocumentCenter(
  fileId: string,
  subjectDocument: SubjectDocument,
  subject: Subject,
  ctx: RequestContext,
): Promise<void> {
  try {
    await FileService.linkForModule(
      {
        file_id: fileId,
        module: 'subject_documents',
        record_id: subjectDocument.id,
        site_id: subject.site_id,
      },
      ctx,
    );
  } catch (err) {
    logger.error('SubjectService: linkForModule failed', {
      subject_document_id: subjectDocument.id,
      file_id: fileId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export const SubjectService = {
  async list(filters: SubjectListFilters, ctx: RequestContext): Promise<Subject[]> {
    await PermissionService.requirePermission(ctx.user.id, 'view_subjects');

    const supabase = await createServerSupabaseClient();
    let query = supabase.from('subjects').select(SUBJECT_COLUMNS).eq('company_id', ctx.company.id);

    if (filters.study_id) query = query.eq('study_id', filters.study_id);
    if (filters.site_id) query = query.eq('site_id', filters.site_id);
    if (filters.status) query = query.eq('status', filters.status);
    if (filters.subject_number)
      query = query.ilike('subject_number', `%${filters.subject_number}%`);
    if (filters.search) {
      const escaped = filters.search.replace(/[%,()]/g, '');
      query = query.or(`subject_number.ilike.%${escaped}%,initials.ilike.%${escaped}%`);
    }

    if (filters.assigned_crc) {
      const { data: staffRows } = await supabase
        .from('study_staff')
        .select('study_id')
        .eq('company_id', ctx.company.id)
        .eq('user_id', filters.assigned_crc)
        .eq('staff_role', 'crc')
        .eq('active', true);

      const studyIds = [
        ...new Set(
          ((staffRows as Array<{ study_id: string }> | null) ?? []).map((r) => r.study_id),
        ),
      ];
      if (studyIds.length === 0) return [];
      query = query.in('study_id', studyIds);
    }

    const { data } = await query.order('created_at', { ascending: false });
    return (data as Subject[]) ?? [];
  },

  async getById(subjectId: string, ctx: RequestContext): Promise<Subject> {
    await PermissionService.requirePermission(ctx.user.id, 'view_subjects');

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('subjects')
      .select(SUBJECT_COLUMNS)
      .eq('id', subjectId)
      .eq('company_id', ctx.company.id)
      .single();

    if (error || !data) throw new NotFoundError('Subject');
    return data as Subject;
  },

  async create(input: CreateSubjectInput, ctx: RequestContext): Promise<Subject> {
    await PermissionService.requirePermission(ctx.user.id, 'create_subject');
    await PermissionService.requireSiteAccess(ctx.user.id, input.site_id);

    const supabase = await createServerSupabaseClient();

    // Study/site-assignment/approved-template are three independent reads — none
    // depends on another's result, so they run concurrently instead of as three
    // sequential round trips. Validation below still evaluates them in the same
    // precedence as before (study, then site, then template), so the error a
    // caller sees for an invalid combination is unchanged.
    const [{ data: study }, { data: studySite }, { data: template }] = await Promise.all([
      supabase
        .from('studies')
        .select('id, status')
        .eq('id', input.study_id)
        .eq('company_id', ctx.company.id)
        .maybeSingle(),
      supabase
        .from('study_sites')
        .select('id')
        .eq('study_id', input.study_id)
        .eq('site_id', input.site_id)
        .eq('company_id', ctx.company.id)
        .maybeSingle(),
      // GAP-REQ-03: block creation until the study has an approved visit template.
      // Fetched once here and reused below for the item lookup — avoids re-querying
      // visit_templates with the identical filter a second time.
      supabase
        .from('visit_templates')
        .select('id')
        .eq('study_id', input.study_id)
        .eq('company_id', ctx.company.id)
        .eq('status', 'approved')
        .maybeSingle(),
    ]);

    if (!study) throw new NotFoundError('Study');
    if ((study as { status: string }).status !== 'active') {
      throw new BusinessRuleError('Subjects can only be created for an active study');
    }
    if (!studySite) {
      throw new BusinessRuleError('The selected site is not assigned to this study');
    }
    if (!template) {
      throw new BusinessRuleError(
        'This study does not have an approved visit template. Please approve a visit template before creating subjects.',
      );
    }

    const { data, error } = await supabase
      .from('subjects')
      .insert({
        company_id: ctx.company.id,
        site_id: input.site_id,
        study_id: input.study_id,
        subject_number: input.subject_number,
        initials: input.initials ?? null,
        status: 'pre_screening',
        screening_date: input.screening_date ?? null,
        created_by: ctx.user.id,
      })
      .select(SUBJECT_COLUMNS)
      .single();

    if (error || !data) {
      if ((error as { code?: string } | null)?.code === '23505') {
        throw new DuplicateRecordError('subject_number');
      }
      throw new DatabaseError(error?.message ?? 'Failed to create subject');
    }

    const subject = data as Subject;

    await this.addTimelineEvent(
      subject.id,
      ctx.company.id,
      'subject_created',
      new Date().toISOString(),
      `Subject ${subject.subject_number} created`,
      ctx.user.id,
    );

    // Baseline is no longer collected at creation — instead, a placeholder visit is
    // scheduled for the template's designated Baseline item now, and completing it
    // (SubjectService.completeBaselineVisit) records baseline_date and generates the
    // rest of the protocol schedule anchored to that date.
    const { data: items } = await supabase
      .from('visit_template_items')
      .select(TEMPLATE_ITEM_COLUMNS)
      .eq('template_id', (template as { id: string }).id)
      .order('visit_order');

    const allItems = (items as VisitTemplateItem[]) ?? [];
    const baselineItem = allItems.find((i) => i.is_baseline);

    if (!baselineItem) {
      throw new BusinessRuleError(
        "This study's approved visit template has no Baseline visit configured",
      );
    }

    // Everything up to and including Baseline is created now — items ordered before
    // Baseline (e.g. Screening) need to exist as real, completable rows so the
    // out-of-sequence lock has something to check Baseline against. Everything after
    // Baseline is still unanchored (no baseline_date yet) and is generated once
    // Baseline is completed (generateVisitSchedule).
    const initialItems = allItems.filter((i) => i.visit_order <= baselineItem.visit_order);

    const { error: visitError } = await supabase.from('visits').insert(
      initialItems.map((item) => ({
        company_id: ctx.company.id,
        site_id: subject.site_id,
        study_id: subject.study_id,
        subject_id: subject.id,
        visit_template_item_id: item.id,
        visit_name: item.visit_name,
        visit_type: item.visit_type,
        target_date: null,
        window_start: null,
        window_end: null,
        status: 'scheduled',
        created_by: ctx.user.id,
      })),
    );
    if (visitError) throw new DatabaseError(visitError.message);

    const { data: createdVisits } = await supabase
      .from('visits')
      .select(VISIT_COLUMNS)
      .eq('subject_id', subject.id)
      .eq('company_id', ctx.company.id);
    await VisitService.createCalendarEventsForVisits((createdVisits as Visit[]) ?? [], ctx);

    await this.addTimelineEvent(
      subject.id,
      ctx.company.id,
      'baseline_visit_scheduled',
      new Date().toISOString(),
      `${initialItems.length} visit(s) scheduled through Baseline — pending completion`,
      ctx.user.id,
    );

    await AuditService.log({
      company_id: ctx.company.id,
      site_id: subject.site_id,
      user_id: ctx.user.id,
      action: 'subject.created',
      module: 'subjects',
      record_type: 'subjects',
      record_id: subject.id,
      new_value: input as unknown as Record<string, unknown>,
    });

    return subject;
  },

  async update(
    subjectId: string,
    input: UpdateSubjectInput,
    ctx: RequestContext,
  ): Promise<Subject> {
    await PermissionService.requirePermission(ctx.user.id, 'edit_subject');

    const subject = await this.getById(subjectId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data: updated, error } = await supabase
      .from('subjects')
      .update(input)
      .eq('id', subjectId)
      .eq('company_id', ctx.company.id)
      .select(SUBJECT_COLUMNS)
      .single();

    if (error || !updated) throw new DatabaseError(error?.message ?? 'Failed to update subject');

    const result = updated as Subject;

    await AuditService.log({
      company_id: ctx.company.id,
      site_id: subject.site_id,
      user_id: ctx.user.id,
      action: 'subject.updated',
      module: 'subjects',
      record_type: 'subjects',
      record_id: subjectId,
      old_value: subject as unknown as Record<string, unknown>,
      new_value: input as Record<string, unknown>,
    });

    return result;
  },

  async generateVisitSchedule(subject: Subject, ctx: RequestContext): Promise<Visit[]> {
    if (!subject.baseline_date) return [];

    const supabase = await createServerSupabaseClient();

    const { data: template } = await supabase
      .from('visit_templates')
      .select('id')
      .eq('study_id', subject.study_id)
      .eq('company_id', ctx.company.id)
      .eq('status', 'approved')
      .maybeSingle();

    if (!template) return [];

    const { data: items } = await supabase
      .from('visit_template_items')
      .select(TEMPLATE_ITEM_COLUMNS)
      .eq('template_id', (template as { id: string }).id)
      .order('visit_order');

    const allItems = (items as VisitTemplateItem[]) ?? [];
    const baselineItem = allItems.find((i) => i.is_baseline);

    // Everything at or before Baseline's visit_order already exists as a visit row
    // (created at subject creation — see SubjectService.create) — only generate what's
    // ordered strictly after Baseline.
    const templateItems = baselineItem
      ? allItems.filter((item) => item.visit_order > baselineItem.visit_order)
      : allItems.filter((item) => !item.is_baseline);
    if (templateItems.length === 0) return [];

    // Reopening a completed Baseline visit and completing it again (with an edited
    // date) re-invokes this method — it must recalculate the still-pending downstream
    // visits it already generated instead of inserting duplicates, and must never
    // touch a downstream visit that has already occurred.
    const { data: existingVisits } = await supabase
      .from('visits')
      .select(VISIT_COLUMNS)
      .eq('subject_id', subject.id)
      .eq('company_id', ctx.company.id)
      .in(
        'visit_template_item_id',
        templateItems.map((item) => item.id),
      );

    const existingByItemId = new Map(
      ((existingVisits as Visit[]) ?? []).map((v) => [v.visit_template_item_id, v]),
    );
    const OCCURRED_STATUSES: VisitStatus[] = ['completed', 'cancelled', 'out_of_window', 'missed'];

    const rowsToInsert: Array<Record<string, unknown>> = [];
    const toRecalculate: Array<{
      id: string;
      target_date: string;
      window_start: string;
      window_end: string;
    }> = [];

    for (const item of templateItems) {
      const targetDate = addDaysToDateString(subject.baseline_date as string, item.offset_days);
      const windowStart = addDaysToDateString(targetDate, -item.window_before);
      const windowEnd = addDaysToDateString(targetDate, item.window_after);
      const existing = existingByItemId.get(item.id);

      if (!existing) {
        rowsToInsert.push({
          company_id: ctx.company.id,
          site_id: subject.site_id,
          study_id: subject.study_id,
          subject_id: subject.id,
          visit_template_item_id: item.id,
          visit_name: item.visit_name,
          visit_type: item.visit_type,
          target_date: targetDate,
          window_start: windowStart,
          window_end: windowEnd,
          status: 'scheduled',
          created_by: ctx.user.id,
        });
      } else if (!OCCURRED_STATUSES.includes(existing.status)) {
        toRecalculate.push({
          id: existing.id,
          target_date: targetDate,
          window_start: windowStart,
          window_end: windowEnd,
        });
      }
      // else: already completed/cancelled/out_of_window/missed — it occurred (or was
      // resolved) on its original date and is never moved by a later recalculation.
    }

    const touched: Visit[] = [];

    if (rowsToInsert.length > 0) {
      const { data: inserted, error } = await supabase
        .from('visits')
        .insert(rowsToInsert)
        .select(VISIT_COLUMNS);
      if (error) throw new DatabaseError(error.message);
      touched.push(...((inserted as Visit[]) ?? []));
      await VisitService.createCalendarEventsForVisits((inserted as Visit[]) ?? [], ctx);
    }

    for (const recalc of toRecalculate) {
      const { data: updated, error } = await supabase
        .from('visits')
        .update({
          target_date: recalc.target_date,
          window_start: recalc.window_start,
          window_end: recalc.window_end,
        })
        .eq('id', recalc.id)
        .eq('company_id', ctx.company.id)
        .select(VISIT_COLUMNS)
        .single();
      if (error) throw new DatabaseError(error.message);
      if (updated) touched.push(updated as Visit);

      if (updated) {
        await VisitService.upsertCalendarEventForVisit(updated as Visit, ctx, {
          target_date: recalc.target_date,
        });
      }
    }

    if (touched.length > 0) {
      const parts = [
        rowsToInsert.length > 0 ? `${rowsToInsert.length} visit(s) generated` : null,
        toRecalculate.length > 0 ? `${toRecalculate.length} visit(s) recalculated` : null,
      ].filter(Boolean);
      await this.addTimelineEvent(
        subject.id,
        ctx.company.id,
        'visits_generated',
        new Date().toISOString(),
        `${parts.join(', ')} from the approved visit template`,
        ctx.user.id,
      );
    }

    return touched;
  },

  // Fetches the subject's approved template items and all of its current visit rows —
  // the shared context the out-of-sequence lock check needs. Reused by
  // completeBaselineVisit and completeVisit.
  async getVisitScheduleContext(
    subject: Subject,
    ctx: RequestContext,
  ): Promise<{ templateItems: VisitTemplateItem[]; allVisits: Visit[] }> {
    const supabase = await createServerSupabaseClient();

    const { data: template } = await supabase
      .from('visit_templates')
      .select('id')
      .eq('study_id', subject.study_id)
      .eq('company_id', ctx.company.id)
      .eq('status', 'approved')
      .maybeSingle();

    if (!template) return { templateItems: [], allVisits: [] };

    const [{ data: items }, { data: visits }] = await Promise.all([
      supabase
        .from('visit_template_items')
        .select(TEMPLATE_ITEM_COLUMNS)
        .eq('template_id', (template as { id: string }).id)
        .order('visit_order'),
      supabase
        .from('visits')
        .select(VISIT_COLUMNS)
        .eq('subject_id', subject.id)
        .eq('company_id', ctx.company.id),
    ]);

    return {
      templateItems: (items as VisitTemplateItem[]) ?? [],
      allVisits: (visits as Visit[]) ?? [],
    };
  },

  async completeBaselineVisit(
    subjectId: string,
    input: CompleteBaselineVisitInput,
    ctx: RequestContext,
  ): Promise<Subject> {
    await PermissionService.requirePermission(ctx.user.id, 'edit_subject');

    const subject = await this.getById(subjectId, ctx);

    const { templateItems, allVisits } = await this.getVisitScheduleContext(subject, ctx);
    const baselineItem = templateItems.find((i) => i.is_baseline);

    if (!baselineItem) {
      throw new BusinessRuleError(
        'This study’s approved visit template has no Baseline visit configured',
      );
    }

    const item = baselineItem;

    const baselineVisit = allVisits.find((v) => v.visit_template_item_id === item.id);

    if (!baselineVisit) {
      throw new NotFoundError('Baseline visit');
    }

    // Sprint 4 visit state machine: Complete is only allowed from In Progress —
    // the Baseline visit must go through Confirm → Start like any other visit
    // before it can be completed here. This is the SOLE completion guard — it
    // deliberately does not also check subject.baseline_date, since that would
    // permanently block re-completion after a legitimate Reopen (Completed ->
    // In Progress) even though the visit's own status correctly allows it again.
    if (baselineVisit.status !== 'in_progress') {
      throw new BusinessRuleError(
        `Only an In Progress visit can be completed (current status: ${baselineVisit.status}). Confirm and start this visit first.`,
      );
    }

    const lockStatus = getVisitLockStatus(baselineVisit, allVisits, templateItems);
    if (lockStatus.locked) {
      throw new BusinessRuleError(lockStatus.reason);
    }

    const supabase = await createServerSupabaseClient();

    // Step 1 (sequential, reversible): record where/when the visit actually
    // happened. Status is deliberately NOT touched here — the visit remains
    // in_progress until Step 2 below, so a failure here is safe to retry and
    // never risks the "completed implies chart exists" invariant.
    const { error: visitFieldsError } = await supabase
      .from('visits')
      .update({
        scheduled_date: input.baseline_date,
        target_date: input.baseline_date,
        window_start: addDaysToDateString(input.baseline_date, -item.window_before),
        window_end: addDaysToDateString(input.baseline_date, item.window_after),
      })
      .eq('id', baselineVisit.id)
      .eq('company_id', ctx.company.id);

    if (visitFieldsError) throw new DatabaseError(visitFieldsError.message);

    // Step 2 (atomic — Decision 1): flips status -> completed and creates the
    // required Chart in a single Postgres transaction (migration 026's
    // complete_visit_with_chart RPC), guaranteeing no completed visit without
    // its Chart, including under retry or concurrent completion attempts.
    const { visit: completedBaselineVisit } = await ChartService.ensureChartForCompletedVisit(
      baselineVisit.id,
      subjectId,
      'completed',
      ctx,
    );

    await supabase.from('visit_history').insert({
      company_id: ctx.company.id,
      visit_id: baselineVisit.id,
      old_status: baselineVisit.status,
      new_status: 'completed',
      changed_by: ctx.user.id,
    });

    await VisitService.upsertCalendarEventForVisit(completedBaselineVisit, ctx, {
      status: 'completed',
      target_date: input.baseline_date,
    });

    const { data: updated, error } = await supabase
      .from('subjects')
      .update({ baseline_date: input.baseline_date })
      .eq('id', subjectId)
      .eq('company_id', ctx.company.id)
      .select(SUBJECT_COLUMNS)
      .single();

    if (error || !updated) {
      throw new DatabaseError(error?.message ?? 'Failed to record baseline date');
    }

    const result = updated as Subject;

    await this.addTimelineEvent(
      subjectId,
      ctx.company.id,
      'baseline_visit_completed',
      new Date().toISOString(),
      `${item.visit_name} visit completed on ${input.baseline_date}`,
      ctx.user.id,
    );

    await this.generateVisitSchedule(result, ctx);

    await AuditService.log({
      company_id: ctx.company.id,
      site_id: subject.site_id,
      user_id: ctx.user.id,
      action: 'subject.baseline_completed',
      module: 'subjects',
      record_type: 'subjects',
      record_id: subjectId,
      new_value: { baseline_date: input.baseline_date },
    });

    return result;
  },

  // Generic completion for any non-Baseline visit. Baseline keeps its own dedicated
  // action (completeBaselineVisit) because completing it has extra side effects —
  // recording subject.baseline_date and generating the rest of the schedule.
  async completeVisit(
    subjectId: string,
    visitId: string,
    input: CompleteVisitInput,
    ctx: RequestContext,
  ): Promise<Visit> {
    await PermissionService.requirePermission(ctx.user.id, 'edit_subject');

    const subject = await this.getById(subjectId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data: visitRow, error } = await supabase
      .from('visits')
      .select(VISIT_COLUMNS)
      .eq('id', visitId)
      .eq('subject_id', subjectId)
      .eq('company_id', ctx.company.id)
      .single();

    if (error || !visitRow) throw new NotFoundError('Visit');
    const visit = visitRow as Visit;

    if (visit.status === 'completed') {
      throw new BusinessRuleError('Visit has already been completed');
    }

    // Sprint 4 visit state machine: Complete is only allowed from In Progress —
    // this tightens the previously accepted scheduled/confirmed/in_progress/
    // rescheduled range down to a single required precondition.
    if (visit.status !== 'in_progress') {
      throw new BusinessRuleError(
        `Only an In Progress visit can be completed (current status: ${visit.status}). Confirm and start this visit first.`,
      );
    }

    const { templateItems, allVisits } = await this.getVisitScheduleContext(subject, ctx);
    const item = templateItems.find((i) => i.id === visit.visit_template_item_id);

    if (item?.is_baseline) {
      throw new BusinessRuleError('Use the Complete Baseline Visit action for the Baseline visit');
    }

    const lockStatus = getVisitLockStatus(visit, allVisits, templateItems);
    if (lockStatus.locked) {
      throw new BusinessRuleError(lockStatus.reason);
    }

    // BUSINESS_RULES_04_Visits.md "Out of Window": a completion date outside the
    // visit's window is marked out_of_window instead of completed — the visit
    // occurred, just late. Chart-priority escalation is deferred (Charts ship in
    // Sprint 5); the status transition, CRC notification, and audit trail are not.
    const isOutOfWindow =
      !!visit.window_start &&
      !!visit.window_end &&
      (input.scheduled_date < visit.window_start || input.scheduled_date > visit.window_end);
    const finalStatus: VisitStatus = isOutOfWindow ? 'out_of_window' : 'completed';

    // Step 1 (sequential, reversible): record the actual completion date.
    // Status is deliberately NOT touched here — the visit remains in_progress
    // until Step 2 below, so a failure here is safe to retry.
    const { error: dateFieldError } = await supabase
      .from('visits')
      .update({ scheduled_date: input.scheduled_date })
      .eq('id', visitId)
      .eq('company_id', ctx.company.id);

    if (dateFieldError) throw new DatabaseError(dateFieldError.message);

    // Step 2 (atomic — Decision 1): flips status -> finalStatus (completed OR
    // out_of_window — both are chart-eligible, per BUSINESS_RULES_05 listing
    // "Out of Window" as a Chart priority criterion) and creates the required
    // Chart in a single Postgres transaction, guaranteeing no completed visit
    // without its Chart, including under retry or concurrent completion.
    const { visit: updated } = await ChartService.ensureChartForCompletedVisit(
      visitId,
      subjectId,
      finalStatus,
      ctx,
    );

    await supabase.from('visit_history').insert({
      company_id: ctx.company.id,
      visit_id: visitId,
      old_status: visit.status,
      new_status: finalStatus,
      changed_by: ctx.user.id,
      reason: isOutOfWindow
        ? `Completed outside visit window (${visit.window_start} – ${visit.window_end})`
        : null,
    });

    // calendar_events.status has no out_of_window state — the visit still occurred,
    // so it renders as completed on the Calendar either way (matches classifyVisit).
    await VisitService.upsertCalendarEventForVisit(updated, ctx, { status: 'completed' });

    await this.addTimelineEvent(
      subjectId,
      ctx.company.id,
      'visit_completed',
      new Date().toISOString(),
      isOutOfWindow
        ? `${visit.visit_name} visit completed out of window on ${input.scheduled_date} (window: ${visit.window_start} – ${visit.window_end})`
        : `${visit.visit_name} visit completed on ${input.scheduled_date}`,
      ctx.user.id,
      'visits',
      visitId,
    );

    await AuditService.log({
      company_id: ctx.company.id,
      site_id: subject.site_id,
      user_id: ctx.user.id,
      action: isOutOfWindow ? 'visit.out_of_window' : 'visit.completed',
      module: 'subjects',
      record_type: 'visits',
      record_id: visitId,
      new_value: { status: finalStatus, scheduled_date: input.scheduled_date },
    });

    if (isOutOfWindow) {
      await NotificationService.dispatch({
        type: 'visit_out_of_window',
        companyId: ctx.company.id,
        siteId: subject.site_id,
        recipientRole: 'crc',
        relatedModule: 'subjects',
        relatedRecordId: visitId,
        relatedRecordType: 'visits',
        context: { subject_number: subject.subject_number },
      });
    }

    return updated;
  },

  async randomize(
    subjectId: string,
    input: RandomizeSubjectInput,
    ctx: RequestContext,
  ): Promise<Subject> {
    await PermissionService.requirePermission(ctx.user.id, 'edit_subject');

    const subject = await this.getById(subjectId, ctx);

    if (subject.randomization_date) {
      throw new BusinessRuleError('Subject has already been randomized');
    }

    if (!subject.baseline_date) {
      throw new BusinessRuleError(
        'Cannot randomize a subject until the Baseline visit has been completed',
      );
    }

    if (!isValidStatusTransition(subject.status, 'randomized')) {
      throw new BusinessRuleError(`Cannot randomize a subject with status "${subject.status}"`);
    }

    const supabase = await createServerSupabaseClient();
    const { data: updated, error } = await supabase
      .from('subjects')
      .update({
        randomization_number: input.randomization_number,
        randomization_date: input.randomization_date,
        status: 'randomized',
      })
      .eq('id', subjectId)
      .eq('company_id', ctx.company.id)
      .select(SUBJECT_COLUMNS)
      .single();

    if (error || !updated) {
      throw new DatabaseError(error?.message ?? 'Failed to randomize subject');
    }

    const result = updated as Subject;

    await supabase.from('subject_status_history').insert({
      company_id: ctx.company.id,
      subject_id: subjectId,
      old_status: subject.status,
      new_status: 'randomized',
      changed_by: ctx.user.id,
      reason: `Randomization #${input.randomization_number}`,
    });

    await this.addTimelineEvent(
      subjectId,
      ctx.company.id,
      'randomized',
      new Date().toISOString(),
      `Subject randomized (Randomization #${input.randomization_number})`,
      ctx.user.id,
    );

    await AuditService.log({
      company_id: ctx.company.id,
      site_id: subject.site_id,
      user_id: ctx.user.id,
      action: 'subject.randomized',
      module: 'subjects',
      record_type: 'subjects',
      record_id: subjectId,
      old_value: { status: subject.status },
      new_value: {
        status: 'randomized',
        randomization_number: input.randomization_number,
        randomization_date: input.randomization_date,
      },
    });

    for (const recipientRole of ['pi', 'crc']) {
      await NotificationService.dispatch({
        type: 'subject_status_changed',
        companyId: ctx.company.id,
        siteId: subject.site_id,
        recipientRole,
        relatedModule: 'subjects',
        relatedRecordId: subjectId,
        relatedRecordType: 'subjects',
        context: { subject_number: subject.subject_number, new_status: 'randomized' },
      });
    }

    return result;
  },

  async updateStatus(
    subjectId: string,
    status: SubjectStatus,
    ctx: RequestContext,
    reason?: string,
  ): Promise<Subject> {
    await PermissionService.requirePermission(ctx.user.id, 'edit_subject');

    const subject = await this.getById(subjectId, ctx);

    if (!isValidStatusTransition(subject.status, status)) {
      throw new BusinessRuleError(
        `Cannot change subject status from "${subject.status}" to "${status}"`,
      );
    }

    const supabase = await createServerSupabaseClient();
    const { data: updated, error } = await supabase
      .from('subjects')
      .update({ status })
      .eq('id', subjectId)
      .eq('company_id', ctx.company.id)
      .select(SUBJECT_COLUMNS)
      .single();

    if (error || !updated) {
      throw new DatabaseError(error?.message ?? 'Failed to update subject status');
    }

    // GAP-DUP-01: write structured history + narrative timeline + immutable audit log — all three.
    await supabase.from('subject_status_history').insert({
      company_id: ctx.company.id,
      subject_id: subjectId,
      old_status: subject.status,
      new_status: status,
      changed_by: ctx.user.id,
      reason: reason ?? null,
    });

    await this.addTimelineEvent(
      subjectId,
      ctx.company.id,
      'status_changed',
      new Date().toISOString(),
      `Status changed from ${subject.status} to ${status}${reason ? `: ${reason}` : ''}`,
      ctx.user.id,
    );

    await AuditService.log({
      company_id: ctx.company.id,
      site_id: subject.site_id,
      user_id: ctx.user.id,
      action: 'subject.status_changed',
      module: 'subjects',
      record_type: 'subjects',
      record_id: subjectId,
      old_value: { status: subject.status },
      new_value: { status, reason: reason ?? null },
    });

    for (const recipientRole of ['pi', 'crc']) {
      await NotificationService.dispatch({
        type: 'subject_status_changed',
        companyId: ctx.company.id,
        siteId: subject.site_id,
        recipientRole,
        relatedModule: 'subjects',
        relatedRecordId: subjectId,
        relatedRecordType: 'subjects',
        context: { subject_number: subject.subject_number, new_status: status },
      });
    }

    // Analytics recalculation (BUSINESS_RULES_03) deferred — Analytics ships in Sprint 11.

    if (status === 'completed') {
      await this.closeRemainingVisits(subjectId, ctx);
      // Closing remaining charts and completing open subject tasks (BUSINESS_RULES_03
      // "Subject Completion") is deferred — Charts and Task Engine ship in Sprint 5/8.
    }

    return updated as Subject;
  },

  async closeRemainingVisits(subjectId: string, ctx: RequestContext): Promise<void> {
    const supabase = await createServerSupabaseClient();
    await supabase
      .from('visits')
      .update({ status: 'cancelled' })
      .eq('subject_id', subjectId)
      .eq('company_id', ctx.company.id)
      .in('status', ['scheduled', 'confirmed']);
  },

  async addNote(
    subjectId: string,
    note: string,
    ctx: RequestContext,
    visibility: SubjectNoteVisibility = 'internal',
  ): Promise<SubjectNote> {
    await PermissionService.requirePermission(ctx.user.id, 'edit_subject');
    const subject = await this.getById(subjectId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('subject_notes')
      .insert({
        company_id: ctx.company.id,
        subject_id: subjectId,
        note,
        visibility,
        created_by: ctx.user.id,
      })
      .select(NOTE_COLUMNS)
      .single();

    if (error || !data) throw new DatabaseError(error?.message ?? 'Failed to add note');

    await AuditService.log({
      company_id: ctx.company.id,
      site_id: subject.site_id,
      user_id: ctx.user.id,
      action: 'subject.note_added',
      module: 'subjects',
      record_type: 'subject_notes',
      record_id: (data as SubjectNote).id,
      new_value: { subject_id: subjectId, visibility },
    });

    return data as SubjectNote;
  },

  async listNotes(subjectId: string, ctx: RequestContext): Promise<SubjectNote[]> {
    await PermissionService.requirePermission(ctx.user.id, 'view_subjects');
    await this.getById(subjectId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data } = await supabase
      .from('subject_notes')
      .select(NOTE_COLUMNS)
      .eq('subject_id', subjectId)
      .eq('company_id', ctx.company.id)
      .order('created_at', { ascending: false });

    return (data as SubjectNote[]) ?? [];
  },

  async uploadDocument(
    subjectId: string,
    file: File,
    ctx: RequestContext,
    documentType?: string,
  ): Promise<SubjectDocument> {
    await PermissionService.requirePermission(ctx.user.id, 'edit_subject');
    const subject = await this.getById(subjectId, ctx);

    const supabase = await createServerSupabaseClient();
    const storagePath = `${ctx.company.id}/${subjectId}/${Date.now()}_${file.name}`;

    const { error: uploadError } = await supabase.storage
      .from('subject-documents')
      .upload(storagePath, file, { contentType: file.type, upsert: false });

    if (uploadError) {
      throw new DatabaseError(`Document upload failed: ${uploadError.message}`);
    }

    const fileExtension = file.name.includes('.') ? file.name.split('.').pop() : null;

    const { data: fileRow, error: fileError } = await supabase
      .from('files')
      .insert({
        company_id: ctx.company.id,
        file_name: file.name,
        original_name: file.name,
        file_extension: fileExtension,
        mime_type: file.type || null,
        file_size: file.size,
        storage_path: storagePath,
        uploaded_by: ctx.user.id,
      })
      .select('id')
      .single();

    if (fileError || !fileRow) {
      throw new DatabaseError(fileError?.message ?? 'Failed to record uploaded file');
    }

    const fileId = (fileRow as { id: string }).id;

    const { data, error } = await supabase
      .from('subject_documents')
      .insert({
        company_id: ctx.company.id,
        subject_id: subjectId,
        file_id: fileId,
        document_type: documentType ?? null,
        uploaded_by: ctx.user.id,
      })
      .select(DOCUMENT_COLUMNS)
      .single();

    if (error || !data) throw new DatabaseError(error?.message ?? 'Failed to link document');

    const subjectDocument = data as SubjectDocument;

    await AuditService.log({
      company_id: ctx.company.id,
      site_id: subject.site_id,
      user_id: ctx.user.id,
      action: 'subject.document_uploaded',
      module: 'subjects',
      record_type: 'subject_documents',
      record_id: subjectDocument.id,
      new_value: { subject_id: subjectId, file_name: file.name },
    });

    await linkToDocumentCenter(fileId, subjectDocument, subject, ctx);

    return subjectDocument;
  },

  async listDocuments(subjectId: string, ctx: RequestContext): Promise<SubjectDocument[]> {
    await PermissionService.requirePermission(ctx.user.id, 'view_subjects');
    await this.getById(subjectId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data } = await supabase
      .from('subject_documents')
      .select(DOCUMENT_COLUMNS)
      .eq('subject_id', subjectId)
      .eq('company_id', ctx.company.id)
      .order('uploaded_at', { ascending: false });

    return (data as SubjectDocument[]) ?? [];
  },

  async listTimeline(subjectId: string, ctx: RequestContext): Promise<SubjectTimelineEvent[]> {
    await PermissionService.requirePermission(ctx.user.id, 'view_subjects');
    await this.getById(subjectId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data } = await supabase
      .from('subject_timeline')
      .select(TIMELINE_COLUMNS)
      .eq('subject_id', subjectId)
      .eq('company_id', ctx.company.id)
      .order('event_date', { ascending: false });

    return (data as SubjectTimelineEvent[]) ?? [];
  },

  async addTimelineEvent(
    subjectId: string,
    companyId: string,
    eventType: string,
    eventDate: string,
    description: string,
    userId: string,
    relatedRecordType?: string,
    relatedRecordId?: string,
  ): Promise<void> {
    const supabase = await createServerSupabaseClient();
    await supabase.from('subject_timeline').insert({
      company_id: companyId,
      subject_id: subjectId,
      event_type: eventType,
      event_date: eventDate,
      description,
      related_record_type: relatedRecordType ?? null,
      related_record_id: relatedRecordId ?? null,
      created_by: userId,
    });
  },

  async listStatusHistory(subjectId: string, ctx: RequestContext): Promise<SubjectStatusHistory[]> {
    await PermissionService.requirePermission(ctx.user.id, 'view_subjects');
    await this.getById(subjectId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data } = await supabase
      .from('subject_status_history')
      .select(STATUS_HISTORY_COLUMNS)
      .eq('subject_id', subjectId)
      .eq('company_id', ctx.company.id)
      .order('changed_at', { ascending: false });

    return (data as SubjectStatusHistory[]) ?? [];
  },

  async listVisits(subjectId: string, ctx: RequestContext): Promise<Visit[]> {
    await PermissionService.requireAnyPermission(ctx.user.id, ['view_subjects', 'view_visits']);

    // Fetch the subject row directly rather than via getById(), which would
    // redundantly re-check requirePermission('view_subjects') — already covered by
    // the requireAnyPermission call above (and getById()'s narrower check would
    // incorrectly reject a caller who only holds view_visits).
    const supabase = await createServerSupabaseClient();
    const { data: subjectRow, error: subjectError } = await supabase
      .from('subjects')
      .select(SUBJECT_COLUMNS)
      .eq('id', subjectId)
      .eq('company_id', ctx.company.id)
      .single();

    if (subjectError || !subjectRow) throw new NotFoundError('Subject');
    const subject = subjectRow as Subject;

    const { data } = await supabase
      .from('visits')
      .select(VISIT_COLUMNS)
      .eq('subject_id', subjectId)
      .eq('company_id', ctx.company.id);

    const visits = (data as Visit[]) ?? [];
    if (visits.length === 0) return visits;

    // Sort by the approved template's visit_order, not target_date — pre-Baseline
    // items (e.g. Screening) have no target_date and must not sort to the end.
    const { templateItems } = await this.getVisitScheduleContext(subject, ctx);
    return sortVisitsByOrder(visits, templateItems);
  },
};
