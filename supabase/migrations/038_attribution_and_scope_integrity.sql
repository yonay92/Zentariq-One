-- ============================================================
-- Migration 038 — Attribution and scope integrity (G8, M4 phase 1)
-- ============================================================
--
-- CONTEXT: the G8 M4 assessment (2026-11-09) confirmed that a signed-in
-- user can call the Data API directly with their own JWT and write rows
-- the application would never write. Migration 038 is the first,
-- database-only step of the remediation and is limited to attribution and
-- scope integrity:
--
--   F1  audit_logs accepted any user_id (including other tenants' users),
--       any created_at and another tenant's site_id.
--   F3  history, timeline, notes and other attributable rows accepted a
--       forged actor and timestamp; chart_history, chart_comments,
--       visit_history and appointment_confirmation_log did not check
--       that the caller may access the parent chart or visit.
--   F6  can_access_site() honoured view_all_sites for ANY site id, and
--       145 parent links were id-only foreign keys, so rows could point at
--       another tenant's sites, subjects, studies, files or users.
--   F7  (write side only) a visit could be created at one site for a
--       subject of another site; a chart could disagree with its visit.
--   F12 user_has_site_access(user, site) answered for users and sites of
--       other tenants.
--   F13 files.storage_path could name another tenant's storage folder.
--   F15 enforce_task_update_invariants() had no pinned search_path.
--
-- DESIGN (extends the 037 pattern):
--   * Attribution is derived, never supplied. A BEFORE trigger sets actor
--     columns from auth.uid() and event timestamps from now() for Data API
--     callers (authenticated/anon). A supplied actor that is not the
--     caller RAISES (fail closed) instead of being silently rewritten.
--     service_role and migration roles are unaffected, as in 037.
--   * Tenant scope is structural: every link between two company-scoped
--     tables becomes a composite (child_col, company_id) ->
--     (id, company_id) foreign key. SET NULL links keep SET NULL on the
--     child column only (PostgreSQL 15+ column-list syntax), so company_id
--     is never nulled. ON DELETE/ON UPDATE behaviour is otherwise unchanged.
--   * Site consistency is structural for the denormalised site columns
--     that the application never changes after creation:
--     visit -> subject (site, study), chart -> visit (site, study, subject),
--     subject_contact_info -> subject (site),
--     appointment_confirmations -> visit (site).
--   * Child-record writes check parent accessibility with the existing
--     SECURITY DEFINER helpers (can_access_chart / can_access_visit).
--   * No new SECURITY DEFINER function. Two existing definer helpers are
--     replaced in place (same signature, owner, grants, pinned search_path).
--
-- NOT CHANGED HERE (later phases, see the G8 M4 report §6.2):
--   workflow/state-machine rules and per-transition permissions (039),
--   fabricated self-attributed audit events, audit site scope within the
--   tenant, audit ip/user_agent, Data API change capture (040),
--   regulatory transactions (041), role governance (042), Storage read
--   site scope (043). Storage bucket policies are NOT modified here.
--
-- EXECUTION: one transaction; NOT idempotent. Every precondition is checked
-- first and the migration aborts with an explicit message (and no change)
-- if the schema is not the exact post-037 state, if 038 is already
-- applied, or if existing rows would violate a new constraint.
-- Requires PostgreSQL 15+ (ON DELETE SET NULL (column)).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 0. Foreign-key plan (single source of truth for sections 1, 4 and 9)
-- ------------------------------------------------------------
-- Every row is an EXISTING single-column foreign key between two
-- company-scoped tables (verified against the post-037 catalog). It is
-- replaced by a composite foreign key with the same name and the same
-- ON DELETE action. Rows 45, 58, 62 and 131 also carry the parent's
-- site/study/subject columns to enforce site consistency.
CREATE TEMP TABLE m038_fk_plan (
  ord         integer PRIMARY KEY,
  child       text    NOT NULL,
  conname     text    NOT NULL,
  fk_col      text    NOT NULL,
  parent      text    NOT NULL,
  on_delete   text    NOT NULL CHECK (on_delete IN ('CASCADE', 'RESTRICT', 'NO ACTION', 'SET NULL')),
  child_cols  text[]  NOT NULL,
  parent_cols text[]  NOT NULL
) ON COMMIT DROP;

INSERT INTO m038_fk_plan (ord, child, conname, fk_col, parent, on_delete, child_cols, parent_cols) VALUES
  (  1, 'user_invitations', 'user_invitations_accepted_by_fkey', 'accepted_by', 'profiles', 'NO ACTION', '{accepted_by,company_id}', '{id,company_id}'),
  (  2, 'user_invitations', 'user_invitations_invited_by_fkey', 'invited_by', 'profiles', 'RESTRICT', '{invited_by,company_id}', '{id,company_id}'),
  (  3, 'user_invitations', 'user_invitations_revoked_by_fkey', 'revoked_by', 'profiles', 'NO ACTION', '{revoked_by,company_id}', '{id,company_id}'),
  (  4, 'notifications', 'notifications_user_id_fkey', 'user_id', 'profiles', 'CASCADE', '{user_id,company_id}', '{id,company_id}'),
  (  5, 'notification_preferences', 'notification_preferences_user_id_fkey', 'user_id', 'profiles', 'CASCADE', '{user_id,company_id}', '{id,company_id}'),
  (  6, 'notification_email_queue', 'notification_email_queue_notification_id_fkey', 'notification_id', 'notifications', 'CASCADE', '{notification_id,company_id}', '{id,company_id}'),
  (  7, 'notification_email_queue', 'notification_email_queue_user_id_fkey', 'user_id', 'profiles', 'CASCADE', '{user_id,company_id}', '{id,company_id}'),
  (  8, 'audit_logs', 'audit_logs_site_id_fkey', 'site_id', 'sites', 'NO ACTION', '{site_id,company_id}', '{id,company_id}'),
  (  9, 'audit_logs', 'audit_logs_user_id_fkey', 'user_id', 'profiles', 'NO ACTION', '{user_id,company_id}', '{id,company_id}'),
  ( 10, 'files', 'files_uploaded_by_fkey', 'uploaded_by', 'profiles', 'SET NULL', '{uploaded_by,company_id}', '{id,company_id}'),
  ( 11, 'studies', 'studies_created_by_fkey', 'created_by', 'profiles', 'SET NULL', '{created_by,company_id}', '{id,company_id}'),
  ( 12, 'study_sites', 'study_sites_site_id_fkey', 'site_id', 'sites', 'RESTRICT', '{site_id,company_id}', '{id,company_id}'),
  ( 13, 'study_sites', 'study_sites_study_id_fkey', 'study_id', 'studies', 'CASCADE', '{study_id,company_id}', '{id,company_id}'),
  ( 14, 'study_staff', 'study_staff_study_id_fkey', 'study_id', 'studies', 'CASCADE', '{study_id,company_id}', '{id,company_id}'),
  ( 15, 'study_staff', 'study_staff_user_id_fkey', 'user_id', 'profiles', 'CASCADE', '{user_id,company_id}', '{id,company_id}'),
  ( 16, 'visit_templates', 'visit_templates_approved_by_fkey', 'approved_by', 'profiles', 'SET NULL', '{approved_by,company_id}', '{id,company_id}'),
  ( 17, 'visit_templates', 'visit_templates_created_by_fkey', 'created_by', 'profiles', 'SET NULL', '{created_by,company_id}', '{id,company_id}'),
  ( 18, 'visit_templates', 'visit_templates_study_id_fkey', 'study_id', 'studies', 'CASCADE', '{study_id,company_id}', '{id,company_id}'),
  ( 19, 'visit_template_items', 'visit_template_items_template_id_fkey', 'template_id', 'visit_templates', 'CASCADE', '{template_id,company_id}', '{id,company_id}'),
  ( 20, 'study_documents', 'study_documents_file_id_fkey', 'file_id', 'files', 'RESTRICT', '{file_id,company_id}', '{id,company_id}'),
  ( 21, 'study_documents', 'study_documents_study_id_fkey', 'study_id', 'studies', 'CASCADE', '{study_id,company_id}', '{id,company_id}'),
  ( 22, 'study_documents', 'study_documents_uploaded_by_fkey', 'uploaded_by', 'profiles', 'SET NULL', '{uploaded_by,company_id}', '{id,company_id}'),
  ( 23, 'study_ai_extractions', 'study_ai_extractions_reviewed_by_fkey', 'reviewed_by', 'profiles', 'SET NULL', '{reviewed_by,company_id}', '{id,company_id}'),
  ( 24, 'study_ai_extractions', 'study_ai_extractions_study_id_fkey', 'study_id', 'studies', 'CASCADE', '{study_id,company_id}', '{id,company_id}'),
  ( 25, 'study_document_requirements', 'study_document_requirements_document_type_id_fkey', 'document_type_id', 'document_types', 'RESTRICT', '{document_type_id,company_id}', '{id,company_id}'),
  ( 26, 'study_document_requirements', 'study_document_requirements_site_id_fkey', 'site_id', 'sites', 'CASCADE', '{site_id,company_id}', '{id,company_id}'),
  ( 27, 'study_document_requirements', 'study_document_requirements_study_id_fkey', 'study_id', 'studies', 'CASCADE', '{study_id,company_id}', '{id,company_id}'),
  ( 28, 'subjects', 'subjects_created_by_fkey', 'created_by', 'profiles', 'SET NULL', '{created_by,company_id}', '{id,company_id}'),
  ( 29, 'subjects', 'subjects_site_id_fkey', 'site_id', 'sites', 'RESTRICT', '{site_id,company_id}', '{id,company_id}'),
  ( 30, 'subjects', 'subjects_study_id_fkey', 'study_id', 'studies', 'RESTRICT', '{study_id,company_id}', '{id,company_id}'),
  ( 31, 'subject_status_history', 'subject_status_history_changed_by_fkey', 'changed_by', 'profiles', 'SET NULL', '{changed_by,company_id}', '{id,company_id}'),
  ( 32, 'subject_status_history', 'subject_status_history_subject_id_fkey', 'subject_id', 'subjects', 'CASCADE', '{subject_id,company_id}', '{id,company_id}'),
  ( 33, 'subject_notes', 'subject_notes_created_by_fkey', 'created_by', 'profiles', 'SET NULL', '{created_by,company_id}', '{id,company_id}'),
  ( 34, 'subject_notes', 'subject_notes_subject_id_fkey', 'subject_id', 'subjects', 'CASCADE', '{subject_id,company_id}', '{id,company_id}'),
  ( 35, 'subject_documents', 'subject_documents_file_id_fkey', 'file_id', 'files', 'RESTRICT', '{file_id,company_id}', '{id,company_id}'),
  ( 36, 'subject_documents', 'subject_documents_subject_id_fkey', 'subject_id', 'subjects', 'CASCADE', '{subject_id,company_id}', '{id,company_id}'),
  ( 37, 'subject_documents', 'subject_documents_uploaded_by_fkey', 'uploaded_by', 'profiles', 'SET NULL', '{uploaded_by,company_id}', '{id,company_id}'),
  ( 38, 'subject_milestones', 'subject_milestones_created_by_fkey', 'created_by', 'profiles', 'SET NULL', '{created_by,company_id}', '{id,company_id}'),
  ( 39, 'subject_milestones', 'subject_milestones_subject_id_fkey', 'subject_id', 'subjects', 'CASCADE', '{subject_id,company_id}', '{id,company_id}'),
  ( 40, 'subject_timeline', 'subject_timeline_created_by_fkey', 'created_by', 'profiles', 'SET NULL', '{created_by,company_id}', '{id,company_id}'),
  ( 41, 'subject_timeline', 'subject_timeline_subject_id_fkey', 'subject_id', 'subjects', 'CASCADE', '{subject_id,company_id}', '{id,company_id}'),
  ( 42, 'visits', 'visits_created_by_fkey', 'created_by', 'profiles', 'SET NULL', '{created_by,company_id}', '{id,company_id}'),
  ( 43, 'visits', 'visits_site_id_fkey', 'site_id', 'sites', 'RESTRICT', '{site_id,company_id}', '{id,company_id}'),
  ( 44, 'visits', 'visits_study_id_fkey', 'study_id', 'studies', 'RESTRICT', '{study_id,company_id}', '{id,company_id}'),
  ( 45, 'visits', 'visits_subject_id_fkey', 'subject_id', 'subjects', 'CASCADE', '{subject_id,company_id,site_id,study_id}', '{id,company_id,site_id,study_id}'),
  ( 46, 'visits', 'visits_visit_template_item_id_fkey', 'visit_template_item_id', 'visit_template_items', 'SET NULL', '{visit_template_item_id,company_id}', '{id,company_id}'),
  ( 47, 'study_drafts', 'study_drafts_created_by_fkey', 'created_by', 'profiles', 'SET NULL', '{created_by,company_id}', '{id,company_id}'),
  ( 48, 'study_drafts', 'study_drafts_file_id_fkey', 'file_id', 'files', 'RESTRICT', '{file_id,company_id}', '{id,company_id}'),
  ( 49, 'study_drafts', 'study_drafts_study_id_fkey', 'study_id', 'studies', 'SET NULL', '{study_id,company_id}', '{id,company_id}'),
  ( 50, 'visit_history', 'visit_history_changed_by_fkey', 'changed_by', 'profiles', 'SET NULL', '{changed_by,company_id}', '{id,company_id}'),
  ( 51, 'visit_history', 'visit_history_visit_id_fkey', 'visit_id', 'visits', 'CASCADE', '{visit_id,company_id}', '{id,company_id}'),
  ( 52, 'visit_notes', 'visit_notes_created_by_fkey', 'created_by', 'profiles', 'SET NULL', '{created_by,company_id}', '{id,company_id}'),
  ( 53, 'visit_notes', 'visit_notes_visit_id_fkey', 'visit_id', 'visits', 'CASCADE', '{visit_id,company_id}', '{id,company_id}'),
  ( 54, 'calendar_events', 'calendar_events_created_by_fkey', 'created_by', 'profiles', 'SET NULL', '{created_by,company_id}', '{id,company_id}'),
  ( 55, 'calendar_events', 'calendar_events_site_id_fkey', 'site_id', 'sites', 'RESTRICT', '{site_id,company_id}', '{id,company_id}'),
  ( 56, 'subject_contact_info', 'subject_contact_info_created_by_fkey', 'created_by', 'profiles', 'SET NULL', '{created_by,company_id}', '{id,company_id}'),
  ( 57, 'subject_contact_info', 'subject_contact_info_site_id_fkey', 'site_id', 'sites', 'RESTRICT', '{site_id,company_id}', '{id,company_id}'),
  ( 58, 'subject_contact_info', 'subject_contact_info_subject_id_fkey', 'subject_id', 'subjects', 'CASCADE', '{subject_id,company_id,site_id}', '{id,company_id,site_id}'),
  ( 59, 'subject_contact_info', 'subject_contact_info_updated_by_fkey', 'updated_by', 'profiles', 'SET NULL', '{updated_by,company_id}', '{id,company_id}'),
  ( 60, 'appointment_confirmations', 'appointment_confirmations_last_contacted_by_fkey', 'last_contacted_by', 'profiles', 'SET NULL', '{last_contacted_by,company_id}', '{id,company_id}'),
  ( 61, 'appointment_confirmations', 'appointment_confirmations_site_id_fkey', 'site_id', 'sites', 'RESTRICT', '{site_id,company_id}', '{id,company_id}'),
  ( 62, 'appointment_confirmations', 'appointment_confirmations_visit_id_fkey', 'visit_id', 'visits', 'CASCADE', '{visit_id,company_id,site_id}', '{id,company_id,site_id}'),
  ( 63, 'appointment_confirmation_log', 'appointment_confirmation_log_contacted_by_fkey', 'contacted_by', 'profiles', 'SET NULL', '{contacted_by,company_id}', '{id,company_id}'),
  ( 64, 'appointment_confirmation_log', 'appointment_confirmation_log_visit_id_fkey', 'visit_id', 'visits', 'CASCADE', '{visit_id,company_id}', '{id,company_id}'),
  ( 65, 'leads', 'leads_archived_by_fkey', 'archived_by', 'profiles', 'SET NULL', '{archived_by,company_id}', '{id,company_id}'),
  ( 66, 'leads', 'leads_assigned_user_id_fkey', 'assigned_user_id', 'profiles', 'SET NULL', '{assigned_user_id,company_id}', '{id,company_id}'),
  ( 67, 'leads', 'leads_converted_subject_id_fkey', 'converted_subject_id', 'subjects', 'SET NULL', '{converted_subject_id,company_id}', '{id,company_id}'),
  ( 68, 'leads', 'leads_created_by_fkey', 'created_by', 'profiles', 'SET NULL', '{created_by,company_id}', '{id,company_id}'),
  ( 69, 'leads', 'leads_referral_source_id_fkey', 'referral_source_id', 'referral_sources', 'SET NULL', '{referral_source_id,company_id}', '{id,company_id}'),
  ( 70, 'leads', 'leads_site_id_fkey', 'site_id', 'sites', 'RESTRICT', '{site_id,company_id}', '{id,company_id}'),
  ( 71, 'leads', 'leads_study_id_fkey', 'study_id', 'studies', 'SET NULL', '{study_id,company_id}', '{id,company_id}'),
  ( 72, 'leads', 'leads_updated_by_fkey', 'updated_by', 'profiles', 'SET NULL', '{updated_by,company_id}', '{id,company_id}'),
  ( 73, 'lead_contact_info', 'lead_contact_info_created_by_fkey', 'created_by', 'profiles', 'SET NULL', '{created_by,company_id}', '{id,company_id}'),
  ( 74, 'lead_contact_info', 'lead_contact_info_lead_id_fkey', 'lead_id', 'leads', 'CASCADE', '{lead_id,company_id}', '{id,company_id}'),
  ( 75, 'lead_contact_info', 'lead_contact_info_site_id_fkey', 'site_id', 'sites', 'RESTRICT', '{site_id,company_id}', '{id,company_id}'),
  ( 76, 'lead_contact_info', 'lead_contact_info_updated_by_fkey', 'updated_by', 'profiles', 'SET NULL', '{updated_by,company_id}', '{id,company_id}'),
  ( 77, 'lead_contact_log', 'lead_contact_log_contacted_by_fkey', 'contacted_by', 'profiles', 'SET NULL', '{contacted_by,company_id}', '{id,company_id}'),
  ( 78, 'lead_contact_log', 'lead_contact_log_lead_id_fkey', 'lead_id', 'leads', 'CASCADE', '{lead_id,company_id}', '{id,company_id}'),
  ( 79, 'study_prescreening_questions', 'study_prescreening_questions_created_by_fkey', 'created_by', 'profiles', 'SET NULL', '{created_by,company_id}', '{id,company_id}'),
  ( 80, 'study_prescreening_questions', 'study_prescreening_questions_study_id_fkey', 'study_id', 'studies', 'CASCADE', '{study_id,company_id}', '{id,company_id}'),
  ( 81, 'lead_prescreenings', 'lead_prescreenings_completed_by_fkey', 'completed_by', 'profiles', 'SET NULL', '{completed_by,company_id}', '{id,company_id}'),
  ( 82, 'lead_prescreenings', 'lead_prescreenings_lead_id_fkey', 'lead_id', 'leads', 'CASCADE', '{lead_id,company_id}', '{id,company_id}'),
  ( 83, 'lead_prescreenings', 'lead_prescreenings_manual_override_by_fkey', 'manual_override_by', 'profiles', 'SET NULL', '{manual_override_by,company_id}', '{id,company_id}'),
  ( 84, 'lead_prescreenings', 'lead_prescreenings_study_id_fkey', 'study_id', 'studies', 'CASCADE', '{study_id,company_id}', '{id,company_id}'),
  ( 85, 'lead_prescreening_answers', 'lead_prescreening_answers_lead_prescreening_id_fkey', 'lead_prescreening_id', 'lead_prescreenings', 'CASCADE', '{lead_prescreening_id,company_id}', '{id,company_id}'),
  ( 86, 'lead_prescreening_answers', 'lead_prescreening_answers_question_id_fkey', 'question_id', 'study_prescreening_questions', 'SET NULL', '{question_id,company_id}', '{id,company_id}'),
  ( 87, 'regulatory_binders', 'regulatory_binders_site_id_fkey', 'site_id', 'sites', 'CASCADE', '{site_id,company_id}', '{id,company_id}'),
  ( 88, 'regulatory_binders', 'regulatory_binders_study_id_fkey', 'study_id', 'studies', 'CASCADE', '{study_id,company_id}', '{id,company_id}'),
  ( 89, 'regulatory_documents', 'regulatory_documents_document_type_id_fkey', 'document_type_id', 'document_types', 'RESTRICT', '{document_type_id,company_id}', '{id,company_id}'),
  ( 90, 'regulatory_documents', 'regulatory_documents_file_id_fkey', 'file_id', 'files', 'RESTRICT', '{file_id,company_id}', '{id,company_id}'),
  ( 91, 'regulatory_documents', 'regulatory_documents_site_id_fkey', 'site_id', 'sites', 'CASCADE', '{site_id,company_id}', '{id,company_id}'),
  ( 92, 'regulatory_documents', 'regulatory_documents_study_id_fkey', 'study_id', 'studies', 'CASCADE', '{study_id,company_id}', '{id,company_id}'),
  ( 93, 'regulatory_documents', 'regulatory_documents_uploaded_by_fkey', 'uploaded_by', 'profiles', 'SET NULL', '{uploaded_by,company_id}', '{id,company_id}'),
  ( 94, 'staff_documents', 'staff_documents_document_type_id_fkey', 'document_type_id', 'document_types', 'RESTRICT', '{document_type_id,company_id}', '{id,company_id}'),
  ( 95, 'staff_documents', 'staff_documents_file_id_fkey', 'file_id', 'files', 'RESTRICT', '{file_id,company_id}', '{id,company_id}'),
  ( 96, 'staff_documents', 'staff_documents_site_id_fkey', 'site_id', 'sites', 'CASCADE', '{site_id,company_id}', '{id,company_id}'),
  ( 97, 'staff_documents', 'staff_documents_user_id_fkey', 'user_id', 'profiles', 'CASCADE', '{user_id,company_id}', '{id,company_id}'),
  ( 98, 'document_versions', 'document_versions_document_id_fkey', 'document_id', 'regulatory_documents', 'CASCADE', '{document_id,company_id}', '{id,company_id}'),
  ( 99, 'document_versions', 'document_versions_duplicate_of_version_id_fkey', 'duplicate_of_version_id', 'document_versions', 'SET NULL', '{duplicate_of_version_id,company_id}', '{id,company_id}'),
  (100, 'document_versions', 'document_versions_file_id_fkey', 'file_id', 'files', 'RESTRICT', '{file_id,company_id}', '{id,company_id}'),
  (101, 'document_versions', 'document_versions_previous_version_id_fkey', 'previous_version_id', 'document_versions', 'SET NULL', '{previous_version_id,company_id}', '{id,company_id}'),
  (102, 'document_versions', 'document_versions_reviewed_by_fkey', 'reviewed_by', 'profiles', 'SET NULL', '{reviewed_by,company_id}', '{id,company_id}'),
  (103, 'document_versions', 'document_versions_staff_document_id_fkey', 'staff_document_id', 'staff_documents', 'CASCADE', '{staff_document_id,company_id}', '{id,company_id}'),
  (104, 'document_versions', 'document_versions_uploaded_by_fkey', 'uploaded_by', 'profiles', 'RESTRICT', '{uploaded_by,company_id}', '{id,company_id}'),
  (105, 'document_history', 'document_history_changed_by_fkey', 'changed_by', 'profiles', 'SET NULL', '{changed_by,company_id}', '{id,company_id}'),
  (106, 'document_history', 'document_history_document_id_fkey', 'document_id', 'regulatory_documents', 'CASCADE', '{document_id,company_id}', '{id,company_id}'),
  (107, 'document_history', 'document_history_staff_document_id_fkey', 'staff_document_id', 'staff_documents', 'CASCADE', '{staff_document_id,company_id}', '{id,company_id}'),
  (108, 'document_history', 'document_history_version_id_fkey', 'version_id', 'document_versions', 'SET NULL', '{version_id,company_id}', '{id,company_id}'),
  (109, 'lead_notes', 'lead_notes_created_by_fkey', 'created_by', 'profiles', 'SET NULL', '{created_by,company_id}', '{id,company_id}'),
  (110, 'lead_notes', 'lead_notes_lead_id_fkey', 'lead_id', 'leads', 'CASCADE', '{lead_id,company_id}', '{id,company_id}'),
  (111, 'lead_calls', 'lead_calls_created_by_fkey', 'created_by', 'profiles', 'SET NULL', '{created_by,company_id}', '{id,company_id}'),
  (112, 'lead_calls', 'lead_calls_lead_id_fkey', 'lead_id', 'leads', 'CASCADE', '{lead_id,company_id}', '{id,company_id}'),
  (113, 'lead_tasks', 'lead_tasks_assigned_user_id_fkey', 'assigned_user_id', 'profiles', 'SET NULL', '{assigned_user_id,company_id}', '{id,company_id}'),
  (114, 'lead_tasks', 'lead_tasks_completed_by_fkey', 'completed_by', 'profiles', 'SET NULL', '{completed_by,company_id}', '{id,company_id}'),
  (115, 'lead_tasks', 'lead_tasks_created_by_fkey', 'created_by', 'profiles', 'SET NULL', '{created_by,company_id}', '{id,company_id}'),
  (116, 'lead_tasks', 'lead_tasks_lead_id_fkey', 'lead_id', 'leads', 'CASCADE', '{lead_id,company_id}', '{id,company_id}'),
  (117, 'lead_tasks', 'lead_tasks_site_id_fkey', 'site_id', 'sites', 'RESTRICT', '{site_id,company_id}', '{id,company_id}'),
  (118, 'lead_tasks', 'lead_tasks_study_id_fkey', 'study_id', 'studies', 'SET NULL', '{study_id,company_id}', '{id,company_id}'),
  (119, 'lead_status_history', 'lead_status_history_changed_by_fkey', 'changed_by', 'profiles', 'SET NULL', '{changed_by,company_id}', '{id,company_id}'),
  (120, 'lead_status_history', 'lead_status_history_lead_id_fkey', 'lead_id', 'leads', 'CASCADE', '{lead_id,company_id}', '{id,company_id}'),
  (121, 'lead_duplicate_dismissals', 'lead_duplicate_dismissals_dismissed_by_fkey', 'dismissed_by', 'profiles', 'SET NULL', '{dismissed_by,company_id}', '{id,company_id}'),
  (122, 'lead_duplicate_dismissals', 'lead_duplicate_dismissals_lead_id_fkey', 'lead_id', 'leads', 'CASCADE', '{lead_id,company_id}', '{id,company_id}'),
  (123, 'lead_duplicate_dismissals', 'lead_duplicate_dismissals_matched_lead_id_fkey', 'matched_lead_id', 'leads', 'CASCADE', '{matched_lead_id,company_id}', '{id,company_id}'),
  (124, 'file_links', 'file_links_created_by_fkey', 'created_by', 'profiles', 'SET NULL', '{created_by,company_id}', '{id,company_id}'),
  (125, 'file_links', 'file_links_file_id_fkey', 'file_id', 'files', 'RESTRICT', '{file_id,company_id}', '{id,company_id}'),
  (126, 'file_links', 'file_links_site_id_fkey', 'site_id', 'sites', 'CASCADE', '{site_id,company_id}', '{id,company_id}'),
  (127, 'charts', 'charts_entered_by_fkey', 'entered_by', 'profiles', 'SET NULL', '{entered_by,company_id}', '{id,company_id}'),
  (128, 'charts', 'charts_site_id_fkey', 'site_id', 'sites', 'RESTRICT', '{site_id,company_id}', '{id,company_id}'),
  (129, 'charts', 'charts_study_id_fkey', 'study_id', 'studies', 'RESTRICT', '{study_id,company_id}', '{id,company_id}'),
  (130, 'charts', 'charts_subject_id_fkey', 'subject_id', 'subjects', 'CASCADE', '{subject_id,company_id}', '{id,company_id}'),
  (131, 'charts', 'charts_visit_id_fkey', 'visit_id', 'visits', 'RESTRICT', '{visit_id,company_id,site_id,study_id,subject_id}', '{id,company_id,site_id,study_id,subject_id}'),
  (132, 'chart_history', 'chart_history_changed_by_fkey', 'changed_by', 'profiles', 'SET NULL', '{changed_by,company_id}', '{id,company_id}'),
  (133, 'chart_history', 'chart_history_chart_id_fkey', 'chart_id', 'charts', 'CASCADE', '{chart_id,company_id}', '{id,company_id}'),
  (134, 'chart_comments', 'chart_comments_chart_id_fkey', 'chart_id', 'charts', 'CASCADE', '{chart_id,company_id}', '{id,company_id}'),
  (135, 'chart_comments', 'chart_comments_created_by_fkey', 'created_by', 'profiles', 'SET NULL', '{created_by,company_id}', '{id,company_id}'),
  (136, 'chart_metrics', 'chart_metrics_chart_id_fkey', 'chart_id', 'charts', 'CASCADE', '{chart_id,company_id}', '{id,company_id}'),
  (137, 'chart_assignments', 'chart_assignments_assigned_by_fkey', 'assigned_by', 'profiles', 'SET NULL', '{assigned_by,company_id}', '{id,company_id}'),
  (138, 'chart_assignments', 'chart_assignments_assigned_to_fkey', 'assigned_to', 'profiles', 'RESTRICT', '{assigned_to,company_id}', '{id,company_id}'),
  (139, 'chart_assignments', 'chart_assignments_chart_id_fkey', 'chart_id', 'charts', 'CASCADE', '{chart_id,company_id}', '{id,company_id}'),
  (140, 'tasks', 'tasks_assigned_to_fkey', 'assigned_to', 'profiles', 'SET NULL', '{assigned_to,company_id}', '{id,company_id}'),
  (141, 'tasks', 'tasks_site_id_fkey', 'site_id', 'sites', 'RESTRICT', '{site_id,company_id}', '{id,company_id}'),
  (142, 'task_history', 'task_history_changed_by_fkey', 'changed_by', 'profiles', 'SET NULL', '{changed_by,company_id}', '{id,company_id}'),
  (143, 'task_history', 'task_history_task_id_fkey', 'task_id', 'tasks', 'CASCADE', '{task_id,company_id}', '{id,company_id}'),
  (144, 'task_comments', 'task_comments_created_by_fkey', 'created_by', 'profiles', 'SET NULL', '{created_by,company_id}', '{id,company_id}'),
  (145, 'task_comments', 'task_comments_task_id_fkey', 'task_id', 'tasks', 'CASCADE', '{task_id,company_id}', '{id,company_id}');

-- ------------------------------------------------------------
-- 1. Preconditions (read-only; abort on any surprise)
-- ------------------------------------------------------------
DO $$
DECLARE
  r       record;
  v_count integer;
  v_cols  text[];
  v_bad   text := '';
BEGIN
  IF current_setting('server_version_num')::integer < 150000 THEN
    RAISE EXCEPTION '038 precondition failed: PostgreSQL 15 or later is required (ON DELETE SET NULL (column)).';
  END IF;

  -- Exact post-037 state.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_document_history_enforce_attribution'
                   AND tgrelid = 'public.document_history'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_profiles_enforce_update_integrity'
                   AND tgrelid = 'public.profiles'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_profiles_id_company'
                   AND conrelid = 'public.profiles'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_sites_id_company'
                   AND conrelid = 'public.sites'::regclass) THEN
    RAISE EXCEPTION '038 precondition failed: migration 037 is not applied.';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.audit_logs', 'INSERT') THEN
    RAISE EXCEPTION '038 precondition failed: authenticated has no INSERT on public.audit_logs. Apply migration 036 first.';
  END IF;

  -- Not already applied.
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_row_attribution'
               AND pronamespace = 'public'::regnamespace)
     OR EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_files_storage_path_company_prefix') THEN
    RAISE EXCEPTION '038 precondition failed: migration 038 is already applied (enforce_row_attribution or ck_files_storage_path_company_prefix exists).';
  END IF;

  -- Every planned foreign key exists exactly as reviewed (single column,
  -- expected parent, expected ON DELETE, ON UPDATE NO ACTION).
  FOR r IN SELECT p.*, c.oid AS con_oid, c.confrelid, c.confdeltype, c.confupdtype, c.conkey, c.conrelid
           FROM m038_fk_plan p
           LEFT JOIN pg_constraint c
             ON c.conname = p.conname AND c.contype = 'f'
            AND c.conrelid = to_regclass('public.' || p.child)
           ORDER BY p.ord LOOP
    IF r.con_oid IS NULL THEN
      v_bad := v_bad || format(E'\n  missing %s.%s', r.child, r.conname);
      CONTINUE;
    END IF;
    SELECT array_agg(a.attname::text ORDER BY k.ord) INTO v_cols
    FROM unnest(r.conkey) WITH ORDINALITY k(n, ord)
    JOIN pg_attribute a ON a.attrelid = r.conrelid AND a.attnum = k.n;
    IF v_cols <> ARRAY[r.fk_col]
       OR r.confrelid <> to_regclass('public.' || r.parent)
       OR r.confupdtype <> 'a'
       OR r.confdeltype <> (CASE r.on_delete WHEN 'CASCADE' THEN 'c' WHEN 'RESTRICT' THEN 'r'
                                             WHEN 'NO ACTION' THEN 'a' WHEN 'SET NULL' THEN 'n' END) THEN
      v_bad := v_bad || format(E'\n  unexpected definition %s.%s', r.child, r.conname);
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION '038 precondition failed: foreign keys differ from the reviewed post-037 schema:%', v_bad;
  END IF;

  -- Existing rows must already satisfy every new composite foreign key.
  -- (MATCH SIMPLE: a row with any NULL key column is not checked.)
  FOR r IN SELECT * FROM m038_fk_plan ORDER BY ord LOOP
    EXECUTE format(
      'SELECT count(*) FROM public.%I c WHERE %s AND NOT EXISTS (SELECT 1 FROM public.%I p WHERE %s)',
      r.child,
      (SELECT string_agg(format('c.%I IS NOT NULL', col), ' AND ') FROM unnest(r.child_cols) col),
      r.parent,
      (SELECT string_agg(format('p.%I = c.%I', pc, cc), ' AND ')
         FROM unnest(r.parent_cols, r.child_cols) AS u(pc, cc)))
    INTO v_count;
    IF v_count > 0 THEN
      v_bad := v_bad || format(E'\n  %s row(s) in %s violate %s (%s)', v_count, r.child, r.conname,
                               array_to_string(r.child_cols, ', '));
    END IF;
  END LOOP;

  SELECT count(*) INTO v_count FROM public.files f
  WHERE NOT (split_part(f.storage_path, '/', 1) = f.company_id::text
             AND length(f.storage_path) > length(f.company_id::text) + 1
             AND f.storage_path !~ '(^|/)\.{1,2}(/|$)');
  IF v_count > 0 THEN
    v_bad := v_bad || format(E'\n  %s files row(s) have a storage_path outside their company folder', v_count);
  END IF;

  IF v_bad <> '' THEN
    RAISE EXCEPTION '038 precondition failed: existing data violates the new constraints (no data was changed):%', v_bad;
  END IF;
