-- ============================================================
-- bootstrap_admin.sql
--
-- One-time bootstrap script for a FRESH Zentariq One database.
-- Run manually (e.g. `psql ... -f supabase/bootstrap_admin.sql`)
-- AFTER migrations 001_companies_sites_users.sql and
-- 002_roles_permissions.sql have been applied.
--
-- Creates:
--   1. The first company
--   2. The default system roles (admin, ceo, crc, data_entry,
--      regulatory, pi) per docs/DATABASE_Part_01_Core_SaaS_Users_Roles_Sites.md
--   2b. Every permission granted to the Administrator role
--   3. The administrator auth user + profile
--   4. The Administrator role assignment
--
-- Requires supabase/seed/002_permissions.sql to have been applied first
-- (so the Administrator role has permission rows to grant in step 2b).
--
-- Idempotent: safe to run more than once — every step is a
-- lookup-or-create, so re-running against an already-bootstrapped
-- database is a no-op.
--
-- SECURITY: override the defaults below via psql -v flags, e.g.:
--   psql "$DATABASE_URL" \
--     -v admin_email="'you@company.com'" \
--     -v admin_password="'a-strong-password'" \
--     -f supabase/bootstrap_admin.sql
-- The default password below is a placeholder — change it immediately
-- after first login if you run this script with the defaults.
-- ============================================================

\set company_name 'Zentariq Systems'
\set admin_email 'admin@zentariqsystems.local'
\set admin_password 'ChangeMe123!'
\set admin_full_name 'System Administrator'

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
DECLARE
  v_company_name    text := :'company_name';
  v_admin_email     text := :'admin_email';
  v_admin_password  text := :'admin_password';
  v_admin_full_name text := :'admin_full_name';

  v_company_id    uuid;
  v_admin_user_id uuid;
  v_admin_role_id uuid;
BEGIN

  -- ------------------------------------------------------------
  -- 1. First company
  -- ------------------------------------------------------------
  SELECT id INTO v_company_id
  FROM companies
  WHERE name = v_company_name;

  IF v_company_id IS NULL THEN
    INSERT INTO companies (name, legal_name, status)
    VALUES (v_company_name, v_company_name, 'active')
    RETURNING id INTO v_company_id;
  END IF;

  -- ------------------------------------------------------------
  -- 2. Default system roles
  -- ------------------------------------------------------------
  INSERT INTO roles (company_id, name, key, description, is_system_role)
  VALUES
    (v_company_id, 'Administrator',                 'admin',      'Full system access',                          true),
    (v_company_id, 'CEO',                            'ceo',        'Executive oversight and reporting',           true),
    (v_company_id, 'Clinical Research Coordinator',  'crc',        'Day-to-day site and subject operations',      true),
    (v_company_id, 'Data Entry',                     'data_entry', 'Data entry and chart processing',             true),
    (v_company_id, 'Regulatory',                     'regulatory', 'eRegulatory and document management',        true),
    (v_company_id, 'Principal Investigator',         'pi',         'Study oversight and subject approval',        true)
  ON CONFLICT (company_id, key) DO NOTHING;

  SELECT id INTO v_admin_role_id
  FROM roles
  WHERE company_id = v_company_id AND key = 'admin';

  -- ------------------------------------------------------------
  -- 2b. Administrator role — grant every permission except the ones that
  -- must be deliberately elevated (force_archive_study / force_archive_site /
  -- reopen_visit are conscious, per-role overrides a company owner grants via
  -- Settings > Roles — it would defeat the purpose of those safeguards if
  -- every admin got them free). view_subject_phi / edit_subject_phi ARE part
  -- of the Administrator default (product decision) — other roles still
  -- require a conscious per-role grant via the same Settings > Roles override
  -- mechanism.
  -- Mirrors CompanyService.provision()'s adminPerms (all permission keys
  -- minus the same exclusion list).
  -- Without this step, a fresh admin role has zero role_permissions rows
  -- and therefore zero permissions — not just missing site access.
  -- Requires supabase/seed/002_permissions.sql to have been applied first.
  -- ------------------------------------------------------------
  INSERT INTO role_permissions (company_id, role_id, permission_id, allowed)
  SELECT v_company_id, v_admin_role_id, p.id, true
  FROM permissions p
  WHERE p.key NOT IN ('force_archive_study', 'force_archive_site', 'reopen_visit')
  ON CONFLICT (company_id, role_id, permission_id) DO NOTHING;

  -- ------------------------------------------------------------
  -- 3. Administrator auth user + profile
  -- ------------------------------------------------------------
  SELECT id INTO v_admin_user_id
  FROM auth.users
  WHERE email = v_admin_email;

  IF v_admin_user_id IS NULL THEN
    v_admin_user_id := gen_random_uuid();

    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at, confirmation_token, recovery_token
    ) VALUES (
      '00000000-0000-0000-0000-000000000000',
      v_admin_user_id,
      'authenticated',
      'authenticated',
      v_admin_email,
      crypt(v_admin_password, gen_salt('bf')),
      now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{}'::jsonb,
      now(),
      now(),
      '',
      ''
    );

    INSERT INTO auth.identities (
      id, user_id, provider_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at
    ) VALUES (
      gen_random_uuid(),
      v_admin_user_id,
      v_admin_user_id::text,
      jsonb_build_object('sub', v_admin_user_id::text, 'email', v_admin_email),
      'email',
      now(),
      now(),
      now()
    );
  END IF;

  INSERT INTO profiles (id, company_id, full_name, email, status)
  VALUES (v_admin_user_id, v_company_id, v_admin_full_name, v_admin_email, 'active')
  ON CONFLICT (id) DO NOTHING;

  -- ------------------------------------------------------------
  -- 4. Administrator role assignment
  -- ------------------------------------------------------------
  INSERT INTO user_roles (company_id, user_id, role_id)
  VALUES (v_company_id, v_admin_user_id, v_admin_role_id)
  ON CONFLICT (user_id, role_id) DO NOTHING;

END $$;
