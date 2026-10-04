-- ============================================================
-- Migration 033 — Task Engine mutation-surface hardening +
-- M4 chart_history/chart_comments site-isolation fix
-- ============================================================
--
-- CONTEXT (Milestone 5.0 Final E2E Validation, security audit section):
-- PostgreSQL RLS is row-level, not column-level. The Milestone 5 tasks/
-- task_history/task_comments policies (migrations 030/032) correctly gate
-- *which rows* a session may touch, but never constrained *which columns*
-- an already-authorized UPDATE/INSERT may set, or that history/comment
-- authorship claims matched the calling session. Concretely, prior to this
-- migration, a session holding complete_task (or merely self-assigned to a
-- task) could — by calling Supabase directly with the anon key + their own
-- JWT, bypassing TaskService entirely — legally satisfy tasks_update's
-- USING/WITH CHECK while setting status/assigned_to/priority/due_date/
-- title/source_* /created_by_system to anything, insert task_history rows
-- with a spoofed changed_by, or insert a tasks row that impersonated a
-- system-generated record. This migration closes those gaps without
-- changing TaskService, any API route, or any currently-passing test:
-- everything TaskService itself does already satisfies the tightened
-- invariants below, because they were reverse-derived from what
-- TaskService already legitimately writes.
--
-- This migration does NOT re-implement the Task state machine or
-- permission model as a whole (that stays exactly as it is, in
-- TaskService/PermissionService) — it only adds the narrow, structural
-- guardrails that RLS's row-level model cannot express on its own:
--   1. tasks: a BEFORE UPDATE trigger enforcing (a) creation-time fields
--      are immutable after INSERT, (b) status only moves along the
--      approved state machine, (c) assigned_to/assigned_role may only
--      change together with assign_task, and only to a user who actually
--      has access to the task's site.
--   2. tasks: tasks_insert's WITH CHECK now also pins the fields a manual
--      creation must have (created_by_system = false, source_module =
--      'manual', no source_record_*, status in the two legal initial
--      values, and — if assigned_to is set — that the target has site
--      access), closing the "insert a fake system task" / "insert with an
--      invalid target" bypasses.
--   3. task_history_insert's WITH CHECK now requires changed_by =
--      auth.uid() (no authorship spoofing) and that new_status matches the
--      task's actual current status and the claimed transition is
--      structurally valid (or a no-op status, which reassignment
--      legitimately records) — a direct client can no longer fabricate an
--      arbitrary ledger entry for a task it can see.
--   4. task_comments_insert's WITH CHECK now requires created_by =
--      auth.uid() (no authorship spoofing).
--   5. chart_history_select / chart_comments_select (Milestone 4 debt,
--      confirmed during this validation pass): both checked only
--      company_id + view_charts, with no parent-chart site check, so a
--      view_charts user without access to a chart's site could read that
--      chart's history/comments directly. Both are corrected to require
--      can_access_site on the parent chart's site_id, mirroring the
--      task_history_select / task_comments_select pattern already
--      established in migration 030.
--
-- chart_assignments was re-audited (not modified): TaskService only ever
-- READS chart_assignments (resolveChartTaskAssignee); no service method
-- writes it, so there is no server-side audit/sync path for a direct
-- client write to bypass. Its existing INSERT/UPDATE policies already
-- require manage_chart_assignments, chart_accessible_for_assignment, and
-- (when active) chart_assignment_target_valid — unchanged here, per this
-- migration's explicit instruction not to weaken existing validation.
--
-- NOT included, deliberately, per the approved scope for this migration:
--   - No change to migrations 001-032.
--   - No change to RLS/permissions beyond the specific gaps above.
--   - No change to the Task state machine, TaskService, or any API route.
--   - task_history's old_status is still client (TaskService)-supplied and
--     is only checked for *structural* plausibility (a real transition
--     edge, or a no-op), not cryptographically tied to the row's actual
--     prior value — doing that precisely would require deriving history
--     rows entirely from a trigger, which would also have to reconstruct
--     TaskService's human-readable reason text (cancel reason, "Reassigned
--     from X to Y") and is out of scope for this hardening pass. Flagged
--     as a residual, low-severity risk in the validation report.
--
-- ROLLBACK: see the commented block at the end of this file.
-- ============================================================

-- ============================================================
-- 1. tasks — BEFORE UPDATE invariant trigger
-- ============================================================

