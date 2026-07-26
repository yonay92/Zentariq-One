-- Migration: 016_regulatory_documents.sql
-- Description: Sprint 6 — Regulatory Compliance & eReg Binder. Extends the
--   document_types/study_document_requirements/files tables that migration 003
--   deliberately reserved for this sprint (see that migration's forward-
--   dependency note), and adds the regulatory document lifecycle: binders,
--   documents, versions, status history, and staff credentials.
--
-- Core business rule (explicit product decision — governs every table below):
--   Regulatory documents are immutable once uploaded.
--     - The stored file is never overwritten or replaced in place.
--     - Every replacement creates a new document_versions row; the previous
--       version remains permanently accessible in version history.
--     - Exactly one version per document may be marked current at a time
--       (enforced by a partial unique index, not just application logic).
--     - A version already in a terminal state (approved-then-superseded,
--       rejected, or archived) can never be updated again — enforced by the
--       document_versions UPDATE policy's USING clause, not merely by
--       service-layer discipline.
--     - Storage keys are unique per version (keyed by the version's own uuid,
--       generated before upload — not by upload timestamp, which is only
--       probabilistically unique).
--     - Archiving a document never deletes any version; no DELETE policy
--       exists on document_versions/document_history/staff_documents at all,
--       matching audit_logs' existing immutability pattern.
--
-- Design decisions (per product direction, from the approved Sprint 6 spec):
--   1. Table shapes follow docs/DATABASE_Part_05_Regulatory_Files_AI_Audit.md
--      directly (regulatory_binders, regulatory_documents, document_versions,
--      document_history, staff_documents) — extended only where the approved
--      spec's immutability rule required additional columns.
--   2. study_document_requirements is extended (study_id made nullable, site_id
--      added) rather than replaced, so one table declares requirements at
--      company/site/study scope via nullable FKs — same nullable-scope
--      pattern already used for `leads` (migration 014).
--   3. No Tasks table — renewal alerts go through the existing
--      NotificationService (document_expiring/document_expired event types
--      already defined in types/notifications.ts, unused until this sprint).
--   4. Scheduling for the expiration checker (and the pre-existing, previously
--      unscheduled visit-status-checker) uses Supabase pg_cron + pg_net. The
--      Edge Function URL and service-role key are NOT hardcoded here — they
--      must be provisioned into Supabase Vault out-of-band before the cron
--      jobs can run (see the note above the cron.schedule() calls below).
--   5. document_types.category remains free-text; binder "sections" in the UI
--      are computed at render time by grouping on it — no hardcoded document
--      names or categories anywhere in this migration or the services that
--      consume it.
--
-- Depends on: 001_companies_sites_users.sql (companies, sites, profiles,
--   current_company_id), 002_roles_permissions.sql (permissions, has_permission,
--   can_access_site), 003_studies_visit_templates.sql (document_types, files,
--   study_document_requirements, studies — all extended below, none redefined)
-- Rollback: see ROLLBACK section at the bottom

