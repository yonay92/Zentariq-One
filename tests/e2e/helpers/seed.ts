import { createAdminSupabaseClient } from '@/lib/supabase/admin';

/**
 * Provisions the fixed, reusable identity fixtures for the PHI Contact Info +
 * Appointment Confirmation e2e suite: a dedicated company, three roles that
 * differ only in whether they hold view_subject_phi/edit_subject_phi, and one
 * user per role. Everything here is idempotent (find-or-create, keyed by
 * unique name/email) — safe to run before every test invocation without
 * accumulating duplicate companies/roles/users across runs.
 *
 * Site/study/visit-template/subject scaffolding is intentionally NOT handled
 * here — see tests/e2e/global-setup.ts, which creates a fresh study every run
 * (via the real API, not raw SQL) so each run always has a clean, subject-free
 * active study.
 */

const COMPANY_NAME = 'Zentariq E2E Tests';
const SITE_NAME = 'E2E Test Site';

// Fixed test-only credential for a dedicated, disposable e2e Supabase project
// (never a shared/prod one — see tests/e2e/README.md). Not read from env: the
// module importing this runs before global-setup's loadEnvLocal() call, so an
// env override here would silently never apply.
export const E2E_PASSWORD = 'E2eTestPass!2024';

export const E2E_USERS = {
  admin: { email: 'e2e-admin@zentariq-e2e.test', roleKey: 'e2e_admin' },
  phi: { email: 'e2e-phi@zentariq-e2e.test', roleKey: 'e2e_phi' },
  nophi: { email: 'e2e-nophi@zentariq-e2e.test', roleKey: 'e2e_nophi' },
  // e2e_admin deliberately excludes reopen_visit (ADMIN_EXCLUDED_PERMISSIONS
  // below, mirroring the real bootstrapped Administrator) — none of the other
  // seeded personas hold it either, so the Visit Calendar e2e suite's Reopen
  // coverage needs a persona that does. Reused by tests/e2e/charts.spec.ts
  // (Milestone 4.1) for the same reason on reopen_chart — one dangerous-
  // operation-override persona, not a second one per module.
  reopener: { email: 'e2e-reopener@zentariq-e2e.test', roleKey: 'e2e_reopener' },
} as const;

export type E2EPersona = keyof typeof E2E_USERS;

export type E2EIdentityFixtures = {
  companyId: string;
  siteId: string;
  siteName: string;
  users: Record<E2EPersona, { userId: string; email: string; password: string }>;
};

async function findOrCreateCompany(
  supabase: ReturnType<typeof createAdminSupabaseClient>,
): Promise<string> {
  const { data: existing } = await supabase
    .from('companies')
    .select('id')
    .eq('name', COMPANY_NAME)
    .maybeSingle();
  if (existing) return (existing as { id: string }).id;

  const { data: created, error } = await supabase
    .from('companies')
    .insert({ name: COMPANY_NAME, legal_name: COMPANY_NAME, status: 'active' })
    .select('id')
    .single();
  if (error || !created) throw new Error(`Failed to create e2e company: ${error?.message}`);
  return (created as { id: string }).id;
}

async function findOrCreateSite(
  supabase: ReturnType<typeof createAdminSupabaseClient>,
  companyId: string,
): Promise<string> {
  const { data: existing } = await supabase
    .from('sites')
    .select('id')
    .eq('company_id', companyId)
    .eq('name', SITE_NAME)
    .maybeSingle();
  if (existing) return (existing as { id: string }).id;

  const { data: created, error } = await supabase
    .from('sites')
    .insert({ company_id: companyId, name: SITE_NAME, status: 'active' })
    .select('id')
    .single();
  if (error || !created) throw new Error(`Failed to create e2e site: ${error?.message}`);
  return (created as { id: string }).id;
}

// permissions catalog is global — safe to look up once and reuse across roles.
async function loadPermissionMap(
  supabase: ReturnType<typeof createAdminSupabaseClient>,
): Promise<Map<string, string>> {
  const { data, error } = await supabase.from('permissions').select('id, key');
  if (error || !data) throw new Error(`Failed to load permissions: ${error?.message}`);
  return new Map((data as Array<{ id: string; key: string }>).map((p) => [p.key, p.id]));
}

