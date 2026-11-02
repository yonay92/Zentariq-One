-- ============================================================
-- Migration 036 — Explicit, least-privilege Data API table grants
-- ============================================================
--
-- CONTEXT (G7 Production Authentication Diagnostic, 2026-11-02): Supabase
-- changed its platform defaults so that tables in the `public` schema are no
-- longer exposed to the Data API automatically (opt-in from 2026-04-28,
-- default for every NEW project from 2026-05-30, applied to NEW tables in
-- existing projects from 2026-10-30). On such a project the default ACL for
-- tables created by `postgres` gives `anon`, `authenticated` and
-- `service_role` only TRUNCATE/REFERENCES/TRIGGER/MAINTAIN — no SELECT,
-- INSERT, UPDATE or DELETE. Migrations 001–035 never contained table-level
-- GRANTs (older projects granted everything to all three roles by
-- default), so on the Private Test project every PostgREST query fails with
-- `42501 permission denied` — including the post-login `profiles` read —
-- even for `service_role` (which bypasses RLS but NOT table privileges).
--
-- DESIGN — explicit least-privilege matrix, derived from the application:
--   * Every grant below is backed by a concrete access path in the code:
--     a `.from('<table>')` call on the session client (`authenticated`) or
--     the admin client / Edge Functions (`service_role`), a PostgREST
--     embedded resource, an RLS policy subquery, Realtime
--     (`notifications`), or a SECURITY INVOKER function/trigger
--     (`complete_visit_with_chart`, `enforce_task_update_invariants`,
--     `record_task_reassignment_history`).
--   * UPDATE/DELETE imply SELECT (PostgREST filters are WHERE clauses that
--     read the filtered columns). Upserts that use ON CONFLICT DO UPDATE
--     need UPDATE even on the insert path; `ignoreDuplicates` upserts
--     (ON CONFLICT DO NOTHING) do not.
--   * `authenticated` only receives an operation for which an RLS policy
--     exists (RLS stays the row-level guard; a grant without a policy would
--     grant nothing), except `lead_duplicate_dismissals` UPDATE, which
--     Postgres requires at plan time for its DO UPDATE upsert — there is no
--     UPDATE policy, so RLS still rejects the conflict/update path exactly
--     as before.
--   * Append-only ledgers (audit, history, timeline, logs, comments, notes)
--     get SELECT/INSERT at most — never UPDATE or DELETE.
--   * `document_versions` rows are permanent (migration 016): UPDATE is
--     granted only on the four workflow columns the application changes
--     (status, is_current, reviewed_by, reviewed_at); file, checksum and
--     version columns stay immutable at the privilege level.
--   * `anon` receives NOTHING. Sign-in goes through Supabase Auth, and the
--     only unauthenticated table reads (invitation validation/acceptance)
--     use `service_role` on the server.
--   * Not exposed to the Data API at all (no application access path):
--     `migration_reconciliation_log`, `regulatory_binders`,
--     `subject_milestones`; `notification_email_queue` and
--     `chart_assignments` are server-side (`service_role`) only.
--   * Purely additive: no REVOKE, no ALTER DEFAULT PRIVILEGES, no grants on
--     `auth`, `storage` or any other schema, no SECURITY DEFINER functions,
--     no policy changes. Projects created before the platform change
--     already hold broader legacy grants; this migration does not narrow
--     them (see the PR for that follow-up decision).
--   * Sequences: none exist in `public` (UUID keys everywhere), so no
--     sequence grants are needed.
--
-- RULE FOR FUTURE MIGRATIONS: every new `public` table must ship its own
-- explicit GRANTs (and RLS policies) in the migration that creates it.
-- ============================================================

BEGIN;

-- ============================================================
-- 0. Safety gate — refuse to expose any table without RLS.
-- ============================================================

DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO v_missing
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relkind IN ('r', 'p')
     AND NOT c.relrowsecurity;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'migration 036: RLS is disabled on public table(s): %', v_missing;
  END IF;
END
$$;

-- ============================================================
-- 1. Tenant, identity and authorization tables
-- ============================================================

GRANT SELECT                         ON public.companies          TO authenticated;

GRANT SELECT                         ON public.company_settings   TO authenticated;
GRANT UPDATE                         ON public.company_settings   TO authenticated;
GRANT SELECT, INSERT, UPDATE         ON public.company_settings   TO service_role;

