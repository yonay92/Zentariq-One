import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@/lib/supabase/admin';
import {
  ChartService,
  isValidChartTransition,
  computeChartAging,
} from '@/services/charts/ChartService';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import { TaskService } from '@/services/tasks/TaskService';
import { logger } from '@/lib/logger';
import { PermissionDeniedError, BusinessRuleError, NotFoundError } from '@/lib/api/errors';
import type { Chart } from '@/types/charts';

vi.mock('@/services/audit/AuditService', () => ({
  AuditService: { log: vi.fn() },
}));

// Milestone 5.0 integration: TaskService is mocked wholesale so its own
// internal Supabase calls never compete with ChartService's own from()
// response queues below — these tests verify ChartService calls TaskService
// with the right arguments and handles its failures correctly, not
// TaskService's own internals (that's TaskService.test.ts's job).
vi.mock('@/services/tasks/TaskService', () => ({
  TaskService: { ensureTaskForChartReady: vi.fn(), completeTaskForChart: vi.fn() },
}));

const COMPANY_ID = 'company-uuid';
const SITE_ID = 'site-uuid';
const STUDY_ID = 'study-uuid';
const SUBJECT_ID = 'subject-uuid';
const VISIT_ID = 'visit-uuid';
const CHART_ID = 'chart-uuid';
const USER_ID = 'user-uuid';

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

function makeChart(overrides: Partial<Chart> = {}): Chart {
  return {
    id: CHART_ID,
    company_id: COMPANY_ID,
    site_id: SITE_ID,
    study_id: STUDY_ID,
    subject_id: SUBJECT_ID,
    visit_id: VISIT_ID,
    chart_ready_date: '2026-01-01T00:00:00Z',
    entered_in_edc_date: null,
    entered_by: null,
    entered_by_role: null,
    days_until_entry: null,
    priority: 'low',
    status: 'chart_ready',
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
    // Milestone 4.1 listCharts' batched enrichment queries (visits/subjects/
    // studies/sites) filter with .in(...) — chainable like eq, resolves via
    // the same thenable as the rest of this stub.
    in: vi.fn().mockReturnThis(),
    // getChartHistory orders by changed_at — chainable, terminal via the
    // same thenable as the rest of this stub.
    order: vi.fn().mockReturnThis(),
    // Milestone 4.3 upsertChartMetrics' "first in_progress" chart_history
    // lookup chains .order(...).limit(1).maybeSingle() — chainable like
    // order, resolves via the same thenable/maybeSingle as the rest of this
    // stub.
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
  for (const key of ['select', 'eq', 'in', 'order', 'limit', 'insert', 'update', 'upsert']) {
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

function makeRpcClient(
  rpcResult: { data: unknown; error?: unknown },
  ...fromResponses: Array<{ data: unknown; error?: unknown }>
) {
  const from = vi.fn();
  for (const r of fromResponses) {
    from.mockReturnValueOnce(queryStub(r.data, r.error ?? null));
  }
  const rpc = vi.fn().mockResolvedValue({ data: rpcResult.data, error: rpcResult.error ?? null });
  return { from, rpc } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: TaskService integration succeeds silently. Tests that care
  // about its exact call arguments or failure handling override this.
  vi.mocked(TaskService.ensureTaskForChartReady).mockResolvedValue({
    taskId: 'task-uuid',
    taskCreated: true,
  });
  vi.mocked(TaskService.completeTaskForChart).mockResolvedValue(undefined);
});

// ── Pure functions ───────────────────────────────────────────────────────

describe('isValidChartTransition', () => {
  it('allows the documented forward transitions', () => {
    expect(isValidChartTransition('chart_ready', 'in_progress')).toBe(true);
    expect(isValidChartTransition('chart_ready', 'on_hold')).toBe(true);
    expect(isValidChartTransition('on_hold', 'chart_ready')).toBe(true);
    expect(isValidChartTransition('in_progress', 'on_hold')).toBe(true);
    expect(isValidChartTransition('in_progress', 'entered_in_edc')).toBe(true);
  });

  it('rejects transitions not in the approved state machine, including out of entered_in_edc', () => {
    expect(isValidChartTransition('chart_ready', 'entered_in_edc')).toBe(false);
    expect(isValidChartTransition('entered_in_edc', 'chart_ready')).toBe(false);
    expect(isValidChartTransition('entered_in_edc', 'on_hold')).toBe(false);
    expect(isValidChartTransition('on_hold', 'entered_in_edc')).toBe(false);
    expect(isValidChartTransition('chart_ready', 'chart_ready')).toBe(false);
    // entered_in_edc -> in_progress is NOT a generic transition — it only
    // exists via the dedicated, permission+reason-gated reopenChart action
    // (tested separately below), never via startDataEntry's generic check.
    expect(isValidChartTransition('entered_in_edc', 'in_progress')).toBe(false);
  });
});

describe('computeChartAging', () => {
  it('returns low priority and null aging for an entered_in_edc chart', () => {
    const result = computeChartAging(makeChart({ status: 'entered_in_edc' }));
    expect(result).toEqual({ days_since_ready: null, effective_priority: 'low' });
  });

  it('returns low priority for a chart ready less than 1 day ago', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    const result = computeChartAging(makeChart({ chart_ready_date: '2026-01-01T00:00:00Z' }), {
      now,
    });
    expect(result.effective_priority).toBe('low');
  });

  it('returns medium priority at 1-3 days overdue', () => {
    const now = new Date('2026-01-03T00:00:00Z');
    const result = computeChartAging(makeChart({ chart_ready_date: '2026-01-01T00:00:00Z' }), {
      now,
    });
    expect(result.days_since_ready).toBe(2);
    expect(result.effective_priority).toBe('medium');
  });

  it('returns high priority at 4-7 days overdue', () => {
    const now = new Date('2026-01-06T00:00:00Z');
    const result = computeChartAging(makeChart({ chart_ready_date: '2026-01-01T00:00:00Z' }), {
      now,
    });
    expect(result.days_since_ready).toBe(5);
    expect(result.effective_priority).toBe('high');
  });

  it('returns critical priority beyond 7 days overdue', () => {
    const now = new Date('2026-01-10T00:00:00Z');
    const result = computeChartAging(makeChart({ chart_ready_date: '2026-01-01T00:00:00Z' }), {
      now,
    });
    expect(result.effective_priority).toBe('critical');
  });

  it('escalates to critical immediately when out of window, regardless of age', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    const result = computeChartAging(makeChart({ chart_ready_date: '2026-01-01T00:00:00Z' }), {
      now,
      isOutOfWindow: true,
    });
    expect(result.effective_priority).toBe('critical');
  });

  it('escalates to critical immediately when a sponsor visit is approaching', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    const result = computeChartAging(makeChart({ chart_ready_date: '2026-01-01T00:00:00Z' }), {
      now,
      sponsorVisitApproaching: true,
    });
    expect(result.effective_priority).toBe('critical');
  });
});

