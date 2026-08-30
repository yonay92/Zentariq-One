import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import {
  RegulatoryDocumentService,
  computeSlotStatus,
} from '@/services/regulatory/RegulatoryDocumentService';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import { FileService } from '@/services/files/FileService';
import { PermissionDeniedError, BusinessRuleError, NotFoundError } from '@/lib/api/errors';
import type { RegulatoryDocument, DocumentVersion } from '@/types/regulatory';
import type { FileLink } from '@/types/files';

vi.mock('@/services/audit/AuditService', () => ({
  AuditService: { log: vi.fn() },
}));

const COMPANY_ID = 'company-uuid';
const SITE_ID = 'site-uuid';
const DOCUMENT_ID = 'document-uuid';
const USER_ID = 'user-uuid';

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

function baseDocument(overrides: Partial<RegulatoryDocument> = {}): RegulatoryDocument {
  return {
    id: DOCUMENT_ID,
    company_id: COMPANY_ID,
    site_id: SITE_ID,
    study_id: null,
    document_type_id: 'doctype-uuid',
    file_id: 'file-uuid',
    document_name: '1572 Form',
    version: 'v1',
    effective_date: null,
    expiration_date: null,
    status: 'pending_review',
    uploaded_by: USER_ID,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function baseVersion(overrides: Partial<DocumentVersion> = {}): DocumentVersion {
  return {
    id: 'version-uuid',
    company_id: COMPANY_ID,
    document_id: DOCUMENT_ID,
    staff_document_id: null,
    previous_version_id: null,
    version: 'v1',
    file_id: 'file-uuid',
    file: null,
    checksum: 'abc123',
    is_current: true,
    status: 'pending_review',
    effective_date: null,
    expiration_date: null,
    replacement_reason: null,
    duplicate_of_version_id: null,
    uploaded_by: USER_ID,
    uploaded_at: new Date().toISOString(),
    reviewed_by: null,
    reviewed_at: null,
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

// The original makeSupabaseClient above has no `storage` property at all, so
// it cannot support any test that reaches uploadFile()'s
// supabase.storage.from(BUCKET).upload() call — which is every test of
// create()'s or replace()'s actual successful path. This separate,
// array-argument variant adds that support without touching the original
// (used by every pre-existing test in this file, left byte-for-byte
// unchanged) or its calling convention.
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
// per-.from()-call stub objects so a test can inspect exactly what a
// specific insert() call (e.g. "the document_versions insert for the new
// version") was invoked with — used by the is_current regression tests
// below, which must assert on the literal insert payload, not just the
// method's final return value.
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

// Reads the first argument of a stub's Nth call to insert()/update() —
// pulls the mock out of the untyped `Record<string, unknown>` queryStub
// shape used throughout this file.
function callArgsOf(
  stub: Record<string, unknown> | undefined,
  method: 'insert' | 'update',
  callIndex = 0,
): unknown {
  const fn = stub?.[method] as ReturnType<typeof vi.fn> | undefined;
  return fn?.mock.calls[callIndex]?.[0];
}

// jsdom's File implementation doesn't provide arrayBuffer() — build a
// minimal stand-in with the handful of properties/methods the service
// actually reads, rather than relying on a real File in this test environment.
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

describe('computeSlotStatus', () => {
  it('returns current when there is no expiration date', () => {
    expect(computeSlotStatus(null)).toBe('current');
  });

  it('returns current when expiration is far in the future', () => {
    const future = new Date();
    future.setDate(future.getDate() + 200);
    expect(computeSlotStatus(future.toISOString().slice(0, 10))).toBe('current');
  });

  it('returns expiring_soon within the 90-day default threshold', () => {
    const soon = new Date();
    soon.setDate(soon.getDate() + 45);
    expect(computeSlotStatus(soon.toISOString().slice(0, 10))).toBe('expiring_soon');
  });

  it('returns expired for a past date', () => {
    const past = new Date();
    past.setDate(past.getDate() - 5);
    expect(computeSlotStatus(past.toISOString().slice(0, 10))).toBe('expired');
  });
});

describe('RegulatoryDocumentService permission gating', () => {
  it('approve() throws PermissionDeniedError without edit_regulatory_document', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('edit_regulatory_document'),
    );
    await expect(RegulatoryDocumentService.approve(DOCUMENT_ID, makeCtx())).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it('archive() throws PermissionDeniedError without archive_regulatory_document', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('archive_regulatory_document'),
    );
    await expect(
      RegulatoryDocumentService.archive(DOCUMENT_ID, { reason: 'no longer needed' }, makeCtx()),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it('overrideStatus() throws PermissionDeniedError without override_regulatory_status', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('override_regulatory_status'),
    );
    await expect(
      RegulatoryDocumentService.overrideStatus(
        DOCUMENT_ID,
        { new_status: 'current', reason: 'manual fix' },
        makeCtx(),
      ),
    ).rejects.toThrow(PermissionDeniedError);
  });
});

describe('RegulatoryDocumentService.getById', () => {
  it('throws NotFoundError when the document does not exist in this company', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(makeSupabaseClient({ data: null }));

    await expect(RegulatoryDocumentService.getById(DOCUMENT_ID, makeCtx())).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe('RegulatoryDocumentService.approve', () => {
  it('throws BusinessRuleError when the document is not pending_review', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeSupabaseClient({ data: baseDocument({ status: 'current' }) });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(RegulatoryDocumentService.approve(DOCUMENT_ID, makeCtx())).rejects.toThrow(
      BusinessRuleError,
    );
  });

  it('computes expiring_soon status and audits the approval when expiration is near', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const soon = new Date();
    soon.setDate(soon.getDate() + 10);
    const soonDate = soon.toISOString().slice(0, 10);

    const client = makeSupabaseClient(
      { data: baseDocument({ status: 'pending_review' }) }, // getDocumentOrThrow
      { data: baseVersion({ expiration_date: soonDate }) }, // getCurrentVersion
      { data: null }, // document_versions update
      { data: baseDocument({ status: 'expiring_soon' }) }, // regulatory_documents update
      { data: null }, // document_history insert
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await RegulatoryDocumentService.approve(DOCUMENT_ID, makeCtx());
    expect(result.status).toBe('expiring_soon');
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'regulatory_document.approved' }),
    );
  });
});

describe('RegulatoryDocumentService.reject', () => {
  it('throws BusinessRuleError when the document is not pending_review', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeSupabaseClient({ data: baseDocument({ status: 'draft' }) });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      RegulatoryDocumentService.reject(DOCUMENT_ID, { reason: 'incomplete' }, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });
});

describe('RegulatoryDocumentService.replace', () => {
  it('throws BusinessRuleError when no replacement_reason is given', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeSupabaseClient({ data: baseDocument({ status: 'current' }) });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const file = makeFile('doc.pdf', 'content');
    await expect(
      RegulatoryDocumentService.replace(DOCUMENT_ID, file, {}, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('throws BusinessRuleError when the document is archived', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeSupabaseClient({ data: baseDocument({ status: 'archived' }) });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const file = new File(['content'], 'doc.pdf', { type: 'application/pdf' });
    await expect(
      RegulatoryDocumentService.replace(
        DOCUMENT_ID,
        file,
        { replacement_reason: 'updated version' },
        makeCtx(),
      ),
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
    const client = makeSupabaseClient(
      { data: baseDocument({ status: 'current' }) }, // getDocumentOrThrow
      { data: matchingVersion }, // checksum lookup — match found
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const file = makeFile('doc.pdf', 'identical content');
    const result = await RegulatoryDocumentService.replace(
      DOCUMENT_ID,
      file,
      { replacement_reason: 'renewal' },
      makeCtx(),
    );

    expect(result).toMatchObject({
      duplicate_detected: true,
      matching_version: { id: 'existing-version-uuid' },
    });
  });
});

// ── Baseline: create()'s full successful path (Sub-Milestone 3.1) ──────────
//
// Neither create() nor replace() previously had a test exercising their full
// successful path — both reach uploadFile()'s supabase.storage.from(BUCKET)
// call, which the original makeSupabaseClient() (no `storage` property)
// could not support. These baseline tests establish the exact pre-retrofit
// behavior being preserved, per Sub-Milestone 3.1's requirement to prove
// current behavior before modifying either method.

describe('RegulatoryDocumentService.create — baseline (pre- and post-retrofit)', () => {
  it('throws PermissionDeniedError without upload_regulatory_document', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('upload_regulatory_document'),
    );

    const file = makeFile('form.pdf', 'content');
    await expect(
      RegulatoryDocumentService.create(
        { document_type_id: 'doctype-uuid', document_name: '1572 Form' },
        file,
        makeCtx(),
      ),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it('requires site access when site_id is supplied', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const requireSiteAccessSpy = vi
      .spyOn(PermissionService, 'requireSiteAccess')
      .mockRejectedValue(new PermissionDeniedError(`site:${SITE_ID}`));

    const file = makeFile('form.pdf', 'content');
    await expect(
      RegulatoryDocumentService.create(
        { document_type_id: 'doctype-uuid', document_name: '1572 Form', site_id: SITE_ID },
        file,
        makeCtx(),
      ),
    ).rejects.toThrow(PermissionDeniedError);
    expect(requireSiteAccessSpy).toHaveBeenCalledWith(USER_ID, SITE_ID);
  });

  it('throws BusinessRuleError when a document already exists for this type/scope (duplicate slot)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeSupabaseClient({
      data: null,
      error: { code: '23505', message: 'duplicate key' },
    });
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const file = makeFile('form.pdf', 'content');
    await expect(
      RegulatoryDocumentService.create(
        { document_type_id: 'doctype-uuid', document_name: '1572 Form' },
        file,
        makeCtx(),
      ),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('uploads the file, creates the slot + v1 version, and returns the finalized pending_review document (existing response shape)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const newFileId = 'new-file-uuid';
    const client = makeSupabaseClientWithStorage([
      { data: baseDocument({ status: 'draft', file_id: null, version: null }) }, // 1. slot insert
      { data: { id: newFileId } }, // 2. files insert (uploadFile)
      { data: null }, // 3. document_versions insert
      { data: baseDocument({ status: 'pending_review', file_id: newFileId, version: 'v1' }) }, // 4. regulatory_documents finalize update
      { data: null }, // 5. document_history insert (writeHistory)
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const file = makeFile('form.pdf', 'content');
    const result = await RegulatoryDocumentService.create(
      { document_type_id: 'doctype-uuid', document_name: '1572 Form' },
      file,
      makeCtx(),
    );

    // Existing response shape: the full RegulatoryDocument row, finalized.
    expect(result.status).toBe('pending_review');
    expect(result.file_id).toBe(newFileId);
    expect(result.version).toBe('v1');
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'regulatory_document.uploaded', company_id: COMPANY_ID }),
    );
  });
});

// ── Sub-Milestone 3.1: Document Center retrofit for create() ───────────────

describe('RegulatoryDocumentService.create — Document Center retrofit', () => {
  function successClient(newFileId: string, siteId: string | null = SITE_ID) {
    return makeSupabaseClientWithStorage([
      { data: baseDocument({ status: 'draft', file_id: null, version: null, site_id: siteId }) },
      { data: { id: newFileId } },
      { data: null },
      {
        data: baseDocument({
          status: 'pending_review',
          file_id: newFileId,
          version: 'v1',
          site_id: siteId,
        }),
      },
      { data: null },
    ]);
  }

  it('links the uploaded file to the Document Center with the canonical module and record identifiers', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const linkSpy = vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const newFileId = 'new-file-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(successClient(newFileId));

    const file = makeFile('form.pdf', 'content');
    const result = await RegulatoryDocumentService.create(
      { document_type_id: 'doctype-uuid', document_name: '1572 Form' },
      file,
      makeCtx(),
    );

    expect(linkSpy).toHaveBeenCalledWith(
      {
        file_id: newFileId,
        module: 'regulatory_documents',
        record_id: result.id,
        site_id: SITE_ID,
      },
      expect.anything(),
    );
  });

  it('does not duplicate or reconstruct identifiers — uses the actual file_id and document.id produced by the existing flow', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const linkSpy = vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const newFileId = 'distinct-file-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(successClient(newFileId));

    await RegulatoryDocumentService.create(
      { document_type_id: 'doctype-uuid', document_name: '1572 Form' },
      makeFile('form.pdf', 'content'),
      makeCtx(),
    );

    const callArgs = linkSpy.mock.calls[0]?.[0];
    expect(callArgs?.file_id).toBe(newFileId); // the exact id uploadFile() produced
    expect(callArgs?.record_id).toBe(DOCUMENT_ID); // the exact regulatory_documents.id
  });

  it('still succeeds and returns the finalized document when linkForModule fails (failure is logged, not swallowed silently, and never rolled back)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(FileService, 'linkForModule').mockRejectedValue(new Error('file_links insert failed'));
    const newFileId = 'new-file-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(successClient(newFileId));

    const result = await RegulatoryDocumentService.create(
      { document_type_id: 'doctype-uuid', document_name: '1572 Form' },
      makeFile('form.pdf', 'content'),
      makeCtx(),
    );

    // The Regulatory write is unaffected by a Document Center linking failure.
    expect(result.status).toBe('pending_review');
    expect(result.file_id).toBe(newFileId);
  });

  it('passes site_id: null for a company-wide document (no site scope)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const linkSpy = vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const newFileId = 'new-file-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(successClient(newFileId, null));

    await RegulatoryDocumentService.create(
      { document_type_id: 'doctype-uuid', document_name: '1572 Form' },
      makeFile('form.pdf', 'content'),
      makeCtx(),
    );

    expect(linkSpy).toHaveBeenCalledWith(
      expect.objectContaining({ site_id: null }),
      expect.anything(),
    );
  });
});

