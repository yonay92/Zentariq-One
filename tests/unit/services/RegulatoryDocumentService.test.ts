import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import {
  RegulatoryDocumentService,
  computeSlotStatus,
} from '@/services/regulatory/RegulatoryDocumentService';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import { PermissionDeniedError, BusinessRuleError, NotFoundError } from '@/lib/api/errors';
import type { RegulatoryDocument, DocumentVersion } from '@/types/regulatory';

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
