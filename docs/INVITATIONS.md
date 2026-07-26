# INVITATIONS.md

# Zentariq One — User Invitation Architecture Specification

Version: 1.0
Status: Production-Ready — Required before Sprint 1

---

## 1. Purpose

This document defines the complete user invitation system for Zentariq One. It resolves **GAP-DB-02** from GAP_ANALYSIS.md by specifying the `user_invitations` table, the invitation token lifecycle, the invitation service, the API contract, the acceptance flow, and the Supabase Auth integration.

---

## 2. Core Principles

1. Only Admin users (with `manage_users` permission) may invite new users to their company.
2. An invitation is company-scoped — an invited user joins exactly one company.
3. Roles and sites are assigned at the time of invitation and applied automatically upon acceptance.
4. Invitation tokens are single-use, cryptographically random, and expire in 72 hours by default.
5. Accepting an invitation creates a Supabase Auth user and a `profiles` record atomically.
6. Expired and accepted invitations are retained for audit purposes and never hard-deleted.
7. Every invitation event is written to `audit_logs`.

---

## 3. Database Schema

### 3.1 `user_invitations` table (new — add to migration 001)

```sql
CREATE TABLE user_invitations (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid         NOT NULL REFERENCES companies(id),
  email         text         NOT NULL,
  invited_by    uuid         NOT NULL REFERENCES profiles(id),
  roles         jsonb        NOT NULL DEFAULT '[]'::jsonb, -- array of role_ids to assign on acceptance
  sites         jsonb        NOT NULL DEFAULT '[]'::jsonb, -- array of site_ids to assign on acceptance
  token         text         NOT NULL UNIQUE,
  expires_at    timestamptz  NOT NULL,
  accepted_at   timestamptz,
  accepted_by   uuid         REFERENCES profiles(id),      -- profile created upon acceptance
  status        text         NOT NULL DEFAULT 'pending',    -- pending | accepted | expired | revoked
  revoked_by    uuid         REFERENCES profiles(id),
  revoked_at    timestamptz,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT chk_invitation_status CHECK (
    status IN ('pending', 'accepted', 'expired', 'revoked')
  )
);

-- Indexes
CREATE INDEX idx_invitations_company   ON user_invitations(company_id);
CREATE INDEX idx_invitations_email     ON user_invitations(email);
CREATE INDEX idx_invitations_token     ON user_invitations(token) WHERE status = 'pending';
CREATE INDEX idx_invitations_status    ON user_invitations(status, expires_at);
```

### 3.2 RLS Policies

```sql
ALTER TABLE user_invitations ENABLE ROW LEVEL SECURITY;

-- Admins can view all invitations for their company
CREATE POLICY "invitations_select" ON user_invitations
  FOR SELECT USING (
    company_id = current_company_id()
    AND has_permission('manage_users')
  );

-- Admins can insert invitations for their company
CREATE POLICY "invitations_insert" ON user_invitations
  FOR INSERT WITH CHECK (
    company_id = current_company_id()
    AND has_permission('manage_users')
  );

-- Admins can update (revoke) invitations for their company
CREATE POLICY "invitations_update" ON user_invitations
  FOR UPDATE USING (
    company_id = current_company_id()
    AND has_permission('manage_users')
  );

-- No DELETE — invitations are retained for audit
```

---

## 4. Token Generation

Tokens are generated server-side using a cryptographically secure random generator. Tokens are never stored in plaintext in the client.

```typescript
// lib/invitations/generateToken.ts
import { randomBytes } from 'crypto';

export function generateInvitationToken(): string {
  return randomBytes(32).toString('hex'); // 64-character hex string
}
```

The token is included in the invitation URL:

```
https://app.zentariq-one.com/accept-invitation?token=<64-char-hex>
```

---

## 5. Invitation Service