// ── ensureChartForCompletedVisit (Decision 1: atomicity) ────────────────────

describe('ChartService.ensureChartForCompletedVisit', () => {
  it('calls complete_visit_with_chart with the expected arguments', async () => {
    const client = makeRpcClient(
      {
        data: {
          visit: { id: VISIT_ID, status: 'completed' },
          chart_id: CHART_ID,
          chart_created: true,
          already_completed: false,
        },
      },
      { data: null }, // chart_history insert (chart_created = true)
      { data: { status: 'completed' } }, // upsertChartMetrics: visits select
      { data: null }, // upsertChartMetrics: chart_history select (first in_progress)
      { data: null }, // upsertChartMetrics: chart_metrics upsert
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await ChartService.ensureChartForCompletedVisit(VISIT_ID, SUBJECT_ID, 'completed', makeCtx());

    const rpcMock = (client as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc;
    expect(rpcMock).toHaveBeenCalledWith('complete_visit_with_chart', {
      p_visit_id: VISIT_ID,
      p_subject_id: SUBJECT_ID,
      p_company_id: COMPANY_ID,
      p_new_status: 'completed',
    });
  });

  it('writes chart_history and an audit log when a new chart is created', async () => {
    const client = makeRpcClient(
      {
        data: {
          visit: { id: VISIT_ID, site_id: SITE_ID, status: 'completed' },
          chart_id: CHART_ID,
          chart_created: true,
          already_completed: false,
        },
      },
      { data: null }, // chart_history insert
      { data: { status: 'completed' } }, // upsertChartMetrics: visits select
      { data: null }, // upsertChartMetrics: chart_history select (first in_progress)
      { data: null }, // upsertChartMetrics: chart_metrics upsert
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await ChartService.ensureChartForCompletedVisit(
      VISIT_ID,
      SUBJECT_ID,
      'completed',
      makeCtx(),
    );

    expect(result).toEqual({
      visit: { id: VISIT_ID, site_id: SITE_ID, status: 'completed' },
      chartId: CHART_ID,
      chartCreated: true,
    });
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'chart.created', record_id: CHART_ID }),
    );
  });

  // ── Milestone 5.0 — TaskService integration ────────────────────────────

  it('invokes TaskService.ensureTaskForChartReady exactly once, with the correct chart, title, priority, and due date', async () => {
    const now = new Date('2026-01-05T10:00:00Z');
    vi.useFakeTimers().setSystemTime(now);

    const client = makeRpcClient(
      {
        data: {
          visit: { id: VISIT_ID, site_id: SITE_ID, visit_name: 'Visit 3', status: 'completed' },
          chart_id: CHART_ID,
          chart_created: true,
          already_completed: false,
        },
      },
      { data: null },
      { data: { status: 'completed' } },
      { data: null },
      { data: null },
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await ChartService.ensureChartForCompletedVisit(VISIT_ID, SUBJECT_ID, 'completed', makeCtx());

    expect(TaskService.ensureTaskForChartReady).toHaveBeenCalledTimes(1);
    expect(TaskService.ensureTaskForChartReady).toHaveBeenCalledWith(
      { id: CHART_ID, company_id: COMPANY_ID, site_id: SITE_ID },
      {
        title: 'Chart ready for entry: Visit 3',
        priority: 'low', // 0 days since ready, not out of window
        due_date: new Date(now.getTime() + 3 * 86_400_000).toISOString(),
      },
      expect.objectContaining({ company: expect.objectContaining({ id: COMPANY_ID }) }),
    );
    vi.useRealTimers();
  });

  it('passes priority "critical" for an out-of-window visit completion, reusing computeChartAging (no second priority algorithm)', async () => {
    const client = makeRpcClient(
      {
        data: {
          visit: {
            id: VISIT_ID,
            site_id: SITE_ID,
            visit_name: 'Visit 3',
            status: 'out_of_window',
          },
          chart_id: CHART_ID,
          chart_created: true,
          already_completed: false,
        },
      },
      { data: null },
      { data: { status: 'out_of_window' } },
      { data: null },
      { data: null },
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await ChartService.ensureChartForCompletedVisit(
      VISIT_ID,
      SUBJECT_ID,
      'out_of_window',
      makeCtx(),
    );

    expect(TaskService.ensureTaskForChartReady).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ priority: 'critical' }),
      expect.anything(),
    );
  });

  it('does NOT write chart_history/audit again on an idempotent retry, and does NOT re-invoke TaskService', async () => {
    const client = makeRpcClient({
      data: {
        visit: { id: VISIT_ID, status: 'completed' },
        chart_id: CHART_ID,
        chart_created: false,
        already_completed: true,
      },
    });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await ChartService.ensureChartForCompletedVisit(
      VISIT_ID,
      SUBJECT_ID,
      'completed',
      makeCtx(),
    );

    expect(result.chartCreated).toBe(false);
    expect(AuditService.log).not.toHaveBeenCalled();
    expect(TaskService.ensureTaskForChartReady).not.toHaveBeenCalled();
  });

  it('chart creation still succeeds and returns normally when TaskService.ensureTaskForChartReady throws (logged, not propagated)', async () => {
    const client = makeRpcClient(
      {
        data: {
          visit: { id: VISIT_ID, site_id: SITE_ID, visit_name: 'Visit 3', status: 'completed' },
          chart_id: CHART_ID,
          chart_created: true,
          already_completed: false,
        },
      },
      { data: null },
      { data: { status: 'completed' } },
      { data: null },
      { data: null },
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);
    vi.mocked(TaskService.ensureTaskForChartReady).mockRejectedValue(new Error('db unavailable'));
    const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    const result = await ChartService.ensureChartForCompletedVisit(
      VISIT_ID,
      SUBJECT_ID,
      'completed',
      makeCtx(),
    );

    // The chart mutation itself is the primary workflow — it already
    // committed via the RPC before TaskService is ever called, and its
    // success here is completely unaffected by the task-side failure.
    expect(result.chartCreated).toBe(true);
    expect(result.chartId).toBe(CHART_ID);
    // Chart-side audit trail is unaffected.
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'chart.created' }),
    );
    // The failure is not silently dropped — it is logged for observability.
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      'ChartService.ensureChartForCompletedVisit: task creation failed',
      expect.objectContaining({ chartId: CHART_ID, error: 'db unavailable' }),
    );
  });

  it('delegates task creation to TaskService entirely — ChartService never queries/writes tasks or task_history directly', async () => {
    const client = makeRpcClient(
      {
        data: {
          visit: { id: VISIT_ID, site_id: SITE_ID, visit_name: 'Visit 3', status: 'completed' },
          chart_id: CHART_ID,
          chart_created: true,
          already_completed: false,
        },
      },
      { data: null },
      { data: { status: 'completed' } },
      { data: null },
      { data: null },
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await ChartService.ensureChartForCompletedVisit(VISIT_ID, SUBJECT_ID, 'completed', makeCtx());

    const fromCalls = (client as unknown as { from: ReturnType<typeof vi.fn> }).from.mock.calls;
    expect(fromCalls.some((c) => c[0] === 'tasks' || c[0] === 'task_history')).toBe(false);
  });

  it('maps a VISIT_STATE_CONFLICT RPC error to BusinessRuleError (concurrent completion race)', async () => {
    const client = makeRpcClient({
      data: null,
      error: {
        message: 'VISIT_STATE_CONFLICT: visit is not In Progress (current status: completed)',
      },
    });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      ChartService.ensureChartForCompletedVisit(VISIT_ID, SUBJECT_ID, 'completed', makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('maps a VISIT_NOT_FOUND RPC error to NotFoundError', async () => {
    const client = makeRpcClient({
      data: null,
      error: { message: 'VISIT_NOT_FOUND: visit visit-uuid not found or not accessible' },
    });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      ChartService.ensureChartForCompletedVisit(VISIT_ID, SUBJECT_ID, 'completed', makeCtx()),
    ).rejects.toThrow(NotFoundError);
  });

  it('maps a VISIT_OWNERSHIP_MISMATCH RPC error to NotFoundError', async () => {
    const client = makeRpcClient({
      data: null,
      error: {
        message:
          'VISIT_OWNERSHIP_MISMATCH: visit visit-uuid does not belong to the given subject/company',
      },
    });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      ChartService.ensureChartForCompletedVisit(VISIT_ID, SUBJECT_ID, 'completed', makeCtx()),
    ).rejects.toThrow(NotFoundError);
  });
});

