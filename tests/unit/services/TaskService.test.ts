import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@/lib/supabase/admin';
import {
  TaskService,
  isValidTaskTransition,
  computeTaskEffectivePriority,
} from '@/services/tasks/TaskService';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import { NotificationService } from '@/services/notifications/NotificationService';
import { PermissionDeniedError, BusinessRuleError, NotFoundError } from '@/lib/api/errors';
import type { Task } from '@/types/tasks';

vi.mock('@/services/audit/AuditService', () => ({
  AuditService: { log: vi.fn(), logWithAdmin: vi.fn() },
}));

vi.mock('@/services/notifications/NotificationService', () => ({
  NotificationService: { dispatch: vi.fn() },
}));

const COMPANY_ID = 'company-uuid';
const SITE_ID = 'site-uuid';
const OTHER_SITE_ID = 'other-site-uuid';
const CHART_ID = 'chart-uuid';
const TASK_ID = 'task-uuid';
const USER_ID = 'user-uuid';
const OTHER_USER_ID = 'other-user-uuid';
const OWNER_ID = 'owner-uuid';

function makeCtx() {
  return {
    user: {
      id: USER_ID,
      company_id: COMPANY_ID,
      full_name: 'Data Entry User',
      email: 'de@example.com',
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

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    company_id: COMPANY_ID,
    site_id: SITE_ID,
    assigned_to: null,
    assigned_role: 'data_entry',
    source_module: 'charts',
    source_record_type: 'chart',
    source_record_id: CHART_ID,
    title: 'Chart ready for data entry',
    description: null,
    priority: 'medium',
    status: 'new',
    due_date: null,
    created_by_system: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function queryStub(data: unknown, error: unknown = null) {
  const resolved = Promise.resolve({ data, error });
  const stub: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
    single: vi.fn().mockResolvedValue({ data, error }),
    then: resolved.then.bind(resolved),
    catch: resolved.catch.bind(resolved),
    finally: resolved.finally.bind(resolved),
  };
  for (const key of ['select', 'eq', 'in', 'not', 'order', 'limit', 'insert', 'update', 'upsert']) {
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

// Combined admin-client stub: an ordered `from` queue (chart_assignments ->
// profiles -> tasks -> task_history, in whatever subset a given test's code
// path actually reaches) plus a single `rpc` mock for
// user_has_site_access — every createAdminSupabaseClient() call in a test
// resolves to this SAME mocked instance (mockReturnValue, not Once), which
// is exactly how the real factory behaves from the caller's perspective.
function makeAdminClient(
  rpcResult: { data: unknown; error?: unknown } | null,
  ...fromResponses: Array<{ data: unknown; error?: unknown }>
) {
  const from = vi.fn();
  for (const r of fromResponses) {
    from.mockReturnValueOnce(queryStub(r.data, r.error ?? null));
  }
  const rpc = vi
    .fn()
    .mockResolvedValue(
      rpcResult
        ? { data: rpcResult.data, error: rpcResult.error ?? null }
        : { data: null, error: null },
    );
  return { from, rpc } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── isValidTaskTransition ───────────────────────────────────────────────

describe('isValidTaskTransition', () => {
  it('allows every documented transition from "new"', () => {
    expect(isValidTaskTransition('new', 'assigned')).toBe(true);
    expect(isValidTaskTransition('new', 'in_progress')).toBe(true);
    expect(isValidTaskTransition('new', 'completed')).toBe(true);
    expect(isValidTaskTransition('new', 'cancelled')).toBe(true);
    expect(isValidTaskTransition('new', 'waiting')).toBe(false);
  });

  it('allows every documented transition from "assigned"', () => {
    expect(isValidTaskTransition('assigned', 'in_progress')).toBe(true);
    expect(isValidTaskTransition('assigned', 'waiting')).toBe(true);
    expect(isValidTaskTransition('assigned', 'completed')).toBe(true);
    expect(isValidTaskTransition('assigned', 'cancelled')).toBe(true);
    expect(isValidTaskTransition('assigned', 'new')).toBe(false);
  });

  it('allows every documented transition from "in_progress"', () => {
    expect(isValidTaskTransition('in_progress', 'waiting')).toBe(true);
    expect(isValidTaskTransition('in_progress', 'completed')).toBe(true);
    expect(isValidTaskTransition('in_progress', 'cancelled')).toBe(true);
    expect(isValidTaskTransition('in_progress', 'assigned')).toBe(false);
  });

  it('allows every documented transition from "waiting"', () => {
    expect(isValidTaskTransition('waiting', 'in_progress')).toBe(true);
    expect(isValidTaskTransition('waiting', 'completed')).toBe(true);
    expect(isValidTaskTransition('waiting', 'cancelled')).toBe(true);
    expect(isValidTaskTransition('waiting', 'assigned')).toBe(false);
  });

  it('rejects every transition out of the terminal statuses', () => {
    expect(isValidTaskTransition('completed', 'new')).toBe(false);
    expect(isValidTaskTransition('completed', 'in_progress')).toBe(false);
    expect(isValidTaskTransition('completed', 'cancelled')).toBe(false);
    expect(isValidTaskTransition('cancelled', 'new')).toBe(false);
    expect(isValidTaskTransition('cancelled', 'completed')).toBe(false);
  });
});

// ── computeTaskEffectivePriority ────────────────────────────────────────

describe('computeTaskEffectivePriority', () => {
  it('returns the base priority with no escalation when there is no due date', () => {
    const result = computeTaskEffectivePriority(makeTask({ priority: 'low', due_date: null }));
    expect(result).toEqual({ effective_priority: 'low', is_overdue: false, days_overdue: null });
  });

  it('escalates to medium when due within 1 day', () => {
    const now = new Date('2026-01-10T00:00:00Z');
    const result = computeTaskEffectivePriority(
      makeTask({ priority: 'low', due_date: '2026-01-10T12:00:00Z' }),
      now,
    );
    expect(result.effective_priority).toBe('medium');
    expect(result.is_overdue).toBe(false);
  });

  it('does not escalate when due more than 1 day out', () => {
    const now = new Date('2026-01-10T00:00:00Z');
    const result = computeTaskEffectivePriority(
      makeTask({ priority: 'low', due_date: '2026-01-13T00:00:00Z' }),
      now,
    );
    expect(result.effective_priority).toBe('low');
    expect(result.is_overdue).toBe(false);
    expect(result.days_overdue).toBeNull();
  });

  it('escalates to high at 0 days overdue (boundary)', () => {
    const now = new Date('2026-01-10T02:00:00Z');
    const result = computeTaskEffectivePriority(
      makeTask({ priority: 'low', due_date: '2026-01-10T00:00:00Z' }),
      now,
    );
    expect(result.is_overdue).toBe(true);
    expect(result.days_overdue).toBe(0);
    expect(result.effective_priority).toBe('high');
  });

  it('escalates to high at 3 days overdue (upper boundary of the high tier)', () => {
    const now = new Date('2026-01-04T00:00:00Z');
    const result = computeTaskEffectivePriority(
      makeTask({ priority: 'low', due_date: '2026-01-01T00:00:00Z' }),
      now,
    );
    expect(result.days_overdue).toBe(3);
    expect(result.effective_priority).toBe('high');
  });

  it('escalates to critical beyond 3 days overdue', () => {
    const now = new Date('2026-01-05T00:00:01Z');
    const result = computeTaskEffectivePriority(
      makeTask({ priority: 'low', due_date: '2026-01-01T00:00:00Z' }),
      now,
    );
    expect(result.days_overdue).toBeGreaterThan(3);
    expect(result.effective_priority).toBe('critical');
  });

  it('never downgrades below the stored base priority (monotonic escalation)', () => {
    const now = new Date('2026-01-01T00:00:00Z'); // due date far in the future -> low due-date rank
    const result = computeTaskEffectivePriority(
      makeTask({ priority: 'critical', due_date: '2026-06-01T00:00:00Z' }),
      now,
    );
    expect(result.effective_priority).toBe('critical');
  });

  it('a completed task never escalates and is never overdue, regardless of due_date', () => {
    const now = new Date('2026-06-01T00:00:00Z'); // due date 5 months in the past
    const result = computeTaskEffectivePriority(
      makeTask({ priority: 'low', status: 'completed', due_date: '2026-01-01T00:00:00Z' }),
      now,
    );
    expect(result).toEqual({ effective_priority: 'low', is_overdue: false, days_overdue: null });
  });

  it('a cancelled task never escalates and is never overdue, regardless of due_date', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    const result = computeTaskEffectivePriority(
      makeTask({ priority: 'medium', status: 'cancelled', due_date: '2026-01-01T00:00:00Z' }),
      now,
    );
    expect(result).toEqual({ effective_priority: 'medium', is_overdue: false, days_overdue: null });
  });
});

// ── createTask (manual creation) ────────────────────────────────────────

describe('TaskService.createTask', () => {
  it('throws PermissionDeniedError when the caller lacks create_task', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('create_task'),
    );

    await expect(
      TaskService.createTask({ site_id: SITE_ID, title: 'Manual task' }, makeCtx()),
    ).rejects.toThrow(PermissionDeniedError);
    expect(PermissionService.requirePermission).toHaveBeenCalledWith(USER_ID, 'create_task');
  });

  it('throws when neither assigned_to nor assigned_role is supplied', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'requireSiteAccess').mockResolvedValue(undefined);

    await expect(
      TaskService.createTask({ site_id: SITE_ID, title: 'Manual task' }, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('rejects an assignee outside the caller company (validateUserExists throws NotFoundError)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'requireSiteAccess').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'validateUserExists').mockRejectedValue(new NotFoundError('User'));

    await expect(
      TaskService.createTask(
        { site_id: SITE_ID, title: 'Manual task', assigned_to: OTHER_USER_ID },
        makeCtx(),
      ),
    ).rejects.toThrow(NotFoundError);
  });

  it('rejects an assignee with no access to the given site', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'requireSiteAccess').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'validateUserExists').mockResolvedValue({} as never);
    vi.mocked(createAdminSupabaseClient).mockReturnValue(makeAdminClient({ data: false }));

    await expect(
      TaskService.createTask(
        { site_id: SITE_ID, title: 'Manual task', assigned_to: OTHER_USER_ID },
        makeCtx(),
      ),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('creates a role-only task, scoped to the company, with no individual notification', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'requireSiteAccess').mockResolvedValue(undefined);

    const created = makeTask({ assigned_to: null, assigned_role: 'data_entry', status: 'new' });
    const client = makeSupabaseClient(
      { data: created }, // tasks insert
      { data: null }, // task_history insert — session client (migration 032)
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await TaskService.createTask(
      { site_id: SITE_ID, title: 'Manual task', assigned_role: 'data_entry' },
      makeCtx(),
    );

    expect(result.status).toBe('new');
    const fromMock = (client as unknown as { from: ReturnType<typeof vi.fn> }).from;
    expect(fromMock).toHaveBeenCalledWith('tasks');
    const insertArg = (fromMock.mock.results[0]?.value as { insert: ReturnType<typeof vi.fn> })
      .insert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertArg).toMatchObject({
      company_id: COMPANY_ID,
      assigned_role: 'data_entry',
      assigned_to: null,
    });
    expect(NotificationService.dispatch).not.toHaveBeenCalled();
  });

  it('writes the initial task_history row through the session client, not the admin client (migration 032)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'requireSiteAccess').mockResolvedValue(undefined);

    const created = makeTask({ assigned_to: null, assigned_role: 'data_entry', status: 'new' });
    const client = makeSupabaseClient({ data: created }, { data: null });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await TaskService.createTask(
      { site_id: SITE_ID, title: 'Manual task', assigned_role: 'data_entry' },
      makeCtx(),
    );

    const fromMock = (client as unknown as { from: ReturnType<typeof vi.fn> }).from;
    expect(fromMock).toHaveBeenCalledWith('task_history');
    const historyInsertArg = (
      fromMock.mock.results[1]?.value as { insert: ReturnType<typeof vi.fn> }
    ).insert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(historyInsertArg).toMatchObject({ company_id: COMPANY_ID, new_status: 'new' });
    // No admin client needed anywhere in the manual-create path any more.
    expect(createAdminSupabaseClient).not.toHaveBeenCalled();
  });

  it('creates an individually assigned task and dispatches task_assigned', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'requireSiteAccess').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'validateUserExists').mockResolvedValue({} as never);

    const created = makeTask({
      assigned_to: OTHER_USER_ID,
      assigned_role: null,
      status: 'assigned',
    });
    const client = makeSupabaseClient(
      { data: created }, // tasks insert
      { data: null }, // task_history insert — session client
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);
    vi.mocked(createAdminSupabaseClient).mockReturnValue(makeAdminClient({ data: true }));

    await TaskService.createTask(
      { site_id: SITE_ID, title: 'Manual task', assigned_to: OTHER_USER_ID },
      makeCtx(),
    );

    expect(NotificationService.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'task_assigned', recipientUserId: OTHER_USER_ID }),
    );
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'task.created', company_id: COMPANY_ID }),
    );
  });
});

