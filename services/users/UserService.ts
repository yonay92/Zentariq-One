import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@/lib/supabase/admin';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import {
  NotFoundError,
  DatabaseError,
  PermissionDeniedError,
  SignInSyncError,
} from '@/lib/api/errors';
import { logger } from '@/lib/logger';
import type { Profile, UserWithAccess } from '@/types/users';
import type { RequestContext } from '@/types/api';

// GoTrue has no "ban forever"; ~100 years, cleared again on reactivation.
const SIGN_IN_REVOKED_BAN_DURATION = '876000h';

/**
 * Keeps Supabase Auth in step with the STORED profiles.status. A non-active
 * account is banned, which revokes its refresh tokens and blocks new
 * sign-ins, so a deactivated user cannot keep minting access tokens. The
 * database already denies a non-active user all tenant data
 * (current_company_id() is NULL, migration 037); this ends the session itself.
 *
 * Idempotent, so callers run it on every explicit status save: repeating the
 * save is how an administrator retries a failed synchronization. A failure
 * leaves the profile saved; it is logged, audited and reported as
 * SignInSyncError so it is never silent.
 */
async function syncSignInAccess(
  userId: string,
  storedStatus: string,
  ctx: RequestContext,
): Promise<void> {
  const signInAllowed = storedStatus === 'active';
  const adminSupabase = createAdminSupabaseClient();
  const { error } = await adminSupabase.auth.admin.updateUserById(userId, {
    ban_duration: signInAllowed ? 'none' : SIGN_IN_REVOKED_BAN_DURATION,
  });
  if (!error) return;

  logger.error('UserService.syncSignInAccess failed', {
    userId,
    storedStatus,
    error: error.message,
  });
  await AuditService.log({
    company_id: ctx.company.id,
    user_id: ctx.user.id,
    action: 'user.sign_in_sync_failed',
    module: 'users',
    record_type: 'profiles',
    record_id: userId,
    new_value: { status: storedStatus, sign_in: signInAllowed ? 'allowed' : 'revoked' },
  });
  throw new SignInSyncError(
    signInAllowed
      ? 'The account was saved as active, but sign-in could not be re-enabled. Save the status again to retry.'
      : `The account was saved as ${storedStatus} and has no data access, but its sessions could not be revoked. Save the status again to retry.`,
  );
}