// ── Reads ────────────────────────────────────────────────────────────────

describe('ChartService.getChartByVisitId / getChartById', () => {
  it('throws PermissionDeniedError when the caller lacks view_charts', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('view_charts'),
    );

    await expect(ChartService.getChartByVisitId(VISIT_ID, makeCtx())).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it('getChartByVisitId returns null when no chart exists for the visit', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(makeSupabaseClient({ data: null }));

    const result = await ChartService.getChartByVisitId(VISIT_ID, makeCtx());
    expect(result).toBeNull();
  });

  it('getChartById throws NotFoundError for a chart in a different company', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(makeSupabaseClient({ data: null }));

    await expect(ChartService.getChartById(CHART_ID, makeCtx())).rejects.toThrow(NotFoundError);
  });
});

// ── Lifecycle transitions ───────────────────────────────────────────────

describe('ChartService.startDataEntry', () => {
  it('throws PermissionDeniedError when the caller lacks mark_chart_ready', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('mark_chart_ready'),
    );

    await expect(ChartService.startDataEntry(CHART_ID, makeCtx())).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it('throws BusinessRuleError from an invalid source status (entered_in_edc)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: makeChart({ status: 'entered_in_edc' }) }),
    );

    await expect(ChartService.startDataEntry(CHART_ID, makeCtx())).rejects.toThrow(
      BusinessRuleError,
    );
  });

  it('transitions chart_ready -> in_progress and writes chart_history/audit', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const chart = makeChart({ status: 'chart_ready' });
    const updated = { ...chart, status: 'in_progress' };
    const client = makeSupabaseClient(
      { data: chart }, // getChartOrThrow
      { data: updated }, // charts update
      { data: null }, // chart_history insert
      { data: { status: 'completed' } }, // upsertChartMetrics: visits select
      { data: null }, // upsertChartMetrics: chart_history select (first in_progress)
      { data: null }, // upsertChartMetrics: chart_metrics upsert
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await ChartService.startDataEntry(CHART_ID, makeCtx());

    expect(result.status).toBe('in_progress');
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'chart.entry_started', record_id: CHART_ID }),
    );
  });
});

