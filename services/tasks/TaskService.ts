import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@/lib/supabase/admin';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import { NotificationService } from '@/services/notifications/NotificationService';
import {
  NotFoundError,
  DatabaseError,
  BusinessRuleError,
  PermissionDeniedError,
} from '@/lib/api/errors';
import type {
  Task,
  TaskStatus,
  TaskPriority,
  TaskHistoryEntry,
  TaskComment,
  AddTaskCommentInput,
  CreateTaskInput,
  CancelTaskInput,
  ReassignTaskInput,
  TaskEffectivePriority,
  TaskQueueFilters,
  TaskQueueItem,
  TaskQueueResult,
} from '@/types/tasks';
import type { RequestContext } from '@/types/api';

const TASK_COLUMNS =
  'id, company_id, site_id, assigned_to, assigned_role, source_module, source_record_type, source_record_id, title, description, priority, status, due_date, created_by_system, created_at, updated_at';
const TASK_HISTORY_COLUMNS =
  'id, company_id, task_id, old_status, new_status, changed_by, changed_at, reason';
const TASK_COMMENT_COLUMNS = 'id, company_id, task_id, comment, created_by, created_at';

const DEFAULT_QUEUE_PAGE_SIZE = 25;
const MAX_QUEUE_PAGE_SIZE = 100;

// Approved Milestone 5.0 state machine (Phase B §F, unchanged by this
// implementation). Keyed by "from" status, valued by the set of valid "to"
// statuses. completed/cancelled are terminal — no outgoing edges. No UI/API
// action for in_progress/waiting ships in 5.0 (Phase A/B E) — the enum
// values and transition edges exist for forward compatibility only.
const VALID_TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  new: ['assigned', 'in_progress', 'completed', 'cancelled'],
  assigned: ['in_progress', 'waiting', 'completed', 'cancelled'],
  in_progress: ['waiting', 'completed', 'cancelled'],
  waiting: ['in_progress', 'completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export function isValidTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TASK_TRANSITIONS[from]?.includes(to) ?? false;
}

const PRIORITY_RANK: Record<TaskPriority, number> = { critical: 4, high: 3, medium: 2, low: 1 };
const RANK_TO_PRIORITY: TaskPriority[] = ['low', 'medium', 'high', 'critical'];

// Compute-on-read effective priority (Phase B §H, Security Addendum
// unchanged). Base priority (stored, snapshotted at creation) is a FLOOR —
// due-date proximity can only escalate a task above it, never downgrade it
// below what the creating event judged the task to deserve. Unlike
// ChartService.computeChartAging (which ignores the stored charts.priority
// column entirely, since that column is vestigial), tasks.priority is a
// real input here — this is a deliberate, documented divergence from the
// Charts precedent, not a copy-paste.
//
// Terminal (completed/cancelled) tasks never escalate and are never
// "overdue" work — effective_priority collapses to the stored base
// priority, is_overdue is always false, days_overdue is always null.
export function computeTaskEffectivePriority(
  task: Pick<Task, 'priority' | 'due_date' | 'status'>,
  now: Date = new Date(),
): TaskEffectivePriority {
  if (task.status === 'completed' || task.status === 'cancelled') {
    return { effective_priority: task.priority, is_overdue: false, days_overdue: null };
  }
  if (!task.due_date) {
    return { effective_priority: task.priority, is_overdue: false, days_overdue: null };
  }

  const dueDate = new Date(task.due_date);
  const msDiff = now.getTime() - dueDate.getTime(); // positive = overdue
  const isOverdue = msDiff > 0;
  const daysOverdue = isOverdue ? Math.floor(msDiff / 86_400_000) : null;

  // Due-date-derived escalation tier, independent of base priority:
  //   > 3 days overdue      -> critical
  //   0-3 days overdue      -> high
  //   due within 1 day      -> medium
  //   otherwise             -> low (no escalation pressure)
  let dueDateRank: number;
  if (isOverdue && daysOverdue !== null && daysOverdue > 3) {
    dueDateRank = PRIORITY_RANK.critical;
  } else if (isOverdue) {
    dueDateRank = PRIORITY_RANK.high;
  } else if (-msDiff <= 86_400_000) {
    dueDateRank = PRIORITY_RANK.medium;
  } else {
    dueDateRank = PRIORITY_RANK.low;
  }

  const effectiveRank = Math.max(PRIORITY_RANK[task.priority], dueDateRank);
  return {
    effective_priority: RANK_TO_PRIORITY[effectiveRank - 1] as TaskPriority,
    is_overdue: isOverdue,
    days_overdue: daysOverdue,
  };
}