// Mirrors CompanyService.provision()'s ADMIN_EXCLUDED_PERMISSIONS — e2e_admin
// gets every permission except the deliberate per-role overrides, same as a
// real bootstrapped Administrator. view_subject_phi/edit_subject_phi are NOT
// excluded here (migration 013) — Administrator gets PHI access by default;
// e2e_phi/e2e_nophi below are what exercise the "other roles still require a
// conscious per-role grant" path.
const ADMIN_EXCLUDED_PERMISSIONS = new Set([
  'force_archive_study',
  'force_archive_site',
  'reopen_visit',
  'override_regulatory_status',
  // Added alongside Milestone 4.1's e2e coverage — mirrors
  // CompanyService.ADMIN_EXCLUDED_PERMISSIONS exactly (migration 026 added
  // reopen_chart to the same "conscious per-role override" category as
  // reopen_visit). Without this, e2e_admin would incorrectly gain
  // reopen_chart, which a real bootstrapped Administrator never has by
  // default — that mismatch would make any e2e_admin-based "cannot reopen a
  // chart" assertion false.
  'reopen_chart',
]);

const BASE_ACCESS_PERMISSIONS = [
  'view_dashboard',
  'view_studies',
  'view_subjects',
  'view_visits',
  'view_all_sites',
  'view_leads',
  'view_regulatory',
];

async function findOrCreateRole(
  supabase: ReturnType<typeof createAdminSupabaseClient>,
  companyId: string,
  key: string,
  name: string,
  permissionKeys: string[],
  permissionMap: Map<string, string>,
): Promise<string> {
  const { data: existing } = await supabase
    .from('roles')
    .select('id')
    .eq('company_id', companyId)
    .eq('key', key)
    .maybeSingle();

  const roleId = existing
    ? (existing as { id: string }).id
    : await (async () => {
        const { data: created, error } = await supabase
          .from('roles')
          .insert({ company_id: companyId, key, name, description: name, is_system_role: false })
          .select('id')
          .single();
        if (error || !created) throw new Error(`Failed to create role ${key}: ${error?.message}`);
        return (created as { id: string }).id;
      })();

  const permissionIds = permissionKeys
    .map((k) => permissionMap.get(k))
    .filter((id): id is string => Boolean(id));

  if (permissionIds.length > 0) {
    await supabase.from('role_permissions').upsert(
      permissionIds.map((permissionId) => ({
        company_id: companyId,
        role_id: roleId,
        permission_id: permissionId,
        allowed: true,
      })),
      { onConflict: 'company_id,role_id,permission_id', ignoreDuplicates: true },
    );
  }

  return roleId;
}

async function findOrCreateUser(
  supabase: ReturnType<typeof createAdminSupabaseClient>,
  companyId: string,
  roleId: string,
  email: string,
  fullName: string,
): Promise<string> {
  const { data: existingProfile } = await supabase
    .from('profiles')
    .select('id')
    .eq('company_id', companyId)
    .eq('email', email)
    .maybeSingle();

  let userId: string;
  if (existingProfile) {
    userId = (existingProfile as { id: string }).id;
  } else {
    const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
      email,
      password: E2E_PASSWORD,
      email_confirm: true,
    });
    if (authError || !authUser.user) {
      throw new Error(`Failed to create e2e auth user ${email}: ${authError?.message}`);
    }
    userId = authUser.user.id;

    const { error: profileError } = await supabase.from('profiles').insert({
      id: userId,
      company_id: companyId,
      full_name: fullName,
      email,
      status: 'active',
    });
    if (profileError) {
      throw new Error(`Failed to create profile for ${email}: ${profileError.message}`);
    }
  }

  await supabase
    .from('user_roles')
    .upsert(
      { company_id: companyId, user_id: userId, role_id: roleId },
      { onConflict: 'user_id,role_id', ignoreDuplicates: true },
    );

  return userId;
}

