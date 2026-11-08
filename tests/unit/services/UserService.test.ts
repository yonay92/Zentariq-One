import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@/lib/supabase/admin';
import { UserService } from '@/services/users/UserService';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import { NotFoundError, PermissionDeniedError, SignInSyncError } from '@/lib/api/errors';

const COMPANY_ID = 'company-uuid';
const USER_ID = 'user-uuid';

function makeCtx() {
  return {
    user: {
      id: USER_ID,
      company_id: COMPANY_ID,
      full_name: 'Admin User',
      email: 'admin@example.com',
      phone: null,
      avatar_file_id: null,
      status: 'active' as const,
      last_login_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    company: {
      id: COMPANY_ID,
      name: 'Test Company',
      legal_name: null,
      status: 'active' as const,
      subscription_plan: null,
      timezone: 'UTC',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  };
}

function queryStub(data: unknown, error: unknown = null) {
  const resolved = Promise.resolve({ data, error });
  const stub: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
    single: vi.fn().mockResolvedValue({ data, error }),
    then: resolved.then.bind(resolved),
    catch: resolved.catch.bind(resolved),
    finally: resolved.finally.bind(resolved),
  };
  for (const key of ['select', 'eq', 'order', 'in', 'update', 'insert']) {
    (stub[key] as ReturnType<typeof vi.fn>).mockReturnValue(stub);
  }
  return stub;
}

function makeSupabaseClient(...responses: Array<{ data: unknown; error?: unknown }>) {
  const from = vi.fn();
  for (const r of responses) {
    from.mockReturnValueOnce(queryStub(r.data, r.error ?? null));
  }
  return { from } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('UserService.list', () => {
  it('returns an empty array without extra queries when there are no profiles', async () => {
    const client = makeSupabaseClient({ data: [] });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await UserService.list(makeCtx());

    expect(result).toEqual([]);
  });

  it('attaches each user’s roles and sites via batched lookups', async () => {
    const profiles = [
      { id: 'user-1', company_id: COMPANY_ID, full_name: 'Alice', email: 'alice@example.com' },
      { id: 'user-2', company_id: COMPANY_ID, full_name: 'Bob', email: 'bob@example.com' },
    ];
    const userRoles = [
      { user_id: 'user-1', roles: { id: 'role-admin', key: 'admin', name: 'Administrator' } },
    ];
    const userSites = [{ user_id: 'user-1', sites: { id: 'site-1', name: 'Main Site' } }];

    const client = makeSupabaseClient(
      { data: profiles }, // profiles select
      { data: userRoles }, // user_roles batched lookup
      { data: userSites }, // user_sites batched lookup
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await UserService.list(makeCtx());

    expect(result).toHaveLength(2);
    const alice = result.find((u) => u.id === 'user-1');
    const bob = result.find((u) => u.id === 'user-2');

    expect(alice?.roles).toEqual([{ id: 'role-admin', key: 'admin', name: 'Administrator' }]);
    expect(alice?.sites).toEqual([{ id: 'site-1', name: 'Main Site' }]);
    expect(bob?.roles).toEqual([]);
    expect(bob?.sites).toEqual([]);
  });
});

// ── Account status and sign-in access (G7 H1) ────────────────────────────────

const TARGET_ID = 'target-user-uuid';

function makeAdminClient(updateResult: { error: unknown } = { error: null }) {
  const updateUserById = vi.fn().mockResolvedValue({ data: {}, ...updateResult });
  const from = vi.fn().mockReturnValue(queryStub(null));
  return { client: { from, auth: { admin: { updateUserById } } } as never, updateUserById, from };
}

describe('UserService.update — account status', () => {
  beforeEach(() => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(AuditService, 'log').mockResolvedValue(undefined as never);
  });

  it('rejects a self-service status change before touching the database', async () => {
    await expect(
      UserService.update(USER_ID, { status: 'active' }, makeCtx()),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(createServerSupabaseClient).not.toHaveBeenCalled();
  });

  it('still allows self-service name and phone edits without revoking sign-in', async () => {
    const client = makeSupabaseClient(
      { data: { id: USER_ID, full_name: 'Old', phone: null, status: 'active' } },
      { data: { id: USER_ID, full_name: 'New', status: 'active' } },
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await UserService.update(USER_ID, { full_name: 'New' }, makeCtx());

    expect(PermissionService.requirePermission).not.toHaveBeenCalled();
    expect(createAdminSupabaseClient).not.toHaveBeenCalled();
  });

  it('bans the account when an administrator suspends another user', async () => {
    const client = makeSupabaseClient(
      { data: { id: TARGET_ID, full_name: 'T', phone: null, status: 'active' } },
      { data: { id: TARGET_ID, status: 'suspended' } },
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);
    const admin = makeAdminClient();
    vi.mocked(createAdminSupabaseClient).mockReturnValue(admin.client);

    await UserService.update(TARGET_ID, { status: 'suspended' }, makeCtx());

    expect(PermissionService.requirePermission).toHaveBeenCalledWith(USER_ID, 'manage_users');
    expect(admin.updateUserById).toHaveBeenCalledWith(TARGET_ID, { ban_duration: '876000h' });
  });

  it('lifts the ban when an administrator reactivates a user', async () => {
    const client = makeSupabaseClient(
      { data: { id: TARGET_ID, full_name: 'T', phone: null, status: 'inactive' } },
      { data: { id: TARGET_ID, status: 'active' } },
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);
    const admin = makeAdminClient();
    vi.mocked(createAdminSupabaseClient).mockReturnValue(admin.client);

    await UserService.update(TARGET_ID, { status: 'active' }, makeCtx());

    expect(admin.updateUserById).toHaveBeenCalledWith(TARGET_ID, { ban_duration: 'none' });
  });

  it('re-synchronizes sign-in access when the same status is saved again (retry)', async () => {
    const client = makeSupabaseClient(
      { data: { id: TARGET_ID, full_name: 'T', phone: null, status: 'active' } },
      { data: { id: TARGET_ID, status: 'active' } },
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);
    const admin = makeAdminClient();
    vi.mocked(createAdminSupabaseClient).mockReturnValue(admin.client);

    await UserService.update(TARGET_ID, { status: 'active', full_name: 'T2' }, makeCtx());

    expect(admin.updateUserById).toHaveBeenCalledWith(TARGET_ID, { ban_duration: 'none' });
  });

  it('synchronizes to the stored status, never to the requested one', async () => {
    const client = makeSupabaseClient(
      { data: { id: TARGET_ID, full_name: 'T', phone: null, status: 'inactive' } },
      { data: { id: TARGET_ID, status: 'inactive' } },
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);
    const admin = makeAdminClient();
    vi.mocked(createAdminSupabaseClient).mockReturnValue(admin.client);

    await UserService.update(TARGET_ID, { status: 'active' }, makeCtx());

    expect(admin.updateUserById).toHaveBeenCalledWith(TARGET_ID, { ban_duration: '876000h' });
    expect(admin.updateUserById).not.toHaveBeenCalledWith(TARGET_ID, { ban_duration: 'none' });
  });

  it('reports a failed ban explicitly after the suspension was saved and audited', async () => {
    const client = makeSupabaseClient(
      { data: { id: TARGET_ID, full_name: 'T', phone: null, status: 'active' } },
      { data: { id: TARGET_ID, status: 'suspended' } },
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);
    const admin = makeAdminClient({ error: { message: 'auth unavailable' } });
    vi.mocked(createAdminSupabaseClient).mockReturnValue(admin.client);

    const result = UserService.update(TARGET_ID, { status: 'suspended' }, makeCtx());

    await expect(result).rejects.toBeInstanceOf(SignInSyncError);
    await expect(result).rejects.toThrow(/saved as suspended and has no data access/);
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.updated', record_id: TARGET_ID }),
    );
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.sign_in_sync_failed',
        record_id: TARGET_ID,
        new_value: { status: 'suspended', sign_in: 'revoked' },
      }),
    );
  });

  it('reports a failed unban explicitly after the reactivation was saved', async () => {
    const client = makeSupabaseClient(
      { data: { id: TARGET_ID, full_name: 'T', phone: null, status: 'inactive' } },
      { data: { id: TARGET_ID, status: 'active' } },
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);
    const admin = makeAdminClient({ error: { message: 'auth unavailable' } });
    vi.mocked(createAdminSupabaseClient).mockReturnValue(admin.client);

    const result = UserService.update(TARGET_ID, { status: 'active' }, makeCtx());

    await expect(result).rejects.toBeInstanceOf(SignInSyncError);
    await expect(result).rejects.toThrow(/Save the status again to retry/);
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.sign_in_sync_failed',
        new_value: { status: 'active', sign_in: 'allowed' },
      }),
    );
  });

  it('recovers when the failed unban is retried by saving the same status again', async () => {
    const updateUserById = vi
      .fn()
      .mockResolvedValueOnce({ data: {}, error: { message: 'auth unavailable' } })
      .mockResolvedValueOnce({ data: {}, error: null });
    vi.mocked(createAdminSupabaseClient).mockReturnValue({
      from: vi.fn(),
      auth: { admin: { updateUserById } },
    } as never);

    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient(
        { data: { id: TARGET_ID, full_name: 'T', phone: null, status: 'inactive' } },
        { data: { id: TARGET_ID, status: 'active' } },
      ),
    );
    await expect(
      UserService.update(TARGET_ID, { status: 'active' }, makeCtx()),
    ).rejects.toBeInstanceOf(SignInSyncError);

    // Retry: the profile is already active, the sync must still run.
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient(
        { data: { id: TARGET_ID, full_name: 'T', phone: null, status: 'active' } },
        { data: { id: TARGET_ID, status: 'active' } },
      ),
    );
    await expect(
      UserService.update(TARGET_ID, { status: 'active' }, makeCtx()),
    ).resolves.toMatchObject({ id: TARGET_ID, status: 'active' });

    expect(updateUserById).toHaveBeenCalledTimes(2);
    expect(updateUserById).toHaveBeenNthCalledWith(2, TARGET_ID, { ban_duration: 'none' });
  });

  it('does not touch sign-in access when no status is submitted', async () => {
    const client = makeSupabaseClient(
      { data: { id: TARGET_ID, full_name: 'T', phone: null, status: 'inactive' } },
      { data: { id: TARGET_ID, status: 'inactive' } },
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await UserService.update(TARGET_ID, { full_name: 'T2' }, makeCtx());

    expect(createAdminSupabaseClient).not.toHaveBeenCalled();
  });
});