```typescript
// services/InvitationService.ts

export interface SendInvitationInput {
  email: string;
  roleIds: string[]; // validated to exist and belong to company_id
  siteIds: string[]; // validated to exist and belong to company_id
  companyId: string;
  invitedBy: string; // inviting user's profile id
  expiresInHours?: number; // default 72
}

export interface AcceptInvitationInput {
  token: string;
  fullName: string;
  password: string; // must meet password strength requirements
}

export class InvitationService {
  async sendInvitation(input: SendInvitationInput, ctx: RequestContext): Promise<UserInvitation> {
    // 1. Check permission
    await permissionService.requirePermission(ctx.userId, 'manage_users');

    // 2. Validate roles and sites belong to company
    await this.validateRolesAndSites(input.roleIds, input.siteIds, input.companyId);

    // 3. Check for existing pending invitation for this email + company
    const existing = await db.user_invitations.findPending(input.email, input.companyId);
    if (existing) {
      await this.revokeInvitation(existing.id, ctx);
    }

    // 4. Check if user already exists in this company
    const existingProfile = await db.profiles.findByEmail(input.email, input.companyId);
    if (existingProfile) {
      throw new ConflictError('A user with this email already exists in this company');
    }

    // 5. Create invitation record
    const token = generateInvitationToken();
    const invitation = await db.user_invitations.insert({
      company_id: input.companyId,
      email: input.email.toLowerCase().trim(),
      invited_by: input.invitedBy,
      roles: input.roleIds,
      sites: input.siteIds,
      token,
      expires_at: new Date(Date.now() + (input.expiresInHours ?? 72) * 3600 * 1000),
      status: 'pending',
    });

    // 6. Send notification email
    await notificationService.dispatch({
      type: 'user_invited',
      companyId: input.companyId,
      recipientUserId: null, // external email — not an existing user
      customTitle: 'You have been invited to Zentariq One',
      customBody: this.buildInvitationEmailBody(invitation, token),
      context: { token, email: input.email },
    });

    // 7. Audit
    await auditService.log({
      action: 'user_invitation.sent',
      module: 'users',
      record_type: 'user_invitations',
      record_id: invitation.id,
      new_value: { email: input.email, roles: input.roleIds, sites: input.siteIds },
      ctx,
    });

    return invitation;
  }

  async acceptInvitation(
    input: AcceptInvitationInput,
  ): Promise<{ userId: string; session: Session }> {
    // 1. Validate token
    const invitation = await db.user_invitations.findByToken(input.token);
    if (!invitation) throw new NotFoundError('Invitation not found or already used');
    if (invitation.status !== 'pending')
      throw new ConflictError(`Invitation is ${invitation.status}`);
    if (new Date() > invitation.expires_at) {
      await db.user_invitations.update(invitation.id, { status: 'expired' });
      throw new ValidationError('Invitation has expired. Please request a new invitation.');
    }

    // 2. Create Supabase Auth user (uses service role key — server-side only)
    const { data: authUser, error } = await supabaseAdmin.auth.admin.createUser({
      email: invitation.email,
      password: input.password,
      email_confirm: true, // pre-confirmed since they clicked the invitation link
    });
    if (error) throw new AuthError(error.message);

    // 3. Create profile (Supabase trigger handles this, or explicit insert)
    const profile = await db.profiles.insert({
      id: authUser.user.id,
      company_id: invitation.company_id,
      full_name: input.fullName,
      email: invitation.email,
      status: 'active',
    });

    // 4. Assign roles
    for (const roleId of invitation.roles as string[]) {
      await db.user_roles.insert({
        company_id: invitation.company_id,
        user_id: profile.id,
        role_id: roleId,
      });
    }

    // 5. Assign sites
    for (const siteId of invitation.sites as string[]) {
      await db.user_sites.insert({
        company_id: invitation.company_id,
        user_id: profile.id,
        site_id: siteId,
      });
    }

    // 6. Mark invitation accepted
    await db.user_invitations.update(invitation.id, {
      status: 'accepted',
      accepted_at: new Date(),
      accepted_by: profile.id,
    });

    // 7. Initialize notification preferences
    await notificationService.initializeDefaultPreferences(profile.id, invitation.company_id);

    // 8. Sign in and return session
    const { data: session } = await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email: invitation.email,
    });

    // 9. Audit
    await auditService.log({
      action: 'user_invitation.accepted',
      module: 'users',
      record_type: 'user_invitations',
      record_id: invitation.id,
      new_value: { user_id: profile.id, email: invitation.email },
      ctx: { companyId: invitation.company_id, userId: profile.id },
    });

    return { userId: profile.id, session };
  }

  async revokeInvitation(invitationId: string, ctx: RequestContext): Promise<void> {
    await permissionService.requirePermission(ctx.userId, 'manage_users');

    const invitation = await db.user_invitations.findById(invitationId, ctx.companyId);
    if (!invitation) throw new NotFoundError('Invitation not found');
    if (invitation.status !== 'pending')
      throw new ConflictError('Only pending invitations can be revoked');

    await db.user_invitations.update(invitationId, {
      status: 'revoked',
      revoked_by: ctx.userId,
      revoked_at: new Date(),
    });

    await auditService.log({
      action: 'user_invitation.revoked',
      module: 'users',
      record_type: 'user_invitations',
      record_id: invitationId,
      new_value: { revoked_by: ctx.userId },
      ctx,
    });
  }

  async expireStaleInvitations(): Promise<void> {
    // Called by daily cron — marks all 'pending' invitations past their expires_at as 'expired'
    await db.user_invitations.expireStale();
  }

  async resendInvitation(invitationId: string, ctx: RequestContext): Promise<UserInvitation> {
    await permissionService.requirePermission(ctx.userId, 'manage_users');

    const existing = await db.user_invitations.findById(invitationId, ctx.companyId);
    if (!existing || existing.status !== 'pending') {
      throw new ConflictError('Only pending invitations can be resent');
    }

    // Extend expiry and generate a new token
    const token = generateInvitationToken();
    const updated = await db.user_invitations.update(invitationId, {
      token,
      expires_at: new Date(Date.now() + 72 * 3600 * 1000),
    });

    await notificationService.dispatch({
      type: 'user_invited',
      companyId: ctx.companyId,
      customTitle: 'Reminder: Your Zentariq One invitation is waiting',
      context: { token, email: existing.email },
    });

    await auditService.log({
      action: 'user_invitation.resent',
      module: 'users',
      record_type: 'user_invitations',
      record_id: invitationId,
      ctx,
    });

    return updated;
  }

  private buildInvitationEmailBody(invitation: UserInvitation, token: string): string {
    const acceptUrl = `${process.env.NEXT_PUBLIC_APP_URL}/accept-invitation?token=${token}`;
    return `
      You have been invited to join Zentariq One by a member of your organization.
      Click the link below to set up your account. This link expires in 72 hours.

      ${acceptUrl}

      If you did not expect this invitation, you can safely ignore this email.
    `;
  }
}
```