-- ============================================================
-- DOCUMENT_TYPES — extend (ALTER, per migration 003's reservation)
-- ============================================================

ALTER TABLE document_types
  ADD COLUMN has_expiration     boolean NOT NULL DEFAULT false,
  ADD COLUMN expiration_rule    jsonb,
  ADD COLUMN default_alert_days integer[] NOT NULL DEFAULT '{90,60,30,14,7}',
  ADD COLUMN requires_version   boolean NOT NULL DEFAULT true;

-- ============================================================
-- STUDY_DOCUMENT_REQUIREMENTS — extend to company/site/study scope
-- study_id becomes nullable; site_id is added. At least one of
-- (study_id, site_id) must be set OR both may be null for a company-wide
-- requirement (e.g. a corporate SOP required everywhere).
-- ============================================================

ALTER TABLE study_document_requirements
  ALTER COLUMN study_id DROP NOT NULL,
  ADD COLUMN site_id uuid REFERENCES sites(id) ON DELETE CASCADE;

-- The original UNIQUE (study_id, document_type_id) doesn't account for the
-- new site_id column or company-wide (both-null) requirements — replace it
-- with a COALESCE-based expression unique index, same technique used for
-- regulatory_binders/regulatory_documents slot uniqueness below.
ALTER TABLE study_document_requirements
  DROP CONSTRAINT uq_study_document_requirements;

CREATE UNIQUE INDEX uq_study_document_requirements ON study_document_requirements (
  company_id,
  document_type_id,
  COALESCE(study_id, '00000000-0000-0000-0000-000000000000'),
  COALESCE(site_id, '00000000-0000-0000-0000-000000000000')
);

CREATE INDEX idx_study_document_requirements_site ON study_document_requirements(site_id);

-- study_document_requirements previously had no UPDATE policy (it was
-- insert-only, populated solely by StudyService.activateStudy()). The
-- Document Requirement Builder needs to toggle required/expiration_required
-- in place, so an UPDATE policy is added, gated by the new
-- manage_regulatory_requirements permission (OR the existing manage_studies,
-- for backward compatibility — no app code currently reads this table, so
-- this is a safe additive change, not a breaking one).
CREATE POLICY "study_document_requirements_update" ON study_document_requirements
  FOR UPDATE USING (
    company_id = current_company_id()
    AND (has_permission('manage_studies') OR has_permission('manage_regulatory_requirements'))
  )
  WITH CHECK (
    company_id = current_company_id()
    AND (has_permission('manage_studies') OR has_permission('manage_regulatory_requirements'))
  );

-- Original insert policy only allowed manage_studies — widen to also accept
-- the new dedicated permission, matching the update policy above.
DROP POLICY "study_document_requirements_insert" ON study_document_requirements;

CREATE POLICY "study_document_requirements_insert" ON study_document_requirements
  FOR INSERT WITH CHECK (
    company_id = current_company_id()
    AND (has_permission('manage_studies') OR has_permission('manage_regulatory_requirements'))
  );

-- ============================================================
-- FILES — add a second INSERT policy for the regulatory upload flow
-- (migration 003's comment explicitly reserved this for Sprint 6, without
-- altering the existing studies-flow policy).
-- ============================================================

CREATE POLICY "files_insert_regulatory" ON files
  FOR INSERT WITH CHECK (
    company_id = current_company_id()
    AND has_permission('upload_regulatory_document')
  );

-- ============================================================
-- REGULATORY_BINDERS  (FK -> companies, studies, sites)
-- Thin container/anchor per (study) or (site) — actual document
-- organization is virtual (grouped by document_types.category at render
-- time), not a physical folder tree.
-- ============================================================

CREATE TABLE regulatory_binders (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  study_id   uuid        REFERENCES studies(id) ON DELETE CASCADE,
  site_id    uuid        REFERENCES sites(id) ON DELETE CASCADE,
  status     text        NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_regulatory_binders_status CHECK (status IN ('active', 'archived')),
  CONSTRAINT chk_regulatory_binders_scope CHECK (study_id IS NOT NULL OR site_id IS NOT NULL)
);

CREATE UNIQUE INDEX uq_regulatory_binders_scope ON regulatory_binders (
  company_id,
  COALESCE(study_id, '00000000-0000-0000-0000-000000000000'),
  COALESCE(site_id, '00000000-0000-0000-0000-000000000000')
);
CREATE INDEX idx_regulatory_binders_company ON regulatory_binders(company_id);
CREATE INDEX idx_regulatory_binders_study   ON regulatory_binders(study_id);
CREATE INDEX idx_regulatory_binders_site    ON regulatory_binders(site_id);

ALTER TABLE regulatory_binders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "regulatory_binders_select" ON regulatory_binders
  FOR SELECT USING (
    company_id = current_company_id()
    AND has_permission('view_regulatory')
    AND (site_id IS NULL OR can_access_site(site_id))
  );

CREATE POLICY "regulatory_binders_insert" ON regulatory_binders
  FOR INSERT WITH CHECK (
    company_id = current_company_id()
    AND has_permission('upload_regulatory_document')
    AND (site_id IS NULL OR can_access_site(site_id))
  );

CREATE POLICY "regulatory_binders_update" ON regulatory_binders
  FOR UPDATE USING (
    company_id = current_company_id()
    AND has_permission('archive_regulatory_document')
    AND (site_id IS NULL OR can_access_site(site_id))
  )
  WITH CHECK (
    company_id = current_company_id()
    AND has_permission('archive_regulatory_document')
    AND (site_id IS NULL OR can_access_site(site_id))
  );

-- ============================================================
-- REGULATORY_DOCUMENTS  (FK -> companies, sites, studies, document_types, files)
-- One stable "slot" per (document_type, scope) — persists across every
-- replacement. Denormalized current-version columns (file_id, version,
-- effective_date, expiration_date, status) mirror document_versions' current
-- row for fast binder-view queries without a join; document_versions is the
-- single source of truth and the only place a file lineage is recorded.
-- ============================================================

CREATE TABLE regulatory_documents (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  site_id           uuid        REFERENCES sites(id) ON DELETE CASCADE,
  study_id          uuid        REFERENCES studies(id) ON DELETE CASCADE,
  document_type_id  uuid        NOT NULL REFERENCES document_types(id) ON DELETE RESTRICT,
  file_id           uuid        REFERENCES files(id) ON DELETE RESTRICT,
  document_name     text        NOT NULL,
  version           text,
  effective_date    date,
  expiration_date   date,
  status            text        NOT NULL DEFAULT 'missing',
  uploaded_by       uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_regulatory_documents_status CHECK (
    status IN ('missing', 'draft', 'pending_review', 'current', 'expiring_soon', 'expired', 'rejected', 'archived')
  )
);

CREATE UNIQUE INDEX uq_regulatory_documents_slot ON regulatory_documents (
  company_id,
  document_type_id,
  COALESCE(study_id, '00000000-0000-0000-0000-000000000000'),
  COALESCE(site_id, '00000000-0000-0000-0000-000000000000')
);
CREATE INDEX idx_regulatory_documents_company ON regulatory_documents(company_id);
CREATE INDEX idx_regulatory_documents_study   ON regulatory_documents(study_id);
CREATE INDEX idx_regulatory_documents_site    ON regulatory_documents(site_id);
CREATE INDEX idx_regulatory_documents_expiry  ON regulatory_documents(status, expiration_date);

CREATE TRIGGER regulatory_documents_updated_at
  BEFORE UPDATE ON regulatory_documents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE regulatory_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "regulatory_documents_select" ON regulatory_documents
  FOR SELECT USING (
    company_id = current_company_id()
    AND has_permission('view_regulatory')
    AND (site_id IS NULL OR can_access_site(site_id))
  );

CREATE POLICY "regulatory_documents_insert" ON regulatory_documents
  FOR INSERT WITH CHECK (
    company_id = current_company_id()
    AND has_permission('upload_regulatory_document')
    AND (site_id IS NULL OR can_access_site(site_id))
  );

-- UPDATE covers: status transitions driven by review/archive/override actions,
-- and the denormalized-column sync performed on replace. All three actions
-- share one policy because the actual legality of a given transition is
-- enforced in the service layer's state machine (RLS's job here is tenant/
-- site isolation + "does this user hold ANY of the regulatory permissions",
-- not the transition graph itself — consistent with how visit status
-- transitions are enforced in VisitService, not in RLS).
CREATE POLICY "regulatory_documents_update" ON regulatory_documents
  FOR UPDATE USING (
    company_id = current_company_id()
    AND (
      has_permission('upload_regulatory_document')
      OR has_permission('edit_regulatory_document')
      OR has_permission('archive_regulatory_document')
      OR has_permission('override_regulatory_status')
    )
    AND (site_id IS NULL OR can_access_site(site_id))
  )
  WITH CHECK (
    company_id = current_company_id()
    AND (
      has_permission('upload_regulatory_document')
      OR has_permission('edit_regulatory_document')
      OR has_permission('archive_regulatory_document')
      OR has_permission('override_regulatory_status')
    )
    AND (site_id IS NULL OR can_access_site(site_id))
  );

