import { z } from 'zod';

// ── Auth ──────────────────────────────────────────────────────────────────────

export const signInSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

export type SignInSchema = z.infer<typeof signInSchema>;

// ── Invitations ───────────────────────────────────────────────────────────────

export const sendInvitationSchema = z.object({
  email: z.string().email('Invalid email address').toLowerCase().trim(),
  role_ids: z.array(z.string().uuid('Invalid role ID')).min(1, 'At least one role is required'),
  site_ids: z.array(z.string().uuid('Invalid site ID')),
});

export type SendInvitationSchema = z.infer<typeof sendInvitationSchema>;

const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character');

export const acceptInvitationSchema = z.object({
  token: z
    .string()
    .length(64, 'Invalid invitation token')
    .regex(/^[0-9a-f]+$/, 'Invalid invitation token format'),
  full_name: z.string().min(2, 'Full name is required').max(200).trim(),
  password: passwordSchema,
});

export type AcceptInvitationSchema = z.infer<typeof acceptInvitationSchema>;

export const validateTokenSchema = z.object({
  token: z
    .string()
    .length(64)
    .regex(/^[0-9a-f]+$/),
});

// ── Users ─────────────────────────────────────────────────────────────────────

export const updateUserSchema = z.object({
  full_name: z.string().min(2).max(200).trim().optional(),
  phone: z.string().max(20).trim().nullable().optional(),
  status: z.enum(['active', 'inactive', 'suspended']).optional(),
});

export type UpdateUserSchema = z.infer<typeof updateUserSchema>;

export const assignUserRoleSchema = z.object({
  role_id: z.string().uuid('Invalid role ID'),
});

export type AssignUserRoleSchema = z.infer<typeof assignUserRoleSchema>;

export const assignUserSiteSchema = z.object({
  site_id: z.string().uuid('Invalid site ID'),
});

export type AssignUserSiteSchema = z.infer<typeof assignUserSiteSchema>;

// ── Roles ─────────────────────────────────────────────────────────────────────

export const updateRolePermissionSchema = z.object({
  permission_key: z.string().min(1, 'Permission key is required'),
  allowed: z.boolean(),
});

export type UpdateRolePermissionSchema = z.infer<typeof updateRolePermissionSchema>;

// ── Sites ─────────────────────────────────────────────────────────────────────

export const createSiteSchema = z.object({
  name: z.string().min(1, 'Site name is required').max(200).trim(),
  site_code: z.string().max(50).trim().optional(),
  principal_investigator: z.string().max(200).trim().optional(),
  address: z.string().max(500).trim().optional(),
  city: z.string().max(100).trim().optional(),
  state: z.string().max(100).trim().optional(),
  zip_code: z.string().max(20).trim().optional(),
  phone: z.string().max(20).trim().optional(),
  timezone: z.string().max(100).trim().optional(),
});

export type CreateSiteSchema = z.infer<typeof createSiteSchema>;

export const updateSiteSchema = z.object({
  name: z.string().min(1).max(200).trim().optional(),
  site_code: z.string().max(50).trim().optional(),
  principal_investigator: z.string().max(200).trim().optional(),
  address: z.string().max(500).trim().optional(),
  city: z.string().max(100).trim().optional(),
  state: z.string().max(100).trim().optional(),
  zip_code: z.string().max(20).trim().optional(),
  phone: z.string().max(20).trim().optional(),
  timezone: z.string().max(100).trim().optional(),
  status: z.enum(['active', 'inactive', 'closed', 'archived']).optional(),
});

export type UpdateSiteSchema = z.infer<typeof updateSiteSchema>;

export const archiveSiteSchema = z.object({
  reason: z.string().min(1).max(1000).trim().optional(),
});

export type ArchiveSiteSchema = z.infer<typeof archiveSiteSchema>;

// ── Company ───────────────────────────────────────────────────────────────────

export const updateCompanySettingsSchema = z.object({
  primary_color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Invalid hex color')
    .optional(),
  secondary_color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Invalid hex color')
    .optional(),
  default_timezone: z.string().max(100).optional(),
  date_format: z.enum(['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD']).optional(),
  language: z.string().max(10).optional(),
  enable_ai: z.boolean().optional(),
  enable_task_center: z.boolean().optional(),
});

export type UpdateCompanySettingsSchema = z.infer<typeof updateCompanySettingsSchema>;

// ── Notifications ─────────────────────────────────────────────────────────────

export const updateNotificationPreferenceSchema = z.object({
  in_app: z.boolean(),
  email: z.boolean(),
});

export type UpdateNotificationPreferenceSchema = z.infer<typeof updateNotificationPreferenceSchema>;

