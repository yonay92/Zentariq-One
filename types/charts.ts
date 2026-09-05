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