-- ============================================================
-- STAFF_DOCUMENTS  (FK -> companies, profiles, sites, document_types, files)
-- Staff-level credentials (CV, GCP training, medical license). Keyed by
-- (user_id, document_type_id, site_id) so a credential uploaded once is
-- visible in every study binder that user is assigned to via study_staff —
-- joined at query time, never copied per-study. Declared before
-- document_versions/document_history since both reference it.
-- ============================================================

CREATE TABLE staff_documents (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  user_id          uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  site_id          uuid        REFERENCES sites(id) ON DELETE CASCADE,
  document_type_id uuid        NOT NULL REFERENCES document_types(id) ON DELETE RESTRICT,
  file_id          uuid        REFERENCES files(id) ON DELETE RESTRICT,
  version          text,
  effective_date   date,
  expiration_date  date,
  status           text        NOT NULL DEFAULT 'missing',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_staff_documents_status CHECK (
    status IN ('missing', 'draft', 'pending_review', 'current', 'expiring_soon', 'expired', 'rejected', 'archived')
  )
);

CREATE UNIQUE INDEX uq_staff_documents_slot ON staff_documents (
  company_id,
  user_id,
  document_type_id,
  COALESCE(site_id, '00000000-0000-0000-0000-000000000000')
);
CREATE INDEX idx_staff_documents_company ON staff_documents(company_id);
CREATE INDEX idx_staff_documents_user    ON staff_documents(user_id);
CREATE INDEX idx_staff_documents_expiry  ON staff_documents(status, expiration_date);