export const getNotificationsSchema = z.object({
  is_read: z
    .string()
    .transform((v) => v === 'true')
    .optional(),
  limit: z
    .string()
    .transform(Number)
    .pipe(z.number().int().min(1).max(100))
    .optional()
    .default('50'),
});

// ── Studies ───────────────────────────────────────────────────────────────────

const studyDraftFieldsSchema = {
  protocol_version: z.string().max(100).trim().optional(),
  indication: z.string().max(500).trim().optional(),
  estimated_enrollment: z.number().int().positive().optional(),
  study_duration: z.string().max(200).trim().optional(),
  study_design: z.string().max(1000).trim().optional(),
  primary_endpoint: z.string().max(1000).trim().optional(),
};

export const createStudySchema = z.object({
  study_name: z.string().min(1, 'Study name is required').max(300).trim(),
  protocol_number: z.string().max(100).trim().optional(),
  sponsor: z.string().max(200).trim().optional(),
  cro: z.string().max(200).trim().optional(),
  phase: z.string().max(50).trim().optional(),
  therapeutic_area: z.string().max(200).trim().optional(),
  start_date: z.string().date().optional(),
  end_date: z.string().date().optional(),
  ...studyDraftFieldsSchema,
});

export type CreateStudySchema = z.infer<typeof createStudySchema>;

export const updateStudySchema = z.object({
  study_name: z.string().min(1).max(300).trim().optional(),
  protocol_number: z.string().max(100).trim().optional(),
  sponsor: z.string().max(200).trim().optional(),
  cro: z.string().max(200).trim().optional(),
  phase: z.string().max(50).trim().optional(),
  therapeutic_area: z.string().max(200).trim().optional(),
  start_date: z.string().date().optional(),
  end_date: z.string().date().optional(),
  status: z.enum(['draft', 'active', 'on_hold', 'closed', 'archived']).optional(),
  ...studyDraftFieldsSchema,
});

export type UpdateStudySchema = z.infer<typeof updateStudySchema>;

export const archiveStudySchema = z.object({
  reason: z.string().min(1).max(1000).trim().optional(),
});

export type ArchiveStudySchema = z.infer<typeof archiveStudySchema>;

export const assignSitesSchema = z.object({
  site_ids: z.array(z.string().uuid('Invalid site ID')).min(1, 'At least one site is required'),
});

export type AssignSitesSchema = z.infer<typeof assignSitesSchema>;

export const approveAiExtractionSchema = z.object({
  extraction_id: z.string().uuid('Invalid extraction ID'),
});

export type ApproveAiExtractionSchema = z.infer<typeof approveAiExtractionSchema>;

// ── Visit Templates ───────────────────────────────────────────────────────────

export const visitTemplateItemSchema = z.object({
  visit_name: z.string().min(1, 'Visit name is required').max(200).trim(),
  visit_order: z.number().int().min(0),
  offset_days: z.number().int().optional(),
  window_before: z.number().int().min(0).optional(),
  window_after: z.number().int().min(0).optional(),
  visit_type: z.enum(['scheduled', 'unscheduled']).optional(),
  is_required: z.boolean().optional(),
  is_baseline: z.boolean().optional(),
  notes: z.string().max(1000).trim().optional(),
});

export const createVisitTemplateSchema = z.object({
  items: z.array(visitTemplateItemSchema).min(1, 'At least one visit is required'),
});

export type CreateVisitTemplateSchema = z.infer<typeof createVisitTemplateSchema>;

export const finalizeAiDraftSchema = z.object({
  study_name: z.string().min(1, 'Study title is required').max(300).trim(),
  protocol_number: z.string().max(100).trim().optional(),
  sponsor: z.string().max(200).trim().optional(),
  cro: z.string().max(200).trim().optional(),
  phase: z.string().max(50).trim().optional(),
  therapeutic_area: z.string().max(200).trim().optional(),
  start_date: z.string().date().optional(),
  end_date: z.string().date().optional(),
  ...studyDraftFieldsSchema,
  visit_template_items: z.array(visitTemplateItemSchema).optional(),
});

export type FinalizeAiDraftSchema = z.infer<typeof finalizeAiDraftSchema>;

// ── Subjects ──────────────────────────────────────────────────────────────────

export const createSubjectSchema = z.object({
  site_id: z.string().uuid('Invalid site ID'),
  study_id: z.string().uuid('Invalid study ID'),
  subject_number: z.string().min(1, 'Subject number is required').max(50).trim(),
  initials: z.string().max(10).trim().optional(),
  screening_date: z.string().date().optional(),
});

export type CreateSubjectSchema = z.infer<typeof createSubjectSchema>;

export const updateSubjectSchema = z.object({
  initials: z.string().max(10).trim().optional(),
  screening_date: z.string().date().optional(),
  end_of_study_date: z.string().date().optional(),
});