// ── ensureTaskForChartReady (internal, system path) ─────────────────────

describe('TaskService.ensureTaskForChartReady', () => {
  const chart = { id: CHART_ID, company_id: COMPANY_ID, site_id: SITE_ID };
  const taskInput = { title: 'Chart ready for data entry', priority: 'medium' as const };

  it('throws BusinessRuleError on a company mismatch between the chart and the calling context', async () => {
    await expect(
      TaskService.ensureTaskForChartReady(
        { id: CHART_ID, company_id: 'different-company', site_id: SITE_ID },
        taskInput,
        makeCtx(),
      ),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('resolves the active chart_assignments owner as the assignee when valid (company + site both check out)', async () => {
    const inserted = makeTask({ assigned_to: OWNER_ID, assigned_role: null, status: 'assigned' });
    vi.mocked(createAdminSupabaseClient).mockReturnValue(
      makeAdminClient(
        { data: true }, // user_has_site_access
        { data: { assigned_to: OWNER_ID } }, // chart_assignments lookup
        { data: { id: OWNER_ID } }, // profiles lookup
        { data: inserted }, // tasks insert
        { data: null }, // task_history insert
      ),
    );

    const result = await TaskService.ensureTaskForChartReady(chart, taskInput, makeCtx());

    expect(result).toEqual({ taskId: TASK_ID, taskCreated: true });
    expect(AuditService.logWithAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'task.created', record_id: TASK_ID }),
    );
    expect(NotificationService.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'task_assigned', recipientUserId: OWNER_ID }),
    );
  });

  it('falls back to the unclaimed data_entry role queue when the owner is a different company (stale)', async () => {
    const inserted = makeTask({ assigned_to: null, assigned_role: 'data_entry', status: 'new' });
    vi.mocked(createAdminSupabaseClient).mockReturnValue(
      makeAdminClient(
        null,
        { data: { assigned_to: OWNER_ID } }, // chart_assignments lookup
        { data: null }, // profiles lookup — not found in this company => stale
        { data: inserted }, // tasks insert
        { data: null }, // task_history insert
      ),
    );

    const result = await TaskService.ensureTaskForChartReady(chart, taskInput, makeCtx());

    expect(result.taskCreated).toBe(true);
    expect(NotificationService.dispatch).not.toHaveBeenCalled();
  });

  it('falls back to the unclaimed data_entry role queue when the owner has lost site access (stale)', async () => {
    const inserted = makeTask({ assigned_to: null, assigned_role: 'data_entry', status: 'new' });
    vi.mocked(createAdminSupabaseClient).mockReturnValue(
      makeAdminClient(
        { data: false }, // user_has_site_access -> stale
        { data: { assigned_to: OWNER_ID } },
        { data: { id: OWNER_ID } },
        { data: inserted },
        { data: null },
      ),
    );

    const result = await TaskService.ensureTaskForChartReady(chart, taskInput, makeCtx());

    expect(result.taskCreated).toBe(true);
    expect(NotificationService.dispatch).not.toHaveBeenCalled();
  });

  it('falls back to the unclaimed role queue when there is no active chart_assignment at all', async () => {
    const inserted = makeTask({ assigned_to: null, assigned_role: 'data_entry', status: 'new' });
    vi.mocked(createAdminSupabaseClient).mockReturnValue(
      makeAdminClient(
        null,
        { data: null }, // no active assignment
        { data: inserted }, // tasks insert
        { data: null }, // task_history insert
      ),
    );

    const result = await TaskService.ensureTaskForChartReady(chart, taskInput, makeCtx());

    expect(result.taskCreated).toBe(true);
    expect(result.taskId).toBe(TASK_ID);
  });

  it('never mutates or deletes the chart_assignments row itself (only ever reads it)', async () => {
    const inserted = makeTask({ assigned_to: null, assigned_role: 'data_entry', status: 'new' });
    const admin = makeAdminClient(null, { data: null }, { data: inserted }, { data: null });
    vi.mocked(createAdminSupabaseClient).mockReturnValue(admin);

    await TaskService.ensureTaskForChartReady(chart, taskInput, makeCtx());

    const fromMock = (admin as unknown as { from: ReturnType<typeof vi.fn> }).from;
    expect(fromMock).toHaveBeenCalledWith('chart_assignments');
    const chartAssignmentsStub = fromMock.mock.results[0]?.value as {
      update: ReturnType<typeof vi.fn>;
      insert: ReturnType<typeof vi.fn>;
    };
    expect(chartAssignmentsStub.update).not.toHaveBeenCalled();
    expect(chartAssignmentsStub.insert).not.toHaveBeenCalled();
  });

  it('treats a uq_tasks_open_per_source conflict as idempotent — returns the existing open task, creates nothing new', async () => {
    const existing = makeTask({
      id: 'existing-task-uuid',
      status: 'assigned',
      assigned_to: OWNER_ID,
    });
    vi.mocked(createAdminSupabaseClient).mockReturnValue(
      makeAdminClient(
        null,
        { data: null }, // no active chart_assignment
        { data: null, error: { code: '23505', message: 'duplicate key' } }, // tasks insert conflict
        { data: existing }, // re-select of the existing open task
      ),
    );

    const result = await TaskService.ensureTaskForChartReady(chart, taskInput, makeCtx());

    expect(result).toEqual({ taskId: 'existing-task-uuid', taskCreated: false });
    expect(AuditService.logWithAdmin).not.toHaveBeenCalled();
    expect(NotificationService.dispatch).not.toHaveBeenCalled();
  });
});

