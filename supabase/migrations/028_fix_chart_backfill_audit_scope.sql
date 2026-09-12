-- Migration: 028_fix_chart_backfill_audit_scope.sql
-- Description: Sub-Milestone 4.2 remediation — deletes 6 erroneous
--   'chart.backfilled' audit_logs rows that migration 027 incorrectly wrote
--   against the Zentariq E2E Tests company. DML only — no schema change, no
--   modification to migrations 026 or 027.
--
-- ============================================================
-- ROOT CAUSE (migration 027, already applied — NOT edited here)
-- ============================================================
-- Migration 027 ran three INSERTs. The first two were correctly scoped:
--
--   1. charts        — INSERT ... FROM visits v WHERE v.status IN (...)
--                       AND v.company_id = '<production>' AND NOT EXISTS
--                       (chart for that visit_id). Explicit company_id
--                       predicate: correctly production-only.
--
--   2. chart_history  — INSERT ... FROM charts ch WHERE NOT EXISTS
--                       (any chart_history row for that chart_id). No
--                       explicit company_id predicate, but harmless: every
--                       chart ever created by the live workflow already
--                       receives its first chart_history row at creation
--                       time, so "zero chart_history rows" can only ever be
--                       true for a chart this same migration run just
--                       inserted (step 1) — self-scoping in practice for
--                       any company.
--
--   3. audit_logs     — INSERT ... FROM charts ch WHERE NOT EXISTS (an
--                       audit_logs row with action = 'chart.backfilled' for
--                       that chart's id). THE DEFECT: unlike chart_history,
--                       'chart.backfilled' is not written on every chart
--                       state transition — it is only ever written by this
--                       migration itself. On migration 027's first (and
--                       only) run, that condition was vacuously true for
--                       EVERY pre-existing chart in EVERY company, not just
--                       the 8 newly-inserted production ones, because no
--                       chart anywhere had a 'chart.backfilled' audit row
--                       yet. The missing predicate was an explicit
--                       `AND ch.company_id = '<production>'` (or equivalently
--                       restricting to only the charts step 1 just inserted).
--                       Its absence let step 3 also match the 6 pre-existing,
--                       live-created charts already sitting in the
--                       "Zentariq E2E Tests" company (c1be2318-7ec1-491b-b0df-
--                       3cd0b9d70af7), writing them a false
--                       'chart.backfilled' audit entry claiming they were
--                       part of the Sub-Milestone 4.2 historical backfill,
--                       which they were not — those 6 charts were created
--                       and progressed through the live chart workflow on
--                       2026-09-05, two days before migration 027 executed
--                       on 2026-09-07 00:42:01.366583 UTC.
--
-- ============================================================
-- WHY MIGRATION 027 IS NOT EDITED
-- ============================================================
-- 027 is an already-applied, already-recorded historical migration
-- (supabase_migrations.schema_migrations has version '027'; its own
-- production-facing effects — 8 charts, 8 chart_history rows, 8 correct
-- audit_logs rows for company_id 'a181874c-9f28-4822-97ae-8a5da769e91a' —
-- are correct and must remain exactly as they are). Rewriting an applied
-- migration would not undo what already ran and would corrupt the
-- migration history's own record of what actually executed. The correct
-- remediation for an applied migration's side effect is a new, narrowly
-- scoped forward migration — this file — not an edit to 027.
--
-- ============================================================
-- VERIFIED SCOPE OF THIS REMEDIATION
-- ============================================================
-- Independently re-verified (read-only SELECT, Sub-Milestone 4.2
-- remediation audit) immediately before this file was written: exactly 6
-- audit_logs rows match ALL of the following simultaneously —
--   action        = 'chart.backfilled'
--   company_id    = 'c1be2318-7ec1-491b-b0df-3cd0b9d70af7' ("Zentariq E2E Tests")
--   module        = 'charts'
--   record_type   = 'chart'
--   created_at    = '2026-09-07 00:42:01.366583+00'  (migration 027's exact
--                    execution instant, identical to the microsecond across
--                    all 14 rows — 8 correct + 6 erroneous — it wrote)
-- Their exact ids:
--   3d9475e4-36c5-4023-9cde-0775f1cc5b5c
--   695b89bb-3f2a-4498-b94d-ceacf867bff8
--   6b85184d-3781-471b-b13c-833e559a4ecc
--   d1bd6d41-028d-44bb-ba31-7addd7e0f76b
--   d86d0d85-f80b-4fd5-b027-a5f50b5dc028
--   eeb7ce98-6a95-4398-ba3c-152cc67489f1
-- Each references (via record_id) one of the 6 pre-existing E2E charts
-- (3a68651d, 5d81c9e7, 7b240983, 89d5d8c6, 88ffab15, 94152a37 respectively),
-- none of which overlaps with the 8 legitimate production chart ids
-- migration 027 itself created. This migration targets ONLY those 6
-- audit_logs rows, by exact id plus every defensive predicate above.
--
-- ============================================================
-- REMEDIATION PERFORMED
-- ============================================================
-- DELETE exactly the 6 audit_logs rows above, guarded by:
--   (a) a precondition check that all 6 (and only those 6) still exist and
--       still match every defensive predicate, aborting via RAISE EXCEPTION
--       with zero changes if the count is not exactly 6;
--   (b) a post-DELETE row-count check (GET DIAGNOSTICS) that exactly 6 rows
--       were removed, aborting the whole transaction otherwise.
-- Nothing else is touched: no charts, chart_history, visits, subjects, or
-- any other audit_logs row (including the 8 legitimate production
-- 'chart.backfilled' rows) is read for writing or modified.
--
-- ============================================================
-- IDEMPOTENCY
-- Running this file a second time will find 0 rows matching the precondition
-- (since the 6 targeted rows will already be gone) and will RAISE EXCEPTION,
-- making zero changes — intentionally strict, matching migration 027's own
-- precondition philosophy: this is a one-time, human-verified remediation
-- for a specific, already-diagnosed incident, not a generalized cleanup
-- rule to silently re-run.
-- ============================================================
--
-- Rollback / recovery: see ROLLBACK section at the bottom. Since this
-- migration only deletes rows that should never have existed, "rollback"
-- means restoring the exact same 6 rows if this remediation is ever judged
-- to have been a mistake — their full original field values are recorded
-- there for that purpose.
-- ============================================================