// Approved queue order (Phase B §H): effective priority desc, then days
// overdue desc, then created_at asc. Same shape as ChartService's
// compareChartQueueItems.
function compareTaskQueueItems(a: TaskQueueItem, b: TaskQueueItem): number {
  const rankDiff = PRIORITY_RANK[b.effective_priority] - PRIORITY_RANK[a.effective_priority];
  if (rankDiff !== 0) return rankDiff;

  const daysA = a.days_overdue ?? -1;
  const daysB = b.days_overdue ?? -1;
  if (daysB !== daysA) return daysB - daysA;

  return a.created_at.localeCompare(b.created_at);
}

function isUniqueViolation(error: { code?: string } | null | undefined): boolean {
  return error?.code === '23505';
}

// RLS-deferred lookup (tasks_select: company + can_access_site + (view_tasks
// OR assigned_to = auth.uid())) — deliberately does NOT call
// PermissionService.requirePermission('view_tasks') up front, unlike
// ChartService's getChartOrThrow. Charts has no self-assignee visibility
// concept; Tasks does (an assignee may see their own task without
// view_tasks), so the session-scoped client + RLS IS the authorization here,
// not a shortcut around it — re-deriving that OR-predicate in TypeScript
// would risk drifting out of sync with the actual RLS policy.
async function getTaskOrThrow(taskId: string, ctx: RequestContext): Promise<Task> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from('tasks')
    .select(TASK_COLUMNS)
    .eq('id', taskId)
    .eq('company_id', ctx.company.id)
    .maybeSingle();

  if (error) throw new DatabaseError(error.message);
  if (!data) throw new NotFoundError('Task');
  return data as Task;
}

// Mirrors ChartService.getChartForCommentScopeOrThrow exactly, for exactly
// the same reason: comment_task must stand entirely on its own, never
// implicitly coupled to view_tasks (or the assigned_to=self carve-out).
// Uses the admin client purely to resolve the task's existence/site_id for
// scoping the comment insert and its audit log — never to bypass the
// comment_task permission check itself (the caller always calls
// PermissionService.requirePermission(ctx.user.id, 'comment_task') first),
// and it re-validates company_id explicitly rather than trusting the admin
// client's lack of RLS.
async function getTaskForCommentScopeOrThrow(taskId: string, ctx: RequestContext): Promise<Task> {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('tasks')
    .select(TASK_COLUMNS)
    .eq('id', taskId)
    .eq('company_id', ctx.company.id)
    .maybeSingle();

  if (error) throw new DatabaseError(error.message);
  if (!data) throw new NotFoundError('Task');
  return data as Task;
}

// Cross-user site-access check (Final RLS Correction / Security Addendum
// §B). Deliberately NOT PermissionService.canAccessSite(userId, siteId) —
// that helper's view_all_sites branch calls PermissionService.hasPermission,
// whose underlying has_permission SQL RPC is hardcoded to auth.uid(), i.e.
// the CURRENT session, regardless of the userId argument passed in. Safe
// when userId === ctx.user.id (the two happen to be the same subject), but
// silently wrong for a genuinely different target user (a chart_assignments
// owner or a reassignment target) — it would answer the question "can I,
// the caller, access this site" instead of "can they." The dedicated
// user_has_site_access SQL function (migration 030) takes the target user
// explicitly and has no such coupling; called here via the admin client so
// this check is unaffected by the calling session's own RLS/permissions.
async function targetUserHasSiteAccess(userId: string, siteId: string): Promise<boolean> {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin.rpc('user_has_site_access', {
    p_user_id: userId,
    p_site_id: siteId,
  });
  if (error) return false; // fail closed
  return Boolean(data);
}

