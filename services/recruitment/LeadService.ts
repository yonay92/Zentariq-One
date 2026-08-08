import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@/lib/supabase/admin';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import { SubjectService } from '@/services/subjects/SubjectService';
import { LeadDuplicateService } from '@/services/recruitment/LeadDuplicateService';
import { NotFoundError, DatabaseError, BusinessRuleError } from '@/lib/api/errors';
import { PIPELINE_COLUMN_ORDER, getPipelineColumnForStatus } from '@/lib/utils/leadPipelineColumns';
import type {
  Lead,
  LeadStatus,
  LeadPriority,
  CreateLeadInput,
  UpdateLeadInput,
  ListLeadsFilters,
  LeadListItem,
  LeadListResult,
  AssignLeadInput,
  ArchiveLeadInput,
  ChangeLeadStatusInput,
  LeadStatusHistoryEntry,
  LogLeadContactInput,
  LeadContactLogEntry,
  PrescreeningOutcome,
  LeadNote,
  CreateLeadNoteInput,
  UpdateLeadNoteInput,
  LeadCall,
  LogLeadCallInput,
  LeadTask,
  CreateLeadTaskInput,
  UpdateLeadTaskInput,
  BulkActionResult,
  BulkActionOutcome,
  BulkAssignInput,
  BulkUpdatePriorityInput,
  BulkArchiveInput,
  BulkCreateTaskInput,
  BulkChangeStatusInput,
  BulkChangeStatusPreview,
  FollowUpQueueScope,
  FollowUpQueueEntry,
  WorkloadSummary,
  WorkloadSummaryEntry,
  ConversionReadiness,
  ConversionReadinessItem,
  ConversionReadinessItemKey,
  PipelineCounts,
  PipelineColumnKey,
  ValidNextStatuses,
} from '@/types/recruitment';
import type { CreateSubjectInput } from '@/types/subjects';
import type { RequestContext } from '@/types/api';

type SupabaseClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

const LEAD_COLUMNS =
  'id, company_id, site_id, study_id, referral_source_id, initials, status, priority, assigned_user_id, contact_attempt_count, last_contacted_at, next_contact_at, waitlisted_at, consent_to_contact, do_not_contact, do_not_contact_reason, source_detail, notes_summary, converted_subject_id, converted_at, declined_reason, archived_at, archived_by, created_by, updated_by, created_at, updated_at';

const NOTE_COLUMNS =
  'id, company_id, lead_id, note_type, body, is_private, created_by, created_at, updated_at';

const CALL_COLUMNS =
  'id, company_id, lead_id, direction, outcome, started_at, ended_at, duration_seconds, phone_number, summary, follow_up_required, follow_up_at, created_by, created_at';

const TASK_COLUMNS =
  'id, company_id, site_id, study_id, lead_id, title, description, status, priority, assigned_user_id, due_at, completed_at, completed_by, created_by, created_at, updated_at';

const STATUS_HISTORY_COLUMNS =
  'id, company_id, lead_id, previous_status, new_status, reason, changed_by, changed_at';

// Statuses with no normal forward transition — reachable only via the
// "exceptional transition with a required reason" path in changeStatus, or
// (for 'converted' specifically) never reachable through changeStatus at
// all — only LeadService.convertToSubject may set it, so converted_subject_id
// and the eligibility/PHI preconditions it enforces can never be bypassed.
const TERMINAL_STATUSES: LeadStatus[] = [
  'converted',
  'declined',
  'lost',
  'not_interested',
  'not_qualified',
  'screen_failed',
  'withdrawn',
];

// Normal allowed forward transitions. Anything not listed here for the
// current status still requires a `reason` (enforced in changeStatus) —
// never a hard block — matching "authorized users may perform exceptional
// transitions only with a required reason and audit entry." 'converted' is
// deliberately never a value in this map; it is excluded as a target in
// changeStatus regardless of reason.
const STATUS_TRANSITIONS: Partial<Record<LeadStatus, LeadStatus[]>> = {
  new: ['contact_attempted', 'contacted', 'not_interested', 'lost'],
  contact_attempted: ['contacted', 'voicemail_left', 'not_interested', 'lost'],
  voicemail_left: ['contacted', 'contact_attempted', 'not_interested', 'lost'],
  contacted: ['interested', 'not_interested', 'prescreen_scheduled', 'lost'],
  interested: ['prescreen_scheduled', 'prescreening', 'not_interested', 'lost'],
  prescreen_scheduled: ['prescreen_in_progress', 'prescreening', 'not_interested', 'lost'],
  prescreen_in_progress: ['prescreen_complete', 'prescreening', 'not_interested', 'lost'],
  prescreening: ['qualified', 'not_qualified', 'prescreen_complete'],
  prescreen_complete: ['qualified', 'not_qualified'],
  qualified: ['screening_scheduled', 'waitlisted', 'not_qualified'],
  screening_scheduled: ['screened', 'not_qualified'],
  screened: ['screen_failed'],
  waitlisted: ['contacted', 'screening_scheduled'],
};

async function getLeadOrThrow(leadId: string, ctx: RequestContext): Promise<Lead> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from('leads')
    .select(LEAD_COLUMNS)
    .eq('id', leadId)
    .eq('company_id', ctx.company.id)
    .single();

  if (error || !data) throw new NotFoundError('Lead');
  return data as Lead;
}

function assertNotTerminal(lead: Lead): void {
  if (TERMINAL_STATUSES.includes(lead.status)) {
    throw new BusinessRuleError(
      `This lead is already ${lead.status.replace(/_/g, ' ')} and cannot be updated further.`,
    );
  }
}

// Fire-and-forget, same convention as the lead_contact_log insert below —
// a history-write failure must never fail the primary status-changing
// operation it's recording.
async function insertStatusHistory(
  supabase: SupabaseClient,
  params: {
    company_id: string;
    lead_id: string;
    previous_status: LeadStatus | null;
    new_status: LeadStatus;
    reason?: string | null | undefined;
    changed_by: string;
  },
): Promise<void> {
  await supabase.from('lead_status_history').insert({
    company_id: params.company_id,
    lead_id: params.lead_id,
    previous_status: params.previous_status,
    new_status: params.new_status,
    reason: params.reason ?? null,
    changed_by: params.changed_by,
  });
}

// Single company-wide query (bounded by open/in_progress task volume, not
// total lead count) that answers both "how many open tasks does lead X
// have" and "which leads have an overdue task" — reused by list() for the
// Lead Table's Open Tasks column and Has Overdue Tasks filter, so neither
// needs its own per-row round trip (avoids N+1).
async function getOpenTaskInfo(
  supabase: SupabaseClient,
  companyId: string,
): Promise<{ openCountByLead: Map<string, number>; overdueLeadIds: Set<string> }> {
  const { data, error } = await supabase
    .from('lead_tasks')
    .select('lead_id, due_at')
    .eq('company_id', companyId)
    .in('status', ['open', 'in_progress']);

  if (error) throw new DatabaseError(error.message);

  const openCountByLead = new Map<string, number>();
  const overdueLeadIds = new Set<string>();
  const now = Date.now();
  for (const row of (data as Array<{ lead_id: string; due_at: string | null }>) ?? []) {
    openCountByLead.set(row.lead_id, (openCountByLead.get(row.lead_id) ?? 0) + 1);
    if (row.due_at && new Date(row.due_at).getTime() < now) overdueLeadIds.add(row.lead_id);
  }
  return { openCountByLead, overdueLeadIds };
}

function summarizeOutcomes(outcomes: BulkActionOutcome[]): BulkActionResult {
  const succeeded_count = outcomes.filter((o) => o.succeeded).length;
  return { outcomes, succeeded_count, skipped_count: outcomes.length - succeeded_count };
}

