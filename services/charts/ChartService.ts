import { createServerSupabaseClient } from '@/lib/supabase/server';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import { NotFoundError, DatabaseError, BusinessRuleError } from '@/lib/api/errors';
import type {
  Chart,
  ChartStatus,
  ChartAging,
  MarkEnteredInEdcInput,
  ReopenChartInput,
} from '@/types/charts';
import type { Visit, VisitStatus } from '@/types/subjects';
import type { RequestContext } from '@/types/api';

const CHART_COLUMNS =
  'id, company_id, site_id, study_id, subject_id, visit_id, chart_ready_date, entered_in_edc_date, entered_by, entered_by_role, days_until_entry, priority, status, created_at, updated_at';

// The state machine approved in Phase B (docs/BUSINESS_RULES_05_Charts_DataEntry.md
// + docs/DATABASE_Part_04's exact status vocabulary — no additional states
// invented for UI convenience). Keyed by "from" status, valued by the set of
// valid "to" statuses. RLS (migration 026, charts_update) independently
// enforces that ENTERED_IN_EDC rows are untouchable without reopen_chart.
//
// entered_in_edc has NO outgoing edge in this table, deliberately: the only
// way out of it is the dedicated, permission+reason-gated reopenChart action
// below, which checks chart.status directly rather than consulting this
// table. Routing it through the generic table would let startDataEntry
// (chart_ready -> in_progress) accidentally also treat entered_in_edc as a
// valid "in_progress" source, since both share the same target status —
// exactly the ambiguity a dedicated, non-generic reopen path avoids.
const VALID_CHART_TRANSITIONS: Record<ChartStatus, ChartStatus[]> = {
  chart_ready: ['in_progress', 'on_hold'],
  on_hold: ['chart_ready'],
  in_progress: ['on_hold', 'entered_in_edc'],
  entered_in_edc: [],
};

export function isValidChartTransition(from: ChartStatus, to: ChartStatus): boolean {
  return VALID_CHART_TRANSITIONS[from]?.includes(to) ?? false;
}

// Decision 3: compute-on-read, no persisted/scheduled aging. Pure function —
// no I/O, no dependency on wall-clock beyond the injectable `now` (defaults
// to the real current time). isOutOfWindow / sponsorVisitApproaching are
// supplied by the caller (resolved from the owning Visit / Calendar context,
// which this function deliberately does not fetch itself) rather than joined
// here, keeping the priority MATH pure and independently testable.
export function computeChartAging(
  chart: Pick<Chart, 'status' | 'chart_ready_date'>,
  options: { isOutOfWindow?: boolean; sponsorVisitApproaching?: boolean; now?: Date } = {},
): ChartAging {
  const now = options.now ?? new Date();

  if (!chart.chart_ready_date || chart.status === 'entered_in_edc') {
    return { days_since_ready: null, effective_priority: 'low' };
  }

  const readyDate = new Date(chart.chart_ready_date);
  const daysSinceReady = Math.max(
    0,
    Math.floor((now.getTime() - readyDate.getTime()) / 86_400_000),
  );

  // BUSINESS_RULES_05_Charts_DataEntry.md "Priority Rules" — exact thresholds.
  if (options.sponsorVisitApproaching || options.isOutOfWindow || daysSinceReady > 7) {
    return { days_since_ready: daysSinceReady, effective_priority: 'critical' };
  }
  if (daysSinceReady >= 4) {
    return { days_since_ready: daysSinceReady, effective_priority: 'high' };
  }
  if (daysSinceReady >= 1) {
    return { days_since_ready: daysSinceReady, effective_priority: 'medium' };
  }
  return { days_since_ready: daysSinceReady, effective_priority: 'low' };
}

async function getChartOrThrow(chartId: string, ctx: RequestContext): Promise<Chart> {
  await PermissionService.requirePermission(ctx.user.id, 'view_charts');

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from('charts')
    .select(CHART_COLUMNS)
    .eq('id', chartId)
    .eq('company_id', ctx.company.id)
    .single();

  if (error || !data) throw new NotFoundError('Chart');
  return data as Chart;
}

