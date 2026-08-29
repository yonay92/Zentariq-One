import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@/lib/supabase/admin';
import { FileService } from '@/services/files/FileService';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import { PermissionDeniedError, NotFoundError, DatabaseError } from '@/lib/api/errors';

vi.mock('@/services/audit/AuditService', () => ({
  AuditService: { log: vi.fn() },
}));

const COMPANY_ID = 'company-uuid';
const SITE_ID = 'site-uuid';
const USER_ID = 'user-uuid';
const FILE_ID = 'file-uuid';
const LINK_ID = 'link-uuid';

function makeCtx() {
  return {
    user: {
      id: USER_ID,
      company_id: COMPANY_ID,
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

function makeFile(overrides: Record<string, unknown> = {}) {
  return {
    id: FILE_ID,
    company_id: COMPANY_ID,
    file_name: 'protocol.pdf',
    original_name: 'protocol.pdf',
    file_extension: 'pdf',
    mime_type: 'application/pdf',
    file_size: 1024,
    storage_path: `${COMPANY_ID}/uuid_protocol.pdf`,
    uploaded_by: USER_ID,
    uploaded_at: '',
    checksum: 'abc123',
    ai_processed: false,
    ...overrides,
  };
}

function makeLink(overrides: Record<string, unknown> = {}) {
  return {
    id: LINK_ID,
    company_id: COMPANY_ID,
    file_id: FILE_ID,
    site_id: null,
    module: 'subjects',
    record_id: 'record-uuid',
    created_by: USER_ID,
    created_at: '',
    ...overrides,
  };
}

/** Mirrors VisitService.test.ts's queryStub/makeSupabaseClient pattern. */
function queryStub(data: unknown, error: unknown = null) {
  const resolved = Promise.resolve({ data, error });
  const stub: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    lte: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
    single: vi.fn().mockResolvedValue({ data, error }),
    then: resolved.then.bind(resolved),
    catch: resolved.catch.bind(resolved),
    finally: resolved.finally.bind(resolved),
  };
  for (const key of ['select', 'eq', 'not', 'in', 'order', 'gte', 'lte', 'insert', 'delete']) {
    (stub[key] as ReturnType<typeof vi.fn>).mockReturnValue(stub);
  }
  return stub;
}

function makeSupabaseClient(
  responses: Array<{ data: unknown; error?: unknown }>,
  storage?: { upload?: unknown; createSignedUrl?: unknown; remove?: unknown },
) {
  const from = vi.fn();
  for (const r of responses) {
    from.mockReturnValueOnce(queryStub(r.data, r.error ?? null));
  }
  const storageBucket = {
    upload: storage?.upload ?? vi.fn().mockResolvedValue({ data: {}, error: null }),
    createSignedUrl:
      storage?.createSignedUrl ??
      vi.fn().mockResolvedValue({ data: { signedUrl: 'https://signed.example/x' }, error: null }),
    remove: storage?.remove ?? vi.fn().mockResolvedValue({ data: {}, error: null }),
  };
  return { from, storage: { from: vi.fn().mockReturnValue(storageBucket) } } as never;
}

function makeAdminClient(siteRows: Array<{ site_id: string }>) {
  return { from: vi.fn().mockReturnValue(queryStub(siteRows)) } as never;
}

function fakeFile(name = 'protocol.pdf'): File {
  return {
    name,
    type: 'application/pdf',
    size: 1024,
    arrayBuffer: async () => new TextEncoder().encode('pdf-bytes').buffer,
  } as unknown as File;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── upload ───────────────────────────────────────────────────────────────

describe('FileService.upload', () => {
  it('throws PermissionDeniedError when the caller lacks upload_documents', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('upload_documents'),
    );

    await expect(FileService.upload(fakeFile(), makeCtx())).rejects.toThrow(PermissionDeniedError);
  });

  it('uploads to storage, records metadata, and writes an audit log', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient([{ data: makeFile() }]),
    );

    const result = await FileService.upload(fakeFile(), makeCtx());

    expect(result.id).toBe(FILE_ID);
    expect(result.company_id).toBe(COMPANY_ID);
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'file.uploaded', company_id: COMPANY_ID }),
    );
  });

  it('throws DatabaseError when the storage upload itself fails', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient([{ data: makeFile() }], {
        upload: vi.fn().mockResolvedValue({ data: null, error: { message: 'storage down' } }),
      }),
    );

    await expect(FileService.upload(fakeFile(), makeCtx())).rejects.toThrow(DatabaseError);
  });

  it('cleans up the orphaned storage object when the metadata insert fails', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const removeMock = vi.fn().mockResolvedValue({ data: {}, error: null });
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient([{ data: null, error: { message: 'insert failed' } }], {
        remove: removeMock,
      }),
    );

    await expect(FileService.upload(fakeFile(), makeCtx())).rejects.toThrow(DatabaseError);
    expect(removeMock).toHaveBeenCalled();
  });
});