// ── completeTaskForChart (internal, system path) ────────────────────────

describe('TaskService.completeTaskForChart', () => {
  it('completes the open chart-sourced task, writing history and audit', async () => {
    const openTask = makeTask({ status: 'assigned', assigned_to: OWNER_ID });
    vi.mocked(createAdminSupabaseClient).mockReturnValue(
      makeAdminClient(
        null,
        { data: openTask }, // find open task
        { data: null }, // update
        { data: null }, // history insert
      ),
    );

    await TaskService.completeTaskForChart(CHART_ID, makeCtx());

    expect(AuditService.logWithAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'task.completed', record_id: TASK_ID }),
    );
  });

  it('is a safe no-op when no open task exists for the chart', async () => {
    vi.mocked(createAdminSupabaseClient).mockReturnValue(makeAdminClient(null, { data: null }));

    await expect(TaskService.completeTaskForChart(CHART_ID, makeCtx())).resolves.toBeUndefined();
    expect(AuditService.logWithAdmin).not.toHaveBeenCalled();
  });
});

// ── completeTask ─────────────────────────────────────────────────────────

describe('TaskService.completeTask', () => {
  it('throws PermissionDeniedError when the caller neither holds complete_task nor is the assignee', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: makeTask({ status: 'assigned', assigned_to: OTHER_USER_ID }) }),
    );
    vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(false);

    await expect(TaskService.completeTask(TASK_ID, makeCtx())).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it('rejects even a self-assignee when they lack site access — assignment never bypasses site authorization', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: makeTask({ status: 'assigned', assigned_to: USER_ID }) }),
    );
    vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(false); // no complete_task
    vi.spyOn(PermissionService, 'requireSiteAccess').mockRejectedValue(
      new PermissionDeniedError(`site:${SITE_ID}`),
    );

    await expect(TaskService.completeTask(TASK_ID, makeCtx())).rejects.toThrow(
      PermissionDeniedError,
    );
    expect(PermissionService.requireSiteAccess).toHaveBeenCalledWith(USER_ID, SITE_ID);
  });

  it('allows a self-assignee to complete their own task without complete_task, once site access is confirmed', async () => {
    const task = makeTask({ status: 'assigned', assigned_to: USER_ID });
    const client = makeSupabaseClient(
      { data: task }, // getTaskOrThrow
      { data: { ...task, status: 'completed' } }, // update
      { data: null }, // task_history insert — session client (migration 032)
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);
    vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(false);
    vi.spyOn(PermissionService, 'requireSiteAccess').mockResolvedValue(undefined);

    const result = await TaskService.completeTask(TASK_ID, makeCtx());

    expect(result.status).toBe('completed');
    // Migration 032 closed the task_history_insert gap for the self-
    // assignee path — the history write now goes through the ordinary
    // session client, exactly like every other user-initiated transition.
    // No admin client is used anywhere in this call any more.
    expect(createAdminSupabaseClient).not.toHaveBeenCalled();
    const fromMock = (client as unknown as { from: ReturnType<typeof vi.fn> }).from;
    expect(fromMock).toHaveBeenCalledWith('task_history');
    const historyArg = (fromMock.mock.results[2]?.value as { insert: ReturnType<typeof vi.fn> })
      .insert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(historyArg).toMatchObject({
      task_id: TASK_ID,
      old_status: 'assigned',
      new_status: 'completed',
      changed_by: USER_ID,
    });
  });

  it('an unauthorized caller (no complete_task, not the assignee) cannot gain history-write authority via completeTask', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: makeTask({ status: 'assigned', assigned_to: OTHER_USER_ID }) }),
    );
    vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(false);

    await expect(TaskService.completeTask(TASK_ID, makeCtx())).rejects.toThrow(
      PermissionDeniedError,
    );
    // Rejected before any tasks UPDATE or task_history INSERT is attempted.
    expect(createAdminSupabaseClient).not.toHaveBeenCalled();
  });

  it('allows a holder of complete_task to complete a task not assigned to them, using the session client for history', async () => {
    const task = makeTask({ status: 'assigned', assigned_to: OTHER_USER_ID });
    const client = makeSupabaseClient(
      { data: task },
      { data: { ...task, status: 'completed' } },
      { data: null }, // task_history insert, via the session client
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);
    vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(true);
    vi.spyOn(PermissionService, 'requireSiteAccess').mockResolvedValue(undefined);

    const result = await TaskService.completeTask(TASK_ID, makeCtx());

    expect(result.status).toBe('completed');
    expect(createAdminSupabaseClient).not.toHaveBeenCalled();
  });

  it('throws BusinessRuleError from a terminal source status', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: makeTask({ status: 'cancelled', assigned_to: USER_ID }) }),
    );
    vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(true);
    vi.spyOn(PermissionService, 'requireSiteAccess').mockResolvedValue(undefined);

    await expect(TaskService.completeTask(TASK_ID, makeCtx())).rejects.toThrow(BusinessRuleError);
  });
});