END
$$;

-- ------------------------------------------------------------
-- 2. F6 — can_access_site(): view_all_sites covers OWN-company sites only
-- ------------------------------------------------------------
-- Before: `... OR has_permission('view_all_sites')` returned true for any
-- site id, including another tenant's, so policies such as subjects_insert
-- accepted another tenant's site. Now the site must exist and belong to
-- the caller's active company (current_company_id() is NULL for inactive
-- users or companies), and only then do user_sites or view_all_sites
-- apply. can_access_site(NULL) stays false; every policy on a nullable
-- site column already tests `site_id IS NULL OR can_access_site(site_id)`.
-- Same signature, owner, EXECUTE grants and pinned search_path.
CREATE OR REPLACE FUNCTION public.can_access_site(p_site_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM sites s
    WHERE s.id = p_site_id
      AND s.company_id = current_company_id()
      AND (
        EXISTS (
          SELECT 1 FROM user_sites us
          WHERE us.user_id = auth.uid()
            AND us.site_id = s.id
            AND us.company_id = s.company_id
        )
        OR has_permission('view_all_sites')
      )
  );
$$;

-- ------------------------------------------------------------
-- 3. F12 — user_has_site_access(): no cross-tenant answers
-- ------------------------------------------------------------
-- Callers: the tasks_insert policy, chart_assignment_target_valid() and the
-- 035 task trigger (as the session user), and TaskService through the
-- admin client (service_role, no auth.uid()). A Data API caller now gets
-- an answer only for a user AND a site of its own active company; anything
-- else is false. Trusted server contexts (no auth.uid() and no
-- authenticated/anon JWT role, i.e. service_role or a migration) keep the
-- previous behaviour. The access predicate itself is unchanged.
CREATE OR REPLACE FUNCTION public.user_has_site_access(p_user_id uuid, p_site_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH caller AS (
    SELECT auth.uid() AS uid,
           coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
                    nullif(current_setting('request.jwt.claim.role', true), '')) AS jwt_role
  )
  SELECT
    (
      (c.uid IS NULL AND coalesce(c.jwt_role, '') NOT IN ('authenticated', 'anon'))
      OR (
        EXISTS (SELECT 1 FROM profiles me
                WHERE me.id = p_user_id AND me.company_id = current_company_id())
        AND (p_site_id IS NULL
             OR EXISTS (SELECT 1 FROM sites s
                        WHERE s.id = p_site_id AND s.company_id = current_company_id()))
      )
    )
    AND (
      EXISTS (
        SELECT 1
        FROM user_sites us
        JOIN profiles pr ON pr.id = us.user_id AND pr.company_id = us.company_id
        WHERE us.user_id = p_user_id AND us.site_id = p_site_id
      )
      OR EXISTS (
        SELECT 1
        FROM user_roles ur
        JOIN profiles pr ON pr.id = ur.user_id AND pr.company_id = ur.company_id
        JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.company_id = ur.company_id
        JOIN permissions p ON p.id = rp.permission_id
        WHERE ur.user_id = p_user_id
          AND p.key = 'view_all_sites'
          AND rp.allowed = true
          AND (
            p_site_id IS NULL
            OR EXISTS (SELECT 1 FROM sites s WHERE s.id = p_site_id AND s.company_id = ur.company_id)
          )
      )
    )
  FROM caller c;