GRANT SELECT                         ON public.company_modules    TO authenticated;
GRANT SELECT, INSERT, UPDATE         ON public.company_modules    TO service_role;

GRANT SELECT, UPDATE                 ON public.profiles           TO authenticated;
GRANT SELECT, INSERT, UPDATE         ON public.profiles           TO service_role;

GRANT SELECT                         ON public.roles              TO authenticated;
GRANT SELECT, INSERT                 ON public.roles              TO service_role;

GRANT SELECT                         ON public.permissions        TO authenticated;
GRANT SELECT                         ON public.permissions        TO service_role;

GRANT SELECT, INSERT, UPDATE         ON public.role_permissions   TO authenticated;
GRANT SELECT, INSERT, UPDATE         ON public.role_permissions   TO service_role;

GRANT SELECT, INSERT, DELETE         ON public.user_roles         TO authenticated;
GRANT SELECT, INSERT                 ON public.user_roles         TO service_role;

GRANT SELECT, INSERT, UPDATE         ON public.sites              TO authenticated;
GRANT SELECT                         ON public.sites              TO service_role;

GRANT SELECT, INSERT, DELETE         ON public.user_sites         TO authenticated;
GRANT SELECT, INSERT                 ON public.user_sites         TO service_role;

GRANT SELECT                         ON public.user_invitations   TO authenticated;
GRANT SELECT, INSERT, UPDATE         ON public.user_invitations   TO service_role;

-- Append-only: insert only, never read back, updated or deleted via the API.
GRANT INSERT                         ON public.audit_logs         TO authenticated;
GRANT INSERT                         ON public.audit_logs         TO service_role;

-- ============================================================
-- 2. Studies, sites and visit templates
-- ============================================================

GRANT SELECT, INSERT, UPDATE         ON public.studies                      TO authenticated;

GRANT SELECT, INSERT, DELETE         ON public.study_sites                  TO authenticated;
GRANT SELECT                         ON public.study_sites                  TO service_role;

GRANT SELECT                         ON public.study_staff                  TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.study_drafts                 TO authenticated;
GRANT SELECT, UPDATE                 ON public.study_drafts                 TO service_role;

GRANT SELECT, UPDATE                 ON public.study_ai_extractions         TO authenticated;
GRANT SELECT, INSERT                 ON public.study_ai_extractions         TO service_role;

GRANT SELECT, INSERT, UPDATE         ON public.study_prescreening_questions TO authenticated;

GRANT SELECT, INSERT, UPDATE         ON public.study_document_requirements  TO authenticated;

GRANT SELECT, INSERT                 ON public.study_documents              TO authenticated;

GRANT SELECT, INSERT, UPDATE         ON public.visit_templates              TO authenticated;

GRANT SELECT, INSERT                 ON public.visit_template_items         TO authenticated;

-- ============================================================
-- 3. Subjects, visits and calendar
-- ============================================================

GRANT SELECT, INSERT, UPDATE         ON public.subjects                     TO authenticated;

GRANT SELECT, INSERT, UPDATE         ON public.subject_contact_info         TO authenticated;
GRANT INSERT                         ON public.subject_contact_info         TO service_role;

GRANT SELECT, INSERT                 ON public.subject_documents            TO authenticated;
GRANT SELECT, INSERT                 ON public.subject_notes                TO authenticated;
GRANT SELECT, INSERT                 ON public.subject_status_history       TO authenticated;

GRANT SELECT, INSERT                 ON public.subject_timeline             TO authenticated;
GRANT INSERT                         ON public.subject_timeline             TO service_role;

GRANT SELECT, INSERT, UPDATE         ON public.visits                       TO authenticated;
GRANT SELECT, UPDATE                 ON public.visits                       TO service_role;

GRANT INSERT                         ON public.visit_history                TO authenticated;
GRANT SELECT, INSERT                 ON public.visit_notes                  TO authenticated;

GRANT SELECT, INSERT, UPDATE         ON public.calendar_events              TO authenticated;
GRANT SELECT, INSERT, UPDATE         ON public.appointment_confirmations    TO authenticated;
GRANT INSERT                         ON public.appointment_confirmation_log TO authenticated;

-- ============================================================
-- 4. Charts and Task Engine
-- ============================================================

GRANT SELECT, INSERT, UPDATE         ON public.charts            TO authenticated;
GRANT SELECT                         ON public.charts            TO service_role;