export const UserService = {
  async list(
    ctx: RequestContext,
    filters?: { role?: string; site?: string; status?: string },
  ): Promise<UserWithAccess[]> {
    const supabase = await createServerSupabaseClient();
    let query = supabase
      .from('profiles')
      .select(
        'id, company_id, full_name, email, phone, status, avatar_file_id, last_login_at, created_at, updated_at',
      )
      .eq('company_id', ctx.company.id)
      .order('full_name');

    if (filters?.status) {
      query = query.eq('status', filters.status);
    }

    const { data } = await query;
    const profiles = (data as Profile[]) ?? [];
    if (profiles.length === 0) return [];

    const userIds = profiles.map((p) => p.id);

    const [{ data: userRoles }, { data: userSites }] = await Promise.all([
      supabase
        .from('user_roles')
        .select('user_id, roles!inner(id, key, name)')
        .eq('company_id', ctx.company.id)
        .in('user_id', userIds),
      supabase
        .from('user_sites')
        .select('user_id, sites!inner(id, name)')
        .eq('company_id', ctx.company.id)
        .in('user_id', userIds),
    ]);

    const rolesByUser = new Map<string, UserWithAccess['roles']>();
    for (const ur of (userRoles as Array<{
      user_id: string;
      roles: UserWithAccess['roles'][number];
    }> | null) ?? []) {
      const list = rolesByUser.get(ur.user_id) ?? [];
      list.push(ur.roles);
      rolesByUser.set(ur.user_id, list);
    }

    const sitesByUser = new Map<string, UserWithAccess['sites']>();
    for (const us of (userSites as Array<{
      user_id: string;
      sites: UserWithAccess['sites'][number];
    }> | null) ?? []) {
      const list = sitesByUser.get(us.user_id) ?? [];
      list.push(us.sites);
      sitesByUser.set(us.user_id, list);
    }

    return profiles.map((p) => ({
      ...p,
      roles: rolesByUser.get(p.id) ?? [],
      sites: sitesByUser.get(p.id) ?? [],
    }));
  },

  async getById(userId: string, ctx: RequestContext): Promise<Profile> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('profiles')
      .select(
        'id, company_id, full_name, email, phone, status, avatar_file_id, last_login_at, created_at, updated_at',
      )
      .eq('id', userId)
      .eq('company_id', ctx.company.id)
      .single();

    if (error || !data) throw new NotFoundError('User');
    return data as Profile;
  },

  async update(
    userId: string,
    input: { full_name?: string; phone?: string | null; status?: string },
    ctx: RequestContext,
  ): Promise<Profile> {
    // User can update own profile; admin can update any profile in company
    const isSelf = userId === ctx.user.id;
    if (isSelf && input.status !== undefined) {
      throw new PermissionDeniedError('Cannot change your own account status');
    }
    if (!isSelf) {
      await PermissionService.requirePermission(ctx.user.id, 'manage_users');
    }

    const supabase = await createServerSupabaseClient();
    const { data: old } = await supabase
      .from('profiles')
      .select('id, full_name, phone, status')
      .eq('id', userId)
      .eq('company_id', ctx.company.id)
      .maybeSingle();

    if (!old) throw new NotFoundError('User');

    const { data, error } = await supabase
      .from('profiles')
      .update(input)
      .eq('id', userId)
      .eq('company_id', ctx.company.id)
      .select(
        'id, company_id, full_name, email, phone, status, avatar_file_id, last_login_at, created_at, updated_at',
      )
      .single();

    if (error || !data) throw new DatabaseError(error?.message ?? 'Update failed');

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: isSelf ? 'user.updated_self' : 'user.updated',
      module: 'users',
      record_type: 'profiles',
      record_id: userId,
      old_value: old as Record<string, unknown>,
      new_value: input as Record<string, unknown>,
    });

    // Synchronize to the status actually stored, also when it is unchanged,
    // so saving the same status again retries a previously failed sync.
    if (input.status !== undefined) {
      await syncSignInAccess(userId, (data as Profile).status, ctx);
    }

    return data as Profile;
  },

  async deactivate(userId: string, ctx: RequestContext): Promise<void> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_users');

    if (userId === ctx.user.id) {
      throw new PermissionDeniedError('Cannot deactivate your own account');
    }

    const supabase = await createServerSupabaseClient();
    const { data: existing } = await supabase
      .from('profiles')
      .select('id, full_name, status')
      .eq('id', userId)
      .eq('company_id', ctx.company.id)
      .maybeSingle();

    if (!existing) throw new NotFoundError('User');

    const adminSupabase = createAdminSupabaseClient();
    const { error } = await adminSupabase
      .from('profiles')
      .update({ status: 'inactive' })
      .eq('id', userId)
      .eq('company_id', ctx.company.id);

    if (error) throw new DatabaseError(error.message);

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'user.deactivated',
      module: 'users',
      record_type: 'profiles',
      record_id: userId,
      old_value: { status: (existing as { status: string }).status },
      new_value: { status: 'inactive' },
    });

    await syncSignInAccess(userId, 'inactive', ctx);
  },

  async assignRole(userId: string, roleId: string, ctx: RequestContext): Promise<void> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_users');

    const supabase = await createServerSupabaseClient();
    // Both must belong to the caller's company (also enforced by the
    // composite foreign keys of migration 037).
    const [{ data: role }, { data: target }] = await Promise.all([
      supabase
        .from('roles')
        .select('id')
        .eq('id', roleId)
        .eq('company_id', ctx.company.id)
        .maybeSingle(),
      supabase
        .from('profiles')
        .select('id')
        .eq('id', userId)
        .eq('company_id', ctx.company.id)
        .maybeSingle(),
    ]);
    if (!role) throw new NotFoundError('Role');
    if (!target) throw new NotFoundError('User');

    const { error } = await supabase.from('user_roles').insert({
      company_id: ctx.company.id,
      user_id: userId,
      role_id: roleId,
    });

    if (error && !error.message.includes('duplicate')) {
      throw new DatabaseError(error.message);
    }

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'user_roles.assigned',
      module: 'users',
      record_type: 'user_roles',
      new_value: { user_id: userId, role_id: roleId },
    });
  },

  async removeRole(userId: string, roleId: string, ctx: RequestContext): Promise<void> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_users');

    const supabase = await createServerSupabaseClient();
    await supabase
      .from('user_roles')
      .delete()
      .eq('user_id', userId)
      .eq('role_id', roleId)
      .eq('company_id', ctx.company.id);

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'user_roles.removed',
      module: 'users',
      record_type: 'user_roles',
      new_value: { user_id: userId, role_id: roleId },
    });
  },

  async assignSite(userId: string, siteId: string, ctx: RequestContext): Promise<void> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_users');

    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.from('user_sites').insert({
      company_id: ctx.company.id,
      user_id: userId,
      site_id: siteId,
    });

    if (error && !error.message.includes('duplicate')) {
      throw new DatabaseError(error.message);
    }

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'user_sites.assigned',
      module: 'users',
      record_type: 'user_sites',
      new_value: { user_id: userId, site_id: siteId },
    });
  },

  async removeSite(userId: string, siteId: string, ctx: RequestContext): Promise<void> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_users');

    const supabase = await createServerSupabaseClient();
    await supabase
      .from('user_sites')
      .delete()
      .eq('user_id', userId)
      .eq('site_id', siteId)
      .eq('company_id', ctx.company.id);

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'user_sites.removed',
      module: 'users',
      record_type: 'user_sites',
      new_value: { user_id: userId, site_id: siteId },
    });
  },
};