async function writeChartTransition(
  chart: Chart,
  newStatus: ChartStatus,
  ctx: RequestContext,
  options: { reason?: string | null; auditAction: string; extraFields?: Record<string, unknown> },
): Promise<Chart> {
  const supabase = await createServerSupabaseClient();

  const { data: updated, error } = await supabase
    .from('charts')
    .update({ status: newStatus, ...(options.extraFields ?? {}) })
    .eq('id', chart.id)
    .eq('company_id', ctx.company.id)
    .select(CHART_COLUMNS)
    .single();

  if (error || !updated) throw new DatabaseError(error?.message ?? 'Failed to update chart');

  await supabase.from('chart_history').insert({
    company_id: ctx.company.id,
    chart_id: chart.id,
    old_status: chart.status,
    new_status: newStatus,
    changed_by: ctx.user.id,
    reason: options.reason ?? null,
  });

  await AuditService.log({
    company_id: ctx.company.id,
    site_id: chart.site_id,
    user_id: ctx.user.id,
    action: options.auditAction,
    module: 'charts',
    record_type: 'charts',
    record_id: chart.id,
    old_value: { status: chart.status },
    new_value: { status: newStatus, reason: options.reason ?? null },
  });

  return updated as Chart;
}

// Maps the atomic RPC's distinguishable error prefixes (migration 026,
// complete_visit_with_chart) back to this codebase's normal AppError family,
// so callers see the exact same error shape regardless of whether the
// failure came from a plain guard check or the DB-level race-safe recheck.
function mapCompleteVisitRpcError(message: string): never {
  if (message.startsWith('VISIT_NOT_FOUND') || message.startsWith('VISIT_OWNERSHIP_MISMATCH')) {
    throw new NotFoundError('Visit');
  }
  if (message.startsWith('VISIT_STATE_CONFLICT')) {
    throw new BusinessRuleError(
      'This visit was already completed by another request. Please refresh and try again.',
    );
  }
  throw new DatabaseError(message);
}