GRANT SELECT                         ON public.chart_assignments TO service_role;

GRANT SELECT, INSERT                 ON public.chart_comments    TO authenticated;
GRANT SELECT, INSERT                 ON public.chart_history     TO authenticated;
GRANT SELECT, INSERT, UPDATE         ON public.chart_metrics     TO authenticated;

GRANT SELECT, INSERT, UPDATE         ON public.tasks             TO authenticated;
GRANT SELECT, INSERT, UPDATE         ON public.tasks             TO service_role;

GRANT SELECT, INSERT                 ON public.task_comments     TO authenticated;

GRANT SELECT, INSERT                 ON public.task_history      TO authenticated;
GRANT INSERT                         ON public.task_history      TO service_role;

-- ============================================================
-- 5. Recruitment CRM
-- ============================================================

GRANT SELECT, INSERT, UPDATE         ON public.leads                     TO authenticated;
GRANT SELECT, INSERT, UPDATE         ON public.lead_contact_info         TO authenticated;
GRANT SELECT, INSERT, UPDATE         ON public.lead_notes                TO authenticated;
GRANT SELECT, INSERT, UPDATE         ON public.lead_tasks                TO authenticated;
GRANT SELECT, INSERT, UPDATE         ON public.lead_prescreenings        TO authenticated;
GRANT SELECT, INSERT                 ON public.lead_prescreening_answers TO authenticated;
GRANT SELECT, INSERT                 ON public.lead_calls                TO authenticated;
GRANT SELECT, INSERT                 ON public.lead_contact_log          TO authenticated;
GRANT SELECT, INSERT                 ON public.lead_status_history       TO authenticated;
-- UPDATE is required by the ON CONFLICT DO UPDATE upsert in
-- LeadDuplicateService.dismissDuplicate; no UPDATE policy exists, so RLS
-- still rejects the update path.
GRANT SELECT, INSERT, UPDATE         ON public.lead_duplicate_dismissals TO authenticated;
GRANT SELECT, INSERT, UPDATE         ON public.referral_sources          TO authenticated;

-- ============================================================
-- 6. Regulatory and Document Center
-- ============================================================

GRANT SELECT, INSERT, UPDATE         ON public.regulatory_documents TO authenticated;
GRANT SELECT, UPDATE                 ON public.regulatory_documents TO service_role;

GRANT SELECT, INSERT, UPDATE         ON public.staff_documents      TO authenticated;
GRANT SELECT, UPDATE                 ON public.staff_documents      TO service_role;

GRANT SELECT, INSERT, UPDATE         ON public.document_types       TO authenticated;
GRANT SELECT, INSERT, UPDATE         ON public.document_types       TO service_role;

-- Versions are permanent: only the review/supersede workflow columns change.
GRANT SELECT, INSERT                 ON public.document_versions    TO authenticated;
GRANT UPDATE (status, is_current, reviewed_by, reviewed_at)
                                     ON public.document_versions    TO authenticated;

GRANT SELECT, INSERT                 ON public.document_history     TO authenticated;
GRANT INSERT                         ON public.document_history     TO service_role;

GRANT SELECT, INSERT                 ON public.files                TO authenticated;
GRANT SELECT, UPDATE                 ON public.files                TO service_role;

GRANT SELECT, INSERT, DELETE         ON public.file_links           TO authenticated;
GRANT SELECT, INSERT, DELETE         ON public.file_links           TO service_role;

-- ============================================================
-- 7. Notifications
-- ============================================================

-- SELECT also backs the browser Realtime subscription (hooks/useNotifications.ts).
GRANT SELECT, UPDATE                 ON public.notifications            TO authenticated;
GRANT SELECT, INSERT                 ON public.notifications            TO service_role;

GRANT SELECT, INSERT, UPDATE         ON public.notification_preferences TO authenticated;
GRANT SELECT, INSERT                 ON public.notification_preferences TO service_role;

GRANT SELECT, INSERT, UPDATE         ON public.notification_email_queue TO service_role;

COMMIT;

-- ============================================================
-- ROLLBACK (manual, if ever needed): re-run the GRANTs above as REVOKEs,
-- e.g. `REVOKE SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA
-- public FROM authenticated, service_role;` — ONLY on a project created
-- after the 2026-05-30 platform change. On older projects that statement
-- would also strip the legacy default grants the application relies on.
-- Never run it without an owner-approved plan.
-- ============================================================