describe('ChartService.markEnteredInEdc', () => {
  it('throws BusinessRuleError from an invalid source status (chart_ready)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: makeChart({ status: 'chart_ready' }) }),
    );

    await expect(
      ChartService.markEnteredInEdc(CHART_ID, { entered_by_role: 'data_entry' }, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('transitions in_progress -> entered_in_edc, recording entered_by/entered_by_role/entered_in_edc_date', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const chart = makeChart({ status: 'in_progress' });
    const updated = { ...chart, status: 'entered_in_edc', entered_by: USER_ID };
    const client = makeSupabaseClient(
      { data: chart }, // getChartOrThrow
      { data: updated }, // charts update
      { data: null }, // chart_history insert
      { data: { status: 'completed' } }, // upsertChartMetrics: visits select
      { data: { changed_at: '2026-01-02T00:00:00Z' } }, // upsertChartMetrics: chart_history select (first in_progress)
      { data: null }, // upsertChartMetrics: chart_metrics upsert
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await ChartService.markEnteredInEdc(
      CHART_ID,
      { entered_by_role: 'data_entry' },
      makeCtx(),
    );

    expect(result.status).toBe('entered_in_edc');
    const updateStub = (client as unknown as { from: ReturnType<typeof vi.fn> }).from.mock
      .results[1]?.value as { update: ReturnType<typeof vi.fn> };
    const updateArg = updateStub.update.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(updateArg.entered_by).toBe(USER_ID);
    expect(updateArg.entered_by_role).toBe('data_entry');
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'chart.entered', record_id: CHART_ID }),
    );
    // Milestone 5.0 — the corresponding Data-Entry task is completed via
    // TaskService, which owns locating/completing/history/audit for it —
    // ChartService only supplies the chart id and context.
    expect(TaskService.completeTaskForChart).toHaveBeenCalledWith(CHART_ID, expect.anything());
  });

  // ── Milestone 5.0 — TaskService integration ────────────────────────────

  it('chart entered_in_edc still succeeds when TaskService.completeTaskForChart throws (logged, not propagated)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const chart = makeChart({ status: 'in_progress' });
    const updated = { ...chart, status: 'entered_in_edc', entered_by: USER_ID };
    const client = makeSupabaseClient(
      { data: chart },
      { data: updated },
      { data: null },
      { data: { status: 'completed' } },
      { data: { changed_at: '2026-01-02T00:00:00Z' } },
      { data: null },
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);
    vi.mocked(TaskService.completeTaskForChart).mockRejectedValue(new Error('db unavailable'));
    const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    const result = await ChartService.markEnteredInEdc(
      CHART_ID,
      { entered_by_role: 'data_entry' },
      makeCtx(),
    );

    // The chart's own transition already committed and is unaffected by
    // the task-completion failure.
    expect(result.status).toBe('entered_in_edc');
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'chart.entered' }),
    );
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      'ChartService.markEnteredInEdc: task completion failed',
      expect.objectContaining({ chartId: CHART_ID, error: 'db unavailable' }),
    );
  });

  it('relies entirely on TaskService.completeTaskForChart for the safe no-op when no open task exists — no duplicate query/update logic in ChartService', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const chart = makeChart({ status: 'in_progress' });
    const updated = { ...chart, status: 'entered_in_edc', entered_by: USER_ID };
    const client = makeSupabaseClient(
      { data: chart },
      { data: updated },
      { data: null },
      { data: { status: 'completed' } },
      { data: null },
      { data: null },
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);
    // TaskService's own safe no-op contract (verified independently in
    // TaskService.test.ts) — here we only assert ChartService delegates to
    // it and does not itself query/update tasks or task_history.
    vi.mocked(TaskService.completeTaskForChart).mockResolvedValue(undefined);

    const result = await ChartService.markEnteredInEdc(
      CHART_ID,
      { entered_by_role: 'data_entry' },
      makeCtx(),
    );

    expect(result.status).toBe('entered_in_edc');
    expect(TaskService.completeTaskForChart).toHaveBeenCalledTimes(1);
    const fromCalls = (client as unknown as { from: ReturnType<typeof vi.fn> }).from.mock.calls;
    expect(fromCalls.some((c) => c[0] === 'tasks' || c[0] === 'task_history')).toBe(false);
  });
});

// ── Immutability + authorized correction (Decision 2, RULE C) ─────────────

describe('ChartService.reopenChart', () => {
  it('throws BusinessRuleError when the chart is not Entered in EDC', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: makeChart({ status: 'in_progress' }) }),
    );

    await expect(
      ChartService.reopenChart(CHART_ID, { reason: 'Correction needed' }, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('throws BusinessRuleError when the caller lacks reopen_chart, even with a reason', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: makeChart({ status: 'entered_in_edc' }) }),
    );
    vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(false);

    await expect(
      ChartService.reopenChart(CHART_ID, { reason: 'Correction needed' }, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('throws BusinessRuleError when the caller has reopen_chart but no reason', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: makeChart({ status: 'entered_in_edc' }) }),
    );
    vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(true);

    await expect(ChartService.reopenChart(CHART_ID, { reason: '' }, makeCtx())).rejects.toThrow(
      BusinessRuleError,
    );
  });

  it('reopens an Entered-in-EDC chart back to in_progress when authorized, recording reason/actor/timestamp', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(true);

    const chart = makeChart({ status: 'entered_in_edc', entered_by: 'other-user' });
    const updated = { ...chart, status: 'in_progress' };
    const client = makeSupabaseClient(
      { data: chart }, // getChartOrThrow
      { data: updated }, // charts update
      { data: null }, // chart_history insert
      { data: { status: 'completed' } }, // upsertChartMetrics: visits select
      { data: { changed_at: '2026-01-02T00:00:00Z' } }, // upsertChartMetrics: chart_history select (first in_progress)
      { data: null }, // upsertChartMetrics: chart_metrics upsert
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await ChartService.reopenChart(
      CHART_ID,
      { reason: 'Correction needed — wrong value entered' },
      makeCtx(),
    );

    expect(result.status).toBe('in_progress');

    const historyStub = (client as unknown as { from: ReturnType<typeof vi.fn> }).from.mock
      .results[2]?.value as { insert: ReturnType<typeof vi.fn> };
    const historyArg = historyStub.insert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(historyArg).toMatchObject({
      chart_id: CHART_ID,
      old_status: 'entered_in_edc',
      new_status: 'in_progress',
      changed_by: USER_ID,
      reason: 'Correction needed — wrong value entered',
    });

    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'chart.reopened',
        record_id: CHART_ID,
        old_value: { status: 'entered_in_edc' },
        new_value: expect.objectContaining({
          status: 'in_progress',
          reason: 'Correction needed — wrong value entered',
        }),
      }),
    );
  });
});