describe('UserService.deactivate — session revocation', () => {
  beforeEach(() => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(AuditService, 'log').mockResolvedValue(undefined as never);
  });

  it('sets the profile inactive, audits it, then bans the account', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: { id: TARGET_ID, full_name: 'T', status: 'active' } }),
    );
    const admin = makeAdminClient();
    vi.mocked(createAdminSupabaseClient).mockReturnValue(admin.client);

    await UserService.deactivate(TARGET_ID, makeCtx());

    expect(admin.from).toHaveBeenCalledWith('profiles');
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.deactivated', record_id: TARGET_ID }),
    );
    expect(admin.updateUserById).toHaveBeenCalledWith(TARGET_ID, { ban_duration: '876000h' });
  });

  it('reports a failed revocation after the deactivation itself was saved and audited', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: { id: TARGET_ID, full_name: 'T', status: 'active' } }),
    );
    const admin = makeAdminClient({ error: { message: 'auth unavailable' } });
    vi.mocked(createAdminSupabaseClient).mockReturnValue(admin.client);

    await expect(UserService.deactivate(TARGET_ID, makeCtx())).rejects.toBeInstanceOf(
      SignInSyncError,
    );
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.deactivated' }),
    );
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.sign_in_sync_failed',
        new_value: { status: 'inactive', sign_in: 'revoked' },
      }),
    );
  });

  it('retries the ban when an already-inactive account is deactivated again', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: { id: TARGET_ID, full_name: 'T', status: 'inactive' } }),
    );
    const admin = makeAdminClient();
    vi.mocked(createAdminSupabaseClient).mockReturnValue(admin.client);

    await UserService.deactivate(TARGET_ID, makeCtx());

    expect(admin.updateUserById).toHaveBeenCalledWith(TARGET_ID, { ban_duration: '876000h' });
  });

  it('still refuses to deactivate the caller’s own account', async () => {
    await expect(UserService.deactivate(USER_ID, makeCtx())).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    expect(createAdminSupabaseClient).not.toHaveBeenCalled();
  });
});

