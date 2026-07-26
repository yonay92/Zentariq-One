-- Migration: 017_document_type_management_policies.sql
-- Description: document_types (migration 003) was deliberately read-only for
--   authenticated users — "seeded by migration/service-role only... until
--   Sprint 6 builds a management UI." Migration 016 built that UI
--   (DocumentTypeService.create/update, the Document Requirement Builder
--   panel) but missed adding the INSERT/UPDATE policies it needs — the
--   service uses the normal RLS-scoped server client, not the admin client,
--   so without these policies every create/update is rejected by RLS. Found
--   via e2e test failure (POST /api/regulatory/document-types: "new row
--   violates row-level security policy for table document_types").
--
-- Depends on: 003_studies_visit_templates.sql (document_types),
--   016_regulatory_documents.sql (manage_regulatory_requirements permission)
-- Rollback: see ROLLBACK section at the bottom

CREATE POLICY "document_types_insert" ON document_types
  FOR INSERT WITH CHECK (
    company_id = current_company_id()
    AND has_permission('manage_regulatory_requirements')
  );

CREATE POLICY "document_types_update" ON document_types
  FOR UPDATE USING (
    company_id = current_company_id()
    AND has_permission('manage_regulatory_requirements')
  )
  WITH CHECK (
    company_id = current_company_id()
    AND has_permission('manage_regulatory_requirements')
  );

-- ============================================================
-- ROLLBACK
-- DROP POLICY IF EXISTS "document_types_update" ON document_types;
-- DROP POLICY IF EXISTS "document_types_insert" ON document_types;
-- ============================================================