export const LeadService = {
  async create(input: CreateLeadInput, ctx: RequestContext): Promise<Lead> {
    await PermissionService.requirePermission(ctx.user.id, 'create_lead');
    // Company-wide pool by design (product decision) — site_id is optional; a
    // caller is only required to prove access to a site they're actually
    // assigning the lead to, never to a site they're leaving unset.
    if (input.site_id) {
      await PermissionService.requireSiteAccess(ctx.user.id, input.site_id);
    }

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('leads')
      .insert({
        company_id: ctx.company.id,
        site_id: input.site_id ?? null,
        study_id: input.study_id ?? null,
        referral_source_id: input.referral_source_id ?? null,
        status: 'new',
        created_by: ctx.user.id,
        updated_by: ctx.user.id,
      })
      .select(LEAD_COLUMNS)
      .single();

    if (error || !data) throw new DatabaseError(error?.message ?? 'Failed to create lead');

    const lead = data as Lead;

    await AuditService.log({
      company_id: ctx.company.id,
      site_id: lead.site_id,
      user_id: ctx.user.id,
      action: 'lead.created',
      module: 'recruitment',
      record_type: 'leads',
      record_id: lead.id,
      new_value: { site_id: lead.site_id, study_id: lead.study_id },
    });

    return lead;
  },

  async getById(leadId: string, ctx: RequestContext): Promise<Lead> {
    await PermissionService.requirePermission(ctx.user.id, 'view_leads');
    return getLeadOrThrow(leadId, ctx);
  },

  // Gated by view_lead_phi, not view_leads — notes may contain PHI-adjacent
  // contact context, same reasoning as the log table's own RLS policy.
  async getContactLog(leadId: string, ctx: RequestContext): Promise<LeadContactLogEntry[]> {
    await PermissionService.requirePermission(ctx.user.id, 'view_lead_phi');
    await getLeadOrThrow(leadId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('lead_contact_log')
      .select(
        'id, company_id, lead_id, contact_method, old_status, new_status, notes, contacted_by, contacted_at',
      )
      .eq('lead_id', leadId)
      .eq('company_id', ctx.company.id)
      .order('contacted_at', { ascending: false });

    if (error) throw new DatabaseError(error.message);
    return (data as LeadContactLogEntry[]) ?? [];
  },

  // Server-side paginated/sorted/filtered — the Lead Table's work-queue
  // listing. Page size is always capped (see listLeadsSchema) so this can
  // never become an unbounded query regardless of caller input.
  async list(filters: ListLeadsFilters, ctx: RequestContext): Promise<LeadListResult> {
    await PermissionService.requirePermission(ctx.user.id, 'view_leads');

    const page = filters.page && filters.page > 0 ? filters.page : 1;
    const pageSize =
      filters.page_size && filters.page_size > 0 ? Math.min(filters.page_size, 100) : 25;
    const sortBy = filters.sort_by ?? 'created_at';
    const sortDir = filters.sort_dir ?? 'desc';

    const supabase = await createServerSupabaseClient();

    // has_duplicate_warning is PHI-adjacent (it reveals a phone/email is
    // shared with another lead) — only computed for callers who could
    // already see that via checkDuplicates. Non-PHI callers still get a
    // normal list() result; the column is just always false for them and
    // the filter (if requested) is silently a no-op rather than an error.
    const canViewPhi = await PermissionService.hasPermission(ctx.user.id, 'view_lead_phi');
    const duplicateWarningLeadIds = canViewPhi
      ? await LeadDuplicateService.getLeadsWithActiveDuplicateWarnings(ctx)
      : new Set<string>();

    const { openCountByLead, overdueLeadIds } = await getOpenTaskInfo(supabase, ctx.company.id);

    let query = supabase
      .from('leads')
      .select(LEAD_COLUMNS, { count: 'exact' })
      .eq('company_id', ctx.company.id);

    if (filters.status) query = query.eq('status', filters.status);
    if (filters.statuses && filters.statuses.length > 0)
      query = query.in('status', filters.statuses);
    if (filters.site_id) query = query.eq('site_id', filters.site_id);
    if (filters.study_id) query = query.eq('study_id', filters.study_id);
    if (filters.referral_source_id)
      query = query.eq('referral_source_id', filters.referral_source_id);
    if (filters.priority) query = query.eq('priority', filters.priority);
    if (filters.assigned_user_id) query = query.eq('assigned_user_id', filters.assigned_user_id);
    // Archived leads never appear in default queries (business rule) — a
    // caller must explicitly ask for them.
    if (!filters.include_archived) query = query.is('archived_at', null);
    // initials only — the one non-PHI identifying value on `leads` itself.
    if (filters.search?.trim()) query = query.ilike('initials', `%${filters.search.trim()}%`);
    if (filters.next_follow_up_from)
      query = query.gte('next_contact_at', filters.next_follow_up_from);
    if (filters.next_follow_up_to) query = query.lte('next_contact_at', filters.next_follow_up_to);
    if (filters.created_from) query = query.gte('created_at', filters.created_from);
    if (filters.created_to) query = query.lte('created_at', filters.created_to);
    if (filters.has_overdue_tasks) {
      const ids = Array.from(overdueLeadIds);
      query = query.in('id', ids.length > 0 ? ids : ['00000000-0000-0000-0000-000000000000']);
    }
    if (filters.has_duplicate_warning && canViewPhi) {
      const ids = Array.from(duplicateWarningLeadIds);
      query = query.in('id', ids.length > 0 ? ids : ['00000000-0000-0000-0000-000000000000']);
    }

    query = query
      .order(sortBy, { ascending: sortDir === 'asc' })
      .range((page - 1) * pageSize, page * pageSize - 1);

    const { data, error, count } = await query;
    if (error) throw new DatabaseError(error.message);
    const leads = (data as Lead[]) ?? [];

    const items: LeadListItem[] = leads.map((lead) => ({
      ...lead,
      open_task_count: openCountByLead.get(lead.id) ?? 0,
      has_overdue_task: overdueLeadIds.has(lead.id),
      has_duplicate_warning: duplicateWarningLeadIds.has(lead.id),
    }));

    return { data: items, total: count ?? items.length, page, page_size: pageSize };
  },

  async update(leadId: string, input: UpdateLeadInput, ctx: RequestContext): Promise<Lead> {
    await PermissionService.requirePermission(ctx.user.id, 'edit_lead');
    const lead = await getLeadOrThrow(leadId, ctx);
    assertNotTerminal(lead);

    if (input.site_id) {
      await PermissionService.requireSiteAccess(ctx.user.id, input.site_id);
    }

    const patch: Record<string, unknown> = { updated_by: ctx.user.id };
    if (input.site_id !== undefined) patch.site_id = input.site_id;
    if (input.study_id !== undefined) patch.study_id = input.study_id;
    if (input.referral_source_id !== undefined) patch.referral_source_id = input.referral_source_id;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.source_detail !== undefined) patch.source_detail = input.source_detail;
    if (input.notes_summary !== undefined) patch.notes_summary = input.notes_summary;
    if (input.consent_to_contact !== undefined) patch.consent_to_contact = input.consent_to_contact;
    if (input.do_not_contact !== undefined) patch.do_not_contact = input.do_not_contact;
    if (input.do_not_contact_reason !== undefined)
      patch.do_not_contact_reason = input.do_not_contact_reason;

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('leads')
      .update(patch)
      .eq('id', leadId)
      .eq('company_id', ctx.company.id)
      .select(LEAD_COLUMNS)
      .single();

    if (error || !data) throw new DatabaseError(error?.message ?? 'Failed to update lead');

    const updated = data as Lead;

    await AuditService.log({
      company_id: ctx.company.id,
      site_id: updated.site_id,
      user_id: ctx.user.id,
      action: 'lead.updated',
      module: 'recruitment',
      record_type: 'leads',
      record_id: leadId,
      old_value: { site_id: lead.site_id, study_id: lead.study_id },
      new_value: { site_id: updated.site_id, study_id: updated.study_id },
    });

    return updated;
  },

  // Assignment is an administrative action, not a pipeline-progression one —
  // deliberately not blocked by assertNotTerminal (ownership can still be
  // corrected on a closed-out lead for reporting purposes).
  async assign(leadId: string, input: AssignLeadInput, ctx: RequestContext): Promise<Lead> {
    await PermissionService.requirePermission(ctx.user.id, 'assign_lead');
    const lead = await getLeadOrThrow(leadId, ctx);

    if (input.assigned_user_id) {
      await PermissionService.validateUserExists(input.assigned_user_id, ctx.company.id);
      // No cross-site assignment without permission: the assignee must be
      // able to access the lead's site themselves (unassigned/pool leads
      // have no site to check). view_all_sites-holders pass automatically —
      // same rule canAccessSite already applies to the caller elsewhere.
      if (lead.site_id) {
        const assigneeHasSiteAccess = await PermissionService.canAccessSite(
          input.assigned_user_id,
          lead.site_id,
        );
        if (!assigneeHasSiteAccess) {
          throw new BusinessRuleError(
            'The selected user does not have access to this lead’s site.',
          );
        }
      }
    }

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('leads')
      .update({ assigned_user_id: input.assigned_user_id, updated_by: ctx.user.id })
      .eq('id', leadId)
      .eq('company_id', ctx.company.id)
      .select(LEAD_COLUMNS)
      .single();

    if (error || !data) throw new DatabaseError(error?.message ?? 'Failed to assign lead');

    const updated = data as Lead;

    await AuditService.log({
      company_id: ctx.company.id,
      site_id: updated.site_id,
      user_id: ctx.user.id,
      action: 'lead.assigned',
      module: 'recruitment',
      record_type: 'leads',
      record_id: leadId,
      old_value: { assigned_user_id: lead.assigned_user_id },
      new_value: { assigned_user_id: updated.assigned_user_id },
    });

    return updated;
  },

  // Soft-delete only — hard deletion is never exposed through the API.
  // Administrative, like assign: not blocked by assertNotTerminal.
  async archive(leadId: string, input: ArchiveLeadInput, ctx: RequestContext): Promise<Lead> {
    await PermissionService.requirePermission(ctx.user.id, 'archive_lead');
    const lead = await getLeadOrThrow(leadId, ctx);

    if (lead.archived_at) {
      throw new BusinessRuleError('This lead is already archived.');
    }

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('leads')
      .update({
        archived_at: new Date().toISOString(),
        archived_by: ctx.user.id,
        updated_by: ctx.user.id,
      })
      .eq('id', leadId)
      .eq('company_id', ctx.company.id)
      .select(LEAD_COLUMNS)
      .single();

    if (error || !data) throw new DatabaseError(error?.message ?? 'Failed to archive lead');

    await AuditService.log({
      company_id: ctx.company.id,
      site_id: lead.site_id,
      user_id: ctx.user.id,
      action: 'lead.archived',
      module: 'recruitment',
      record_type: 'leads',
      record_id: leadId,
      new_value: { reason: input.reason ?? null },
    });

    return data as Lead;
  },

  // General-purpose manual status change, gated by the explicit transition
  // map above. logContact/waitlist/decline/convertToSubject remain the
  // existing, more specific entry points for their own flows and are
  // unchanged; this is the new entry point for every other transition
  // (e.g. moving through the granular prescreen_scheduled -> screened chain).
  async changeStatus(
    leadId: string,
    input: ChangeLeadStatusInput,
    ctx: RequestContext,
  ): Promise<Lead> {
    await PermissionService.requirePermission(ctx.user.id, 'edit_lead');
    const lead = await getLeadOrThrow(leadId, ctx);

    if (input.new_status === lead.status) {
      throw new BusinessRuleError('The lead is already in that status.');
    }
    // 'converted' may only ever be set by LeadService.convertToSubject, which
    // enforces the eligibility/PHI/site/study preconditions it depends on —
    // never reachable through the generic status-change path, even with a
    // reason.
    if (input.new_status === 'converted') {
      throw new BusinessRuleError(
        'A lead can only be marked converted through the Convert to Subject action.',
      );
    }

    const allowedNext = STATUS_TRANSITIONS[lead.status] ?? [];
    const isNormalTransition = allowedNext.includes(input.new_status);
    if (!isNormalTransition && !input.reason?.trim()) {
      throw new BusinessRuleError(
        `Moving from ${lead.status.replace(/_/g, ' ')} to ${input.new_status.replace(/_/g, ' ')} is not a normal transition and requires a reason.`,
      );
    }

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('leads')
      .update({ status: input.new_status, updated_by: ctx.user.id })
      .eq('id', leadId)
      .eq('company_id', ctx.company.id)
      .select(LEAD_COLUMNS)
      .single();

    if (error || !data) throw new DatabaseError(error?.message ?? 'Failed to change lead status');

    await insertStatusHistory(supabase, {
      company_id: ctx.company.id,
      lead_id: leadId,
      previous_status: lead.status,
      new_status: input.new_status,
      reason: input.reason,
      changed_by: ctx.user.id,
    });

    await AuditService.log({
      company_id: ctx.company.id,
      site_id: lead.site_id,
      user_id: ctx.user.id,
      action: 'lead.status_changed',
      module: 'recruitment',
      record_type: 'leads',
      record_id: leadId,
      old_value: { status: lead.status },
      new_value: { status: input.new_status, exceptional: !isNormalTransition },
    });

    return data as Lead;
  },

  async getStatusHistory(leadId: string, ctx: RequestContext): Promise<LeadStatusHistoryEntry[]> {
    await PermissionService.requirePermission(ctx.user.id, 'view_leads');
    await getLeadOrThrow(leadId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('lead_status_history')
      .select(STATUS_HISTORY_COLUMNS)
      .eq('lead_id', leadId)
      .eq('company_id', ctx.company.id)
      .order('changed_at', { ascending: false });

    if (error) throw new DatabaseError(error.message);
    return (data as LeadStatusHistoryEntry[]) ?? [];
  },

  // Contacting a lead is gated by edit_lead_phi (not edit_lead) — same
  // reasoning as appointment_confirmation_log: the notes/method here are
  // PHI-adjacent contact context, not bare pipeline state. do_not_contact
  // blocks this action unless the caller holds override_do_not_contact and
  // supplies a reason (business rule 7).
  async logContact(leadId: string, input: LogLeadContactInput, ctx: RequestContext): Promise<Lead> {
    await PermissionService.requirePermission(ctx.user.id, 'edit_lead_phi');
    const lead = await getLeadOrThrow(leadId, ctx);
    assertNotTerminal(lead);
    await PermissionService.guardDangerousOperation(ctx.user.id, 'override_do_not_contact', {
      blocked: lead.do_not_contact,
      reason: input.override_reason,
      blockedMessage:
        'This lead is marked do-not-contact. Logging a contact attempt requires an authorized override with a reason.',
    });

    const supabase = await createServerSupabaseClient();
    const previousStatus = lead.status;

    const { data, error } = await supabase
      .from('leads')
      .update({
        status: input.new_status,
        contact_attempt_count: lead.contact_attempt_count + 1,
        last_contacted_at: new Date().toISOString(),
        next_contact_at: input.next_contact_at ?? null,
        updated_by: ctx.user.id,
      })
      .eq('id', leadId)
      .eq('company_id', ctx.company.id)
      .select(LEAD_COLUMNS)
      .single();

    if (error || !data) throw new DatabaseError(error?.message ?? 'Failed to log contact attempt');

    await supabase.from('lead_contact_log').insert({
      company_id: ctx.company.id,
      lead_id: leadId,
      contact_method: input.contact_method ?? null,
      old_status: previousStatus,
      new_status: input.new_status,
      notes: input.notes ?? null,
      contacted_by: ctx.user.id,
    });

    await insertStatusHistory(supabase, {
      company_id: ctx.company.id,
      lead_id: leadId,
      previous_status: previousStatus,
      new_status: input.new_status,
      reason: lead.do_not_contact ? input.override_reason : null,
      changed_by: ctx.user.id,
    });

    // Status/method only — never notes, which may contain PHI-adjacent
    // context. Same rule as AppointmentConfirmationService.logContact.
    await AuditService.log({
      company_id: ctx.company.id,
      site_id: (data as Lead).site_id,
      user_id: ctx.user.id,
      action: 'lead.contact_logged',
      module: 'recruitment',
      record_type: 'leads',
      record_id: leadId,
      old_value: { status: previousStatus },
      new_value: { status: input.new_status, contact_method: input.contact_method ?? null },
    });

    return data as Lead;
  },

  async waitlist(leadId: string, ctx: RequestContext): Promise<Lead> {
    await PermissionService.requirePermission(ctx.user.id, 'edit_lead');
    const lead = await getLeadOrThrow(leadId, ctx);
    assertNotTerminal(lead);

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('leads')
      .update({
        status: 'waitlisted',
        waitlisted_at: new Date().toISOString(),
        updated_by: ctx.user.id,
      })
      .eq('id', leadId)
      .eq('company_id', ctx.company.id)
      .select(LEAD_COLUMNS)
      .single();

    if (error || !data) throw new DatabaseError(error?.message ?? 'Failed to waitlist lead');

    await insertStatusHistory(supabase, {
      company_id: ctx.company.id,
      lead_id: leadId,
      previous_status: lead.status,
      new_status: 'waitlisted',
      changed_by: ctx.user.id,
    });

    await AuditService.log({
      company_id: ctx.company.id,
      site_id: (data as Lead).site_id,
      user_id: ctx.user.id,
      action: 'lead.waitlisted',
      module: 'recruitment',
      record_type: 'leads',
      record_id: leadId,
      old_value: { status: lead.status },
      new_value: { status: 'waitlisted' },
    });

    return data as Lead;
  },

  async decline(leadId: string, reason: string, ctx: RequestContext): Promise<Lead> {
    await PermissionService.requirePermission(ctx.user.id, 'edit_lead');
    const lead = await getLeadOrThrow(leadId, ctx);
    assertNotTerminal(lead);

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('leads')
      .update({ status: 'declined', declined_reason: reason, updated_by: ctx.user.id })
      .eq('id', leadId)
      .eq('company_id', ctx.company.id)
      .select(LEAD_COLUMNS)
      .single();

    if (error || !data) throw new DatabaseError(error?.message ?? 'Failed to decline lead');

    await insertStatusHistory(supabase, {
      company_id: ctx.company.id,
      lead_id: leadId,
      previous_status: lead.status,
      new_status: 'declined',
      reason,
      changed_by: ctx.user.id,
    });

    await AuditService.log({
      company_id: ctx.company.id,
      site_id: (data as Lead).site_id,
      user_id: ctx.user.id,
      action: 'lead.declined',
      module: 'recruitment',
      record_type: 'leads',
      record_id: leadId,
      old_value: { status: lead.status },
      new_value: { status: 'declined', declined_reason: reason },
    });

    return data as Lead;
  },

  // Notes are freeform and author-owned — view_lead_notes/create_lead_note
  // are distinct, materially different permissions from view_lead_phi/
  // edit_lead_phi (a note is not structured contact info). RLS additionally
  // hides is_private=true notes from everyone except their author.
  async listNotes(leadId: string, ctx: RequestContext): Promise<LeadNote[]> {
    await PermissionService.requireAnyPermission(ctx.user.id, [
      'view_lead_notes',
      'create_lead_note',
    ]);
    await getLeadOrThrow(leadId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('lead_notes')
      .select(NOTE_COLUMNS)
      .eq('lead_id', leadId)
      .eq('company_id', ctx.company.id)
      .order('created_at', { ascending: false });

    if (error) throw new DatabaseError(error.message);
    return (data as LeadNote[]) ?? [];
  },

  async addNote(
    leadId: string,
    input: CreateLeadNoteInput,
    ctx: RequestContext,
  ): Promise<LeadNote> {
    await PermissionService.requirePermission(ctx.user.id, 'create_lead_note');
    await getLeadOrThrow(leadId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('lead_notes')
      .insert({
        company_id: ctx.company.id,
        lead_id: leadId,
        note_type: input.note_type ?? 'general',
        body: input.body,
        is_private: input.is_private ?? false,
        created_by: ctx.user.id,
      })
      .select(NOTE_COLUMNS)
      .single();

    if (error || !data) throw new DatabaseError(error?.message ?? 'Failed to add note');

    // Metadata only — the note body is free text that may contain
    // PHI-adjacent content and is never written to the audit trail.
    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'lead_note.created',
      module: 'recruitment',
      record_type: 'lead_notes',
      record_id: (data as LeadNote).id,
      new_value: {
        note_type: (data as LeadNote).note_type,
        is_private: (data as LeadNote).is_private,
      },
    });

    return data as LeadNote;
  },

  // Only the author may edit their own note — no separate "edit any note"
  // permission was requested, so this is enforced as an ownership check
  // rather than a broader grant.
  async updateNote(
    leadId: string,
    noteId: string,
    input: UpdateLeadNoteInput,
    ctx: RequestContext,
  ): Promise<LeadNote> {
    await PermissionService.requirePermission(ctx.user.id, 'create_lead_note');

    const supabase = await createServerSupabaseClient();
    const { data: existing, error: fetchError } = await supabase
      .from('lead_notes')
      .select('id, created_by')
      .eq('id', noteId)
      .eq('lead_id', leadId)
      .eq('company_id', ctx.company.id)
      .maybeSingle();

    if (fetchError || !existing) throw new NotFoundError('Note');
    if ((existing as { created_by: string | null }).created_by !== ctx.user.id) {
      throw new BusinessRuleError('You can only edit your own notes.');
    }

    const patch: Record<string, unknown> = {};
    if (input.note_type !== undefined) patch.note_type = input.note_type;
    if (input.body !== undefined) patch.body = input.body;
    if (input.is_private !== undefined) patch.is_private = input.is_private;

    const { data, error } = await supabase
      .from('lead_notes')
      .update(patch)
      .eq('id', noteId)
      .eq('company_id', ctx.company.id)
      .select(NOTE_COLUMNS)
      .single();

    if (error || !data) throw new DatabaseError(error?.message ?? 'Failed to update note');

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'lead_note.updated',
      module: 'recruitment',
      record_type: 'lead_notes',
      record_id: noteId,
      new_value: { updated_fields: Object.keys(patch) },
    });

    return data as LeadNote;
  },

  async listCalls(leadId: string, ctx: RequestContext): Promise<LeadCall[]> {
    await PermissionService.requirePermission(ctx.user.id, 'log_lead_call');
    await getLeadOrThrow(leadId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('lead_calls')
      .select(CALL_COLUMNS)
      .eq('lead_id', leadId)
      .eq('company_id', ctx.company.id)
      .order('started_at', { ascending: false });

    if (error) throw new DatabaseError(error.message);
    return (data as LeadCall[]) ?? [];
  },

  // do_not_contact blocks logging a call the same way it blocks logContact
  // (business rule 7) — a call is a contact activity.
  async logCall(leadId: string, input: LogLeadCallInput, ctx: RequestContext): Promise<LeadCall> {
    await PermissionService.requirePermission(ctx.user.id, 'log_lead_call');
    const lead = await getLeadOrThrow(leadId, ctx);
    await PermissionService.guardDangerousOperation(ctx.user.id, 'override_do_not_contact', {
      blocked: lead.do_not_contact,
      reason: input.override_reason,
      blockedMessage:
        'This lead is marked do-not-contact. Logging a call requires an authorized override with a reason.',
    });

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('lead_calls')
      .insert({
        company_id: ctx.company.id,
        lead_id: leadId,
        direction: input.direction,
        outcome: input.outcome,
        started_at: input.started_at,
        ended_at: input.ended_at ?? null,
        duration_seconds: input.duration_seconds ?? null,
        phone_number: input.phone_number ?? null,
        summary: input.summary ?? null,
        follow_up_required: input.follow_up_required ?? false,
        follow_up_at: input.follow_up_at ?? null,
        created_by: ctx.user.id,
      })
      .select(CALL_COLUMNS)
      .single();

    if (error || !data) throw new DatabaseError(error?.message ?? 'Failed to log call');

    // phone_number/summary are PHI-adjacent and never written to the audit
    // trail — same rule as lead_contact_log's notes field.
    await AuditService.log({
      company_id: ctx.company.id,
      site_id: lead.site_id,
      user_id: ctx.user.id,
      action: 'lead_call.logged',
      module: 'recruitment',
      record_type: 'lead_calls',
      record_id: (data as LeadCall).id,
      new_value: {
        direction: input.direction,
        outcome: input.outcome,
        follow_up_required: input.follow_up_required ?? false,
        do_not_contact_override: lead.do_not_contact,
      },
    });

    return data as LeadCall;
  },

  async listTasks(leadId: string, ctx: RequestContext): Promise<LeadTask[]> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_lead_tasks');
    await getLeadOrThrow(leadId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('lead_tasks')
      .select(TASK_COLUMNS)
      .eq('lead_id', leadId)
      .eq('company_id', ctx.company.id)
      .order('due_at', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false });

    if (error) throw new DatabaseError(error.message);
    return (data as LeadTask[]) ?? [];
  },

  // No dedicated "call task" type exists on lead_tasks, so the do_not_contact
  // guard applies to every task on a DNC lead (business rule 7's "call tasks"
  // clause), not just ones that happen to mention calling.
  async createTask(
    leadId: string,
    input: CreateLeadTaskInput,
    ctx: RequestContext,
  ): Promise<LeadTask> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_lead_tasks');
    const lead = await getLeadOrThrow(leadId, ctx);
    await PermissionService.guardDangerousOperation(ctx.user.id, 'override_do_not_contact', {
      blocked: lead.do_not_contact,
      reason: input.override_reason,
      blockedMessage:
        'This lead is marked do-not-contact. Creating a follow-up task requires an authorized override with a reason.',
    });

    if (input.assigned_user_id) {
      await PermissionService.validateUserExists(input.assigned_user_id, ctx.company.id);
    }

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('lead_tasks')
      .insert({
        company_id: ctx.company.id,
        site_id: lead.site_id,
        study_id: lead.study_id,
        lead_id: leadId,
        title: input.title,
        description: input.description ?? null,
        priority: input.priority ?? 'medium',
        assigned_user_id: input.assigned_user_id ?? null,
        due_at: input.due_at ?? null,
        created_by: ctx.user.id,
      })
      .select(TASK_COLUMNS)
      .single();

    if (error || !data) throw new DatabaseError(error?.message ?? 'Failed to create task');

    // title/description are free text and never written to the audit trail.
    await AuditService.log({
      company_id: ctx.company.id,
      site_id: lead.site_id,
      user_id: ctx.user.id,
      action: 'lead_task.created',
      module: 'recruitment',
      record_type: 'lead_tasks',
      record_id: (data as LeadTask).id,
      new_value: {
        priority: (data as LeadTask).priority,
        assigned_user_id: input.assigned_user_id ?? null,
      },
    });

    return data as LeadTask;
  },

  async updateTask(
    leadId: string,
    taskId: string,
    input: UpdateLeadTaskInput,
    ctx: RequestContext,
  ): Promise<LeadTask> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_lead_tasks');

    const supabase = await createServerSupabaseClient();
    const { data: existing, error: fetchError } = await supabase
      .from('lead_tasks')
      .select('id')
      .eq('id', taskId)
      .eq('lead_id', leadId)
      .eq('company_id', ctx.company.id)
      .maybeSingle();

    if (fetchError || !existing) throw new NotFoundError('Task');

    if (input.assigned_user_id) {
      await PermissionService.validateUserExists(input.assigned_user_id, ctx.company.id);
    }

    const patch: Record<string, unknown> = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description;
    if (input.status !== undefined) patch.status = input.status;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.assigned_user_id !== undefined) patch.assigned_user_id = input.assigned_user_id;
    if (input.due_at !== undefined) patch.due_at = input.due_at;

    const { data, error } = await supabase
      .from('lead_tasks')
      .update(patch)
      .eq('id', taskId)
      .eq('company_id', ctx.company.id)
      .select(TASK_COLUMNS)
      .single();

    if (error || !data) throw new DatabaseError(error?.message ?? 'Failed to update task');

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'lead_task.updated',
      module: 'recruitment',
      record_type: 'lead_tasks',
      record_id: taskId,
      new_value: { updated_fields: Object.keys(patch) },
    });

    return data as LeadTask;
  },

  async completeTask(leadId: string, taskId: string, ctx: RequestContext): Promise<LeadTask> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_lead_tasks');

    const supabase = await createServerSupabaseClient();
    const { data: existing, error: fetchError } = await supabase
      .from('lead_tasks')
      .select('id, status')
      .eq('id', taskId)
      .eq('lead_id', leadId)
      .eq('company_id', ctx.company.id)
      .maybeSingle();

    if (fetchError || !existing) throw new NotFoundError('Task');
    if ((existing as { status: string }).status === 'completed') {
      throw new BusinessRuleError('This task is already completed.');
    }

    const { data, error } = await supabase
      .from('lead_tasks')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        completed_by: ctx.user.id,
      })
      .eq('id', taskId)
      .eq('company_id', ctx.company.id)
      .select(TASK_COLUMNS)
      .single();

    if (error || !data) throw new DatabaseError(error?.message ?? 'Failed to complete task');

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'lead_task.completed',
      module: 'recruitment',
      record_type: 'lead_tasks',
      record_id: taskId,
    });

    return data as LeadTask;
  },

  // Converts a Lead into a real, enrolled Subject. Reuses SubjectService.create
  // directly (never duplicates its active-study/approved-template/site-assigned
  // business rules), then copies the lead's PHI into a new subject_contact_info
  // row using the admin client — deliberately bypassing the normal
  // edit_subject_phi RLS check for this one write. convert_lead is the
  // authorizing permission for the conversion as a single atomic action; a
  // caller who can legitimately convert leads (and already proved edit_lead_phi
  // to see the source contact info) shouldn't also need a separate,
  // unrelated-looking edit_subject_phi grant just for this internal copy step.
  async convertToSubject(
    leadId: string,
    input: { subject_number: string; screening_date?: string | undefined },
    ctx: RequestContext,
  ): Promise<{ lead: Lead; subject_id: string }> {
    await PermissionService.requirePermission(ctx.user.id, 'convert_lead');
    const lead = await getLeadOrThrow(leadId, ctx);
    assertNotTerminal(lead);

    if (!lead.site_id) {
      throw new BusinessRuleError(
        'This lead must be assigned to a site before it can be converted.',
      );
    }
    if (!lead.study_id) {
      throw new BusinessRuleError(
        'This lead must be matched to a study before it can be converted.',
      );
    }

    const supabase = await createServerSupabaseClient();

    const { data: latestPrescreening } = await supabase
      .from('lead_prescreenings')
      .select('computed_outcome, manual_outcome')
      .eq('lead_id', leadId)
      .eq('study_id', lead.study_id)
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const effectiveOutcome: PrescreeningOutcome | null = latestPrescreening
      ? ((
          latestPrescreening as {
            manual_outcome: PrescreeningOutcome | null;
            computed_outcome: PrescreeningOutcome;
          }
        ).manual_outcome ??
        (latestPrescreening as { computed_outcome: PrescreeningOutcome }).computed_outcome)
      : null;

    if (!effectiveOutcome || effectiveOutcome === 'not_eligible') {
      throw new BusinessRuleError(
        'This lead needs a prescreening for the matched study with an outcome other than Not Eligible before it can be converted.',
      );
    }

    const { data: contactInfo } = await supabase
      .from('lead_contact_info')
      .select(
        'first_name, last_name, date_of_birth, sex, phone_primary, phone_secondary, email, preferred_contact_method',
      )
      .eq('lead_id', leadId)
      .maybeSingle();

    if (!contactInfo) {
      throw new BusinessRuleError('This lead has no contact information on file yet.');
    }
    const info = contactInfo as {
      first_name: string;
      last_name: string;
      date_of_birth: string | null;
      sex: string | null;
      phone_primary: string;
      phone_secondary: string | null;
      email: string | null;
      preferred_contact_method: string;
    };
    // date_of_birth and sex are optional on lead_contact_info ("DOB if
    // available" — product decision — and sex was never required at the
    // recruitment stage) but both are NOT NULL on subject_contact_info — a
    // Subject needs them for clinical purposes. Catch that mismatch here with
    // a clear message rather than letting the copy step fail on a DB
    // constraint partway through (the Subject would already be created).
    const missingFields = [!info.date_of_birth && 'date of birth', !info.sex && 'sex'].filter(
      (f): f is string => Boolean(f),
    );
    if (missingFields.length > 0) {
      throw new BusinessRuleError(
        `This lead needs ${missingFields.join(' and ')} on file before it can be converted to a Subject.`,
      );
    }

    const subjectInput: CreateSubjectInput = {
      site_id: lead.site_id,
      study_id: lead.study_id,
      subject_number: input.subject_number,
      ...(lead.initials ? { initials: lead.initials } : {}),
      ...(input.screening_date ? { screening_date: input.screening_date } : {}),
    };
    const subject = await SubjectService.create(subjectInput, ctx);

    const adminSupabase = createAdminSupabaseClient();
    const { error: contactError } = await adminSupabase.from('subject_contact_info').insert({
      company_id: ctx.company.id,
      site_id: lead.site_id,
      subject_id: subject.id,
      first_name: info.first_name,
      last_name: info.last_name,
      date_of_birth: info.date_of_birth,
      sex: info.sex,
      phone_primary: info.phone_primary,
      phone_secondary: info.phone_secondary,
      email: info.email,
      preferred_language: 'English',
      preferred_contact_method: info.preferred_contact_method,
      voicemail_permission: false,
      created_by: ctx.user.id,
      updated_by: ctx.user.id,
    });
    if (contactError) {
      throw new DatabaseError(
        `Subject created, but copying contact info failed: ${contactError.message}`,
      );
    }

    const { data: updatedLead, error: leadError } = await supabase
      .from('leads')
      .update({
        status: 'converted',
        converted_subject_id: subject.id,
        converted_at: new Date().toISOString(),
        updated_by: ctx.user.id,
      })
      .eq('id', leadId)
      .eq('company_id', ctx.company.id)
      .select(LEAD_COLUMNS)
      .single();

    if (leadError || !updatedLead) {
      throw new DatabaseError(
        leadError?.message ?? 'Subject created, but updating the lead failed',
      );
    }

    await insertStatusHistory(supabase, {
      company_id: ctx.company.id,
      lead_id: leadId,
      previous_status: lead.status,
      new_status: 'converted',
      changed_by: ctx.user.id,
    });

    await AuditService.log({
      company_id: ctx.company.id,
      site_id: lead.site_id,
      user_id: ctx.user.id,
      action: 'lead.converted',
      module: 'recruitment',
      record_type: 'leads',
      record_id: leadId,
      new_value: { converted_subject_id: subject.id },
    });

    return { lead: updatedLead as Lead, subject_id: subject.id };
  },

  async getValidNextStatuses(leadId: string, ctx: RequestContext): Promise<ValidNextStatuses> {
    await PermissionService.requirePermission(ctx.user.id, 'view_leads');
    const lead = await getLeadOrThrow(leadId, ctx);
    return {
      current_status: lead.status,
      normal_next_statuses: STATUS_TRANSITIONS[lead.status] ?? [],
      reason_required_for_others: true,
    };
  },

  // ── Bulk actions ──────────────────────────────────────────────────────
  // Every bulk method delegates to the existing single-lead method for each
  // id — never reimplements a business rule. This also gives free
  // defense-in-depth: bulk_manage_recruitment_leads is checked once here,
  // and the delegated method still re-checks its own specific permission
  // (edit_lead/assign_lead/archive_lead/manage_lead_tasks) per lead.

  async bulkAssign(input: BulkAssignInput, ctx: RequestContext): Promise<BulkActionResult> {
    await PermissionService.requirePermission(ctx.user.id, 'bulk_manage_recruitment_leads');

    const outcomes: BulkActionOutcome[] = [];
    for (const leadId of input.lead_ids) {
      try {
        await LeadService.assign(leadId, { assigned_user_id: input.assigned_user_id }, ctx);
        outcomes.push({ lead_id: leadId, succeeded: true, reason: null });
      } catch (err) {
        outcomes.push({
          lead_id: leadId,
          succeeded: false,
          reason: err instanceof Error ? err.message : 'Failed to assign lead',
        });
      }
    }
    return summarizeOutcomes(outcomes);
  },

  async bulkUpdatePriority(
    input: BulkUpdatePriorityInput,
    ctx: RequestContext,
  ): Promise<BulkActionResult> {
    await PermissionService.requirePermission(ctx.user.id, 'bulk_manage_recruitment_leads');

    const outcomes: BulkActionOutcome[] = [];
    for (const leadId of input.lead_ids) {
      try {
        await LeadService.update(leadId, { priority: input.priority }, ctx);
        outcomes.push({ lead_id: leadId, succeeded: true, reason: null });
      } catch (err) {
        outcomes.push({
          lead_id: leadId,
          succeeded: false,
          reason: err instanceof Error ? err.message : 'Failed to update priority',
        });
      }
    }
    return summarizeOutcomes(outcomes);
  },

  async bulkArchive(input: BulkArchiveInput, ctx: RequestContext): Promise<BulkActionResult> {
    await PermissionService.requirePermission(ctx.user.id, 'bulk_manage_recruitment_leads');

    const outcomes: BulkActionOutcome[] = [];
    for (const leadId of input.lead_ids) {
      try {
        await LeadService.archive(leadId, { reason: input.reason }, ctx);
        outcomes.push({ lead_id: leadId, succeeded: true, reason: null });
      } catch (err) {
        outcomes.push({
          lead_id: leadId,
          succeeded: false,
          reason: err instanceof Error ? err.message : 'Failed to archive lead',
        });
      }
    }
    return summarizeOutcomes(outcomes);
  },

  // do_not_contact leads are skipped (not failed) unless override_reason is
  // supplied — createTask's own guardDangerousOperation call enforces this
  // per lead, so nothing extra is needed here.
  async bulkCreateTask(input: BulkCreateTaskInput, ctx: RequestContext): Promise<BulkActionResult> {
    await PermissionService.requirePermission(ctx.user.id, 'bulk_manage_recruitment_leads');

    const outcomes: BulkActionOutcome[] = [];
    for (const leadId of input.lead_ids) {
      try {
        await LeadService.createTask(
          leadId,
          {
            title: input.title,
            description: input.description,
            priority: input.priority,
            assigned_user_id: input.assigned_user_id,
            due_at: input.due_at,
            override_reason: input.override_reason,
          },
          ctx,
        );
        outcomes.push({ lead_id: leadId, succeeded: true, reason: null });
      } catch (err) {
        outcomes.push({
          lead_id: leadId,
          succeeded: false,
          reason: err instanceof Error ? err.message : 'Failed to create task',
        });
      }
    }
    return summarizeOutcomes(outcomes);
  },

  // Read-only dry run — the UI's required pre-apply validation summary comes
  // straight from this, never re-derived client-side. bulkChangeStatus
  // re-validates from scratch at apply time regardless (never trusts this
  // preview as authorization).
  async previewBulkChangeStatus(
    input: { lead_ids: string[]; new_status: LeadStatus },
    ctx: RequestContext,
  ): Promise<BulkChangeStatusPreview> {
    await PermissionService.requirePermission(ctx.user.id, 'bulk_manage_recruitment_leads');

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('leads')
      .select('id, status')
      .eq('company_id', ctx.company.id)
      .in('id', input.lead_ids);
    if (error) throw new DatabaseError(error.message);

    const rows = (data as Array<{ id: string; status: LeadStatus }>) ?? [];
    const statusById = new Map(rows.map((r) => [r.id, r.status]));

    const eligible: string[] = [];
    const ineligible: Array<{ lead_id: string; reason: string }> = [];

    for (const leadId of input.lead_ids) {
      const currentStatus = statusById.get(leadId);
      if (!currentStatus) {
        ineligible.push({ lead_id: leadId, reason: 'Lead not found' });
        continue;
      }
      if (input.new_status === currentStatus) {
        ineligible.push({ lead_id: leadId, reason: 'Already in that status' });
        continue;
      }
      if (input.new_status === 'converted') {
        ineligible.push({
          lead_id: leadId,
          reason: 'Use the Convert to Subject action instead',
        });
        continue;
      }
      // Bulk status changes only ever apply normal transitions — a single
      // exceptional-transition reason cannot be assumed valid across a
      // batch of leads that may be at different current statuses.
      const allowedNext = STATUS_TRANSITIONS[currentStatus] ?? [];
      if (!allowedNext.includes(input.new_status)) {
        ineligible.push({
          lead_id: leadId,
          reason: `Not a normal transition from ${currentStatus.replace(/_/g, ' ')}`,
        });
      } else {
        eligible.push(leadId);
      }
    }

    return { eligible_lead_ids: eligible, ineligible, all_eligible: ineligible.length === 0 };
  },

  // All-or-nothing: rejects the entire batch if any selected lead is
  // ineligible, per "do not allow bulk status transitions unless every
  // selected Lead is eligible for that transition."
  async bulkChangeStatus(
    input: BulkChangeStatusInput,
    ctx: RequestContext,
  ): Promise<BulkActionResult> {
    await PermissionService.requirePermission(ctx.user.id, 'bulk_manage_recruitment_leads');

    const preview = await LeadService.previewBulkChangeStatus(
      { lead_ids: input.lead_ids, new_status: input.new_status },
      ctx,
    );
    if (!preview.all_eligible) {
      throw new BusinessRuleError(
        `Bulk status change blocked — ${preview.ineligible.length} of ${input.lead_ids.length} selected leads are not eligible to move to ${input.new_status.replace(/_/g, ' ')}.`,
      );
    }

    const outcomes: BulkActionOutcome[] = [];
    for (const leadId of input.lead_ids) {
      try {
        await LeadService.changeStatus(
          leadId,
          { new_status: input.new_status, reason: input.reason },
          ctx,
        );
        outcomes.push({ lead_id: leadId, succeeded: true, reason: null });
      } catch (err) {
        outcomes.push({
          lead_id: leadId,
          succeeded: false,
          reason: err instanceof Error ? err.message : 'Failed to change status',
        });
      }
    }
    return summarizeOutcomes(outcomes);
  },

  // "My Follow-ups" is a personal lead_tasks queue (see Sprint 7.2 plan) —
  // due_today/overdue/upcoming are computed from due_at + status;
  // completed_recently looks at completed tasks from the last 14 days.
  // Viewing another user's queue requires assign_lead (the existing
  // "can see other people's workload" gate), not a new permission.
  async getFollowUpQueue(
    params: {
      scope: FollowUpQueueScope;
      assigned_user_id?: string | undefined;
      site_id?: string | undefined;
      study_id?: string | undefined;
      page?: number | undefined;
      page_size?: number | undefined;
    },
    ctx: RequestContext,
  ): Promise<{ data: FollowUpQueueEntry[]; total: number }> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_lead_tasks');

    const targetUserId = params.assigned_user_id ?? ctx.user.id;
    if (targetUserId !== ctx.user.id) {
      await PermissionService.requirePermission(ctx.user.id, 'assign_lead');
    }

    const page = params.page && params.page > 0 ? params.page : 1;
    const pageSize =
      params.page_size && params.page_size > 0 ? Math.min(params.page_size, 100) : 25;

    const supabase = await createServerSupabaseClient();

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const startOfTomorrow = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
    ).toISOString();

    let query = supabase
      .from('lead_tasks')
      .select(TASK_COLUMNS, { count: 'exact' })
      .eq('company_id', ctx.company.id)
      .eq('assigned_user_id', targetUserId);

    if (params.scope === 'due_today') {
      query = query
        .in('status', ['open', 'in_progress'])
        .gte('due_at', startOfToday)
        .lt('due_at', startOfTomorrow);
    } else if (params.scope === 'overdue') {
      query = query.in('status', ['open', 'in_progress']).lt('due_at', startOfToday);
    } else if (params.scope === 'upcoming') {
      query = query.in('status', ['open', 'in_progress']).gte('due_at', startOfTomorrow);
    } else {
      const cutoff = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
      query = query.eq('status', 'completed').gte('completed_at', cutoff);
    }

    if (params.site_id) query = query.eq('site_id', params.site_id);
    if (params.study_id) query = query.eq('study_id', params.study_id);

    query = query
      .order('due_at', { ascending: true, nullsFirst: false })
      .range((page - 1) * pageSize, page * pageSize - 1);

    const { data, error, count } = await query;
    if (error) throw new DatabaseError(error.message);
    const tasks = (data as LeadTask[]) ?? [];

    const leadIds = Array.from(new Set(tasks.map((t) => t.lead_id)));
    const leadInfoById = new Map<string, { status: LeadStatus; initials: string | null }>();
    if (leadIds.length > 0) {
      const { data: leadRows, error: leadsError } = await supabase
        .from('leads')
        .select('id, status, initials')
        .eq('company_id', ctx.company.id)
        .in('id', leadIds);
      if (leadsError) throw new DatabaseError(leadsError.message);
      for (const row of (leadRows as Array<{
        id: string;
        status: LeadStatus;
        initials: string | null;
      }>) ?? []) {
        leadInfoById.set(row.id, { status: row.status, initials: row.initials });
      }
    }

    const entries: FollowUpQueueEntry[] = tasks.map((task) => ({
      ...task,
      lead_status: leadInfoById.get(task.lead_id)?.status ?? 'new',
      lead_initials: leadInfoById.get(task.lead_id)?.initials ?? null,
    }));

    return { data: entries, total: count ?? entries.length };
  },

  // assign_lead is reused as the "can see workload across users" gate — the
  // same permission already governs seeing/changing who owns a lead.
  async getWorkloadSummary(
    filters: { site_id?: string | undefined; study_id?: string | undefined },
    ctx: RequestContext,
  ): Promise<WorkloadSummary> {
    await PermissionService.requirePermission(ctx.user.id, 'assign_lead');

    const supabase = await createServerSupabaseClient();
    let leadsQuery = supabase
      .from('leads')
      .select('id, assigned_user_id')
      .eq('company_id', ctx.company.id)
      .is('archived_at', null);
    if (filters.site_id) leadsQuery = leadsQuery.eq('site_id', filters.site_id);
    if (filters.study_id) leadsQuery = leadsQuery.eq('study_id', filters.study_id);

    const { data: leadRows, error: leadsError } = await leadsQuery;
    if (leadsError) throw new DatabaseError(leadsError.message);
    const leads = (leadRows as Array<{ id: string; assigned_user_id: string | null }>) ?? [];

    const countByUser = new Map<string, number>();
    let unassignedCount = 0;
    for (const lead of leads) {
      if (lead.assigned_user_id) {
        countByUser.set(lead.assigned_user_id, (countByUser.get(lead.assigned_user_id) ?? 0) + 1);
      } else {
        unassignedCount += 1;
      }
    }

    const { data: taskRows, error: tasksError } = await supabase
      .from('lead_tasks')
      .select('assigned_user_id, due_at')
      .eq('company_id', ctx.company.id)
      .in('status', ['open', 'in_progress']);
    if (tasksError) throw new DatabaseError(tasksError.message);

    const overdueCountByUser = new Map<string, number>();
    const now = Date.now();
    for (const row of (taskRows as Array<{
      assigned_user_id: string | null;
      due_at: string | null;
    }>) ?? []) {
      if (!row.assigned_user_id || !row.due_at) continue;
      if (new Date(row.due_at).getTime() < now) {
        overdueCountByUser.set(
          row.assigned_user_id,
          (overdueCountByUser.get(row.assigned_user_id) ?? 0) + 1,
        );
      }
    }

    const entries: WorkloadSummaryEntry[] = Array.from(countByUser.entries()).map(
      ([assigned_user_id, active_lead_count]) => ({
        assigned_user_id,
        active_lead_count,
        overdue_task_count: overdueCountByUser.get(assigned_user_id) ?? 0,
      }),
    );

    return { entries, unassigned_count: unassignedCount };
  },

  // Mirrors the ActivationReadiness pattern already built for Studies — only
  // the preconditions convertToSubject actually enforces are blocking=true;
  // duplicate/do-not-contact/consent are informational warnings, matching
  // that same precedent's reasoning.
  async getConversionReadiness(leadId: string, ctx: RequestContext): Promise<ConversionReadiness> {
    await PermissionService.requirePermission(ctx.user.id, 'view_leads');
    const lead = await getLeadOrThrow(leadId, ctx);

    const supabase = await createServerSupabaseClient();
    const canConvertPermission = await PermissionService.hasPermission(ctx.user.id, 'convert_lead');

    const items: ConversionReadinessItem[] = [];

    items.push({
      key: 'not_previously_converted',
      label: 'Lead has not already been converted',
      met: !lead.converted_subject_id,
      blocking: true,
      reason: lead.converted_subject_id
        ? 'This lead has already been converted to a Subject.'
        : null,
    });
    items.push({
      key: 'site_assigned',
      label: 'Site assigned',
      met: Boolean(lead.site_id),
      blocking: true,
      reason: lead.site_id
        ? null
        : 'This lead must be assigned to a site before it can be converted.',
    });
    items.push({
      key: 'study_assigned',
      label: 'Study assigned',
      met: Boolean(lead.study_id),
      blocking: true,
      reason: lead.study_id
        ? null
        : 'This lead must be matched to a study before it can be converted.',
    });
    items.push({
      key: 'permission_granted',
      label: 'You have permission to convert leads',
      met: canConvertPermission,
      blocking: true,
      reason: canConvertPermission ? null : 'You do not have permission to convert leads.',
    });

    let contactInfoComplete = false;
    let contactInfoReason: string | null = 'This lead has no contact information on file yet.';
    const { data: contactInfo } = await supabase
      .from('lead_contact_info')
      .select('date_of_birth, sex')
      .eq('lead_id', leadId)
      .maybeSingle();
    if (contactInfo) {
      const info = contactInfo as { date_of_birth: string | null; sex: string | null };
      const missing = [!info.date_of_birth && 'date of birth', !info.sex && 'sex'].filter(
        (f): f is string => Boolean(f),
      );
      contactInfoComplete = missing.length === 0;
      contactInfoReason = missing.length > 0 ? `Missing ${missing.join(' and ')} on file.` : null;
    }
    items.push({
      key: 'contact_info_complete',
      label: 'Contact information complete (date of birth, sex)',
      met: contactInfoComplete,
      blocking: true,
      reason: contactInfoReason,
    });

    let prescreeningEligible = false;
    let prescreeningReason: string | null = 'No study matched yet.';
    if (lead.study_id) {
      prescreeningReason = 'No prescreening on file for the matched study.';
      const { data: latestPrescreening } = await supabase
        .from('lead_prescreenings')
        .select('computed_outcome, manual_outcome')
        .eq('lead_id', leadId)
        .eq('study_id', lead.study_id)
        .order('completed_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (latestPrescreening) {
        const p = latestPrescreening as {
          computed_outcome: PrescreeningOutcome;
          manual_outcome: PrescreeningOutcome | null;
        };
        const effective = p.manual_outcome ?? p.computed_outcome;
        prescreeningEligible = effective !== 'not_eligible';
        prescreeningReason = prescreeningEligible
          ? null
          : 'The most recent prescreening outcome is Not Eligible.';
      }
    }
    items.push({
      key: 'prescreening_eligible',
      label: 'Prescreening outcome is not Not Eligible',
      met: prescreeningEligible,
      blocking: true,
      reason: prescreeningReason,
    });

    const canViewPhi = await PermissionService.hasPermission(ctx.user.id, 'view_lead_phi');
    let hasActiveDuplicate = false;
    if (canViewPhi) {
      const flagged = await LeadDuplicateService.getLeadsWithActiveDuplicateWarnings(ctx);
      hasActiveDuplicate = flagged.has(leadId);
    }
    items.push({
      key: 'duplicate_review',
      label: 'No unresolved duplicate matches',
      met: !hasActiveDuplicate,
      blocking: false,
      reason: hasActiveDuplicate
        ? 'This lead has an unresolved possible duplicate match — review before converting.'
        : null,
    });

    items.push({
      key: 'do_not_contact_clear',
      label: 'Lead is not marked do-not-contact',
      met: !lead.do_not_contact,
      blocking: false,
      reason: lead.do_not_contact ? 'This lead is marked do-not-contact.' : null,
    });

    items.push({
      key: 'consent_to_contact',
      label: 'Consent to contact is recorded',
      met: lead.consent_to_contact,
      blocking: false,
      reason: lead.consent_to_contact
        ? null
        : 'Consent to contact has not been recorded for this lead.',
    });

    const blockingItems = items.filter((i) => i.blocking && !i.met);
    const warnings = items.filter((i) => !i.blocking && !i.met);

    return {
      can_convert: blockingItems.length === 0,
      items,
      blocking_items: blockingItems,
      warnings,
    };
  },

  // Column counts for the Kanban Pipeline — one bounded query (status only,
  // capped) grouped in JS by the shared column mapping, never a per-column
  // count query (10x) and never the full lead rows (no PHI join at all).
  async getPipelineCounts(
    filters: {
      site_id?: string | undefined;
      study_id?: string | undefined;
      assigned_user_id?: string | undefined;
      priority?: LeadPriority | undefined;
    },
    ctx: RequestContext,
  ): Promise<PipelineCounts> {
    await PermissionService.requirePermission(ctx.user.id, 'view_leads');

    const supabase = await createServerSupabaseClient();
    let query = supabase
      .from('leads')
      .select('status')
      .eq('company_id', ctx.company.id)
      .is('archived_at', null)
      .limit(10000);
    if (filters.site_id) query = query.eq('site_id', filters.site_id);
    if (filters.study_id) query = query.eq('study_id', filters.study_id);
    if (filters.assigned_user_id) query = query.eq('assigned_user_id', filters.assigned_user_id);
    if (filters.priority) query = query.eq('priority', filters.priority);

    const { data, error } = await query;
    if (error) throw new DatabaseError(error.message);

    const countByColumn = new Map<PipelineColumnKey, number>();
    for (const row of (data as Array<{ status: LeadStatus }>) ?? []) {
      const column = getPipelineColumnForStatus(row.status);
      countByColumn.set(column, (countByColumn.get(column) ?? 0) + 1);
    }

    const columns = PIPELINE_COLUMN_ORDER.map((column) => ({
      column,
      count: countByColumn.get(column) ?? 0,
    }));

    return { columns };
  },
};
