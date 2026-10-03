-- Migration: 031_task_engine_function_execute_hardening.sql
-- Description: Security hardening follow-up to migration 030 (Milestone
--   5.0 Task Engine). Post-apply verification of migration 030 found that
--   `anon` unexpectedly has EXECUTE on the three new SECURITY DEFINER
--   functions, despite migration 030's `REVOKE ALL ... FROM PUBLIC` and its
--   documented intent to exclude `anon`. Root cause: this project has
--   pre-existing schema-level default privileges (`ALTER DEFAULT
--   PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO anon, authenticated,
--   service_role`) that auto-grant EXECUTE to `anon` on every NEW function
--   created in the public schema, regardless of a subsequent `REVOKE ...
--   FROM PUBLIC` (PUBLIC and the named `anon` role are separate ACL
--   entries; revoking one does not revoke the other).
--
-- ============================================================
-- SCOPE — intentionally minimal
-- ============================================================
-- This migration does exactly one thing: explicitly revoke EXECUTE on
-- `anon` for the three Milestone 5 functions below. Nothing else.
--
-- Does NOT touch:
--   - migrations 001-030 (all already applied; not modified)
--   - any table, column, index, or RLS policy
--   - the `permissions`/`role_permissions` tables or any business data
--   - any other function (pre-existing or otherwise)
--   - the project's schema-level pg_default_acl configuration — that
--     default-privilege behavior is separate, pre-existing infrastructure
--     technical debt and is explicitly NOT altered here. Its practical
--     effect is scoped to future CREATE FUNCTION statements in the public
--     schema, which is out of scope for this narrowly-targeted fix.
--
-- Final intended privilege state for all three functions:
--   PUBLIC          -> NO EXECUTE  (already true after migration 030)
--   anon            -> NO EXECUTE  (this migration's only effect)
--   authenticated   -> EXECUTE     (unchanged — required for RLS policy
--                                    evaluation and ordinary app queries)
--   service_role    -> EXECUTE     (unchanged — required for TaskService's
--                                    server-side stale-assignment check,
--                                    Security Addendum §B/D)
-- ============================================================

REVOKE EXECUTE ON FUNCTION user_has_site_access(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION chart_accessible_for_assignment(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION chart_assignment_target_valid(uuid, uuid) FROM anon;

-- ============================================================
-- ROLLBACK
-- GRANT EXECUTE ON FUNCTION chart_assignment_target_valid(uuid, uuid) TO anon;
-- GRANT EXECUTE ON FUNCTION chart_accessible_for_assignment(uuid) TO anon;
-- GRANT EXECUTE ON FUNCTION user_has_site_access(uuid, uuid) TO anon;
-- ============================================================