// AE-2 (approved): resolve a newly-created chart task's default assignee
// from the chart's active chart_assignments owner, falling back to the
// unclaimed data_entry role queue if there is none or it is stale. Reads
// via the admin client (chart_assignments_select requires view_charts,
// which the caller triggering this — e.g. a CRC completing a visit — may
// not hold; this internal resolution must not be coupled to that permission
// any more than chart_assignments' own RLS is, per the Final RLS
// Correction). Never mutates or deletes the chart_assignments row itself —
// a stale owner is simply not used for THIS task.
async function resolveChartTaskAssignee(chart: {
  id: string;
  company_id: string;
  site_id: string;
}): Promise<{ assignedTo: string | null; assignedRole: string | null }> {
  const admin = createAdminSupabaseClient();

  const { data: assignment } = await admin
    .from('chart_assignments')
    .select('assigned_to')
    .eq('chart_id', chart.id)
    .eq('company_id', chart.company_id)
    .eq('active', true)
    .maybeSingle();

  const ownerId = (assignment as { assigned_to?: string } | null)?.assigned_to;

  if (ownerId) {
    const { data: profile } = await admin
      .from('profiles')
      .select('id')
      .eq('id', ownerId)
      .eq('company_id', chart.company_id)
      .maybeSingle();

    if (profile) {
      const hasSiteAccess = await targetUserHasSiteAccess(ownerId, chart.site_id);
      if (hasSiteAccess) {
        return { assignedTo: ownerId, assignedRole: null };
      }
    }
  }

  // Invalid, stale, or no active assignment — unclaimed, role-queued.
  return { assignedTo: null, assignedRole: 'data_entry' };
}

// Shared transition writer for user-initiated mutations (completeTask,
// cancelTask). Mirrors ChartService.writeChartTransition. Both the tasks
// UPDATE and the task_history INSERT go through the ordinary session-scoped
// client — migration 032 closed the gap in task_history_insert's RLS that
// previously required routing the self-assignee completion path's history
// write through the admin client (see the migration 032 report for the
// policy change; that workaround no longer exists in this function).
async function writeTaskTransition(
  task: Task,
  newStatus: TaskStatus,
  ctx: RequestContext,
  options: {
    reason?: string | null | undefined;
    auditAction: string;
  },
): Promise<Task> {
  const supabase = await createServerSupabaseClient();

  const { data: updated, error } = await supabase
    .from('tasks')
    .update({ status: newStatus })
    .eq('id', task.id)
    .eq('company_id', ctx.company.id)
    .select(TASK_COLUMNS)
    .single();

  if (error || !updated) throw new DatabaseError(error?.message ?? 'Failed to update task');

  await supabase.from('task_history').insert({
    company_id: ctx.company.id,
    task_id: task.id,
    old_status: task.status,
    new_status: newStatus,
    changed_by: ctx.user.id,
    reason: options.reason ?? null,
  });

  await AuditService.log({
    company_id: ctx.company.id,
    site_id: task.site_id,
    user_id: ctx.user.id,
    action: options.auditAction,
    module: 'tasks',
    record_type: 'tasks',
    record_id: task.id,
    old_value: { status: task.status },
    new_value: { status: newStatus, reason: options.reason ?? null },
  });

  return updated as Task;
}

