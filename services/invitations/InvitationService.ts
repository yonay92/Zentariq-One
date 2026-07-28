import { createAdminSupabaseClient } from '@/lib/supabase/admin';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { generateInvitationToken } from '@/lib/invitations/generateToken';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import { NotificationService } from '@/services/notifications/NotificationService';
import {
  PermissionDeniedError,
  NotFoundError,
  ConflictError,
  AuthError,
  ValidationError,
} from '@/lib/api/errors';
import { config } from '@/lib/config';
import type { UserInvitation, ValidateTokenResponse } from '@/types/invitations';
import type { Profile } from '@/types/users';
import type { RequestContext } from '@/types/api';

const INVITATION_EXPIRY_HOURS = 72;
const RATE_LIMIT_ATTEMPTS = 10;
const RATE_LIMIT_WINDOW_MS = 3600 * 1000;

// In-memory rate limiter for acceptance endpoint (keyed by IP)
const acceptanceAttempts = new Map<string, { count: number; resetAt: number }>();

function checkAcceptanceRateLimit(ip: string): void {
  const now = Date.now();
  const entry = acceptanceAttempts.get(ip);

  if (!entry || entry.resetAt < now) {
    acceptanceAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return;
  }

  if (entry.count >= RATE_LIMIT_ATTEMPTS) {
    throw new ValidationError('Too many attempts. Please try again in an hour.');
  }

  entry.count++;
}