export type UpdateSubjectSchema = z.infer<typeof updateSubjectSchema>;

export const completeBaselineVisitSchema = z.object({
  baseline_date: z.string().date(),
});

export type CompleteBaselineVisitSchema = z.infer<typeof completeBaselineVisitSchema>;

export const completeVisitSchema = z.object({
  scheduled_date: z.string().date(),
});

export type CompleteVisitSchema = z.infer<typeof completeVisitSchema>;

export const randomizeSubjectSchema = z.object({
  randomization_number: z.string().min(1, 'Randomization number is required').max(50).trim(),
  randomization_date: z.string().date(),
});

export type RandomizeSubjectSchema = z.infer<typeof randomizeSubjectSchema>;

export const changeSubjectStatusSchema = z.object({
  status: z.enum([
    'pre_screening',
    'screening',
    'screen_failed',
    'randomized',
    'active',
    'completed',
    'early_terminated',
    'lost_to_follow_up',
  ]),
  reason: z.string().max(1000).trim().optional(),
});

export type ChangeSubjectStatusSchema = z.infer<typeof changeSubjectStatusSchema>;

export const addSubjectNoteSchema = z.object({
  note: z.string().min(1, 'Note text is required').max(5000).trim(),
  visibility: z.enum(['internal', 'crc_only', 'admin_only']).optional(),
});

export type AddSubjectNoteSchema = z.infer<typeof addSubjectNoteSchema>;

// ── Visits ────────────────────────────────────────────────────────────────────

export const confirmVisitSchema = z.object({});

export type ConfirmVisitSchema = z.infer<typeof confirmVisitSchema>;

export const startVisitSchema = z.object({});

export type StartVisitSchema = z.infer<typeof startVisitSchema>;

export const rescheduleVisitSchema = z.object({
  target_date: z.string().date(),
  reason: z.string().min(1, 'A reason is required'),
});

export type RescheduleVisitSchema = z.infer<typeof rescheduleVisitSchema>;

export const cancelVisitSchema = z.object({
  reason: z.string().min(1, 'A reason is required'),
});

export type CancelVisitSchema = z.infer<typeof cancelVisitSchema>;

export const reopenVisitSchema = z.object({
  reason: z.string().min(1, 'A reason is required'),
});

export type ReopenVisitSchema = z.infer<typeof reopenVisitSchema>;

export const createUnscheduledVisitSchema = z.object({
  visit_name: z.string().min(1, 'Visit name is required').max(200).trim(),
  target_date: z.string().date(),
  notes: z.string().max(1000).trim().optional(),
});

export type CreateUnscheduledVisitSchema = z.infer<typeof createUnscheduledVisitSchema>;

// ── Subject Contact Info (PHI) ───────────────────────────────────────────────

export const upsertSubjectContactInfoSchema = z.object({
  first_name: z.string().min(1, 'First name is required').max(200).trim(),
  last_name: z.string().min(1, 'Last name is required').max(200).trim(),
  date_of_birth: z.string().date(),
  sex: z.string().min(1, 'Sex is required').max(50).trim(),
  phone_primary: z.string().min(1, 'Primary phone is required').max(20).trim(),
  phone_secondary: z.string().max(20).trim().optional(),
  email: z.string().email('Invalid email address').toLowerCase().trim().optional(),
  preferred_language: z.string().min(1, 'Preferred language is required').max(100).trim(),
  preferred_contact_method: z.enum(['phone', 'email', 'sms']),
  voicemail_permission: z.boolean(),
  best_time_to_contact: z.string().max(200).trim().optional(),
});

export type UpsertSubjectContactInfoSchema = z.infer<typeof upsertSubjectContactInfoSchema>;

// ── Appointment Confirmation ─────────────────────────────────────────────────

export const logContactAttemptSchema = z.object({
  confirmation_status: z.enum([
    'not_contacted',
    'attempted',
    'confirmed',
    'left_voicemail',
    'requested_reschedule',
    'unable_to_reach',
  ]),
  contact_method: z.enum(['phone', 'email']).optional(),
  notes: z.string().max(2000).trim().optional(),
  next_contact_at: z.string().datetime().optional(),
});

export type LogContactAttemptSchema = z.infer<typeof logContactAttemptSchema>;

// ── Calendar ──────────────────────────────────────────────────────────────────

export const listCalendarEventsSchema = z.object({
  start: z.string().date(),
  end: z.string().date(),
  site_id: z.string().uuid().optional(),
  study_id: z.string().uuid().optional(),
  status: z.enum(['scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled']).optional(),
  crc_user_id: z.string().uuid().optional(),
});