// ── getMetadata — company + site authorization ─────────────────────────────

describe('FileService.getMetadata', () => {
  it('throws PermissionDeniedError when the caller lacks view_documents', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('view_documents'),
    );

    await expect(FileService.getMetadata(FILE_ID, makeCtx())).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it('throws NotFoundError for a file belonging to a different company (file metadata remains company-scoped)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    // Simulates RLS: a cross-company id filter returns no row.
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient([{ data: null, error: { message: 'no rows' } }]),
    );

    await expect(FileService.getMetadata(FILE_ID, makeCtx())).rejects.toThrow(NotFoundError);
  });

  it('returns the file when it has no site-scoped links (company-wide)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient([{ data: makeFile() }]),
    );
    vi.mocked(createAdminSupabaseClient).mockReturnValueOnce(makeAdminClient([]));

    const result = await FileService.getMetadata(FILE_ID, makeCtx());
    expect(result.id).toBe(FILE_ID);
  });

  it('returns the file when the caller can access at least one linked site', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient([{ data: makeFile() }]),
    );
    vi.mocked(createAdminSupabaseClient).mockReturnValueOnce(
      makeAdminClient([{ site_id: SITE_ID }]),
    );
    vi.spyOn(PermissionService, 'canAccessSite').mockResolvedValue(true);

    const result = await FileService.getMetadata(FILE_ID, makeCtx());
    expect(result.id).toBe(FILE_ID);
  });

  it('throws PermissionDeniedError when the caller cannot access any linked site', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient([{ data: makeFile() }]),
    );
    vi.mocked(createAdminSupabaseClient).mockReturnValueOnce(
      makeAdminClient([{ site_id: SITE_ID }]),
    );
    vi.spyOn(PermissionService, 'canAccessSite').mockResolvedValue(false);

    await expect(FileService.getMetadata(FILE_ID, makeCtx())).rejects.toThrow(
      PermissionDeniedError,
    );
  });
});

// ── getSignedUrl — the "authorization before signed URL issuance" gate ─────

describe('FileService.getSignedUrl', () => {
  it('issues a signed URL and audits it when authorized (company + site)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient)
      .mockResolvedValueOnce(makeSupabaseClient([{ data: makeFile() }])) // getMetadata's files lookup
      .mockResolvedValueOnce(makeSupabaseClient([])); // the createSignedUrl call's own client
    vi.mocked(createAdminSupabaseClient).mockReturnValueOnce(makeAdminClient([]));

    const url = await FileService.getSignedUrl(FILE_ID, makeCtx());

    expect(url).toBe('https://signed.example/x');
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'file.signed_url_issued' }),
    );
  });

  it("rejects an unauthorized signed URL request when the caller lacks access to the file's linked site", async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient([{ data: makeFile() }]),
    );
    vi.mocked(createAdminSupabaseClient).mockReturnValueOnce(
      makeAdminClient([{ site_id: SITE_ID }]),
    );
    vi.spyOn(PermissionService, 'canAccessSite').mockResolvedValue(false);

    await expect(FileService.getSignedUrl(FILE_ID, makeCtx())).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it('rejects a signed URL request for a file in a different company', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient([{ data: null, error: { message: 'no rows' } }]),
    );

    await expect(FileService.getSignedUrl(FILE_ID, makeCtx())).rejects.toThrow(NotFoundError);
  });
});