describe('RegulatoryDocumentService.replace — baseline (pre- and post-retrofit)', () => {
  it('uploads the new file, supersedes the previous version, and returns the finalized pending_review document (existing response shape)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(FileService, 'relinkForModule').mockResolvedValue({} as FileLink);
    const previousVersion = baseVersion({
      id: 'version-a-uuid',
      version: 'v1',
      file_id: 'file-a-uuid',
    });
    const newFileId = 'file-b-uuid';
    const client = makeSupabaseClientWithStorage([
      { data: baseDocument({ status: 'current' }) }, // 1. getDocumentOrThrow
      { data: null }, // 2. checksum lookup — no match, proceed
      { data: previousVersion }, // 3. getCurrentVersion
      { data: null }, // 4. supersede previous version update
      { data: { id: newFileId } }, // 5. files insert (uploadFile)
      { data: null }, // 6. document_versions insert (new version)
      { data: baseDocument({ status: 'pending_review', file_id: newFileId, version: 'v2' }) }, // 7. regulatory_documents finalize update
      { data: null }, // 8. document_history insert (supersede)
      { data: null }, // 9. document_history insert (new pending_review)
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const file = makeFile('form-v2.pdf', 'new content');
    const result = await RegulatoryDocumentService.replace(
      DOCUMENT_ID,
      file,
      { replacement_reason: 'annual renewal' },
      makeCtx(),
    );

    // Existing response shape: the full RegulatoryDocument row (not the
    // DuplicateChecksumWarning branch), finalized on the new version.
    expect(result).not.toHaveProperty('duplicate_detected');
    const document = result as RegulatoryDocument;
    expect(document.status).toBe('pending_review');
    expect(document.file_id).toBe(newFileId);
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'regulatory_document.replaced', company_id: COMPANY_ID }),
    );
  });
});

