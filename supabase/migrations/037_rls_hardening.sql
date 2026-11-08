-- ============================================================
-- Migration 037 — RLS, tenant-isolation, site-isolation and regulated
-- document integrity hardening (G7)
-- ============================================================
--
-- CONTEXT: the G7 final security review of PR #14 (migration 036) found
-- that 036 itself is correct, but that it is the switch that makes the
-- existing RLS policies the ONLY data-layer guard on post-2026-05-30
-- projects. Several pre-existing policy/schema weaknesses then become
-- reachable through the Data API (and are already reachable today on
-- legacy projects, which carry broad default grants). This migration fixes
-- them at the database boundary, so that a direct PostgREST call with a
-- user's JWT cannot do what the application would refuse:
--
--   H1  Deactivated/suspended users kept full RLS access and could
--       reactivate themselves (`profiles_update_own` had no column or
--       value restriction; `current_company_id()` ignored status).
--   M1  `role_permissions` / `user_roles` could reference another
--       tenant's role (single-column FKs; `has_permission()` did not join
--       on company).
--   M2  `company_settings_update` let ANY company member update settings,
--       defeating `company_settings_update_admin`; no INSERT policy (I2).
--   M3  15 child tables enforced company but not site isolation.
--   M5  `document_versions` reviewer attribution, timestamps and status
--       transitions were unconstrained, and `regulatory_documents.status`
--       could be set to 'current' directly without an approved version
--       (PR #16 final audit).
--   L1  `tasks_insert` compared `pr.company_id = company_id`, which
--       resolves to `pr.company_id = pr.company_id` inside the subquery;
--       `user_has_site_access()` had no company filter.
--   L2  `notifications` was UPDATE-able on every column.
--   L5  four SECURITY DEFINER helpers had no fixed search_path; several
--       functions were EXECUTE-able by PUBLIC/anon.
--
-- DESIGN PRINCIPLES:
--   * Fail closed. Every company-scoped policy calls current_company_id();
--     making it return NULL for an inactive user or company revokes all
--     tenant data access in one place, without touching 160+ policies.
--   * Database-enforced integrity where the schema allows it (composite
--     foreign keys), triggers where a value rule is needed, and policy
--     predicates for row visibility.
--   * Trusted boundary: the integrity triggers apply to Data API callers
--     (`authenticated`/`anon`). `service_role` (server code that has already
--     authorized the request) and migration roles are unaffected, which
--     keeps the invitation, provisioning and Edge Function flows unchanged.
--   * Site isolation for child tables goes through small SECURITY DEFINER
--     helpers that answer exactly one question for the CALLER ("may I
--     access this parent record by company and site?"). They return a
--     boolean, take no role/user parameter, read parents as the owner (so
--     there is no recursive RLS evaluation) and leave the existing
--     per-table permission checks untouched.
--   * Preserves every legitimate application flow (verified against the
--     session-client code paths on main and PR #15).
--
-- NOT CHANGED HERE (owner decisions, see the G7 hardening report):
--   M4 (direct Data API bypasses app validation/BRE/audit — architecture),
--   L3 (invitation token readable — requires an application change),
--   L4 (files metadata visibility — product decision),
--   L6 (platform default TRUNCATE/REFERENCES/TRIGGER/MAINTAIN ACL).
--
-- PRECONDITIONS: migration 036 (or legacy grants) present; no existing
-- cross-company role/user/site references. Both are checked below and the
-- whole migration aborts with an explicit message if either fails.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 0. Preconditions
-- ------------------------------------------------------------
DO $$
DECLARE
  v_count integer;
BEGIN
  IF NOT has_table_privilege('authenticated', 'public.profiles', 'SELECT') THEN
    RAISE EXCEPTION '037 precondition failed: authenticated has no SELECT on public.profiles. Apply migration 036 first.';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
  WHERE r.company_id <> ur.company_id;
  IF v_count > 0 THEN
    RAISE EXCEPTION '037 precondition failed: % user_roles row(s) reference a role of another company. Re-audit before applying.', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.role_permissions rp JOIN public.roles r ON r.id = rp.role_id
  WHERE r.company_id <> rp.company_id;
  IF v_count > 0 THEN
    RAISE EXCEPTION '037 precondition failed: % role_permissions row(s) reference a role of another company. Re-audit before applying.', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.user_roles ur JOIN public.profiles p ON p.id = ur.user_id
  WHERE p.company_id <> ur.company_id;
  IF v_count > 0 THEN
    RAISE EXCEPTION '037 precondition failed: % user_roles row(s) reference a user of another company. Re-audit before applying.', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.user_sites us
  JOIN public.profiles p ON p.id = us.user_id
  JOIN public.sites s ON s.id = us.site_id
  WHERE p.company_id <> us.company_id OR s.company_id <> us.company_id;
  IF v_count > 0 THEN
    RAISE EXCEPTION '037 precondition failed: % user_sites row(s) reference a user or site of another company. Re-audit before applying.', v_count;
  END IF;
END
$$;

-- ------------------------------------------------------------
-- 1. H1 — status-aware identity helpers
-- ------------------------------------------------------------
-- An inactive/suspended/pending user, or any user of a non-active company,
-- resolves to NO company: every `company_id = current_company_id()` policy
-- then fails closed. The application middleware already requires both
-- statuses to be 'active'; this makes the database agree.
CREATE OR REPLACE FUNCTION public.current_company_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.company_id
  FROM public.profiles p
  JOIN public.companies c ON c.id = p.company_id
  WHERE p.id = auth.uid()
    AND p.status = 'active'
    AND c.status = 'active'
  LIMIT 1;
$$;

-- M1 defense in depth: a role assignment only grants permissions recorded
-- for that role within the same company (composite FKs in section 2 make
-- any other combination impossible to store).
CREATE OR REPLACE FUNCTION public.has_permission(permission_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id AND r.company_id = ur.company_id
    JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.company_id = ur.company_id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = auth.uid()
      AND ur.company_id = current_company_id()
      AND p.key = permission_key
      AND rp.allowed = true
  );
$$;

CREATE OR REPLACE FUNCTION public.can_access_site(p_site_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM user_sites
      WHERE user_id = auth.uid()
        AND site_id = p_site_id
        AND company_id = current_company_id()
    )
    OR has_permission('view_all_sites');
$$;

CREATE OR REPLACE FUNCTION public.current_user_sites()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT site_id
  FROM public.user_sites
  WHERE user_id = auth.uid()
    AND company_id = current_company_id();
$$;

-- L1: the target user's site access is evaluated inside the target user's
-- own company only (role, permission and site all in that company).
CREATE OR REPLACE FUNCTION public.user_has_site_access(p_user_id uuid, p_site_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
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
    );
$$;

-- ------------------------------------------------------------
-- 1b. H1 — profiles: own-row visibility and protected fields
-- ------------------------------------------------------------
-- With current_company_id() fail-closed, an inactive user can no longer
-- read their own profile through `profiles_select`. Sign-in (AuthService)
-- must still read it to show "account deactivated" and end the session,
-- so a user may always read exactly their own row — nothing else.
CREATE POLICY "profiles_select_own" ON profiles
  FOR SELECT USING (id = auth.uid());

-- Data API callers can never change identity fields. Status can only be
-- changed by a `manage_users` holder, never on their own row, and never
-- into/out of 'pending_invite' (owned by the invitation flow, which runs
-- as service_role). last_login_at can only be stamped by the user
-- themselves, with the database clock.
CREATE OR REPLACE FUNCTION public.enforce_profile_update_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.email IS DISTINCT FROM OLD.email
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'profiles: id, company_id, email and created_at cannot be changed'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.id = auth.uid() THEN
      RAISE EXCEPTION 'profiles: users cannot change their own account status'
        USING ERRCODE = '42501';
    END IF;
    IF NOT has_permission('manage_users') THEN
      RAISE EXCEPTION 'profiles: changing account status requires manage_users'
        USING ERRCODE = '42501';
    END IF;
    IF OLD.status = 'pending_invite' OR NEW.status = 'pending_invite' THEN
      RAISE EXCEPTION 'profiles: pending_invite status is managed by the invitation flow'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.last_login_at IS DISTINCT FROM OLD.last_login_at THEN
    IF OLD.id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'profiles: last_login_at can only be recorded by the user'
        USING ERRCODE = '42501';
    END IF;
    NEW.last_login_at := now();
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_profiles_enforce_update_integrity
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION enforce_profile_update_integrity();

-- ------------------------------------------------------------
-- 2. M1 — same-company references, enforced by composite foreign keys
-- ------------------------------------------------------------
-- Each single-column FK is REPLACED (same name, same ON DELETE CASCADE) by
-- a composite FK that also carries company_id — the company equality RLS
-- cannot enforce, because FK checks bypass RLS. Replacing rather than
-- adding keeps exactly one relationship per table pair: two FKs between
-- the same tables make PostgREST embeds such as
-- `user_roles -> roles!inner(...)` ambiguous (PGRST201), which would break
-- PermissionService and UserService.list.
ALTER TABLE roles    ADD CONSTRAINT uq_roles_id_company    UNIQUE (id, company_id);
ALTER TABLE profiles ADD CONSTRAINT uq_profiles_id_company UNIQUE (id, company_id);
ALTER TABLE sites    ADD CONSTRAINT uq_sites_id_company    UNIQUE (id, company_id);

ALTER TABLE role_permissions
  DROP CONSTRAINT role_permissions_role_id_fkey,
  ADD CONSTRAINT role_permissions_role_id_fkey
    FOREIGN KEY (role_id, company_id) REFERENCES roles (id, company_id) ON DELETE CASCADE;

ALTER TABLE user_roles
  DROP CONSTRAINT user_roles_role_id_fkey,
  ADD CONSTRAINT user_roles_role_id_fkey
    FOREIGN KEY (role_id, company_id) REFERENCES roles (id, company_id) ON DELETE CASCADE,
  DROP CONSTRAINT user_roles_user_id_fkey,
  ADD CONSTRAINT user_roles_user_id_fkey
    FOREIGN KEY (user_id, company_id) REFERENCES profiles (id, company_id) ON DELETE CASCADE;

ALTER TABLE user_sites
  DROP CONSTRAINT user_sites_user_id_fkey,
  ADD CONSTRAINT user_sites_user_id_fkey
    FOREIGN KEY (user_id, company_id) REFERENCES profiles (id, company_id) ON DELETE CASCADE,
  DROP CONSTRAINT user_sites_site_id_fkey,
  ADD CONSTRAINT user_sites_site_id_fkey
    FOREIGN KEY (site_id, company_id) REFERENCES sites (id, company_id) ON DELETE CASCADE;

-- ------------------------------------------------------------
-- 3. M2 / I2 — company settings require manage_settings
-- ------------------------------------------------------------
-- Permissive policies are OR'ed: the permission-less policy made
-- `company_settings_update_admin` meaningless.
DROP POLICY "company_settings_update" ON company_settings;

-- I2: CompanyService.updateSettings inserts the row on first save (session
-- client, after requirePermission('manage_settings')). uq_company_settings
-- (UNIQUE company_id) keeps it to one row per company.
CREATE POLICY "company_settings_insert_admin" ON company_settings
  FOR INSERT WITH CHECK (
    company_id = current_company_id()
    AND has_permission('manage_settings')
  );

GRANT INSERT ON public.company_settings TO authenticated;

-- ------------------------------------------------------------
-- 4. M3 — site isolation for child tables, through their parent record
-- ------------------------------------------------------------
-- Each helper answers, for the CALLER only: does the parent exist in my
-- company, and may I access its site? (Parents without a site — leads and
-- regulatory documents with site_id NULL — are company-wide, exactly as
-- their own policies treat them.)
CREATE OR REPLACE FUNCTION public.can_access_subject(p_subject_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM subjects s
    WHERE s.id = p_subject_id
      AND s.company_id = current_company_id()
      AND can_access_site(s.site_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.can_access_visit(p_visit_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM visits v
    WHERE v.id = p_visit_id
      AND v.company_id = current_company_id()
      AND can_access_site(v.site_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.can_access_chart(p_chart_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM charts c
    WHERE c.id = p_chart_id
      AND c.company_id = current_company_id()
      AND can_access_site(c.site_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.can_access_lead(p_lead_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM leads l
    WHERE l.id = p_lead_id
      AND l.company_id = current_company_id()
      AND (l.site_id IS NULL OR can_access_site(l.site_id))
  );
$$;

CREATE OR REPLACE FUNCTION public.can_access_lead_prescreening(p_lead_prescreening_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM lead_prescreenings lp
    WHERE lp.id = p_lead_prescreening_id
      AND lp.company_id = current_company_id()
      AND can_access_lead(lp.lead_id)
  );
$$;

-- document_versions / document_history target exactly one parent
-- (chk_*_target). Staff documents carry no site restriction in their own
-- policy (credentials belong to a person), so only company is checked.
CREATE OR REPLACE FUNCTION public.can_access_document_parent(
  p_document_id uuid,
  p_staff_document_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_document_id IS NOT NULL THEN EXISTS (
      SELECT 1 FROM regulatory_documents d
      WHERE d.id = p_document_id
        AND d.company_id = current_company_id()
        AND (d.site_id IS NULL OR can_access_site(d.site_id))
    )
    WHEN p_staff_document_id IS NOT NULL THEN EXISTS (
      SELECT 1 FROM staff_documents sd
      WHERE sd.id = p_staff_document_id
        AND sd.company_id = current_company_id()
    )
    ELSE false
  END;
$$;

-- Subject children
ALTER POLICY "subject_notes_select" ON subject_notes
  USING (company_id = current_company_id() AND has_permission('view_subjects') AND can_access_subject(subject_id));
ALTER POLICY "subject_notes_insert" ON subject_notes
  WITH CHECK (company_id = current_company_id() AND has_permission('edit_subject') AND can_access_subject(subject_id));

ALTER POLICY "subject_documents_select" ON subject_documents
  USING (company_id = current_company_id() AND has_permission('view_subjects') AND can_access_subject(subject_id));
ALTER POLICY "subject_documents_insert" ON subject_documents
  WITH CHECK (company_id = current_company_id() AND has_permission('edit_subject') AND can_access_subject(subject_id));

ALTER POLICY "subject_status_history_select" ON subject_status_history
  USING (company_id = current_company_id() AND has_permission('view_subjects') AND can_access_subject(subject_id));
ALTER POLICY "subject_status_history_insert" ON subject_status_history
  WITH CHECK (company_id = current_company_id() AND has_permission('edit_subject') AND can_access_subject(subject_id));

ALTER POLICY "subject_timeline_select" ON subject_timeline
  USING (company_id = current_company_id() AND has_permission('view_subjects') AND can_access_subject(subject_id));
ALTER POLICY "subject_timeline_insert" ON subject_timeline
  WITH CHECK (
    company_id = current_company_id()
    AND (has_permission('create_subject') OR has_permission('edit_subject'))
    AND can_access_subject(subject_id)
  );

-- Visit and chart children
ALTER POLICY "visit_notes_select" ON visit_notes
  USING (company_id = current_company_id() AND has_permission('view_visits') AND can_access_visit(visit_id));
ALTER POLICY "visit_notes_insert" ON visit_notes
  WITH CHECK (company_id = current_company_id() AND has_permission('manage_visits') AND can_access_visit(visit_id));

ALTER POLICY "chart_metrics_select" ON chart_metrics
  USING (company_id = current_company_id() AND has_permission('view_charts') AND can_access_chart(chart_id));
ALTER POLICY "chart_metrics_insert" ON chart_metrics
  WITH CHECK (
    company_id = current_company_id()
    AND (has_permission('edit_subject') OR has_permission('mark_chart_ready')
         OR has_permission('mark_chart_entered') OR has_permission('reopen_chart'))
    AND can_access_chart(chart_id)
  );
ALTER POLICY "chart_metrics_update" ON chart_metrics
  USING (
    company_id = current_company_id()
    AND (has_permission('edit_subject') OR has_permission('mark_chart_ready')
         OR has_permission('mark_chart_entered') OR has_permission('reopen_chart'))
    AND can_access_chart(chart_id)
  )
  WITH CHECK (company_id = current_company_id() AND can_access_chart(chart_id));

-- Lead children
ALTER POLICY "lead_calls_select" ON lead_calls
  USING (company_id = current_company_id() AND has_permission('log_lead_call') AND can_access_lead(lead_id));
ALTER POLICY "lead_calls_insert" ON lead_calls
  WITH CHECK (company_id = current_company_id() AND has_permission('log_lead_call') AND can_access_lead(lead_id));

ALTER POLICY "lead_contact_log_select" ON lead_contact_log
  USING (company_id = current_company_id() AND has_permission('view_lead_phi') AND can_access_lead(lead_id));
ALTER POLICY "lead_contact_log_insert" ON lead_contact_log
  WITH CHECK (company_id = current_company_id() AND has_permission('edit_lead_phi') AND can_access_lead(lead_id));

ALTER POLICY "lead_notes_select" ON lead_notes
  USING (
    company_id = current_company_id()
    AND (has_permission('view_lead_notes') OR has_permission('create_lead_note'))
    AND (is_private = false OR created_by = auth.uid())
    AND can_access_lead(lead_id)
  );
ALTER POLICY "lead_notes_insert" ON lead_notes
  WITH CHECK (company_id = current_company_id() AND has_permission('create_lead_note') AND can_access_lead(lead_id));
ALTER POLICY "lead_notes_update" ON lead_notes
  USING (
    company_id = current_company_id() AND has_permission('create_lead_note')
    AND created_by = auth.uid() AND can_access_lead(lead_id)
  )
  WITH CHECK (
    company_id = current_company_id() AND has_permission('create_lead_note')
    AND created_by = auth.uid() AND can_access_lead(lead_id)
  );

ALTER POLICY "lead_prescreenings_select" ON lead_prescreenings
  USING (company_id = current_company_id() AND has_permission('view_leads') AND can_access_lead(lead_id));
ALTER POLICY "lead_prescreenings_insert" ON lead_prescreenings
  WITH CHECK (company_id = current_company_id() AND has_permission('edit_lead') AND can_access_lead(lead_id));
ALTER POLICY "lead_prescreenings_update" ON lead_prescreenings
  USING (company_id = current_company_id() AND has_permission('edit_lead') AND can_access_lead(lead_id))
  WITH CHECK (company_id = current_company_id() AND has_permission('edit_lead') AND can_access_lead(lead_id));

ALTER POLICY "prescreening_answers_select" ON lead_prescreening_answers
  USING (
    company_id = current_company_id() AND has_permission('view_leads')
    AND can_access_lead_prescreening(lead_prescreening_id)
  );
ALTER POLICY "prescreening_answers_insert" ON lead_prescreening_answers
  WITH CHECK (
    company_id = current_company_id() AND has_permission('edit_lead')
    AND can_access_lead_prescreening(lead_prescreening_id)
  );

ALTER POLICY "lead_status_history_select" ON lead_status_history
  USING (company_id = current_company_id() AND has_permission('view_leads') AND can_access_lead(lead_id));
ALTER POLICY "lead_status_history_insert" ON lead_status_history
  WITH CHECK (
    company_id = current_company_id()
    AND (has_permission('edit_lead') OR has_permission('convert_lead'))
    AND can_access_lead(lead_id)
  );

-- A dismissal links two leads: both must be accessible.
ALTER POLICY "lead_duplicate_dismissals_select" ON lead_duplicate_dismissals
  USING (
    company_id = current_company_id() AND has_permission('view_lead_phi')
    AND can_access_lead(lead_id) AND can_access_lead(matched_lead_id)
  );
ALTER POLICY "lead_duplicate_dismissals_insert" ON lead_duplicate_dismissals
  WITH CHECK (
    company_id = current_company_id() AND has_permission('dismiss_recruitment_duplicates')
    AND can_access_lead(lead_id) AND can_access_lead(matched_lead_id)
  );

-- Regulatory / staff document children
ALTER POLICY "document_versions_select" ON document_versions
  USING (
    company_id = current_company_id()
    AND (has_permission('view_regulatory') OR has_permission('view_staff_credentials'))
    AND can_access_document_parent(document_id, staff_document_id)
  );
ALTER POLICY "document_versions_insert" ON document_versions
  WITH CHECK (
    company_id = current_company_id()
    AND (
      (document_id IS NOT NULL AND has_permission('upload_regulatory_document'))
      OR (staff_document_id IS NOT NULL AND has_permission('manage_staff_credentials'))
    )
    AND can_access_document_parent(document_id, staff_document_id)
  );
ALTER POLICY "document_versions_update" ON document_versions
  USING (
    company_id = current_company_id()
    AND status IN ('pending_review', 'approved')
    AND (has_permission('edit_regulatory_document') OR has_permission('archive_regulatory_document')
         OR has_permission('override_regulatory_status') OR has_permission('manage_staff_credentials'))
    AND can_access_document_parent(document_id, staff_document_id)
  )
  WITH CHECK (
    company_id = current_company_id()
    AND can_access_document_parent(document_id, staff_document_id)
  );

ALTER POLICY "document_history_select" ON document_history
  USING (
    company_id = current_company_id() AND has_permission('view_regulatory_audit')
    AND can_access_document_parent(document_id, staff_document_id)
  );
ALTER POLICY "document_history_insert" ON document_history
  WITH CHECK (
    company_id = current_company_id()
    AND (has_permission('upload_regulatory_document') OR has_permission('edit_regulatory_document')
         OR has_permission('archive_regulatory_document') OR has_permission('override_regulatory_status')
         OR has_permission('manage_staff_credentials'))
    AND can_access_document_parent(document_id, staff_document_id)
  );

-- ------------------------------------------------------------
-- 5. M5 — regulated document review integrity
-- ------------------------------------------------------------
-- For Data API callers:
--   INSERT  uploaded_by must be the caller; uploaded_at is the DB clock; the
--           file must belong to the same company. Regulatory versions start
--           'pending_review' with no reviewer. Staff credential versions may
--           be recorded 'approved' by a manage_staff_credentials holder, who
--           is then the recorded reviewer.
--   UPDATE  only status / is_current / reviewed_by / reviewed_at may change
--           (this also protects legacy projects whose broad grants predate
--           036's column-level grant). Allowed transitions:
--             pending_review -> approved | rejected | superseded | archived
--             approved       -> superseded | archived
--           approved/rejected is a review decision: it requires
--           edit_regulatory_document (regulatory) or manage_staff_credentials
--           (staff), and records the CALLER at the DB clock. A supplied
--           reviewed_by other than the caller is rejected as forged. No
--           other update may touch the reviewer fields. A version never
--           becomes current again, and a rejected/superseded/archived
--           version cannot be current.
CREATE OR REPLACE FUNCTION public.enforce_document_version_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_review_permission text;
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'document_versions: an authenticated user is required' USING ERRCODE = '42501';
  END IF;

  v_review_permission := CASE WHEN NEW.document_id IS NOT NULL
                              THEN 'edit_regulatory_document'
                              ELSE 'manage_staff_credentials' END;

  IF TG_OP = 'INSERT' THEN
    IF NEW.uploaded_by IS DISTINCT FROM v_uid THEN
      RAISE EXCEPTION 'document_versions: uploaded_by must be the current user' USING ERRCODE = '42501';
    END IF;
    NEW.uploaded_at := now();

    -- Evaluated under the caller's RLS on files (company-scoped).
    IF NOT EXISTS (SELECT 1 FROM files f WHERE f.id = NEW.file_id AND f.company_id = NEW.company_id) THEN
      RAISE EXCEPTION 'document_versions: the file must belong to the same company' USING ERRCODE = '42501';
    END IF;

    IF NEW.status = 'pending_review' THEN
      IF NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL THEN
        RAISE EXCEPTION 'document_versions: a version pending review cannot carry a reviewer'
          USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.status = 'approved' AND NEW.staff_document_id IS NOT NULL THEN
      IF NEW.reviewed_by IS NOT NULL AND NEW.reviewed_by <> v_uid THEN
        RAISE EXCEPTION 'document_versions: reviewed_by must be the current user' USING ERRCODE = '42501';
      END IF;
      NEW.reviewed_by := v_uid;
      NEW.reviewed_at := now();
    ELSE
      RAISE EXCEPTION 'document_versions: a new % version cannot start as %',
        CASE WHEN NEW.document_id IS NOT NULL THEN 'regulatory' ELSE 'staff credential' END, NEW.status
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.document_id IS DISTINCT FROM OLD.document_id
     OR NEW.staff_document_id IS DISTINCT FROM OLD.staff_document_id
     OR NEW.previous_version_id IS DISTINCT FROM OLD.previous_version_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.file_id IS DISTINCT FROM OLD.file_id
     OR NEW.checksum IS DISTINCT FROM OLD.checksum
     OR NEW.effective_date IS DISTINCT FROM OLD.effective_date
     OR NEW.expiration_date IS DISTINCT FROM OLD.expiration_date
     OR NEW.replacement_reason IS DISTINCT FROM OLD.replacement_reason
     OR NEW.duplicate_of_version_id IS DISTINCT FROM OLD.duplicate_of_version_id
     OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
     OR NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at THEN
    RAISE EXCEPTION 'document_versions: version, file, checksum and upload attributes are immutable'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('approved', 'rejected') THEN
    IF OLD.status <> 'pending_review' THEN
      RAISE EXCEPTION 'document_versions: invalid status transition % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
    IF NOT has_permission(v_review_permission) THEN
      RAISE EXCEPTION 'document_versions: % is required to review this version', v_review_permission
        USING ERRCODE = '42501';
    END IF;
    IF NEW.reviewed_by IS NOT NULL AND NEW.reviewed_by <> v_uid THEN
      RAISE EXCEPTION 'document_versions: reviewed_by must be the current user' USING ERRCODE = '42501';
    END IF;
    NEW.reviewed_by := v_uid;
    NEW.reviewed_at := now();
  ELSE
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (OLD.status IN ('pending_review', 'approved') AND NEW.status IN ('superseded', 'archived')) THEN
      RAISE EXCEPTION 'document_versions: invalid status transition % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
    IF NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
       OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at THEN
      RAISE EXCEPTION 'document_versions: the reviewer is recorded only by an approve or reject decision'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.is_current AND NOT OLD.is_current THEN
    RAISE EXCEPTION 'document_versions: a version cannot be made current again' USING ERRCODE = '23514';
  END IF;
  IF NEW.is_current AND NEW.status IN ('rejected', 'superseded', 'archived') THEN
    RAISE EXCEPTION 'document_versions: a % version cannot be current', NEW.status USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_document_versions_enforce_integrity
  BEFORE INSERT OR UPDATE ON document_versions
  FOR EACH ROW EXECUTE FUNCTION enforce_document_version_integrity();

-- The regulated history ledger records the caller at the DB clock.
CREATE OR REPLACE FUNCTION public.enforce_document_history_attribution()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  IF NEW.changed_by IS NOT NULL AND NEW.changed_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'document_history: changed_by must be the current user' USING ERRCODE = '42501';
  END IF;
  NEW.changed_by := auth.uid();
  NEW.changed_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_document_history_enforce_attribution
  BEFORE INSERT ON document_history
  FOR EACH ROW EXECUTE FUNCTION enforce_document_history_attribution();

-- The regulatory document "slot" carries the status the binder, the health
-- score and the expiration checker read. Without this trigger an uploader
-- could set it to 'current' directly while its version is still pending
-- review, or move an approved slot to another document type or scope.
-- For Data API callers:
--   INSERT  starts as 'missing' or 'draft', uploaded_by is the caller, and
--           the denormalized version fields (file, version, dates) are empty.
--   UPDATE  identity (company, site, study, type, name, uploader, created_at)
--           is immutable; the denormalized version fields may only be set to
--           the current version's values. A status change needs:
--             override_regulatory_status         any transition (manual
--                                                override, app-audited)
--             -> archived                        archive_regulatory_document
--             -> pending_review (not archived)   upload_regulatory_document
--                                                and a current version
--                                                pending review
--             pending_review -> current /        edit_regulatory_document and
--               expiring_soon / expired          a current APPROVED version
--                                                (not 'current'/'expiring_soon'
--                                                once that version expired)
--             pending_review -> rejected         edit_regulatory_document, no
--                                                current version, and a version
--                                                rejected by the caller
--           Everything else (incl. expiry recomputation, which the
--           regulatory-expiration-checker does as service_role) is refused.
-- Version rows are read under the caller's RLS (company and site scoped);
-- their reviewer attribution is enforced by trg_document_versions_enforce_integrity.
CREATE OR REPLACE FUNCTION public.enforce_regulatory_document_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_current record;
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'regulatory_documents: an authenticated user is required' USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.uploaded_by IS DISTINCT FROM v_uid THEN
      RAISE EXCEPTION 'regulatory_documents: uploaded_by must be the current user' USING ERRCODE = '42501';
    END IF;
    IF NEW.status NOT IN ('missing', 'draft') THEN
      RAISE EXCEPTION 'regulatory_documents: a new document cannot start as %', NEW.status
        USING ERRCODE = '23514';
    END IF;
    IF NEW.file_id IS NOT NULL OR NEW.version IS NOT NULL
       OR NEW.effective_date IS NOT NULL OR NEW.expiration_date IS NOT NULL THEN
      RAISE EXCEPTION 'regulatory_documents: version fields are set from an uploaded version'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.site_id IS DISTINCT FROM OLD.site_id
     OR NEW.study_id IS DISTINCT FROM OLD.study_id
     OR NEW.document_type_id IS DISTINCT FROM OLD.document_type_id
     OR NEW.document_name IS DISTINCT FROM OLD.document_name
     OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'regulatory_documents: document identity, scope and uploader are immutable'
      USING ERRCODE = '42501';
  END IF;

  SELECT dv.status, dv.file_id, dv.version, dv.effective_date, dv.expiration_date
    INTO v_current
    FROM document_versions dv
   WHERE dv.document_id = OLD.id AND dv.is_current
   LIMIT 1;

  IF NEW.file_id IS DISTINCT FROM OLD.file_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.effective_date IS DISTINCT FROM OLD.effective_date
     OR NEW.expiration_date IS DISTINCT FROM OLD.expiration_date THEN
    IF v_current.status IS NULL
       OR NEW.file_id IS DISTINCT FROM v_current.file_id
       OR NEW.version IS DISTINCT FROM v_current.version
       OR NEW.effective_date IS DISTINCT FROM v_current.effective_date
       OR NEW.expiration_date IS DISTINCT FROM v_current.expiration_date THEN
      RAISE EXCEPTION 'regulatory_documents: file, version and dates must match the current version'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status OR has_permission('override_regulatory_status') THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'archived' THEN
    IF NOT has_permission('archive_regulatory_document') THEN
      RAISE EXCEPTION 'regulatory_documents: archive_regulatory_document is required to archive'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.status = 'pending_review' THEN
    IF OLD.status = 'archived' THEN
      RAISE EXCEPTION 'regulatory_documents: an archived document cannot be resubmitted'
        USING ERRCODE = '23514';
    END IF;
    IF NOT has_permission('upload_regulatory_document') THEN
      RAISE EXCEPTION 'regulatory_documents: upload_regulatory_document is required to submit'
        USING ERRCODE = '42501';
    END IF;
    IF v_current.status IS DISTINCT FROM 'pending_review' THEN
      RAISE EXCEPTION 'regulatory_documents: submitting for review requires a current version pending review'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status IN ('current', 'expiring_soon', 'expired') THEN
    IF OLD.status <> 'pending_review' THEN
      RAISE EXCEPTION 'regulatory_documents: invalid status transition % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
    IF NOT has_permission('edit_regulatory_document') THEN
      RAISE EXCEPTION 'regulatory_documents: edit_regulatory_document is required to approve'
        USING ERRCODE = '42501';
    END IF;
    IF v_current.status IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'regulatory_documents: % requires an approved current version', NEW.status
        USING ERRCODE = '23514';
    END IF;
    -- One day of tolerance for the application's local-midnight date math.
    IF NEW.status <> 'expired' AND v_current.expiration_date < current_date - 1 THEN
      RAISE EXCEPTION 'regulatory_documents: the approved version has expired'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status = 'rejected' THEN
    IF OLD.status <> 'pending_review' THEN
      RAISE EXCEPTION 'regulatory_documents: invalid status transition % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
    IF NOT has_permission('edit_regulatory_document') THEN
      RAISE EXCEPTION 'regulatory_documents: edit_regulatory_document is required to reject'
        USING ERRCODE = '42501';
    END IF;
    IF v_current.status IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM document_versions dv
      WHERE dv.document_id = OLD.id AND dv.status = 'rejected' AND dv.reviewed_by = v_uid
    ) THEN
      RAISE EXCEPTION 'regulatory_documents: rejecting requires a version rejected by the current user'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'regulatory_documents: invalid status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_regulatory_documents_enforce_integrity
  BEFORE INSERT OR UPDATE ON regulatory_documents
  FOR EACH ROW EXECUTE FUNCTION enforce_regulatory_document_integrity();

-- ------------------------------------------------------------
-- 6. L1 — tasks_insert assignee company check
-- ------------------------------------------------------------
-- Inside the EXISTS subquery an unqualified `company_id` resolves to
-- `pr.company_id`; it must refer to the task row.
ALTER POLICY "tasks_insert" ON tasks
  WITH CHECK (
    company_id = current_company_id()
    AND can_access_site(site_id)
    AND has_permission('create_task')
    AND created_by_system = false
    AND source_module = 'manual'
    AND source_record_type IS NULL
    AND source_record_id IS NULL
    AND status IN ('new', 'assigned')
    AND (
      assigned_to IS NULL
      OR (
        user_has_site_access(assigned_to, site_id)
        AND EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = tasks.assigned_to AND pr.company_id = tasks.company_id)
      )
    )
  );

-- ------------------------------------------------------------
-- 7. L2 — notifications: only the read state is user-writable
-- ------------------------------------------------------------
-- NotificationService.markRead/markAllRead write exactly these columns.
REVOKE UPDATE ON public.notifications FROM authenticated;
GRANT UPDATE (is_read, read_at) ON public.notifications TO authenticated;

-- ------------------------------------------------------------
-- 8. L5 — function EXECUTE surface
-- ------------------------------------------------------------
-- No application path calls these as `anon` (sign-in is Supabase Auth;
-- invitation validation uses service_role; storage policies are
-- TO authenticated). Trigger functions are not callable directly and do
-- not need EXECUTE to fire.
REVOKE ALL ON FUNCTION
  public.current_company_id(),
  public.has_permission(text),
  public.can_access_site(uuid),
  public.current_user_sites(),
  public.user_has_site_access(uuid, uuid),
  public.can_access_subject(uuid),
  public.can_access_visit(uuid),
  public.can_access_chart(uuid),
  public.can_access_lead(uuid),
  public.can_access_lead_prescreening(uuid),
  public.can_access_document_parent(uuid, uuid),
  public.complete_visit_with_chart(uuid, uuid, uuid, text),
  public.update_updated_at_column(),
  public.record_task_reassignment_history(),
  public.enforce_profile_update_integrity(),
  public.enforce_document_version_integrity(),
  public.enforce_document_history_attribution(),
  public.enforce_regulatory_document_integrity()
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.current_company_id(),
  public.has_permission(text),
  public.can_access_site(uuid),
  public.current_user_sites(),
  public.user_has_site_access(uuid, uuid),
  public.can_access_subject(uuid),
  public.can_access_visit(uuid),
  public.can_access_chart(uuid),
  public.can_access_lead(uuid),
  public.can_access_lead_prescreening(uuid),
  public.can_access_document_parent(uuid, uuid),
  public.complete_visit_with_chart(uuid, uuid, uuid, text)
TO authenticated, service_role;

COMMIT;

-- ROLLBACK GUIDANCE (manual, owner-approved only): restore the previous
-- definitions of the five helper functions and the altered policies from
-- migrations 001–035 (they are recreated verbatim there), DROP the four
-- triggers and their functions, the six can_access_* helpers, policy
-- profiles_select_own and company_settings_insert_admin; re-create the five
-- single-column FKs (role_permissions/user_roles role_id, user_roles/
-- user_sites user_id, user_sites site_id, all ON DELETE CASCADE) in place
-- of the composite ones, then drop the uq_*_id_company constraints;
-- re-create company_settings_update;
-- REVOKE INSERT ON company_settings and the notifications column grant
-- from authenticated and re-GRANT UPDATE ON notifications. Rolling back
-- re-opens H1/M1/M2/M3/M5 — do not do it on a project with real users.