// ── linkToRecord ─────────────────────────────────────────────────────────

describe('FileService.linkToRecord', () => {
  it('throws PermissionDeniedError when the caller lacks upload_documents', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('upload_documents'),
    );

    await expect(
      FileService.linkToRecord(
        { file_id: FILE_ID, module: 'subjects', record_id: 'record-uuid' },
        makeCtx(),
      ),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it("refuses to link a file that belongs to a different company (cannot link Company B's files)", async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    // getMetadata's files lookup — cross-company, RLS-equivalent filter returns nothing.
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient([{ data: null, error: { message: 'no rows' } }]),
    );

    await expect(
      FileService.linkToRecord(
        { file_id: FILE_ID, module: 'subjects', record_id: 'record-uuid' },
        makeCtx(),
      ),
    ).rejects.toThrow(NotFoundError);
  });

  it('throws PermissionDeniedError when linking to a site the caller cannot access', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient([{ data: makeFile() }]),
    );
    vi.mocked(createAdminSupabaseClient).mockReturnValueOnce(makeAdminClient([]));
    vi.spyOn(PermissionService, 'requireSiteAccess').mockRejectedValue(
      new PermissionDeniedError(`site:${SITE_ID}`),
    );

    await expect(
      FileService.linkToRecord(
        { file_id: FILE_ID, module: 'subjects', record_id: 'record-uuid', site_id: SITE_ID },
        makeCtx(),
      ),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it("links the file with the caller's own company_id and writes an audit log", async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient)
      .mockResolvedValueOnce(makeSupabaseClient([{ data: makeFile() }])) // getMetadata
      .mockResolvedValueOnce(makeSupabaseClient([{ data: makeLink() }])); // file_links insert
    vi.mocked(createAdminSupabaseClient).mockReturnValueOnce(makeAdminClient([]));

    const link = await FileService.linkToRecord(
      { file_id: FILE_ID, module: 'subjects', record_id: 'record-uuid' },
      makeCtx(),
    );

    expect(link.company_id).toBe(COMPANY_ID);
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'file.linked', company_id: COMPANY_ID }),
    );
  });
});

// ── unlink ───────────────────────────────────────────────────────────────

describe('FileService.unlink', () => {
  it("throws NotFoundError when the link does not belong to the caller's company", async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient([{ data: null }]),
    );

    await expect(FileService.unlink(LINK_ID, makeCtx())).rejects.toThrow(NotFoundError);
  });

  it('deletes the link and writes an audit log with the prior link data', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient([{ data: makeLink() }, { data: null, error: null }]),
    );

    await FileService.unlink(LINK_ID, makeCtx());

    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'file.unlinked', company_id: COMPANY_ID }),
    );
  });
});

// ── listLinksForRecord ───────────────────────────────────────────────────

describe('FileService.listLinksForRecord', () => {
  it('throws PermissionDeniedError when the caller lacks view_documents', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('view_documents'),
    );

    await expect(
      FileService.listLinksForRecord('subjects', 'record-uuid', makeCtx()),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it("returns links scoped to the caller's company", async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient([{ data: [makeLink()] }]),
    );

    const result = await FileService.listLinksForRecord('subjects', 'record-uuid', makeCtx());
    expect(result).toHaveLength(1);
    expect(result[0]?.company_id).toBe(COMPANY_ID);
  });
});

// ── getWithLinks ─────────────────────────────────────────────────────────

