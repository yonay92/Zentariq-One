import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import {
  ChartService,
  isValidChartTransition,
  computeChartAging,
} from '@/services/charts/ChartService';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import { PermissionDeniedError, BusinessRuleError, NotFoundError } from '@/lib/api/errors';
import type { Chart } from '@/types/charts';

vi.mock('@/services/audit/AuditService', () => ({
  AuditService: { log: vi.fn() },
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
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
    single: vi.fn().mockResolvedValue({ data, error }),
    then: resolved.then.bind(resolved),
    catch: resolved.catch.bind(resolved),
    finally: resolved.finally.bind(resolved),
  };
  for (const key of ['select', 'eq', 'in', 'order', 'insert', 'update']) {
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

  it('does NOT write chart_history/audit again on an idempotent retry (chart already existed)', async () => {
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
