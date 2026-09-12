import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@/lib/supabase/admin';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import { NotFoundError, DatabaseError, BusinessRuleError } from '@/lib/api/errors';
import type {
  Chart,
  ChartStatus,
  ChartPriority,
  ChartAging,
  ChartHistoryEntry,
  ChartQueueFilters,
  ChartQueueItem,
  ChartQueueResult,
  MarkEnteredInEdcInput,
  ReopenChartInput,
  ChartComment,
  AddChartCommentInput,
  ChartMetrics,
} from '@/types/charts';
import type { Visit, VisitStatus } from '@/types/subjects';
import type { RequestContext } from '@/types/api';

const CHART_COLUMNS =
  'id, company_id, site_id, study_id, subject_id, visit_id, chart_ready_date, entered_in_edc_date, entered_by, entered_by_role, days_until_entry, priority, status, created_at, updated_at';
const CHART_HISTORY_COLUMNS =
  'id, company_id, chart_id, old_status, new_status, changed_by, changed_at, reason';
const CHART_COMMENT_COLUMNS = 'id, company_id, chart_id, comment, created_by, created_at';
const CHART_METRICS_COLUMNS =
  'id, company_id, chart_id, ready_to_entry_hours, total_entry_hours, overdue_days, out_of_window, sponsor_priority, calculated_at';

const DEFAULT_QUEUE_PAGE_SIZE = 25;
const MAX_QUEUE_PAGE_SIZE = 100;

// docs/UI_UX_09_Charts.md queue order: 1. Most overdue, 2. Out of Window,
// 3. Sponsor-related, 4. Remaining. sponsorVisitApproaching is always false
// in Milestone 4.1 (Phase A/B decision P3 — no authoritative data source
// exists yet), so that tier folds into "remaining" until it does; days-based
// overdue-ness and out-of-window both already surface as 'critical' via
// computeChartAging, so this fixed business-rule order is expressed as:
// priority tier desc, then days-pending desc (breaks ties within a tier by
// "most overdue" first), then created_at asc (stable, oldest-first fallback,
// same final tiebreak GAP_ANALYSIS's GAP-PERF-02 documents).
const PRIORITY_RANK: Record<ChartPriority, number> = { critical: 4, high: 3, medium: 2, low: 1 };

function compareChartQueueItems(a: ChartQueueItem, b: ChartQueueItem): number {
  const rankDiff = PRIORITY_RANK[b.effective_priority] - PRIORITY_RANK[a.effective_priority];
  if (rankDiff !== 0) return rankDiff;

  const daysA = a.days_since_ready ?? -1;
  const daysB = b.days_since_ready ?? -1;
  if (daysB !== daysA) return daysB - daysA;

  return a.created_at.localeCompare(b.created_at);
}

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