// ── cancelTask ───────────────────────────────────────────────────────────

describe('TaskService.cancelTask', () => {
  it('throws BusinessRuleError when the caller lacks cancel_task, even with a reason', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: makeTask({ status: 'assigned' }) }),
    );
    vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(false);

    await expect(
      TaskService.cancelTask(TASK_ID, { reason: 'No longer needed' }, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('throws BusinessRuleError when the caller holds cancel_task but supplies a blank reason', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: makeTask({ status: 'assigned' }) }),
    );
    vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(true);

    await expect(TaskService.cancelTask(TASK_ID, { reason: '   ' }, makeCtx())).rejects.toThrow(
      BusinessRuleError,
    );
  });

  it('throws BusinessRuleError for an already-terminal task', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: makeTask({ status: 'completed' }) }),
    );
    vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(true);
    vi.spyOn(PermissionService, 'requireSiteAccess').mockResolvedValue(undefined);

    await expect(
      TaskService.cancelTask(TASK_ID, { reason: 'Duplicate' }, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('cancels a non-terminal task when authorized, recording the reason in history and audit', async () => {
    const task = makeTask({ status: 'assigned' });
    const client = makeSupabaseClient(
      { data: task },
      { data: { ...task, status: 'cancelled' } },
      { data: null },
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);
    vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(true);
    vi.spyOn(PermissionService, 'requireSiteAccess').mockResolvedValue(undefined);

    const result = await TaskService.cancelTask(TASK_ID, { reason: 'Duplicate task' }, makeCtx());

    expect(result.status).toBe('cancelled');
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'task.cancelled',
        new_value: expect.objectContaining({ status: 'cancelled', reason: 'Duplicate task' }),
      }),
    );
  });

  it('a cancelled task is never treated as overdue afterward', () => {
    const result = computeTaskEffectivePriority(
      makeTask({ status: 'cancelled', due_date: '2020-01-01T00:00:00Z', priority: 'critical' }),
    );
    expect(result.is_overdue).toBe(false);
    expect(result.days_overdue).toBeNull();
  });
});