export const InvitationService = {
  async sendInvitation(
    input: { email: string; roleIds: string[]; siteIds: string[] },
    ctx: RequestContext,
  ): Promise<{ invitation_id: string; email: string; expires_at: string }> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_users');

    const supabase = createAdminSupabaseClient();

    // Validate that all roleIds belong to the company
    const { data: roles, error: rolesError } = await supabase
      .from('roles')
      .select('id')
      .eq('company_id', ctx.company.id)
      .in('id', input.roleIds);

    if (rolesError || !roles || roles.length !== input.roleIds.length) {
      throw new ValidationError('One or more role IDs are invalid for this company');
    }

    // Validate siteIds if any provided
    if (input.siteIds.length > 0) {
      const { data: sites, error: sitesError } = await supabase
        .from('sites')
        .select('id')
        .eq('company_id', ctx.company.id)
        .in('id', input.siteIds);

      if (sitesError || !sites || sites.length !== input.siteIds.length) {
        throw new ValidationError('One or more site IDs are invalid for this company');
      }
    }

    // Check if user already exists in this company
    const { data: existingProfile } = await supabase
      .from('profiles')
      .select('id')
      .eq('company_id', ctx.company.id)
      .eq('email', input.email.toLowerCase().trim())
      .maybeSingle();

    if (existingProfile) {
      throw new ConflictError('A user with this email already exists in this company');
    }

    // Revoke any existing pending invitation for this email + company
    const { data: existingInvite } = await supabase
      .from('user_invitations')
      .select('id')
      .eq('company_id', ctx.company.id)
      .eq('email', input.email.toLowerCase().trim())
      .eq('status', 'pending')
      .maybeSingle();

    if (existingInvite) {
      await supabase
        .from('user_invitations')
        .update({
          status: 'revoked',
          revoked_by: ctx.user.id,
          revoked_at: new Date().toISOString(),
        })
        .eq('id', (existingInvite as { id: string }).id);
    }

    const token = generateInvitationToken();
    const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_HOURS * 3600 * 1000).toISOString();

    const { data: invitation, error: insertError } = await supabase
      .from('user_invitations')
      .insert({
        company_id: ctx.company.id,
        email: input.email.toLowerCase().trim(),
        invited_by: ctx.user.id,
        roles: input.roleIds,
        sites: input.siteIds,
        token,
        expires_at: expiresAt,
        status: 'pending',
      })
      .select('id, email, expires_at')
      .single();

    if (insertError || !invitation) {
      throw new AuthError('Failed to create invitation');
    }

    const acceptUrl = `${config.app.url}/accept-invitation?token=${token}`;
    await NotificationService.dispatch({
      type: 'user_invited',
      companyId: ctx.company.id,
      recipientUserId: null,
      customTitle: "You've been invited to Zentariq One",
      customBody: `You have been invited to join Zentariq One by ${ctx.user.full_name}. Click the link below to set up your account. This link expires in 72 hours.\n\n${acceptUrl}\n\nIf you did not expect this invitation, you can safely ignore this email.`,
      context: { token, email: input.email },
    });

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'user_invitation.sent',
      module: 'users',
      record_type: 'user_invitations',
      record_id: (invitation as { id: string }).id,
      new_value: { email: input.email, role_ids: input.roleIds, site_ids: input.siteIds },
    });

    return {
      invitation_id: (invitation as { id: string; email: string; expires_at: string }).id,
      email: (invitation as { id: string; email: string; expires_at: string }).email,
      expires_at: (invitation as { id: string; email: string; expires_at: string }).expires_at,
    };
  },

  async validateToken(token: string): Promise<ValidateTokenResponse> {
    const supabase = createAdminSupabaseClient();
    const { data } = await supabase
      .from('user_invitations')
      .select('email, status, expires_at')
      .eq('token', token)
      .eq('status', 'pending')
      .maybeSingle();

    if (!data) return { valid: false };

    const inv = data as { email: string; status: string; expires_at: string };
    if (new Date() > new Date(inv.expires_at)) return { valid: false };

    return { valid: true, email: inv.email };
  },

  async acceptInvitation(
    input: { token: string; fullName: string; password: string },
    ipAddress?: string,
  ): Promise<{ userId: string }> {
    if (ipAddress) {
      checkAcceptanceRateLimit(ipAddress);
    }

    const supabase = createAdminSupabaseClient();

    const { data: invitation, error: invErr } = await supabase
      .from('user_invitations')
      .select('id, company_id, email, roles, sites, status, expires_at')
      .eq('token', input.token)
      .eq('status', 'pending')
      .maybeSingle();

    if (invErr || !invitation) {
      throw new NotFoundError('Invitation not found or already used');
    }

    const inv = invitation as {
      id: string;
      company_id: string;
      email: string;
      roles: string[];
      sites: string[];
      status: string;
      expires_at: string;
    };

    if (new Date() > new Date(inv.expires_at)) {
      await supabase.from('user_invitations').update({ status: 'expired' }).eq('id', inv.id);
      throw new ValidationError('Invitation has expired. Please request a new invitation.');
    }

    // Create Supabase auth user (service role — pre-confirmed since they clicked the invitation link)
    const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
      email: inv.email,
      password: input.password,
      email_confirm: true,
    });

    if (authError || !authUser.user) {
      throw new AuthError(authError?.message ?? 'Failed to create user account');
    }

    let profileId: string | null = null;

    try {
      // Create profile
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .insert({
          id: authUser.user.id,
          company_id: inv.company_id,
          full_name: input.fullName.trim(),
          email: inv.email,
          status: 'active',
        })
        .select('id')
        .single();

      if (profileError || !profile) {
        throw new AuthError('Failed to create user profile');
      }

      profileId = (profile as { id: string }).id;

      // Assign roles
      if (inv.roles.length > 0) {
        await supabase.from('user_roles').insert(
          inv.roles.map((roleId: string) => ({
            company_id: inv.company_id,
            user_id: profileId!,
            role_id: roleId,
          })),
        );
      }

      // Assign sites
      if (inv.sites.length > 0) {
        await supabase.from('user_sites').insert(
          inv.sites.map((siteId: string) => ({
            company_id: inv.company_id,
            user_id: profileId!,
            site_id: siteId,
          })),
        );
      }

      // Mark invitation accepted
      await supabase
        .from('user_invitations')
        .update({
          status: 'accepted',
          accepted_at: new Date().toISOString(),
          accepted_by: profileId,
        })
        .eq('id', inv.id);

      // Initialize notification preferences
      await NotificationService.initializeDefaultPreferences(profileId!, inv.company_id);

      // Audit
      await AuditService.logWithAdmin({
        company_id: inv.company_id,
        user_id: profileId,
        action: 'user_invitation.accepted',
        module: 'users',
        record_type: 'user_invitations',
        record_id: inv.id,
        new_value: { user_id: profileId, email: inv.email },
      });

      await AuditService.logWithAdmin({
        company_id: inv.company_id,
        user_id: profileId,
        action: 'user.created',
        module: 'users',
        record_type: 'profiles',
        record_id: profileId,
        new_value: { email: inv.email, full_name: input.fullName.trim() },
      });

      return { userId: profileId! };
    } catch (err) {
      // If anything after auth user creation fails, delete the orphaned auth user
      if (!profileId) {
        await supabase.auth.admin.deleteUser(authUser.user.id);
      }
      throw err;
    }
  },

  async revokeInvitation(invitationId: string, ctx: RequestContext): Promise<void> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_users');

    const supabase = await createServerSupabaseClient();
    const { data: invitation } = await supabase
      .from('user_invitations')
      .select('id, status, company_id')
      .eq('id', invitationId)
      .eq('company_id', ctx.company.id)
      .maybeSingle();

    if (!invitation) throw new NotFoundError('Invitation');
    if ((invitation as { status: string }).status !== 'pending') {
      throw new ConflictError('Only pending invitations can be revoked');
    }

    const adminSupabase = createAdminSupabaseClient();
    await adminSupabase
      .from('user_invitations')
      .update({
        status: 'revoked',
        revoked_by: ctx.user.id,
        revoked_at: new Date().toISOString(),
      })
      .eq('id', invitationId);

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'user_invitation.revoked',
      module: 'users',
      record_type: 'user_invitations',
      record_id: invitationId,
      new_value: { revoked_by: ctx.user.id },
    });
  },

  async resendInvitation(
    invitationId: string,
    ctx: RequestContext,
  ): Promise<{ expires_at: string }> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_users');

    const supabase = await createServerSupabaseClient();
    const { data: existing } = await supabase
      .from('user_invitations')
      .select('id, email, status')
      .eq('id', invitationId)
      .eq('company_id', ctx.company.id)
      .maybeSingle();

    if (!existing || (existing as { status: string }).status !== 'pending') {
      throw new ConflictError('Only pending invitations can be resent');
    }

    const inv = existing as { id: string; email: string; status: string };
    const newToken = generateInvitationToken();
    const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_HOURS * 3600 * 1000).toISOString();

    const adminSupabase = createAdminSupabaseClient();
    await adminSupabase
      .from('user_invitations')
      .update({ token: newToken, expires_at: expiresAt })
      .eq('id', invitationId);

    const acceptUrl = `${config.app.url}/accept-invitation?token=${newToken}`;
    await NotificationService.dispatch({
      type: 'user_invited',
      companyId: ctx.company.id,
      recipientUserId: null,
      customTitle: 'Reminder: Your Zentariq One invitation is waiting',
      customBody: `Your invitation to Zentariq One is waiting. Click the link below to set up your account. This link expires in 72 hours.\n\n${acceptUrl}`,
      context: { token: newToken, email: inv.email },
    });

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'user_invitation.resent',
      module: 'users',
      record_type: 'user_invitations',
      record_id: invitationId,
    });

    return { expires_at: expiresAt };
  },

  async listInvitations(ctx: RequestContext, status?: string): Promise<UserInvitation[]> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_users');

    const supabase = await createServerSupabaseClient();
    let query = supabase
      .from('user_invitations')
      .select(
        'id, company_id, email, invited_by, roles, sites, token, expires_at, accepted_at, accepted_by, status, revoked_by, revoked_at, created_at, updated_at',
      )
      .eq('company_id', ctx.company.id)
      .order('created_at', { ascending: false });

    if (status) {
      query = query.eq('status', status);
    }

    const { data } = await query;
    return (data as UserInvitation[]) ?? [];
  },

  async expireStaleInvitations(): Promise<void> {
    const supabase = createAdminSupabaseClient();
    await supabase
      .from('user_invitations')
      .update({ status: 'expired' })
      .eq('status', 'pending')
      .lt('expires_at', new Date().toISOString());
  },
};