BEGIN;

DO $$
DECLARE
  target_ids uuid[] := ARRAY[
    '3d9475e4-36c5-4023-9cde-0775f1cc5b5c',
    '695b89bb-3f2a-4498-b94d-ceacf867bff8',
    '6b85184d-3781-471b-b13c-833e559a4ecc',
    'd1bd6d41-028d-44bb-ba31-7addd7e0f76b',
    'd86d0d85-f80b-4fd5-b027-a5f50b5dc028',
    'eeb7ce98-6a95-4398-ba3c-152cc67489f1'
  ]::uuid[];
  e2e_company_id uuid := 'c1be2318-7ec1-491b-b0df-3cd0b9d70af7'::uuid;
  migration_027_instant timestamptz := '2026-09-07 00:42:01.366583+00'::timestamptz;
  precondition_count integer;
  deleted_count integer;
BEGIN
  SELECT count(*) INTO precondition_count
  FROM audit_logs a
  WHERE a.id = ANY(target_ids)
    AND a.action = 'chart.backfilled'
    AND a.company_id = e2e_company_id
    AND a.module = 'charts'
    AND a.record_type = 'chart'
    AND a.created_at = migration_027_instant;

  IF precondition_count != 6 THEN
    RAISE EXCEPTION
      'Sub-Milestone 4.2 audit remediation precondition failed: expected exactly 6 erroneous chart.backfilled audit_log rows for Zentariq E2E Tests (company_id %) matching all verified attributes, found %. Live data has changed since this migration was authored/verified — re-audit before proceeding. Aborting without making any change.',
      e2e_company_id, precondition_count;
  END IF;

  DELETE FROM audit_logs
  WHERE id = ANY(target_ids)
    AND action = 'chart.backfilled'
    AND company_id = e2e_company_id
    AND module = 'charts'
    AND record_type = 'chart'
    AND created_at = migration_027_instant;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  IF deleted_count != 6 THEN
    RAISE EXCEPTION
      'Sub-Milestone 4.2 audit remediation failed: expected to delete exactly 6 rows, deleted %. Aborting transaction — no partial deletion is committed.',
      deleted_count;
  END IF;
END $$;

COMMIT;