CREATE TRIGGER staff_documents_updated_at
  BEFORE UPDATE ON staff_documents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE staff_documents ENABLE ROW LEVEL SECURITY;

-- A user may always view their own credentials (visibility into their own
-- compliance status) in addition to anyone holding view_staff_credentials.
CREATE POLICY "staff_documents_select" ON staff_documents
  FOR SELECT USING (
    company_id = current_company_id()
    AND (user_id = auth.uid() OR has_permission('view_staff_credentials'))
  );

CREATE POLICY "staff_documents_insert" ON staff_documents
  FOR INSERT WITH CHECK (
    company_id = current_company_id()
    AND has_permission('manage_staff_credentials')
  );

CREATE POLICY "staff_documents_update" ON staff_documents
  FOR UPDATE USING (
    company_id = current_company_id()
    AND has_permission('manage_staff_credentials')
  )
  WITH CHECK (
    company_id = current_company_id()
    AND has_permission('manage_staff_credentials')
  );

-- ============================================================
-- DOCUMENT_VERSIONS  (FK -> companies, regulatory_documents OR staff_documents, files, profiles)
-- Append-only file lineage, shared by both regulatory_documents and
-- staff_documents (exactly one of document_id/staff_document_id is set per
-- row). Immutability is enforced at the database level: once a row's status
-- leaves ('pending_review', 'approved'), the UPDATE policy's USING clause
-- makes it permanently unmodifiable by anyone, regardless of permission —
-- this is the concrete mechanism behind "superseded versions must remain
-- read-only."
-- ============================================================

CREATE TABLE document_versions (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              uuid        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  document_id             uuid        REFERENCES regulatory_documents(id) ON DELETE CASCADE,
  staff_document_id       uuid        REFERENCES staff_documents(id) ON DELETE CASCADE,
  previous_version_id     uuid        REFERENCES document_versions(id) ON DELETE SET NULL,
  version                 text        NOT NULL,
  file_id                 uuid        NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  checksum                text        NOT NULL,
  is_current               boolean    NOT NULL DEFAULT false,
  status                   text       NOT NULL DEFAULT 'pending_review',
  effective_date           date,
  expiration_date          date,
  replacement_reason       text,
  duplicate_of_version_id  uuid       REFERENCES document_versions(id) ON DELETE SET NULL,
  uploaded_by              uuid       NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  uploaded_at              timestamptz NOT NULL DEFAULT now(),
  reviewed_by              uuid       REFERENCES profiles(id) ON DELETE SET NULL,
  reviewed_at              timestamptz,
  CONSTRAINT chk_document_versions_status CHECK (
    status IN ('pending_review', 'approved', 'rejected', 'superseded', 'archived')
  ),
  CONSTRAINT chk_document_versions_replacement_reason CHECK (
    previous_version_id IS NULL OR replacement_reason IS NOT NULL
  ),
  CONSTRAINT chk_document_versions_target CHECK (
    (document_id IS NOT NULL AND staff_document_id IS NULL)
    OR (document_id IS NULL AND staff_document_id IS NOT NULL)
  )
);