// ── Sub-Milestone 3.1b: Document Center retrofit for replace() ─────────────
//
// Mirrors create()'s Document Center retrofit tests above, but for
// relinkForModule instead of linkForModule: the relink call must happen
// only AFTER replace()'s own Regulatory writes have already succeeded (see
// successClient below — the relink spy is asserted against calls made once
// the full 9-step client sequence has already resolved), must carry the
// exact file_id/record_id/site_id the existing flow produced, and must
// never block or roll back an otherwise-successful replace() when it fails.

describe('RegulatoryDocumentService.replace — Document Center retrofit (Sub-Milestone 3.1b)', () => {
  function successClient(newFileId: string, siteId: string | null = SITE_ID) {
    const previousVersion = baseVersion({
      id: 'version-a-uuid',
      version: 'v1',
      file_id: 'file-a-uuid',
    });
    return makeSupabaseClientWithStorage([
      { data: baseDocument({ status: 'current', site_id: siteId }) }, // 1. getDocumentOrThrow
      { data: null }, // 2. checksum lookup — no match, proceed
      { data: previousVersion }, // 3. getCurrentVersion
      { data: null }, // 4. supersede previous version update
      { data: { id: newFileId } }, // 5. files insert (uploadFile)
      { data: null }, // 6. document_versions insert (new version)
      {
        data: baseDocument({
          status: 'pending_review',
          file_id: newFileId,
          version: 'v2',
          site_id: siteId,
        }),
      }, // 7. regulatory_documents finalize update
      { data: null }, // 8. document_history insert (supersede)
      { data: null }, // 9. document_history insert (new pending_review)
    ]);
  }

  it('relinks the Document Center to the new file with the canonical module/record/site identifiers', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const relinkSpy = vi.spyOn(FileService, 'relinkForModule').mockResolvedValue({} as FileLink);
    const newFileId = 'file-b-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(successClient(newFileId));

    const result = await RegulatoryDocumentService.replace(
      DOCUMENT_ID,
      makeFile('form-v2.pdf', 'new content'),
      { replacement_reason: 'annual renewal' },
      makeCtx(),
    );
    const document = result as RegulatoryDocument;

    expect(relinkSpy).toHaveBeenCalledWith(
      {
        file_id: newFileId,
        module: 'regulatory_documents',
        record_id: document.id,
        site_id: SITE_ID,
      },
      expect.anything(),
    );
  });

  it('does not duplicate or reconstruct identifiers — uses the actual replacement file_id and document.id produced by the existing flow', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const relinkSpy = vi.spyOn(FileService, 'relinkForModule').mockResolvedValue({} as FileLink);
    const newFileId = 'distinct-file-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(successClient(newFileId));

    await RegulatoryDocumentService.replace(
      DOCUMENT_ID,
      makeFile('form-v2.pdf', 'new content'),
      { replacement_reason: 'annual renewal' },
      makeCtx(),
    );

    const callArgs = relinkSpy.mock.calls[0]?.[0];
    expect(callArgs?.file_id).toBe(newFileId); // the exact id uploadFile() produced for the replacement
    expect(callArgs?.record_id).toBe(DOCUMENT_ID); // the exact regulatory_documents.id, unchanged by replace()
  });

  it('passes the authoritative site_id from the regulatory document, including null for a company-wide document', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const relinkSpy = vi.spyOn(FileService, 'relinkForModule').mockResolvedValue({} as FileLink);
    const newFileId = 'file-b-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(successClient(newFileId, null));

    await RegulatoryDocumentService.replace(
      DOCUMENT_ID,
      makeFile('form-v2.pdf', 'new content'),
      { replacement_reason: 'annual renewal' },
      makeCtx(),
    );

    expect(relinkSpy).toHaveBeenCalledWith(
      expect.objectContaining({ site_id: null }),
      expect.anything(),
    );
  });

  it('still succeeds and returns the finalized document when relinkForModule fails (failure is logged, not swallowed silently, and never rolled back)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(FileService, 'relinkForModule').mockRejectedValue(
      new Error('file_links relink failed'),
    );
    const newFileId = 'file-b-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(successClient(newFileId));

    const result = await RegulatoryDocumentService.replace(
      DOCUMENT_ID,
      makeFile('form-v2.pdf', 'new content'),
      { replacement_reason: 'annual renewal' },
      makeCtx(),
    );

    // The Regulatory replacement is unaffected by a Document Center relink failure.
    expect(result).not.toHaveProperty('duplicate_detected');
    const document = result as RegulatoryDocument;
    expect(document.status).toBe('pending_review');
    expect(document.file_id).toBe(newFileId);
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'regulatory_document.replaced' }),
    );
  });

  it('never exposes a public URL from the Document Center relink', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(FileService, 'relinkForModule').mockResolvedValue({
      id: 'link-uuid',
      company_id: COMPANY_ID,
      file_id: 'file-b-uuid',
      site_id: SITE_ID,
      module: 'regulatory_documents',
      record_id: DOCUMENT_ID,
      created_by: USER_ID,
      created_at: new Date().toISOString(),
    } as FileLink);
    const newFileId = 'file-b-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(successClient(newFileId));

    const result = await RegulatoryDocumentService.replace(
      DOCUMENT_ID,
      makeFile('form-v2.pdf', 'new content'),
      { replacement_reason: 'annual renewal' },
      makeCtx(),
    );

    expect(result).not.toHaveProperty('url');
    expect(result).not.toHaveProperty('signedUrl');
    expect(result).not.toHaveProperty('publicUrl');
  });

  it('archive() still succeeds on a document that was previously replaced — relink is isolated to file_links and never touches regulatory_documents/document_versions state', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const replacedVersion = baseVersion({
      id: 'version-b-uuid',
      version: 'v2',
      previous_version_id: 'version-a-uuid',
      status: 'pending_review',
    });
    const client = makeSupabaseClient(
      { data: baseDocument({ status: 'pending_review' }) }, // getDocumentOrThrow
      { data: replacedVersion }, // getCurrentVersion → the replaced version, correctly current
      { data: null }, // document_versions update (archived)
      { data: baseDocument({ status: 'archived' }) }, // regulatory_documents update
      { data: null }, // document_history insert
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await RegulatoryDocumentService.archive(
      DOCUMENT_ID,
      { reason: 'study closed' },
      makeCtx(),
    );
    expect(result.status).toBe('archived');
  });
});

