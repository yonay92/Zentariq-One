-- Migration: 025_document_center_backfill.sql
-- Description: Sub-Milestone 3.5 — one-time, idempotent Document Center
--   backfill for historical rows created before each module's respective
--   Document Center retrofit went live (3.1/3.1b Regulatory, 3.2B Staff
--   Credentials, 3.3B Subjects, 3.4B Studies). DML only — no schema change.
--
-- Scope: exactly the four approved modules (regulatory_documents,
--   staff_documents, subject_documents, study_documents). study_drafts is
--   explicitly and permanently excluded per the Sub-Milestone 3.4
--   architecture decision — no statement in this file inserts, deletes, or
--   otherwise references a file_links row with module='study_drafts'.
--
-- Numbering: 023 remains permanently reserved/skipped (see migration 024's
--   own header). 024 is the highest migration present both locally and on
--   the remote project as of Sub-Milestone 3.5A's audit and 3.5B's
--   re-confirmation immediately before this file was written (verified via
--   `supabase migration list` both times, with identical results) — this
--   migration is 025.
--
-- ============================================================
-- CANONICAL MAPPING (established and audited in Sub-Milestone 3.5A —
-- reproduces the exact semantics already implemented in each service's
-- linkForModule/relinkForModule call site; see that audit report for the
-- full per-module analysis and live-data verification):
--
--   regulatory_documents -> document_versions, newest row by
--     (uploaded_at DESC, id DESC) for that document_id, REGARDLESS of its
--     current is_current/status value. This matches create()/replace()'s
--     own behavior exactly: each links whichever version it just
--     inserted, and no later action (approve/reject/archive) ever
--     unlinks or relinks it — so a document whose newest version was
--     later archived or rejected still correctly resolves to that
--     version's file.
--   staff_documents -> document_versions, newest row by
--     (uploaded_at DESC, id DESC) for that staff_document_id. Used
--     directly (not the staff_documents.file_id convenience column,
--     which the live code keeps in sync but which is not itself the
--     source of truth), per the explicit instruction not to rely on a
--     convenience/stale pointer when another table is the actual source
--     of truth.
--   subject_documents -> its own file_id column directly. No versioning
--     table exists for this module; file_id is set exactly once, at
--     INSERT, and never updated by any code path — it IS the source of
--     truth, not a pointer to one.
--   study_documents -> its own file_id column directly, same reasoning
--     as subject_documents (set once at INSERT by uploadProtocol() or
--     finalizeDraft(), never updated afterward).
--
-- Every candidate row additionally requires
-- files.company_id = <record>.company_id before being inserted — a file
-- whose owning company disagrees with the source record's company is
-- excluded as an anomaly, never linked. Zero such anomalies were found
-- in the live dataset audited for this migration (13 regulatory_documents,
-- 1 staff_documents, 2 subject_documents, 8 study_documents, 16 existing
-- file_links rows, all individually traced), but the guard is
-- unconditional here, not just a one-time check.
-- ============================================================
--
-- ============================================================
-- HISTORICAL STALENESS FIX (regulatory_documents only — the only module
-- with a stale association anywhere in the audited dataset):
--
-- Sub-Milestones 3.1 (create() retrofit) and 3.1b (replace()'s
-- relinkForModule) were implemented separately, in that order. Any
-- document created and then replaced strictly within that window got its
-- file_links row written once, by create()'s linkForModule (pointing at
-- v1's file), and never updated when replace() produced a newer version,
-- because relinkForModule did not exist yet at that moment. Two such
-- documents were identified and independently re-confirmed immediately
-- before this migration was written (Sub-Milestone 3.5A audit, then
-- re-verified in 3.5B with identical results — zero drift):
--
--   file_links.id = 'd26400bb-0c93-49e7-8f0d-efcb71dff528'
--     regulatory_documents.id = '9423acae-459f-49a5-beee-c997ebd415cc'
--     currently points at file_id = '84e75d34-f3c4-442b-9c09-237b2e91af05'
--       (that document's v1, document_versions.status = 'superseded')
--     authoritative replacement: file_id =
--       '81a85a90-48ec-470a-8a16-8afb7c2e57e4' (v2, is_current = true)
--
--   file_links.id = '1cb708d1-1218-444b-af60-5bb573254827'
--     regulatory_documents.id = '6505d77a-fc38-4e12-af9b-f5748ce4b224'
--     currently points at file_id = '2b6f90d2-d96f-471f-91ea-f847b57aafd4'
--       (that document's v1, document_versions.status = 'superseded')
--     authoritative replacement: file_id =
--       'fbd275fa-032b-49b4-aa25-db3ee5c35a0f' (v2, is_current = false,
--       status = 'archived' — still the correct target: this document was
--       archived after its v2 replacement, and archive() never touches
--       file_links, exactly mirroring what the live retrofit code would
--       already show had relinkForModule existed for its entire history)
--
-- Deleting each is necessary because file_links has no UPDATE policy by
-- design (migration 022: "links are immutable... unlink + relink, not an
-- update") — the only way to correct a wrong association is to remove it
-- and insert the right one, which is exactly what this migration's DELETE
-- step followed by its INSERT step does.
--
-- The DELETE predicate below is intentionally over-constrained, not just
-- "module + record_id": it requires the exact file_links.id (there is no
-- narrower identifier — it is this table's own primary key), AND
-- company_id, AND module, AND record_id, AND the specific stale file_id,
-- ALL simultaneously. Every one of those five conditions was independently
-- confirmed against live data immediately before this file was written.
-- This predicate cannot affect any other tenant, document, or link:
-- file_links.id is globally unique by definition, so even a single one of
-- these five AND'ed conditions alone would already be sufficient to select
-- at most the one intended row — requiring all five simultaneously makes a
-- mismatch (and thus an unintended deletion) structurally impossible, not
-- merely unlikely. Nothing else in the four-module dataset was found stale
-- during the 3.5A audit or its 3.5B re-confirmation.
-- ============================================================
--
-- Idempotent: every INSERT is guarded by NOT EXISTS on the exact
-- (file_id, module, record_id) tuple file_links already uniquely indexes
-- (uq_file_links_file_module_record); the two DELETEs are scoped to exact,
-- literal file_links.id primary keys — once removed, those ids can never
-- exist again, so re-running this migration any number of times after the
-- first affects zero further rows in every statement.
--
-- Never touches: study_drafts, any module value outside the four listed
-- above (including the pre-existing, unrelated 'subjects'-module rows from
-- Milestone 2's own generic linkToRecord testing — left completely alone),
-- or any column on regulatory_documents/staff_documents/subject_documents/
-- study_documents themselves. No schema/DDL statement of any kind.
--
-- Rollback: see ROLLBACK section at the bottom.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. REGULATORY_DOCUMENTS — remove the two identified stale associations
--    (unlink step; see the HISTORICAL STALENESS FIX comment above for the
--    full justification of each row targeted here)
-- ============================================================
DELETE FROM file_links fl
WHERE fl.id = 'd26400bb-0c93-49e7-8f0d-efcb71dff528'
  AND fl.company_id = 'c1be2318-7ec1-491b-b0df-3cd0b9d70af7'
  AND fl.module = 'regulatory_documents'
  AND fl.record_id = '9423acae-459f-49a5-beee-c997ebd415cc'
  AND fl.file_id = '84e75d34-f3c4-442b-9c09-237b2e91af05';

DELETE FROM file_links fl
WHERE fl.id = '1cb708d1-1218-444b-af60-5bb573254827'
  AND fl.company_id = 'c1be2318-7ec1-491b-b0df-3cd0b9d70af7'
  AND fl.module = 'regulatory_documents'
  AND fl.record_id = '6505d77a-fc38-4e12-af9b-f5748ce4b224'
  AND fl.file_id = '2b6f90d2-d96f-471f-91ea-f847b57aafd4';

-- ============================================================
-- 2. REGULATORY_DOCUMENTS — insert missing/corrected associations
-- ============================================================
INSERT INTO file_links (company_id, file_id, site_id, module, record_id, created_by)
SELECT rd.company_id, newest.file_id, rd.site_id, 'regulatory_documents', rd.id, NULL
FROM regulatory_documents rd
JOIN LATERAL (
  SELECT dv.file_id
  FROM document_versions dv
  WHERE dv.document_id = rd.id
  ORDER BY dv.uploaded_at DESC, dv.id DESC
  LIMIT 1
) newest ON true
JOIN files f ON f.id = newest.file_id AND f.company_id = rd.company_id
WHERE NOT EXISTS (
  SELECT 1 FROM file_links fl
  WHERE fl.file_id = newest.file_id
    AND fl.module = 'regulatory_documents'
    AND fl.record_id = rd.id
);

-- ============================================================
-- 3. STAFF_DOCUMENTS — insert missing associations
-- ============================================================
INSERT INTO file_links (company_id, file_id, site_id, module, record_id, created_by)
SELECT sd.company_id, newest.file_id, sd.site_id, 'staff_documents', sd.id, NULL
FROM staff_documents sd
JOIN LATERAL (
  SELECT dv.file_id
  FROM document_versions dv
  WHERE dv.staff_document_id = sd.id
  ORDER BY dv.uploaded_at DESC, dv.id DESC
  LIMIT 1
) newest ON true
JOIN files f ON f.id = newest.file_id AND f.company_id = sd.company_id
WHERE NOT EXISTS (
  SELECT 1 FROM file_links fl
  WHERE fl.file_id = newest.file_id
    AND fl.module = 'staff_documents'
    AND fl.record_id = sd.id
);

-- ============================================================
-- 4. SUBJECT_DOCUMENTS — insert missing associations, independently per
--    row (never collapsed by subject_id — each subject_documents row is
--    its own independent logical document, per Sub-Milestone 3.3's
--    multi-attachment architecture)
-- ============================================================
INSERT INTO file_links (company_id, file_id, site_id, module, record_id, created_by)
SELECT sub_doc.company_id, sub_doc.file_id, s.site_id, 'subject_documents', sub_doc.id, NULL
FROM subject_documents sub_doc
JOIN subjects s ON s.id = sub_doc.subject_id
JOIN files f ON f.id = sub_doc.file_id AND f.company_id = sub_doc.company_id
WHERE NOT EXISTS (
  SELECT 1 FROM file_links fl
  WHERE fl.file_id = sub_doc.file_id
    AND fl.module = 'subject_documents'
    AND fl.record_id = sub_doc.id
);

-- ============================================================
-- 5. STUDY_DOCUMENTS — insert missing associations, independently per row
--    (initial protocol, each amendment, and each finalized AI draft are
--    all independent study_documents rows, per Sub-Milestone 3.4's
--    multi-attachment architecture — never collapsed by study_id).
--    study_drafts rows are NEVER referenced by this migration at all.
-- ============================================================
INSERT INTO file_links (company_id, file_id, site_id, module, record_id, created_by)
SELECT std_doc.company_id, std_doc.file_id, NULL, 'study_documents', std_doc.id, NULL
FROM study_documents std_doc
JOIN files f ON f.id = std_doc.file_id AND f.company_id = std_doc.company_id
WHERE NOT EXISTS (
  SELECT 1 FROM file_links fl
  WHERE fl.file_id = std_doc.file_id
    AND fl.module = 'study_documents'
    AND fl.record_id = std_doc.id
);

COMMIT;

-- ============================================================
-- ROLLBACK
-- Not provided as a blind reverse-DELETE — that would also remove any
-- legitimate association a user created live between this migration
-- running and a rollback being considered. If specific rows inserted by
-- this migration need to be identified, they are exactly the rows in
-- file_links with created_by IS NULL and module IN
-- ('regulatory_documents','staff_documents','subject_documents','study_documents')
-- whose created_at falls within this migration's run window. The two
-- deleted stale rows are documented in full above (id, company_id,
-- module, record_id, file_id) if they ever need to be manually
-- reconstructed — though doing so would restore a known-stale state,
-- which is never desirable; prefer re-deriving the correct association
-- via the same INSERT logic above instead.
-- ============================================================