$$;

-- ------------------------------------------------------------
-- 4. F6/F7 — composite parent keys and foreign keys
-- ------------------------------------------------------------
-- Parent keys referenced by the plan (profiles and sites already have
-- uq_*_id_company from 037). Each is a small unique btree index; the
-- tables are locked for the duration of the transaction.
ALTER TABLE public.notifications                ADD CONSTRAINT uq_notifications_id_company                UNIQUE (id, company_id);
ALTER TABLE public.studies                      ADD CONSTRAINT uq_studies_id_company                      UNIQUE (id, company_id);
ALTER TABLE public.visit_templates              ADD CONSTRAINT uq_visit_templates_id_company              UNIQUE (id, company_id);
ALTER TABLE public.visit_template_items         ADD CONSTRAINT uq_visit_template_items_id_company         UNIQUE (id, company_id);
ALTER TABLE public.files                        ADD CONSTRAINT uq_files_id_company                        UNIQUE (id, company_id);
ALTER TABLE public.document_types               ADD CONSTRAINT uq_document_types_id_company               UNIQUE (id, company_id);
ALTER TABLE public.subjects                     ADD CONSTRAINT uq_subjects_id_company                     UNIQUE (id, company_id),
                                                ADD CONSTRAINT uq_subjects_id_company_site                UNIQUE (id, company_id, site_id),
                                                ADD CONSTRAINT uq_subjects_id_company_site_study          UNIQUE (id, company_id, site_id, study_id);
