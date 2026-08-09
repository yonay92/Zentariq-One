export type LeadStatus =
  | 'new'
  | 'contact_attempted'
  | 'contacted'
  | 'voicemail_left'
  | 'interested'
  | 'not_interested'
  | 'prescreening'
  | 'prescreen_scheduled'
  | 'prescreen_in_progress'
  | 'prescreen_complete'
  | 'qualified'
  | 'not_qualified'
  | 'screening_scheduled'
  | 'screened'
  | 'screen_failed'
  | 'withdrawn'
  | 'waitlisted'
  | 'converted'
  | 'declined'
  | 'lost';

export type LeadPriority = 'low' | 'medium' | 'high' | 'urgent';

export type Lead = {
  id: string;
  company_id: string;
  site_id: string | null;
  study_id: string | null;
  referral_source_id: string | null;
  initials: string | null;
  status: LeadStatus;
  priority: LeadPriority;
  assigned_user_id: string | null;
  contact_attempt_count: number;
  last_contacted_at: string | null;
  next_contact_at: string | null;
  waitlisted_at: string | null;
  consent_to_contact: boolean;
  do_not_contact: boolean;
  do_not_contact_reason: string | null;
  source_detail: string | null;
  notes_summary: string | null;
  converted_subject_id: string | null;
  converted_at: string | null;
  declined_reason: string | null;
  archived_at: string | null;
  archived_by: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateLeadInput = {
  site_id?: string | undefined;
  study_id?: string | undefined;
  referral_source_id?: string | undefined;
};

export type UpdateLeadInput = Partial<{
  site_id: string | null;
  study_id: string | null;
  referral_source_id: string | null;
  priority: LeadPriority;
  source_detail: string | null;
  notes_summary: string | null;
  consent_to_contact: boolean;
  do_not_contact: boolean;
  do_not_contact_reason: string | null;
}>;

export type LeadSortField =
  'created_at' | 'last_contacted_at' | 'next_contact_at' | 'priority' | 'status';
export type SortDirection = 'asc' | 'desc';

export type ListLeadsFilters = {
  status?: LeadStatus | undefined;
  // Used by the Pipeline to fetch a column's cards (a column may group
  // several raw statuses, e.g. the closed/not-eligible column) — additive to
  // `status`, never replaces it; when both are supplied results must match
  // `status` AND be included in `statuses`.
  statuses?: LeadStatus[] | undefined;
  site_id?: string | undefined;
  study_id?: string | undefined;
  referral_source_id?: string | undefined;
  priority?: LeadPriority | undefined;
  assigned_user_id?: string | undefined;
  include_archived?: boolean | undefined;
  // Matches against initials only — the one non-PHI identifying value that
  // exists directly on `leads` (see Sprint 7.1 PHI split). Never searches
  // lead_contact_info.
  search?: string | undefined;
  has_overdue_tasks?: boolean | undefined;
  has_duplicate_warning?: boolean | undefined;
  next_follow_up_from?: string | undefined;
  next_follow_up_to?: string | undefined;
  created_from?: string | undefined;
  created_to?: string | undefined;
  page?: number | undefined;
  page_size?: number | undefined;
  sort_by?: LeadSortField | undefined;
  sort_dir?: SortDirection | undefined;
};

export type LeadListItem = Lead & {
  open_task_count: number;
  has_overdue_task: boolean;
  // Phone/email exact-match signal only — see LeadDuplicateService for why
  // name+DOB/name+postal-code matching isn't part of this bulk/list-level
  // indicator (kept to two cheaply-batchable, indexed columns to avoid an
  // unbounded per-row computation across a full page).
  has_duplicate_warning: boolean;
};

export type LeadListResult = {
  data: LeadListItem[];
  total: number;
  page: number;
  page_size: number;
};

export type AssignLeadInput = {
  assigned_user_id: string | null;
};

export type ArchiveLeadInput = {
  reason?: string | undefined;
};

export type ChangeLeadStatusInput = {
  new_status: LeadStatus;
  reason?: string | undefined;
};

export type LeadStatusHistoryEntry = {
  id: string;
  company_id: string;
  lead_id: string;
  previous_status: LeadStatus | null;
  new_status: LeadStatus;
  reason: string | null;
  changed_by: string | null;
  changed_at: string;
};

export type LeadPreferredContactMethod = 'phone' | 'email' | 'sms';

export type LeadContactInfo = {
  id: string;
  company_id: string;
  site_id: string | null;
  lead_id: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: string | null;
  sex: string | null;
  gender_identity: string | null;
  preferred_language: string | null;
  phone_primary: string;
  phone_secondary: string | null;
  email: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  preferred_contact_method: LeadPreferredContactMethod;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type UpsertLeadContactInfoInput = {
  first_name: string;
  middle_name?: string | undefined;
  last_name: string;
  preferred_name?: string | undefined;
  date_of_birth?: string | undefined;
  sex?: string | undefined;
  gender_identity?: string | undefined;
  preferred_language?: string | undefined;
  phone_primary: string;
  phone_secondary?: string | undefined;
  email?: string | undefined;
  address_line_1?: string | undefined;
  address_line_2?: string | undefined;
  city?: string | undefined;
  state?: string | undefined;
  postal_code?: string | undefined;
  country?: string | undefined;
  preferred_contact_method: LeadPreferredContactMethod;
};

export type LeadContactLogEntry = {
  id: string;
  company_id: string;
  lead_id: string;
  contact_method: string | null;
  old_status: string | null;
  new_status: string;
  notes: string | null;
  contacted_by: string | null;
  contacted_at: string;
};

export type LogLeadContactInput = {
  new_status: LeadStatus;
  contact_method?: string | undefined;
  notes?: string | undefined;
  next_contact_at?: string | undefined;
  // Required only when the lead has do_not_contact = true — audited override.
  override_reason?: string | undefined;
};

export type ReferralSourceCategory =
  | 'physician_referral'
  | 'advertisement'
  | 'patient_database'
  | 'self_referral'
  | 'social_media'
  | 'other';

export type ReferralSource = {
  id: string;
  company_id: string;
  name: string;
  category: ReferralSourceCategory;
  active: boolean;
  created_at: string;
  updated_at: string;
};

export type CreateReferralSourceInput = {
  name: string;
  category: ReferralSourceCategory;
};

export type UpdateReferralSourceInput = Partial<CreateReferralSourceInput> & {
  active?: boolean;
};

export type PrescreeningQuestionType = 'yes_no' | 'number' | 'text';

export type StudyPrescreeningQuestion = {
  id: string;
  company_id: string;
  study_id: string;
  question_order: number;
  question_text: string;
  question_type: PrescreeningQuestionType;
  eligible_answer: string | null;
  min_eligible_value: number | null;
  max_eligible_value: number | null;
  is_hard_exclusion: boolean;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type CreatePrescreeningQuestionInput = {
  question_order: number;
  question_text: string;
  question_type: PrescreeningQuestionType;
  eligible_answer?: string | undefined;
  min_eligible_value?: number | undefined;
  max_eligible_value?: number | undefined;
  is_hard_exclusion?: boolean | undefined;
};

export type UpdatePrescreeningQuestionInput = Partial<
  Omit<CreatePrescreeningQuestionInput, 'question_type'>
> & {
  is_active?: boolean | undefined;
};

export type PrescreeningOutcome = 'potentially_eligible' | 'needs_review' | 'not_eligible';

export type LeadPrescreening = {
  id: string;
  company_id: string;
  lead_id: string;
  study_id: string;
  computed_outcome: PrescreeningOutcome;
  manual_outcome: PrescreeningOutcome | null;
  manual_override_reason: string | null;
  manual_override_by: string | null;
  manual_override_at: string | null;
  completed_by: string | null;
  completed_at: string;
};

export type LeadPrescreeningAnswer = {
  id: string;
  company_id: string;
  lead_prescreening_id: string;
  question_id: string | null;
  question_text: string;
  question_type: PrescreeningQuestionType;
  answer_value: string;
  is_eligible_answer: boolean | null;
};

export type SubmitPrescreeningAnswerInput = {
  question_id: string;
  answer_value: string;
};

export type SubmitPrescreeningInput = {
  study_id: string;
  answers: SubmitPrescreeningAnswerInput[];
};

export type OverridePrescreeningInput = {
  manual_outcome: PrescreeningOutcome;
  manual_override_reason: string;
};

export type LeadPrescreeningWithAnswers = LeadPrescreening & {
  answers: LeadPrescreeningAnswer[];
};

export type RecruitmentFunnelCounts = Record<LeadStatus, number>;

export type RecruitmentDashboard = {
  funnel: RecruitmentFunnelCounts;
  total_leads: number;
  conversion_rate: number;
  by_referral_source: Array<{ referral_source_id: string | null; name: string; count: number }>;
  // Sprint 7.2 — every field on this type (including funnel/total_leads/
  // conversion_rate/by_referral_source above) is computed under whatever
  // site/study/assigned-user/date filters were supplied — see
  // RecruitmentDashboardService.get(). metrics duplicates conversion_rate
  // for convenience alongside the rest of the operational metric set.
  metrics: RecruitmentOperationalMetrics;
};

// ── Recruitment: Lead Notes ────────────────────────────────────────────────

export type LeadNoteType = 'general' | 'call_summary' | 'eligibility' | 'follow_up' | 'other';

export type LeadNote = {
  id: string;
  company_id: string;
  lead_id: string;
  note_type: LeadNoteType;
  body: string;
  is_private: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateLeadNoteInput = {
  note_type?: LeadNoteType | undefined;
  body: string;
  is_private?: boolean | undefined;
};

export type UpdateLeadNoteInput = Partial<{
  note_type: LeadNoteType;
  body: string;
  is_private: boolean;
}>;

// ── Recruitment: Lead Calls ────────────────────────────────────────────────

export type CallDirection = 'inbound' | 'outbound';

export type CallOutcome =
  | 'answered'
  | 'no_answer'
  | 'voicemail_left'
  | 'busy'
  | 'wrong_number'
  | 'disconnected'
  | 'interested'
  | 'not_interested'
  | 'callback_requested'
  | 'scheduled'
  | 'other';

export type LeadCall = {
  id: string;
  company_id: string;
  lead_id: string;
  direction: CallDirection;
  outcome: CallOutcome;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  phone_number: string | null;
  summary: string | null;
  follow_up_required: boolean;
  follow_up_at: string | null;
  created_by: string | null;
  created_at: string;
};

export type LogLeadCallInput = {
  direction: CallDirection;
  outcome: CallOutcome;
  started_at: string;
  ended_at?: string | undefined;
  duration_seconds?: number | undefined;
  phone_number?: string | undefined;
  summary?: string | undefined;
  follow_up_required?: boolean | undefined;
  follow_up_at?: string | undefined;
  // Required only when the lead has do_not_contact = true — audited override,
  // same pattern as PermissionService.guardDangerousOperation.
  override_reason?: string | undefined;
};

// ── Recruitment: Lead Tasks ────────────────────────────────────────────────

export type LeadTaskStatus = 'open' | 'in_progress' | 'completed' | 'cancelled';

export type LeadTask = {
  id: string;
  company_id: string;
  site_id: string | null;
  study_id: string | null;
  lead_id: string;
  title: string;
  description: string | null;
  status: LeadTaskStatus;
  priority: LeadPriority;
  assigned_user_id: string | null;
  due_at: string | null;
  completed_at: string | null;
  completed_by: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateLeadTaskInput = {
  title: string;
  description?: string | undefined;
  priority?: LeadPriority | undefined;
  assigned_user_id?: string | undefined;
  due_at?: string | undefined;
  // Required only when the lead has do_not_contact = true and the task is a
  // contact-oriented one — audited override.
  override_reason?: string | undefined;
};

export type UpdateLeadTaskInput = Partial<{
  title: string;
  description: string | null;
  status: LeadTaskStatus;
  priority: LeadPriority;
  assigned_user_id: string | null;
  due_at: string | null;
}>;

// ── Recruitment: Duplicate Detection ───────────────────────────────────────

export type CheckDuplicatesInput = {
  phone?: string | undefined;
  email?: string | undefined;
  first_name?: string | undefined;
  last_name?: string | undefined;
  date_of_birth?: string | undefined;
  postal_code?: string | undefined;
  // The lead this check is being performed for, if it already exists (e.g.
  // re-checking an existing lead from its detail page) — enables dismissal
  // lookups so a previously-reviewed match can be flagged rather than
  // re-surfaced as a fresh warning. Omitted for the pre-save check on a
  // brand new lead, which has no id yet.
  lead_id?: string | undefined;
};

export type DuplicateMatchReason =
  'phone_match' | 'email_match' | 'name_dob_match' | 'name_postal_code_match';

export type DuplicateMatch = {
  lead_id: string;
  initials: string | null;
  status: LeadStatus;
  site_id: string | null;
  study_id: string | null;
  archived: boolean;
  match_reasons: DuplicateMatchReason[];
  // true when check_duplicates_input.lead_id has an existing dismissal
  // against this match — never suppressed, only flagged (business rule: do
  // not silently suppress duplicate warnings).
  previously_dismissed: boolean;
};

export type CheckDuplicatesResult = {
  possible_matches: DuplicateMatch[];
};

// ── Recruitment: Duplicate Dismissal ───────────────────────────────────────

export type DismissDuplicateInput = {
  matched_lead_id: string;
  reason: string;
};

export type LeadDuplicateDismissal = {
  id: string;
  company_id: string;
  lead_id: string;
  matched_lead_id: string;
  reason: string;
  dismissed_by: string | null;
  dismissed_at: string;
};

// ── Recruitment: Bulk Actions ──────────────────────────────────────────────
//
// Every bulk action returns a per-lead outcome so the caller can render a
// validation summary — never a single pass/fail for the whole batch (except
// bulkChangeStatus, which is deliberately all-or-nothing: see
// LeadService.bulkChangeStatus).

export type BulkActionOutcome = {
  lead_id: string;
  succeeded: boolean;
  reason: string | null;
};

export type BulkActionResult = {
  outcomes: BulkActionOutcome[];
  succeeded_count: number;
  skipped_count: number;
};

export type BulkAssignInput = {
  lead_ids: string[];
  assigned_user_id: string | null;
};

export type BulkUpdatePriorityInput = {
  lead_ids: string[];
  priority: LeadPriority;
};

export type BulkArchiveInput = {
  lead_ids: string[];
  reason?: string | undefined;
};

export type BulkCreateTaskInput = {
  lead_ids: string[];
  title: string;
  description?: string | undefined;
  priority?: LeadPriority | undefined;
  assigned_user_id?: string | undefined;
  due_at?: string | undefined;
  // Applied uniformly to every do_not_contact lead in the batch — leads
  // that are do_not_contact without this reason are skipped, not failed.
  override_reason?: string | undefined;
};

export type BulkChangeStatusInput = {
  lead_ids: string[];
  new_status: LeadStatus;
  reason?: string | undefined;
};

// A dry-run preview of a bulk status change — same eligibility logic
// bulkChangeStatus itself enforces, exposed separately so the UI can render
// the required pre-apply validation summary before the user confirms.
export type BulkChangeStatusPreview = {
  eligible_lead_ids: string[];
  ineligible: Array<{ lead_id: string; reason: string }>;
  all_eligible: boolean;
};

// ── Recruitment: Follow-up Queues ──────────────────────────────────────────

export type FollowUpQueueScope = 'due_today' | 'overdue' | 'upcoming' | 'completed_recently';

// "My Follow-ups" is a personal lead_tasks queue (see Sprint 7.2 plan) —
// each entry is a task, not a lead, so the UI can link back to its lead.
export type FollowUpQueueEntry = LeadTask & {
  lead_status: LeadStatus;
  lead_initials: string | null;
};

// ── Recruitment: Workload ──────────────────────────────────────────────────

export type WorkloadSummaryEntry = {
  assigned_user_id: string | null;
  active_lead_count: number;
  overdue_task_count: number;
};

export type WorkloadSummary = {
  entries: WorkloadSummaryEntry[];
  unassigned_count: number;
};

// ── Recruitment: Conversion Readiness ──────────────────────────────────────
//
// Mirrors the ActivationReadiness pattern already built for Studies — the
// backend is the single source of truth; the frontend only renders this.

export type ConversionReadinessItemKey =
  | 'not_previously_converted'
  | 'site_assigned'
  | 'study_assigned'
  | 'permission_granted'
  | 'contact_info_complete'
  | 'prescreening_eligible'
  | 'duplicate_review'
  | 'do_not_contact_clear'
  | 'consent_to_contact';

export type ConversionReadinessItem = {
  key: ConversionReadinessItemKey;
  label: string;
  met: boolean;
  blocking: boolean;
  reason: string | null;
};

export type ConversionReadiness = {
  can_convert: boolean;
  items: ConversionReadinessItem[];
  blocking_items: ConversionReadinessItem[];
  warnings: ConversionReadinessItem[];
};

// ── Recruitment: Pipeline ──────────────────────────────────────────────────

// The Kanban board groups the 20 raw statuses into a fixed set of columns —
// closed/terminal statuses share one column but each card still shows its
// specific status (see components/recruitment/leadPipelineColumns.ts).
export type PipelineColumnKey =
  | 'new'
  | 'contact_attempted'
  | 'contacted'
  | 'interested'
  | 'prescreen'
  | 'qualified'
  | 'screening_scheduled'
  | 'screened'
  | 'converted'
  | 'closed';

export type PipelineColumnCount = {
  column: PipelineColumnKey;
  count: number;
};

export type PipelineCounts = {
  columns: PipelineColumnCount[];
};

// ── Recruitment: Valid Next Statuses ───────────────────────────────────────

export type ValidNextStatuses = {
  current_status: LeadStatus;
  normal_next_statuses: LeadStatus[];
  // Any status not in normal_next_statuses is still reachable via
  // changeStatus, but requires a reason (exceptional transition) — 'converted'
  // is never included here; it is only ever reachable via convertToSubject.
  reason_required_for_others: boolean;
};

// ── Recruitment: Dashboard (extended) ──────────────────────────────────────

export type RecruitmentDashboardFilters = {
  site_id?: string | undefined;
  study_id?: string | undefined;
  assigned_user_id?: string | undefined;
  date_from?: string | undefined;
  date_to?: string | undefined;
};

export type RecruitmentOperationalMetrics = {
  new_leads: number;
  follow_ups_due_today: number;
  overdue_follow_ups: number;
  unassigned_leads: number;
  high_priority_leads: number;
  prescreens_scheduled_today: number;
  screenings_scheduled: number;
  qualified_leads: number;
  converted_this_month: number;
  avg_days_new_to_contacted: number | null;
  avg_days_qualified_to_screening_scheduled: number | null;
  conversion_rate: number;
};