-- Only one version per document (or staff credential) may be current at a
-- time — enforced by the database, not application logic.
CREATE UNIQUE INDEX uq_document_versions_current ON document_versions (document_id) WHERE (is_current AND document_id IS NOT NULL);
CREATE UNIQUE INDEX uq_staff_document_versions_current ON document_versions (staff_document_id) WHERE (is_current AND staff_document_id IS NOT NULL);

CREATE INDEX idx_document_versions_document       ON document_versions(document_id);
CREATE INDEX idx_document_versions_staff_document ON document_versions(staff_document_id);
CREATE INDEX idx_document_versions_company        ON document_versions(company_id);
CREATE INDEX idx_document_versions_checksum        ON document_versions(document_id, checksum);

ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "document_versions_select" ON document_versions
  FOR SELECT USING (
    company_id = current_company_id()
    AND (has_permission('view_regulatory') OR has_permission('view_staff_credentials'))
  );

CREATE POLICY "document_versions_insert" ON document_versions
  FOR INSERT WITH CHECK (
    company_id = current_company_id()
    AND (
      (document_id IS NOT NULL AND has_permission('upload_regulatory_document'))
      OR (staff_document_id IS NOT NULL AND has_permission('manage_staff_credentials'))
    )
  );

-- The immutability guarantee: a row can only be updated while its status is
-- still 'pending_review' (review decision, or is_current flip on first
-- approval) or 'approved' (the single narrow mutation of flipping
-- is_current -> false / status -> 'superseded' when replaced, or -> 'archived'
-- when the slot is archived). Once a row reaches 'rejected', 'superseded', or
-- 'archived' it satisfies no USING clause ever again and cannot be updated,
-- full stop — not even by an Administrator.
CREATE POLICY "document_versions_update" ON document_versions
  FOR UPDATE USING (
    company_id = current_company_id()
    AND status IN ('pending_review', 'approved')
    AND (
      has_permission('edit_regulatory_document')
      OR has_permission('archive_regulatory_document')
      OR has_permission('override_regulatory_status')
      OR has_permission('manage_staff_credentials')
    )
  )
  WITH CHECK (
    company_id = current_company_id()
  );

-- Deliberately no DELETE policy — document_versions rows are permanent.

-- ============================================================
-- DOCUMENT_HISTORY  (FK -> companies, regulatory_documents OR staff_documents, document_versions, profiles)
-- Append-only status-transition ledger — distinct from document_versions
-- (file lineage) and from audit_logs (cross-cutting compliance log). Every
-- transition writes exactly one row here.
-- ============================================================

CREATE TABLE document_history (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid        NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  document_id       uuid        REFERENCES regulatory_documents(id) ON DELETE CASCADE,
  staff_document_id uuid        REFERENCES staff_documents(id) ON DELETE CASCADE,
  version_id        uuid        REFERENCES document_versions(id) ON DELETE SET NULL,
  old_status        text,
  new_status        text        NOT NULL,
  changed_by        uuid        REFERENCES profiles(id) ON DELETE SET NULL,
  changed_at        timestamptz NOT NULL DEFAULT now(),
  reason            text,
  CONSTRAINT chk_document_history_target CHECK (
    (document_id IS NOT NULL AND staff_document_id IS NULL)
    OR (document_id IS NULL AND staff_document_id IS NOT NULL)
  )
);

CREATE INDEX idx_document_history_document       ON document_history(document_id);
CREATE INDEX idx_document_history_staff_document ON document_history(staff_document_id);
CREATE INDEX idx_document_history_company        ON document_history(company_id);

ALTER TABLE document_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "document_history_select" ON document_history
  FOR SELECT USING (
    company_id = current_company_id()
    AND has_permission('view_regulatory_audit')
  );

