-- Migration: 029_chart_comments_metrics.sql
-- Description: Milestone 4.3 — Chart Comments + Chart Metrics. Introduces the
--   `chart_comments` and `chart_metrics` tables (docs/DATABASE_Part_04
--   Charts_Tasks_Analytics.md §4-5), the `comment_chart` permission, and no
--   other schema change. Does not modify migrations 026, 027, or 028, and
--   does not touch `charts` or `chart_history`.
--
-- ============================================================
-- SCOPE (approved Milestone 4.3 plan)
-- ============================================================
-- In scope:
--   - chart_comments: append-only comment thread on a chart, postable by an
--     authorized user regardless of chart lock state (comments never mutate
--     the chart itself, so they do not need to respect the entered_in_edc
--     immutability gate that charts_update enforces).
--   - chart_metrics: one current, recalculated-in-place row per chart,
--     holding the 5 fields DATABASE_Part_04 §5 already specifies.
--
-- Explicitly OUT of scope for this migration (approved Milestone 4.3 plan):
--   - chart_assignments — migration 026 already deferred this to
--     Milestone 5 / Task Engine; unchanged here.
--   - Sponsor-visit resolution — verified during Milestone 4.3 planning that
--     no calendar_events row of event_type='sponsor_visit' can be produced
--     by any existing code path (VisitService only ever writes
--     'patient_visit'; no CalendarService/manual-create UI exists). Building
--     that write path is out of scope (no new Calendar architecture, no
--     scheduling subsystem). chart_metrics.sponsor_priority therefore stays
--     hardcoded false here, exactly mirroring ChartService.computeChartAging's
--     existing sponsorVisitApproaching=false default — not a new gap, the
--     same already-approved Milestone 4.1 "P3" limitation, now also reflected
--     in this table.
--   - Task Engine, Realtime, background workers, analytics_kpis writes.
--
-- ============================================================
-- CHART_COMMENTS — append-only, no UPDATE/DELETE policy at all (same
-- enforcement style as chart_history, migration 026): immutability after
-- creation is a database guarantee, not a UI convention. Postable on a
-- locked (entered_in_edc) chart without reopen_chart — a comment is a
-- side-table record, never a mutation of charts.status or any clinical
-- field on the chart itself, so it does not need the reopen_chart gate that
-- protects the chart row.
-- ============================================================

CREATE TABLE chart_comments (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  chart_id   uuid        NOT NULL REFERENCES charts(id) ON DELETE CASCADE,
  comment    text        NOT NULL,
  created_by uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_chart_comments_not_blank CHECK (btrim(comment) <> '')
);

CREATE INDEX idx_chart_comments_chart   ON chart_comments(chart_id);
CREATE INDEX idx_chart_comments_company ON chart_comments(company_id);

ALTER TABLE chart_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "chart_comments_select" ON chart_comments
  FOR SELECT USING (
    company_id = current_company_id()
    AND has_permission('view_charts')
  );

CREATE POLICY "chart_comments_insert" ON chart_comments
  FOR INSERT WITH CHECK (
    company_id = current_company_id()
    AND has_permission('comment_chart')
  );

-- Deliberately no UPDATE or DELETE policy — comments are immutable and
-- permanent for this milestone (no edit, no delete, no hard-delete route),
-- enforced here at the database level so no future application-layer bug
-- could accidentally expose an edit/delete path.

-- ============================================================
-- CHART_METRICS — exactly one current row per chart (UNIQUE chart_id),
-- recalculated in place via upsert. This is a derived/reporting snapshot,
-- never the historical ledger (chart_history/audit_logs remain that).
-- overdue_days reuses the exact same day-count math as
-- ChartService.computeChartAging (see service layer) — one authoritative
-- "days overdue" formula in the codebase, not two.
-- ============================================================