// ── Sub-Milestone 3.1a: is_current correctness fix ──────────────────────────
//
// Proves the required invariant precisely: exactly one version is current
// after create(), after replace(), and after replace() again; the newest
// successful replacement is the current version; all superseded versions
// are not current. Each scenario is verified by inspecting the literal
// insert/update payloads replace() sends, not just its return value —
// the previous bug (is_current: false on the new version) was invisible
// from the return value alone, since replace() never re-reads is_current
// from what it just wrote.

describe('RegulatoryDocumentService — is_current invariant (Sub-Milestone 3.1a)', () => {
  it('A: create() writes the first version with is_current: true', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const newFileId = 'file-a-uuid';
    const { client, stubs } = makeSupabaseClientWithCapture([
      { data: baseDocument({ status: 'draft', file_id: null, version: null }) }, // 0. slot insert
      { data: { id: newFileId } }, // 1. files insert
      { data: null }, // 2. document_versions insert (version A)
      { data: baseDocument({ status: 'pending_review', file_id: newFileId, version: 'v1' }) }, // 3. finalize update
      { data: null }, // 4. document_history insert
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await RegulatoryDocumentService.create(
      { document_type_id: 'doctype-uuid', document_name: '1572 Form' },
      makeFile('form.pdf', 'content'),
      makeCtx(),
    );

    const versionInsertArgs = callArgsOf(stubs[2], 'insert');
    expect(versionInsertArgs).toMatchObject({ version: 'v1', is_current: true });
  });

  it('B: first replace() writes the previous version as not-current and the new version as current — exactly one current version', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(FileService, 'relinkForModule').mockResolvedValue({} as FileLink);
    const versionA = baseVersion({ id: 'version-a-uuid', version: 'v1', file_id: 'file-a-uuid' });
    const fileB = 'file-b-uuid';
    const { client, stubs } = makeSupabaseClientWithCapture([
      { data: baseDocument({ status: 'current' }) }, // 0. getDocumentOrThrow
      { data: null }, // 1. checksum lookup — no match
      { data: versionA }, // 2. getCurrentVersion → A (is_current: true)
      { data: null }, // 3. supersede A
      { data: { id: fileB } }, // 4. files insert
      { data: null }, // 5. document_versions insert (version B)
      { data: baseDocument({ status: 'pending_review', file_id: fileB, version: 'v2' }) }, // 6. finalize
      { data: null }, // 7. document_history insert (supersede)
      { data: null }, // 8. document_history insert (pending_review)
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await RegulatoryDocumentService.replace(
      DOCUMENT_ID,
      makeFile('form-v2.pdf', 'content b'),
      { replacement_reason: 'first replacement' },
      makeCtx(),
    );

    // A is superseded and explicitly marked not current.
    const supersedeArgs = callArgsOf(stubs[3], 'update');
    expect(supersedeArgs).toMatchObject({ is_current: false, status: 'superseded' });

    // B is inserted as current — this is the exact line the bug was on.
    const versionInsertArgs = callArgsOf(stubs[5], 'insert');
    expect(versionInsertArgs).toMatchObject({
      version: 'v2',
      file_id: fileB,
      is_current: true,
      previous_version_id: versionA.id,
    });

    // By construction, replace() supersedes exactly one existing row and
    // inserts exactly one new is_current: true row per call — no other code
    // path sets is_current, so "exactly one current version" holds after
    // this call for this document by the two assertions above.
  });

  it('C: second replace() on the same document finds B via getCurrentVersion (the fix), supersedes B, and makes C current — this call used to throw BusinessRuleError before the fix', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.spyOn(FileService, 'relinkForModule').mockResolvedValue({} as FileLink);
    // Simulates the document's state exactly as B's replace() (test above)
    // left it, now that the fix means B was actually written as is_current: true.
    const versionB = baseVersion({
      id: 'version-b-uuid',
      version: 'v2',
      file_id: 'file-b-uuid',
      previous_version_id: 'version-a-uuid',
      status: 'pending_review',
    });
    const fileC = 'file-c-uuid';
    const { client, stubs } = makeSupabaseClientWithCapture([
      { data: baseDocument({ status: 'pending_review' }) }, // 0. getDocumentOrThrow
      { data: null }, // 1. checksum lookup — no match
      { data: versionB }, // 2. getCurrentVersion → B (is_current: true, thanks to the fix)
      { data: null }, // 3. supersede B
      { data: { id: fileC } }, // 4. files insert
      { data: null }, // 5. document_versions insert (version C)
      { data: baseDocument({ status: 'pending_review', file_id: fileC, version: 'v3' }) }, // 6. finalize
      { data: null }, // 7. document_history insert (supersede)
      { data: null }, // 8. document_history insert (pending_review)
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    // Does not throw — proves getCurrentVersion() successfully located B.
    const result = await RegulatoryDocumentService.replace(
      DOCUMENT_ID,
      makeFile('form-v3.pdf', 'content c'),
      { replacement_reason: 'second replacement' },
      makeCtx(),
    );
    expect(result).not.toHaveProperty('duplicate_detected');

    // B is superseded and explicitly marked not current.
    const supersedeArgs = callArgsOf(stubs[3], 'update');
    expect(supersedeArgs).toMatchObject({ is_current: false, status: 'superseded' });

    // C is inserted as current, chained from B.
    const versionInsertArgs = callArgsOf(stubs[5], 'insert');
    expect(versionInsertArgs).toMatchObject({
      version: 'v3',
      file_id: fileC,
      is_current: true,
      previous_version_id: versionB.id,
    });
  });

  it('D: approve() succeeds on the current replaced version (previously blocked — getCurrentVersion() returned null)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const replacedVersion = baseVersion({
      id: 'version-b-uuid',
      version: 'v2',
      previous_version_id: 'version-a-uuid',
      status: 'pending_review',
    });
    const client = makeSupabaseClient(
      { data: baseDocument({ status: 'pending_review' }) }, // getDocumentOrThrow
      { data: replacedVersion }, // getCurrentVersion → the replaced version, now correctly current
      { data: null }, // document_versions update (approved)
      { data: baseDocument({ status: 'current' }) }, // regulatory_documents update
      { data: null }, // document_history insert
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await RegulatoryDocumentService.approve(DOCUMENT_ID, makeCtx());
    expect(result.status).toBe('current');
  });

  it('D: reject() succeeds on the current replaced version (previously blocked — getCurrentVersion() returned null)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const replacedVersion = baseVersion({
      id: 'version-b-uuid',
      version: 'v2',
      previous_version_id: 'version-a-uuid',
      status: 'pending_review',
    });
    const client = makeSupabaseClient(
      { data: baseDocument({ status: 'pending_review' }) }, // getDocumentOrThrow
      { data: replacedVersion }, // getCurrentVersion → the replaced version, now correctly current
      { data: null }, // document_versions update (rejected)
      { data: baseDocument({ status: 'rejected' }) }, // regulatory_documents update
      { data: null }, // document_history insert
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await RegulatoryDocumentService.reject(
      DOCUMENT_ID,
      { reason: 'incorrect version' },
      makeCtx(),
    );
    expect(result.status).toBe('rejected');
  });

  it('E: existing permission enforcement is unchanged by the fix — replace() still requires upload_regulatory_document', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('upload_regulatory_document'),
    );

    await expect(
      RegulatoryDocumentService.replace(
        DOCUMENT_ID,
        makeFile('form.pdf', 'content'),
        { replacement_reason: 'test' },
        makeCtx(),
      ),
    ).rejects.toThrow(PermissionDeniedError);
  });
});
