-- Migration: 026_charts_foundation.sql
-- Description: Milestone 4 / Sub-Milestone 4.0 — Charts & Data Entry foundation.
--   Introduces the `charts` and `chart_history` tables (docs/DATABASE_Part_04
--   Charts_Tasks_Analytics.md §2-3), the atomic visit-completion + chart-
--   creation RPC, and the `reopen_chart` permission. `view_charts` /
--   `mark_chart_ready` / `mark_chart_entered` are already forward-referenced
--   (as harmless no-ops — the rows didn't exist) by
--   supabase/seed/002_permissions.sql and services/company/CompanyService.ts's
--   provision() role grants; this migration is what makes those grants take
--   effect, exactly as migration 022 did for view_documents/upload_documents.
--
-- Explicitly OUT of scope for this migration (approved Milestone 4 / Phase B
-- plan — see the Phase A/B reports for the full rationale):
--   - chart_comments, chart_metrics, chart_assignments, tasks (Task Engine) —
--     not needed by this phase's ChartService surface; chart_assignments is
--     explicitly deferred to Milestone 5/Task Engine per product decision.
--   - Historical backfill DML (existing completed/out_of_window visits with
--     no chart) — a separate, later-numbered migration (Sub-Milestone 4.2),
--     never bundled with schema/RPC/RLS changes.
--   - Full Charts/Data Entry UI.
--
-- ============================================================
-- CHART LIFECYCLE (docs/BUSINESS_RULES_05_Charts_DataEntry.md +
-- docs/DATABASE_Part_04 §2 status vocabulary — exact values reused, no
-- additional states invented for UI convenience):
--
--   (visit completes) --[atomic RPC]--> chart_ready
--   chart_ready   -> in_progress   (mark_chart_ready)   begin data entry
--   chart_ready   -> on_hold       (mark_chart_ready)   hold
--   on_hold       -> chart_ready   (mark_chart_ready)   release hold
--   on_hold       -> in_progress   (mark_chart_ready)   release hold into entry
--   in_progress   -> on_hold       (mark_chart_ready)   hold mid-entry
--   in_progress   -> entered_in_edc (mark_chart_entered) mark Entered in EDC
--   entered_in_edc -> in_progress  (reopen_chart + mandatory reason)  correction
--
-- All other transitions are invalid and are rejected by ChartService's state
-- machine (application layer) — RLS's job (below) is the coarser guarantee
-- that ENTERED_IN_EDC rows cannot be touched by anyone lacking reopen_chart,
-- full stop, matching the "not UI-only, real server/database protection"
-- requirement. This mirrors document_versions_update (migration 016): RLS
-- enforces tenant/site/status-gate + "holds any relevant permission"; the
-- legality of a SPECIFIC transition is enforced in the service layer, same
-- division of responsibility used everywhere else in this codebase.
--
-- ASSUMPTION FLAGGED FOR CONFIRMATION: the three pre-existing chart
-- permission names (view_charts / mark_chart_ready / mark_chart_entered) are
-- not fully self-describing for the whole state machine above. This
-- migration interprets mark_chart_ready as "manage a chart anywhere in the
-- pre-entered pipeline" (start entry, hold, release) and mark_chart_entered
-- strictly as "the Entered-in-EDC action" (matching its name exactly and
-- BUSINESS_RULES_05's "Only authorized Data Entry (or approved CRC) may mark
-- Entered in EDC"). This is a judgment call, not a documented rule — flagged
-- explicitly rather than assumed silently.
-- ============================================================
--
-- Depends on: 001_companies_sites_users.sql (companies, sites,
--   current_company_id, update_updated_at_column), 002_roles_permissions.sql
--   (permissions, has_permission, can_access_site), 003_studies_visit_templates.sql
--   (studies), 004_subjects.sql (subjects, visits)
-- Rollback: see ROLLBACK section at the bottom

-- ============================================================
-- CHARTS  (FK -> companies, sites, studies, subjects, visits, profiles)
-- Exactly 0..1 chart per visit — enforced by uq_charts_visit below, the
-- database-level duplicate-prevention control required by Decision 1.
-- ============================================================

CREATE TABLE charts (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  site_id             uuid        NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  study_id            uuid        NOT NULL REFERENCES studies(id) ON DELETE RESTRICT,
  subject_id          uuid        NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  visit_id            uuid        NOT NULL REFERENCES visits(id) ON DELETE RESTRICT,
  chart_ready_date    timestamptz,
  entered_in_edc_date timestamptz,
  entered_by          uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  entered_by_role     text,
  days_until_entry    numeric,
  priority            text        NOT NULL DEFAULT 'low',
  status              text        NOT NULL DEFAULT 'chart_ready',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_charts_status CHECK (
    status IN ('chart_ready', 'in_progress', 'entered_in_edc', 'on_hold')
  ),
  CONSTRAINT chk_charts_priority CHECK (
    priority IN ('critical', 'high', 'medium', 'low')
  )
);

-- Decision 1: "no duplicate Chart for the same eligible Visit," enforced at
-- the database level. Combined with the atomic RPC's FOR UPDATE row lock on
-- visits (belt) and this constraint's ON CONFLICT handling (suspenders),
-- concurrent completion attempts cannot produce two chart rows for one visit.
CREATE UNIQUE INDEX uq_charts_visit ON charts (visit_id);

CREATE INDEX idx_charts_company ON charts(company_id);
CREATE INDEX idx_charts_site    ON charts(site_id);
CREATE INDEX idx_charts_subject ON charts(subject_id);
CREATE INDEX idx_charts_status  ON charts(company_id, status);

CREATE TRIGGER charts_updated_at
  BEFORE UPDATE ON charts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE charts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "charts_select" ON charts
  FOR SELECT USING (
    company_id = current_company_id()
    AND has_permission('view_charts')
    AND can_access_site(site_id)
  );

-- Charts are only ever created by the atomic complete_visit_with_chart() RPC
-- below, as a side effect of a visit completion the caller already holds
-- edit_subject for (SubjectService.completeVisit / completeBaselineVisit).
-- No standalone "create a chart" application flow exists in this phase.
CREATE POLICY "charts_insert" ON charts
  FOR INSERT WITH CHECK (
    company_id = current_company_id()
    AND has_permission('edit_subject')
    AND can_access_site(site_id)
  );

-- Immutability: once a chart reaches entered_in_edc, NO update succeeds
-- unless the actor holds reopen_chart — a database-level guarantee, not a
-- UI affordance. This is the direct mechanism behind Decision 2 RULE C ("no
-- silent mutation of entered/locked clinical data"), mirroring
-- document_versions_update's status-gated USING clause (migration 016).
CREATE POLICY "charts_update" ON charts
  FOR UPDATE USING (
    company_id = current_company_id()
    AND can_access_site(site_id)
    AND (status <> 'entered_in_edc' OR has_permission('reopen_chart'))
    AND (
      has_permission('mark_chart_ready')
      OR has_permission('mark_chart_entered')
      OR has_permission('reopen_chart')
    )
  )
  WITH CHECK (
    company_id = current_company_id()
    AND can_access_site(site_id)
  );

-- Deliberately no DELETE policy — charts are never hard-deleted, matching
-- the soft-delete/no-hard-delete strategy already used for every other
-- operational record in this codebase.

-- ============================================================
-- CHART_HISTORY  (FK -> companies, charts, profiles)
-- Append-only status-transition ledger, identical shape/intent to
-- document_history (migration 016). Every transition — including the
-- initial chart_ready creation and every reopen — writes exactly one row.
-- ============================================================

CREATE TABLE chart_history (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  chart_id   uuid        NOT NULL REFERENCES charts(id) ON DELETE CASCADE,
  old_status text,
  new_status text        NOT NULL,
  changed_by uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  reason     text
);

CREATE INDEX idx_chart_history_chart   ON chart_history(chart_id);
CREATE INDEX idx_chart_history_company ON chart_history(company_id);

ALTER TABLE chart_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "chart_history_select" ON chart_history
  FOR SELECT USING (
    company_id = current_company_id()
    AND has_permission('view_charts')
  );

CREATE POLICY "chart_history_insert" ON chart_history
  FOR INSERT WITH CHECK (
    company_id = current_company_id()
    AND (
      has_permission('edit_subject')
      OR has_permission('mark_chart_ready')
      OR has_permission('mark_chart_entered')
      OR has_permission('reopen_chart')
    )
  );

-- No UPDATE or DELETE policy — history rows are permanent, same as
-- document_history / audit_logs.

-- ============================================================
-- ATOMIC VISIT COMPLETION + CHART CREATION  (Decision 1)
--
-- SECURITY INVOKER (the default — stated explicitly for auditability): this
-- function runs with exactly the calling session's own privileges and RLS,
-- never elevated. It does not expose service-role capabilities to the
-- client — the client never calls this RPC directly in any case; only
-- SubjectService (server-side, using the caller's own session-scoped
-- client) does. RLS on visits/charts remains the live enforcement boundary
-- for every read/write this function performs, exactly as if the two
-- statements had been issued directly by the caller — this function's only
-- job is to make them atomic and race-safe, not to bypass authorization.
--
-- Concurrency: the visit row is locked (SELECT ... FOR UPDATE) for the
-- duration of the function call. A second concurrent call for the same
-- visit_id blocks until the first commits, then observes the already-
-- updated status and takes the idempotent/conflict branch below — no two
-- calls can ever both observe 'in_progress' and both proceed to complete.
-- uq_charts_visit is the additional, independent database-level backstop
-- (Decision 1: "not only in TypeScript").
--
-- Idempotency: a retried call with the SAME target status on an
-- already-completed visit returns success with chart_created = false
-- (safe to retry after a client-side timeout with no duplicate side
-- effects). A call that finds the visit in any other non-in_progress state
-- (e.g. a genuine concurrent race to two different target statuses) raises
-- VISIT_STATE_CONFLICT, which ChartService maps to the same BusinessRuleError
-- family SubjectService already throws for "not in progress" — this resolves
-- GAP_ANALYSIS.md's GAP-REQ-01 ("no specified behavior for concurrent visit
-- completions") with a graceful, distinguishable error, not a crash or a
-- silent double-write.
--
-- Ownership defense-in-depth: p_subject_id/p_company_id are re-checked
-- against the locked row even though RLS + the caller's own pre-fetch
-- already scoped it — belt-and-suspenders, matching this codebase's existing
-- style (e.g. VisitService.getVisitOrThrow's redundant .eq() chain).
-- ============================================================

CREATE OR REPLACE FUNCTION complete_visit_with_chart(
  p_visit_id   uuid,
  p_subject_id uuid,
  p_company_id uuid,
  p_new_status text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_visit         visits%ROWTYPE;
  v_chart         charts%ROWTYPE;
  v_chart_created boolean := false;
BEGIN
  IF p_new_status NOT IN ('completed', 'out_of_window') THEN
    RAISE EXCEPTION 'INVALID_TARGET_STATUS: % is not a valid visit completion status', p_new_status;
  END IF;

  SELECT * INTO v_visit FROM visits WHERE id = p_visit_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'VISIT_NOT_FOUND: visit % not found or not accessible', p_visit_id;
  END IF;

  IF v_visit.subject_id <> p_subject_id OR v_visit.company_id <> p_company_id THEN
    RAISE EXCEPTION 'VISIT_OWNERSHIP_MISMATCH: visit % does not belong to the given subject/company', p_visit_id;
  END IF;

  -- Idempotent retry: the visit is already in the exact target state.
  -- Ensure the chart still exists (it should — created atomically the first
  -- time) and return success without writing anything again.
  IF v_visit.status = p_new_status THEN
    SELECT * INTO v_chart FROM charts WHERE visit_id = p_visit_id;
    RETURN jsonb_build_object(
      'visit', to_jsonb(v_visit),
      'chart_id', v_chart.id,
      'chart_created', false,
      'already_completed', true
    );
  END IF;

  IF v_visit.status <> 'in_progress' THEN
    RAISE EXCEPTION 'VISIT_STATE_CONFLICT: visit % is not In Progress (current status: %)', p_visit_id, v_visit.status;
  END IF;

  UPDATE visits SET status = p_new_status WHERE id = p_visit_id RETURNING * INTO v_visit;

  INSERT INTO charts (company_id, site_id, study_id, subject_id, visit_id, status, priority, chart_ready_date)
  VALUES (v_visit.company_id, v_visit.site_id, v_visit.study_id, v_visit.subject_id, v_visit.id, 'chart_ready', 'low', now())
  ON CONFLICT (visit_id) DO NOTHING
  RETURNING * INTO v_chart;

  IF v_chart.id IS NULL THEN
    -- Conflict path: a chart already exists for this visit_id (should be
    -- unreachable given the row lock above, but the constraint is the
    -- authoritative backstop, not the lock — handled gracefully either way).
    SELECT * INTO v_chart FROM charts WHERE visit_id = p_visit_id;
  ELSE
    v_chart_created := true;
  END IF;

  RETURN jsonb_build_object(
    'visit', to_jsonb(v_visit),
    'chart_id', v_chart.id,
    'chart_created', v_chart_created,
    'already_completed', false
  );
END;
$$;

-- ============================================================
-- PERMISSIONS — charts module
-- view_charts / mark_chart_ready / mark_chart_entered are pre-existing keys
-- (supabase/seed/002_permissions.sql) already referenced by
-- CompanyService.ts's provision() role grants — this INSERT is what
-- activates those forward references on every EXISTING company's database
-- (the seed file only runs at fresh bootstrap). reopen_chart is new.
--
-- reopen_chart is deliberately excluded from Administrator's default grant
-- (see CompanyService.ts ADMIN_EXCLUDED_PERMISSIONS, updated alongside this
-- migration) — same "conscious per-role override" treatment as reopen_visit /
-- override_regulatory_status, not a default capability of any role.
-- ============================================================

INSERT INTO permissions (key, module, description)
VALUES
  ('view_charts',        'charts', 'View the chart data entry queue'),
  ('mark_chart_ready',   'charts', 'Manage a chart through the pre-entry pipeline (start entry, hold, release)'),
  ('mark_chart_entered', 'charts', 'Mark a chart as Entered in EDC'),
  ('reopen_chart',       'charts', 'Reopen an Entered-in-EDC chart for authorized correction')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- BACKFILL — grant to every EXISTING company's roles, matching exactly what
-- CompanyService.ts's provision() grants to newly provisioned companies
-- (ceoPerms: view_charts; crcPerms: mark_chart_ready, view_charts;
-- dataEntryPerms: view_charts, mark_chart_entered; adminPerms: every
-- permission except the excluded set, which now includes reopen_chart).
-- Same backfill pattern as migrations 016/022.
-- ============================================================

INSERT INTO role_permissions (company_id, role_id, permission_id, allowed)
SELECT r.company_id, r.id, p.id, true
FROM roles r
CROSS JOIN permissions p
WHERE r.key = 'admin'
  AND p.key IN ('view_charts', 'mark_chart_ready', 'mark_chart_entered')
ON CONFLICT (company_id, role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (company_id, role_id, permission_id, allowed)
SELECT r.company_id, r.id, p.id, true
FROM roles r
CROSS JOIN permissions p
WHERE r.key = 'ceo'
  AND p.key = 'view_charts'
ON CONFLICT (company_id, role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (company_id, role_id, permission_id, allowed)
SELECT r.company_id, r.id, p.id, true
FROM roles r
CROSS JOIN permissions p
WHERE r.key = 'crc'
  AND p.key IN ('mark_chart_ready', 'view_charts')
ON CONFLICT (company_id, role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (company_id, role_id, permission_id, allowed)
SELECT r.company_id, r.id, p.id, true
FROM roles r
CROSS JOIN permissions p
WHERE r.key = 'data_entry'
  AND p.key IN ('view_charts', 'mark_chart_entered')
ON CONFLICT (company_id, role_id, permission_id) DO NOTHING;

-- reopen_chart is granted to no role by default, for any company — matching
-- reopen_visit's precedent exactly. An Administrator enables it per-role via
-- Settings > Roles when the organization decides who may perform corrections.

-- ============================================================
-- ROLLBACK
-- DROP FUNCTION IF EXISTS complete_visit_with_chart(uuid, uuid, uuid, text);
-- DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE key IN ('view_charts', 'mark_chart_ready', 'mark_chart_entered', 'reopen_chart'));
-- DELETE FROM permissions WHERE key IN ('view_charts', 'mark_chart_ready', 'mark_chart_entered', 'reopen_chart');
-- DROP POLICY IF EXISTS "chart_history_insert" ON chart_history;
-- DROP POLICY IF EXISTS "chart_history_select" ON chart_history;
-- DROP TABLE IF EXISTS chart_history CASCADE;
-- DROP POLICY IF EXISTS "charts_update" ON charts;
-- DROP POLICY IF EXISTS "charts_insert" ON charts;
-- DROP POLICY IF EXISTS "charts_select" ON charts;
-- DROP TABLE IF EXISTS charts CASCADE;
-- ============================================================
