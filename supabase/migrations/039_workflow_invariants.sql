-- ============================================================
-- Migration 039 — Workflow invariants (G8, M4 phase 2)
-- ============================================================
--
-- CONTEXT: the G8 M4 assessment (2026-11-09) showed that a signed-in user
-- can call the Data API directly and move records through states the
-- application would never allow (findings F4/F5, probes BR-*): create a
-- subject in a draft study, randomize without a baseline, complete a visit
-- out of sequence, mark a chart entered in EDC without the permission,
-- mark a lead converted without a conversion, or activate a study with
-- edit_study only. Migration 038 fixed attribution and tenant/site scope;
-- 039 moves the service-layer state rules into the database.
--
-- OWNER DECISIONS APPLIED (2026-11-21):
--   M4-D5  required earlier visits must be done before a visit is
--          completed; out-of-window visits are allowed as 'out_of_window'
--          (the warning state); authorized sequence exceptions are
--          recorded with a justification and are auditable.
--   O-1    a visit performed outside its window must be 'out_of_window',
--          never 'completed'.
--   Obs-1/Obs-2  current study lifecycle leniency and subject creation at
--          inactive study sites are kept (separate review).
--   Obs-3  (found in E2) LeadService.changeStatus lets a lead leave a closed
--          status with a reason; kept as the application behaves, pending
--          owner review (see the leads trigger below).
--
-- DESIGN:
--   * BEFORE triggers that act only for Data API roles
--     (current_user IN ('authenticated','anon')), exactly like 038's
--     enforce_row_attribution: service_role, migrations and SECURITY
--     DEFINER code are unaffected. Every rule mirrors the application
--     service it protects (file:line references below).
--   * Precondition lookups run in SECURITY DEFINER helpers with a pinned
--     search_path, so they do not depend on the caller's SELECT visibility
--     (M4 lesson: an invoker lookup wrongly denied a CRC).
--   * The helpers and the transition table live in a new schema `private`
--     that the Data API does not expose. PUBLIC/anon have no privilege on
--     it; authenticated has USAGE and EXECUTE on the helpers only. Every
--     helper also checks the caller's company itself and returns only fixed
--     rule texts or booleans, so exposure by mistake would leak nothing.
--     The schema's non-exposure is verified outside the database (E1 §11).
--   * Transitions are data (private.workflow_transitions), not CASE code, so
--     later phases (patients: 'withdrawn') add rows instead of rewriting 039.
--   * Fail closed: 23514 (check_violation) for business rules, 42501 for a
--     missing permission. Messages name the rule, never other rows' data.
--   * One new permission, override_visit_sequence, granted to no role by
--     default (same pattern as force_archive_study / reopen_visit).
--   * Visit integrity (final review H-1, 2026-11-21): a visit keeps its
--     subject, study, site and template visit; a subject has at most one
--     visit per template visit (cancelled ones included, like
--     SubjectService.generateVisitSchedule); a template visit must come from
--     the study's approved template; target date and window follow the
--     template (a window can be narrowed, never widened or cleared); the
--     visit date is recorded only while the visit is in progress; and the
--     subject's baseline date must match its completed baseline visit. So the
--     sequence (M4-D5) and O-1 cannot be bypassed by re-pointing visits,
--     fabricating predecessors or editing dates.
--   * No oracle before authorization (final review M-1): BEFORE triggers run
--     before the RLS WITH CHECK of an INSERT, so every INSERT check that looks
--     at other rows first applies the table's own INSERT policy and answers
--     exactly like RLS (42501). The sequence-exception lookup and its row lock
--     only reach a visit of the caller's company, authorized site, subject
--     and site.
--
-- NOT CHANGED HERE: reasons for exceptional lead transitions and visit
-- reopening (the reason travels in a different request; enforced with 044
-- when status changes move to RPCs), staff_documents and credentials (041),
-- database-captured audit (040), role governance (042), Storage (043).
--
-- EXECUTION: one transaction; NOT idempotent. Preconditions are checked
-- first; the migration aborts with an explicit message and no change if
-- 038 is missing, if 039 is already applied, or if the Data API role is
-- configured to expose a schema named `private`. Apply with a lock_timeout.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 0. Preconditions
-- ------------------------------------------------------------
DO $$
DECLARE
  v_cfg text;
BEGIN
  IF to_regprocedure('public.enforce_row_attribution()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_files_storage_path_company_prefix') THEN
    RAISE EXCEPTION '039 precondition failed: migration 038 is not applied.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'private')
     OR EXISTS (SELECT 1 FROM public.permissions WHERE key = 'override_visit_sequence')
     OR to_regclass('public.visit_sequence_exceptions') IS NOT NULL THEN
    RAISE EXCEPTION '039 precondition failed: migration 039 is already applied (schema private, permission override_visit_sequence or table visit_sequence_exceptions exists).';
  END IF;
  -- Early detection only (not a proof of non-exposure, see E1 §11): the
  -- in-database PostgREST setting must not name the schema.
  SELECT string_agg(c, ',') INTO v_cfg
    FROM pg_roles r, unnest(coalesce(r.rolconfig, '{}'::text[])) c
   WHERE r.rolname = 'authenticator' AND c ILIKE 'pgrst.db_schemas=%';
  IF v_cfg IS NOT NULL AND v_cfg ~* '(^|[=,[:space:]])"?private"?([,[:space:]]|$)' THEN
    RAISE EXCEPTION '039 precondition failed: the authenticator role exposes a schema named private (%).', v_cfg;
  END IF;
  -- H-1: the unique index below must not meet existing duplicates.
  SELECT count(*)::text INTO v_cfg
    FROM (SELECT 1 FROM public.visits WHERE visit_template_item_id IS NOT NULL
           GROUP BY subject_id, visit_template_item_id HAVING count(*) > 1) d;
  IF v_cfg <> '0' THEN
    RAISE EXCEPTION '039 precondition failed: % subject/template-visit pairs have more than one visit; resolve them before applying 039.', v_cfg;
  END IF;
  FOR v_cfg IN SELECT unnest(ARRAY['edit_subject','manage_visits','reopen_visit','mark_chart_ready',
                                   'mark_chart_entered','reopen_chart','manage_studies','force_archive_study',
                                   'convert_lead','edit_lead','view_visits','create_subject','edit_study'])
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.permissions WHERE key = v_cfg) THEN
      RAISE EXCEPTION '039 precondition failed: permission % is missing.', v_cfg;
    END IF;
  END LOOP;