export const TaskService = {
  isValidTaskTransition,
  computeTaskEffectivePriority,

  // Manual creation (Admin, create_task). Goes through the ordinary
  // session-scoped client throughout, including its initial task_history
  // row — tasks_insert's and (since migration 032) task_history_insert's
  // RLS both authorize has_permission('create_task') directly, so no
  // admin-client bypass is needed anywhere in this method. This is
  // deliberately the ONLY path that can ever produce a
  // created_by_system = false task.
  async createTask(input: CreateTaskInput, ctx: RequestContext): Promise<Task> {
    await PermissionService.requirePermission(ctx.user.id, 'create_task');
    await PermissionService.requireSiteAccess(ctx.user.id, input.site_id);

    if (!input.assigned_to && !input.assigned_role) {
      throw new BusinessRuleError('A task must have either an assigned user or an assigned role.');
    }

    if (input.assigned_to) {
      await PermissionService.validateUserExists(input.assigned_to, ctx.company.id);
      const hasSiteAccess = await targetUserHasSiteAccess(input.assigned_to, input.site_id);
      if (!hasSiteAccess) {
        throw new BusinessRuleError('The assigned user does not have access to this site.');
      }
    }

    const status: TaskStatus = input.assigned_to ? 'assigned' : 'new';
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('tasks')
      .insert({
        company_id: ctx.company.id,
        site_id: input.site_id,
        assigned_to: input.assigned_to ?? null,
        assigned_role: input.assigned_to ? null : (input.assigned_role ?? null),
        source_module: input.source_module ?? 'manual',
        source_record_type: input.source_record_type ?? null,
        source_record_id: input.source_record_id ?? null,
        title: input.title,
        description: input.description ?? null,
        priority: input.priority ?? 'medium',
        status,
        due_date: input.due_date ?? null,
        created_by_system: false,
      })
      .select(TASK_COLUMNS)
      .single();

    if (error || !data) throw new DatabaseError(error?.message ?? 'Failed to create task');
    const task = data as Task;

    await supabase.from('task_history').insert({
      company_id: ctx.company.id,
      task_id: task.id,
      old_status: null,
      new_status: task.status,
      changed_by: ctx.user.id,
      reason: null,
    });

    await AuditService.log({
      company_id: ctx.company.id,
      site_id: task.site_id,
      user_id: ctx.user.id,
      action: 'task.created',
      module: 'tasks',
      record_type: 'tasks',
      record_id: task.id,
      new_value: { status: task.status, title: task.title },
    });

    if (task.assigned_to) {
      await NotificationService.dispatch({
        type: 'task_assigned',
        companyId: ctx.company.id,
        siteId: task.site_id,
        recipientUserId: task.assigned_to,
        relatedModule: 'tasks',
        relatedRecordId: task.id,
        relatedRecordType: 'task',
        context: { task_title: task.title },
      });
    }

    return task;
  },

  // Internal, server-controlled only — never exported via any API route.
  // Exported on this object (not a closure-private function) purely so
  // ChartService can call it directly once integrated (matching
  // ChartService.ensureChartForCompletedVisit's own "public on the object,
  // private in intended caller" convention) — its safety comes from using
  // the admin/service-role client plus explicit re-validation, not from
  // being unreachable. Do not add a route that calls this directly; do not
  // widen it into a generic "create a task as any module" primitive callable
  // with arbitrary, unvalidated input — every field written here is
  // resolved from the trusted `chart` argument or the fixed
  // source_module='charts' constant, never from unchecked caller input.
  async ensureTaskForChartReady(
    chart: { id: string; company_id: string; site_id: string },
    taskInput: {
      title: string;
      description?: string | null | undefined;
      priority: TaskPriority;
      due_date?: string | null | undefined;
    },
    ctx: RequestContext,
  ): Promise<{ taskId: string; taskCreated: boolean }> {
    if (chart.company_id !== ctx.company.id) {
      throw new BusinessRuleError('Task creation company mismatch.');
    }

    const { assignedTo, assignedRole } = await resolveChartTaskAssignee(chart);
    const admin = createAdminSupabaseClient();

    const { data: inserted, error } = await admin
      .from('tasks')
      .insert({
        company_id: chart.company_id,
        site_id: chart.site_id,
        assigned_to: assignedTo,
        assigned_role: assignedRole,
        source_module: 'charts',
        source_record_type: 'chart',
        source_record_id: chart.id,
        title: taskInput.title,
        description: taskInput.description ?? null,
        priority: taskInput.priority,
        status: assignedTo ? 'assigned' : 'new',
        due_date: taskInput.due_date ?? null,
        created_by_system: true,
      })
      .select(TASK_COLUMNS)
      .single();

    if (error) {
      // uq_tasks_open_per_source hit — an open task already exists for this
      // chart (retried/idempotent call). Not an error: resolve and return
      // the existing row, matching ChartService.ensureChartForCompletedVisit's
      // own "chart_created: false but chartId still populated" contract.
      if (isUniqueViolation(error)) {
        const { data: existing, error: lookupError } = await admin
          .from('tasks')
          .select(TASK_COLUMNS)
          .eq('source_module', 'charts')
          .eq('source_record_type', 'chart')
          .eq('source_record_id', chart.id)
          .eq('company_id', chart.company_id)
          .not('status', 'in', '("completed","cancelled")')
          .single();
        if (lookupError || !existing) {
          throw new DatabaseError(lookupError?.message ?? 'Task conflict could not be resolved');
        }
        return { taskId: (existing as Task).id, taskCreated: false };
      }
      throw new DatabaseError(error.message);
    }

    const task = inserted as Task;

    await admin.from('task_history').insert({
      company_id: chart.company_id,
      task_id: task.id,
      old_status: null,
      new_status: task.status,
      changed_by: ctx.user.id,
      reason: null,
    });

    await AuditService.logWithAdmin({
      company_id: chart.company_id,
      site_id: chart.site_id,
      user_id: ctx.user.id,
      action: 'task.created',
      module: 'tasks',
      record_type: 'tasks',
      record_id: task.id,
      new_value: { status: task.status, source_module: 'charts', source_record_id: chart.id },
    });

    if (assignedTo) {
      await NotificationService.dispatch({
        type: 'task_assigned',
        companyId: chart.company_id,
        siteId: chart.site_id,
        recipientUserId: assignedTo,
        relatedModule: 'tasks',
        relatedRecordId: task.id,
        relatedRecordType: 'task',
        context: { task_title: task.title },
      });
    }

    return { taskId: task.id, taskCreated: true };
  },

  // Internal, server-controlled only — same posture as
  // ensureTaskForChartReady above. Not wired into ChartService yet (that
  // integration is a later, separately-approved phase); exists now so it
  // exists as a tested, ready call target.
  async completeTaskForChart(chartId: string, ctx: RequestContext): Promise<void> {
    const admin = createAdminSupabaseClient();
    const { data: openTask } = await admin
      .from('tasks')
      .select(TASK_COLUMNS)
      .eq('source_module', 'charts')
      .eq('source_record_type', 'chart')
      .eq('source_record_id', chartId)
      .eq('company_id', ctx.company.id)
      .not('status', 'in', '("completed","cancelled")')
      .maybeSingle();

    if (!openTask) return; // safe no-op — no open task to complete

    const task = openTask as Task;
    if (!isValidTaskTransition(task.status, 'completed')) return;

    const { error: updateError } = await admin
      .from('tasks')
      .update({ status: 'completed' })
      .eq('id', task.id)
      .eq('company_id', ctx.company.id);
    if (updateError) throw new DatabaseError(updateError.message);

    await admin.from('task_history').insert({
      company_id: ctx.company.id,
      task_id: task.id,
      old_status: task.status,
      new_status: 'completed',
      changed_by: ctx.user.id,
      reason: null,
    });

    await AuditService.logWithAdmin({
      company_id: ctx.company.id,
      site_id: task.site_id,
      user_id: ctx.user.id,
      action: 'task.completed',
      module: 'tasks',
      record_type: 'tasks',
      record_id: task.id,
      old_value: { status: task.status },
      new_value: { status: 'completed' },
    });
  },

  // complete_task authorizes any qualifying task; an assignee may also
  // complete their OWN task without holding complete_task (tasks_update's
  // RLS explicitly allows assigned_to = auth.uid() — Security Addendum §C).
  // Site authorization is enforced unconditionally regardless of which of
  // the two paths granted permission — assignment never substitutes for it.
  async completeTask(taskId: string, ctx: RequestContext): Promise<Task> {
    const task = await getTaskOrThrow(taskId, ctx);

    const hasCompletePermission = await PermissionService.hasPermission(
      ctx.user.id,
      'complete_task',
    );
    const isSelfAssignee = task.assigned_to === ctx.user.id;
    if (!hasCompletePermission && !isSelfAssignee) {
      throw new PermissionDeniedError('complete_task');
    }
    await PermissionService.requireSiteAccess(ctx.user.id, task.site_id);

    if (!isValidTaskTransition(task.status, 'completed')) {
      throw new BusinessRuleError(`A task in "${task.status}" status cannot be completed.`);
    }

    return writeTaskTransition(task, 'completed', ctx, {
      auditAction: 'task.completed',
    });
  },

  // Admin-only (decision #3): cancel_task permission + mandatory non-blank
  // reason, via the same guardDangerousOperation mechanism reopenChart
  // already uses. No self-assignee bypass — cancellation is never available
  // to an assignee acting only on their own assignment.
  async cancelTask(taskId: string, input: CancelTaskInput, ctx: RequestContext): Promise<Task> {
    const task = await getTaskOrThrow(taskId, ctx);

    await PermissionService.guardDangerousOperation(ctx.user.id, 'cancel_task', {
      blocked: true,
      reason: input.reason,
      blockedMessage: 'Cancelling a task requires the Cancel Task permission and a reason.',
    });
    await PermissionService.requireSiteAccess(ctx.user.id, task.site_id);

    if (!isValidTaskTransition(task.status, 'cancelled')) {
      throw new BusinessRuleError(`A task in "${task.status}" status cannot be cancelled.`);
    }

    return writeTaskTransition(task, 'cancelled', ctx, {
      reason: input.reason,
      auditAction: 'task.cancelled',
    });
  },

  // Admin-only (assign_task). Validates the target user belongs to the same
  // company and has access to THIS task's site — never the caller's own
  // access, which is separately and unconditionally required too.
  // Deliberately never touches chart_assignments (Phase B §G / this turn's
  // explicit confirmation): chart ownership and a specific task's assignee
  // remain fully decoupled in both directions.
  async reassignTask(taskId: string, input: ReassignTaskInput, ctx: RequestContext): Promise<Task> {
    await PermissionService.requirePermission(ctx.user.id, 'assign_task');

    const task = await getTaskOrThrow(taskId, ctx);
    await PermissionService.requireSiteAccess(ctx.user.id, task.site_id);

    if (task.status === 'completed' || task.status === 'cancelled') {
      throw new BusinessRuleError(`A task in "${task.status}" status cannot be reassigned.`);
    }

    await PermissionService.validateUserExists(input.assigned_to, ctx.company.id);
    const targetHasSiteAccess = await targetUserHasSiteAccess(input.assigned_to, task.site_id);
    if (!targetHasSiteAccess) {
      throw new BusinessRuleError("The selected user does not have access to this task's site.");
    }

    // new/waiting -> assigned on reassignment (Phase B §G); assigned/
    // in_progress keep their current status — reassignment is an assignee
    // change, not necessarily itself a status transition.
    const newStatus: TaskStatus =
      task.status === 'new' || task.status === 'waiting' ? 'assigned' : task.status;
    const statusChanged = newStatus !== task.status;

    const supabase = await createServerSupabaseClient();
    const { data: updated, error } = await supabase
      .from('tasks')
      .update({ assigned_to: input.assigned_to, assigned_role: null, status: newStatus })
      .eq('id', task.id)
      .eq('company_id', ctx.company.id)
      .select(TASK_COLUMNS)
      .single();

    if (error || !updated) throw new DatabaseError(error?.message ?? 'Failed to reassign task');

    // The task_history row for this reassignment (same-status when status
    // doesn't change, per this turn's explicit confirmation) is now written
    // automatically by the record_task_reassignment_history AFTER UPDATE
    // trigger (migration 035) — added so a direct, non-TaskService
    // assigned_to/assigned_role change can never silently skip the ledger.
    // TaskService must NOT also insert one here, or every reassignment would
    // produce two history rows for the same event.

    await AuditService.log({
      company_id: ctx.company.id,
      site_id: task.site_id,
      user_id: ctx.user.id,
      action: 'task.reassigned',
      module: 'tasks',
      record_type: 'tasks',
      record_id: task.id,
      old_value: { assigned_to: task.assigned_to, status: task.status },
      new_value: {
        assigned_to: input.assigned_to,
        status: newStatus,
        status_changed: statusChanged,
      },
    });

    await NotificationService.dispatch({
      type: 'task_assigned',
      companyId: ctx.company.id,
      siteId: task.site_id,
      recipientUserId: input.assigned_to,
      relatedModule: 'tasks',
      relatedRecordId: task.id,
      relatedRecordType: 'task',
      context: { task_title: task.title },
    });

    return updated as Task;
  },

  // comment_task stands entirely on its own — never coupled with view_tasks
  // or any assignment-based visibility (see getTaskForCommentScopeOrThrow),
  // mirroring ChartService.addComment's R3/R4 decision exactly.
  async addComment(
    taskId: string,
    input: AddTaskCommentInput,
    ctx: RequestContext,
  ): Promise<TaskComment> {
    await PermissionService.requirePermission(ctx.user.id, 'comment_task');

    const task = await getTaskForCommentScopeOrThrow(taskId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('task_comments')
      .insert({
        company_id: ctx.company.id,
        task_id: task.id,
        comment: input.comment,
        created_by: ctx.user.id,
      })
      .select(TASK_COMMENT_COLUMNS)
      .single();

    if (error || !data) throw new DatabaseError(error?.message ?? 'Failed to add comment');

    await AuditService.log({
      company_id: ctx.company.id,
      site_id: task.site_id,
      user_id: ctx.user.id,
      action: 'task.commented',
      module: 'tasks',
      record_type: 'tasks',
      record_id: task.id,
      new_value: { comment_id: (data as TaskComment).id },
    });

    return data as TaskComment;
  },

  async getComments(taskId: string, ctx: RequestContext): Promise<TaskComment[]> {
    await getTaskOrThrow(taskId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('task_comments')
      .select(TASK_COMMENT_COLUMNS)
      .eq('task_id', taskId)
      .eq('company_id', ctx.company.id)
      .order('created_at', { ascending: false });

    if (error) throw new DatabaseError(error.message);
    return (data as TaskComment[]) ?? [];
  },

  async getHistory(taskId: string, ctx: RequestContext): Promise<TaskHistoryEntry[]> {
    await getTaskOrThrow(taskId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('task_history')
      .select(TASK_HISTORY_COLUMNS)
      .eq('task_id', taskId)
      .eq('company_id', ctx.company.id)
      .order('changed_at', { ascending: false });

    if (error) throw new DatabaseError(error.message);
    return (data as TaskHistoryEntry[]) ?? [];
  },

  // Same read-time operational fields as listTasks/getMyToday, from the same
  // computeTaskEffectivePriority — computed on read, never persisted. Access
  // control is unchanged: getTaskOrThrow (company scope + RLS) still gates
  // the read; computation only runs on a row the caller was allowed to see.
  async getTaskById(taskId: string, ctx: RequestContext): Promise<TaskQueueItem> {
    const task = await getTaskOrThrow(taskId, ctx);
    return { ...task, ...computeTaskEffectivePriority(task) };
  },

  // General queue browse — requires view_tasks explicitly (unlike
  // getMyToday below), matching UI_UX_05_Task_Center.md's Task Center as a
  // view_tasks-gated capability, with company/site scoping applied to the
  // base query before any application-layer priority computation/sort/
  // pagination, same posture as ChartService.listCharts.
  async listTasks(filters: TaskQueueFilters, ctx: RequestContext): Promise<TaskQueueResult> {
    await PermissionService.requirePermission(ctx.user.id, 'view_tasks');

    const supabase = await createServerSupabaseClient();
    let query = supabase.from('tasks').select(TASK_COLUMNS).eq('company_id', ctx.company.id);
    if (filters.site_id) query = query.eq('site_id', filters.site_id);
    if (filters.status) query = query.eq('status', filters.status);
    if (filters.assigned_to) query = query.eq('assigned_to', filters.assigned_to);

    const { data, error } = await query;
    if (error) throw new DatabaseError(error.message);
    const tasks = (data as Task[]) ?? [];

    const page = filters.page && filters.page > 0 ? filters.page : 1;
    const pageSize =
      filters.page_size && filters.page_size > 0
        ? Math.min(filters.page_size, MAX_QUEUE_PAGE_SIZE)
        : DEFAULT_QUEUE_PAGE_SIZE;

    let items: TaskQueueItem[] = tasks.map((task) => ({
      ...task,
      ...computeTaskEffectivePriority(task),
    }));

    // Priority is compute-on-read, never a DB column filter — same
    // reasoning as ChartService.listCharts.
    if (filters.priority) {
      items = items.filter((item) => item.effective_priority === filters.priority);
    }

    items.sort(compareTaskQueueItems);

    const total = items.length;
    const paged = items.slice((page - 1) * pageSize, page * pageSize);

    return { data: paged, total, page, page_size: pageSize };
  },

  // "My tasks" — inherently self-scoped by construction (filtered to
  // assigned_to = ctx.user.id), so it does not require view_tasks: RLS's
  // assigned_to = auth.uid() carve-out is exactly what authorizes this read,
  // by design, not a gap.
  async getMyToday(ctx: RequestContext): Promise<TaskQueueItem[]> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('tasks')
      .select(TASK_COLUMNS)
      .eq('company_id', ctx.company.id)
      .eq('assigned_to', ctx.user.id)
      .not('status', 'in', '("completed","cancelled")');

    if (error) throw new DatabaseError(error.message);
    const tasks = (data as Task[]) ?? [];

    const items: TaskQueueItem[] = tasks.map((task) => ({
      ...task,
      ...computeTaskEffectivePriority(task),
    }));
    items.sort(compareTaskQueueItems);
    return items;
  },
};