export async function seedIdentityFixtures(): Promise<E2EIdentityFixtures> {
  const supabase = createAdminSupabaseClient();

  const companyId = await findOrCreateCompany(supabase);
  const siteId = await findOrCreateSite(supabase, companyId);
  const permissionMap = await loadPermissionMap(supabase);

  const adminPerms = Array.from(permissionMap.keys()).filter(
    (k) => !ADMIN_EXCLUDED_PERMISSIONS.has(k),
  );
  const phiPerms = [
    ...BASE_ACCESS_PERMISSIONS,
    'view_subject_phi',
    'edit_subject_phi',
    'view_lead_phi',
    'edit_lead_phi',
  ];
  const nophiPerms = [...BASE_ACCESS_PERMISSIONS];
  // manage_visits is required alongside reopen_visit: it's the base RLS gate
  // on any visits UPDATE (migration 010_visit_calendar.sql), separate from
  // reopen_visit's app-level "dangerous operation" override check
  // (VisitService.reopenVisit -> PermissionService.guardDangerousOperation).
  // Without it the reopen write itself is silently blocked by RLS (0 rows
  // affected -> "Cannot coerce the result to a single JSON object").
  // view_charts + reopen_chart added alongside Milestone 4.1's e2e coverage —
  // unlike visits' RLS gate, charts_update's WITH-permission clause accepts
  // reopen_chart on its own (no separate base-write permission needed), so
  // no chart equivalent of manage_visits is required here.
  const reopenerPerms = [
    ...BASE_ACCESS_PERMISSIONS,
    'manage_visits',
    'reopen_visit',
    'view_charts',
    'reopen_chart',
  ];

  const adminRoleId = await findOrCreateRole(
    supabase,
    companyId,
    E2E_USERS.admin.roleKey,
    'E2E Admin',
    adminPerms,
    permissionMap,
  );
  const phiRoleId = await findOrCreateRole(
    supabase,
    companyId,
    E2E_USERS.phi.roleKey,
    'E2E PHI User',
    phiPerms,
    permissionMap,
  );
  const nophiRoleId = await findOrCreateRole(
    supabase,
    companyId,
    E2E_USERS.nophi.roleKey,
    'E2E No-PHI User',
    nophiPerms,
    permissionMap,
  );
  const reopenerRoleId = await findOrCreateRole(
    supabase,
    companyId,
    E2E_USERS.reopener.roleKey,
    'E2E Reopener',
    reopenerPerms,
    permissionMap,
  );

  const adminUserId = await findOrCreateUser(
    supabase,
    companyId,
    adminRoleId,
    E2E_USERS.admin.email,
    'E2E Admin',
  );
  const phiUserId = await findOrCreateUser(
    supabase,
    companyId,
    phiRoleId,
    E2E_USERS.phi.email,
    'E2E PHI User',
  );
  const nophiUserId = await findOrCreateUser(
    supabase,
    companyId,
    nophiRoleId,
    E2E_USERS.nophi.email,
    'E2E No-PHI User',
  );
  const reopenerUserId = await findOrCreateUser(
    supabase,
    companyId,
    reopenerRoleId,
    E2E_USERS.reopener.email,
    'E2E Reopener',
  );

  return {
    companyId,
    siteId,
    siteName: SITE_NAME,
    users: {
      admin: { userId: adminUserId, email: E2E_USERS.admin.email, password: E2E_PASSWORD },
      phi: { userId: phiUserId, email: E2E_USERS.phi.email, password: E2E_PASSWORD },
      nophi: { userId: nophiUserId, email: E2E_USERS.nophi.email, password: E2E_PASSWORD },
      reopener: {
        userId: reopenerUserId,
        email: E2E_USERS.reopener.email,
        password: E2E_PASSWORD,
      },
    },
  };
}

/**
 * Assigns a user as an active CRC on a study by inserting directly into
 * study_staff. There is currently no API/UI path to manage study staff
 * assignments in the app — StudyService.listCrcOptions (which backs the
 * Calendar's CRC filter) only ever reads this table — so, same rationale as
 * the identity fixtures above, a raw write is the only option for this
 * fixture data. Upserts on the table's (study_id, user_id, staff_role)
 * unique constraint, though callers only need this once per (fresh) study.
 */
export async function assignCrcStaff(
  companyId: string,
  studyId: string,
  userId: string,
): Promise<void> {
  const supabase = createAdminSupabaseClient();
  const { error } = await supabase.from('study_staff').upsert(
    {
      company_id: companyId,
      study_id: studyId,
      user_id: userId,
      staff_role: 'crc',
      active: true,
    },
    { onConflict: 'study_id,user_id,staff_role', ignoreDuplicates: true },
  );
  if (error) throw new Error(`Failed to assign CRC staff: ${error.message}`);
}