export type ListCalendarEventsSchema = z.infer<typeof listCalendarEventsSchema>;

export const listSubjectsSchema = z.object({
  study_id: z.string().uuid().optional(),
  site_id: z.string().uuid().optional(),
  status: z
    .enum([
      'pre_screening',
      'screening',
      'screen_failed',
      'randomized',
      'active',
      'completed',
      'early_terminated',
      'lost_to_follow_up',
    ])
    .optional(),
  subject_number: z.string().max(50).optional(),
});

// ── Invitations list filter ───────────────────────────────────────────────────

export const listInvitationsSchema = z.object({
  status: z.enum(['pending', 'accepted', 'expired', 'revoked']).optional(),
});

// ── Recruitment: Leads ───────────────────────────────────────────────────────

const LEAD_STATUSES = [
  'new',
  'contact_attempted',
  'contacted',
  'voicemail_left',
  'interested',
  'not_interested',
  'prescreening',
  'prescreen_scheduled',
  'prescreen_in_progress',
  'prescreen_complete',
  'qualified',
  'not_qualified',
  'screening_scheduled',
  'screened',
  'screen_failed',
  'withdrawn',
  'waitlisted',
  'converted',
  'declined',
  'lost',
] as const;

const LEAD_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

export const createLeadSchema = z.object({
  site_id: z.string().uuid().optional(),
  study_id: z.string().uuid().optional(),
  referral_source_id: z.string().uuid().optional(),
});

export type CreateLeadSchema = z.infer<typeof createLeadSchema>;

export const updateLeadSchema = z.object({
  site_id: z.string().uuid().nullable().optional(),
  study_id: z.string().uuid().nullable().optional(),
  referral_source_id: z.string().uuid().nullable().optional(),
  priority: z.enum(LEAD_PRIORITIES).optional(),
  source_detail: z.string().max(500).trim().nullable().optional(),
  notes_summary: z.string().max(2000).trim().nullable().optional(),
  consent_to_contact: z.boolean().optional(),
  do_not_contact: z.boolean().optional(),
  do_not_contact_reason: z.string().max(1000).trim().nullable().optional(),
});

export type UpdateLeadSchema = z.infer<typeof updateLeadSchema>;

const LEAD_SORT_FIELDS = [
  'created_at',
  'last_contacted_at',
  'next_contact_at',
  'priority',
  'status',
] as const;

export const listLeadsSchema = z.object({
  status: z.enum(LEAD_STATUSES).optional(),
  statuses: z.array(z.enum(LEAD_STATUSES)).max(20).optional(),
  site_id: z.string().uuid().optional(),
  study_id: z.string().uuid().optional(),
  referral_source_id: z.string().uuid().optional(),
  priority: z.enum(LEAD_PRIORITIES).optional(),
  assigned_user_id: z.string().uuid().optional(),
  include_archived: z.coerce.boolean().optional(),
  search: z.string().max(200).trim().optional(),
  has_overdue_tasks: z.coerce.boolean().optional(),
  has_duplicate_warning: z.coerce.boolean().optional(),
  next_follow_up_from: z.string().datetime().optional(),
  next_follow_up_to: z.string().datetime().optional(),
  created_from: z.string().datetime().optional(),
  created_to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).optional(),
  page_size: z.coerce.number().int().min(1).max(100).optional(),
  sort_by: z.enum(LEAD_SORT_FIELDS).optional(),
  sort_dir: z.enum(['asc', 'desc']).optional(),
});

export type ListLeadsSchema = z.infer<typeof listLeadsSchema>;

export const logLeadContactSchema = z.object({
  new_status: z.enum(LEAD_STATUSES),
  contact_method: z.enum(['phone', 'email', 'sms']).optional(),
  notes: z.string().max(2000).trim().optional(),
  next_contact_at: z.string().datetime().optional(),
  override_reason: z.string().max(1000).trim().optional(),
});

export type LogLeadContactSchema = z.infer<typeof logLeadContactSchema>;

export const waitlistLeadSchema = z.object({
  notes: z.string().max(2000).trim().optional(),
});

export const declineLeadSchema = z.object({
  declined_reason: z.string().min(1, 'A reason is required').max(1000).trim(),
});

export type DeclineLeadSchema = z.infer<typeof declineLeadSchema>;

export const convertLeadSchema = z.object({
  subject_number: z.string().min(1, 'Subject number is required').max(50).trim(),
  screening_date: z.string().date().optional(),
});

export type ConvertLeadSchema = z.infer<typeof convertLeadSchema>;

export const assignLeadSchema = z.object({
  assigned_user_id: z.string().uuid().nullable(),
});

export type AssignLeadSchema = z.infer<typeof assignLeadSchema>;

