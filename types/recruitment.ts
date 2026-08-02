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

export type ListLeadsFilters = {
  status?: LeadStatus | undefined;
  site_id?: string | undefined;
  study_id?: string | undefined;
  referral_source_id?: string | undefined;
  priority?: LeadPriority | undefined;
  assigned_user_id?: string | undefined;
  include_archived?: boolean | undefined;
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
};

export type CheckDuplicatesResult = {
  possible_matches: DuplicateMatch[];
};
