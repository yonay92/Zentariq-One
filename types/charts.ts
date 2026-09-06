export type ChartStatus = 'chart_ready' | 'in_progress' | 'entered_in_edc' | 'on_hold';

export type ChartPriority = 'critical' | 'high' | 'medium' | 'low';

export type Chart = {
  id: string;
  company_id: string;
  site_id: string;
  study_id: string;
  subject_id: string;
  visit_id: string;
  chart_ready_date: string | null;
  entered_in_edc_date: string | null;
  entered_by: string | null;
  entered_by_role: string | null;
  days_until_entry: number | null;
  priority: ChartPriority;
  status: ChartStatus;
  created_at: string;
  updated_at: string;
};

export type ChartHistoryEntry = {
  id: string;
  company_id: string;
  chart_id: string;
  old_status: ChartStatus | null;
  new_status: ChartStatus;
  changed_by: string | null;
  changed_at: string;
  reason: string | null;
};

export type MarkEnteredInEdcInput = {
  entered_by_role: string;
};

export type ReopenChartInput = {
  reason: string;
};

// Computed, not persisted (Decision 3 — compute-on-read, no scheduled
// recalculation). Attached to a Chart at read time by ChartService.
export type ChartAging = {
  days_since_ready: number | null;
  effective_priority: ChartPriority;
};

// Milestone 4.1 — Chart Queue / Subject Profile Charts tab read filters.
// priority is applied by ChartService.listCharts AFTER computing ChartAging
// per row, never as a DB column filter — charts.priority is a stale
// creation-time default, not the authoritative computed value.
export type ChartQueueFilters = {
  site_id?: string | undefined;
  study_id?: string | undefined;
  subject_id?: string | undefined;
  status?: ChartStatus | undefined;
  priority?: ChartPriority | undefined;
  page?: number | undefined;
  page_size?: number | undefined;
};

// Denormalized display fields resolved by ChartService.listCharts' batched
// enrichment (same pattern as VisitService.enrichCalendarEvents) — the one
// authorized read contract shared by the Chart Queue and the Subject
// Profile Charts tab, never a second independent data-access path.
export type ChartQueueItem = Chart &
  ChartAging & {
    subject_number: string;
    study_name: string;
    site_name: string;
    visit_name: string;
    visit_date: string | null;
    is_out_of_window: boolean;
  };

export type ChartQueueResult = {
  data: ChartQueueItem[];
  total: number;
  page: number;
  page_size: number;
};