// ── addComment / getComments (Milestone 4.3 — Chart Comments) ──────────────

describe('ChartService.addComment', () => {
  it('throws PermissionDeniedError when the caller lacks comment_chart', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('comment_chart'),
    );

    await expect(
      ChartService.addComment(CHART_ID, { comment: 'Needs review' }, makeCtx()),
    ).rejects.toThrow(PermissionDeniedError);

    // R3: the permission check itself must be for comment_chart, never a
    // substitute — proves the gate is the dedicated permission, not one of
    // view_charts/mark_chart_ready/mark_chart_entered/reopen_chart.
    expect(PermissionService.requirePermission).toHaveBeenCalledWith(USER_ID, 'comment_chart');
  });

  it('throws NotFoundError when the chart does not exist / is out of company scope', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createAdminSupabaseClient).mockReturnValue(makeSupabaseClient({ data: null }));

    await expect(
      ChartService.addComment(CHART_ID, { comment: 'Needs review' }, makeCtx()),
    ).rejects.toThrow(NotFoundError);
  });

  it('adds a comment on an entered_in_edc (locked) chart without requiring reopen_chart (R4)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createAdminSupabaseClient).mockReturnValue(
      makeSupabaseClient({ data: makeChart({ status: 'entered_in_edc' }) }),
    );
    const insertedComment = {
      id: 'comment-uuid',
      company_id: COMPANY_ID,
      chart_id: CHART_ID,
      comment: 'Needs review',
      created_by: USER_ID,
      created_at: '2026-01-05T00:00:00Z',
    };
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: insertedComment }),
    );

    const result = await ChartService.addComment(CHART_ID, { comment: 'Needs review' }, makeCtx());

    expect(result).toEqual(insertedComment);
    // guardDangerousOperation / hasPermission('reopen_chart') must never be
    // consulted for a comment — proves comments are independent of the
    // chart-lock gate.
    expect(PermissionService.requirePermission).not.toHaveBeenCalledWith(USER_ID, 'reopen_chart');
  });

  it('writes an audit log entry for the comment, scoped to the chart and company', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createAdminSupabaseClient).mockReturnValue(makeSupabaseClient({ data: makeChart() }));
    const insertedComment = {
      id: 'comment-uuid',
      company_id: COMPANY_ID,
      chart_id: CHART_ID,
      comment: 'Needs review',
      created_by: USER_ID,
      created_at: '2026-01-05T00:00:00Z',
    };
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: insertedComment }),
    );

    await ChartService.addComment(CHART_ID, { comment: 'Needs review' }, makeCtx());

    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: COMPANY_ID,
        site_id: SITE_ID,
        user_id: USER_ID,
        action: 'chart.commented',
        module: 'charts',
        record_type: 'chart',
        record_id: CHART_ID,
        new_value: { comment_id: 'comment-uuid' },
      }),
    );
  });
});

describe('ChartService.getComments', () => {
  it('rejects a caller without view_charts', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('view_charts'),
    );

    await expect(ChartService.getComments(CHART_ID, makeCtx())).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it('returns comments scoped to the chart and company, newest first', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const comments = [
      {
        id: 'c2',
        company_id: COMPANY_ID,
        chart_id: CHART_ID,
        comment: 'Second',
        created_by: USER_ID,
        created_at: '2026-01-06T00:00:00Z',
      },
      {
        id: 'c1',
        company_id: COMPANY_ID,
        chart_id: CHART_ID,
        comment: 'First',
        created_by: USER_ID,
        created_at: '2026-01-05T00:00:00Z',
      },
    ];
    const client = makeSupabaseClient(
      { data: makeChart() }, // getChartOrThrow
      { data: comments }, // chart_comments select
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await ChartService.getComments(CHART_ID, makeCtx());

    expect(result).toEqual(comments);
  });
});

// ── chart_metrics recalculation (Milestone 4.3, R5 — upsert semantics) ─────

describe('ChartService chart_metrics recalculation', () => {
  it('markEnteredInEdc computes ready_to_entry_hours and total_entry_hours from chart_ready_date, the first in_progress transition, and entered_in_edc_date', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const chart = makeChart({
      status: 'in_progress',
      chart_ready_date: '2026-01-01T00:00:00Z',
    });
    const updated = {
      ...chart,
      status: 'entered_in_edc',
      entered_by: USER_ID,
      entered_in_edc_date: '2026-01-03T12:00:00Z', // 60 hours after chart_ready_date
    };
    const client = makeSupabaseClient(
      { data: chart }, // getChartOrThrow
      { data: updated }, // charts update
      { data: null }, // chart_history insert
      { data: { status: 'chart_ready' } }, // upsertChartMetrics: visits select
      { data: { changed_at: '2026-01-01T06:00:00Z' } }, // upsertChartMetrics: first in_progress — 6 hours after ready
      { data: null }, // upsertChartMetrics: chart_metrics upsert
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await ChartService.markEnteredInEdc(CHART_ID, { entered_by_role: 'data_entry' }, makeCtx());

    const metricsStub = (client as unknown as { from: ReturnType<typeof vi.fn> }).from.mock
      .results[5]?.value as { upsert: ReturnType<typeof vi.fn> };
    const upsertArg = metricsStub.upsert.mock.calls[0]?.[0] as Record<string, unknown>;
    const upsertOpts = metricsStub.upsert.mock.calls[0]?.[1] as Record<string, unknown>;

    expect(upsertArg).toMatchObject({
      company_id: COMPANY_ID,
      chart_id: CHART_ID,
      ready_to_entry_hours: 6,
      total_entry_hours: 60,
      out_of_window: false,
      sponsor_priority: false,
    });
    expect(upsertOpts).toEqual({ onConflict: 'chart_id' });
  });

  it('marks out_of_window true and reflects it in the recalculated metrics row', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const chart = makeChart({ status: 'chart_ready', chart_ready_date: '2026-01-01T00:00:00Z' });
    const updated = { ...chart, status: 'in_progress' };
    const client = makeSupabaseClient(
      { data: chart }, // getChartOrThrow
      { data: updated }, // charts update
      { data: null }, // chart_history insert
      { data: { status: 'out_of_window' } }, // upsertChartMetrics: visits select
      { data: null }, // upsertChartMetrics: first in_progress (none yet)
      { data: null }, // upsertChartMetrics: chart_metrics upsert
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await ChartService.startDataEntry(CHART_ID, makeCtx());

    const metricsStub = (client as unknown as { from: ReturnType<typeof vi.fn> }).from.mock
      .results[5]?.value as { upsert: ReturnType<typeof vi.fn> };
    const upsertArg = metricsStub.upsert.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(upsertArg).toMatchObject({ out_of_window: true, ready_to_entry_hours: null });
  });
});

