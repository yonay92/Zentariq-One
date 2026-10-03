-- Migration: 030_task_engine.sql
-- Description: Milestone 5.0 — Task Engine. Introduces the generic,
--   cross-module `tasks` / `task_history` / `task_comments` tables
--   (docs/DATABASE_Part_04_Charts_Tasks_Analytics.md §6-9) and the durable
--   chart-ownership `chart_assignments` table (§6, deferred here from
--   migration 026/029). Charts is the first producer of the generic engine,
--   not a Charts-specific task system — Subjects/Studies/Regulatory
--   producers are explicitly out of scope for this migration and will
--   integrate later without any change to the schema created here.
--
-- ============================================================
-- SCOPE (approved Milestone 5.0 design — Phase A, Phase B, the Phase B
-- Final Security Addendum, and the Final RLS Correction)
-- ============================================================
-- In scope:
--   - chart_assignments: durable, chart-level ownership record, fully
--     decoupled from tasks.assigned_to (a chart's owner is a default
--     ASSIGNEE SOURCE for a newly-created chart task, never a live link).
--   - tasks / task_history / task_comments: generic engine, polymorphic
--     source_module/source_record_type/source_record_id (same pattern as
--     file_links — docs/ARCHITECT_REVIEW.md §4.1).
--   - Three new SECURITY DEFINER helper functions: user_has_site_access
--     (generalizes can_access_site to an arbitrary target user — needed
--     because the chart-assignment owner and the task assignee are almost
--     always a different user than the calling session), and
--     chart_accessible_for_assignment / chart_assignment_target_valid
--     (used exclusively by chart_assignments' own RLS, so that policy does
--     not implicitly depend on view_charts via an un-hardened subquery —
--     see the "why not a raw subquery" note below).
--   - New permissions: create_task, comment_task, cancel_task,
--     manage_chart_assignments. Backfill existing companies' role grants.
--     Backfill assign_task (already existed, unused since its original
--     seeding — grant to admin only, matching approved design).
--
-- Explicitly OUT of scope for this migration (approved design):
--   - Business Rule Engine (none exists; not introduced here).
--   - Any change to chart_history / chart_comments / charts_insert /
--     charts_select or any other Milestone 1-4 object. The discovered
--     chart_history/chart_comments site-isolation gap (missing
--     can_access_site check on their SELECT policies) is REAL, PRE-EXISTING
--     technical debt, deliberately left untouched here per explicit
--     instruction — to be logged in GAP_ANALYSIS.md and remediated by a
--     separate, narrowly-scoped migration later.
--   - Any change to CompanyService.ts's provision() default-permission
--     lists. crcPerms/dataEntryPerms are explicit arrays in that file and
--     will need comment_task (and manage_chart_assignments for crc) added
--     for NEWLY PROVISIONED companies in a later phase — adminPerms needs
--     no change (it is "all permissions except ADMIN_EXCLUDED_PERMISSIONS",
--     computed generically, so it already covers every permission seeded
--     below). This migration only backfills EXISTING companies.
--   - task-overdue-checker / any cron / any Edge Function / any Realtime
--     channel — explicitly deferred to Milestone 5.1 or later.
--   - ChartService/TaskService/API/UI code — a later, separately-approved
--     implementation phase.
--
-- ============================================================
-- WHY NOT A RAW SUBQUERY FOR chart_assignments' SITE CHECK
-- ============================================================
-- A plain `EXISTS (SELECT 1 FROM charts WHERE ...)` written directly inside
-- a chart_assignments RLS policy body runs as the CALLING session and is
-- therefore itself filtered by charts_select's own RLS (which requires
-- view_charts). That would silently and unintentionally couple
-- chart_assignments authorization to a Charts-module READ permission it
-- was never reviewed against — the same class of unreviewed cross-
-- permission coupling this design explicitly rejected for tasks_insert
-- (see below, "why not mark_chart_ready"). The fix is the same one
-- current_company_id()/has_permission()/can_access_site() already use:
-- STABLE SECURITY DEFINER functions, which read their underlying tables
-- (here, charts and profiles) authoritatively, bypassing RLS by virtue of
-- executing as the function owner, not the calling session.
--
-- ============================================================
-- WHY NOT mark_chart_ready FOR tasks_insert
-- ============================================================
-- mark_chart_ready means exactly one thing: this role may transition a
-- chart into chart_ready status. It says nothing about, and was never
-- reviewed against, generic tasks-table write authority. Using it (or any
-- single-module permission) to gate tasks_insert would (a) create an
-- invisible privilege coupling if that permission is ever granted to a role
-- for unrelated reasons, and (b) not generalize to the approved
-- multi-producer architecture, which would require editing this policy
-- every time a new module becomes a task producer. Instead: tasks_insert
-- authorizes ONLY manual creation (create_task, for the authenticated
-- role/RLS). All system-generated task rows (the Charts producer, today)
-- are written exclusively by TaskService's two private, non-route-exposed
-- functions via the service-role/admin client — the exact same mechanism
-- already used by NotificationService.dispatch() (notifications has NO
-- authenticated INSERT policy at all, "INSERT only via service role") and
-- by ChartService.getChartForCommentScopeOrThrow (Milestone 4.3). RLS on
-- tasks/task_history is therefore narrower after this migration than a
-- naive design would produce, not weaker.
--
-- ============================================================
-- SECURITY DEFINER FUNCTION HARDENING
-- ============================================================
-- The four pre-existing SECURITY DEFINER functions in this codebase
-- (current_company_id, has_permission, can_access_site, and
-- calculate_chart_priority-style helpers where applicable) do not set an
-- explicit search_path and do not restrict their PUBLIC execute grant —
-- confirmed by inspection of migrations 001/002; this is real, pre-existing
-- hardening debt, of the same technical-debt class as the chart_history/
-- chart_comments RLS gap, and is NOT touched here (modifying those
-- functions is outside this migration's approved scope). The three NEW
-- functions below are, however, hardened to current best practice, since
-- there is no reason to propagate a known gap into brand-new surface:
--   - `SET search_path = public, pg_temp` pins every unqualified table
--     reference inside the function body, regardless of the calling
--     session's own search_path, closing the classic SECURITY DEFINER
--     search-path-injection class of bug.
--   - PUBLIC execute is revoked; EXECUTE is granted only to `authenticated`
--     (needed because RLS policy evaluation and ordinary application
--     queries run as that role) and `service_role` (needed because
--     TaskService's server-side stale-assignment check calls
--     user_has_site_access via the admin/service-role client). `anon` is
--     deliberately excluded — no unauthenticated caller has any legitimate
--     reason to invoke these.
-- ============================================================

-- ============================================================
-- FUNCTION: user_has_site_access(p_user_id, p_site_id)
-- Generalizes can_access_site (migration 002, hardcoded to auth.uid()) to
-- an arbitrary target user. Needed because the chart_assignments owner
-- (and, by extension, a task's default assignee) is almost always a
-- DIFFERENT user than the session performing the write that triggers the
-- check. Never referenced by any RLS policy other than chart_assignments'
-- own (below); also called directly by TaskService's server-side
-- stale-assignment check (service layer, not RLS).
-- ============================================================

CREATE OR REPLACE FUNCTION user_has_site_access(p_user_id uuid, p_site_id uuid)
RETURNS boolean AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM user_sites
      WHERE user_id = p_user_id AND site_id = p_site_id
    )
    OR EXISTS (
      SELECT 1 FROM user_roles ur
      JOIN role_permissions rp ON rp.role_id = ur.role_id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = p_user_id AND p.key = 'view_all_sites' AND rp.allowed = true
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- ============================================================
-- FUNCTION: chart_accessible_for_assignment(p_chart_id)
-- Caller-scoped: does the given chart exist, belong to my company, and am I
-- (the calling session) authorized for its site? Deliberately does NOT
-- check view_charts — that permission is checked separately, on purpose,
-- in chart_assignments_select below, so the two concerns stay independent
-- and auditable rather than silently fused.
-- ============================================================

CREATE OR REPLACE FUNCTION chart_accessible_for_assignment(p_chart_id uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM charts
    WHERE id = p_chart_id
      AND company_id = current_company_id()
      AND can_access_site(site_id)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- ============================================================
-- FUNCTION: chart_assignment_target_valid(p_chart_id, p_assigned_to)
-- Assignee-scoped: for the given chart, is p_assigned_to (almost always a
-- DIFFERENT user than the caller doing the assigning) in the same company
-- as the chart, and does that user have site access to the chart's site?
-- Built on user_has_site_access rather than can_access_site for the same
-- reason that function exists: can_access_site is hardcoded to auth.uid().
-- ============================================================

CREATE OR REPLACE FUNCTION chart_assignment_target_valid(p_chart_id uuid, p_assigned_to uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM charts c
    WHERE c.id = p_chart_id
      AND EXISTS (
        SELECT 1 FROM profiles pr WHERE pr.id = p_assigned_to AND pr.company_id = c.company_id
      )
      AND user_has_site_access(p_assigned_to, c.site_id)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- ============================================================
-- CHART_ASSIGNMENTS — durable chart ownership (FK -> companies, charts,
-- profiles). No site_id column: site scope is derived exclusively from the
-- parent chart via the two functions above, so there is exactly one
-- authoritative site relationship, never a second copy that could drift.
-- Reassignment is soft-close (active=false) + insert of a new active row —
-- never an in-place UPDATE of assigned_to — so ownership history is fully
-- reconstructable from the table itself, matching chart_history's
-- "never mutate history, only add to it" convention.
-- ============================================================

CREATE TABLE chart_assignments (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  chart_id     uuid        NOT NULL REFERENCES charts(id) ON DELETE CASCADE,
  assigned_to  uuid        NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  assigned_by  uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  assigned_at  timestamptz NOT NULL DEFAULT now(),
  active       boolean     NOT NULL DEFAULT true
);

CREATE INDEX idx_chart_assignments_chart   ON chart_assignments(chart_id);
CREATE INDEX idx_chart_assignments_company ON chart_assignments(company_id);

-- At most one ACTIVE assignment per chart at any time.
CREATE UNIQUE INDEX uq_chart_assignments_active_per_chart
  ON chart_assignments(chart_id) WHERE active = true;

ALTER TABLE chart_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "chart_assignments_select" ON chart_assignments
  FOR SELECT USING (
    company_id = current_company_id()
    AND has_permission('view_charts')
    AND chart_accessible_for_assignment(chart_id)
  );

CREATE POLICY "chart_assignments_insert" ON chart_assignments
  FOR INSERT WITH CHECK (
    company_id = current_company_id()
    AND has_permission('manage_chart_assignments')
    AND chart_accessible_for_assignment(chart_id)
    AND (active = false OR chart_assignment_target_valid(chart_id, assigned_to))
  );

CREATE POLICY "chart_assignments_update" ON chart_assignments
  FOR UPDATE USING (
    company_id = current_company_id()
    AND has_permission('manage_chart_assignments')
    AND chart_accessible_for_assignment(chart_id)
  )
  WITH CHECK (
    company_id = current_company_id()
    AND chart_accessible_for_assignment(chart_id)
    AND (active = false OR chart_assignment_target_valid(chart_id, assigned_to))
  );

-- Deliberately no DELETE policy — assignments are closed (active=false),
-- never deleted; historical inactive rows are permanent.

-- ============================================================
-- TASKS — central, generic, cross-module work queue (FK -> companies,
-- sites, profiles). source_module/source_record_type/source_record_id is
-- the same polymorphic-reference pattern already used by file_links
-- (docs/ARCHITECT_REVIEW.md §4.1) — Charts is the first producer, not the
-- only one this schema will ever support.
-- ============================================================

CREATE TABLE tasks (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  site_id            uuid        NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  assigned_to        uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  assigned_role      text,
  source_module      text        NOT NULL,
  source_record_type text,
  source_record_id   uuid,
  title              text        NOT NULL,
  description        text,
  priority           text        NOT NULL DEFAULT 'medium',
  status             text        NOT NULL DEFAULT 'new',
  due_date           timestamptz,
  created_by_system  boolean     NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_tasks_priority CHECK (priority IN ('critical','high','medium','low')),
  CONSTRAINT chk_tasks_status   CHECK (status IN ('new','assigned','in_progress','waiting','completed','cancelled')),
  -- A task with neither an individual nor a role assignee would be
  -- invisible to everyone under tasks_select below except an admin with
  -- view_tasks and full site access — never a valid state.
  CONSTRAINT chk_tasks_assignee CHECK (assigned_to IS NOT NULL OR assigned_role IS NOT NULL)
);

CREATE INDEX idx_tasks_company     ON tasks(company_id);
CREATE INDEX idx_tasks_site        ON tasks(site_id);
CREATE INDEX idx_tasks_status      ON tasks(status);
CREATE INDEX idx_tasks_due_date    ON tasks(due_date);
CREATE INDEX idx_tasks_assigned_to ON tasks(assigned_to);
CREATE INDEX idx_tasks_source      ON tasks(source_record_type, source_record_id);

-- Idempotency backstop (application-level guard is TaskService's own
-- result.chart_created check): at most one OPEN auto-created task per
-- source record. Terminal tasks are excluded so a NEW task can legitimately
-- be opened later against the same source record (e.g., chart reopened).
CREATE UNIQUE INDEX uq_tasks_open_per_source
  ON tasks(source_module, source_record_type, source_record_id)
  WHERE status NOT IN ('completed', 'cancelled') AND source_record_id IS NOT NULL;

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

-- assigned_to = auth.uid() NEVER stands alone — it only ever widens
-- visibility inside an already-authorized company+site, never around it.
CREATE POLICY "tasks_select" ON tasks
  FOR SELECT USING (
    company_id = current_company_id()
    AND can_access_site(site_id)
    AND (has_permission('view_tasks') OR assigned_to = auth.uid())
  );

-- Manual creation ONLY. All system-generated task rows are written via the
-- service-role/admin client by TaskService's private functions, which never
-- touch this policy at all (see header note above).
CREATE POLICY "tasks_insert" ON tasks
  FOR INSERT WITH CHECK (
    company_id = current_company_id()
    AND can_access_site(site_id)
    AND has_permission('create_task')
  );

CREATE POLICY "tasks_update" ON tasks
  FOR UPDATE USING (
    company_id = current_company_id()
    AND can_access_site(site_id)
    AND (
      has_permission('complete_task')
      OR has_permission('assign_task')
      OR has_permission('cancel_task')
      OR assigned_to = auth.uid()
    )
  )
  WITH CHECK (
    company_id = current_company_id()
    AND can_access_site(site_id)
  );

-- No DELETE policy — tasks are never hard-deleted.

-- ============================================================
-- TASK_HISTORY — append-only status-transition ledger (FK -> companies,
-- tasks, profiles). Site scope is derived by joining back to the parent
-- task (AE-3, the Final RLS Correction's mandated strict pattern) — this is
-- the STRICTER version, deliberately NOT reproducing chart_history's
-- shipped (company+permission-only) predicate. See header note: the
-- pre-existing chart_history/chart_comments gap is untouched here.
-- ============================================================

CREATE TABLE task_history (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  task_id     uuid        NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  old_status  text,
  new_status  text        NOT NULL,
  changed_by  uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  reason      text
);

CREATE INDEX idx_task_history_task ON task_history(task_id);

ALTER TABLE task_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "task_history_select" ON task_history
  FOR SELECT USING (
    company_id = current_company_id()
    AND EXISTS (
      SELECT 1 FROM tasks t
      WHERE t.id = task_history.task_id
        AND can_access_site(t.site_id)
        AND (has_permission('view_tasks') OR t.assigned_to = auth.uid())
    )
  );

-- Covers only user-initiated transitions (complete/reassign/cancel). The
-- system-generated "task created" and "task auto-completed on EDC entry"
-- history rows are written via the service-role/admin client and never go
-- through this policy at all.
CREATE POLICY "task_history_insert" ON task_history
  FOR INSERT WITH CHECK (
    company_id = current_company_id()
    AND EXISTS (
      SELECT 1 FROM tasks t
      WHERE t.id = task_history.task_id AND can_access_site(t.site_id)
    )
    AND (
      has_permission('complete_task')
      OR has_permission('assign_task')
      OR has_permission('cancel_task')
    )
  );

-- No UPDATE/DELETE — history rows are permanent.

-- ============================================================
-- TASK_COMMENTS — append-only comment thread (FK -> companies, tasks,
-- profiles). Same strict joined-site-isolation pattern as task_history.
-- comment_task is always a genuine, user-initiated permission with no
-- system-generated equivalent, so unlike tasks/task_history's INSERT
-- policy this one is unaffected by the mark_chart_ready correction.
-- ============================================================

CREATE TABLE task_comments (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  task_id    uuid        NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  comment    text        NOT NULL,
  created_by uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_task_comments_not_blank CHECK (btrim(comment) <> '')
);

CREATE INDEX idx_task_comments_task ON task_comments(task_id);

ALTER TABLE task_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "task_comments_select" ON task_comments
  FOR SELECT USING (
    company_id = current_company_id()
    AND EXISTS (
      SELECT 1 FROM tasks t
      WHERE t.id = task_comments.task_id
        AND can_access_site(t.site_id)
        AND (has_permission('view_tasks') OR t.assigned_to = auth.uid())
    )
  );

CREATE POLICY "task_comments_insert" ON task_comments
  FOR INSERT WITH CHECK (
    company_id = current_company_id()
    AND has_permission('comment_task')
    AND EXISTS (
      SELECT 1 FROM tasks t WHERE t.id = task_comments.task_id AND can_access_site(t.site_id)
    )
  );

-- No UPDATE/DELETE — comments are permanent.

-- ============================================================
-- PERMISSIONS — create_task, comment_task, cancel_task,
-- manage_chart_assignments (all new). assign_task already exists (seeded
-- pre-Milestone-5, never previously granted to any role).
-- ============================================================

INSERT INTO permissions (key, module, description)
VALUES
  ('create_task',              'tasks',  'Manually create a task'),
  ('comment_task',              'tasks',  'Add a comment to a task'),
  ('cancel_task',                'tasks',  'Cancel a task with a reason'),
  ('manage_chart_assignments',  'charts', 'Assign or reassign a chart''s durable owner')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- BACKFILL — grant to every EXISTING company's roles, matching exactly
-- what a future CompanyService.ts provision() update will grant to newly
-- provisioned companies (adminPerms is computed generically and needs no
-- code change; crcPerms/dataEntryPerms are explicit arrays that WILL need
-- comment_task, and for crc also manage_chart_assignments, added in a
-- later phase — see header note; this migration only backfills existing
-- companies' role_permissions). Same backfill pattern as migrations
-- 016/022/026/029.
-- ============================================================

-- admin: create_task, comment_task, cancel_task, manage_chart_assignments,
-- and the pre-existing-but-never-granted assign_task.
INSERT INTO role_permissions (company_id, role_id, permission_id, allowed)
SELECT r.company_id, r.id, p.id, true
FROM roles r
CROSS JOIN permissions p
WHERE r.key = 'admin'
  AND p.key IN ('create_task', 'comment_task', 'cancel_task', 'manage_chart_assignments', 'assign_task')
ON CONFLICT (company_id, role_id, permission_id) DO NOTHING;

-- crc: comment_task, manage_chart_assignments.
INSERT INTO role_permissions (company_id, role_id, permission_id, allowed)
SELECT r.company_id, r.id, p.id, true
FROM roles r
CROSS JOIN permissions p
WHERE r.key = 'crc'
  AND p.key IN ('comment_task', 'manage_chart_assignments')
ON CONFLICT (company_id, role_id, permission_id) DO NOTHING;

-- data_entry: comment_task.
INSERT INTO role_permissions (company_id, role_id, permission_id, allowed)
SELECT r.company_id, r.id, p.id, true
FROM roles r
CROSS JOIN permissions p
WHERE r.key = 'data_entry'
  AND p.key = 'comment_task'
ON CONFLICT (company_id, role_id, permission_id) DO NOTHING;

-- ============================================================
-- EXECUTE GRANT HARDENING — the three new functions only, per the header
-- note above. Pre-existing functions (current_company_id, has_permission,
-- can_access_site) are untouched — modifying their grants is outside this
-- migration's approved scope and is logged as separate technical debt.
-- ============================================================

REVOKE ALL ON FUNCTION user_has_site_access(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION user_has_site_access(uuid, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION chart_accessible_for_assignment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chart_accessible_for_assignment(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION chart_assignment_target_valid(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chart_assignment_target_valid(uuid, uuid) TO authenticated, service_role;

-- ============================================================
-- ROLLBACK
-- REVOKE EXECUTE ON FUNCTION chart_assignment_target_valid(uuid, uuid) FROM authenticated, service_role;
-- REVOKE EXECUTE ON FUNCTION chart_accessible_for_assignment(uuid) FROM authenticated, service_role;
-- REVOKE EXECUTE ON FUNCTION user_has_site_access(uuid, uuid) FROM authenticated, service_role;
-- DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE key IN ('create_task', 'comment_task', 'cancel_task', 'manage_chart_assignments', 'assign_task'));
-- DELETE FROM permissions WHERE key IN ('create_task', 'comment_task', 'cancel_task', 'manage_chart_assignments');
-- DROP POLICY IF EXISTS "task_comments_insert" ON task_comments;
-- DROP POLICY IF EXISTS "task_comments_select" ON task_comments;
-- DROP TABLE IF EXISTS task_comments CASCADE;
-- DROP POLICY IF EXISTS "task_history_insert" ON task_history;
-- DROP POLICY IF EXISTS "task_history_select" ON task_history;
-- DROP TABLE IF EXISTS task_history CASCADE;
-- DROP POLICY IF EXISTS "tasks_update" ON tasks;
-- DROP POLICY IF EXISTS "tasks_insert" ON tasks;
-- DROP POLICY IF EXISTS "tasks_select" ON tasks;
-- DROP TABLE IF EXISTS tasks CASCADE;
-- DROP POLICY IF EXISTS "chart_assignments_update" ON chart_assignments;
-- DROP POLICY IF EXISTS "chart_assignments_insert" ON chart_assignments;
-- DROP POLICY IF EXISTS "chart_assignments_select" ON chart_assignments;
-- DROP TABLE IF EXISTS chart_assignments CASCADE;
-- DROP FUNCTION IF EXISTS chart_assignment_target_valid(uuid, uuid);
-- DROP FUNCTION IF EXISTS chart_accessible_for_assignment(uuid);
-- DROP FUNCTION IF EXISTS user_has_site_access(uuid, uuid);
-- ============================================================
