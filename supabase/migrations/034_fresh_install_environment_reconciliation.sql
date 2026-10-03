-- ============================================================
-- Migration 034 — Fresh-install environment reconciliation for 027/028
-- ============================================================
--
-- CONTEXT
-- Migrations 027 (charts_historical_backfill) and 028
-- (fix_chart_backfill_audit_scope) are pure DML, no schema/function/policy/
-- grant change (confirmed by full read during the Milestone 5.0 Fresh-Install
-- Architecture Audit). Both are permanently, correctly, already-applied on
-- the ORIGINAL project (company_id = 'a181874c-9f28-4822-97ae-8a5da769e91a',
-- "Zentariq Systems") and must never be re-executed or edited there or
-- anywhere else — 027's own header calls its scope "a single, explicit,
-- human-confirmed... decision for THIS migration only."
--
-- On a FRESH (non-original) database, that company does not exist, so 027's
-- hard `RAISE EXCEPTION unless exactly 8 candidates` precondition can never
-- be satisfied — it is architecturally impossible for 027/028 to ever
-- legitimately run anywhere except the one project they already ran on.
-- The approved fresh-install procedure (Milestone 5.0 Historical Migration
-- Archive Audit, Option 2) is therefore: mark 027/028 `applied` via
-- `supabase migration repair` (a ledger-only operation, never touching
-- schema or data) WITHOUT ever executing their bodies, so `db push` can
-- proceed to 029+ — and record that fact durably, right here, in 034.
--
-- WHAT THIS MIGRATION DOES
-- It distinguishes exactly two legitimate environment classes, using no
-- signal beyond what 027/028 themselves already established:
--
--   1. ORIGINAL/HISTORICAL environment — the "Zentariq Systems" company
--      exists AND has exactly 8 charts tagged with 027's own permanent
--      backfill marker (chart_history.reason = 'Historical Chart backfill
--      — Sub-Milestone 4.2'). This is 027's own "exactly 8" invariant,
--      re-used here, not invented. On this path, 034 is a documented,
--      verified NO-OP: it inserts nothing, updates nothing, never touches
--      charts / chart_history / audit_logs, and never raises merely for
--      being the original environment.
--
--   2. FRESH/NON-ORIGINAL environment — that company does not exist at
--      all. On this path, 034 inserts exactly one durable, permanent
--      record (see MIGRATION_RECONCILIATION_LOG below) stating that 027
--      and 028 were reconciled (marked applied in migration history)
--      without executing their bodies, and why.
--
--   AMBIGUOUS (fail closed, not invented): the company exists but does NOT
--   have exactly 8 backfill-tagged charts. This is neither a pristine
--   fresh database (which has no such company at all) nor the verified
--   original state (which always has exactly 8, per 027's own guarantee)
--   — something changed since 027 last ran there, or the id collided by
--   some other means. 034 refuses to guess and raises, exactly mirroring
--   027/028's own "abort rather than assume" precondition philosophy.
--
-- WHY A NEW TABLE, NOT audit_logs
-- audit_logs.company_id is NOT NULL (migration 001) and a genuinely fresh,
-- just-migrated database has zero rows in `companies` — there is no valid
-- company to attach a company-scoped audit row to at migration time, and
-- this fact is not about any one company anyway; it is a deployment/
-- bootstrap-level fact. migration_reconciliation_log below is a minimal,
-- company-agnostic, RLS-enabled-with-no-policies (so no session, only the
-- migration runner itself, can ever write or read it) table that exists
-- solely to hold this one class of fact. No application code reads or
-- writes it.
--
-- IDEMPOTENCY
-- The fresh-environment INSERT is guarded by a NOT EXISTS check against the
-- table itself — since this table has exactly one purpose, "any row already
-- present" means "already reconciled," so re-running this file's body
-- (accidentally or otherwise) inserts nothing further.
--
-- SCOPE DISCIPLINE
-- No schema/RLS/grant change beyond the one new table this reconciliation
-- itself needs. Migrations 001–033 are not touched. No historical chart,
-- chart_history, or audit_logs row is ever read for writing, inserted,
-- updated, or deleted by this migration, on either environment path.
--
-- Rollback: see ROLLBACK section at the bottom.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS migration_reconciliation_log (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciled_versions text[]      NOT NULL,
  note                text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- No policies — default-deny for `anon`/`authenticated` (RLS with zero
-- policies permits nothing to those roles); `service_role`/the migration
-- runner bypass RLS entirely, which is the only intended writer, ever.
ALTER TABLE migration_reconciliation_log ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  v_original_company_id uuid := 'a181874c-9f28-4822-97ae-8a5da769e91a';
  v_backfill_reason      text := 'Historical Chart backfill — Sub-Milestone 4.2';
  v_company_exists       boolean;
  v_backfilled_count     integer;
BEGIN
  SELECT EXISTS (SELECT 1 FROM companies WHERE id = v_original_company_id)
    INTO v_company_exists;

  IF v_company_exists THEN
    SELECT count(*) INTO v_backfilled_count
    FROM charts ch
    JOIN chart_history h ON h.chart_id = ch.id
    WHERE h.reason = v_backfill_reason
      AND ch.company_id = v_original_company_id;

    IF v_backfilled_count = 8 THEN
      -- ORIGINAL/HISTORICAL environment, verified. 027/028 already
      -- legitimately executed here. No-op: nothing inserted, nothing
      -- touched on charts/chart_history/audit_logs, no exception raised
      -- merely for being the original environment.
      RAISE NOTICE
        'Migration 034: original historical environment verified (company % present with all 8 Sub-Milestone 4.2 backfilled charts) — no reconciliation needed, no-op.',
        v_original_company_id;
    ELSE
      -- AMBIGUOUS — fail closed rather than guess, mirroring 027/028's own
      -- precondition philosophy exactly.
      RAISE EXCEPTION
        'Migration 034: ambiguous environment state — company % exists but has % chart(s) tagged with the Sub-Milestone 4.2 backfill marker (expected exactly 8, the count 027 itself guarantees for the genuine original environment). This is neither a fresh database (no such company would exist) nor the verified original state. Aborting without making any change — re-audit before proceeding.',
        v_original_company_id, v_backfilled_count;
    END IF;
  ELSE
    -- FRESH/NON-ORIGINAL environment — record the reconciliation fact once.
    INSERT INTO migration_reconciliation_log (reconciled_versions, note)
    SELECT
      ARRAY['027', '028'],
      'Migrations 027 (charts_historical_backfill) and 028 (fix_chart_backfill_audit_scope) are original-environment historical DML (Sub-Milestone 4.2 Chart backfill for company a181874c-9f28-4822-97ae-8a5da769e91a, and its audit-scope remediation) that cannot and must not execute here — this database has no such company. Their versions were marked applied via `supabase migration repair --status applied 027 028` for fresh-install bootstrap purposes only; their SQL bodies never ran on this database, and no chart, chart_history, or audit_logs row from either was fabricated. See migration 034 and tests/e2e/README.md for the full fresh-install procedure.'
    WHERE NOT EXISTS (SELECT 1 FROM migration_reconciliation_log);
  END IF;
END $$;

COMMIT;

-- ============================================================
-- ROLLBACK
-- Drops only what this migration itself created. Never touches companies,
-- charts, chart_history, or audit_logs — this migration never wrote to any
-- of them on either environment path, so there is nothing there to revert.
--
-- DROP TABLE IF EXISTS migration_reconciliation_log;
-- ============================================================