describe('ChartService.getMetrics', () => {
  it('rejects a caller without view_charts', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('view_charts'),
    );

    await expect(ChartService.getMetrics(CHART_ID, makeCtx())).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it('throws NotFoundError when no metrics row exists yet for the chart', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeSupabaseClient(
      { data: makeChart() }, // getChartOrThrow
      { data: null }, // chart_metrics select — not found
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(ChartService.getMetrics(CHART_ID, makeCtx())).rejects.toThrow(NotFoundError);
  });

  it('returns the current metrics row scoped to the chart and company', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const metrics = {
      id: 'metrics-uuid',
      company_id: COMPANY_ID,
      chart_id: CHART_ID,
      ready_to_entry_hours: 6,
      total_entry_hours: 60,
      overdue_days: 0,
      out_of_window: false,
      sponsor_priority: false,
      calculated_at: '2026-01-03T12:00:00Z',
    };
    const client = makeSupabaseClient(
      { data: makeChart() }, // getChartOrThrow
      { data: metrics }, // chart_metrics select
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await ChartService.getMetrics(CHART_ID, makeCtx());

    expect(result).toEqual(metrics);
  });
});

// ── getChartHistory (Milestone 4.1 — Chart Detail workspace) ────────────────

describe('ChartService.getChartHistory', () => {
  it('rejects a caller without view_charts', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('view_charts'),
    );

    await expect(ChartService.getChartHistory(CHART_ID, makeCtx())).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it('throws NotFoundError when the chart does not exist / is out of scope', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(makeSupabaseClient({ data: null }));

    await expect(ChartService.getChartHistory(CHART_ID, makeCtx())).rejects.toThrow(NotFoundError);
  });

  it('returns history rows scoped to the chart and company, most recent first', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const historyRows = [
      {
        id: 'h2',
        company_id: COMPANY_ID,
        chart_id: CHART_ID,
        old_status: 'in_progress',
        new_status: 'entered_in_edc',
        changed_by: USER_ID,
        changed_at: '2026-01-05T00:00:00Z',
        reason: null,
      },
      {
        id: 'h1',
        company_id: COMPANY_ID,
        chart_id: CHART_ID,
        old_status: null,
        new_status: 'chart_ready',
        changed_by: USER_ID,
        changed_at: '2026-01-01T00:00:00Z',
        reason: null,
      },
    ];
    const client = makeSupabaseClient(
      { data: makeChart() }, // getChartOrThrow
      { data: historyRows }, // chart_history select
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await ChartService.getChartHistory(CHART_ID, makeCtx());

    expect(result).toEqual(historyRows);
    const historyStub = (client as unknown as { from: ReturnType<typeof vi.fn> }).from.mock
      .results[1]?.value as { eq: ReturnType<typeof vi.fn> };
    expect(historyStub.eq).toHaveBeenCalledWith('chart_id', CHART_ID);
    expect(historyStub.eq).toHaveBeenCalledWith('company_id', COMPANY_ID);
  });
});

// ── listCharts (Milestone 4.1 — Chart Queue / Subject Profile Charts tab) ───

function makeVisitRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: VISIT_ID,
    visit_name: 'Visit 2',
    target_date: '2026-01-01',
    scheduled_date: '2026-01-01',
    status: 'completed',
    ...overrides,
  };
}

