-- Migration: 021_grant_recruitment_experience_default_permissions.sql
-- Description: Backfills the 4 recruitment operational-experience
--   permissions introduced in migration 020 onto every EXISTING company's
--   Administrator and CRC roles, matching the defaults
--   CompanyService.provision() now grants to any newly provisioned company:
--     - Administrator: view_recruitment_dashboard, dismiss_recruitment_duplicates,
--       bulk_manage_recruitment_leads — NOT reopen_recruitment_tasks, which
--       follows the same "sensitive reopen requires a conscious per-role
--       grant" precedent as reopen_visit (also excluded from the
--       Administrator default).
--     - CRC: view_recruitment_dashboard, dismiss_recruitment_duplicates —
--       day-to-day operational grants. NOT bulk_manage_recruitment_leads
--       (a cross-lead supervisory-scale action — no bulk/archive-class
--       permission is in CRC's default set anywhere else either) and NOT
--       reopen_recruitment_tasks.
--
-- Depends on: 002_roles_permissions.sql (roles, permissions, role_permissions),
--   020_recruitment_operational_experience.sql (the 4 permission rows this
--   migration grants)
-- Rollback: see ROLLBACK section at the bottom — safe to re-run in either
--   direction; the INSERTs only ever add rows keyed on
--   (company_id, role_id, permission_id) that don't already exist.

INSERT INTO role_permissions (company_id, role_id, permission_id, allowed)
SELECT r.company_id, r.id, p.id, true
FROM roles r
CROSS JOIN permissions p
WHERE r.key = 'admin'
  AND p.key IN (
    'view_recruitment_dashboard', 'dismiss_recruitment_duplicates', 'bulk_manage_recruitment_leads'
  )
ON CONFLICT (company_id, role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (company_id, role_id, permission_id, allowed)
SELECT r.company_id, r.id, p.id, true
FROM roles r
CROSS JOIN permissions p
WHERE r.key = 'crc'
  AND p.key IN ('view_recruitment_dashboard', 'dismiss_recruitment_duplicates')
ON CONFLICT (company_id, role_id, permission_id) DO NOTHING;

-- ============================================================
-- ROLLBACK
-- Only removes rows for the 'admin'/'crc' role keys — never touches any
-- other role's (e.g. a company-granted Regulatory or PI) recruitment grants.
--
-- DELETE FROM role_permissions
-- WHERE role_id IN (SELECT id FROM roles WHERE key IN ('admin', 'crc'))
--   AND permission_id IN (
--     SELECT id FROM permissions WHERE key IN (
--       'view_recruitment_dashboard', 'dismiss_recruitment_duplicates', 'bulk_manage_recruitment_leads'
--     )
--   );
-- ============================================================