CREATE OR REPLACE FUNCTION enforce_task_update_invariants()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Creation-time fields are immutable after INSERT — no UPDATE path,
  -- application or direct client, may ever change them.
  IF NEW.company_id          IS DISTINCT FROM OLD.company_id
     OR NEW.site_id          IS DISTINCT FROM OLD.site_id
     OR NEW.source_module    IS DISTINCT FROM OLD.source_module
     OR NEW.source_record_type IS DISTINCT FROM OLD.source_record_type
     OR NEW.source_record_id   IS DISTINCT FROM OLD.source_record_id
     OR NEW.created_by_system  IS DISTINCT FROM OLD.created_by_system
     OR NEW.title             IS DISTINCT FROM OLD.title
     OR NEW.description       IS DISTINCT FROM OLD.description
     OR NEW.priority           IS DISTINCT FROM OLD.priority
     OR NEW.due_date            IS DISTINCT FROM OLD.due_date
     OR NEW.created_at           IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'tasks: this field cannot be changed after creation'
      USING ERRCODE = '42501';
  END IF;

  -- assigned_to / assigned_role may only change together with assign_task
  -- (mirrors TaskService.reassignTask's own gate — the RLS assigned_to =
  -- auth.uid() self-carve-out authorizes completing your own task, never
  -- reassigning it away from yourself), and only to a user who actually
  -- has access to this task's site (mirrors reassignTask's
  -- targetUserHasSiteAccess check).
  IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to
     OR NEW.assigned_role IS DISTINCT FROM OLD.assigned_role
  THEN
    IF NOT has_permission('assign_task') THEN
      RAISE EXCEPTION 'tasks: reassignment requires assign_task' USING ERRCODE = '42501';
    END IF;
    IF NEW.assigned_to IS NOT NULL AND NOT user_has_site_access(NEW.assigned_to, NEW.site_id) THEN
      RAISE EXCEPTION 'tasks: assignee does not have access to this site' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- status may only move along the approved state machine (mirrors
  -- TaskService.isValidTaskTransition exactly; completed/cancelled remain
  -- terminal with no outgoing edges).
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'new'         AND NEW.status IN ('assigned', 'in_progress', 'completed', 'cancelled'))
      OR (OLD.status = 'assigned'    AND NEW.status IN ('in_progress', 'waiting', 'completed', 'cancelled'))
      OR (OLD.status = 'in_progress' AND NEW.status IN ('waiting', 'completed', 'cancelled'))
      OR (OLD.status = 'waiting'     AND NEW.status IN ('in_progress', 'completed', 'cancelled'))
    ) THEN
      RAISE EXCEPTION 'tasks: invalid status transition from % to %', OLD.status, NEW.status
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tasks_enforce_update_invariants ON tasks;
CREATE TRIGGER trg_tasks_enforce_update_invariants
  BEFORE UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION enforce_task_update_invariants();

-- ============================================================
-- 2. tasks_insert — pin manual-creation-only fields, validate target
-- ============================================================

DROP POLICY IF EXISTS "tasks_insert" ON tasks;

CREATE POLICY "tasks_insert" ON tasks
  FOR INSERT WITH CHECK (
    company_id = current_company_id()
    AND can_access_site(site_id)
    AND has_permission('create_task')
    AND created_by_system = false
    AND source_module = 'manual'
    AND source_record_type IS NULL
    AND source_record_id IS NULL
    AND status IN ('new', 'assigned')
    AND (assigned_to IS NULL OR user_has_site_access(assigned_to, site_id))
  );

-- ============================================================
-- 3. task_history_insert — no changed_by spoofing; new_status/old_status
--    must be structurally plausible against the task's real current state
-- ============================================================

CREATE OR REPLACE FUNCTION is_valid_task_transition(p_old text, p_new text)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT CASE p_old
    WHEN 'new'         THEN p_new IN ('assigned', 'in_progress', 'completed', 'cancelled')
    WHEN 'assigned'    THEN p_new IN ('in_progress', 'waiting', 'completed', 'cancelled')
    WHEN 'in_progress' THEN p_new IN ('waiting', 'completed', 'cancelled')
    WHEN 'waiting'     THEN p_new IN ('in_progress', 'completed', 'cancelled')
    ELSE false
  END;
$$;

DROP POLICY IF EXISTS "task_history_insert" ON task_history;

