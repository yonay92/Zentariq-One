-- Migration: 022_document_center_foundation.sql
-- Description: Document Center Milestone 1 — Document Foundation.
--   Introduces the generic, cross-module file-linking layer on top of the
--   `files` table that has existed since migration 003. Adds `file_links`,
--   a `documents` storage bucket, and the `view_documents` / `upload_documents`
--   permissions that `services/company/CompanyService.ts`'s `provision()`
--   already forward-references for the ceo/crc/regulatory roles (those
--   entries have been silent no-ops until now, since the permission rows
--   didn't exist).
--
-- Explicitly OUT of scope for this migration (see docs/UI_UX_11 +
-- Milestone 2/3 of the approved Document Center plan):
--   - file_folders, generic file_versions, file_ai_metadata — not needed by
--     FileService's Milestone 1 primitives (upload / metadata / signed URL /
--     link / unlink) and are deferred to the milestones that actually need
--     them (browse UI, OCR/AI).
--   - No retrofit of the five existing upload flows (SubjectService,
--     StudyService, AIDraftService, StaffCredentialService,
--     RegulatoryDocumentService) — this migration is purely additive. None
--     of their existing `files` INSERT policies (`files_insert`,
--     `files_insert_regulatory`) are touched.
--
-- ============================================================
-- AUTHORIZATION MODEL FOR file_links (documented per Milestone 1's security
-- requirements before the policies below were written)
--
-- Threat model: a user authenticated into Company A's session must never be
-- able to discover, read, link, modify, or obtain a signed URL for Company
-- B's files — regardless of what client-supplied IDs they pass.
--
-- company_id — the hard tenant boundary. Every policy below requires
--   `company_id = current_company_id()`, where current_company_id() is
--   resolved server-side from the authenticated session's own profile row
--   (never client-supplied). This alone makes cross-company file_links rows
--   invisible/unwritable, independent of anything else. The INSERT policy
--   additionally verifies (via EXISTS) that file_links.file_id actually
--   belongs to that same company_id — this stops a Company A session from
--   forging a file_links row whose company_id column says "A" but whose
--   file_id secretly points at a Company B file.
--
-- site_id — the operational-access boundary, mirroring the exact pattern
--   already used by regulatory_binders / regulatory_documents / staff_documents
--   (can_access_site(), the same SQL helper, no new one introduced). Stored
--   directly ON file_links (denormalized, nullable) rather than resolved via
--   a generic join against the linked record — a truly generic polymorphic
--   join across every current and future `module` value is not something SQL
--   RLS can express safely or extensibly. The service layer (FileService),
--   which already knows the concrete module/record being linked, resolves
--   and supplies site_id at link time. NULL site_id = company-wide file
--   (e.g. a corporate SOP), matching regulatory_binders' own
--   `study_id IS NOT NULL OR site_id IS NOT NULL` — but for file_links both
--   may legitimately be null (no site scope at all).
--
-- study_id — deliberately NOT stored on file_links and NOT part of its RLS.
--   The one existing precedent for this exact question — regulatory_documents,
--   which has both site_id AND study_id columns — only gates its RLS on
--   site_id; study_id is informational only, resolved via the `module`/
--   `record_id`'s own table when needed. file_links follows the same,
--   already-established precedent rather than inventing a second scoping
--   dimension.
--
-- record_id (the polymorphic target) — this is the one dimension RLS
--   genuinely cannot verify generically: record_id is an opaque uuid with no
--   FK (by design — that's what makes file_links usable by every current and
--   future module without a schema change per module). This is a known,
--   inherent limitation of the polymorphic-link pattern, not an oversight —
--   it is the same tradeoff GAP_ANALYSIS.md's GAP-DB-03 already accepted for
--   this exact design ("this is indirect but correct for the polymorphic
--   file model"). Mitigation: FileService.linkToRecord requires an explicit,
--   already-resolved site_id from the caller (who owns the module-specific
--   knowledge of what site that record belongs to) and independently
--   verifies the caller can access that site via PermissionService before
--   ever writing the row — a defense-in-depth application-layer check on top
--   of the RLS company/site checks, not a replacement for them.
--
-- Signed URL issuance (FileService.getSignedUrl): never covered by a
--   database policy directly (storage.objects RLS below only proves
--   company-level bucket-folder isolation, the same limitation the existing
--   `protocols`/`regulatory` buckets already have). Site-level authorization
--   for a specific file is enforced in FileService BEFORE calling
--   storage.createSignedUrl(): it resolves every site_id any file_links row
--   links that file to (via the admin client, deliberately bypassing
--   file_links' own RLS for this one lookup — see FileService's comment
--   explaining why: the caller must be told "you cannot access this file at
--   this site" rather than silently seeing an empty, indistinguishable-from-
--   "no site restriction at all" result if RLS pre-filtered the query for
--   them) and requires PermissionService.canAccessSite() to succeed for at
--   least one of them. Only once that passes does the actual
--   storage.createSignedUrl() call happen — and even then it runs through
--   the session-scoped (RLS-respecting) Supabase client, not the admin
--   client, so the storage bucket's own company-isolation RLS (below) is
--   still a live backstop, not bypassed.
-- ============================================================
--
-- Depends on: 001_companies_sites_users.sql (companies, current_company_id),
--   002_roles_permissions.sql (permissions, has_permission, can_access_site),
--   003_studies_visit_templates.sql (files table)
-- Rollback: see ROLLBACK section at the bottom

-- ============================================================
-- FILE_LINKS  (FK -> companies, files, sites)
-- Generic polymorphic link between a stored file and any domain record.
-- See the authorization-model comment block above for the full design
-- rationale behind every column and policy here.
-- ============================================================

CREATE TABLE file_links (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  file_id    uuid        NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  site_id    uuid        REFERENCES sites(id) ON DELETE CASCADE,
  module     text        NOT NULL,
  record_id  uuid        NOT NULL,
  created_by uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Prevents the same file being linked twice to the same record.
CREATE UNIQUE INDEX uq_file_links_file_module_record ON file_links (file_id, module, record_id);

CREATE INDEX idx_file_links_company       ON file_links(company_id);
CREATE INDEX idx_file_links_site          ON file_links(site_id);
CREATE INDEX idx_file_links_file          ON file_links(file_id);
CREATE INDEX idx_file_links_module_record ON file_links(module, record_id);

ALTER TABLE file_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "file_links_select" ON file_links
  FOR SELECT USING (
    company_id = current_company_id()
    AND has_permission('view_documents')
    AND (site_id IS NULL OR can_access_site(site_id))
  );

CREATE POLICY "file_links_insert" ON file_links
  FOR INSERT WITH CHECK (
    company_id = current_company_id()
    AND has_permission('upload_documents')
    AND (site_id IS NULL OR can_access_site(site_id))
    AND EXISTS (
      SELECT 1 FROM files
      WHERE files.id = file_links.file_id
        AND files.company_id = file_links.company_id
    )
  );

-- Unlinking is a hard delete of the LINK row only — the underlying file in
-- `files`/storage is never touched (matches "Files: Never deleted" in the
-- approved soft-delete strategy; only the association is removed, same as
-- removing a tag, not deleting a document).
CREATE POLICY "file_links_delete" ON file_links
  FOR DELETE USING (
    company_id = current_company_id()
    AND has_permission('upload_documents')
    AND (site_id IS NULL OR can_access_site(site_id))
  );

-- Deliberately no UPDATE policy — links are immutable. Changing what a file
-- is linked to is unlink + relink, not an update.

-- ============================================================
-- FILES — one new, purely additive INSERT policy for FileService's generic
-- upload primitive. Does not touch/replace `files_insert` (003) or
-- `files_insert_regulatory` (016) — Postgres RLS policies for the same
-- command are OR'd together, so this only ever widens what's allowed, and
-- only for the new upload_documents permission.
-- ============================================================

CREATE POLICY "files_insert_document_center" ON files
  FOR INSERT WITH CHECK (
    company_id = current_company_id()
    AND has_permission('upload_documents')
  );

-- ============================================================
-- STORAGE BUCKET — documents
-- Private, signed-URL-only, same pattern as the existing `protocols` (003)
-- and `regulatory` (016) buckets. Key convention:
--   {company_id}/{uuid}_{filename}
-- The uuid path segment (generated before upload, same technique regulatory
-- uses for its version_id segment) guarantees a unique storage key.
--
-- This bucket-level policy proves company isolation only (folder-prefix
-- match), the same limitation protocols/regulatory already have — it is not
-- expected to enforce site-level access on its own. See the authorization
-- model comment above for where site-level enforcement actually happens
-- (FileService, before it ever calls createSignedUrl).
-- ============================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('documents', 'documents', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "documents_bucket_insert_own_company" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = current_company_id()::text
  );

CREATE POLICY "documents_bucket_select_own_company" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = current_company_id()::text
  );

-- ============================================================
-- PERMISSIONS — view_documents / upload_documents
-- Both keys are already referenced (as harmless forward-references — the
-- permission rows didn't exist yet) by services/company/CompanyService.ts's
-- provision(): ceoPerms/crcPerms/regulatoryPerms include 'view_documents',
-- regulatoryPerms also includes 'upload_documents'. Creating these rows here
-- makes those existing role-grant lists take effect for every NEWLY
-- provisioned company with zero further code changes. Administrator is not
-- given a special case — provision()'s adminPerms already grants "every
-- permission except ADMIN_EXCLUDED_PERMISSIONS", and neither key is in that
-- exclusion set, so Administrator gets both automatically.
-- ============================================================

INSERT INTO permissions (key, module, description)
VALUES
  ('view_documents',   'documents', 'View files in the Document Center and linked to records the user can access'),
  ('upload_documents', 'documents', 'Upload files and link/unlink them to records via the Document Center')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- BACKFILL — grant the new permissions to every EXISTING company's roles,
-- mirroring exactly what CompanyService.ts's provision() grants to newly
-- provisioned companies (admin: both, via "every permission except
-- excluded"; ceo/crc: view_documents; regulatory: both). Same backfill
-- pattern as migration 016.
-- ============================================================

INSERT INTO role_permissions (company_id, role_id, permission_id, allowed)
SELECT r.company_id, r.id, p.id, true
FROM roles r
CROSS JOIN permissions p
WHERE r.key = 'admin'
  AND p.key IN ('view_documents', 'upload_documents')
ON CONFLICT (company_id, role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (company_id, role_id, permission_id, allowed)
SELECT r.company_id, r.id, p.id, true
FROM roles r
CROSS JOIN permissions p
WHERE r.key IN ('ceo', 'crc')
  AND p.key = 'view_documents'
ON CONFLICT (company_id, role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (company_id, role_id, permission_id, allowed)
SELECT r.company_id, r.id, p.id, true
FROM roles r
CROSS JOIN permissions p
WHERE r.key = 'regulatory'
  AND p.key IN ('view_documents', 'upload_documents')
ON CONFLICT (company_id, role_id, permission_id) DO NOTHING;

-- ============================================================
-- ROLLBACK
-- DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE key IN ('view_documents', 'upload_documents'));
-- DELETE FROM permissions WHERE key IN ('view_documents', 'upload_documents');
-- DROP POLICY IF EXISTS "documents_bucket_select_own_company" ON storage.objects;
-- DROP POLICY IF EXISTS "documents_bucket_insert_own_company" ON storage.objects;
-- DELETE FROM storage.buckets WHERE id = 'documents';
-- DROP POLICY IF EXISTS "files_insert_document_center" ON files;
-- DROP POLICY IF EXISTS "file_links_delete" ON file_links;
-- DROP POLICY IF EXISTS "file_links_insert" ON file_links;
-- DROP POLICY IF EXISTS "file_links_select" ON file_links;
-- DROP TABLE IF EXISTS file_links CASCADE;
-- ============================================================