describe('FileService.getWithLinks', () => {
  it('throws NotFoundError for a file belonging to a different company', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient([{ data: null, error: { message: 'no rows' } }]),
    );

    await expect(FileService.getWithLinks(FILE_ID, makeCtx())).rejects.toThrow(NotFoundError);
  });

  it('returns the file with its links attached', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    // getWithLinks calls createServerSupabaseClient() twice: once inside
    // getMetadata (files lookup) and once for its own file_links lookup.
    vi.mocked(createServerSupabaseClient)
      .mockResolvedValueOnce(makeSupabaseClient([{ data: makeFile() }]))
      .mockResolvedValueOnce(makeSupabaseClient([{ data: [makeLink()] }]));
    vi.mocked(createAdminSupabaseClient).mockReturnValueOnce(makeAdminClient([]));

    const result = await FileService.getWithLinks(FILE_ID, makeCtx());
    expect(result.id).toBe(FILE_ID);
    expect(result.links).toHaveLength(1);
    expect(result.links[0]?.module).toBe('subjects');
  });

  it('returns an empty links array for a file with no linked records', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient)
      .mockResolvedValueOnce(makeSupabaseClient([{ data: makeFile() }]))
      .mockResolvedValueOnce(makeSupabaseClient([{ data: [] }]));
    vi.mocked(createAdminSupabaseClient).mockReturnValueOnce(makeAdminClient([]));

    const result = await FileService.getWithLinks(FILE_ID, makeCtx());
    expect(result.links).toEqual([]);
  });
});

// ── list — browsing, filters, and per-row site authorization ──────────────

describe('FileService.list', () => {
  it('throws PermissionDeniedError when the caller lacks view_documents', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('view_documents'),
    );

    await expect(FileService.list({}, makeCtx())).rejects.toThrow(PermissionDeniedError);
  });

  it("returns every company file scoped to the caller's company when the caller holds view_all_sites", async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient([{ data: [makeFile()] }, { data: [] }]),
    );
    vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(true);

    const result = await FileService.list({}, makeCtx());
    expect(result).toHaveLength(1);
    expect(result[0]?.company_id).toBe(COMPANY_ID);
    expect(result[0]?.links).toEqual([]);
  });

  it('excludes a file whose only linked site the caller cannot access', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient([{ data: [makeFile()] }, { data: [makeLink({ site_id: SITE_ID })] }]),
    );
    vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(false); // no view_all_sites
    vi.spyOn(PermissionService, 'canAccessSite').mockResolvedValue(false);

    const result = await FileService.list({}, makeCtx());
    expect(result).toHaveLength(0);
  });

  it('includes a file whose linked site the caller can access', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient([{ data: [makeFile()] }, { data: [makeLink({ site_id: SITE_ID })] }]),
    );
    vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(false);
    vi.spyOn(PermissionService, 'canAccessSite').mockResolvedValue(true);

    const result = await FileService.list({}, makeCtx());
    expect(result).toHaveLength(1);
  });

  it('returns an empty array immediately when the module filter matches no links (no unnecessary files query)', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(makeSupabaseClient([{ data: [] }]));

    const result = await FileService.list({ module: 'subjects' }, makeCtx());
    expect(result).toEqual([]);
  });

  it('returns files matching a module filter', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(
      makeSupabaseClient([
        { data: [{ file_id: FILE_ID }] }, // module-filter file_links lookup
        { data: [makeFile()] }, // files query
        { data: [makeLink()] }, // links-for-found-files lookup
      ]),
    );
    vi.spyOn(PermissionService, 'hasPermission').mockResolvedValue(true);

    const result = await FileService.list({ module: 'subjects' }, makeCtx());
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(FILE_ID);
  });

  it('returns an empty array when no files exist for the company', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValueOnce(makeSupabaseClient([{ data: [] }]));

    const result = await FileService.list({}, makeCtx());
    expect(result).toEqual([]);
  });
});