ALTER TABLE public.visits                       ADD CONSTRAINT uq_visits_id_company                       UNIQUE (id, company_id),
                                                ADD CONSTRAINT uq_visits_id_company_site                  UNIQUE (id, company_id, site_id),
                                                ADD CONSTRAINT uq_visits_id_company_site_study_subject    UNIQUE (id, company_id, site_id, study_id, subject_id);
ALTER TABLE public.referral_sources             ADD CONSTRAINT uq_referral_sources_id_company             UNIQUE (id, company_id);
ALTER TABLE public.leads                        ADD CONSTRAINT uq_leads_id_company                        UNIQUE (id, company_id);
ALTER TABLE public.study_prescreening_questions ADD CONSTRAINT uq_study_prescreening_questions_id_company UNIQUE (id, company_id);
ALTER TABLE public.lead_prescreenings           ADD CONSTRAINT uq_lead_prescreenings_id_company           UNIQUE (id, company_id);
ALTER TABLE public.regulatory_documents         ADD CONSTRAINT uq_regulatory_documents_id_company         UNIQUE (id, company_id);
ALTER TABLE public.staff_documents              ADD CONSTRAINT uq_staff_documents_id_company              UNIQUE (id, company_id);
ALTER TABLE public.document_versions            ADD CONSTRAINT uq_document_versions_id_company            UNIQUE (id, company_id);
ALTER TABLE public.charts                       ADD CONSTRAINT uq_charts_id_company                       UNIQUE (id, company_id);
ALTER TABLE public.tasks                        ADD CONSTRAINT uq_tasks_id_company                        UNIQUE (id, company_id);

