-- Migration: 032_task_history_authorization_alignment.sql
-- Description: Milestone 5.0 — Task Engine cleanup. Realigns
--   task_history_insert's authorization surface with the task-mutation
--   authorization model migrations 030/031 already deployed. Discovered
--   during TaskService implementation (docs review:
--   Zentariq_Milestone_5_TaskService_Review.md): the shipped
--   task_history_insert policy's permission OR-list
--   (complete_task OR assign_task OR cancel_task) omitted two legitimate
--   write paths that tasks_insert/tasks_update's own RLS already allows —
--   create_task (manual task creation's initial history row) and the
--   assigned_to = auth.uid() self-completion path tasks_update explicitly
--   grants. TaskService worked around both via a narrowly-scoped admin-
--   client path pending this correction; that workaround is removed in the
--   same change that applies this migration (see the TaskService cleanup
--   report for the code-side half of this gate).
--
-- ============================================================
-- SCOPE — intentionally minimal
-- ============================================================
-- This migration touches exactly one object: the task_history_insert RLS
-- policy on the existing task_history table. Nothing else.
--
-- Does NOT touch:
--   - migrations 001-031 (all already applied; not modified)
--   - any other RLS policy (task_history_select, task_comments_*,
--     tasks_*, chart_assignments_* all unchanged)
--   - any table, column, index, or constraint
--   - permissions / role_permissions / any business data
--   - any SECURITY DEFINER function
--   - pg_default_acl
--
-- Preserved, unchanged from the shipped policy:
--   - company_id = current_company_id() (mandatory, outer AND)
--   - the EXISTS join to the parent tasks row via
--     t.id = task_history.task_id — every authorization check below,
--     including the new self-assignee clause, is evaluated against THAT
--     SAME joined parent row, never a bare/disconnected auth.uid() check
--   - can_access_site(t.site_id) — site authorization is still derived
--     exclusively from the parent task, unchanged
--   - complete_task / assign_task / cancel_task — all three existing
--     permission paths preserved verbatim
--
-- Added:
--   - has_permission('create_task') — covers the initial history row for
--     manual task creation
--   - t.assigned_to = auth.uid() — covers the already-approved
--     self-completion path (tasks_update's RLS already allows this same
--     caller to update the tasks row itself; this migration only extends
--     the SAME authorization to its corresponding history row, tied to the
--     identical parent task, never a generic standalone check)
-- ============================================================

DROP POLICY IF EXISTS "task_history_insert" ON task_history;

CREATE POLICY "task_history_insert" ON task_history
  FOR INSERT WITH CHECK (
    company_id = current_company_id()
    AND EXISTS (
      SELECT 1 FROM tasks t
      WHERE t.id = task_history.task_id
        AND can_access_site(t.site_id)
        AND (
          has_permission('complete_task')
          OR has_permission('assign_task')
          OR has_permission('cancel_task')
          OR has_permission('create_task')
          OR t.assigned_to = auth.uid()
        )
    )
  );

-- task_history_select is unchanged. Still no UPDATE or DELETE policy on
-- task_history — history rows remain permanent, exactly as before.

-- ============================================================
-- ROLLBACK
-- DROP POLICY IF EXISTS "task_history_insert" ON task_history;
-- CREATE POLICY "task_history_insert" ON task_history
--   FOR INSERT WITH CHECK (
--     company_id = current_company_id()
--     AND EXISTS (
--       SELECT 1 FROM tasks t
--       WHERE t.id = task_history.task_id AND can_access_site(t.site_id)
--     )
--     AND (
--       has_permission('complete_task')
--       OR has_permission('assign_task')
--       OR has_permission('cancel_task')
--     )
--   );
-- ============================================================