export const archiveLeadSchema = z.object({
  reason: z.string().max(1000).trim().optional(),
});

export type ArchiveLeadSchema = z.infer<typeof archiveLeadSchema>;

export const changeLeadStatusSchema = z.object({
  new_status: z.enum(LEAD_STATUSES),
  reason: z.string().max(1000).trim().optional(),
});

export type ChangeLeadStatusSchema = z.infer<typeof changeLeadStatusSchema>;

// ── Recruitment: Lead Contact Info (PHI) ──────────────────────────────────────

export const upsertLeadContactInfoSchema = z.object({
  first_name: z.string().min(1, 'First name is required').max(200).trim(),
  middle_name: z.string().max(200).trim().optional(),
  last_name: z.string().min(1, 'Last name is required').max(200).trim(),
  preferred_name: z.string().max(200).trim().optional(),
  date_of_birth: z.string().date().optional(),
  sex: z.string().max(50).trim().optional(),
  gender_identity: z.string().max(50).trim().optional(),
  preferred_language: z.string().max(100).trim().optional(),
  phone_primary: z.string().min(1, 'Primary phone is required').max(20).trim(),
  phone_secondary: z.string().max(20).trim().optional(),
  email: z.string().email('Invalid email address').toLowerCase().trim().optional(),
  address_line_1: z.string().max(200).trim().optional(),
  address_line_2: z.string().max(200).trim().optional(),
  city: z.string().max(100).trim().optional(),
  state: z.string().max(100).trim().optional(),
  postal_code: z.string().max(20).trim().optional(),
  country: z.string().max(100).trim().optional(),
  preferred_contact_method: z.enum(['phone', 'email', 'sms']),
});

export type UpsertLeadContactInfoSchema = z.infer<typeof upsertLeadContactInfoSchema>;

// ── Recruitment: Duplicate Detection ──────────────────────────────────────────

export const checkDuplicatesSchema = z
  .object({
    phone: z.string().max(20).trim().optional(),
    email: z.string().email('Invalid email address').toLowerCase().trim().optional(),
    first_name: z.string().max(200).trim().optional(),
    last_name: z.string().max(200).trim().optional(),
    date_of_birth: z.string().date().optional(),
    postal_code: z.string().max(20).trim().optional(),
    lead_id: z.string().uuid().optional(),
  })
  .refine(
    (v) =>
      v.phone ??
      v.email ??
      (v.first_name && v.last_name ? (v.date_of_birth ?? v.postal_code) : undefined),
    {
      message:
        'Provide a phone, an email, or a first and last name plus date of birth or postal code',
    },
  );

export type CheckDuplicatesSchema = z.infer<typeof checkDuplicatesSchema>;

// ── Recruitment: Lead Notes ────────────────────────────────────────────────

const LEAD_NOTE_TYPES = ['general', 'call_summary', 'eligibility', 'follow_up', 'other'] as const;

export const createLeadNoteSchema = z.object({
  note_type: z.enum(LEAD_NOTE_TYPES).optional(),
  body: z.string().min(1, 'Note body is required').max(5000).trim(),
  is_private: z.boolean().optional(),
});

export type CreateLeadNoteSchema = z.infer<typeof createLeadNoteSchema>;

export const updateLeadNoteSchema = z.object({
  note_type: z.enum(LEAD_NOTE_TYPES).optional(),
  body: z.string().min(1, 'Note body is required').max(5000).trim().optional(),
  is_private: z.boolean().optional(),
});

export type UpdateLeadNoteSchema = z.infer<typeof updateLeadNoteSchema>;

// ── Recruitment: Lead Calls ────────────────────────────────────────────────

const CALL_DIRECTIONS = ['inbound', 'outbound'] as const;
const CALL_OUTCOMES = [
  'answered',
  'no_answer',
  'voicemail_left',
  'busy',
  'wrong_number',
  'disconnected',
  'interested',
  'not_interested',
  'callback_requested',
  'scheduled',
  'other',
] as const;

export const logLeadCallSchema = z
  .object({
    direction: z.enum(CALL_DIRECTIONS),
    outcome: z.enum(CALL_OUTCOMES),
    started_at: z.string().datetime(),
    ended_at: z.string().datetime().optional(),
    duration_seconds: z.number().int().min(0).max(86400).optional(),
    phone_number: z.string().max(20).trim().optional(),
    summary: z.string().max(5000).trim().optional(),
    follow_up_required: z.boolean().optional(),
    follow_up_at: z.string().datetime().optional(),
    override_reason: z.string().max(1000).trim().optional(),
  })
  .refine((v) => !v.ended_at || new Date(v.ended_at) >= new Date(v.started_at), {
    message: 'Call end time must be at or after the start time',
    path: ['ended_at'],
  });