// ── reassignTask ─────────────────────────────────────────────────────────

describe('TaskService.reassignTask', () => {
  it('throws PermissionDeniedError when the caller lacks assign_task', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('assign_task'),
    );

    await expect(
      TaskService.reassignTask(TASK_ID, { assigned_to: OTHER_USER_ID }, makeCtx()),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it('rejects reassigning to a user outside the company', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: makeTask({ status: 'new' }) }),
    );
    vi.spyOn(PermissionService, 'requireSiteAccess').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'validateUserExists').mockRejectedValue(new NotFoundError('User'));

    await expect(
      TaskService.reassignTask(TASK_ID, { assigned_to: OTHER_USER_ID }, makeCtx()),
    ).rejects.toThrow(NotFoundError);
  });

  it('rejects reassigning to a user without access to the task site', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: makeTask({ status: 'new' }) }),
    );
    vi.spyOn(PermissionService, 'requireSiteAccess').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'validateUserExists').mockResolvedValue({} as never);
    vi.mocked(createAdminSupabaseClient).mockReturnValue(makeAdminClient({ data: false }));

    await expect(
      TaskService.reassignTask(TASK_ID, { assigned_to: OTHER_USER_ID }, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('throws BusinessRuleError for an already-terminal task', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: makeTask({ status: 'completed' }) }),
    );
    vi.spyOn(PermissionService, 'requireSiteAccess').mockResolvedValue(undefined);

    await expect(
      TaskService.reassignTask(TASK_ID, { assigned_to: OTHER_USER_ID }, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('reassigns a "new" task to "assigned", clears assigned_role, notifies, and never touches chart_assignments', async () => {
    const task = makeTask({ status: 'new', assigned_to: null, assigned_role: 'data_entry' });
    const client = makeSupabaseClient(
      { data: task },
      { data: { ...task, assigned_to: OTHER_USER_ID, assigned_role: null, status: 'assigned' } },
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'requireSiteAccess').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'validateUserExists').mockResolvedValue({} as never);
    vi.mocked(createAdminSupabaseClient).mockReturnValue(makeAdminClient({ data: true }));

    const result = await TaskService.reassignTask(
      TASK_ID,
      { assigned_to: OTHER_USER_ID },
      makeCtx(),
    );

    expect(result.status).toBe('assigned');
    expect(result.assigned_to).toBe(OTHER_USER_ID);
    const fromCalls = (client as unknown as { from: ReturnType<typeof vi.fn> }).from.mock.calls;
    expect(fromCalls.some((c) => c[0] === 'chart_assignments')).toBe(false);
    expect(NotificationService.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'task_assigned', recipientUserId: OTHER_USER_ID }),
    );
  });

  // migration 035: the task_history row for a reassignment (same-status
  // when status doesn't change) is now written automatically by the DB's
  // record_task_reassignment_history AFTER UPDATE trigger — a direct,
  // non-TaskService assigned_to/assigned_role change can never silently
  // skip the ledger that way. TaskService itself must NOT also insert one,
  // or every reassignment would produce two history rows for the same
  // event; the live trigger behavior is proven in the Milestone 5 live
  // security regression reports, not here (this suite mocks the Supabase
  // client, so it has no trigger to exercise).
  it('does not insert task_history itself when reassigning (the DB trigger owns that write)', async () => {
    const task = makeTask({ status: 'assigned', assigned_to: OWNER_ID });
    const client = makeSupabaseClient(
      { data: task },
      { data: { ...task, assigned_to: OTHER_USER_ID } },
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'requireSiteAccess').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'validateUserExists').mockResolvedValue({} as never);
    vi.mocked(createAdminSupabaseClient).mockReturnValue(makeAdminClient({ data: true }));

    await TaskService.reassignTask(TASK_ID, { assigned_to: OTHER_USER_ID }, makeCtx());

    const fromCalls = (client as unknown as { from: ReturnType<typeof vi.fn> }).from.mock.calls;
    expect(fromCalls.some((c) => c[0] === 'task_history')).toBe(false);
  });
});