export const ChartService = {
  isValidChartTransition,
  computeChartAging,

  // Called by SubjectService.completeVisit / completeBaselineVisit at the
  // exact point each transitions a visit into 'completed' or 'out_of_window'.
  // Wraps the atomic complete_visit_with_chart RPC (migration 026) — the
  // Decision-1-approved mechanism guaranteeing "no completed visit without
  // its chart." The caller's own edit_subject permission check (already
  // performed before this is called) remains the authoritative application
  // gate; RLS on visits/charts remains the live enforcement boundary inside
  // the RPC, unchanged by this call.
  async ensureChartForCompletedVisit(
    visitId: string,
    subjectId: string,
    newStatus: Extract<VisitStatus, 'completed' | 'out_of_window'>,
    ctx: RequestContext,
  ): Promise<{ visit: Visit; chartId: string; chartCreated: boolean }> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.rpc('complete_visit_with_chart', {
      p_visit_id: visitId,
      p_subject_id: subjectId,
      p_company_id: ctx.company.id,
      p_new_status: newStatus,
    });

    if (error) mapCompleteVisitRpcError(error.message);
    if (!data) throw new DatabaseError('complete_visit_with_chart returned no data');

    const result = data as {
      visit: Visit;
      chart_id: string;
      chart_created: boolean;
      already_completed: boolean;
    };

    // Only the FIRST successful completion writes chart_history/audit for
    // the chart's creation — a retried/idempotent no-op call must not
    // fabricate a second "chart.created" event for a chart that already
    // existed before this call even started.
    if (result.chart_created) {
      await supabase.from('chart_history').insert({
        company_id: ctx.company.id,
        chart_id: result.chart_id,
        old_status: null,
        new_status: 'chart_ready',
        changed_by: ctx.user.id,
        reason: null,
      });

      await AuditService.log({
        company_id: ctx.company.id,
        site_id: result.visit.site_id,
        user_id: ctx.user.id,
        action: 'chart.created',
        module: 'charts',
        record_type: 'charts',
        record_id: result.chart_id,
        new_value: { status: 'chart_ready', visit_id: visitId },
      });
    }

    return { visit: result.visit, chartId: result.chart_id, chartCreated: result.chart_created };
  },

  async getChartByVisitId(visitId: string, ctx: RequestContext): Promise<Chart | null> {
    await PermissionService.requirePermission(ctx.user.id, 'view_charts');

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('charts')
      .select(CHART_COLUMNS)
      .eq('visit_id', visitId)
      .eq('company_id', ctx.company.id)
      .maybeSingle();

    if (error) throw new DatabaseError(error.message);
    return (data as Chart) ?? null;
  },

  async getChartById(chartId: string, ctx: RequestContext): Promise<Chart> {
    return getChartOrThrow(chartId, ctx);
  },

  async startDataEntry(chartId: string, ctx: RequestContext): Promise<Chart> {
    await PermissionService.requirePermission(ctx.user.id, 'mark_chart_ready');

    const chart = await getChartOrThrow(chartId, ctx);
    if (!isValidChartTransition(chart.status, 'in_progress')) {
      throw new BusinessRuleError(`A chart in "${chart.status}" status cannot begin data entry.`);
    }

    return writeChartTransition(chart, 'in_progress', ctx, { auditAction: 'chart.entry_started' });
  },

  async holdChart(chartId: string, ctx: RequestContext): Promise<Chart> {
    await PermissionService.requirePermission(ctx.user.id, 'mark_chart_ready');

    const chart = await getChartOrThrow(chartId, ctx);
    if (!isValidChartTransition(chart.status, 'on_hold')) {
      throw new BusinessRuleError(`A chart in "${chart.status}" status cannot be put on hold.`);
    }

    return writeChartTransition(chart, 'on_hold', ctx, { auditAction: 'chart.held' });
  },

  async releaseChart(chartId: string, ctx: RequestContext): Promise<Chart> {
    await PermissionService.requirePermission(ctx.user.id, 'mark_chart_ready');

    const chart = await getChartOrThrow(chartId, ctx);
    if (!isValidChartTransition(chart.status, 'chart_ready')) {
      throw new BusinessRuleError(`A chart in "${chart.status}" status cannot be released.`);
    }

    return writeChartTransition(chart, 'chart_ready', ctx, { auditAction: 'chart.released' });
  },

  // BUSINESS_RULES_05: "Only authorized Data Entry (or approved CRC) may mark
  // Entered in EDC. System records: entered_by, entered_at, audit log."
  async markEnteredInEdc(
    chartId: string,
    input: MarkEnteredInEdcInput,
    ctx: RequestContext,
  ): Promise<Chart> {
    await PermissionService.requirePermission(ctx.user.id, 'mark_chart_entered');

    const chart = await getChartOrThrow(chartId, ctx);
    if (!isValidChartTransition(chart.status, 'entered_in_edc')) {
      throw new BusinessRuleError(
        `A chart in "${chart.status}" status cannot be marked Entered in EDC.`,
      );
    }

    return writeChartTransition(chart, 'entered_in_edc', ctx, {
      auditAction: 'chart.entered',
      extraFields: {
        entered_by: ctx.user.id,
        entered_by_role: input.entered_by_role,
        entered_in_edc_date: new Date().toISOString(),
      },
    });
  },

  // Decision 2, RULE C: explicit permission + mandatory reason + full audit
  // trail (actor, timestamp, previous/resulting state — captured by
  // writeChartTransition's chart_history + AuditService.log calls above).
  // Reusing PermissionService.guardDangerousOperation — the same mechanism
  // VisitService.reopenVisit already uses — rather than a parallel check.
  async reopenChart(chartId: string, input: ReopenChartInput, ctx: RequestContext): Promise<Chart> {
    const chart = await getChartOrThrow(chartId, ctx);
    if (chart.status !== 'entered_in_edc') {
      throw new BusinessRuleError('Only an Entered in EDC chart can be reopened.');
    }

    await PermissionService.guardDangerousOperation(ctx.user.id, 'reopen_chart', {
      blocked: true,
      reason: input.reason,
      blockedMessage:
        'Reopening an Entered-in-EDC chart requires the Reopen Chart permission and a reason.',
    });

    return writeChartTransition(chart, 'in_progress', ctx, {
      reason: input.reason,
      auditAction: 'chart.reopened',
    });
  },
};