// Milestone 4.3 / R3: comment_chart must stand entirely on its own — never
// coupled with or substituted by view_charts (or any other chart
// permission). charts_select's RLS policy (migration 026) itself requires
// view_charts, so looking the chart up through the normal session-scoped
// client would silently re-introduce that dependency. This helper uses the
// admin client purely to resolve the chart's existence/site_id/company_id
// for scoping the comment insert and its audit log — never to bypass the
// comment_chart permission check itself (callers always call
// PermissionService.requirePermission(ctx.user.id, 'comment_chart') first),
// and it re-validates company_id explicitly in TypeScript (defense in
// depth, the same pattern migration 026's RPC uses for its own re-checks)
// rather than trusting the admin client's lack of RLS.
async function getChartForCommentScopeOrThrow(
  chartId: string,
  ctx: RequestContext,
): Promise<Chart> {
  const supabase = createAdminSupabaseClient();
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

// Milestone 4.3 / R5: exactly one current row per chart, recalculated in
// place (ON CONFLICT chart_id DO UPDATE — chart_metrics.chart_id is UNIQUE,
// migration 029). Called synchronously at the four points that change any of
// this row's inputs (chart creation, start of entry, mark entered, reopen —
// see each call site below); hold/release are not trigger points because no
// field below depends on hold state. overdue_days reuses computeChartAging's
// exact days-since-ready math (Decision 3) rather than a second formula, so
// this reporting snapshot can never disagree with the live queue-priority
// calculation — this is the concrete fix for GAP_ANALYSIS.md's GAP-DUP-03.
// sponsor_priority is hardcoded false — see migration 029's header and
// docs/BUSINESS_RULES_05_Charts_DataEntry.md's amended note: no
// calendar_events row of event_type='sponsor_visit' can be produced by any
// existing code path (verified during Milestone 4.3 planning), so this
// mirrors ChartService.computeChartAging's own sponsorVisitApproaching=false
// default rather than inventing a second, equally-unpopulated source.
// Errors from this upsert are intentionally not surfaced to the caller —
// same best-effort posture the sibling chart_history insert above already
// has (its .error is likewise never checked) — a metrics-recalculation
// failure must never block the actual chart transition it accompanies.
async function upsertChartMetrics(
  chart: Pick<Chart, 'id' | 'visit_id' | 'chart_ready_date' | 'entered_in_edc_date' | 'status'>,
  ctx: RequestContext,
): Promise<void> {
  const supabase = await createServerSupabaseClient();

  const [visitRes, firstInProgressRes] = await Promise.all([
    supabase
      .from('visits')
      .select('status')
      .eq('id', chart.visit_id)
      .eq('company_id', ctx.company.id)
      .maybeSingle(),
    supabase
      .from('chart_history')
      .select('changed_at')
      .eq('chart_id', chart.id)
      .eq('company_id', ctx.company.id)
      .eq('new_status', 'in_progress')
      .order('changed_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);

  const isOutOfWindow =
    (visitRes.data as { status?: VisitStatus } | null)?.status === 'out_of_window';
  const { days_since_ready: overdueDays } = computeChartAging(chart, { isOutOfWindow });

  const readyAt = chart.chart_ready_date ? new Date(chart.chart_ready_date).getTime() : null;
  const firstInProgressAt = (firstInProgressRes.data as { changed_at?: string } | null)?.changed_at;
  const readyToEntryHours =
    readyAt !== null && firstInProgressAt
      ? (new Date(firstInProgressAt).getTime() - readyAt) / 3_600_000
      : null;
  const totalEntryHours =
    readyAt !== null && chart.entered_in_edc_date
      ? (new Date(chart.entered_in_edc_date).getTime() - readyAt) / 3_600_000
      : null;

  await supabase.from('chart_metrics').upsert(
    {
      company_id: ctx.company.id,
      chart_id: chart.id,
      ready_to_entry_hours: readyToEntryHours,
      total_entry_hours: totalEntryHours,
      overdue_days: overdueDays,
      out_of_window: isOutOfWindow,
      sponsor_priority: false,
      calculated_at: new Date().toISOString(),
    },
    { onConflict: 'chart_id' },
  );
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

      await upsertChartMetrics(
        {
          id: result.chart_id,
          visit_id: visitId,
          chart_ready_date: new Date().toISOString(),
          entered_in_edc_date: null,
          status: 'chart_ready',
        },
        ctx,
      );
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

  // Append-only transition ledger for the Chart Detail workspace's History
  // section (Milestone 4.1). getChartOrThrow's view_charts + company_id +
  // RLS (can_access_site) checks already gate the chart itself; chart_history
  // has no site_id of its own to check independently.
  async getChartHistory(chartId: string, ctx: RequestContext): Promise<ChartHistoryEntry[]> {
    await getChartOrThrow(chartId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('chart_history')
      .select(CHART_HISTORY_COLUMNS)
      .eq('chart_id', chartId)
      .eq('company_id', ctx.company.id)
      .order('changed_at', { ascending: false });

    if (error) throw new DatabaseError(error.message);
    return (data as ChartHistoryEntry[]) ?? [];
  },

  // Milestone 4.1 — the one new read method backing both the Chart Queue and
  // the Subject Profile Charts tab (Phase A/B decision P1). Security scoping
  // (company_id here, company_id + can_access_site via RLS's charts_select
  // policy underneath) is applied to the base query BEFORE any of the
  // application-layer priority-filter/sort/pagination below runs (P2) — this
  // method never fetches out-of-scope rows and narrows down after the fact.
  async listCharts(filters: ChartQueueFilters, ctx: RequestContext): Promise<ChartQueueResult> {
    await PermissionService.requirePermission(ctx.user.id, 'view_charts');

    const supabase = await createServerSupabaseClient();

    let query = supabase.from('charts').select(CHART_COLUMNS).eq('company_id', ctx.company.id);
    if (filters.site_id) query = query.eq('site_id', filters.site_id);
    if (filters.study_id) query = query.eq('study_id', filters.study_id);
    if (filters.subject_id) query = query.eq('subject_id', filters.subject_id);
    if (filters.status) query = query.eq('status', filters.status);

    const { data, error } = await query;
    if (error) throw new DatabaseError(error.message);
    const charts = (data as Chart[]) ?? [];

    const page = filters.page && filters.page > 0 ? filters.page : 1;
    const pageSize =
      filters.page_size && filters.page_size > 0
        ? Math.min(filters.page_size, MAX_QUEUE_PAGE_SIZE)
        : DEFAULT_QUEUE_PAGE_SIZE;

    if (charts.length === 0) {
      return { data: [], total: 0, page, page_size: pageSize };
    }

    // Batched (not per-chart) enrichment — same bounded-query-count pattern
    // as VisitService.enrichCalendarEvents, regardless of how many charts
    // are returned.
    const visitIds = [...new Set(charts.map((c) => c.visit_id))];
    const subjectIds = [...new Set(charts.map((c) => c.subject_id))];
    const studyIds = [...new Set(charts.map((c) => c.study_id))];
    const siteIds = [...new Set(charts.map((c) => c.site_id))];

    const [visitsRes, subjectsRes, studiesRes, sitesRes] = await Promise.all([
      supabase
        .from('visits')
        .select('id, visit_name, target_date, scheduled_date, status')
        .eq('company_id', ctx.company.id)
        .in('id', visitIds),
      supabase
        .from('subjects')
        .select('id, subject_number')
        .eq('company_id', ctx.company.id)
        .in('id', subjectIds),
      supabase
        .from('studies')
        .select('id, study_name')
        .eq('company_id', ctx.company.id)
        .in('id', studyIds),
      supabase.from('sites').select('id, name').eq('company_id', ctx.company.id).in('id', siteIds),
    ]);
    if (visitsRes.error) throw new DatabaseError(visitsRes.error.message);
    if (subjectsRes.error) throw new DatabaseError(subjectsRes.error.message);
    if (studiesRes.error) throw new DatabaseError(studiesRes.error.message);
    if (sitesRes.error) throw new DatabaseError(sitesRes.error.message);

    type VisitLookup = {
      id: string;
      visit_name: string;
      target_date: string | null;
      scheduled_date: string | null;
      status: VisitStatus;
    };
    const visitById = new Map(((visitsRes.data as VisitLookup[]) ?? []).map((v) => [v.id, v]));
    const subjectNumberById = new Map(
      ((subjectsRes.data as Array<{ id: string; subject_number: string }>) ?? []).map((s) => [
        s.id,
        s.subject_number,
      ]),
    );
    const studyNameById = new Map(
      ((studiesRes.data as Array<{ id: string; study_name: string }>) ?? []).map((s) => [
        s.id,
        s.study_name,
      ]),
    );
    const siteNameById = new Map(
      ((sitesRes.data as Array<{ id: string; name: string }>) ?? []).map((s) => [s.id, s.name]),
    );

    let items: ChartQueueItem[] = charts.map((chart) => {
      const visit = visitById.get(chart.visit_id);
      const isOutOfWindow = visit?.status === 'out_of_window';
      // sponsorVisitApproaching intentionally always false in Milestone 4.1
      // (approved P3) — no authoritative sponsor-visit data source exists.
      const aging = computeChartAging(chart, { isOutOfWindow, sponsorVisitApproaching: false });
      return {
        ...chart,
        ...aging,
        subject_number: subjectNumberById.get(chart.subject_id) ?? '—',
        study_name: studyNameById.get(chart.study_id) ?? '—',
        site_name: siteNameById.get(chart.site_id) ?? '—',
        visit_name: visit?.visit_name ?? '—',
        visit_date: visit?.scheduled_date ?? visit?.target_date ?? null,
        is_out_of_window: isOutOfWindow,
      };
    });

    // Priority is compute-on-read (Decision 3) and NOT reliably reflected by
    // the stored charts.priority column (never updated by any transition
    // above) — filtering by priority must happen here, after computation,
    // never as a DB `.eq('priority', ...)` against that stale column.
    if (filters.priority) {
      items = items.filter((item) => item.effective_priority === filters.priority);
    }

    // Fixed business-rule order (not user-selectable, unlike Leads'
    // sort_by/sort_dir) — application-layer per P2, isolated to this one
    // spot so it can move to a DB ORDER BY later without changing this
    // method's return contract.
    items.sort(compareChartQueueItems);

    const total = items.length;
    const paged = items.slice((page - 1) * pageSize, page * pageSize);

    return { data: paged, total, page, page_size: pageSize };
  },

  async startDataEntry(chartId: string, ctx: RequestContext): Promise<Chart> {
    await PermissionService.requirePermission(ctx.user.id, 'mark_chart_ready');

    const chart = await getChartOrThrow(chartId, ctx);
    if (!isValidChartTransition(chart.status, 'in_progress')) {
      throw new BusinessRuleError(`A chart in "${chart.status}" status cannot begin data entry.`);
    }

    const updated = await writeChartTransition(chart, 'in_progress', ctx, {
      auditAction: 'chart.entry_started',
    });
    await upsertChartMetrics(updated, ctx);
    return updated;
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

    const updated = await writeChartTransition(chart, 'entered_in_edc', ctx, {
      auditAction: 'chart.entered',
      extraFields: {
        entered_by: ctx.user.id,
        entered_by_role: input.entered_by_role,
        entered_in_edc_date: new Date().toISOString(),
      },
    });
    await upsertChartMetrics(updated, ctx);
    return updated;
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

    const updated = await writeChartTransition(chart, 'in_progress', ctx, {
      reason: input.reason,
      auditAction: 'chart.reopened',
    });
    await upsertChartMetrics(updated, ctx);
    return updated;
  },

  // Milestone 4.3 / R3, R4: comment_chart is the ONLY gate — deliberately not
  // combined with view_charts, mark_chart_ready, mark_chart_entered, or
  // reopen_chart (see getChartForCommentScopeOrThrow above for why the chart
  // lookup itself uses the admin client rather than getChartOrThrow). A
  // comment never touches charts.status or any clinical field, so it is
  // postable on a locked (entered_in_edc) chart without reopen_chart —
  // chart_comments has no UPDATE/DELETE RLS policy at all (migration 029),
  // so this insert is the only way this table is ever written, and it can
  // never be edited or removed afterward.
  async addComment(
    chartId: string,
    input: AddChartCommentInput,
    ctx: RequestContext,
  ): Promise<ChartComment> {
    await PermissionService.requirePermission(ctx.user.id, 'comment_chart');

    const chart = await getChartForCommentScopeOrThrow(chartId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('chart_comments')
      .insert({
        company_id: ctx.company.id,
        chart_id: chart.id,
        comment: input.comment,
        created_by: ctx.user.id,
      })
      .select(CHART_COMMENT_COLUMNS)
      .single();

    if (error || !data) throw new DatabaseError(error?.message ?? 'Failed to add comment');

    await AuditService.log({
      company_id: ctx.company.id,
      site_id: chart.site_id,
      user_id: ctx.user.id,
      action: 'chart.commented',
      module: 'charts',
      record_type: 'chart',
      record_id: chart.id,
      new_value: { comment_id: (data as ChartComment).id },
    });

    return data as ChartComment;
  },

  // Read path intentionally requires view_charts (chart_comments_select's
  // RLS predicate, migration 029) — a separate, already-approved decision
  // from the write-side comment_chart gate above, not a coupling of the two
  // permissions.
  async getComments(chartId: string, ctx: RequestContext): Promise<ChartComment[]> {
    await getChartOrThrow(chartId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('chart_comments')
      .select(CHART_COMMENT_COLUMNS)
      .eq('chart_id', chartId)
      .eq('company_id', ctx.company.id)
      .order('created_at', { ascending: false });

    if (error) throw new DatabaseError(error.message);
    return (data as ChartComment[]) ?? [];
  },

  // Milestone 4.3 — read-only projection of the single upserted row
  // upsertChartMetrics maintains. Requires view_charts, same as every other
  // chart read.
  async getMetrics(chartId: string, ctx: RequestContext): Promise<ChartMetrics> {
    await getChartOrThrow(chartId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('chart_metrics')
      .select(CHART_METRICS_COLUMNS)
      .eq('chart_id', chartId)
      .eq('company_id', ctx.company.id)
      .single();

    if (error || !data) throw new NotFoundError('Chart metrics');
    return data as ChartMetrics;
  },
};