CREATE POLICY "document_history_insert" ON document_history
  FOR INSERT WITH CHECK (
    company_id = current_company_id()
    AND (
      has_permission('upload_regulatory_document')
      OR has_permission('edit_regulatory_document')
      OR has_permission('archive_regulatory_document')
      OR has_permission('override_regulatory_status')
      OR has_permission('manage_staff_credentials')
    )
  );

-- No UPDATE or DELETE policy — history rows are permanent, same as audit_logs.

-- ============================================================
-- STORAGE BUCKET — regulatory
-- Private, signed-URL-only, same pattern as the existing `protocols` bucket.
-- Key convention: {company_id}/{study_id|site_id|staff/{user_id}}/{document_type_id}/{version_id}_{filename}
-- The version_id path segment (generated before upload) guarantees a unique
-- storage key per version — not reliant on timestamp granularity.
-- ============================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('regulatory', 'regulatory', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "regulatory_bucket_insert_own_company" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'regulatory'
    AND (storage.foldername(name))[1] = current_company_id()::text
  );

CREATE POLICY "regulatory_bucket_select_own_company" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'regulatory'
    AND (storage.foldername(name))[1] = current_company_id()::text
  );

-- ============================================================
-- PERMISSIONS — regulatory module (5 new; the 4 existing
-- view_regulatory/upload_regulatory_document/edit_regulatory_document/
-- archive_regulatory_document keys are reused unchanged — edit_regulatory_document
-- doubles as the review/approve/reject permission, no separate permission
-- added for that).
-- override_regulatory_status is intentionally excluded from every default
-- role grant below (including Administrator) — same "conscious per-role
-- override" treatment as force_archive_study/force_archive_site/reopen_visit.
-- ============================================================

INSERT INTO permissions (key, module, description)
VALUES
  ('manage_regulatory_requirements', 'regulatory', 'Configure which document types are required, at company/site/study scope'),
  ('view_staff_credentials',         'regulatory', 'View staff regulatory credentials (CV, GCP training, licenses)'),
  ('manage_staff_credentials',       'regulatory', 'Upload and replace staff regulatory credentials'),
  ('view_regulatory_audit',          'regulatory', 'View regulatory document version and status history'),
  ('override_regulatory_status',     'regulatory', 'Manually override a regulatory document''s status, bypassing normal review')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- BACKFILL — grant the new permissions to every EXISTING company's
-- Administrator and Regulatory roles, matching what CompanyService.provision()
-- now grants to newly provisioned companies (see CompanyService.ts changes in
-- this same sprint). override_regulatory_status is granted to neither by
-- default — an Administrator must explicitly enable it per Settings > Roles,
-- same mechanism already used for reopen_visit.
-- ============================================================

INSERT INTO role_permissions (company_id, role_id, permission_id, allowed)
SELECT r.company_id, r.id, p.id, true
FROM roles r
CROSS JOIN permissions p
WHERE r.key IN ('admin', 'regulatory')
  AND p.key IN (
    'manage_regulatory_requirements', 'view_staff_credentials',
    'manage_staff_credentials', 'view_regulatory_audit'
  )