describe('ChartService.listCharts', () => {
  it('rejects a caller without view_charts', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('view_charts'),
    );

    await expect(ChartService.listCharts({}, makeCtx())).rejects.toThrow(PermissionDeniedError);
  });

  it('returns an empty, zero-total page without any enrichment queries when no charts match', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeSupabaseClient({ data: [] });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await ChartService.listCharts({}, makeCtx());

    expect(result).toEqual({ data: [], total: 0, page: 1, page_size: 25 });
    // Only the base charts query — no visits/subjects/studies/sites lookups.
    expect((client as unknown as { from: ReturnType<typeof vi.fn> }).from).toHaveBeenCalledTimes(1);
  });

  it('scopes the base query to company_id plus every supplied filter', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeSupabaseClient(
      { data: [] }, // no charts match — short-circuits before enrichment
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await ChartService.listCharts(
      { site_id: SITE_ID, study_id: STUDY_ID, subject_id: SUBJECT_ID, status: 'chart_ready' },
      makeCtx(),
    );

    const chartsStub = (client as unknown as { from: ReturnType<typeof vi.fn> }).from.mock
      .results[0]?.value as { eq: ReturnType<typeof vi.fn> };
    expect(chartsStub.eq).toHaveBeenCalledWith('company_id', COMPANY_ID);
    expect(chartsStub.eq).toHaveBeenCalledWith('site_id', SITE_ID);
    expect(chartsStub.eq).toHaveBeenCalledWith('study_id', STUDY_ID);
    expect(chartsStub.eq).toHaveBeenCalledWith('subject_id', SUBJECT_ID);
    expect(chartsStub.eq).toHaveBeenCalledWith('status', 'chart_ready');
  });

  it('never sends priority to the DB query — it is a computed field, filtered after the fact', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeSupabaseClient({ data: [] });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await ChartService.listCharts({ priority: 'critical' }, makeCtx());

    const chartsStub = (client as unknown as { from: ReturnType<typeof vi.fn> }).from.mock
      .results[0]?.value as { eq: ReturnType<typeof vi.fn> };
    expect(chartsStub.eq).not.toHaveBeenCalledWith('priority', 'critical');
  });

  it('enriches rows with subject/study/site/visit display fields and computed aging', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const now = new Date('2026-01-10T00:00:00Z');
    vi.useFakeTimers().setSystemTime(now);

    const chart = makeChart({ chart_ready_date: '2026-01-01T00:00:00Z' });
    const client = makeSupabaseClient(
      { data: [chart] }, // charts
      { data: [makeVisitRow({ status: 'completed' })] }, // visits
      { data: [{ id: SUBJECT_ID, subject_number: 'S-001' }] }, // subjects
      { data: [{ id: STUDY_ID, study_name: 'ACME Trial' }] }, // studies
      { data: [{ id: SITE_ID, name: 'Main Site' }] }, // sites
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await ChartService.listCharts({}, makeCtx());

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      subject_number: 'S-001',
      study_name: 'ACME Trial',
      site_name: 'Main Site',
      visit_name: 'Visit 2',
      is_out_of_window: false,
      effective_priority: 'critical', // >7 days overdue at 2026-01-10
    });
    vi.useRealTimers();
  });

  it('marks a chart critical when its visit is out_of_window, independent of days pending', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const now = new Date('2026-01-01T12:00:00Z');
    vi.useFakeTimers().setSystemTime(now);

    const chart = makeChart({ chart_ready_date: '2026-01-01T00:00:00Z' });
    const client = makeSupabaseClient(
      { data: [chart] },
      { data: [makeVisitRow({ status: 'out_of_window' })] },
      { data: [{ id: SUBJECT_ID, subject_number: 'S-001' }] },
      { data: [{ id: STUDY_ID, study_name: 'ACME Trial' }] },
      { data: [{ id: SITE_ID, name: 'Main Site' }] },
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await ChartService.listCharts({}, makeCtx());

    expect(result.data[0]).toMatchObject({
      is_out_of_window: true,
      effective_priority: 'critical',
    });
    vi.useRealTimers();
  });

  it('filters by the computed priority tier after enrichment', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const now = new Date('2026-01-01T12:00:00Z');
    vi.useFakeTimers().setSystemTime(now);

    const lowChart = makeChart({ id: 'chart-low', chart_ready_date: '2026-01-01T00:00:00Z' });
    const criticalChart = makeChart({ id: 'chart-critical', visit_id: 'visit-2' });
    const client = makeSupabaseClient(
      { data: [lowChart, criticalChart] },
      {
        data: [
          makeVisitRow({ status: 'completed' }),
          makeVisitRow({ id: 'visit-2', status: 'out_of_window' }),
        ],
      },
      { data: [{ id: SUBJECT_ID, subject_number: 'S-001' }] },
      { data: [{ id: STUDY_ID, study_name: 'ACME Trial' }] },
      { data: [{ id: SITE_ID, name: 'Main Site' }] },
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await ChartService.listCharts({ priority: 'critical' }, makeCtx());

    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.id).toBe('chart-critical');
    expect(result.total).toBe(1);
    vi.useRealTimers();
  });

  it('sorts critical charts before low-priority ones, then paginates', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const now = new Date('2026-01-01T12:00:00Z');
    vi.useFakeTimers().setSystemTime(now);

    const lowChart = makeChart({ id: 'chart-low', chart_ready_date: '2026-01-01T00:00:00Z' });
    const criticalChart = makeChart({ id: 'chart-critical', visit_id: 'visit-2' });
    const client = makeSupabaseClient(
      { data: [lowChart, criticalChart] },
      {
        data: [
          makeVisitRow({ status: 'completed' }),
          makeVisitRow({ id: 'visit-2', status: 'out_of_window' }),
        ],
      },
      { data: [{ id: SUBJECT_ID, subject_number: 'S-001' }] },
      { data: [{ id: STUDY_ID, study_name: 'ACME Trial' }] },
      { data: [{ id: SITE_ID, name: 'Main Site' }] },
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await ChartService.listCharts({ page: 1, page_size: 1 }, makeCtx());

    expect(result.total).toBe(2);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.id).toBe('chart-critical');
  });
});
// ── Milestone 5.0 — Task reconciliation (explicit service-level recovery) ──