END
$$;

-- ------------------------------------------------------------
-- 1. Schema `private` (not exposed by the Data API)
-- ------------------------------------------------------------
CREATE SCHEMA private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO authenticated;

-- ------------------------------------------------------------
-- 2. Transition table
-- ------------------------------------------------------------
-- 'enforced' rows are checked by the triggers below. 'reference' rows (the
-- normal lead pipeline) document the service map for parity tests and for
-- 044; the database does not restrict lead destinations because the
-- application allows any non-terminal move with a reason (LeadService).
CREATE TABLE private.workflow_transitions (
  entity              text NOT NULL,
  from_status         text NOT NULL,
  to_status           text NOT NULL,
  required_permission text NOT NULL REFERENCES public.permissions (key) ON UPDATE CASCADE ON DELETE RESTRICT,
  enforcement         text NOT NULL DEFAULT 'enforced',
  note                text,
  PRIMARY KEY (entity, from_status, to_status),
  CONSTRAINT ck_workflow_transitions_entity CHECK (entity IN ('subjects', 'visits', 'charts', 'visit_templates', 'leads')),
  CONSTRAINT ck_workflow_transitions_enforcement CHECK (enforcement IN ('enforced', 'reference')),
  CONSTRAINT ck_workflow_transitions_distinct CHECK (from_status <> to_status)
);
REVOKE ALL ON private.workflow_transitions FROM PUBLIC;

INSERT INTO private.workflow_transitions (entity, from_status, to_status, required_permission, enforcement, note) VALUES
  -- subjects: SubjectService.ts:63-92 (FORWARD_FLOW, TERMINAL_STATUSES, isValidStatusTransition)
  ('subjects', 'pre_screening', 'screening',         'edit_subject', 'enforced', NULL),
  ('subjects', 'screening',     'randomized',        'edit_subject', 'enforced', 'baseline_date, randomization_date and randomization_number required'),
  ('subjects', 'randomized',    'active',            'edit_subject', 'enforced', NULL),
  ('subjects', 'active',        'completed',         'edit_subject', 'enforced', NULL),
  ('subjects', 'pre_screening', 'screen_failed',     'edit_subject', 'enforced', NULL),
  ('subjects', 'screening',     'screen_failed',     'edit_subject', 'enforced', NULL),
  ('subjects', 'screening',     'early_terminated',  'edit_subject', 'enforced', NULL),
  ('subjects', 'randomized',    'early_terminated',  'edit_subject', 'enforced', NULL),
  ('subjects', 'active',        'early_terminated',  'edit_subject', 'enforced', NULL),
  ('subjects', 'screening',     'lost_to_follow_up', 'edit_subject', 'enforced', NULL),
  ('subjects', 'randomized',    'lost_to_follow_up', 'edit_subject', 'enforced', NULL),
  ('subjects', 'active',        'lost_to_follow_up', 'edit_subject', 'enforced', NULL),
  -- visits: VisitService.ts:230-410, SubjectService.ts:573-640 and 696-790 (completion), 1008-1013 (close remaining)
  ('visits', 'scheduled',   'confirmed',     'manage_visits', 'enforced', NULL),
  ('visits', 'confirmed',   'in_progress',   'manage_visits', 'enforced', NULL),
  ('visits', 'in_progress', 'completed',     'edit_subject',  'enforced', 'required earlier visits done (or an authorized exception); inside the window (O-1)'),
  ('visits', 'in_progress', 'out_of_window', 'edit_subject',  'enforced', 'required earlier visits done (or an authorized exception); outside the window (O-1)'),
  ('visits', 'scheduled',   'cancelled',     'manage_visits', 'enforced', NULL),
  ('visits', 'confirmed',   'cancelled',     'manage_visits', 'enforced', NULL),
  ('visits', 'in_progress', 'cancelled',     'manage_visits', 'enforced', NULL),
  ('visits', 'completed',   'in_progress',   'reopen_visit',  'enforced', 'reason required by the application (database: 044)'),
  -- charts: ChartService.ts:75-80 and 698-800
  ('charts', 'chart_ready',    'in_progress',    'mark_chart_ready',   'enforced', NULL),
  ('charts', 'chart_ready',    'on_hold',        'mark_chart_ready',   'enforced', NULL),
  ('charts', 'on_hold',        'chart_ready',    'mark_chart_ready',   'enforced', NULL),
  ('charts', 'in_progress',    'on_hold',        'mark_chart_ready',   'enforced', NULL),
  ('charts', 'in_progress',    'entered_in_edc', 'mark_chart_entered', 'enforced', NULL),
  ('charts', 'entered_in_edc', 'in_progress',    'reopen_chart',       'enforced', NULL),
  -- visit templates: VisitTemplateService.ts:171-240
  ('visit_templates', 'draft',    'approved', 'manage_studies', 'enforced', NULL),
  ('visit_templates', 'approved', 'archived', 'manage_studies', 'enforced', NULL),
  ('visit_templates', 'draft',    'archived', 'manage_studies', 'enforced', NULL),
  -- leads (reference only): LeadService.ts:93-107 STATUS_TRANSITIONS
  ('leads', 'new', 'contact_attempted', 'edit_lead', 'reference', NULL),
  ('leads', 'new', 'contacted', 'edit_lead', 'reference', NULL),
  ('leads', 'new', 'not_interested', 'edit_lead', 'reference', NULL),
  ('leads', 'new', 'lost', 'edit_lead', 'reference', NULL),
  ('leads', 'contact_attempted', 'contacted', 'edit_lead', 'reference', NULL),
  ('leads', 'contact_attempted', 'voicemail_left', 'edit_lead', 'reference', NULL),
  ('leads', 'contact_attempted', 'not_interested', 'edit_lead', 'reference', NULL),
  ('leads', 'contact_attempted', 'lost', 'edit_lead', 'reference', NULL),
  ('leads', 'voicemail_left', 'contacted', 'edit_lead', 'reference', NULL),
  ('leads', 'voicemail_left', 'contact_attempted', 'edit_lead', 'reference', NULL),
  ('leads', 'voicemail_left', 'not_interested', 'edit_lead', 'reference', NULL),
  ('leads', 'voicemail_left', 'lost', 'edit_lead', 'reference', NULL),
  ('leads', 'contacted', 'interested', 'edit_lead', 'reference', NULL),
  ('leads', 'contacted', 'not_interested', 'edit_lead', 'reference', NULL),
  ('leads', 'contacted', 'prescreen_scheduled', 'edit_lead', 'reference', NULL),
  ('leads', 'contacted', 'lost', 'edit_lead', 'reference', NULL),
  ('leads', 'interested', 'prescreen_scheduled', 'edit_lead', 'reference', NULL),
  ('leads', 'interested', 'prescreening', 'edit_lead', 'reference', NULL),
  ('leads', 'interested', 'not_interested', 'edit_lead', 'reference', NULL),
  ('leads', 'interested', 'lost', 'edit_lead', 'reference', NULL),
  ('leads', 'prescreen_scheduled', 'prescreen_in_progress', 'edit_lead', 'reference', NULL),
  ('leads', 'prescreen_scheduled', 'prescreening', 'edit_lead', 'reference', NULL),
  ('leads', 'prescreen_scheduled', 'not_interested', 'edit_lead', 'reference', NULL),
  ('leads', 'prescreen_scheduled', 'lost', 'edit_lead', 'reference', NULL),
  ('leads', 'prescreen_in_progress', 'prescreen_complete', 'edit_lead', 'reference', NULL),
  ('leads', 'prescreen_in_progress', 'prescreening', 'edit_lead', 'reference', NULL),
  ('leads', 'prescreen_in_progress', 'not_interested', 'edit_lead', 'reference', NULL),
  ('leads', 'prescreen_in_progress', 'lost', 'edit_lead', 'reference', NULL),
  ('leads', 'prescreening', 'qualified', 'edit_lead', 'reference', NULL),
  ('leads', 'prescreening', 'not_qualified', 'edit_lead', 'reference', NULL),
  ('leads', 'prescreening', 'prescreen_complete', 'edit_lead', 'reference', NULL),
  ('leads', 'prescreen_complete', 'qualified', 'edit_lead', 'reference', NULL),
  ('leads', 'prescreen_complete', 'not_qualified', 'edit_lead', 'reference', NULL),
  ('leads', 'qualified', 'screening_scheduled', 'edit_lead', 'reference', NULL),
  ('leads', 'qualified', 'waitlisted', 'edit_lead', 'reference', NULL),
  ('leads', 'qualified', 'not_qualified', 'edit_lead', 'reference', NULL),
  ('leads', 'screening_scheduled', 'screened', 'edit_lead', 'reference', NULL),
  ('leads', 'screening_scheduled', 'not_qualified', 'edit_lead', 'reference', NULL),
  ('leads', 'screened', 'screen_failed', 'edit_lead', 'reference', NULL),
  ('leads', 'waitlisted', 'contacted', 'edit_lead', 'reference', NULL),
  ('leads', 'waitlisted', 'screening_scheduled', 'edit_lead', 'reference', NULL);