---

## 6. API Contract

```
POST   /api/users/invite
       Body: { email, role_ids[], site_ids[] }
       Auth: manage_users permission required
       Response: { success, data: { invitation_id, email, expires_at } }

POST   /api/invitations/accept
       Body: { token, full_name, password }
       Auth: None (public endpoint — token is the credential)
       Response: { success, data: { user_id, session } }

DELETE /api/users/invitations/:id
       Auth: manage_users permission required
       Response: { success }

POST   /api/users/invitations/:id/resend
       Auth: manage_users permission required
       Response: { success, data: { expires_at } }

GET    /api/users/invitations
       Auth: manage_users permission required
       Query: ?status=pending|accepted|expired|revoked
       Response: { success, data: UserInvitation[] }
```

---

## 7. Acceptance UI Flow

### 7.1 Accept Invitation Page (`/accept-invitation`)

The accept-invitation page is a public route (no auth required). On load:

1. Extract `token` from query string.
2. Call `GET /api/invitations/validate?token=...` to verify the token is valid and not expired.
3. If invalid: show error ("This invitation is invalid or has expired") with a contact message.
4. If valid: show the account setup form with email pre-filled (read-only) and fields for Full Name + Password.
5. On submit: call `POST /api/invitations/accept` with `{ token, full_name, password }`.
6. On success: redirect to `/dashboard` with the new session active.

### 7.2 Password Requirements

Password must:

- Be at least 12 characters
- Contain at least one uppercase letter
- Contain at least one lowercase letter
- Contain at least one number
- Contain at least one special character

Validation is enforced both client-side (UX) and server-side (security boundary).

