import { createAdminSupabaseClient } from '@/lib/supabase/admin';
import { E2E_PASSWORD } from './seed';

/**
 * Supplementary, disposable-in-spirit fixtures for tests/e2e/tasks.spec.ts
 * ONLY. Deliberately NOT added to helpers/seed.ts / global-setup.ts: those
 * are shared by every other spec, and none of them need a second site or a
 * second company — adding this there would be a change with a blast radius
 * far wider than the one spec that needs it (subject-creation.spec.ts sets
 * exactly this precedent: "build its own throwaway study rather than
 * coupling to another file's fixtures", via apiScaffold.ts).
 *
 * Everything here is idempotent (find-or-create, keyed by unique
 * name/email) — safe to run every invocation without accumulating
 * duplicates, matching helpers/seed.ts's own convention exactly. Uses the
 * `ZE2E-M5-` prefix throughout per this milestone's fixture-safety
 * requirement, so every row this file creates is trivially identifiable and
 * distinguishable from the shared e2e_admin/e2e_nophi/etc. fixtures.
 */

const PREFIX = 'ZE2E-M5';
const SITE2_NAME = `${PREFIX}-Site-2`;
const COMPANY_B_NAME = `${PREFIX}-Company-B`;
const COMPANY_B_SITE_NAME = `${PREFIX}-Company-B-Site`;

export const TASK_E2E_USERS = {
  siteScoped: { email: 'ze2e-m5-sitescoped@zentariq-e2e.test', roleKey: 'ze2e_m5_site_scoped' },
  companyB: { email: 'ze2e-m5-companyb@zentariq-e2e.test', roleKey: 'ze2e_m5_company_b' },
} as const;

export type TaskE2EFixtures = {
  site2Id: string;
  site2Name: string;
  companyBId: string;
  companyBSiteId: string;
  siteScoped: { userId: string; email: string; password: string };
  companyB: { userId: string; email: string; password: string };
};

async function findOrCreateCompany(
  supabase: ReturnType<typeof createAdminSupabaseClient>,
  name: string,
): Promise<string> {
  const { data: existing } = await supabase
    .from('companies')
    .select('id')
    .eq('name', name)
    .maybeSingle();
  if (existing) return (existing as { id: string }).id;

  const { data: created, error } = await supabase
    .from('companies')
    .insert({ name, legal_name: name, status: 'active' })
    .select('id')
    .single();
  if (error || !created) throw new Error(`Failed to create ${name}: ${error?.message}`);
  return (created as { id: string }).id;
}

async function findOrCreateSite(
  supabase: ReturnType<typeof createAdminSupabaseClient>,
  companyId: string,
  name: string,
): Promise<string> {
  const { data: existing } = await supabase
    .from('sites')
    .select('id')
    .eq('company_id', companyId)
    .eq('name', name)
    .maybeSingle();
  if (existing) return (existing as { id: string }).id;

  const { data: created, error } = await supabase
    .from('sites')
    .insert({ company_id: companyId, name, status: 'active' })
    .select('id')
    .single();
  if (error || !created) throw new Error(`Failed to create site ${name}: ${error?.message}`);
  return (created as { id: string }).id;
}

async function loadPermissionMap(
  supabase: ReturnType<typeof createAdminSupabaseClient>,
): Promise<Map<string, string>> {
  const { data, error } = await supabase.from('permissions').select('id, key');
  if (error || !data) throw new Error(`Failed to load permissions: ${error?.message}`);
  return new Map((data as Array<{ id: string; key: string }>).map((p) => [p.key, p.id]));
}

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
    if (profileError)
      throw new Error(`Failed to create profile for ${email}: ${profileError.message}`);
  }

  await supabase
    .from('user_roles')
    .upsert(
      { company_id: companyId, user_id: userId, role_id: roleId },
      { onConflict: 'user_id,role_id', ignoreDuplicates: true },
    );
  return userId;
}

async function ensureUserSite(
  supabase: ReturnType<typeof createAdminSupabaseClient>,
  companyId: string,
  userId: string,
  siteId: string,
): Promise<void> {
  await supabase
    .from('user_sites')
    .upsert(
      { company_id: companyId, user_id: userId, site_id: siteId },
      { onConflict: 'user_id,site_id', ignoreDuplicates: true },
    );
}

/**
 * Provisions, idempotently:
 *   - a second site (`ZE2E-M5-Site-2`) inside the existing shared e2e
 *     company, for the site-isolation coverage (Task Center is otherwise
 *     single-site in the shared fixtures)
 *   - `ze2e-m5-sitescoped`: view_tasks + complete_task + comment_task,
 *     restricted via user_sites to the shared company's FIRST (original)
 *     site only — deliberately NOT view_all_sites, so Site 2 (and any
 *     Company-B site) is genuinely inaccessible to them
 *   - a second company (`ZE2E-M5-Company-B`) with its own site
 *   - `ze2e-m5-companyb`: the full task-permission set inside Company B,
 *     for company-isolation and cross-company-assignee coverage
 */
export async function seedTaskEngineFixtures(
  companyAId: string,
  companyASiteId: string,
): Promise<TaskE2EFixtures> {
  const supabase = createAdminSupabaseClient();
  const permissionMap = await loadPermissionMap(supabase);

  const site2Id = await findOrCreateSite(supabase, companyAId, SITE2_NAME);

  const siteScopedRoleId = await findOrCreateRole(
    supabase,
    companyAId,
    TASK_E2E_USERS.siteScoped.roleKey,
    'ZE2E M5 Site-Scoped',
    ['view_tasks', 'complete_task', 'comment_task'],
    permissionMap,
  );
  const siteScopedUserId = await findOrCreateUser(
    supabase,
    companyAId,
    siteScopedRoleId,
    TASK_E2E_USERS.siteScoped.email,
    'ZE2E M5 Site-Scoped',
  );
  await ensureUserSite(supabase, companyAId, siteScopedUserId, companyASiteId);

  const companyBId = await findOrCreateCompany(supabase, COMPANY_B_NAME);
  const companyBSiteId = await findOrCreateSite(supabase, companyBId, COMPANY_B_SITE_NAME);
  const companyBRoleId = await findOrCreateRole(
    supabase,
    companyBId,
    TASK_E2E_USERS.companyB.roleKey,
    'ZE2E M5 Company B',
    [
      'view_tasks',
      'create_task',
      'complete_task',
      'assign_task',
      'cancel_task',
      'comment_task',
      'view_all_sites',
    ],
    permissionMap,
  );
  const companyBUserId = await findOrCreateUser(
    supabase,
    companyBId,
    companyBRoleId,
    TASK_E2E_USERS.companyB.email,
    'ZE2E M5 Company B',
  );

  return {
    site2Id,
    site2Name: SITE2_NAME,
    companyBId,
    companyBSiteId,
    siteScoped: {
      userId: siteScopedUserId,
      email: TASK_E2E_USERS.siteScoped.email,
      password: E2E_PASSWORD,
    },
    companyB: {
      userId: companyBUserId,
      email: TASK_E2E_USERS.companyB.email,
      password: E2E_PASSWORD,
    },
  };
}