describe('UserService.assignRole — same-company references (G7 M1)', () => {
  beforeEach(() => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(AuditService, 'log').mockResolvedValue(undefined as never);
  });

  it('rejects a role that does not belong to the caller’s company', async () => {
    const client = makeSupabaseClient({ data: null }, { data: { id: TARGET_ID } });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(UserService.assignRole(TARGET_ID, 'foreign-role', makeCtx())).rejects.toThrow(
      new NotFoundError('Role'),
    );
    const fromFn = (client as unknown as { from: ReturnType<typeof vi.fn> }).from;
    expect(fromFn).not.toHaveBeenCalledWith('user_roles');
    expect(AuditService.log).not.toHaveBeenCalled();
  });

  it('rejects a user that does not belong to the caller’s company', async () => {
    const client = makeSupabaseClient({ data: { id: 'role-1' } }, { data: null });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(UserService.assignRole('foreign-user', 'role-1', makeCtx())).rejects.toThrow(
      new NotFoundError('User'),
    );
  });

  it('scopes both lookups to the caller’s company and inserts the assignment', async () => {
    const roleStub = queryStub({ id: 'role-1' });
    const userStub = queryStub({ id: TARGET_ID });
    const insertStub = queryStub(null);
    const from = vi
      .fn()
      .mockReturnValueOnce(roleStub)
      .mockReturnValueOnce(userStub)
      .mockReturnValueOnce(insertStub);
    vi.mocked(createServerSupabaseClient).mockResolvedValue({ from } as never);

    await UserService.assignRole(TARGET_ID, 'role-1', makeCtx());

    expect(from.mock.calls.map((c) => c[0])).toEqual(['roles', 'profiles', 'user_roles']);
    expect(roleStub.eq).toHaveBeenCalledWith('company_id', COMPANY_ID);
    expect(userStub.eq).toHaveBeenCalledWith('company_id', COMPANY_ID);
    expect(insertStub.insert).toHaveBeenCalledWith({
      company_id: COMPANY_ID,
      user_id: TARGET_ID,
      role_id: 'role-1',
    });
  });
});
