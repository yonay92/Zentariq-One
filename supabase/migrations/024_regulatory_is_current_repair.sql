-- Migration: 024_regulatory_is_current_repair.sql
-- Description: One-time, idempotent data repair for a pre-existing defect in
--   RegulatoryDocumentService.replace() (services/regulatory/RegulatoryDocumentService.ts):
--   the newly-inserted document_versions row for a replacement was written
--   with is_current: false instead of true. Since replace() also flips the
--   *previous* version to is_current: false in the same call, every document
--   that has ever been replaced currently has ZERO document_versions rows
--   with is_current = true — permanently, until repaired — which blocks
--   approve()/reject() (both call getCurrentVersion(), which queries
--   is_current = true and throws BusinessRuleError when nothing matches) and
--   blocks any subsequent replace() call on the same document.
--
-- This migration repairs EXISTING data only. The code defect itself (the
-- application-layer is_current: false on the new version, in replace()) is
-- fixed separately in this same Sub-Milestone 3.1a, not by this migration.
--
-- Note on numbering: 023 is reserved for the future Document Center backfill
-- (Sub-Milestone 3.5) and is deliberately skipped here to avoid a collision.
--
-- ============================================================
-- PREDICATE — narrowly scoped, deterministic, proven against live data
-- before being written (see Sub-Milestone 3.1a's analysis):
--
--   A row qualifies for repair only if ALL of the following hold:
--     1. document_id IS NOT NULL — regulatory documents only. Staff
--        credentials (staff_document_id-scoped rows) are explicitly
--        untouched: StaffCredentialService.replace() already sets
--        is_current: true correctly and was never affected by this defect.
--     2. It is the single newest row for its document_id, ordered by
--        (uploaded_at DESC, id DESC) — the tie-break on id makes the
--        candidate selection unambiguous even in the (currently
--        unobserved) case of two rows sharing a timestamp.
--     3. status = 'pending_review' AND previous_version_id IS NOT NULL —
--        this is the exact, unique signature replace()'s defect leaves
--        behind (a version inserted by replace(), still awaiting review,
--        that was supposed to become current and wasn't). This predicate
--        deliberately does NOT match a document whose newest version is
--        'rejected' or 'archived' — reject() and archive() *also*
--        legitimately leave a document with zero is_current = true rows,
--        by design, and must never be touched by this repair. A document's
--        newest row can only be 'pending_review' due to this specific bug
--        because approve()/reject() are themselves blocked by the same
--        defect (they call getCurrentVersion(), which returns nothing, and
--        throw before ever updating the row) — so a genuinely
--        replace()-affected row can never have reached 'approved' or
--        'rejected' status. This makes the predicate exhaustive: nothing
--        outside this exact signature can be a false positive.
--     4. NOT EXISTS a row for the same document_id with is_current = true —
--        confirms the document is actually in the broken (zero-current)
--        state before touching anything.
--
-- Idempotent: after a row is repaired, condition 4 becomes false for its
-- document_id (a current row now exists), so re-running this migration
-- finds nothing left to update — a no-op on every subsequent run.
--
-- Scope confirmed against live data before writing this migration: exactly
-- 8 document_versions rows matched this predicate (out of 17 total
-- document-scoped rows in the table), each the sole 'pending_review' /
-- previous_version_id-set row for its document_id, with zero rows anywhere
-- currently in a 'rejected' or 'archived' state — so no false-positive
-- exclusion case exists in the data today. The predicate is written to
-- remain correct even where that's not true, per the reasoning in point 3.
--
-- Never touches: status, file_id, checksum, effective_date, expiration_date,
-- replacement_reason, or any other column — only is_current. Never touches
-- regulatory_documents (the separate, still-open slot-file_id-staleness
-- issue discovered during Sub-Milestone 3.1a's analysis is completely
-- independent of this defect and is explicitly NOT addressed here). Never
-- deletes any row, in this table or any other.
-- ============================================================

UPDATE document_versions dv
SET is_current = true
WHERE dv.document_id IS NOT NULL
  AND dv.status = 'pending_review'
  AND dv.previous_version_id IS NOT NULL
  AND dv.id = (
    SELECT d2.id
    FROM document_versions d2
    WHERE d2.document_id = dv.document_id
    ORDER BY d2.uploaded_at DESC, d2.id DESC
    LIMIT 1
  )
  AND NOT EXISTS (
    SELECT 1 FROM document_versions cur
    WHERE cur.document_id = dv.document_id
      AND cur.is_current = true
  );

-- ============================================================
-- ROLLBACK
-- No meaningful rollback is provided: the prior state (is_current = false
-- on the affected row) was itself the bug this migration exists to correct,
-- so reverting would restore a known-broken state, which is never
-- desirable. If a specific repair run needs to be undone, identify the
-- exact rows it touched via the read-only verification queries run before
-- and after applying this migration (see Sub-Milestone 3.1a's report) and
-- restore from a pre-migration snapshot rather than attempting a blind
-- reverse UPDATE here.
-- ============================================================