-- ------------------------------------------------------------
-- 3. Permission (granted to no role by default)
-- ------------------------------------------------------------
INSERT INTO public.permissions (key, module, description)
VALUES ('override_visit_sequence', 'visits',
        'Authorize completing a visit before its required earlier visits (sequence exception, reason required)');

-- ------------------------------------------------------------
-- 4. Sequence exceptions (M4-D5)
-- ------------------------------------------------------------
CREATE TABLE public.visit_sequence_exceptions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid        NOT NULL,
  site_id         uuid        NOT NULL,
  subject_id      uuid        NOT NULL,
  visit_id        uuid        NOT NULL,
  reason          text        NOT NULL,
  blocked_by      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  authorized_by   uuid,
  authorized_at   timestamptz NOT NULL DEFAULT now(),
  consumed_at     timestamptz,
  consumed_status text,
  CONSTRAINT fk_visit_sequence_exceptions_company FOREIGN KEY (company_id) REFERENCES public.companies (id) ON DELETE RESTRICT,
  CONSTRAINT fk_visit_sequence_exceptions_site FOREIGN KEY (site_id, company_id) REFERENCES public.sites (id, company_id) ON DELETE RESTRICT,
  CONSTRAINT fk_visit_sequence_exceptions_subject FOREIGN KEY (subject_id, company_id) REFERENCES public.subjects (id, company_id) ON DELETE CASCADE,
  CONSTRAINT fk_visit_sequence_exceptions_visit FOREIGN KEY (visit_id, company_id) REFERENCES public.visits (id, company_id) ON DELETE CASCADE,
  CONSTRAINT fk_visit_sequence_exceptions_authorized_by FOREIGN KEY (authorized_by, company_id) REFERENCES public.profiles (id, company_id) ON DELETE SET NULL (authorized_by),
  CONSTRAINT ck_visit_sequence_exceptions_reason CHECK (length(btrim(reason)) BETWEEN 10 AND 2000),
  CONSTRAINT ck_visit_sequence_exceptions_blocked_by CHECK (jsonb_typeof(blocked_by) = 'array'),
  CONSTRAINT ck_visit_sequence_exceptions_consumed CHECK (
    (consumed_at IS NULL AND consumed_status IS NULL)
    OR (consumed_at IS NOT NULL AND consumed_status IN ('completed', 'out_of_window')))
);
CREATE UNIQUE INDEX uq_visit_sequence_exceptions_open ON public.visit_sequence_exceptions (visit_id) WHERE consumed_at IS NULL;
CREATE INDEX idx_visit_sequence_exceptions_company_site ON public.visit_sequence_exceptions (company_id, site_id);
CREATE INDEX idx_visit_sequence_exceptions_subject ON public.visit_sequence_exceptions (subject_id);

ALTER TABLE public.visit_sequence_exceptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.visit_sequence_exceptions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.visit_sequence_exceptions TO authenticated, service_role;

CREATE POLICY visit_sequence_exceptions_select ON public.visit_sequence_exceptions
  FOR SELECT TO authenticated
  USING (company_id = current_company_id() AND has_permission('view_visits') AND can_access_site(site_id));
CREATE POLICY visit_sequence_exceptions_insert ON public.visit_sequence_exceptions
  FOR INSERT TO authenticated
  WITH CHECK (company_id = current_company_id() AND has_permission('override_visit_sequence') AND can_access_site(site_id));

CREATE TRIGGER trg_visit_sequence_exceptions_enforce_attribution BEFORE INSERT OR UPDATE ON public.visit_sequence_exceptions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_row_attribution('creator:authorized_by:authorized_at');