export type LogLeadCallSchema = z.infer<typeof logLeadCallSchema>;

// ── Recruitment: Lead Tasks ────────────────────────────────────────────────

const LEAD_TASK_STATUSES = ['open', 'in_progress', 'completed', 'cancelled'] as const;

export const createLeadTaskSchema = z.object({
  title: z.string().min(1, 'Title is required').max(300).trim(),
  description: z.string().max(2000).trim().optional(),
  priority: z.enum(LEAD_PRIORITIES).optional(),
  assigned_user_id: z.string().uuid().optional(),
  due_at: z.string().datetime().optional(),
  override_reason: z.string().max(1000).trim().optional(),
});

export type CreateLeadTaskSchema = z.infer<typeof createLeadTaskSchema>;

export const updateLeadTaskSchema = z.object({
  title: z.string().min(1).max(300).trim().optional(),
  description: z.string().max(2000).trim().nullable().optional(),
  status: z.enum(LEAD_TASK_STATUSES).optional(),
  priority: z.enum(LEAD_PRIORITIES).optional(),
  assigned_user_id: z.string().uuid().nullable().optional(),
  due_at: z.string().datetime().nullable().optional(),
});

export type UpdateLeadTaskSchema = z.infer<typeof updateLeadTaskSchema>;

// ── Recruitment: Referral Sources ─────────────────────────────────────────────

const REFERRAL_SOURCE_CATEGORIES = [
  'physician_referral',
  'advertisement',
  'patient_database',
  'self_referral',
  'social_media',
  'other',
] as const;

export const createReferralSourceSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200).trim(),
  category: z.enum(REFERRAL_SOURCE_CATEGORIES),
});

export type CreateReferralSourceSchema = z.infer<typeof createReferralSourceSchema>;

export const updateReferralSourceSchema = z.object({
  name: z.string().min(1).max(200).trim().optional(),
  category: z.enum(REFERRAL_SOURCE_CATEGORIES).optional(),
  active: z.boolean().optional(),
});

export type UpdateReferralSourceSchema = z.infer<typeof updateReferralSourceSchema>;

// ── Recruitment: Prescreening ─────────────────────────────────────────────────

export const createPrescreeningQuestionSchema = z.object({
  question_order: z.number().int().min(0),
  question_text: z.string().min(1, 'Question text is required').max(1000).trim(),
  question_type: z.enum(['yes_no', 'number', 'text']),
  eligible_answer: z.string().max(100).trim().optional(),
  min_eligible_value: z.number().optional(),
  max_eligible_value: z.number().optional(),
  is_hard_exclusion: z.boolean().optional(),
});

export type CreatePrescreeningQuestionSchema = z.infer<typeof createPrescreeningQuestionSchema>;

export const updatePrescreeningQuestionSchema = z.object({
  question_order: z.number().int().min(0).optional(),
  question_text: z.string().min(1).max(1000).trim().optional(),
  eligible_answer: z.string().max(100).trim().optional(),
  min_eligible_value: z.number().optional(),
  max_eligible_value: z.number().optional(),
  is_hard_exclusion: z.boolean().optional(),
  is_active: z.boolean().optional(),
});

export type UpdatePrescreeningQuestionSchema = z.infer<typeof updatePrescreeningQuestionSchema>;

export const submitPrescreeningSchema = z.object({
  study_id: z.string().uuid('Invalid study ID'),
  answers: z
    .array(
      z.object({
        question_id: z.string().uuid('Invalid question ID'),
        answer_value: z.string().min(1, 'Answer is required').max(500).trim(),
      }),
    )
    .min(1, 'At least one answer is required'),
});

export type SubmitPrescreeningSchema = z.infer<typeof submitPrescreeningSchema>;

export const overridePrescreeningSchema = z.object({
  manual_outcome: z.enum(['potentially_eligible', 'needs_review', 'not_eligible']),
  manual_override_reason: z.string().min(1, 'A reason is required').max(1000).trim(),
});

// ── Regulatory: Document Types ──────────────────────────────────────────────

export const createDocumentTypeSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200).trim(),
  category: z.string().max(100).trim().optional(),
  has_expiration: z.boolean().optional(),
  default_alert_days: z.array(z.number().int().positive()).optional(),
  requires_version: z.boolean().optional(),
  required_by_default: z.boolean().optional(),
});

export type CreateDocumentTypeSchema = z.infer<typeof createDocumentTypeSchema>;

export const updateDocumentTypeSchema = createDocumentTypeSchema.partial();

export type UpdateDocumentTypeSchema = z.infer<typeof updateDocumentTypeSchema>;

// ── Regulatory: Requirements ────────────────────────────────────────────────

