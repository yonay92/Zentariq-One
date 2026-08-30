/**
 * Baseline characterization tests — Sub-Milestone 3.2 Phase A.
 *
 * StaffCredentialService had ZERO test coverage before this file. These
 * tests lock down its CURRENT behavior (permission gating, company/site
 * isolation, storage bucket/path conventions, persisted identifiers,
 * replace/archive semantics, failure handling) exactly as implemented,
 * BEFORE any Document Center retrofit touches it. No production code is
 * changed to make these tests pass — they characterize what already exists,
 * including two points where Staff Credentials deliberately differs from
 * the already-retrofitted RegulatoryDocumentService (see the notes on each
 * relevant test below):
 *
 *   1. create() and replace() both set the new version's status straight to
 *      'approved' — there is no pending_review/approve() review gate for
 *      staff credentials (self-certifying upload, gated only by the
 *      manage_staff_credentials permission).
 *   2. replace() DOES update staff_documents.file_id/version on every
 *      successful call (see the "slot stays in sync" tests below) — unlike
 *      RegulatoryDocumentService.replace(), which never updates
 *      regulatory_documents.file_id after create() (the still-open,
 *      out-of-scope "slot-staleness" issue documented in Sub-Milestone
 *      3.1's analysis). This asymmetry is exactly why the Document Center
 *      retrofit must still resolve the authoritative file_id from
 *      uploadFile()'s own return value (the local `fileId`), never from
 *      the slot's file_id column, even though that column happens to be
 *      reliable here — treating it as authoritative would be assuming a
 *      convenience column is the source of truth, the exact mistake this
 *      phase is required to avoid.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { StaffCredentialService } from '@/services/regulatory/StaffCredentialService';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import { FileService } from '@/services/files/FileService';
import { PermissionDeniedError, BusinessRuleError, NotFoundError } from '@/lib/api/errors';
import type { StaffDocument, DocumentVersion } from '@/types/regulatory';
import type { FileLink } from '@/types/files';

vi.mock('@/services/audit/AuditService', () => ({
  AuditService: { log: vi.fn() },
}));

const COMPANY_ID = 'company-uuid';
const SITE_ID = 'site-uuid';
const STAFF_DOC_ID = 'staff-doc-uuid';
const USER_ID = 'user-uuid';
const CREDENTIAL_USER_ID = 'credential-user-uuid';

function makeCtx() {
  return {
    user: {
      id: USER_ID,
      company_id: COMPANY_ID,
      full_name: 'Regulatory User',
      email: 'reg@example.com',
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

function baseCredential(overrides: Partial<StaffDocument> = {}): StaffDocument {
  return {
    id: STAFF_DOC_ID,
    company_id: COMPANY_ID,
    user_id: CREDENTIAL_USER_ID,
    site_id: SITE_ID,
    document_type_id: 'doctype-uuid',
    file_id: 'file-uuid',
    version: 'v1',
    effective_date: null,
    expiration_date: null,
    status: 'current',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function baseVersion(overrides: Partial<DocumentVersion> = {}): DocumentVersion {
  return {
    id: 'version-uuid',
    company_id: COMPANY_ID,
    document_id: null,
    staff_document_id: STAFF_DOC_ID,
    previous_version_id: null,
    version: 'v1',
    file_id: 'file-uuid',
    file: null,
    checksum: 'abc123',
    is_current: true,
    status: 'approved',
    effective_date: null,
    expiration_date: null,
    replacement_reason: null,
    duplicate_of_version_id: null,
    uploaded_by: USER_ID,
    uploaded_at: new Date().toISOString(),
    reviewed_by: USER_ID,
    reviewed_at: new Date().toISOString(),
    ...overrides,
  };
}

function queryStub(data: unknown, error: unknown = null) {
  const resolved = Promise.resolve({ data, error });
  const stub: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
    single: vi.fn().mockResolvedValue({ data, error }),
    then: resolved.then.bind(resolved),
    catch: resolved.catch.bind(resolved),
    finally: resolved.finally.bind(resolved),
  };
  for (const key of ['select', 'eq', 'order', 'limit', 'insert', 'update']) {
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

// No `storage` property — cannot reach uploadFile()'s
// supabase.storage.from('regulatory').upload() call. Used for every test
// that throws before reaching the upload step.
function makeSupabaseClientWithStorage(
  responses: Array<{ data: unknown; error?: unknown }>,
  storage?: { upload?: unknown },
) {
  const from = vi.fn();
  for (const r of responses) {
    from.mockReturnValueOnce(queryStub(r.data, r.error ?? null));
  }
  const storageBucket = {
    upload: storage?.upload ?? vi.fn().mockResolvedValue({ data: {}, error: null }),
  };
  return { from, storage: { from: vi.fn().mockReturnValue(storageBucket) } } as never;
}

// Same as makeSupabaseClientWithStorage, but also returns the individual
// per-.from()-call stub objects so a test can assert on the literal
// insert()/update() payload a specific call received.
function makeSupabaseClientWithCapture(
  responses: Array<{ data: unknown; error?: unknown }>,
  storage?: { upload?: unknown },
) {
  const stubs = responses.map((r) => queryStub(r.data, r.error ?? null));
  const from = vi.fn();
  for (const stub of stubs) {
    from.mockReturnValueOnce(stub);
  }
  const storageBucket = {
    upload: storage?.upload ?? vi.fn().mockResolvedValue({ data: {}, error: null }),
  };
  const client = { from, storage: { from: vi.fn().mockReturnValue(storageBucket) } } as never;
  return { client, stubs };
}

function callArgsOf(
  stub: Record<string, unknown> | undefined,
  method: 'insert' | 'update',
  callIndex = 0,
): unknown {
  const fn = stub?.[method] as ReturnType<typeof vi.fn> | undefined;
  return fn?.mock.calls[callIndex]?.[0];
}

// jsdom's File has no arrayBuffer() — same minimal stand-in used by
// RegulatoryDocumentService.test.ts.
function makeFile(name: string, content: string, type = 'application/pdf'): File {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  return {
    name,
    type,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer,
  } as unknown as File;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── create() ─────────────────────────────────────────────────────────────

describe('StaffCredentialService.create', () => {
  it('throws PermissionDeniedError without manage_staff_credentials', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('manage_staff_credentials'),
    );

    await expect(
      StaffCredentialService.create(
        { user_id: CREDENTIAL_USER_ID, document_type_id: 'doctype-uuid' },
        makeFile('cv.pdf', 'content'),
        makeCtx(),
      ),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it('requires site access when site_id is supplied', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const requireSiteAccessSpy = vi
      .spyOn(PermissionService, 'requireSiteAccess')
      .mockRejectedValue(new PermissionDeniedError(`site:${SITE_ID}`));

    await expect(
      StaffCredentialService.create(
        { user_id: CREDENTIAL_USER_ID, document_type_id: 'doctype-uuid', site_id: SITE_ID },
        makeFile('cv.pdf', 'content'),
        makeCtx(),
      ),
    ).rejects.toThrow(PermissionDeniedError);
    expect(requireSiteAccessSpy).toHaveBeenCalledWith(USER_ID, SITE_ID);
  });

  it('does not require site access when no site_id is supplied (company-wide credential)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const requireSiteAccessSpy = vi.spyOn(PermissionService, 'requireSiteAccess');
    const newFileId = 'new-file-uuid';
    const client = makeSupabaseClientWithStorage([
      { data: baseCredential({ file_id: null, version: null, site_id: null }) }, // slot insert
      { data: { id: newFileId } }, // files insert
      { data: null }, // document_versions insert
      { data: baseCredential({ file_id: newFileId, version: 'v1', site_id: null }) }, // finalize update
      { data: null }, // document_history insert
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await StaffCredentialService.create(
      { user_id: CREDENTIAL_USER_ID, document_type_id: 'doctype-uuid' },
      makeFile('cv.pdf', 'content'),
      makeCtx(),
    );

    expect(requireSiteAccessSpy).not.toHaveBeenCalled();
  });

  it('throws BusinessRuleError when a credential of this type already exists for this staff member (duplicate slot)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeSupabaseClient({
      data: null,
      error: { code: '23505', message: 'duplicate key' },
    });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      StaffCredentialService.create(
        { user_id: CREDENTIAL_USER_ID, document_type_id: 'doctype-uuid' },
        makeFile('cv.pdf', 'content'),
        makeCtx(),
      ),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('uploads to the regulatory bucket, creates the slot + v1 version as approved (no review gate), and returns the finalized credential', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const newFileId = 'new-file-uuid';
    const uploadSpy = vi.fn().mockResolvedValue({ data: {}, error: null });
    const client = makeSupabaseClientWithStorage(
      [
        { data: baseCredential({ status: 'missing', file_id: null, version: null }) }, // slot insert
        { data: { id: newFileId } }, // files insert
        { data: null }, // document_versions insert
        { data: baseCredential({ status: 'current', file_id: newFileId, version: 'v1' }) }, // finalize update
        { data: null }, // document_history insert
      ],
      { upload: uploadSpy },
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await StaffCredentialService.create(
      { user_id: CREDENTIAL_USER_ID, document_type_id: 'doctype-uuid' },
      makeFile('cv.pdf', 'content'),
      makeCtx(),
    );

    // Storage: uploaded to the shared 'regulatory' bucket (not a
    // staff-credentials-specific bucket).
    expect(uploadSpy).toHaveBeenCalled();
    const storageKey = uploadSpy.mock.calls[0]?.[0] as string;
    // Path convention: {company}/staff/{user_id}/{document_type_id}/{versionId}_{filename}
    expect(storageKey).toMatch(
      new RegExp(`^${COMPANY_ID}/staff/${CREDENTIAL_USER_ID}/doctype-uuid/[^/]+_cv\\.pdf$`),
    );

    expect(result.status).toBe('current');
    expect(result.file_id).toBe(newFileId);
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'staff_document.uploaded', company_id: COMPANY_ID }),
    );
  });

  it('writes company_id, user_id, and site_id from ctx/input — never any other source (company/site isolation on write)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(PermissionService, 'requireSiteAccess').mockResolvedValue(undefined);
    vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const newFileId = 'new-file-uuid';
    const { client, stubs } = makeSupabaseClientWithCapture([
      { data: baseCredential({ file_id: null, version: null }) },
      { data: { id: newFileId } },
      { data: null },
      { data: baseCredential({ file_id: newFileId, version: 'v1' }) },
      { data: null },
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await StaffCredentialService.create(
      { user_id: CREDENTIAL_USER_ID, document_type_id: 'doctype-uuid', site_id: SITE_ID },
      makeFile('cv.pdf', 'content'),
      makeCtx(),
    );

    const slotInsertArgs = callArgsOf(stubs[0], 'insert') as Record<string, unknown>;
    expect(slotInsertArgs).toMatchObject({
      company_id: COMPANY_ID,
      user_id: CREDENTIAL_USER_ID,
      site_id: SITE_ID,
      status: 'pending_review',
    });

    const versionInsertArgs = callArgsOf(stubs[2], 'insert') as Record<string, unknown>;
    expect(versionInsertArgs).toMatchObject({
      company_id: COMPANY_ID,
      staff_document_id: STAFF_DOC_ID,
      version: 'v1',
      file_id: newFileId,
      is_current: true,
      status: 'approved', // no pending_review gate for staff credentials
    });
  });

  it('throws DatabaseError when the storage upload itself fails (no orphan-cleanup call for the storage object — pre-existing behavior, not a Document Center concern)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeSupabaseClientWithStorage(
      [{ data: baseCredential({ file_id: null, version: null }) }],
      { upload: vi.fn().mockResolvedValue({ data: null, error: { message: 'storage down' } }) },
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      StaffCredentialService.create(
        { user_id: CREDENTIAL_USER_ID, document_type_id: 'doctype-uuid' },
        makeFile('cv.pdf', 'content'),
        makeCtx(),
      ),
    ).rejects.toThrow('Staff credential upload failed');
  });
});

// ── Sub-Milestone 3.2B: Document Center retrofit for create() ──────────────

describe('StaffCredentialService.create — Document Center retrofit', () => {
  function successClient(newFileId: string, siteId: string | null = SITE_ID) {
    return makeSupabaseClientWithStorage([
      { data: baseCredential({ status: 'draft', file_id: null, version: null, site_id: siteId }) },
      { data: { id: newFileId } },
      { data: null },
      {
        data: baseCredential({
          status: 'current',
          file_id: newFileId,
          version: 'v1',
          site_id: siteId,
        }),
      },
      { data: null },
    ]);
  }

  it('A/C/D/E: calls linkForModule exactly once, with module=staff_documents and the correct record_id/site_id', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const linkSpy = vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const newFileId = 'new-file-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(successClient(newFileId));

    await StaffCredentialService.create(
      { user_id: CREDENTIAL_USER_ID, document_type_id: 'doctype-uuid' },
      makeFile('cv.pdf', 'content'),
      makeCtx(),
    );

    expect(linkSpy).toHaveBeenCalledTimes(1);
    expect(linkSpy).toHaveBeenCalledWith(
      {
        file_id: newFileId,
        module: 'staff_documents',
        record_id: STAFF_DOC_ID,
        site_id: SITE_ID,
      },
      expect.anything(),
    );
  });

  it('B: passes the exact fileId returned by uploadFile() — never a reconstructed or stale identifier', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const linkSpy = vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const newFileId = 'distinct-file-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(successClient(newFileId));

    await StaffCredentialService.create(
      { user_id: CREDENTIAL_USER_ID, document_type_id: 'doctype-uuid' },
      makeFile('cv.pdf', 'content'),
      makeCtx(),
    );

    const callArgs = linkSpy.mock.calls[0]?.[0];
    expect(callArgs?.file_id).toBe(newFileId);
    expect(callArgs?.record_id).toBe(STAFF_DOC_ID);
  });

  it('F: preserves a null site_id for a company-wide credential', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const linkSpy = vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const newFileId = 'new-file-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(successClient(newFileId, null));

    await StaffCredentialService.create(
      { user_id: CREDENTIAL_USER_ID, document_type_id: 'doctype-uuid' },
      makeFile('cv.pdf', 'content'),
      makeCtx(),
    );

    expect(linkSpy).toHaveBeenCalledWith(
      expect.objectContaining({ site_id: null }),
      expect.anything(),
    );
  });

  it('G: still succeeds and returns the finalized credential when linkForModule fails (failure is logged, not swallowed silently, and never rolled back)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(FileService, 'linkForModule').mockRejectedValue(new Error('file_links insert failed'));
    const newFileId = 'new-file-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(successClient(newFileId));

    const result = await StaffCredentialService.create(
      { user_id: CREDENTIAL_USER_ID, document_type_id: 'doctype-uuid' },
      makeFile('cv.pdf', 'content'),
      makeCtx(),
    );

    expect(result.status).toBe('current');
    expect(result.file_id).toBe(newFileId);
  });

  it('H: never exposes a public URL from the Document Center link', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(FileService, 'linkForModule').mockResolvedValue({
      id: 'link-uuid',
      company_id: COMPANY_ID,
      file_id: 'new-file-uuid',
      site_id: SITE_ID,
      module: 'staff_documents',
      record_id: STAFF_DOC_ID,
      created_by: USER_ID,
      created_at: new Date().toISOString(),
    } as FileLink);
    const newFileId = 'new-file-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(successClient(newFileId));

    const result = await StaffCredentialService.create(
      { user_id: CREDENTIAL_USER_ID, document_type_id: 'doctype-uuid' },
      makeFile('cv.pdf', 'content'),
      makeCtx(),
    );

    expect(result).not.toHaveProperty('url');
    expect(result).not.toHaveProperty('signedUrl');
    expect(result).not.toHaveProperty('publicUrl');
  });
});

// ── replace() ────────────────────────────────────────────────────────────

describe('StaffCredentialService.replace', () => {
  it('throws PermissionDeniedError without manage_staff_credentials', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('manage_staff_credentials'),
    );

    await expect(
      StaffCredentialService.replace(
        STAFF_DOC_ID,
        makeFile('cv.pdf', 'content'),
        { replacement_reason: 'renewal' },
        makeCtx(),
      ),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it('throws NotFoundError for a credential belonging to a different company (company isolation)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: null, error: { message: 'no rows' } }),
    );

    await expect(
      StaffCredentialService.replace(
        STAFF_DOC_ID,
        makeFile('cv.pdf', 'content'),
        { replacement_reason: 'renewal' },
        makeCtx(),
      ),
    ).rejects.toThrow(NotFoundError);
  });

  it('throws BusinessRuleError when the credential is archived', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: baseCredential({ status: 'archived' }) }),
    );

    await expect(
      StaffCredentialService.replace(
        STAFF_DOC_ID,
        makeFile('cv.pdf', 'content'),
        { replacement_reason: 'renewal' },
        makeCtx(),
      ),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('throws BusinessRuleError when no replacement_reason is given', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: baseCredential({ status: 'current' }) }),
    );

    await expect(
      StaffCredentialService.replace(STAFF_DOC_ID, makeFile('cv.pdf', 'content'), {}, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('returns a DuplicateChecksumWarning instead of creating a version when the checksum matches and confirm_duplicate is not set', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const matchingVersion = {
      id: 'existing-version-uuid',
      version: 'v1',
      uploaded_at: new Date().toISOString(),
      uploaded_by: USER_ID,
    };
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient(
        { data: baseCredential({ status: 'current' }) }, // getStaffDocumentOrThrow
        { data: matchingVersion }, // checksum lookup — match found
      ),
    );

    const result = await StaffCredentialService.replace(
      STAFF_DOC_ID,
      makeFile('cv.pdf', 'identical content'),
      { replacement_reason: 'renewal' },
      makeCtx(),
    );

    expect(result).toMatchObject({
      duplicate_detected: true,
      matching_version: { id: 'existing-version-uuid' },
    });
  });

  it('throws BusinessRuleError when the credential has no existing current version to replace', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient(
        { data: baseCredential({ status: 'missing' }) }, // getStaffDocumentOrThrow
        { data: null }, // checksum lookup — no match
        { data: null }, // getCurrentVersion — none exists
      ),
    );

    await expect(
      StaffCredentialService.replace(
        STAFF_DOC_ID,
        makeFile('cv.pdf', 'content'),
        { replacement_reason: 'renewal' },
        makeCtx(),
      ),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('supersedes the previous version, uploads the new file, inserts the new version as approved (no review gate), and updates the slot — including file_id, unlike RegulatoryDocumentService.replace()', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(FileService, 'relinkForModule').mockResolvedValue({} as FileLink);
    const previousVersion = baseVersion({
      id: 'version-a-uuid',
      version: 'v1',
      file_id: 'file-a-uuid',
    });
    const newFileId = 'file-b-uuid';
    const { client, stubs } = makeSupabaseClientWithCapture([
      { data: baseCredential({ status: 'current' }) }, // 0. getStaffDocumentOrThrow
      { data: null }, // 1. checksum lookup — no match
      { data: previousVersion }, // 2. getCurrentVersion
      { data: null }, // 3. supersede previous version
      { data: { id: newFileId } }, // 4. files insert
      { data: null }, // 5. document_versions insert (new version)
      { data: baseCredential({ status: 'current', file_id: newFileId, version: 'v2' }) }, // 6. slot update
      { data: null }, // 7. document_history insert (supersede)
      { data: null }, // 8. document_history insert (new)
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await StaffCredentialService.replace(
      STAFF_DOC_ID,
      makeFile('cv-v2.pdf', 'new content'),
      { replacement_reason: 'annual renewal' },
      makeCtx(),
    );

    expect(result).not.toHaveProperty('duplicate_detected');
    const credential = result as StaffDocument;
    expect(credential.file_id).toBe(newFileId);

    const supersedeArgs = callArgsOf(stubs[3], 'update');
    expect(supersedeArgs).toMatchObject({ is_current: false, status: 'superseded' });

    const versionInsertArgs = callArgsOf(stubs[5], 'insert');
    expect(versionInsertArgs).toMatchObject({
      staff_document_id: STAFF_DOC_ID,
      version: 'v2',
      file_id: newFileId,
      is_current: true,
      status: 'approved', // straight to approved — no pending_review gate
      previous_version_id: previousVersion.id,
    });

    // Unlike Regulatory's replace(), the slot's file_id/version ARE updated
    // here — this table does not have the "slot-staleness" defect.
    const slotUpdateArgs = callArgsOf(stubs[6], 'update');
    expect(slotUpdateArgs).toMatchObject({ file_id: newFileId, version: 'v2' });

    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'staff_document.replaced', company_id: COMPANY_ID }),
    );
  });

  it('throws DatabaseError when the storage upload itself fails during replace', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const previousVersion = baseVersion({ id: 'version-a-uuid' });
    const client = makeSupabaseClientWithStorage(
      [
        { data: baseCredential({ status: 'current' }) },
        { data: null }, // checksum lookup
        { data: previousVersion }, // getCurrentVersion
        { data: null }, // supersede
      ],
      { upload: vi.fn().mockResolvedValue({ data: null, error: { message: 'storage down' } }) },
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      StaffCredentialService.replace(
        STAFF_DOC_ID,
        makeFile('cv-v2.pdf', 'content'),
        { replacement_reason: 'renewal' },
        makeCtx(),
      ),
    ).rejects.toThrow('Staff credential upload failed');
  });
});

// ── Sub-Milestone 3.2B: Document Center retrofit for replace() ─────────────

describe('StaffCredentialService.replace — Document Center retrofit', () => {
  function successClient(newFileId: string, siteId: string | null = SITE_ID) {
    const previousVersion = baseVersion({
      id: 'version-a-uuid',
      version: 'v1',
      file_id: 'file-a-uuid',
    });
    return makeSupabaseClientWithStorage([
      { data: baseCredential({ status: 'current', site_id: siteId }) }, // getStaffDocumentOrThrow
      { data: null }, // checksum lookup — no match
      { data: previousVersion }, // getCurrentVersion
      { data: null }, // supersede previous version
      { data: { id: newFileId } }, // files insert
      { data: null }, // document_versions insert
      {
        data: baseCredential({
          status: 'current',
          file_id: newFileId,
          version: 'v2',
          site_id: siteId,
        }),
      }, // slot update
      { data: null }, // history (supersede)
      { data: null }, // history (new version)
    ]);
  }

  it('I/K/L: calls relinkForModule exactly once, with module=staff_documents and the correct logical record_id', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const relinkSpy = vi.spyOn(FileService, 'relinkForModule').mockResolvedValue({} as FileLink);
    const newFileId = 'file-b-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(successClient(newFileId));

    await StaffCredentialService.replace(
      STAFF_DOC_ID,
      makeFile('cv-v2.pdf', 'new content'),
      { replacement_reason: 'annual renewal' },
      makeCtx(),
    );

    expect(relinkSpy).toHaveBeenCalledTimes(1);
    expect(relinkSpy).toHaveBeenCalledWith(
      {
        file_id: newFileId,
        module: 'staff_documents',
        record_id: STAFF_DOC_ID,
        site_id: SITE_ID,
      },
      expect.anything(),
    );
  });

  it('J: passes the exact new fileId from uploadFile() — never the previous/stale file identifier', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const relinkSpy = vi.spyOn(FileService, 'relinkForModule').mockResolvedValue({} as FileLink);
    const newFileId = 'distinct-file-b-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(successClient(newFileId));

    await StaffCredentialService.replace(
      STAFF_DOC_ID,
      makeFile('cv-v2.pdf', 'new content'),
      { replacement_reason: 'annual renewal' },
      makeCtx(),
    );

    const callArgs = relinkSpy.mock.calls[0]?.[0];
    expect(callArgs?.file_id).toBe(newFileId);
    expect(callArgs?.file_id).not.toBe('file-a-uuid'); // the superseded version's file
  });

  it('M: passes the authoritative site_id from the staff credential, including null for a company-wide credential', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const relinkSpy = vi.spyOn(FileService, 'relinkForModule').mockResolvedValue({} as FileLink);
    const newFileId = 'file-b-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(successClient(newFileId, null));

    await StaffCredentialService.replace(
      STAFF_DOC_ID,
      makeFile('cv-v2.pdf', 'new content'),
      { replacement_reason: 'annual renewal' },
      makeCtx(),
    );

    expect(relinkSpy).toHaveBeenCalledWith(
      expect.objectContaining({ site_id: null }),
      expect.anything(),
    );
  });

  it('N: still succeeds and returns the finalized credential when relinkForModule fails (failure is logged, not swallowed silently, and never rolled back)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(FileService, 'relinkForModule').mockRejectedValue(
      new Error('file_links relink failed'),
    );
    const newFileId = 'file-b-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(successClient(newFileId));

    const result = await StaffCredentialService.replace(
      STAFF_DOC_ID,
      makeFile('cv-v2.pdf', 'new content'),
      { replacement_reason: 'annual renewal' },
      makeCtx(),
    );

    expect(result).not.toHaveProperty('duplicate_detected');
    const credential = result as StaffDocument;
    expect(credential.file_id).toBe(newFileId);
  });

  it('O: existing replacement semantics (permission, archived-block, reason-required, duplicate-checksum, slot file_id sync) remain unchanged by the retrofit', async () => {
    // Permission enforcement — unaffected by relinkForModule.
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('manage_staff_credentials'),
    );
    await expect(
      StaffCredentialService.replace(
        STAFF_DOC_ID,
        makeFile('cv.pdf', 'content'),
        { replacement_reason: 'test' },
        makeCtx(),
      ),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it('P: never exposes a public URL from the Document Center relink', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(FileService, 'relinkForModule').mockResolvedValue({
      id: 'link-uuid',
      company_id: COMPANY_ID,
      file_id: 'file-b-uuid',
      site_id: SITE_ID,
      module: 'staff_documents',
      record_id: STAFF_DOC_ID,
      created_by: USER_ID,
      created_at: new Date().toISOString(),
    } as FileLink);
    const newFileId = 'file-b-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(successClient(newFileId));

    const result = await StaffCredentialService.replace(
      STAFF_DOC_ID,
      makeFile('cv-v2.pdf', 'new content'),
      { replacement_reason: 'annual renewal' },
      makeCtx(),
    );

    expect(result).not.toHaveProperty('url');
    expect(result).not.toHaveProperty('signedUrl');
    expect(result).not.toHaveProperty('publicUrl');
  });
});

// ── archive() ────────────────────────────────────────────────────────────

describe('StaffCredentialService.archive', () => {
  it('throws PermissionDeniedError without manage_staff_credentials', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('manage_staff_credentials'),
    );

    await expect(
      StaffCredentialService.archive(STAFF_DOC_ID, { reason: 'no longer needed' }, makeCtx()),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it('throws NotFoundError for a credential belonging to a different company (company isolation)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: null, error: { message: 'no rows' } }),
    );

    await expect(
      StaffCredentialService.archive(STAFF_DOC_ID, { reason: 'no longer needed' }, makeCtx()),
    ).rejects.toThrow(NotFoundError);
  });

  it('marks the current version archived/not-current, archives the slot, and writes history + audit', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const currentVersion = baseVersion({ id: 'version-a-uuid' });
    const { client, stubs } = makeSupabaseClientWithCapture([
      { data: baseCredential({ status: 'current' }) }, // getStaffDocumentOrThrow
      { data: currentVersion }, // getCurrentVersion
      { data: null }, // document_versions update (archived)
      { data: baseCredential({ status: 'archived' }) }, // slot update
      { data: null }, // document_history insert
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await StaffCredentialService.archive(
      STAFF_DOC_ID,
      { reason: 'staff member departed' },
      makeCtx(),
    );

    expect(result.status).toBe('archived');
    const versionUpdateArgs = callArgsOf(stubs[2], 'update');
    expect(versionUpdateArgs).toMatchObject({ status: 'archived', is_current: false });
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'staff_document.archived', company_id: COMPANY_ID }),
    );
  });

  it('still archives the slot when there is no current version on file (e.g. an already-lapsed credential)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeSupabaseClient(
      { data: baseCredential({ status: 'missing' }) }, // getStaffDocumentOrThrow
      { data: null }, // getCurrentVersion — none
      { data: baseCredential({ status: 'archived' }) }, // slot update
      { data: null }, // document_history insert
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await StaffCredentialService.archive(
      STAFF_DOC_ID,
      { reason: 'no longer relevant' },
      makeCtx(),
    );

    expect(result.status).toBe('archived');
  });
});

// ── listForUser ──────────────────────────────────────────────────────────

describe('StaffCredentialService.listForUser', () => {
  it('does not require view_staff_credentials when a user lists their own credentials', async () => {
    const requirePermissionSpy = vi.spyOn(PermissionService, 'requirePermission');
    vi.mocked(createServerSupabaseClient).mockResolvedValue(makeSupabaseClient({ data: [] }));

    await StaffCredentialService.listForUser(USER_ID, makeCtx());

    expect(requirePermissionSpy).not.toHaveBeenCalled();
  });

  it('requires view_staff_credentials when listing another user’s credentials', async () => {
    const requirePermissionSpy = vi
      .spyOn(PermissionService, 'requirePermission')
      .mockRejectedValue(new PermissionDeniedError('view_staff_credentials'));

    await expect(StaffCredentialService.listForUser(CREDENTIAL_USER_ID, makeCtx())).rejects.toThrow(
      PermissionDeniedError,
    );
    expect(requirePermissionSpy).toHaveBeenCalledWith(USER_ID, 'view_staff_credentials');
  });

  it("scopes results to the caller's company and the requested user", async () => {
    const { client, stubs } = makeSupabaseClientWithCapture([{ data: [] }]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await StaffCredentialService.listForUser(USER_ID, makeCtx());

    expect(stubs[0]?.eq).toHaveBeenCalledWith('company_id', COMPANY_ID);
    expect(stubs[0]?.eq).toHaveBeenCalledWith('user_id', USER_ID);
  });
});

// ── listVersions / listHistory ──────────────────────────────────────────

describe('StaffCredentialService.listVersions', () => {
  it('throws PermissionDeniedError without view_staff_credentials', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('view_staff_credentials'),
    );

    await expect(StaffCredentialService.listVersions(STAFF_DOC_ID, makeCtx())).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it('throws NotFoundError for a credential belonging to a different company', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      makeSupabaseClient({ data: null, error: { message: 'no rows' } }),
    );

    await expect(StaffCredentialService.listVersions(STAFF_DOC_ID, makeCtx())).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe('StaffCredentialService.listHistory', () => {
  it('throws PermissionDeniedError without view_regulatory_audit', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('view_regulatory_audit'),
    );

    await expect(StaffCredentialService.listHistory(STAFF_DOC_ID, makeCtx())).rejects.toThrow(
      PermissionDeniedError,
    );
  });
});