-- Replace each planned foreign key, keeping its name and ON DELETE action
-- (ON UPDATE NO ACTION, MATCH SIMPLE, not deferrable, as before).
-- Validation re-checks every row (section 1 already counted violations).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM m038_fk_plan ORDER BY ord LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', r.child, r.conname);
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%s) REFERENCES public.%I (%s) ON DELETE %s',
      r.child, r.conname,
      (SELECT string_agg(format('%I', col), ', ' ORDER BY o) FROM unnest(r.child_cols) WITH ORDINALITY u(col, o)),
      r.parent,
      (SELECT string_agg(format('%I', col), ', ' ORDER BY o) FROM unnest(r.parent_cols) WITH ORDINALITY u(col, o)),
      CASE WHEN r.on_delete = 'SET NULL' THEN format('SET NULL (%I)', r.fk_col) ELSE r.on_delete END);
  END LOOP;
END
$$;

-- ------------------------------------------------------------
-- 5. F13 — files.storage_path stays inside the row's company folder
-- ------------------------------------------------------------
-- Every application upload path builds `<company_id>/...` (FileService,
-- StudyService, SubjectService, AIDraftService, RegulatoryDocumentService,
-- StaffCredentialService). A CHECK constraint applies to every role,
-- including service_role. This does not change Storage bucket policies and
-- does not add site-level Storage read isolation (043).
ALTER TABLE public.files
  ADD CONSTRAINT ck_files_storage_path_company_prefix CHECK (
    split_part(storage_path, '/', 1) = company_id::text
    AND length(storage_path) > length(company_id::text) + 1
    AND storage_path !~ '(^|/)\.{1,2}(/|$)'
  );