// ── addComment / getComments ─────────────────────────────────────────────

describe('TaskService.addComment', () => {
  it('throws PermissionDeniedError when the caller lacks comment_task', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('comment_task'),
    );

    await expect(
      TaskService.addComment(TASK_ID, { comment: 'Needs review' }, makeCtx()),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it('throws NotFoundError when the task does not exist / is out of company scope', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createAdminSupabaseClient).mockReturnValue(makeAdminClient(null, { data: null }));

    await expect(
      TaskService.addComment(TASK_ID, { comment: 'Needs review' }, makeCtx()),
    ).rejects.toThrow(NotFoundError);
  });

  it('adds a comment scoped to the task and company, writing an audit log', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createAdminSupabaseClient).mockReturnValue(
      makeAdminClient(null, { data: makeTask() }),
    );
    const insertedComment = {
      id: 'comment-uuid',
      company_id: COMPANY_ID,
      task_id: TASK_ID,
      comment: 'Needs review',
      created_by: USER_ID,
      created_at: '2026-01-05T00:00:00Z',
    };
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: insertedComment }),
    );

    const result = await TaskService.addComment(TASK_ID, { comment: 'Needs review' }, makeCtx());

    expect(result).toEqual(insertedComment);
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'task.commented',
        company_id: COMPANY_ID,
        record_id: TASK_ID,
        new_value: { comment_id: 'comment-uuid' },
      }),
    );
  });
});