export const createRegulatoryRequirementSchema = z
  .object({
    document_type_id: z.string().uuid('Invalid document type ID'),
    study_id: z.string().uuid('Invalid study ID').optional(),
    site_id: z.string().uuid('Invalid site ID').optional(),
    required: z.boolean().optional(),
    expiration_required: z.boolean().optional(),
  })
  .refine((v) => !v.expiration_required || v.required !== false, {
    message: 'A requirement that is not required cannot require expiration tracking',
    path: ['expiration_required'],
  });

export type CreateRegulatoryRequirementSchema = z.infer<typeof createRegulatoryRequirementSchema>;

export const updateRegulatoryRequirementSchema = z.object({
  required: z.boolean().optional(),
  expiration_required: z.boolean().optional(),
});

export type UpdateRegulatoryRequirementSchema = z.infer<typeof updateRegulatoryRequirementSchema>;

// ── Regulatory: Documents ───────────────────────────────────────────────────

export const createRegulatoryDocumentSchema = z.object({
  document_type_id: z.string().uuid('Invalid document type ID'),
  study_id: z.string().uuid('Invalid study ID').optional(),
  site_id: z.string().uuid('Invalid site ID').optional(),
  document_name: z.string().min(1, 'Document name is required').max(300).trim(),
  effective_date: z.string().date('Invalid effective date').optional(),
  expiration_date: z.string().date('Invalid expiration date').optional(),
});

export type CreateRegulatoryDocumentSchema = z.infer<typeof createRegulatoryDocumentSchema>;

export const uploadDocumentVersionSchema = z.object({
  effective_date: z.string().date('Invalid effective date').optional(),
  expiration_date: z.string().date('Invalid expiration date').optional(),
  replacement_reason: z.string().max(1000).trim().optional(),
  confirm_duplicate: z.boolean().optional(),
});

export type UploadDocumentVersionSchema = z.infer<typeof uploadDocumentVersionSchema>;

export const rejectDocumentSchema = z.object({
  reason: z.string().min(1, 'A reason is required').max(1000).trim(),
});

export type RejectDocumentSchema = z.infer<typeof rejectDocumentSchema>;

export const archiveDocumentSchema = z.object({
  reason: z.string().min(1, 'A reason is required').max(1000).trim(),
});

export type ArchiveDocumentSchema = z.infer<typeof archiveDocumentSchema>;

export const overrideDocumentStatusSchema = z.object({
  new_status: z.enum([
    'missing',
    'draft',
    'pending_review',
    'current',
    'expiring_soon',
    'expired',
    'rejected',
    'archived',
  ]),
  reason: z.string().min(1, 'A reason is required').max(1000).trim(),
});

export type OverrideDocumentStatusSchema = z.infer<typeof overrideDocumentStatusSchema>;

// ── Regulatory: Staff Credentials ───────────────────────────────────────────

export const createStaffDocumentSchema = z.object({
  user_id: z.string().uuid('Invalid user ID'),
  document_type_id: z.string().uuid('Invalid document type ID'),
  site_id: z.string().uuid('Invalid site ID').optional(),
  effective_date: z.string().date('Invalid effective date').optional(),
  expiration_date: z.string().date('Invalid expiration date').optional(),
});

export type CreateStaffDocumentSchema = z.infer<typeof createStaffDocumentSchema>;

export type OverridePrescreeningSchema = z.infer<typeof overridePrescreeningSchema>;

// ── Recruitment: Duplicate Dismissal ──────────────────────────────────────────

export const dismissDuplicateSchema = z.object({
  matched_lead_id: z.string().uuid('Invalid lead ID'),
  reason: z.string().min(1, 'A reason is required').max(1000).trim(),
});

export type DismissDuplicateSchema = z.infer<typeof dismissDuplicateSchema>;

// ── Recruitment: Bulk Actions ─────────────────────────────────────────────────

const BULK_LEAD_IDS = z
  .array(z.string().uuid())
  .min(1, 'Select at least one lead')
  .max(200, 'A single bulk action may apply to at most 200 leads');

export const bulkAssignLeadsSchema = z.object({
  lead_ids: BULK_LEAD_IDS,
  assigned_user_id: z.string().uuid().nullable(),
});

export type BulkAssignLeadsSchema = z.infer<typeof bulkAssignLeadsSchema>;

export const bulkUpdateLeadPrioritySchema = z.object({
  lead_ids: BULK_LEAD_IDS,
  priority: z.enum(LEAD_PRIORITIES),
});

export type BulkUpdateLeadPrioritySchema = z.infer<typeof bulkUpdateLeadPrioritySchema>;

export const bulkArchiveLeadsSchema = z.object({
  lead_ids: BULK_LEAD_IDS,
  reason: z.string().max(1000).trim().optional(),
});

