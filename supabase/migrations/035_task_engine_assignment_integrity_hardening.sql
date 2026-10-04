-- ============================================================
-- Migration 035 — Task Engine assignment-integrity hardening
-- ============================================================
--
-- CONTEXT (Milestone 5.0 Live Grant-Matrix + Security Regression Gate,
-- 2026-09-26): live adversarial testing against a real database (never
-- migration-SQL inference alone) surfaced two real gaps in migration 033's
-- mutation-surface hardening, plus one low-severity grant-hygiene item:
--
--   1. CROSS-COMPANY ASSIGNEE. `tasks_insert`'s WITH CHECK validates
--      `user_has_site_access(assigned_to, site_id)` but never checks that
--      the assignee actually belongs to the task's company.
--      `user_has_site_access` (migration 030) itself has no company
--      scoping — a `view_all_sites` holder in ANY company satisfies it for
--      ANY site in ANY company. `chart_assignment_target_valid` (also
--      migration 030) already guards against exactly this by explicitly
--      joining `profiles.company_id = charts.company_id` before calling
--      `user_has_site_access` — confirmed live: the identical cross-company
--      attempt against `chart_assignments` was correctly rejected, while
--      the same attempt against `tasks` succeeded. TaskService itself
--      (`createTask`, `reassignTask`) was ALREADY safe — both call
--      `PermissionService.validateUserExists(assigned_to, ctx.company.id)`,
--      which filters `profiles` by `company_id` — so this was purely a
--      missing database-layer check, never an application-layer one.
--
--   2. DIRECT REASSIGNMENT AUDIT BYPASS. Migration 033's trigger correctly
--      authorizes an `assign_task` holder's direct `assigned_to` change
--      (permission + target site access both genuinely required), but
--      nothing forces that write through `TaskService.reassignTask`'s own
--      `task_history` INSERT — confirmed live: a direct REST reassignment
--      succeeded and left zero history rows. This migration makes the
--      database itself the single source of truth for that ledger entry
--      (Option A from the design audit — a DB trigger writes the canonical
--      reassignment history row, and `TaskService.reassignTask` stops
--      writing its own, so the two paths can never both fire and duplicate
--      it): the reason string is fully derivable from OLD/NEW with no
--      app-supplied context (`'Reassigned from <old> to <new>'`), and the
--      trigger's own INSERT still goes through the ordinary
--      `task_history_insert` RLS policy (SECURITY INVOKER, not DEFINER) —
--      it gets no special privilege, it only guarantees the write always
--      happens when the column change itself was already authorized.
--      Rejected: prohibiting direct `assigned_to` mutation outright (Option
--      B) — migration 033's own trigger design deliberately keeps the
--      authorization surface at the row/column level rather than forcing
--      every legitimate actor through an RPC, and TaskService's own
--      `reassignTask` already performs additional business validation
--      (company/site of the target, terminal-status guard) before ever
--      reaching this UPDATE — Option B would have meant either re-deriving
--      all of that in SQL (rejected in the original 033 design for the
--      same reason: "prefer server-controlled mutations... rather than
--      reproduce the complete state machine only with permissive RLS" cuts
--      both ways — it also means not over-building the DB layer into a
--      second state machine) or blocking TaskService's own legitimate path
--      too. Option A closes the actual gap (silent audit loss) with the
--      smallest change and no behavior change for any already-authorized
--      actor.
--
--      Corollary defect found while implementing the above: migration
--      033's status-transition table never included `waiting -> assigned`,
--      but `TaskService.reassignTask` legitimately produces exactly that
--      transition (`new/waiting -> assigned` on reassignment) — meaning the
--      real TaskService reassignment path for a `waiting` task would have
--      started failing against a live trigger the moment it was exercised.
--      Not previously caught (no live test had reassigned a `waiting`
--      task). Fixed here as the narrowest possible addition: allowed ONLY
--      when accompanied by an actual `assigned_to`/`assigned_role` change,
--      not as a general status jump — `is_valid_task_transition` (the
--      general-purpose, `TaskService.isValidTaskTransition`-mirroring
--      helper used by `task_history_insert`) is deliberately left
--      untouched; the `task_history_insert` policy instead gets the same
--      narrow reassignment-shaped OR-exception it already has for the
--      same-status case (migration 033), keeping `is_valid_task_transition`
--      an exact mirror of the general state machine.
--
--   3. ANON EXECUTE HYGIENE. Migration 033 revoked `PUBLIC` EXECUTE on its
--      two new functions but never added the matching explicit
--      `REVOKE ... FROM anon` migration 031 established as the actual
--      working pattern (`PUBLIC` revocation alone does not revoke the
--      separate per-role auto-grant Postgres's default privileges create).
--      Confirmed live to be non-exploitable either way (one is a pure,
--      stateless, side-effect-free helper; the other is a trigger function
--      PostgREST cannot even expose as an RPC) — closed anyway, for
--      consistency and defense-in-depth, per instruction.
--
-- PRE-APPLY INVALID-DATA CHECK (run before this migration on any
-- environment, read-only, never modifies anything):
--
--   SELECT t.id, t.company_id AS task_company, p.company_id AS assignee_company
--   FROM tasks t
--   JOIN profiles p ON p.id = t.assigned_to
--   WHERE t.assigned_to IS NOT NULL
--     AND p.company_id IS DISTINCT FROM t.company_id;
--
-- Run against Dev/E2E (tihpjvhufczssjoryidb) immediately before authoring
-- this file: zero rows (the table was empty — all prior test fixtures had
-- already been cleaned up). Not run against, and no data inspected on, the
-- original project.
--
-- SCOPE DISCIPLINE: migrations 001-034 untouched. No schema/RLS/grant
-- change beyond what the three items above require. No historical-data
-- rewrite. No production-specific ids.
--
-- Rollback: see ROLLBACK section at the bottom.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. tasks_insert — require the assignee to belong to the task's company,
--    in addition to (not instead of) the existing site-access check.
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
    AND (
      assigned_to IS NULL
      OR (
        user_has_site_access(assigned_to, site_id)
        AND EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = assigned_to AND pr.company_id = company_id)
      )
    )
  );