-- ============================================================
-- VALIDATION (for manual use after applying — not executed by this file)
--
--   -- Erroneous E2E rows gone (expect 0):
--   SELECT count(*) FROM audit_logs
--   WHERE action = 'chart.backfilled'
--     AND company_id = 'c1be2318-7ec1-491b-b0df-3cd0b9d70af7';
--
--   -- Legitimate production rows untouched (expect 8):
--   SELECT count(*) FROM audit_logs
--   WHERE action = 'chart.backfilled'
--     AND company_id = 'a181874c-9f28-4822-97ae-8a5da769e91a';
--
--   -- charts / chart_history / visits row counts for both companies
--   -- unchanged from pre-remediation values (compare against the
--   -- Sub-Milestone 4.2 remediation audit report).
-- ============================================================

-- ============================================================
-- ROLLBACK / RECOVERY
-- Restores exactly the 6 rows this migration deletes, with their original
-- field values, in case this remediation is ever judged to have been
-- incorrect. Uses explicit ids so no other row can ever be affected.
--
-- INSERT INTO audit_logs (id, company_id, site_id, user_id, action, module, record_type, record_id, new_value, created_at)
-- VALUES
--   ('3d9475e4-36c5-4023-9cde-0775f1cc5b5c', 'c1be2318-7ec1-491b-b0df-3cd0b9d70af7', '9625b929-2de3-4a5c-a819-057fa6bbcf71', NULL, 'chart.backfilled', 'charts', 'chart', '3a68651d-ca9c-4184-b8dd-6d9b9c6c1017', '{"status":"chart_ready","visit_id":"ada06b53-8fd9-41f7-93f8-270bc00bdca8","note":"Historical Chart backfill — Sub-Milestone 4.2"}'::jsonb, '2026-09-07 00:42:01.366583+00'),
--   ('695b89bb-3f2a-4498-b94d-ceacf867bff8', 'c1be2318-7ec1-491b-b0df-3cd0b9d70af7', '9625b929-2de3-4a5c-a819-057fa6bbcf71', NULL, 'chart.backfilled', 'charts', 'chart', '5d81c9e7-6c89-4100-b87a-824ba9637033', '{"status":"chart_ready","visit_id":"f1c759ca-6fab-404a-b527-d1244af4acdd","note":"Historical Chart backfill — Sub-Milestone 4.2"}'::jsonb, '2026-09-07 00:42:01.366583+00'),
--   ('6b85184d-3781-471b-b13c-833e559a4ecc', 'c1be2318-7ec1-491b-b0df-3cd0b9d70af7', '9625b929-2de3-4a5c-a819-057fa6bbcf71', NULL, 'chart.backfilled', 'charts', 'chart', '7b240983-51e4-46be-95b1-c5ac8fe221cd', '{"status":"chart_ready","visit_id":"047d6368-d0d3-435b-a59f-a31521a88821","note":"Historical Chart backfill — Sub-Milestone 4.2"}'::jsonb, '2026-09-07 00:42:01.366583+00'),
--   ('d1bd6d41-028d-44bb-ba31-7addd7e0f76b', 'c1be2318-7ec1-491b-b0df-3cd0b9d70af7', '9625b929-2de3-4a5c-a819-057fa6bbcf71', NULL, 'chart.backfilled', 'charts', 'chart', '89d5d8c6-0a86-413c-9194-ceac5c5a243f', '{"status":"chart_ready","visit_id":"dca40ade-0212-4171-8e4b-ecadf2f7621e","note":"Historical Chart backfill — Sub-Milestone 4.2"}'::jsonb, '2026-09-07 00:42:01.366583+00'),
--   ('d86d0d85-f80b-4fd5-b027-a5f50b5dc028', 'c1be2318-7ec1-491b-b0df-3cd0b9d70af7', '9625b929-2de3-4a5c-a819-057fa6bbcf71', NULL, 'chart.backfilled', 'charts', 'chart', '88ffab15-0bba-4712-aea6-6e13e1383330', '{"status":"chart_ready","visit_id":"8c0391d2-7bcb-47c8-aaaf-847f1971c748","note":"Historical Chart backfill — Sub-Milestone 4.2"}'::jsonb, '2026-09-07 00:42:01.366583+00'),
--   ('eeb7ce98-6a95-4398-ba3c-152cc67489f1', 'c1be2318-7ec1-491b-b0df-3cd0b9d70af7', '9625b929-2de3-4a5c-a819-057fa6bbcf71', NULL, 'chart.backfilled', 'charts', 'chart', '94152a37-2cbd-4b27-879b-df5b60e0664a', '{"status":"chart_ready","visit_id":"c9b83f17-fe92-4015-9728-8e3b300c8cfd","note":"Historical Chart backfill — Sub-Milestone 4.2"}'::jsonb, '2026-09-07 00:42:01.366583+00');
-- ============================================================
