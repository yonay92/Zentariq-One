/**
 * Integration tests: Document Center file isolation
 *
 * Verifies FileService and file_links enforce tenant isolation exactly the
 * way company-isolation.test.ts and site-isolation.test.ts already verify it
 * for every other module: a user from Company A can never discover, read,
 * link, modify, or obtain a signed URL for Company B's files, and site-scoped
 * links additionally respect the caller's own site access.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@/lib/supabase/admin';
import { FileService } from '@/services/files/FileService';
import { PermissionService } from '@/services/permissions/PermissionService';
import { PermissionDeniedError, NotFoundError } from '@/lib/api/errors';

vi.mock('@/services/audit/AuditService', () => ({
  AuditService: { log: vi.fn() },
}));

const COMPANY_A = 'company-a-uuid';
const COMPANY_B = 'company-b-uuid';
const SITE_A = 'site-a-uuid';
const USER_A = 'user-a-uuid';
const FILE_ID = 'file-uuid';

function makeCtx(companyId: string, userId = USER_A) {
  return {
    user: {
      id: userId,
      company_id: companyId,
      full_name: 'Test User',
      email: 'test@example.com',
      phone: null,
      avatar_file_id: null,
      status: 'active' as const,
      last_login_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    company: {
      id: companyId,
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
    not: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
    single: vi.fn().mockResolvedValue({ data, error }),
    then: resolved.then.bind(resolved),
    catch: resolved.catch.bind(resolved),
    finally: resolved.finally.bind(resolved),
  };
  for (const key of ['select', 'not', 'insert', 'delete']) {
    (stub[key] as ReturnType<typeof vi.fn>).mockReturnValue(stub);
  }
  return stub;
}

/**
 * A "company-aware" mock: simulates what RLS actually does — a query for a
 * row scoped by .eq('company_id', ctx.company.id) only ever "sees" rows
 * whose company_id matches the caller's own session company, regardless of
 * what id was requested. This is the same behavior the real
 * `company_id = current_company_id()` RLS policy produces.
 */
function makeCompanyScopedClient(ownerCompanyId: string, callerCompanyId: string, row: unknown) {
  const visible = ownerCompanyId === callerCompanyId ? row : null;
  return { from: vi.fn().mockReturnValue(queryStub(visible)) } as never;
}

function makeAdminClient(siteRows: Array<{ site_id: string }>) {
  return { from: vi.fn().mockReturnValue(queryStub(siteRows)) } as never;
}

function makeFile(companyId: string) {
  return {
    id: FILE_ID,
    company_id: companyId,
    file_name: 'protocol.pdf',
    original_name: 'protocol.pdf',
    file_extension: 'pdf',
    mime_type: 'application/pdf',
    file_size: 1024,
    storage_path: `${companyId}/uuid_protocol.pdf`,
    uploaded_by: USER_A,
    uploaded_at: '',
    checksum: 'abc123',
    ai_processed: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
});

describe('FileService — company isolation', () => {
  it('Company A cannot access a file that belongs to Company B (getMetadata)', async () => {
    // The file actually belongs to Company B; Company A's session queries it.
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeCompanyScopedClient(COMPANY_B, COMPANY_A, makeFile(COMPANY_B)),
    );

    await expect(FileService.getMetadata(FILE_ID, makeCtx(COMPANY_A))).rejects.toThrow(
      NotFoundError,
    );
  });

  it('Company A cannot obtain a signed URL for a file that belongs to Company B', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeCompanyScopedClient(COMPANY_B, COMPANY_A, makeFile(COMPANY_B)),
    );

    await expect(FileService.getSignedUrl(FILE_ID, makeCtx(COMPANY_A))).rejects.toThrow(
      NotFoundError,
    );
  });

  it('Company A cannot link its own file_links row to a file owned by Company B', async () => {
    // linkToRecord's own getMetadata pre-check is what blocks this — the same
    // check that would also fail server-side under RLS's file_links_insert
    // EXISTS(files WHERE files.id = file_id AND files.company_id = file_links.company_id).
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeCompanyScopedClient(COMPANY_B, COMPANY_A, makeFile(COMPANY_B)),
    );

    await expect(
      FileService.linkToRecord(
        { file_id: FILE_ID, module: 'subjects', record_id: 'record-uuid' },
        makeCtx(COMPANY_A),
      ),
    ).rejects.toThrow(NotFoundError);
  });

  it('Company A can fully access its own file (positive control — authorized access works)', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeCompanyScopedClient(COMPANY_A, COMPANY_A, makeFile(COMPANY_A)),
    );
    vi.mocked(createAdminSupabaseClient).mockReturnValueOnce(makeAdminClient([]));

    const result = await FileService.getMetadata(FILE_ID, makeCtx(COMPANY_A));
    expect(result.company_id).toBe(COMPANY_A);
  });
});

describe('FileService — site isolation on top of company isolation', () => {
  it('rejects a signed URL request when the file is linked only to a site the caller cannot access', async () => {
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeCompanyScopedClient(COMPANY_A, COMPANY_A, makeFile(COMPANY_A)),
    );
    vi.mocked(createAdminSupabaseClient).mockReturnValueOnce(
      makeAdminClient([{ site_id: SITE_A }]),
    );
    vi.spyOn(PermissionService, 'canAccessSite').mockResolvedValue(false);

    await expect(FileService.getSignedUrl(FILE_ID, makeCtx(COMPANY_A))).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it('allows a signed URL request when the caller has access to the linked site', async () => {
    vi.mocked(createServerSupabaseClient)
      .mockResolvedValueOnce(makeCompanyScopedClient(COMPANY_A, COMPANY_A, makeFile(COMPANY_A)))
      .mockResolvedValueOnce({
        storage: {
          from: vi.fn().mockReturnValue({
            createSignedUrl: vi
              .fn()
              .mockResolvedValue({ data: { signedUrl: 'https://signed.example/x' }, error: null }),
          }),
        },
      } as never);
    vi.mocked(createAdminSupabaseClient).mockReturnValueOnce(
      makeAdminClient([{ site_id: SITE_A }]),
    );
    vi.spyOn(PermissionService, 'canAccessSite').mockResolvedValue(true);

    const url = await FileService.getSignedUrl(FILE_ID, makeCtx(COMPANY_A));
    expect(url).toBe('https://signed.example/x');
  });
});