---

## 8. Admin UI: Manage Invitations (Sprint 1)

Located at: **Settings → Users → Invitations**

Displays a table of all invitations with columns:

| Column  | Description                                   |
| ------- | --------------------------------------------- |
| Email   | Invited email address                         |
| Roles   | Comma-separated role names                    |
| Sites   | Comma-separated site names                    |
| Status  | pending / accepted / expired / revoked        |
| Invited | Relative time (e.g., "2 days ago")            |
| Expires | Absolute date (e.g., "Jul 3, 2026")           |
| Actions | Resend (pending only) / Revoke (pending only) |

Filters: Status (All / Pending / Accepted / Expired / Revoked)

**Invite User** button opens a modal with:

- Email field
- Role multi-select (populated from `roles` for the company)
- Site multi-select (populated from `sites` for the company)
- Submit → calls `POST /api/users/invite`

---

## 9. Token Security

- Tokens are 32 random bytes encoded as 64 hex characters — 256 bits of entropy.
- Tokens are stored in plaintext in `user_invitations.token` (they are not secrets that require hashing — they expire and are single-use, and they are only transmitted over HTTPS).
- The `idx_invitations_token` index uses a partial index `WHERE status = 'pending'` to ensure O(1) lookup only for active tokens.
- Accepted, expired, and revoked tokens are retained in the table but their index entry is removed by the partial index, preventing reuse.
- The acceptance endpoint is rate-limited to 10 attempts per IP per hour to prevent token enumeration attacks.
- The validation endpoint (`GET /api/invitations/validate`) returns only `{ valid: true/false, email }` — it never returns the full invitation record to unauthenticated callers.

---

## 10. Cron: Expire Stale Invitations

A Supabase Edge Function cron runs daily at 01:00:

```typescript
// supabase/functions/task-generator/expire-invitations.ts
await db.user_invitations.update(
  { status: 'pending', expires_at: { lt: new Date() } },
  { status: 'expired', updated_at: new Date() },
);
```

---

## 11. Audit Events

| Event                      | When                               |
| -------------------------- | ---------------------------------- |
| `user_invitation.sent`     | Admin sends invitation             |
| `user_invitation.accepted` | User completes account setup       |
| `user_invitation.expired`  | Cron expires a stale invitation    |
| `user_invitation.revoked`  | Admin revokes a pending invitation |
| `user_invitation.resent`   | Admin resends invitation           |
| `user.created`             | Profile created on acceptance      |
| `user_roles.assigned`      | Roles applied on acceptance        |
| `user_sites.assigned`      | Sites applied on acceptance        |

---

## 12. Edge Cases

| Scenario                                     | Behavior                                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Email already registered in same company     | Return 409 Conflict — "User already exists"                                                     |
| Email registered in different company        | Allowed — a user can be invited to a second company (separate profile)                          |
| Token used twice                             | Second use returns 409 Conflict — "Invitation already accepted"                                 |
| Token expired (user clicks old link)         | Return 410 Gone — "Invitation expired. Request a new invitation."                               |
| Admin invites without selecting roles        | Validation error — at least one role is required                                                |
| Admin invites without selecting sites        | Allowed — user can be added to sites later                                                      |
| Password too weak                            | Server returns 422 Unprocessable Entity with field-level error                                  |
| Supabase Auth user creation fails            | Invitation remains `pending` — error is surfaced to the user                                    |
| Profile insert fails after Auth user created | Auth user is deleted via `supabaseAdmin.auth.admin.deleteUser()` to avoid orphaned auth records |

---

## 13. Cross-References

- Missing table resolved: GAP-DB-02 (`docs/GAP_ANALYSIS.md`)
- `profiles.status = 'pending_invite'` defined in: `docs/DATABASE_Part_01_Core_SaaS_Users_Roles_Sites.md` §5
- `POST /api/users/invite` in: `docs/API.md`
- Notification for `user_invited` event: `docs/NOTIFICATIONS.md` §6
- Supabase invitation workflow: `docs/SUPABASE_SETUP.md` §2
- Implemented in Sprint: Sprint 1 (`docs/DEVELOPMENT_PLAN.md`)
