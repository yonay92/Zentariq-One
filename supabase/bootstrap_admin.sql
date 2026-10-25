-- ============================================================
-- bootstrap_admin.sql
--
-- One-time bootstrap of the FIRST tenant on a FRESH Zentariq One database.
-- Run AFTER every migration in supabase/migrations/ and AFTER
-- supabase/seed/002_permissions.sql (the Administrator grants in step 3
-- need the permission catalog).
--
-- Creates (each step is lookup-or-create, so re-running with the SAME
-- inputs is a no-op):
--   1. The first company
--   2. The default system roles (admin, ceo, crc, data_entry,
--      regulatory, pi) per docs/DATABASE_Part_01_Core_SaaS_Users_Roles_Sites.md
--   3. Every permission granted to the Administrator role, except the
--      deliberate per-role overrides (see c_admin_excluded below)
--   4. The administrator profile, linked to an EXISTING Supabase Auth user
--   5. The Administrator role assignment
--   6. One audit_logs entry recording the bootstrap
--
-- SECURITY — this script never creates Auth users and never handles
-- passwords. Create the administrator FIRST through the Supabase Auth
-- Admin API (Dashboard > Authentication > Users > Add user > Create new
-- user, with "Auto Confirm User"), so the password is hashed by Supabase
-- Auth and never appears in SQL text, pg_stat_statements or database logs.
--
-- INPUTS — non-secret only, read from session settings that the caller
-- sets in the SAME session immediately before this script:
--   zentariq.bootstrap_company_name
--   zentariq.bootstrap_admin_email
--   zentariq.bootstrap_admin_full_name
-- There are no defaults. If any setting is missing or blank (for example
-- because the client did not run the set_config statements in the same
-- session), the script aborts before writing anything.
--
-- USAGE (psql over a SESSION-mode connection — never a transaction-mode
-- pooler, which does not keep session settings between statements):
--   psql "<connection>" -v ON_ERROR_STOP=1 \
--     -c "SELECT set_config('zentariq.bootstrap_company_name', 'Acme Research', false)" \
--     -c "SELECT set_config('zentariq.bootstrap_admin_email', 'admin@example.com', false)" \
--     -c "SELECT set_config('zentariq.bootstrap_admin_full_name', 'Jane Admin', false)" \
--     -f supabase/bootstrap_admin.sql
-- With any other client, send the three set_config statements followed by
-- this file as ONE request in ONE session.
-- Non-ASCII names can be passed as Unicode escape literals, which keeps the
-- transport pure ASCII, e.g. U&'Zentariq Systems \2014 Demo' (U+2014 EM DASH).
--
-- GUARDS — each aborts the whole script with no changes (the DO block is a
-- single atomic statement):
--   * an input is missing, blank, has leading/trailing whitespace, contains
--     control characters or is not NFC-normalized; or the email is malformed
--   * there is not exactly one confirmed, active Auth user with that email
--   * any company other than the requested one already exists
--     (fresh-database guard: never bootstrap into an unrelated tenant)
--   * more than one company already has the requested name
--   * the Auth user already has a profile in a different company, or another
--     profile in the requested company already uses the email
-- ============================================================

DO $$
DECLARE
  -- Must match CompanyService.provision()'s ADMIN_EXCLUDED_PERMISSIONS:
  -- deliberate, per-role overrides a company owner grants via
  -- Settings > Roles. view_subject_phi / edit_subject_phi ARE part of the
  -- Administrator default (product decision).
  c_admin_excluded constant text[] := ARRAY[
    'force_archive_study',
    'force_archive_site',
    'reopen_visit',
    'override_regulatory_status',
    'override_do_not_contact',
    'reopen_recruitment_tasks',
    'reopen_chart'
  ];

  v_company_name    text := current_setting('zentariq.bootstrap_company_name', true);
  v_admin_email     text := current_setting('zentariq.bootstrap_admin_email', true);
  v_admin_full_name text := current_setting('zentariq.bootstrap_admin_full_name', true);

  v_company_id         uuid;
  v_admin_user_id      uuid;
  v_admin_role_id      uuid;
  v_profile_company_id uuid;
  v_match_count        integer;
  v_role_count         integer;
  v_grant_count        integer;