export type BulkArchiveLeadsSchema = z.infer<typeof bulkArchiveLeadsSchema>;

export const bulkCreateLeadTaskSchema = z.object({
  lead_ids: BULK_LEAD_IDS,
  title: z.string().min(1, 'Title is required').max(300).trim(),
  description: z.string().max(2000).trim().optional(),
  priority: z.enum(LEAD_PRIORITIES).optional(),
  assigned_user_id: z.string().uuid().optional(),
  due_at: z.string().datetime().optional(),
  override_reason: z.string().max(1000).trim().optional(),
});

export type BulkCreateLeadTaskSchema = z.infer<typeof bulkCreateLeadTaskSchema>;

export const bulkChangeLeadStatusSchema = z.object({
  lead_ids: BULK_LEAD_IDS,
  new_status: z.enum(LEAD_STATUSES),
  reason: z.string().max(1000).trim().optional(),
});

export type BulkChangeLeadStatusSchema = z.infer<typeof bulkChangeLeadStatusSchema>;

// ── Recruitment: Follow-up Queues ─────────────────────────────────────────────

export const followUpQueueSchema = z.object({
  scope: z.enum(['due_today', 'overdue', 'upcoming', 'completed_recently']),
  assigned_user_id: z.string().uuid().optional(),
  site_id: z.string().uuid().optional(),
  study_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).optional(),
  page_size: z.coerce.number().int().min(1).max(100).optional(),
});

export type FollowUpQueueSchema = z.infer<typeof followUpQueueSchema>;

// ── Recruitment: Workload ─────────────────────────────────────────────────────

export const workloadSummarySchema = z.object({
  site_id: z.string().uuid().optional(),
  study_id: z.string().uuid().optional(),
});

export type WorkloadSummarySchema = z.infer<typeof workloadSummarySchema>;

// ── Recruitment: Dashboard (extended) ─────────────────────────────────────────

export const recruitmentDashboardFiltersSchema = z.object({
  site_id: z.string().uuid().optional(),
  study_id: z.string().uuid().optional(),
  assigned_user_id: z.string().uuid().optional(),
  date_from: z.string().date().optional(),
  date_to: z.string().date().optional(),
});

export type RecruitmentDashboardFiltersSchema = z.infer<typeof recruitmentDashboardFiltersSchema>;

// ── Recruitment: Pipeline ─────────────────────────────────────────────────────

const PIPELINE_COLUMNS = [
  'new',
  'contact_attempted',
  'contacted',
  'interested',
  'prescreen',
  'qualified',
  'screening_scheduled',
  'screened',
  'converted',
  'closed',
] as const;

export const pipelineCountsSchema = z.object({
  site_id: z.string().uuid().optional(),
  study_id: z.string().uuid().optional(),
  assigned_user_id: z.string().uuid().optional(),
  priority: z.enum(LEAD_PRIORITIES).optional(),
});

export type PipelineCountsSchema = z.infer<typeof pipelineCountsSchema>;

export const pipelineColumnSchema = z.object({ column: z.enum(PIPELINE_COLUMNS) });

export type PipelineColumnSchema = z.infer<typeof pipelineColumnSchema>;

// ── Charts (Milestone 4.1 — Data Entry UI) ────────────────────────────────────

const CHART_STATUSES = ['chart_ready', 'in_progress', 'entered_in_edc', 'on_hold'] as const;
const CHART_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;

export const listChartsSchema = z.object({
  site_id: z.string().uuid().optional(),
  study_id: z.string().uuid().optional(),
  subject_id: z.string().uuid().optional(),
  status: z.enum(CHART_STATUSES).optional(),
  priority: z.enum(CHART_PRIORITIES).optional(),
  page: z.coerce.number().int().min(1).optional(),
  page_size: z.coerce.number().int().min(1).max(100).optional(),
});

export type ListChartsSchema = z.infer<typeof listChartsSchema>;

export const markChartEnteredSchema = z.object({
  entered_by_role: z.string().min(1, 'A role is required').max(100).trim(),
});

export type MarkChartEnteredSchema = z.infer<typeof markChartEnteredSchema>;

export const reopenChartSchema = z.object({
  reason: z.string().min(1, 'A reason is required'),
});

export type ReopenChartSchema = z.infer<typeof reopenChartSchema>;

// ── Document Center ───────────────────────────────────────────────────────────

export const linkFileSchema = z.object({
  module: z.string().min(1, 'Module is required').max(50),
  record_id: z.string().uuid('Invalid record ID'),
  site_id: z.string().uuid('Invalid site ID').optional(),
});

export type LinkFileSchema = z.infer<typeof linkFileSchema>;
