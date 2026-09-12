-- Migration: 027_charts_historical_backfill.sql
-- Description: Sub-Milestone 4.2 — one-time, idempotent historical Chart
--   backfill for completed/out_of_window Visits that predate Milestone 4.0's
--   automatic Chart-creation workflow (migration 026,
--   complete_visit_with_chart / ChartService.ensureChartForCompletedVisit).
--   DML only — no schema change, no modification to migration 026.
--
-- ============================================================
-- SCOPE — EXPLICIT, HUMAN-REVIEWED, ONE-TIME COMPANY DECISION
-- ============================================================
-- The Milestone 4.2 Phase A/B audit found NO authoritative, schema-level, or
-- documented way to distinguish a production company from a test/E2E company
-- (see the Phase A/B design reports — companies has no is_test/environment/
-- account_type column, and every company in the live dataset shares identical
-- status='active'/subscription_plan='standard'). tests/e2e/helpers/seed.ts's
-- own comment states the *intended* architecture is a fully separate,
-- dedicated e2e Supabase project ("never a shared/prod one") — the current
-- co-mingling of test and production data in one project is a deviation from
-- that design, not an in-database distinction to key off of.
--
-- Given that, the company_id below is NOT a generalized production/test
-- discriminator rule and must never be treated as one by any future
-- migration or code path. It is a single, explicit, human-confirmed scope
-- decision for THIS migration only, reviewed and approved for Sub-Milestone
-- 4.2 specifically:
--
--   company_id = 'a181874c-9f28-4822-97ae-8a5da769e91a'  ("Zentariq Systems")
--
-- Independently re-verified immediately before this file was written
-- (read-only SELECT, Sub-Milestone 4.2 Phase A/B audit): exactly 8 eligible
-- candidate visits for this company_id, zero anomalies (no null required
-- relationship fields, no subject/visit or study/visit company/site/study
-- mismatches). The 27 remaining eligible visits belong to the two E2E/test
-- companies ("Zentariq E2E Tests", "Zentariq E2E Tests (legacy)") and are
-- deliberately NOT touched by this migration.
--
-- ============================================================
-- CHART-ELIGIBILITY RULE (reconstructed from existing code, not invented —
-- see migration 026's complete_visit_with_chart and
-- ChartService.ensureChartForCompletedVisit): a Visit is Chart-eligible iff
-- its status is 'completed' OR 'out_of_window' (both are chart-eligible per
-- BUSINESS_RULES_05 — 'out_of_window' is a real completion recorded outside
-- the visit's window, not an abandoned/missed state) AND it does not already
-- have a Chart row. No other Visit status is eligible.
-- ============================================================
--
-- ============================================================
-- FIELD MAPPING
--   company_id, site_id, study_id, subject_id, visit_id -> copied directly
--     from the owning visits row (the same authoritative relationships RLS
--     and every other Chart-creation path already trusts).
--   status -> literal 'chart_ready'. Per explicit instruction: a historically
--     completed Visit is NOT evidence that its data was historically entered
--     into the EDC — no authoritative record of that exists anywhere in the
--     schema, so every backfilled Chart starts at the same first step a live
--     Chart does, regardless of how old the underlying Visit is.
--   priority -> literal 'low', identical to the live RPC's own creation-time
--     value. Never authoritative — ChartService.computeChartAging recomputes
--     the effective priority on every read (Milestone 4.0 Decision 3).
--   chart_ready_date -> visits.scheduled_date, timezone-safe converted (see
--     below). This is the operational AGING REFERENCE for the historical
--     Chart (when the underlying visit's data became ready), never a claim
--     about when a user historically created or entered the Chart itself —
--     that action never happened historically, which is exactly why status
--     starts at chart_ready and entered_in_edc_date/entered_by/
--     entered_by_role are left NULL below.
--   entered_in_edc_date, entered_by, entered_by_role, days_until_entry ->
--     left unset (column defaults, i.e. NULL) — matches the live path's own
--     behavior exactly (days_until_entry is never populated by any existing
--     code path either).
--
--   visits.scheduled_date is `date` (no time component); a bare
--   `::timestamptz` cast is session-timezone-dependent, not deterministic.
--   The conversion used below — `(scheduled_date::timestamp AT TIME ZONE
--   'UTC')` — forms midnight on that calendar date and explicitly labels it
--   UTC, producing an identical timestamptz value regardless of the
--   executing session's TimeZone setting.
-- ============================================================
--
-- ============================================================
-- AUDIT / CHART_HISTORY — SYSTEM-INITIATED, NO FABRICATED ACTOR
-- chart_history.changed_by and audit_logs.user_id are both already nullable
-- (ON DELETE SET NULL / plain nullable FK respectively). No "system actor"
-- placeholder convention exists anywhere in this codebase (verified by
-- search) — the only precedent, migration 025's Document Center backfill,
-- uses NULL for its own backfill-authored rows. This migration does the
-- same: NULL, not a fabricated historical user, and every timestamp below
-- (chart_history.changed_at, audit_logs.created_at) uses each table's own
-- DEFAULT now() — the real, honest moment this migration executes, never a
-- historical date.
-- ============================================================
--
-- ============================================================
-- IDEMPOTENCY
--   charts:        NOT EXISTS (chart for that visit_id) AND
--                  ON CONFLICT (visit_id) DO NOTHING (uq_charts_visit,
--                  migration 026) — belt and suspenders, identical
--                  philosophy to the live RPC.
--   chart_history: NOT EXISTS (a chart_history row for that chart_id).
--                  Provably self-scoping without re-filtering by company: a
--                  Chart can only ever reach this database via (a) the live
--                  ensureChartForCompletedVisit path, which always writes its
--                  chart_history row in the same call, or (b) this
--                  migration's own INSERT above. So "a chart with zero
--                  chart_history rows" can only ever mean "a chart this
--                  migration just inserted, before this statement ran" — on
--                  every later run that set is empty, and it can never
--                  include any of the 6 pre-existing live-created charts.
--   audit_logs:    NOT EXISTS (an audit_logs row with action='chart.backfilled'
--                  for that record_id) — same self-scoping reasoning.
--   Net effect: running this entire file a second time affects exactly 0
--   rows in all three tables, and cannot affect any Chart created by the
--   live workflow, before or after this migration runs.
-- ============================================================
--
-- ============================================================
-- SAFETY PRECONDITION
-- Aborts the whole transaction (raising, so nothing below it commits) unless
-- the live eligible-candidate count for the confirmed company_id is EXACTLY
-- 8 — the independently verified expected count for this migration's one
-- controlled first execution. This is intentionally strict, not "8 or 0":
-- Supabase's own migration bookkeeping (supabase_migrations.schema_migrations)
-- already prevents this file from normally being applied a second time via
-- the standard `supabase db push` workflow, so there is no legitimate,
-- ordinary path by which this guard would ever observe 0 candidates before
-- a genuine first run. If it ever did, that would itself be an unexpected
-- database-state change (e.g. someone else already backfilled these rows
-- outside this migration) and must cause a hard stop, not a silent success.
-- The INSERT statements below keep their own independent, unconditional
-- NOT EXISTS / ON CONFLICT idempotency protections regardless of this
-- precondition (see IDEMPOTENCY above) — those remain the durable guarantee
-- against duplication if this file is ever re-run through any non-standard
-- path; this precondition's only job is to refuse to proceed against a
-- candidate set that does not match what was reviewed and approved.
-- ============================================================
--
-- Numbering: 023 remains permanently reserved/skipped (see migration 024's
--   own header) — not reused or renumbered here. 026 is untouched; this is a
--   pure DML addition on top of it.
--
-- Rollback: see ROLLBACK section at the bottom.
-- ============================================================

BEGIN;

DO $$
DECLARE
  candidate_count integer;
BEGIN
  SELECT count(*) INTO candidate_count
  FROM visits v
  WHERE v.status IN ('completed', 'out_of_window')
    AND v.company_id = 'a181874c-9f28-4822-97ae-8a5da769e91a'
    AND NOT EXISTS (SELECT 1 FROM charts c WHERE c.visit_id = v.id);

  IF candidate_count != 8 THEN
    RAISE EXCEPTION
      'Sub-Milestone 4.2 backfill precondition failed: expected exactly 8 eligible candidates for company_id a181874c-9f28-4822-97ae-8a5da769e91a, found %. Live data has changed since this migration was authored/verified — re-audit before proceeding. Aborting without making any change.',
      candidate_count;
  END IF;
END $$;

-- ============================================================
-- 1. CHARTS — create for eligible, currently chart-less completed/
--    out_of_window visits, confirmed production company only.
-- ============================================================
INSERT INTO charts (
  company_id, site_id, study_id, subject_id, visit_id,
  chart_ready_date, status, priority
)
SELECT
  v.company_id,
  v.site_id,
  v.study_id,
  v.subject_id,
  v.id,
  (v.scheduled_date::timestamp AT TIME ZONE 'UTC'),
  'chart_ready',
  'low'
FROM visits v
WHERE v.status IN ('completed', 'out_of_window')
  AND v.company_id = 'a181874c-9f28-4822-97ae-8a5da769e91a'
  AND NOT EXISTS (SELECT 1 FROM charts c WHERE c.visit_id = v.id)
ON CONFLICT (visit_id) DO NOTHING;

-- ============================================================
-- 2. CHART_HISTORY — exactly one initial "created -> chart_ready" row for
--    every Chart still missing one (see IDEMPOTENCY above for why this
--    predicate can only ever match this migration's own inserts).
-- ============================================================
INSERT INTO chart_history (company_id, chart_id, old_status, new_status, changed_by, reason)
SELECT
  ch.company_id,
  ch.id,
  NULL,
  'chart_ready',
  NULL,
  'Historical Chart backfill — Sub-Milestone 4.2'
FROM charts ch
WHERE NOT EXISTS (SELECT 1 FROM chart_history h WHERE h.chart_id = ch.id);

-- ============================================================
-- 3. AUDIT_LOGS — exactly one 'chart.backfilled' entry for every Chart still
--    missing one (same self-scoping reasoning as step 2).
-- ============================================================
INSERT INTO audit_logs (company_id, site_id, user_id, action, module, record_type, record_id, new_value)
SELECT
  ch.company_id,
  ch.site_id,
  NULL,
  'chart.backfilled',
  'charts',
  'chart',
  ch.id,
  jsonb_build_object(
    'status', 'chart_ready',
    'visit_id', ch.visit_id,
    'note', 'Historical Chart backfill — Sub-Milestone 4.2'
  )
FROM charts ch
WHERE NOT EXISTS (
  SELECT 1 FROM audit_logs a WHERE a.record_id = ch.id AND a.action = 'chart.backfilled'
);

COMMIT;

-- ============================================================
-- VALIDATION (for manual use after applying — not executed by this file)
--
--   -- Eligible candidates remaining for the confirmed company (expect 0):
--   SELECT count(*) FROM visits v
--   WHERE v.status IN ('completed','out_of_window')
--     AND v.company_id = 'a181874c-9f28-4822-97ae-8a5da769e91a'
--     AND NOT EXISTS (SELECT 1 FROM charts c WHERE c.visit_id = v.id);
--
--   -- Every backfilled chart has exactly one history row and one audit row:
--   SELECT ch.id,
--          (SELECT count(*) FROM chart_history h WHERE h.chart_id = ch.id) AS history_rows,
--          (SELECT count(*) FROM audit_logs a WHERE a.record_id = ch.id AND a.action = 'chart.backfilled') AS audit_rows
--   FROM charts ch
--   JOIN chart_history h2 ON h2.chart_id = ch.id AND h2.reason = 'Historical Chart backfill — Sub-Milestone 4.2';
--
--   -- No cross-tenant/ownership drift introduced:
--   SELECT count(*) FROM charts ch JOIN visits v ON v.id = ch.visit_id
--   WHERE ch.company_id IS DISTINCT FROM v.company_id
--      OR ch.site_id IS DISTINCT FROM v.site_id
--      OR ch.study_id IS DISTINCT FROM v.study_id
--      OR ch.subject_id IS DISTINCT FROM v.subject_id;
-- ============================================================

-- ============================================================
-- ROLLBACK
-- Identifies ONLY rows this migration itself created — never a broad
-- deletion capable of touching subsequent legitimate Chart activity (same
-- convention as migration 025's rollback section). Order matters:
-- audit_logs has no FK to charts (record_id is a bare uuid) and is never
-- cascade-deleted, so it must be removed explicitly first; chart_history has
-- ON DELETE CASCADE from chart_id (migration 026) and disappears
-- automatically once its owning charts row is deleted.
--
-- DELETE FROM audit_logs
-- WHERE action = 'chart.backfilled'
--   AND record_id IN (
--     SELECT ch.id FROM charts ch
--     JOIN chart_history h ON h.chart_id = ch.id
--     WHERE h.reason = 'Historical Chart backfill — Sub-Milestone 4.2'
--       AND ch.company_id = 'a181874c-9f28-4822-97ae-8a5da769e91a'
--   );
--
-- DELETE FROM charts
-- WHERE id IN (
--   SELECT ch.id FROM charts ch
--   JOIN chart_history h ON h.chart_id = ch.id
--   WHERE h.reason = 'Historical Chart backfill — Sub-Milestone 4.2'
--     AND ch.company_id = 'a181874c-9f28-4822-97ae-8a5da769e91a'
-- );
-- -- (chart_history rows for these charts are removed automatically by
-- -- ON DELETE CASCADE the moment the charts row above is deleted.)
-- ============================================================