describe('TaskService.getComments', () => {
  it('returns comments scoped to the task and company, newest first', async () => {
    const comments = [
      {
        id: 'c2',
        company_id: COMPANY_ID,
        task_id: TASK_ID,
        comment: 'Second',
        created_by: USER_ID,
        created_at: '2026-01-06T00:00:00Z',
      },
      {
        id: 'c1',
        company_id: COMPANY_ID,
        task_id: TASK_ID,
        comment: 'First',
        created_by: USER_ID,
        created_at: '2026-01-05T00:00:00Z',
      },
    ];
    const client = makeSupabaseClient(
      { data: makeTask() }, // getTaskOrThrow
      { data: comments },
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await TaskService.getComments(TASK_ID, makeCtx());

    expect(result).toEqual(comments);
  });
});

// ── getHistory ───────────────────────────────────────────────────────────

describe('TaskService.getHistory', () => {
  it('returns history rows scoped to the task and company, most recent first', async () => {
    const rows = [
      {
        id: 'h2',
        company_id: COMPANY_ID,
        task_id: TASK_ID,
        old_status: 'new',
        new_status: 'assigned',
        changed_by: USER_ID,
        changed_at: '2026-01-02T00:00:00Z',
        reason: null,
      },
      {
        id: 'h1',
        company_id: COMPANY_ID,
        task_id: TASK_ID,
        old_status: null,
        new_status: 'new',
        changed_by: USER_ID,
        changed_at: '2026-01-01T00:00:00Z',
        reason: null,
      },
    ];
    const client = makeSupabaseClient({ data: makeTask() }, { data: rows });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await TaskService.getHistory(TASK_ID, makeCtx());

    expect(result).toEqual(rows);
  });

  it('throws NotFoundError for a task outside company scope', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(makeSupabaseClient({ data: null }));

    await expect(TaskService.getHistory(TASK_ID, makeCtx())).rejects.toThrow(NotFoundError);
  });
});

// ── listTasks / getMyToday (reads, isolation, sorting) ──────────────────

describe('TaskService.listTasks', () => {
  it('throws PermissionDeniedError when the caller lacks view_tasks', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('view_tasks'),
    );

    await expect(TaskService.listTasks({}, makeCtx())).rejects.toThrow(PermissionDeniedError);
  });

  it('scopes the query to company_id plus every supplied filter', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeSupabaseClient({ data: [] });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await TaskService.listTasks(
      { site_id: SITE_ID, status: 'assigned', assigned_to: USER_ID },
      makeCtx(),
    );

    const stub = (client as unknown as { from: ReturnType<typeof vi.fn> }).from.mock.results[0]
      ?.value as { eq: ReturnType<typeof vi.fn> };
    expect(stub.eq).toHaveBeenCalledWith('company_id', COMPANY_ID);
    expect(stub.eq).toHaveBeenCalledWith('site_id', SITE_ID);
    expect(stub.eq).toHaveBeenCalledWith('status', 'assigned');
    expect(stub.eq).toHaveBeenCalledWith('assigned_to', USER_ID);
  });

  it('sorts by effective priority descending, then days overdue descending, then created_at ascending', async () => {
    const now = new Date('2026-01-10T00:00:00Z');
    vi.useFakeTimers().setSystemTime(now);
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const low = makeTask({
      id: 'low',
      priority: 'low',
      due_date: null,
      created_at: '2026-01-01T00:00:00Z',
    });
    const criticalOld = makeTask({
      id: 'critical-old',
      priority: 'critical',
      due_date: null,
      created_at: '2026-01-02T00:00:00Z',
    });
    const criticalNew = makeTask({
      id: 'critical-new',
      priority: 'critical',
      due_date: null,
      created_at: '2026-01-03T00:00:00Z',
    });
    const client = makeSupabaseClient({ data: [low, criticalNew, criticalOld] });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await TaskService.listTasks({}, makeCtx());

    expect(result.data.map((t) => t.id)).toEqual(['critical-old', 'critical-new', 'low']);
    vi.useRealTimers();
  });

  it('filters by the computed effective priority, not a stored column', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeSupabaseClient({
      data: [
        makeTask({ id: 'low', priority: 'low', due_date: null }),
        makeTask({ id: 'critical', priority: 'critical', due_date: null }),
      ],
    });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await TaskService.listTasks({ priority: 'critical' }, makeCtx());

    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.id).toBe('critical');
    const stub = (client as unknown as { from: ReturnType<typeof vi.fn> }).from.mock.results[0]
      ?.value as { eq: ReturnType<typeof vi.fn> };
    expect(stub.eq).not.toHaveBeenCalledWith('priority', 'critical');
  });
});