-- ------------------------------------------------------------
-- 6. F1/F3 — derived attribution for Data API writes
-- ------------------------------------------------------------
-- One generic BEFORE INSERT OR UPDATE trigger function, configured per
-- table with rules of the form 'kind:actor_column:timestamp_column':
--
--   creator  INSERT: actor must be NULL or the caller; it is set to
--            auth.uid() and the timestamp (if named) to now().
--            UPDATE: actor and timestamp are immutable.
--   editor   INSERT/UPDATE: actor is set to auth.uid(); a supplied
--            different user raises.
--   event    When the actor is set (INSERT with a non-NULL actor, or an
--            UPDATE that changes the actor or the timestamp while the
--            actor is non-NULL): actor must be the caller and the
--            timestamp is set to now(). Clearing the actor is not
--            restricted here (state rules are 039).
--
-- Business dates that users legitimately enter are NOT rule columns:
-- subject_timeline.event_date, lead_calls.started_at/ended_at,
-- leads.last_contacted_at, *.next_contact_at, lead_tasks.due_at.
-- Applies only to Data API roles; service_role/migrations pass through.
-- Not SECURITY DEFINER: it reads only NEW/OLD and auth.uid().
CREATE FUNCTION public.enforce_row_attribution()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid   uuid;
  v_new   jsonb;
  v_old   jsonb;
  v_patch jsonb := '{}'::jsonb;
  v_rule  text[];
  v_actor text;
  v_ts    text;
  i       integer;
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION '%: an authenticated user is required', TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;

  v_new := to_jsonb(NEW);
  IF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD);
  END IF;

  FOR i IN 0 .. TG_NARGS - 1 LOOP
    v_rule  := string_to_array(TG_ARGV[i], ':');
    v_actor := nullif(v_rule[2], '');
    v_ts    := nullif(v_rule[3], '');

    IF v_rule[1] = 'creator' THEN
      IF TG_OP = 'INSERT' THEN
        IF (v_new ->> v_actor) IS NOT NULL AND (v_new ->> v_actor)::uuid <> v_uid THEN
          RAISE EXCEPTION '%: % must be the current user', TG_TABLE_NAME, v_actor USING ERRCODE = '42501';
        END IF;
        v_patch := v_patch || jsonb_build_object(v_actor, v_uid);
        IF v_ts IS NOT NULL THEN
          v_patch := v_patch || jsonb_build_object(v_ts, now());
        END IF;
      ELSIF v_new -> v_actor IS DISTINCT FROM v_old -> v_actor
            OR (v_ts IS NOT NULL AND v_new -> v_ts IS DISTINCT FROM v_old -> v_ts) THEN
        RAISE EXCEPTION '%: % and % cannot be changed', TG_TABLE_NAME, v_actor, coalesce(v_ts, '-')
          USING ERRCODE = '42501';
      END IF;

    ELSIF v_rule[1] = 'editor' THEN
      IF (v_new ->> v_actor) IS NOT NULL AND (v_new ->> v_actor)::uuid <> v_uid
         AND (TG_OP = 'INSERT' OR v_new -> v_actor IS DISTINCT FROM v_old -> v_actor) THEN
        RAISE EXCEPTION '%: % must be the current user', TG_TABLE_NAME, v_actor USING ERRCODE = '42501';
      END IF;
      v_patch := v_patch || jsonb_build_object(v_actor, v_uid);

    ELSIF v_rule[1] = 'event' THEN
      IF (v_new ->> v_actor) IS NOT NULL
         AND (TG_OP = 'INSERT'
              OR v_new -> v_actor IS DISTINCT FROM v_old -> v_actor
              OR v_new -> v_ts IS DISTINCT FROM v_old -> v_ts) THEN
        IF (v_new ->> v_actor)::uuid <> v_uid THEN
          RAISE EXCEPTION '%: % must be the current user', TG_TABLE_NAME, v_actor USING ERRCODE = '42501';
        END IF;
        v_patch := v_patch || jsonb_build_object(v_ts, now());
      END IF;

    ELSE
      RAISE EXCEPTION 'enforce_row_attribution: unknown rule "%" on %', TG_ARGV[i], TG_TABLE_NAME;
    END IF;
  END LOOP;

  IF v_patch <> '{}'::jsonb THEN
    NEW := jsonb_populate_record(NEW, v_patch);
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger functions are never called directly and need no EXECUTE to fire.
REVOKE ALL ON FUNCTION public.enforce_row_attribution() FROM PUBLIC, anon, authenticated;