BEGIN
  -- Serialize concurrent runs; released automatically at transaction end.
  PERFORM pg_advisory_xact_lock(hashtext('zentariq.bootstrap_admin'));

  -- ------------------------------------------------------------
  -- 0. Validate inputs
  -- ------------------------------------------------------------
  IF v_company_name IS NULL OR btrim(v_company_name) = '' THEN
    RAISE EXCEPTION 'bootstrap_admin: setting zentariq.bootstrap_company_name is missing or blank';
  END IF;
  IF v_admin_email IS NULL OR btrim(v_admin_email) = '' THEN
    RAISE EXCEPTION 'bootstrap_admin: setting zentariq.bootstrap_admin_email is missing or blank';
  END IF;
  IF v_admin_full_name IS NULL OR btrim(v_admin_full_name) = '' THEN
    RAISE EXCEPTION 'bootstrap_admin: setting zentariq.bootstrap_admin_full_name is missing or blank';
  END IF;

  IF v_company_name <> btrim(v_company_name)
     OR v_admin_email <> btrim(v_admin_email)
     OR v_admin_full_name <> btrim(v_admin_full_name) THEN
    RAISE EXCEPTION 'bootstrap_admin: inputs must not have leading or trailing whitespace';
  END IF;

  IF v_company_name ~ '[[:cntrl:]]' OR v_admin_full_name ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'bootstrap_admin: company name and full name must not contain control characters';
  END IF;

  IF v_company_name IS NOT NFC NORMALIZED OR v_admin_full_name IS NOT NFC NORMALIZED THEN
    RAISE EXCEPTION 'bootstrap_admin: company name and full name must be NFC-normalized Unicode';
  END IF;

  v_admin_email := lower(v_admin_email);
  IF v_admin_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'bootstrap_admin: admin email % is not a valid address', v_admin_email;
  END IF;

  -- ------------------------------------------------------------
  -- 1. Existing, confirmed Supabase Auth user (created via the Auth
  --    Admin API — this script never writes to the auth schema)
  -- ------------------------------------------------------------
  SELECT count(*) INTO v_match_count
  FROM auth.users u
  WHERE lower(u.email) = v_admin_email;

  IF v_match_count <> 1 THEN
    RAISE EXCEPTION 'bootstrap_admin: expected exactly one Auth user with email %, found %; create it first via Dashboard > Authentication > Users > Add user',
      v_admin_email, v_match_count;
  END IF;

  SELECT u.id INTO v_admin_user_id
  FROM auth.users u
  WHERE lower(u.email) = v_admin_email
    AND u.email_confirmed_at IS NOT NULL
    AND u.deleted_at IS NULL
    AND (u.banned_until IS NULL OR u.banned_until <= now())
    AND u.is_anonymous = false;

  IF v_admin_user_id IS NULL THEN
    RAISE EXCEPTION 'bootstrap_admin: Auth user % is not confirmed, is deleted, banned or anonymous',
      v_admin_email;
  END IF;

  -- ------------------------------------------------------------
  -- 2. Fresh-database guard + first company
  -- ------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM companies WHERE name <> v_company_name) THEN
    RAISE EXCEPTION 'bootstrap_admin: refusing to run: the database already contains a company other than %',
      v_company_name;
  END IF;

  SELECT count(*) INTO v_match_count
  FROM companies
  WHERE name = v_company_name;

  IF v_match_count > 1 THEN
    RAISE EXCEPTION 'bootstrap_admin: % companies are named %; expected at most one',
      v_match_count, v_company_name;
  END IF;

  SELECT id INTO v_company_id
  FROM companies
  WHERE name = v_company_name;

  IF v_company_id IS NULL THEN
    INSERT INTO companies (name, legal_name, status)
    VALUES (v_company_name, v_company_name, 'active')
    RETURNING id INTO v_company_id;
  END IF;

  -- Profile guards, checked before any role or grant is written.
  SELECT company_id INTO v_profile_company_id
  FROM profiles
  WHERE id = v_admin_user_id;

  IF v_profile_company_id IS NOT NULL AND v_profile_company_id <> v_company_id THEN
    RAISE EXCEPTION 'bootstrap_admin: Auth user % already has a profile in another company',
      v_admin_email;
  END IF;

  IF EXISTS (
    SELECT 1 FROM profiles
    WHERE company_id = v_company_id
      AND lower(email) = v_admin_email
      AND id <> v_admin_user_id
  ) THEN
    RAISE EXCEPTION 'bootstrap_admin: another profile in % already uses email %',
      v_company_name, v_admin_email;
  END IF;

  -- ------------------------------------------------------------
  -- 3. Default system roles
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

  IF v_admin_role_id IS NULL THEN
    RAISE EXCEPTION 'bootstrap_admin: Administrator role was not found after creation';
  END IF;

  -- ------------------------------------------------------------
  -- 3b. Administrator role — every permission except c_admin_excluded.
  -- Without this step a fresh admin role has zero role_permissions rows
  -- and therefore zero permissions.
  -- ------------------------------------------------------------
  INSERT INTO role_permissions (company_id, role_id, permission_id, allowed)
  SELECT v_company_id, v_admin_role_id, p.id, true
  FROM permissions p
  WHERE p.key <> ALL (c_admin_excluded)
  ON CONFLICT (company_id, role_id, permission_id) DO NOTHING;

  -- ------------------------------------------------------------
  -- 4. Administrator profile
  -- ------------------------------------------------------------
  INSERT INTO profiles (id, company_id, full_name, email, status)
  VALUES (v_admin_user_id, v_company_id, v_admin_full_name, v_admin_email, 'active')
  ON CONFLICT (id) DO NOTHING;

  -- ------------------------------------------------------------
  -- 5. Administrator role assignment
  -- ------------------------------------------------------------
  INSERT INTO user_roles (company_id, user_id, role_id)
  VALUES (v_company_id, v_admin_user_id, v_admin_role_id)
  ON CONFLICT (user_id, role_id) DO NOTHING;

  -- ------------------------------------------------------------
  -- 6. Audit trail — written once per company
  -- ------------------------------------------------------------
  SELECT count(*) INTO v_role_count
  FROM roles
  WHERE company_id = v_company_id AND is_system_role;

  SELECT count(*) INTO v_grant_count
  FROM role_permissions
  WHERE company_id = v_company_id AND role_id = v_admin_role_id;

  IF NOT EXISTS (
    SELECT 1 FROM audit_logs
    WHERE company_id = v_company_id
      AND action = 'company.bootstrapped'
  ) THEN
    INSERT INTO audit_logs (company_id, user_id, action, module, record_type, record_id, new_value)
    VALUES (
      v_company_id,
      v_admin_user_id,
      'company.bootstrapped',
      'settings',
      'companies',
      v_company_id,
      jsonb_build_object(
        'company_name', v_company_name,
        'admin_user_id', v_admin_user_id,
        'admin_email', v_admin_email,
        'system_roles', v_role_count,
        'admin_permissions_granted', v_grant_count,
        'admin_excluded_permissions', to_jsonb(c_admin_excluded),
        'source', 'supabase/bootstrap_admin.sql'
      )
    );
  END IF;

  RAISE NOTICE 'bootstrap_admin: company % (%), admin %: % system roles, % Administrator grants',
    v_company_name, v_company_id, v_admin_email, v_role_count, v_grant_count;
END $$;