CREATE POLICY "task_history_insert" ON task_history
  FOR INSERT WITH CHECK (
    company_id = current_company_id()
    AND changed_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM tasks t
      WHERE t.id = task_history.task_id
        AND can_access_site(t.site_id)
        AND t.status = task_history.new_status
        AND (
          task_history.old_status IS NULL
          OR task_history.old_status = task_history.new_status
          OR is_valid_task_transition(task_history.old_status, task_history.new_status)
        )
        AND (
          has_permission('complete_task')
          OR has_permission('assign_task')
          OR has_permission('cancel_task')
          OR has_permission('create_task')
          OR t.assigned_to = auth.uid()
        )
    )
  );

-- ============================================================
-- 4. task_comments_insert — no created_by spoofing
-- ============================================================

DROP POLICY IF EXISTS "task_comments_insert" ON task_comments;

CREATE POLICY "task_comments_insert" ON task_comments
  FOR INSERT WITH CHECK (
    company_id = current_company_id()
    AND created_by = auth.uid()
    AND has_permission('comment_task')
    AND EXISTS (
      SELECT 1 FROM tasks t WHERE t.id = task_comments.task_id AND can_access_site(t.site_id)
    )
  );

-- ============================================================
-- 5. M4 debt — chart_history_select / chart_comments_select site isolation
-- ============================================================

DROP POLICY IF EXISTS "chart_history_select" ON chart_history;

CREATE POLICY "chart_history_select" ON chart_history
  FOR SELECT USING (
    company_id = current_company_id()
    AND has_permission('view_charts')
    AND EXISTS (
      SELECT 1 FROM charts c WHERE c.id = chart_history.chart_id AND can_access_site(c.site_id)
    )
  );

DROP POLICY IF EXISTS "chart_comments_select" ON chart_comments;

CREATE POLICY "chart_comments_select" ON chart_comments
  FOR SELECT USING (
    company_id = current_company_id()
    AND has_permission('view_charts')
    AND EXISTS (
      SELECT 1 FROM charts c WHERE c.id = chart_comments.chart_id AND can_access_site(c.site_id)
    )
  );

-- ============================================================
-- EXECUTE GRANT HARDENING — the two new STABLE functions, same posture as
-- migration 030/031's handling of that migration's new functions.
-- ============================================================

REVOKE ALL ON FUNCTION enforce_task_update_invariants() FROM PUBLIC;
REVOKE ALL ON FUNCTION is_valid_task_transition(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_valid_task_transition(text, text) TO authenticated, service_role;
-- enforce_task_update_invariants is a trigger function — Postgres invokes
-- it internally on UPDATE, never via direct EXECUTE, so no role needs (or
-- gets) EXECUTE on it; the two REVOKEs above are enough.

-- ============================================================
-- ROLLBACK (manual, if ever needed — uncomment and run individually)
-- ============================================================
-- DROP POLICY IF EXISTS "chart_comments_select" ON chart_comments;
-- CREATE POLICY "chart_comments_select" ON chart_comments
--   FOR SELECT USING (company_id = current_company_id() AND has_permission('view_charts'));
-- DROP POLICY IF EXISTS "chart_history_select" ON chart_history;
-- CREATE POLICY "chart_history_select" ON chart_history
--   FOR SELECT USING (company_id = current_company_id() AND has_permission('view_charts'));
-- DROP POLICY IF EXISTS "task_comments_insert" ON task_comments;
-- CREATE POLICY "task_comments_insert" ON task_comments
--   FOR INSERT WITH CHECK (
--     company_id = current_company_id() AND has_permission('comment_task')
--     AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_comments.task_id AND can_access_site(t.site_id))
--   );
-- DROP POLICY IF EXISTS "task_history_insert" ON task_history;
-- CREATE POLICY "task_history_insert" ON task_history
--   FOR INSERT WITH CHECK (
--     company_id = current_company_id()
--     AND EXISTS (
--       SELECT 1 FROM tasks t WHERE t.id = task_history.task_id AND can_access_site(t.site_id)
--         AND (has_permission('complete_task') OR has_permission('assign_task')
--              OR has_permission('cancel_task') OR has_permission('create_task')
--              OR t.assigned_to = auth.uid())
--     )
--   );
-- DROP FUNCTION IF EXISTS is_valid_task_transition(text, text);
-- DROP POLICY IF EXISTS "tasks_insert" ON tasks;
-- CREATE POLICY "tasks_insert" ON tasks
--   FOR INSERT WITH CHECK (
--     company_id = current_company_id() AND can_access_site(site_id) AND has_permission('create_task')
--   );
-- DROP TRIGGER IF EXISTS trg_tasks_enforce_update_invariants ON tasks;
-- DROP FUNCTION IF EXISTS enforce_task_update_invariants();
-- ============================================================