-- Ledgers and logs (append-only; INSERT is the only Data API write).
CREATE TRIGGER trg_audit_logs_enforce_attribution BEFORE INSERT OR UPDATE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:user_id:created_at');
CREATE TRIGGER trg_subject_status_history_enforce_attribution BEFORE INSERT OR UPDATE ON public.subject_status_history
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:changed_by:changed_at');
CREATE TRIGGER trg_subject_timeline_enforce_attribution BEFORE INSERT OR UPDATE ON public.subject_timeline
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:created_by:created_at');
CREATE TRIGGER trg_subject_notes_enforce_attribution BEFORE INSERT OR UPDATE ON public.subject_notes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:created_by:created_at');
CREATE TRIGGER trg_chart_history_enforce_attribution BEFORE INSERT OR UPDATE ON public.chart_history
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:changed_by:changed_at');
CREATE TRIGGER trg_chart_comments_enforce_attribution BEFORE INSERT OR UPDATE ON public.chart_comments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:created_by:created_at');
CREATE TRIGGER trg_visit_history_enforce_attribution BEFORE INSERT OR UPDATE ON public.visit_history
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:changed_by:changed_at');
CREATE TRIGGER trg_visit_notes_enforce_attribution BEFORE INSERT OR UPDATE ON public.visit_notes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:created_by:created_at');
CREATE TRIGGER trg_appointment_confirmation_log_enforce_attribution BEFORE INSERT OR UPDATE ON public.appointment_confirmation_log
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:contacted_by:contacted_at');
CREATE TRIGGER trg_lead_status_history_enforce_attribution BEFORE INSERT OR UPDATE ON public.lead_status_history
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:changed_by:changed_at');
CREATE TRIGGER trg_lead_calls_enforce_attribution BEFORE INSERT OR UPDATE ON public.lead_calls
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:created_by:created_at');
CREATE TRIGGER trg_lead_contact_log_enforce_attribution BEFORE INSERT OR UPDATE ON public.lead_contact_log
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:contacted_by:contacted_at');
CREATE TRIGGER trg_lead_notes_enforce_attribution BEFORE INSERT OR UPDATE ON public.lead_notes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:created_by:created_at');
CREATE TRIGGER trg_lead_duplicate_dismissals_enforce_attribution BEFORE INSERT OR UPDATE ON public.lead_duplicate_dismissals
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:dismissed_by:dismissed_at');
-- task_history/task_comments: the 035 policies already pin the actor to
-- auth.uid(); this adds the server-side timestamp.
CREATE TRIGGER trg_task_history_enforce_attribution BEFORE INSERT OR UPDATE ON public.task_history
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:changed_by:changed_at');
CREATE TRIGGER trg_task_comments_enforce_attribution BEFORE INSERT OR UPDATE ON public.task_comments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:created_by:created_at');

-- Files and document links.
CREATE TRIGGER trg_files_enforce_attribution BEFORE INSERT OR UPDATE ON public.files
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:uploaded_by:uploaded_at');
CREATE TRIGGER trg_file_links_enforce_attribution BEFORE INSERT OR UPDATE ON public.file_links
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:created_by:created_at');
CREATE TRIGGER trg_subject_documents_enforce_attribution BEFORE INSERT OR UPDATE ON public.subject_documents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:uploaded_by:uploaded_at');
CREATE TRIGGER trg_study_documents_enforce_attribution BEFORE INSERT OR UPDATE ON public.study_documents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:uploaded_by:created_at');