CREATE TABLE chart_metrics (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  chart_id             uuid        NOT NULL REFERENCES charts(id) ON DELETE CASCADE,
  ready_to_entry_hours numeric,
  total_entry_hours    numeric,
  overdue_days         numeric,
  out_of_window        boolean     NOT NULL DEFAULT false,
  sponsor_priority     boolean     NOT NULL DEFAULT false,
  calculated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_chart_metrics_chart ON chart_metrics(chart_id);
CREATE INDEX idx_chart_metrics_company ON chart_metrics(company_id);

ALTER TABLE chart_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "chart_metrics_select" ON chart_metrics
  FOR SELECT USING (
    company_id = current_company_id()
    AND has_permission('view_charts')
  );

-- Never written directly by a user action — only ever upserted by
-- ChartService as a side effect of an already-permission-gated chart
-- transition (creation, start entry, mark entered, reopen). Same predicate
-- shape as chart_history_insert (migration 026) for exactly that reason: if
-- you're already allowed to perform the transition, you're allowed to write
-- its derived metrics row.
CREATE POLICY "chart_metrics_insert" ON chart_metrics
  FOR INSERT WITH CHECK (
    company_id = current_company_id()
    AND (
      has_permission('edit_subject')
      OR has_permission('mark_chart_ready')
      OR has_permission('mark_chart_entered')
      OR has_permission('reopen_chart')
    )
  );

CREATE POLICY "chart_metrics_update" ON chart_metrics
  FOR UPDATE USING (
    company_id = current_company_id()
    AND (
      has_permission('edit_subject')
      OR has_permission('mark_chart_ready')
      OR has_permission('mark_chart_entered')
      OR has_permission('reopen_chart')
    )
  )
  WITH CHECK (
    company_id = current_company_id()
  );

-- No DELETE policy — a chart_metrics row lives and dies with its chart
-- (ON DELETE CASCADE), never deleted independently.

-- ============================================================
-- PERMISSIONS — comment_chart
-- Dedicated permission, not a reuse of view_charts / mark_chart_ready /
-- mark_chart_entered / reopen_chart (Milestone 4.3 R3 decision) — commenting
-- is a distinct write capability, matching the one-permission-per-verb model
-- migration 026 established for view/mark_ready/mark_entered/reopen.
-- ============================================================

INSERT INTO permissions (key, module, description)
VALUES
  ('comment_chart', 'charts', 'Add a comment to a chart')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- BACKFILL — grant comment_chart to every EXISTING company's Admin, CRC, and
-- Data Entry roles, matching exactly what CompanyService.ts's provision()
-- now grants to newly provisioned companies. Not granted to CEO (view-only),
-- Regulatory, or PI (unrelated to charts). comment_chart is a normal
-- capability, not a conscious-elevation permission like reopen_chart, so
-- Admin receives it by default (not added to ADMIN_EXCLUDED_PERMISSIONS).
-- Same backfill pattern as migrations 016/022/026.
-- ============================================================

INSERT INTO role_permissions (company_id, role_id, permission_id, allowed)
SELECT r.company_id, r.id, p.id, true
FROM roles r
CROSS JOIN permissions p
WHERE r.key = 'admin'
  AND p.key = 'comment_chart'
ON CONFLICT (company_id, role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (company_id, role_id, permission_id, allowed)
SELECT r.company_id, r.id, p.id, true
FROM roles r
CROSS JOIN permissions p
WHERE r.key = 'crc'
  AND p.key = 'comment_chart'
ON CONFLICT (company_id, role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (company_id, role_id, permission_id, allowed)
SELECT r.company_id, r.id, p.id, true
FROM roles r
CROSS JOIN permissions p
WHERE r.key = 'data_entry'
  AND p.key = 'comment_chart'
ON CONFLICT (company_id, role_id, permission_id) DO NOTHING;

-- ============================================================
-- ROLLBACK
-- DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE key = 'comment_chart');
-- DELETE FROM permissions WHERE key = 'comment_chart';
-- DROP POLICY IF EXISTS "chart_metrics_update" ON chart_metrics;
-- DROP POLICY IF EXISTS "chart_metrics_insert" ON chart_metrics;
-- DROP POLICY IF EXISTS "chart_metrics_select" ON chart_metrics;
-- DROP TABLE IF EXISTS chart_metrics CASCADE;
-- DROP POLICY IF EXISTS "chart_comments_insert" ON chart_comments;
-- DROP POLICY IF EXISTS "chart_comments_select" ON chart_comments;
-- DROP TABLE IF EXISTS chart_comments CASCADE;
-- ============================================================