-- ============================================================
-- 2. enforce_task_update_invariants — add the same company check to the
--    assigned_to/assigned_role branch, and the narrow reassignment-only
--    waiting -> assigned exception.
-- ============================================================

CREATE OR REPLACE FUNCTION enforce_task_update_invariants()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
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

  IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to
     OR NEW.assigned_role IS DISTINCT FROM OLD.assigned_role
  THEN
    IF NOT has_permission('assign_task') THEN
      RAISE EXCEPTION 'tasks: reassignment requires assign_task' USING ERRCODE = '42501';
    END IF;
    IF NEW.assigned_to IS NOT NULL THEN
      IF NOT user_has_site_access(NEW.assigned_to, NEW.site_id) THEN
        RAISE EXCEPTION 'tasks: assignee does not have access to this site' USING ERRCODE = '42501';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM profiles pr WHERE pr.id = NEW.assigned_to AND pr.company_id = NEW.company_id
      ) THEN
        RAISE EXCEPTION 'tasks: assignee does not belong to this task''s company' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'new'         AND NEW.status IN ('assigned', 'in_progress', 'completed', 'cancelled'))
      OR (OLD.status = 'assigned'    AND NEW.status IN ('in_progress', 'waiting', 'completed', 'cancelled'))
      OR (OLD.status = 'in_progress' AND NEW.status IN ('waiting', 'completed', 'cancelled'))
      OR (OLD.status = 'waiting'     AND NEW.status IN ('in_progress', 'completed', 'cancelled'))
      -- Reassignment-only exception (TaskService.reassignTask): a waiting
      -- task reassigned to a new owner moves back to 'assigned'. Guarded by
      -- an actual assignee/role change so this is never a bare status jump.
      OR (
        OLD.status = 'waiting' AND NEW.status = 'assigned'
        AND (NEW.assigned_to IS DISTINCT FROM OLD.assigned_to OR NEW.assigned_role IS DISTINCT FROM OLD.assigned_role)
      )
    ) THEN
      RAISE EXCEPTION 'tasks: invalid status transition from % to %', OLD.status, NEW.status
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ============================================================
-- 3. record_task_reassignment_history — canonical, DB-owned ledger entry
--    for every assigned_to/assigned_role change, regardless of caller
--    (direct REST or TaskService). Runs AFTER the row is confirmed valid
--    by enforce_task_update_invariants (a BEFORE trigger), as an ordinary
--    SECURITY INVOKER function — its own INSERT is subject to the exact
--    same task_history_insert RLS policy as any other caller, so it
--    carries no elevated privilege: it only guarantees the write happens
--    whenever the column change itself was already authorized.
-- ============================================================

CREATE OR REPLACE FUNCTION record_task_reassignment_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to
     OR NEW.assigned_role IS DISTINCT FROM OLD.assigned_role
  THEN
    INSERT INTO task_history (company_id, task_id, old_status, new_status, changed_by, reason)
    VALUES (
      NEW.company_id,
      NEW.id,
      OLD.status,
      NEW.status,
      auth.uid(),
      'Reassigned from ' || COALESCE(OLD.assigned_to::text, 'unassigned')
        || ' to ' || COALESCE(NEW.assigned_to::text, 'unassigned')
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tasks_record_reassignment_history ON tasks;
CREATE TRIGGER trg_tasks_record_reassignment_history
  AFTER UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION record_task_reassignment_history();

-- ============================================================
-- 4. task_history_insert — accept the same reassignment-only
--    waiting -> assigned exception the trigger above now allows, so the
--    auto-written history row (and any equivalent legitimate direct
--    write) passes this policy. is_valid_task_transition itself is left
--    untouched, deliberately kept as an exact mirror of
--    TaskService.isValidTaskTransition.
-- ============================================================

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
          OR (task_history.old_status = 'waiting' AND task_history.new_status = 'assigned')
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
-- 5. anon EXECUTE hygiene — migration 031's established pattern, applied
--    to migration 033's two functions plus this migration's new one.
-- ============================================================

REVOKE EXECUTE ON FUNCTION is_valid_task_transition(text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION enforce_task_update_invariants() FROM anon;
REVOKE EXECUTE ON FUNCTION record_task_reassignment_history() FROM anon;

COMMIT;

-- ============================================================
-- ROLLBACK (manual, if ever needed — uncomment and run individually)
-- ============================================================
-- GRANT EXECUTE ON FUNCTION record_task_reassignment_history() TO anon;
-- GRANT EXECUTE ON FUNCTION enforce_task_update_invariants() TO anon;
-- GRANT EXECUTE ON FUNCTION is_valid_task_transition(text, text) TO anon;
-- DROP POLICY IF EXISTS "task_history_insert" ON task_history;
-- -- (recreate the migration 033 version — see that file's own rollback)
-- DROP TRIGGER IF EXISTS trg_tasks_record_reassignment_history ON tasks;
-- DROP FUNCTION IF EXISTS record_task_reassignment_history();
-- -- (recreate enforce_task_update_invariants and tasks_insert from
-- -- migration 033's own text to revert to the pre-035 behavior)
-- ============================================================