-- Business records with a creator, a last editor and/or event actors.
CREATE TRIGGER trg_studies_enforce_attribution BEFORE INSERT OR UPDATE ON public.studies
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:created_by:created_at');
CREATE TRIGGER trg_study_drafts_enforce_attribution BEFORE INSERT OR UPDATE ON public.study_drafts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:created_by:created_at');
CREATE TRIGGER trg_study_prescreening_questions_enforce_attribution BEFORE INSERT OR UPDATE ON public.study_prescreening_questions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:created_by:created_at');
CREATE TRIGGER trg_study_ai_extractions_enforce_attribution BEFORE INSERT OR UPDATE ON public.study_ai_extractions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('event:reviewed_by:reviewed_at');
CREATE TRIGGER trg_visit_templates_enforce_attribution BEFORE INSERT OR UPDATE ON public.visit_templates
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:created_by:created_at', 'event:approved_by:approved_at');
CREATE TRIGGER trg_subjects_enforce_attribution BEFORE INSERT OR UPDATE ON public.subjects
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:created_by:created_at');
CREATE TRIGGER trg_subject_contact_info_enforce_attribution BEFORE INSERT OR UPDATE ON public.subject_contact_info
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:created_by:created_at', 'editor:updated_by:');
CREATE TRIGGER trg_visits_enforce_attribution BEFORE INSERT OR UPDATE ON public.visits
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:created_by:created_at');
CREATE TRIGGER trg_calendar_events_enforce_attribution BEFORE INSERT OR UPDATE ON public.calendar_events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:created_by:created_at');
CREATE TRIGGER trg_appointment_confirmations_enforce_attribution BEFORE INSERT OR UPDATE ON public.appointment_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('event:last_contacted_by:last_contacted_at');
CREATE TRIGGER trg_charts_enforce_attribution BEFORE INSERT OR UPDATE ON public.charts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('event:entered_by:entered_in_edc_date');
CREATE TRIGGER trg_leads_enforce_attribution BEFORE INSERT OR UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:created_by:created_at', 'editor:updated_by:', 'event:archived_by:archived_at');
CREATE TRIGGER trg_lead_contact_info_enforce_attribution BEFORE INSERT OR UPDATE ON public.lead_contact_info
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:created_by:created_at', 'editor:updated_by:');
CREATE TRIGGER trg_lead_tasks_enforce_attribution BEFORE INSERT OR UPDATE ON public.lead_tasks
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:created_by:created_at', 'event:completed_by:completed_at');
CREATE TRIGGER trg_lead_prescreenings_enforce_attribution BEFORE INSERT OR UPDATE ON public.lead_prescreenings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('event:completed_by:completed_at', 'event:manual_override_by:manual_override_at');

-- ------------------------------------------------------------
-- 7. F3/F7 — child records require access to their parent chart/visit
-- ------------------------------------------------------------
-- The other child ledgers already check their parent (can_access_subject,
-- can_access_visit, can_access_lead, can_access_document_parent). These
-- four checked company and permission only. The application writes each
-- of them right after an RLS-checked read or update of the same parent;
-- the one exception is ChartService.addComment, which resolves the chart
-- with the admin client and does not check site access, so a comment on a
-- chart of a site the commenter cannot access is now refused (intended:
-- site isolation, CLAUDE.md domain rules).
ALTER POLICY chart_history_insert ON public.chart_history
  WITH CHECK (
    company_id = current_company_id()
    AND (has_permission('edit_subject') OR has_permission('mark_chart_ready')
         OR has_permission('mark_chart_entered') OR has_permission('reopen_chart'))
    AND can_access_chart(chart_id)
  );

ALTER POLICY chart_comments_insert ON public.chart_comments
  WITH CHECK (
    company_id = current_company_id()
    AND has_permission('comment_chart')
    AND can_access_chart(chart_id)
  );

ALTER POLICY visit_history_insert ON public.visit_history
  WITH CHECK (
    company_id = current_company_id()
    AND has_permission('manage_visits')
    AND can_access_visit(visit_id)
  );

ALTER POLICY appointment_confirmation_log_insert ON public.appointment_confirmation_log
  WITH CHECK (
    company_id = current_company_id()
    AND has_permission('edit_subject_phi')
    AND can_access_visit(visit_id)
  );

-- ------------------------------------------------------------
-- 8. F15 — pin the search_path of the 035 task trigger function
-- ------------------------------------------------------------
-- Behaviour unchanged: every object it references lives in public.
ALTER FUNCTION public.enforce_task_update_invariants() SET search_path = public, pg_temp;

-- ------------------------------------------------------------
-- 9. Postconditions
-- ------------------------------------------------------------
DO $$
DECLARE
  r       record;
  v_count integer;
  v_rule  text;
  v_col   text;
  v_bad   text := '';
BEGIN
  -- Every planned FK is now the planned composite key.
  FOR r IN SELECT p.*, c.oid AS con_oid,
                  (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(n, ord)
                     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n) AS cols,
                  (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(n, ord)
                     JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n) AS pcols
           FROM m038_fk_plan p
           LEFT JOIN pg_constraint c ON c.conname = p.conname AND c.contype = 'f'
                                    AND c.conrelid = to_regclass('public.' || p.child) LOOP
    IF r.con_oid IS NULL OR r.cols <> r.child_cols OR r.pcols <> r.parent_cols THEN
      v_bad := v_bad || format(E'\n  %s.%s', r.child, r.conname);
    END IF;
  END LOOP;

  -- No id-only link between two company-scoped tables remains in public.
  SELECT count(*) INTO v_count
  FROM pg_constraint c
  WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
    AND c.confrelid <> 'public.companies'::regclass
    AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attname = 'company_id' AND NOT a.attisdropped)
    AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.confrelid AND a.attname = 'company_id' AND NOT a.attisdropped)
    AND NOT EXISTS (SELECT 1 FROM unnest(c.conkey) k JOIN pg_attribute a
                    ON a.attrelid = c.conrelid AND a.attnum = k WHERE a.attname = 'company_id');
  IF v_count <> 0 THEN
    v_bad := v_bad || format(E'\n  %s id-only company-scoped foreign key(s) remain', v_count);
  END IF;

  -- Every attribution rule names an existing uuid/timestamptz column.
  FOR r IN SELECT t.tgrelid, t.tgname, t.tgargs FROM pg_trigger t
           WHERE t.tgname LIKE 'trg\_%\_enforce\_attribution' AND NOT t.tgisinternal
             AND t.tgfoid = 'public.enforce_row_attribution()'::regprocedure LOOP
    FOREACH v_rule IN ARRAY regexp_split_to_array(encode(r.tgargs, 'escape'), '\\000') LOOP
      CONTINUE WHEN v_rule = '';
      FOREACH v_col IN ARRAY (string_to_array(v_rule, ':'))[2:3] LOOP
        CONTINUE WHEN v_col = '';
        IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = r.tgrelid AND a.attname = v_col
                         AND NOT a.attisdropped AND a.atttypid IN ('uuid'::regtype, 'timestamptz'::regtype)) THEN
          v_bad := v_bad || format(E'\n  %s: rule %s names a missing column %s', r.tgname, v_rule, v_col);
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  SELECT count(*) INTO v_count FROM pg_trigger
  WHERE tgfoid = 'public.enforce_row_attribution()'::regprocedure AND NOT tgisinternal;
  IF v_count <> 35 THEN
    v_bad := v_bad || format(E'\n  expected 35 attribution triggers, found %s', v_count);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.enforce_task_update_invariants()'::regprocedure
                   AND proconfig @> ARRAY['search_path=public, pg_temp']) THEN
    v_bad := v_bad || E'\n  enforce_task_update_invariants search_path not pinned';
  END IF;

  IF v_bad <> '' THEN
    RAISE EXCEPTION '038 postcondition failed:%', v_bad;
  END IF;
END
$$;

COMMIT;

-- ROLLBACK: see G8_M038_Rollback_Recovery_Plan.md. Prefer a forward fix;
-- reverting re-opens F1/F3/F6/F7(write)/F12/F13 and must not be done on a
-- project with real users.