describe('TaskService.getMyToday', () => {
  it('does not require view_tasks — scoped to the caller as assignee via RLS', async () => {
    const client = makeSupabaseClient({
      data: [makeTask({ assigned_to: USER_ID, status: 'assigned' })],
    });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await TaskService.getMyToday(makeCtx());

    expect(result).toHaveLength(1);
    const stub = (client as unknown as { from: ReturnType<typeof vi.fn> }).from.mock.results[0]
      ?.value as { eq: ReturnType<typeof vi.fn> };
    expect(stub.eq).toHaveBeenCalledWith('company_id', COMPANY_ID);
    expect(stub.eq).toHaveBeenCalledWith('assigned_to', USER_ID);
  });
});

// ── getTaskById read model (Milestone 5.0 detail consistency) ─────────────

describe('TaskService.getTaskById — read-time operational fields', () => {
  const NOW = new Date('2026-01-15T00:00:00Z');

  beforeEach(() => {
    vi.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns effective_priority, is_overdue and days_overdue, escalating an overdue task via the existing computation', async () => {
    const task = makeTask({
      status: 'assigned',
      priority: 'medium',
      due_date: '2026-01-10T00:00:00Z', // 5 days overdue -> critical
    });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(makeSupabaseClient({ data: task }));

    const result = await TaskService.getTaskById(TASK_ID, makeCtx());

    expect(result).toMatchObject({
      id: TASK_ID,
      priority: 'medium', // stored base is preserved, not overwritten
      effective_priority: 'critical',
      is_overdue: true,
      days_overdue: 5,
    });
    // Exactly the same computation the list endpoints use.
    expect(result).toEqual({ ...task, ...computeTaskEffectivePriority(task, NOW) });
  });

  it('returns the same operational fields as listTasks for the same task', async () => {
    const task = makeTask({ status: 'new', priority: 'low', due_date: '2026-01-14T00:00:00Z' });
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(makeSupabaseClient({ data: [task] }));
    const listed = (await TaskService.listTasks({}, makeCtx())).data[0]!;

    vi.mocked(createServerSupabaseClient).mockResolvedValue(makeSupabaseClient({ data: task }));
    const detail = await TaskService.getTaskById(TASK_ID, makeCtx());

    expect(detail.effective_priority).toBe(listed.effective_priority);
    expect(detail.is_overdue).toBe(listed.is_overdue);
    expect(detail.days_overdue).toBe(listed.days_overdue);
  });

  it('a not-yet-due task is not overdue', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({
        data: makeTask({ priority: 'medium', due_date: '2026-01-30T00:00:00Z' }),
      }),
    );
    const result = await TaskService.getTaskById(TASK_ID, makeCtx());
    expect(result).toMatchObject({
      effective_priority: 'medium',
      is_overdue: false,
      days_overdue: null,
    });
  });

  it.each(['completed', 'cancelled'] as const)(
    'a %s task is never overdue and keeps its base priority (terminal semantics)',
    async (status) => {
      vi.mocked(createServerSupabaseClient).mockResolvedValue(
        makeSupabaseClient({
          data: makeTask({ status, priority: 'low', due_date: '2025-12-01T00:00:00Z' }),
        }),
      );
      const result = await TaskService.getTaskById(TASK_ID, makeCtx());
      expect(result).toMatchObject({
        effective_priority: 'low',
        is_overdue: false,
        days_overdue: null,
      });
    },
  );

  it('authorization is unchanged: company-scoped lookup, NotFound when RLS/company hides the row, no enrichment on failure', async () => {
    const client = makeSupabaseClient({ data: null });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);
    const permSpy = vi.spyOn(PermissionService, 'requirePermission');

    await expect(TaskService.getTaskById(TASK_ID, makeCtx())).rejects.toThrow(NotFoundError);

    const stub = (client as unknown as { from: ReturnType<typeof vi.fn> }).from.mock.results[0]
      ?.value as { eq: ReturnType<typeof vi.fn> };
    expect(stub.eq).toHaveBeenCalledWith('company_id', COMPANY_ID);
    // Still no up-front view_tasks requirement (RLS + assignee carve-out).
    expect(permSpy).not.toHaveBeenCalled();
  });
});

// ── Company/site isolation (cross-cutting) ───────────────────────────────

describe('company/site isolation', () => {
  it('getTaskById scopes strictly to company_id and returns NotFoundError otherwise', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(makeSupabaseClient({ data: null }));

    await expect(TaskService.getTaskById(TASK_ID, makeCtx())).rejects.toThrow(NotFoundError);
  });

  it('completeTask always re-checks site access even for a task the caller can otherwise see', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({
        data: makeTask({ status: 'assigned', site_id: OTHER_SITE_ID, assigned_to: USER_ID }),
      }),
    );
    vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(true);
    const requireSiteAccessSpy = vi
      .spyOn(PermissionService, 'requireSiteAccess')
      .mockRejectedValue(new PermissionDeniedError(`site:${OTHER_SITE_ID}`));

    await expect(TaskService.completeTask(TASK_ID, makeCtx())).rejects.toThrow(
      PermissionDeniedError,
    );
    expect(requireSiteAccessSpy).toHaveBeenCalledWith(USER_ID, OTHER_SITE_ID);
  });
});