-- ------------------------------------------------------------
-- 4b. One visit per subject and template visit (final review H-1)
-- ------------------------------------------------------------
-- The application creates each template visit of a subject exactly once
-- (SubjectService.create up to Baseline, generateVisitSchedule after it; a
-- cancelled visit is never re-created). A second row for the same template
-- visit could stand in for a required predecessor that was never done, so
-- the index covers every status, cancelled included. Applies to every role;
-- service_role has no INSERT on visits (036).
CREATE UNIQUE INDEX uq_visits_subject_template_item
  ON public.visits (subject_id, visit_template_item_id)
  WHERE visit_template_item_id IS NOT NULL;

-- ------------------------------------------------------------
-- 5. Private helpers (SECURITY DEFINER, pinned search_path)
-- ------------------------------------------------------------
-- Permission required for an enforced transition, or NULL if the
-- transition does not exist.
CREATE FUNCTION private.transition_permission(p_entity text, p_from text, p_to text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = private, pg_temp
AS $$
  SELECT required_permission
    FROM private.workflow_transitions
   WHERE entity = p_entity AND from_status = p_from AND to_status = p_to AND enforcement = 'enforced';
$$;

-- Subject creation preconditions (SubjectService.ts:193-240). Returns a
-- fixed rule text or NULL. Another company's ids answer like missing ones.
CREATE FUNCTION private.subject_creation_blocker(p_company uuid, p_study uuid, p_site uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_company IS DISTINCT FROM current_company_id() THEN 'subjects: the study is not available'
    WHEN NOT EXISTS (SELECT 1 FROM studies s WHERE s.id = p_study AND s.company_id = p_company AND s.status = 'active')
      THEN 'subjects: subjects can only be created for an active study'
    WHEN NOT EXISTS (SELECT 1 FROM study_sites ss WHERE ss.study_id = p_study AND ss.site_id = p_site AND ss.company_id = p_company)
      THEN 'subjects: the selected site is not assigned to this study'
    WHEN NOT EXISTS (SELECT 1 FROM visit_templates vt WHERE vt.study_id = p_study AND vt.company_id = p_company AND vt.status = 'approved')
      THEN 'subjects: the study has no approved visit template'
  END;
$$;

-- Required earlier visits that are not done (lib/utils/visitSequencing.ts:14-47):
-- template items of the same template with a lower visit_order and
-- is_required, without a visit of the subject in completed/out_of_window.
-- Returns a JSON array of visit names, or NULL when the visit is not blocked.
-- Callable only for the caller's own company.
CREATE FUNCTION private.visit_sequence_blocked_by(p_visit uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT nullif(coalesce(jsonb_agg(pred.visit_name ORDER BY pred.visit_order, pred.visit_name), '[]'::jsonb), '[]'::jsonb)
    FROM visits v
    JOIN visit_template_items item ON item.id = v.visit_template_item_id AND item.company_id = v.company_id
    JOIN visit_template_items pred
      ON pred.template_id = item.template_id AND pred.company_id = item.company_id
     AND pred.visit_order < item.visit_order AND pred.is_required
   WHERE v.id = p_visit
     AND v.company_id = current_company_id() AND can_access_site(v.site_id)
     AND NOT EXISTS (
       SELECT 1 FROM visits done
        WHERE done.subject_id = v.subject_id AND done.company_id = v.company_id
          AND done.visit_template_item_id = pred.id
          AND done.status IN ('completed', 'out_of_window'));
$$;

-- Sequence gate for a visit completion. Returns NULL when the completion may
-- proceed: either nothing is blocking, or an open authorized exception exists
-- for this visit. An exception covers exactly ONE completion: any open
-- exception of the visit is closed (consumed_at/consumed_status) by this
-- completion, whether or not it was needed, so it can never be reused after a
-- reopen. The UPDATE takes the exception's row lock, so a concurrent second
-- completion re-reads consumed_at and is refused. Only usable from a trigger.
CREATE FUNCTION private.visit_sequence_gate(p_visit uuid, p_company uuid, p_new_status text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_blocked jsonb;
  v_id      uuid;
BEGIN
  IF pg_trigger_depth() < 1 OR p_company IS DISTINCT FROM current_company_id() THEN
    RETURN 'visits: the visit is not available';
  END IF;
  v_blocked := private.visit_sequence_blocked_by(p_visit);
  UPDATE visit_sequence_exceptions e
     SET consumed_at = now(), consumed_status = p_new_status
   WHERE e.visit_id = p_visit AND e.company_id = p_company AND e.consumed_at IS NULL
  RETURNING e.id INTO v_id;
  IF v_blocked IS NULL OR v_id IS NOT NULL THEN
    RETURN NULL;
  END IF;
  RETURN 'visits: complete the required earlier visits first, or record an authorized sequence exception';
END;
$$;

-- Study activation precondition (StudyService.ts:526-545).
CREATE FUNCTION private.study_has_approved_template(p_study uuid, p_company uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_company = current_company_id()
     AND EXISTS (SELECT 1 FROM visit_templates vt WHERE vt.study_id = p_study AND vt.company_id = p_company AND vt.status = 'approved');
$$;

-- Archive guard (StudyService.ts:836-858): any subject in the study.
CREATE FUNCTION private.study_has_subjects(p_study uuid, p_company uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_company = current_company_id()
     AND EXISTS (SELECT 1 FROM subjects s WHERE s.study_id = p_study AND s.company_id = p_company);
$$;

-- Template items are editable only while the template is a draft.
CREATE FUNCTION private.template_is_draft(p_template uuid, p_company uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_company = current_company_id()
     AND EXISTS (SELECT 1 FROM visit_templates vt WHERE vt.id = p_template AND vt.company_id = p_company AND vt.status = 'draft');
$$;

-- A chart may be created only for a done visit (complete_visit_with_chart, 026)
-- of the chart's own site, which the caller can access (M-1: a missing,
-- inaccessible, other-site or not-done visit all answer false).
CREATE FUNCTION private.visit_is_done(p_visit uuid, p_company uuid, p_site uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(p_company = current_company_id() AND can_access_site(p_site), false)
     AND EXISTS (SELECT 1 FROM visits v WHERE v.id = p_visit AND v.company_id = p_company AND v.site_id = p_site
                    AND v.status IN ('completed', 'out_of_window'));
$$;

-- A subject's baseline date is the date of its completed baseline visit
-- (SubjectService.completeBaselineVisit records both; generateVisitSchedule
-- anchors every later visit to it). H-1: it cannot be set to any other date.
CREATE FUNCTION private.subject_baseline_matches(p_subject uuid, p_company uuid, p_date date)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(p_company = current_company_id(), false)
     AND EXISTS (
       SELECT 1
         FROM visits v
         JOIN visit_template_items i ON i.id = v.visit_template_item_id AND i.company_id = v.company_id
        WHERE v.subject_id = p_subject AND v.company_id = p_company AND i.is_baseline
          AND v.status IN ('completed', 'out_of_window') AND v.scheduled_date = p_date);
$$;

-- Visit integrity for Data API writes (final review H-1). Returns a fixed
-- rule text or NULL. The legitimate writes it must keep working are listed
-- with the rule they meet:
--   SubjectService.create (initial visits: template visit of the approved
--     template, no dates), generateVisitSchedule (insert with target =
--     baseline + offset and the template window; recalculation of visits not
--     yet occurred, in progress included), completeBaselineVisit step 1
--     (in-progress baseline visit: visit date = target date, template window),
--     completeVisit step 1 (visit date while in progress), rescheduleVisit
--     (scheduled/confirmed: new target, template window or narrower when the
--     template is not readable), createUnscheduledVisit (window = target).
CREATE FUNCTION private.visit_write_blocker(p_op text, p_old public.visits, p_new public.visits)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_found     boolean := false;
  v_before    integer;
  v_after     integer;
  v_offset    integer;
  v_baseline  boolean;
  v_t_study   uuid;
  v_t_status  text;
  v_s_study   uuid;
  v_s_site    uuid;
  v_s_base    date;
  v_dates     boolean;
BEGIN
  IF NOT coalesce(p_new.company_id = current_company_id() AND can_access_site(p_new.site_id), false) THEN
    RETURN 'visits: the visit is not available';
  END IF;

  IF p_new.visit_template_item_id IS NOT NULL THEN
    SELECT i.window_before, i.window_after, i.offset_days, i.is_baseline, t.study_id, t.status
      INTO v_before, v_after, v_offset, v_baseline, v_t_study, v_t_status
      FROM visit_template_items i
      JOIN visit_templates t ON t.id = i.template_id AND t.company_id = i.company_id
     WHERE i.id = p_new.visit_template_item_id AND i.company_id = p_new.company_id;
    v_found := FOUND;
  END IF;

  IF p_op = 'INSERT' THEN
    SELECT s.study_id, s.site_id INTO v_s_study, v_s_site
      FROM subjects s WHERE s.id = p_new.subject_id AND s.company_id = p_new.company_id;
    IF NOT FOUND OR v_s_study IS DISTINCT FROM p_new.study_id OR v_s_site IS DISTINCT FROM p_new.site_id THEN
      RETURN 'visits: a visit must belong to its subject''s study and site';
    END IF;
    IF p_new.visit_template_item_id IS NOT NULL
       AND NOT coalesce(v_found AND v_t_study = p_new.study_id AND v_t_status = 'approved', false) THEN
      RETURN 'visits: a template visit must come from the study''s approved visit template';
    END IF;
    IF p_new.scheduled_date IS NOT NULL THEN
      RETURN 'visits: the visit date is recorded when the visit is completed';
    END IF;
    v_dates := true;
  ELSE
    IF p_new.company_id IS DISTINCT FROM p_old.company_id OR p_new.subject_id IS DISTINCT FROM p_old.subject_id
       OR p_new.study_id IS DISTINCT FROM p_old.study_id OR p_new.site_id IS DISTINCT FROM p_old.site_id
       OR p_new.visit_template_item_id IS DISTINCT FROM p_old.visit_template_item_id THEN
      RETURN 'visits: the subject, study, site and template visit of a visit cannot be changed';
    END IF;
    IF p_new.scheduled_date IS DISTINCT FROM p_old.scheduled_date AND p_old.status IS DISTINCT FROM 'in_progress' THEN
      RETURN 'visits: the visit date can only be recorded while the visit is in progress';
    END IF;
    v_dates := p_new.target_date IS DISTINCT FROM p_old.target_date
               OR p_new.window_start IS DISTINCT FROM p_old.window_start
               OR p_new.window_end IS DISTINCT FROM p_old.window_end;
    IF v_dates THEN
      IF p_old.target_date IS NOT NULL AND p_new.target_date IS NULL THEN
        RETURN 'visits: the target date of a visit cannot be cleared';
      END IF;
      IF p_old.status = 'in_progress' THEN
        SELECT s.baseline_date INTO v_s_base
          FROM subjects s WHERE s.id = p_new.subject_id AND s.company_id = p_new.company_id;
        IF NOT coalesce(v_found AND ((v_baseline AND p_new.target_date = p_new.scheduled_date)
                                     OR p_new.target_date = v_s_base + v_offset), false) THEN
          RETURN 'visits: a visit in progress cannot be rescheduled';
        END IF;
      ELSIF p_old.status NOT IN ('scheduled', 'confirmed') THEN
        RETURN 'visits: the dates of a closed visit cannot be changed';
      END IF;
    END IF;
  END IF;

  -- O-1 window shape: no window without a target date; otherwise the window
  -- contains the target date and stays within the template allowance (zero
  -- for a visit without template visit).
  IF v_dates THEN
    IF p_new.target_date IS NULL THEN
      IF p_new.window_start IS NOT NULL OR p_new.window_end IS NOT NULL THEN
        RETURN 'visits: a visit window requires a target date';
      END IF;
    ELSIF p_new.window_start IS NULL OR p_new.window_end IS NULL
       OR p_new.window_start > p_new.target_date OR p_new.window_end < p_new.target_date
       OR p_new.window_start < p_new.target_date - coalesce(v_before, 0)
       OR p_new.window_end > p_new.target_date + coalesce(v_after, 0) THEN
      RETURN 'visits: the visit window must contain the target date and stay within the template window';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  private.transition_permission(text, text, text),
  private.subject_creation_blocker(uuid, uuid, uuid),
  private.visit_sequence_blocked_by(uuid),
  private.visit_sequence_gate(uuid, uuid, text),
  private.study_has_approved_template(uuid, uuid),
  private.study_has_subjects(uuid, uuid),
  private.template_is_draft(uuid, uuid),
  private.visit_is_done(uuid, uuid, uuid),
  private.subject_baseline_matches(uuid, uuid, date),
  private.visit_write_blocker(text, public.visits, public.visits)
TO authenticated;

-- Shared transition check used by the triggers below.
CREATE FUNCTION private.check_transition(p_entity text, p_from text, p_to text)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_perm text;
BEGIN
  v_perm := private.transition_permission(p_entity, p_from, p_to);
  IF v_perm IS NULL THEN
    RAISE EXCEPTION '%: invalid status transition % -> %', p_entity, p_from, p_to USING ERRCODE = '23514';
  END IF;
  IF NOT has_permission(v_perm) THEN
    RAISE EXCEPTION '%: % is required for % -> %', p_entity, v_perm, p_from, p_to USING ERRCODE = '42501';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION private.check_transition(text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.check_transition(text, text, text) TO authenticated;

-- ------------------------------------------------------------
-- 6. Trigger functions (Data API roles only)
-- ------------------------------------------------------------

-- subjects: SubjectService.ts:63-92, 193-250, 836-860, 925-935; validation.ts:263-267
CREATE FUNCTION public.enforce_subjects_workflow()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_block text;
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- M-1: the subjects_insert policy (004) first, answered exactly like RLS,
    -- so the lookups below never answer an unauthorized caller.
    IF NOT coalesce(NEW.company_id = current_company_id() AND has_permission('create_subject')
                    AND can_access_site(NEW.site_id), false) THEN
      RAISE EXCEPTION 'new row violates row-level security policy for table "subjects"' USING ERRCODE = '42501';
    END IF;
    IF NEW.status IS DISTINCT FROM 'pre_screening' THEN
      RAISE EXCEPTION 'subjects: a subject starts in pre_screening' USING ERRCODE = '23514';
    END IF;
    IF NEW.baseline_date IS NOT NULL THEN
      RAISE EXCEPTION 'subjects: the baseline date is recorded when the baseline visit is completed' USING ERRCODE = '23514';
    END IF;
    v_block := private.subject_creation_blocker(NEW.company_id, NEW.study_id, NEW.site_id);
    IF v_block IS NOT NULL THEN
      RAISE EXCEPTION '%', v_block USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.subject_number IS DISTINCT FROM OLD.subject_number THEN
    RAISE EXCEPTION 'subjects: company and subject number cannot be changed' USING ERRCODE = '23514';
  END IF;
  -- H-1: every later visit is anchored to the baseline date.
  IF NEW.baseline_date IS DISTINCT FROM OLD.baseline_date
     AND NOT private.subject_baseline_matches(NEW.id, NEW.company_id, NEW.baseline_date) THEN
    RAISE EXCEPTION 'subjects: the baseline date must be the date of the completed baseline visit' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM private.check_transition('subjects', OLD.status, NEW.status);
  END IF;
  IF NEW.status = 'randomized' AND NEW.status IS DISTINCT FROM OLD.status
     AND (NEW.baseline_date IS NULL OR NEW.randomization_date IS NULL OR NEW.randomization_number IS NULL) THEN
    RAISE EXCEPTION 'subjects: randomization requires a completed baseline and randomization details' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- visits: VisitService.ts:230-445; SubjectService.ts:573-640, 696-790, 1008-1013;
-- lib/utils/visitSequencing.ts (M4-D5); O-1.
CREATE FUNCTION public.enforce_visits_workflow()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_block      text;
  v_out_window boolean;
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- M-1: the visits_insert policy (004) first, answered exactly like RLS.
    IF NOT coalesce(NEW.company_id = current_company_id()
                    AND (has_permission('create_subject') OR has_permission('manage_visits'))
                    AND can_access_site(NEW.site_id), false) THEN
      RAISE EXCEPTION 'new row violates row-level security policy for table "visits"' USING ERRCODE = '42501';
    END IF;
    IF NEW.status IS DISTINCT FROM 'scheduled' THEN
      RAISE EXCEPTION 'visits: a visit starts as scheduled' USING ERRCODE = '23514';
    END IF;
    -- H-1: subject/study/site coherence, approved template visit, dates.
    v_block := private.visit_write_blocker('INSERT', NULL, NEW);
    IF v_block IS NOT NULL THEN
      RAISE EXCEPTION '%', v_block USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- H-1: identity is immutable; dates and window follow the template.
  v_block := private.visit_write_blocker('UPDATE', OLD, NEW);
  IF v_block IS NOT NULL THEN
    RAISE EXCEPTION '%', v_block USING ERRCODE = '23514';
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  PERFORM private.check_transition('visits', OLD.status, NEW.status);
  IF NEW.status IN ('completed', 'out_of_window') THEN
    -- O-1: same rule as SubjectService.ts:749-753.
    v_out_window := NEW.window_start IS NOT NULL AND NEW.window_end IS NOT NULL AND NEW.scheduled_date IS NOT NULL
                    AND (NEW.scheduled_date < NEW.window_start OR NEW.scheduled_date > NEW.window_end);
    IF NEW.status = 'completed' AND v_out_window THEN
      RAISE EXCEPTION 'visits: a visit performed outside its window must be recorded as out_of_window' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'out_of_window' AND NOT v_out_window THEN
      RAISE EXCEPTION 'visits: out_of_window requires a visit date outside the visit window' USING ERRCODE = '23514';
    END IF;
    -- M4-D5: required earlier visits, or an authorized exception (consumed here).
    v_block := private.visit_sequence_gate(NEW.id, NEW.company_id, NEW.status);
    IF v_block IS NOT NULL THEN
      RAISE EXCEPTION '%', v_block USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- charts: ChartService.ts:75-80, 698-800; creation by complete_visit_with_chart (026)
CREATE FUNCTION public.enforce_charts_workflow()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- M-1: the charts_insert policy (026) first, answered exactly like RLS.
    IF NOT coalesce(NEW.company_id = current_company_id() AND has_permission('edit_subject')
                    AND can_access_site(NEW.site_id), false) THEN
      RAISE EXCEPTION 'new row violates row-level security policy for table "charts"' USING ERRCODE = '42501';
    END IF;
    IF NEW.status IS DISTINCT FROM 'chart_ready' THEN
      RAISE EXCEPTION 'charts: a chart starts as chart_ready' USING ERRCODE = '23514';
    END IF;
    IF NOT private.visit_is_done(NEW.visit_id, NEW.company_id, NEW.site_id) THEN
      RAISE EXCEPTION 'charts: a chart can only be created for a completed visit' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM private.check_transition('charts', OLD.status, NEW.status);
  END IF;
  RETURN NEW;
END;
$$;

-- leads: LeadService.ts:189-205 (create), 480-540 (changeStatus), 1083-1236
-- (convertToSubject). Neither destinations nor exits from closed statuses are
-- restricted: LeadService.changeStatus allows any move except to 'converted'
-- (exceptional moves need a reason, which the database cannot see) and does
-- not apply assertNotTerminal, although BUSINESS_RULES_13 calls converted/
-- declined/lost terminal. Kept as the application behaves (Obs-3, owner
-- review); the database closes the conversion forgery (BR-5) only.
CREATE FUNCTION public.enforce_leads_workflow()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'new' OR NEW.converted_subject_id IS NOT NULL THEN
      RAISE EXCEPTION 'leads: a lead starts as new and unconverted' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.converted_subject_id IS NOT NULL AND NEW.converted_subject_id IS DISTINCT FROM OLD.converted_subject_id THEN
    RAISE EXCEPTION 'leads: the converted subject cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF (NEW.status = 'converted' AND OLD.status IS DISTINCT FROM 'converted')
     OR (NEW.converted_subject_id IS NOT NULL AND OLD.converted_subject_id IS NULL) THEN
    IF NEW.status IS DISTINCT FROM 'converted' OR NEW.converted_subject_id IS NULL THEN
      RAISE EXCEPTION 'leads: converted is set only by Convert to Subject, together with the subject' USING ERRCODE = '23514';
    END IF;
    IF NOT has_permission('convert_lead') THEN
      RAISE EXCEPTION 'leads: convert_lead is required' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- studies: StudyService.ts:162-171 (create), 526-560 (activate), 807-880
-- (close/archive), 925-940 (generic status branch kept: Obs-1).
CREATE FUNCTION public.enforce_studies_workflow()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'studies: a study starts as draft' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT has_permission('manage_studies') THEN
    RAISE EXCEPTION 'studies: manage_studies is required to change the study status' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'active' THEN
    IF OLD.status IN ('closed', 'archived') THEN
      RAISE EXCEPTION 'studies: a % study cannot be activated', OLD.status USING ERRCODE = '23514';
    END IF;
    IF NOT private.study_has_approved_template(NEW.id, NEW.company_id) THEN
      RAISE EXCEPTION 'studies: a study cannot be activated until it has an approved visit template' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status = 'archived' THEN
    IF private.study_has_subjects(NEW.id, NEW.company_id) AND NOT has_permission('force_archive_study') THEN
      RAISE EXCEPTION 'studies: archiving a study with subjects requires force_archive_study' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- visit_templates: VisitTemplateService.ts:90-240
CREATE FUNCTION public.enforce_visit_templates_workflow()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'visit_templates: a template starts as draft' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM private.check_transition('visit_templates', OLD.status, NEW.status);
  END IF;
  RETURN NEW;
END;
$$;

-- visit_template_items: only while the template is a draft (insert, update, delete)
CREATE FUNCTION public.enforce_visit_template_items_workflow()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  -- M-1: the visit_template_items_insert policy (003) first, answered
  -- exactly like RLS (UPDATE/DELETE rows already passed the USING policy).
  IF TG_OP = 'INSERT' AND NOT coalesce(NEW.company_id = current_company_id()
                                       AND (has_permission('edit_study') OR has_permission('manage_studies')), false) THEN
    RAISE EXCEPTION 'new row violates row-level security policy for table "visit_template_items"' USING ERRCODE = '42501';
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') AND NOT private.template_is_draft(OLD.template_id, OLD.company_id) THEN
    RAISE EXCEPTION 'visit_template_items: only a draft template can be changed' USING ERRCODE = '23514';
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NOT private.template_is_draft(NEW.template_id, NEW.company_id) THEN
    RAISE EXCEPTION 'visit_template_items: only a draft template can be changed' USING ERRCODE = '23514';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- visit_sequence_exceptions INSERT authorization (final review M-1). Runs
-- first (trigger names sort "authorize" < "enforce_attribution" <
-- "integrity") and as the caller (SECURITY INVOKER, so current_user is the
-- Data API role): it applies the visit_sequence_exceptions_insert policy and
-- answers exactly like RLS, before the definer integrity trigger looks up or
-- locks any visit. service_role and migrations are not restricted here.
CREATE FUNCTION public.authorize_visit_sequence_exception_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF NOT coalesce(NEW.company_id = current_company_id() AND has_permission('override_visit_sequence')
                    AND can_access_site(NEW.site_id), false) THEN
      RAISE EXCEPTION 'new row violates row-level security policy for table "visit_sequence_exceptions"' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- visit_sequence_exceptions: derived, consistent and only for a blocked,
-- not yet done visit. Applies to every role (the data must be coherent);
-- SECURITY DEFINER for the lookups, fixed search_path.
CREATE FUNCTION public.enforce_visit_sequence_exceptions_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_visit visits%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id
       OR NEW.site_id IS DISTINCT FROM OLD.site_id OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
       OR NEW.visit_id IS DISTINCT FROM OLD.visit_id OR NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.blocked_by IS DISTINCT FROM OLD.blocked_by
       OR OLD.consumed_at IS NOT NULL THEN
      RAISE EXCEPTION 'visit_sequence_exceptions: an exception is immutable once recorded' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- FOR UPDATE serializes with a concurrent completion of the same visit: if
  -- the completion commits first, the latest row (no longer open) is read and
  -- the exception is refused; otherwise the completion waits for this insert.
  -- M-1: the lookup names company, site and subject as well, so only a visit
  -- of the (already authorized) company and site can be found or locked; a
  -- missing visit and another site's or subject's visit answer the same.
  SELECT * INTO v_visit FROM visits
   WHERE id = NEW.visit_id AND company_id = NEW.company_id AND site_id = NEW.site_id AND subject_id = NEW.subject_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'visit_sequence_exceptions: the visit, subject and site do not match' USING ERRCODE = '23514';
  END IF;
  IF v_visit.status NOT IN ('scheduled', 'confirmed', 'in_progress') THEN
    RAISE EXCEPTION 'visit_sequence_exceptions: the visit is no longer open' USING ERRCODE = '23514';
  END IF;
  IF NEW.consumed_at IS NOT NULL OR NEW.consumed_status IS NOT NULL THEN
    RAISE EXCEPTION 'visit_sequence_exceptions: a new exception cannot be pre-consumed' USING ERRCODE = '23514';
  END IF;
  NEW.blocked_by := (
    SELECT coalesce(jsonb_agg(pred.visit_name ORDER BY pred.visit_order, pred.visit_name), '[]'::jsonb)
      FROM visit_template_items item
      JOIN visit_template_items pred
        ON pred.template_id = item.template_id AND pred.company_id = item.company_id
       AND pred.visit_order < item.visit_order AND pred.is_required
     WHERE item.id = v_visit.visit_template_item_id AND item.company_id = v_visit.company_id
       AND NOT EXISTS (
         SELECT 1 FROM visits done
          WHERE done.subject_id = v_visit.subject_id AND done.company_id = v_visit.company_id
            AND done.visit_template_item_id = pred.id
            AND done.status IN ('completed', 'out_of_window')));
  IF NEW.blocked_by = '[]'::jsonb THEN
    RAISE EXCEPTION 'visit_sequence_exceptions: the visit is not blocked by earlier visits' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_visit_sequence_exceptions_integrity() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.authorize_visit_sequence_exception_insert() FROM PUBLIC, anon, authenticated, service_role;

-- Trigger functions are not callable as RPC (they return trigger), but keep
-- EXECUTE closed like the other definer/trigger helpers.
REVOKE ALL ON FUNCTION
  public.enforce_subjects_workflow(),
  public.enforce_visits_workflow(),
  public.enforce_charts_workflow(),
  public.enforce_leads_workflow(),
  public.enforce_studies_workflow(),
  public.enforce_visit_templates_workflow(),
  public.enforce_visit_template_items_workflow()
FROM PUBLIC, anon, service_role;

-- ------------------------------------------------------------
-- 7. Triggers (named after 038's trg_<table>_enforce_attribution, so they
--    fire after it: BEFORE triggers run in name order)
-- ------------------------------------------------------------
CREATE TRIGGER trg_subjects_enforce_workflow BEFORE INSERT OR UPDATE ON public.subjects
  FOR EACH ROW EXECUTE FUNCTION public.enforce_subjects_workflow();
CREATE TRIGGER trg_visits_enforce_workflow BEFORE INSERT OR UPDATE ON public.visits
  FOR EACH ROW EXECUTE FUNCTION public.enforce_visits_workflow();
CREATE TRIGGER trg_charts_enforce_workflow BEFORE INSERT OR UPDATE ON public.charts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_charts_workflow();
CREATE TRIGGER trg_leads_enforce_workflow BEFORE INSERT OR UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.enforce_leads_workflow();
CREATE TRIGGER trg_studies_enforce_workflow BEFORE INSERT OR UPDATE ON public.studies
  FOR EACH ROW EXECUTE FUNCTION public.enforce_studies_workflow();
CREATE TRIGGER trg_visit_templates_enforce_workflow BEFORE INSERT OR UPDATE ON public.visit_templates
  FOR EACH ROW EXECUTE FUNCTION public.enforce_visit_templates_workflow();
CREATE TRIGGER trg_visit_template_items_enforce_workflow BEFORE INSERT OR UPDATE OR DELETE ON public.visit_template_items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_visit_template_items_workflow();
CREATE TRIGGER trg_visit_sequence_exceptions_integrity BEFORE INSERT OR UPDATE ON public.visit_sequence_exceptions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_visit_sequence_exceptions_integrity();
CREATE TRIGGER trg_visit_sequence_exceptions_authorize BEFORE INSERT ON public.visit_sequence_exceptions
  FOR EACH ROW EXECUTE FUNCTION public.authorize_visit_sequence_exception_insert();

-- ------------------------------------------------------------
-- 8. Postconditions
-- ------------------------------------------------------------
DO $$
DECLARE
  v_bad text := '';
BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
        'trg_subjects_enforce_workflow', 'trg_visits_enforce_workflow', 'trg_charts_enforce_workflow',
        'trg_leads_enforce_workflow', 'trg_studies_enforce_workflow', 'trg_visit_templates_enforce_workflow',
        'trg_visit_template_items_enforce_workflow', 'trg_visit_sequence_exceptions_integrity',
        'trg_visit_sequence_exceptions_enforce_attribution', 'trg_visit_sequence_exceptions_authorize')) <> 10 THEN
    v_bad := v_bad || ' triggers';
  END IF;
  -- M-1: the authorization trigger must fire before every other BEFORE INSERT
  -- trigger of the table (name order).
  IF (SELECT min(tgname) FROM pg_trigger WHERE tgrelid = 'public.visit_sequence_exceptions'::regclass AND NOT tgisinternal)
     IS DISTINCT FROM 'trg_visit_sequence_exceptions_authorize' THEN
    v_bad := v_bad || ' trigger-order';
  END IF;
  -- H-1: one visit per subject and template visit.
  IF NOT EXISTS (SELECT 1 FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid
                  WHERE c.relname = 'uq_visits_subject_template_item' AND x.indisunique AND x.indisvalid) THEN
    v_bad := v_bad || ' unique-visit-index';
  END IF;
  IF (SELECT count(*) FROM private.workflow_transitions WHERE enforcement = 'enforced') <> 29
     OR (SELECT count(*) FROM private.workflow_transitions WHERE enforcement = 'reference') <> 41 THEN
    v_bad := v_bad || ' transitions';
  END IF;
  IF has_schema_privilege('anon', 'private', 'USAGE')
     OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'private'::regnamespace
                 AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('service_role', p.oid, 'EXECUTE')))
     OR has_table_privilege('authenticated', 'private.workflow_transitions', 'SELECT')
     OR has_table_privilege('anon', 'public.visit_sequence_exceptions', 'SELECT')
     OR has_table_privilege('authenticated', 'public.visit_sequence_exceptions', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.visit_sequence_exceptions', 'DELETE')
     OR has_table_privilege('authenticated', 'public.visit_sequence_exceptions', 'TRUNCATE') THEN
    v_bad := v_bad || ' privileges';
  END IF;
  IF EXISTS (SELECT 1 FROM public.role_permissions rp JOIN public.permissions p ON p.id = rp.permission_id
              WHERE p.key = 'override_visit_sequence') THEN
    v_bad := v_bad || ' default-grant';
  END IF;
  IF v_bad <> '' THEN
    RAISE EXCEPTION '039 postcondition failed:%', v_bad;
  END IF;
END
$$;

COMMIT;