ON CONFLICT (company_id, role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (company_id, role_id, permission_id, allowed)
SELECT r.company_id, r.id, p.id, true
FROM roles r
CROSS JOIN permissions p
WHERE r.key IN ('crc', 'pi')
  AND p.key = 'view_staff_credentials'
ON CONFLICT (company_id, role_id, permission_id) DO NOTHING;

-- ============================================================
-- SCHEDULED EXPIRATION CHECKS — pg_cron + pg_net
--
-- IMPORTANT — before these jobs can run, an operator must provision two
-- secrets into Supabase Vault via the SQL editor (NOT via this migration,
-- and NEVER committed to the repository):
--
--   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1', 'edge_function_base_url');
--   select vault.create_secret('<service-role-key>', 'edge_function_service_key');
--
-- Until those secrets exist, the cron jobs below will fire on schedule but
-- their net.http_post calls will fail (no matching vault row) — the checker
-- functions can still be invoked manually/by the app for testing.
--
-- This migration also resolves the same, pre-existing scheduling gap for
-- visit-status-checker (Sprint 4), which shipped without ever being wired to
-- a scheduler.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

SELECT cron.schedule(
  'regulatory-expiration-checker-daily',
  '30 2 * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'edge_function_base_url') || '/regulatory-expiration-checker',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'edge_function_service_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

SELECT cron.schedule(
  'visit-status-checker-daily',
  '35 2 * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'edge_function_base_url') || '/visit-status-checker',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'edge_function_service_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ============================================================
-- ROLLBACK
-- SELECT cron.unschedule('visit-status-checker-daily');
-- SELECT cron.unschedule('regulatory-expiration-checker-daily');
-- DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE key IN ('manage_regulatory_requirements', 'view_staff_credentials', 'manage_staff_credentials', 'view_regulatory_audit', 'override_regulatory_status'));
-- DELETE FROM permissions WHERE key IN ('manage_regulatory_requirements', 'view_staff_credentials', 'manage_staff_credentials', 'view_regulatory_audit', 'override_regulatory_status');
-- DROP POLICY IF EXISTS "regulatory_bucket_select_own_company" ON storage.objects;
-- DROP POLICY IF EXISTS "regulatory_bucket_insert_own_company" ON storage.objects;
-- DELETE FROM storage.buckets WHERE id = 'regulatory';
-- DROP POLICY IF EXISTS "document_history_insert" ON document_history;
-- DROP POLICY IF EXISTS "document_history_select" ON document_history;
-- DROP TABLE IF EXISTS document_history CASCADE;
-- DROP POLICY IF EXISTS "document_versions_update" ON document_versions;
-- DROP POLICY IF EXISTS "document_versions_insert" ON document_versions;
-- DROP POLICY IF EXISTS "document_versions_select" ON document_versions;
-- DROP TABLE IF EXISTS document_versions CASCADE;
-- DROP POLICY IF EXISTS "staff_documents_update" ON staff_documents;
-- DROP POLICY IF EXISTS "staff_documents_insert" ON staff_documents;
-- DROP POLICY IF EXISTS "staff_documents_select" ON staff_documents;
-- DROP TABLE IF EXISTS staff_documents CASCADE;
-- DROP POLICY IF EXISTS "regulatory_documents_update" ON regulatory_documents;
-- DROP POLICY IF EXISTS "regulatory_documents_insert" ON regulatory_documents;
-- DROP POLICY IF EXISTS "regulatory_documents_select" ON regulatory_documents;
-- DROP TABLE IF EXISTS regulatory_documents CASCADE;
-- DROP POLICY IF EXISTS "regulatory_binders_update" ON regulatory_binders;
-- DROP POLICY IF EXISTS "regulatory_binders_insert" ON regulatory_binders;
-- DROP POLICY IF EXISTS "regulatory_binders_select" ON regulatory_binders;
-- DROP TABLE IF EXISTS regulatory_binders CASCADE;
-- DROP POLICY IF EXISTS "files_insert_regulatory" ON files;
-- DROP POLICY IF EXISTS "study_document_requirements_update" ON study_document_requirements;
-- DROP POLICY IF EXISTS "study_document_requirements_insert" ON study_document_requirements;
-- CREATE POLICY "study_document_requirements_insert" ON study_document_requirements FOR INSERT WITH CHECK (company_id = current_company_id() AND has_permission('manage_studies'));
-- DROP INDEX IF EXISTS uq_study_document_requirements;
-- ALTER TABLE study_document_requirements DROP COLUMN IF EXISTS site_id;
-- ALTER TABLE study_document_requirements ALTER COLUMN study_id SET NOT NULL;
-- CREATE UNIQUE INDEX uq_study_document_requirements... (original definition, study_id/document_type_id only)
-- ALTER TABLE document_types DROP COLUMN IF EXISTS requires_version, DROP COLUMN IF EXISTS default_alert_days, DROP COLUMN IF EXISTS expiration_rule, DROP COLUMN IF EXISTS has_expiration;
-- ============================================================
