-- Migration: 019_grant_recruitment_crm_default_permissions.sql
-- Description: Backfills the 7 recruitment CRM permissions introduced in
--   migration 018 onto every EXISTING company's Administrator and CRC roles,
--   matching the defaults CompanyService.provision() now grants to any newly
--   provisioned company:
--     - Administrator: 6 of the 7 (archive_lead, assign_lead, view_lead_notes,
--       create_lead_note, log_lead_call, manage_lead_tasks) — everything
--       except override_do_not_contact, which follows the same "sensitive
--       override requires a conscious per-role grant" precedent as
--       force_archive_study/force_archive_site/reopen_visit/
--       override_regulatory_status (none of which are in the Administrator
--       default either).
--     - CRC: assign_lead, view_lead_notes, create_lead_note, log_lead_call,
--       manage_lead_tasks — day-to-day lead-lifecycle operations, same
--       reasoning as its existing create_lead/edit_lead/convert_lead grant.
--       NOT archive_lead (no archive_* permission is in CRC's default set
--       anywhere else either) and NOT override_do_not_contact.
--   Code changes alone (migration 018, CompanyService.ts) only affect newly
--   provisioned companies; role_permissions is data that must be backfilled
--   separately for companies that already exist.
--
-- Depends on: 002_roles_permissions.sql (roles, permissions, role_permissions),
--   018_recruitment_crm_foundation.sql (the 7 permission rows this migration grants)
-- Rollback: see ROLLBACK section at the bottom — safe to re-run in either
--   direction; the INSERTs only ever add rows keyed on
--   (company_id, role_id, permission_id) that don't already exist.

INSERT INTO role_permissions (company_id, role_id, permission_id, allowed)
SELECT r.company_id, r.id, p.id, true
FROM roles r
CROSS JOIN permissions p
WHERE r.key = 'admin'
  AND p.key IN (
    'archive_lead', 'assign_lead', 'view_lead_notes',
    'create_lead_note', 'log_lead_call', 'manage_lead_tasks'
  )
ON CONFLICT (company_id, role_id, permission_id) DO NOTHING;

INSERT INTO role_permissions (company_id, role_id, permission_id, allowed)
SELECT r.company_id, r.id, p.id, true
FROM roles r
CROSS JOIN permissions p
WHERE r.key = 'crc'
  AND p.key IN (
    'assign_lead', 'view_lead_notes', 'create_lead_note',
    'log_lead_call', 'manage_lead_tasks'
  )
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
--       'archive_lead', 'assign_lead', 'view_lead_notes',
--       'create_lead_note', 'log_lead_call', 'manage_lead_tasks'
--     )
--   );
-- ============================================================