describe('ChartService.reconcileReadyChartTask', () => {
  let loggerErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'requireSiteAccess').mockResolvedValue(undefined);
    loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  function readyClient(visit: { visit_name: string; status: string } | null = null) {
    return makeSupabaseClient(
      { data: makeChart({ chart_ready_date: '2026-01-01T00:00:00Z' }) },
      { data: visit ?? { visit_name: 'Visit 3', status: 'completed' } },
    );
  }

  it('invokes ensureTaskForChartReady with the chart context, original chart_ready_date + 3 days, and current effective priority', async () => {
    // 5 full days after chart_ready_date -> 'high'; due date stays anchored
    // to the ORIGINAL ready date, not reconciliation time.
    vi.useFakeTimers().setSystemTime(new Date('2026-01-06T12:00:00Z'));
    vi.mocked(createServerSupabaseClient).mockResolvedValue(readyClient());

    const result = await ChartService.reconcileReadyChartTask(CHART_ID, makeCtx());

    expect(result).toEqual({ taskId: 'task-uuid', taskCreated: true });
    expect(TaskService.ensureTaskForChartReady).toHaveBeenCalledTimes(1);
    expect(TaskService.ensureTaskForChartReady).toHaveBeenCalledWith(
      { id: CHART_ID, company_id: COMPANY_ID, site_id: SITE_ID },
      {
        title: 'Chart ready for entry: Visit 3',
        priority: 'high',
        due_date: '2026-01-04T00:00:00.000Z',
      },
      expect.objectContaining({
        company: expect.objectContaining({ id: COMPANY_ID }),
      }),
    );
    vi.useRealTimers();
  });

  it('uses critical priority for an out-of-window visit', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-01-01T06:00:00Z'));
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      readyClient({ visit_name: 'Visit 3', status: 'out_of_window' }),
    );

    await ChartService.reconcileReadyChartTask(CHART_ID, makeCtx());

    expect(TaskService.ensureTaskForChartReady).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ priority: 'critical' }),
      expect.anything(),
    );
    vi.useRealTimers();
  });

  it('is safe when an open task already exists (idempotent result from TaskService)', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(readyClient());
    vi.mocked(TaskService.ensureTaskForChartReady).mockResolvedValue({
      taskId: 'existing-task',
      taskCreated: false,
    });

    await expect(ChartService.reconcileReadyChartTask(CHART_ID, makeCtx())).resolves.toEqual({
      taskId: 'existing-task',
      taskCreated: false,
    });
  });

  it('rejects a chart from another company (lookup is company-scoped)', async () => {
    const client = makeSupabaseClient({ data: null });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(ChartService.reconcileReadyChartTask(CHART_ID, makeCtx())).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const chartsQuery = (client as unknown as { from: ReturnType<typeof vi.fn> }).from.mock
      .results[0]?.value as { eq: ReturnType<typeof vi.fn> };
    expect(chartsQuery.eq).toHaveBeenCalledWith('company_id', COMPANY_ID);
    expect(TaskService.ensureTaskForChartReady).not.toHaveBeenCalled();
  });

  it('rejects an inaccessible site', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(readyClient());
    vi.spyOn(PermissionService, 'requireSiteAccess').mockRejectedValue(
      new PermissionDeniedError(`site:${SITE_ID}`),
    );

    await expect(ChartService.reconcileReadyChartTask(CHART_ID, makeCtx())).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    expect(PermissionService.requireSiteAccess).toHaveBeenCalledWith(USER_ID, SITE_ID);
    expect(TaskService.ensureTaskForChartReady).not.toHaveBeenCalled();
  });

  it.each(['in_progress', 'on_hold', 'entered_in_edc'] as const)(
    'rejects a chart in %s status',
    async (status) => {
      vi.mocked(createServerSupabaseClient).mockResolvedValue(
        makeSupabaseClient({ data: makeChart({ status }) }),
      );

      await expect(
        ChartService.reconcileReadyChartTask(CHART_ID, makeCtx()),
      ).rejects.toBeInstanceOf(BusinessRuleError);
      expect(TaskService.ensureTaskForChartReady).not.toHaveBeenCalled();
    },
  );

  it('rejects a caller without mark_chart_ready', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('mark_chart_ready'),
    );

    await expect(ChartService.reconcileReadyChartTask(CHART_ID, makeCtx())).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    expect(TaskService.ensureTaskForChartReady).not.toHaveBeenCalled();
  });

  it('surfaces a TaskService failure to the caller (not swallowed or logged-only)', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(readyClient());
    vi.mocked(TaskService.ensureTaskForChartReady).mockRejectedValue(new Error('db unavailable'));

    await expect(ChartService.reconcileReadyChartTask(CHART_ID, makeCtx())).rejects.toThrow(
      'db unavailable',
    );
    expect(loggerErrorSpy).not.toHaveBeenCalled();
  });
});

describe('ChartService.reconcileEnteredChartTask', () => {
  let loggerErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'requireSiteAccess').mockResolvedValue(undefined);
    loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  const enteredChart = () =>
    makeChart({
      status: 'entered_in_edc',
      entered_in_edc_date: '2026-01-03T00:00:00Z',
    });

  it('invokes completeTaskForChart without modifying the chart', async () => {
    const client = makeSupabaseClient({ data: enteredChart() });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await ChartService.reconcileEnteredChartTask(CHART_ID, makeCtx());

    expect(TaskService.completeTaskForChart).toHaveBeenCalledTimes(1);
    expect(TaskService.completeTaskForChart).toHaveBeenCalledWith(CHART_ID, expect.anything());
    // Only the chart lookup — no update/insert against charts or history.
    expect((client as unknown as { from: ReturnType<typeof vi.fn> }).from).toHaveBeenCalledTimes(1);
    expect(AuditService.log).not.toHaveBeenCalled();
  });

  it('is safe when no open task exists (TaskService safe no-op contract)', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: enteredChart() }),
    );
    vi.mocked(TaskService.completeTaskForChart).mockResolvedValue(undefined);

    await expect(
      ChartService.reconcileEnteredChartTask(CHART_ID, makeCtx()),
    ).resolves.toBeUndefined();
  });

  it('rejects a chart from another company', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(makeSupabaseClient({ data: null }));

    await expect(
      ChartService.reconcileEnteredChartTask(CHART_ID, makeCtx()),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(TaskService.completeTaskForChart).not.toHaveBeenCalled();
  });

  it('rejects an inaccessible site', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: enteredChart() }),
    );
    vi.spyOn(PermissionService, 'requireSiteAccess').mockRejectedValue(
      new PermissionDeniedError(`site:${SITE_ID}`),
    );

    await expect(
      ChartService.reconcileEnteredChartTask(CHART_ID, makeCtx()),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(TaskService.completeTaskForChart).not.toHaveBeenCalled();
  });

  it.each(['chart_ready', 'in_progress', 'on_hold'] as const)(
    'rejects a chart in %s status',
    async (status) => {
      vi.mocked(createServerSupabaseClient).mockResolvedValue(
        makeSupabaseClient({ data: makeChart({ status }) }),
      );

      await expect(
        ChartService.reconcileEnteredChartTask(CHART_ID, makeCtx()),
      ).rejects.toBeInstanceOf(BusinessRuleError);
      expect(TaskService.completeTaskForChart).not.toHaveBeenCalled();
    },
  );

  it('surfaces a TaskService failure to the caller', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: enteredChart() }),
    );
    vi.mocked(TaskService.completeTaskForChart).mockRejectedValue(new Error('db unavailable'));

    await expect(ChartService.reconcileEnteredChartTask(CHART_ID, makeCtx())).rejects.toThrow(
      'db unavailable',
    );
    expect(loggerErrorSpy).not.toHaveBeenCalled();
  });
});
