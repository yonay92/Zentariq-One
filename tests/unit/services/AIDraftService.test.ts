import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { AIDraftService } from '@/services/studies/AIDraftService';
import { PermissionService } from '@/services/permissions/PermissionService';
import { VisitTemplateService } from '@/services/visit-templates/VisitTemplateService';
import { AuditService } from '@/services/audit/AuditService';
import { FileService } from '@/services/files/FileService';
import { PermissionDeniedError, NotFoundError, BusinessRuleError } from '@/lib/api/errors';
import type { FileLink } from '@/types/files';

vi.mock('@/services/audit/AuditService', () => ({
  AuditService: { log: vi.fn() },
}));

vi.mock('@/services/visit-templates/VisitTemplateService', () => ({
  VisitTemplateService: {
    createTemplate: vi.fn(),
  },
}));

const COMPANY_ID = 'company-uuid';
const USER_ID = 'user-uuid';
const DRAFT_ID = 'draft-uuid';
const FILE_ID = 'file-uuid';
const STUDY_ID = 'study-uuid';
const STUDY_DOCUMENT_ID = 'study-document-uuid';

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
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data, error }),
    then: resolved.then.bind(resolved),
    catch: resolved.catch.bind(resolved),
    finally: resolved.finally.bind(resolved),
  };
  for (const key of ['select', 'eq', 'insert', 'update', 'delete']) {
    (stub[key] as ReturnType<typeof vi.fn>).mockReturnValue(stub);
  }
  return stub;
}

function makeClient(
  responses: Array<{ data: unknown; error?: unknown }>,
  options: {
    uploadError?: { message: string } | null;
    invokeError?: { message: string } | null;
  } = {},
) {
  const from = vi.fn();
  for (const r of responses) {
    from.mockReturnValueOnce(queryStub(r.data, r.error ?? null));
  }
  return {
    from,
    storage: {
      from: vi.fn().mockReturnValue({
        upload: vi.fn().mockResolvedValue({ error: options.uploadError ?? null }),
      }),
    },
    functions: {
      invoke: vi.fn().mockResolvedValue({ data: {}, error: options.invokeError ?? null }),
    },
  } as never;
}

function makeFile(): File {
  return new File(['%PDF-1.4'], 'protocol.pdf', { type: 'application/pdf' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AIDraftService.createDraft', () => {
  it('throws PermissionDeniedError when user lacks create_study', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('create_study'),
    );

    await expect(AIDraftService.createDraft(makeFile(), makeCtx())).rejects.toThrow(
      PermissionDeniedError,
    );
  });

  it('creates a processing draft, runs extraction, and returns the ready draft', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const fileRow = { id: FILE_ID };
    const draftRowProcessing = {
      id: DRAFT_ID,
      company_id: COMPANY_ID,
      file_id: FILE_ID,
      status: 'processing',
      confidence: null,
      uncertain_fields: [],
      extracted_profile: {},
      extracted_visit_items: [],
      extracted_extra: {},
      error_message: null,
      study_id: null,
      created_by: USER_ID,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const draftRowReady = { ...draftRowProcessing, status: 'ready', confidence: 0.9 };

    const client = makeClient([
      { data: fileRow }, // files insert
      { data: draftRowProcessing }, // study_drafts insert
      { data: draftRowReady }, // getDraft() re-fetch at the end
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await AIDraftService.createDraft(makeFile(), makeCtx());

    expect(result.status).toBe('ready');
    expect(
      (client as unknown as { functions: { invoke: ReturnType<typeof vi.fn> } }).functions.invoke,
    ).toHaveBeenCalledWith('protocol-ai', { body: { file_id: FILE_ID, draft_id: DRAFT_ID } });
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'study.ai_draft_created', record_id: DRAFT_ID }),
    );
  });

  it('marks the draft failed when the protocol-ai invocation errors', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);

    const fileRow = { id: FILE_ID };
    const draftRowProcessing = {
      id: DRAFT_ID,
      company_id: COMPANY_ID,
      file_id: FILE_ID,
      status: 'processing',
      confidence: null,
      uncertain_fields: [],
      extracted_profile: {},
      extracted_visit_items: [],
      extracted_extra: {},
      error_message: null,
      study_id: null,
      created_by: USER_ID,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const draftRowFailed = {
      ...draftRowProcessing,
      status: 'failed',
      error_message: 'boom',
    };

    const client = makeClient(
      [
        { data: fileRow }, // files insert
        { data: draftRowProcessing }, // study_drafts insert
        { data: null }, // study_drafts update (mark failed)
        { data: draftRowFailed }, // getDraft() re-fetch at the end
      ],
      { invokeError: { message: 'boom' } },
    );
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await AIDraftService.createDraft(makeFile(), makeCtx());

    expect(result.status).toBe('failed');
    expect(result.error_message).toBe('boom');
  });

  it('does NOT create any Document Center association — study_drafts is an intermediate artifact, not part of the canonical Document Center', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const linkSpy = vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const relinkSpy = vi.spyOn(FileService, 'relinkForModule');

    const fileRow = { id: FILE_ID };
    const draftRowProcessing = {
      id: DRAFT_ID,
      company_id: COMPANY_ID,
      file_id: FILE_ID,
      status: 'processing',
      confidence: null,
      uncertain_fields: [],
      extracted_profile: {},
      extracted_visit_items: [],
      extracted_extra: {},
      error_message: null,
      study_id: null,
      created_by: USER_ID,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const draftRowReady = { ...draftRowProcessing, status: 'ready', confidence: 0.9 };

    const client = makeClient([
      { data: fileRow },
      { data: draftRowProcessing },
      { data: draftRowReady },
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await AIDraftService.createDraft(makeFile(), makeCtx());

    expect(linkSpy).not.toHaveBeenCalled();
    expect(relinkSpy).not.toHaveBeenCalled();
  });
});

describe('AIDraftService.getDraft', () => {
  it('throws NotFoundError when the draft is missing or belongs to another company', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(makeClient([{ data: null }]));

    await expect(AIDraftService.getDraft(DRAFT_ID, makeCtx())).rejects.toThrow(NotFoundError);
  });
});

describe('AIDraftService.finalizeDraft', () => {
  function readyDraft(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: DRAFT_ID,
      company_id: COMPANY_ID,
      file_id: FILE_ID,
      status: 'ready',
      confidence: 0.9,
      uncertain_fields: [],
      extracted_profile: {},
      extracted_visit_items: [],
      extracted_extra: {},
      error_message: null,
      study_id: null,
      created_by: USER_ID,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  }

  it('throws BusinessRuleError when the draft is already finalized', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeClient([{ data: readyDraft({ status: 'finalized', study_id: STUDY_ID }) }]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      AIDraftService.finalizeDraft(DRAFT_ID, { study_name: 'Study A' }, makeCtx()),
    ).rejects.toThrow(BusinessRuleError);
  });

  it('rejects a bad baseline count before creating anything', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeClient([{ data: readyDraft() }]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(
      AIDraftService.finalizeDraft(
        DRAFT_ID,
        {
          study_name: 'Study A',
          visit_template_items: [
            { visit_name: 'Screening', visit_order: 1, is_baseline: false },
            { visit_name: 'Visit 2', visit_order: 2, is_baseline: false },
          ],
        },
        makeCtx(),
      ),
    ).rejects.toThrow(BusinessRuleError);

    // Only the initial draft fetch should have touched the client — no study was created.
    expect((client as unknown as { from: ReturnType<typeof vi.fn> }).from).toHaveBeenCalledTimes(1);
  });

  it('creates the study, visit template, and protocol document, then marks the draft finalized', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(VisitTemplateService.createTemplate).mockResolvedValue({} as never);
    vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);

    const studyRow = {
      id: STUDY_ID,
      company_id: COMPANY_ID,
      study_name: 'Study A',
      status: 'draft',
    };

    const client = makeClient([
      { data: readyDraft() }, // getDraft()
      { data: studyRow }, // studies insert
      { data: { id: STUDY_DOCUMENT_ID } }, // study_documents insert — now captured via .select('id').single()
      { data: null }, // study_drafts update -> finalized
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    const result = await AIDraftService.finalizeDraft(
      DRAFT_ID,
      {
        study_name: 'Study A',
        visit_template_items: [{ visit_name: 'Screening', visit_order: 1, is_baseline: true }],
      },
      makeCtx(),
    );

    expect(result.id).toBe(STUDY_ID);
    expect(VisitTemplateService.createTemplate).toHaveBeenCalledWith(
      STUDY_ID,
      [{ visit_name: 'Screening', visit_order: 1, is_baseline: true }],
      expect.anything(),
      'ai_generated',
    );
    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'study.ai_draft_finalized', record_id: STUDY_ID }),
    );
  });

  // Sub-Milestone 3.4: this is the exact call site the Document Center
  // retrofit depends on. Locks down: the file_id used is the draft's own
  // file_id (the SAME physical file uploaded at createDraft() time, never
  // re-uploaded or reconstructed), study_id is the newly-created study's
  // id, and (as of 3.4B) the insert result is now captured via
  // .select('id').single() rather than discarded.
  it('inserts the study_documents row with the draft’s own file_id and the newly-created study’s id — the exact identifiers the Document Center retrofit must reuse', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    vi.mocked(VisitTemplateService.createTemplate).mockResolvedValue({} as never);
    vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);

    const studyRow = {
      id: STUDY_ID,
      company_id: COMPANY_ID,
      study_name: 'Study A',
      status: 'draft',
    };
    const draftFileId = 'distinct-draft-file-uuid';

    const stubs = [
      queryStub(readyDraft({ file_id: draftFileId })), // getDraft()
      queryStub(studyRow), // studies insert
      queryStub({ id: STUDY_DOCUMENT_ID }), // study_documents insert
      queryStub(null), // study_drafts update -> finalized
    ];
    const from = vi.fn();
    for (const stub of stubs) from.mockReturnValueOnce(stub);
    const client = {
      from,
      storage: { from: vi.fn().mockReturnValue({ upload: vi.fn() }) },
      functions: { invoke: vi.fn() },
    } as never;
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await AIDraftService.finalizeDraft(DRAFT_ID, { study_name: 'Study A' }, makeCtx());

    const docInsertStub = stubs[2] as unknown as { insert: ReturnType<typeof vi.fn> };
    expect(docInsertStub.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: COMPANY_ID,
        study_id: STUDY_ID,
        file_id: draftFileId,
        document_type: 'protocol',
        ai_processed: true,
      }),
    );
  });
});

// ── Sub-Milestone 3.4B: Document Center retrofit for finalizeDraft() ───────

describe('AIDraftService.finalizeDraft — Document Center retrofit', () => {
  function readyDraft(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: DRAFT_ID,
      company_id: COMPANY_ID,
      file_id: FILE_ID,
      status: 'ready',
      confidence: 0.9,
      uncertain_fields: [],
      extracted_profile: {},
      extracted_visit_items: [],
      extracted_extra: {},
      error_message: null,
      study_id: null,
      created_by: USER_ID,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  }

  function successClient(fileId: string, studyDocumentId: string) {
    return makeClient([
      { data: readyDraft({ file_id: fileId }) }, // getDraft()
      { data: { id: STUDY_ID, company_id: COMPANY_ID, study_name: 'Study A', status: 'draft' } }, // studies insert
      { data: { id: studyDocumentId } }, // study_documents insert
      { data: null }, // study_drafts update -> finalized
    ]);
  }

  beforeEach(() => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
  });

  it('calls linkForModule exactly once, with the correct module, the exact inserted study_documents.id as record_id, site_id null', async () => {
    const linkSpy = vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      successClient(FILE_ID, STUDY_DOCUMENT_ID),
    );

    await AIDraftService.finalizeDraft(DRAFT_ID, { study_name: 'Study A' }, makeCtx());

    expect(linkSpy).toHaveBeenCalledTimes(1);
    expect(linkSpy).toHaveBeenCalledWith(
      {
        file_id: FILE_ID,
        module: 'study_documents',
        record_id: STUDY_DOCUMENT_ID,
        site_id: null,
      },
      expect.anything(),
    );
  });

  it("passes the draft's own file_id (never a reconstructed identifier) and the exact study_documents.id from .select('id').single() — never the study_drafts row", async () => {
    const linkSpy = vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const distinctFileId = 'distinct-draft-file-uuid';
    const distinctDocId = 'distinct-study-document-uuid';
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      successClient(distinctFileId, distinctDocId),
    );

    await AIDraftService.finalizeDraft(DRAFT_ID, { study_name: 'Study A' }, makeCtx());

    const callArgs = linkSpy.mock.calls[0]?.[0];
    expect(callArgs?.file_id).toBe(distinctFileId);
    expect(callArgs?.record_id).toBe(distinctDocId);
    expect(callArgs?.record_id).not.toBe(DRAFT_ID); // never the study_drafts row's own id
  });

  it('still succeeds and returns the finalized study when linkForModule fails (failure is logged, not swallowed silently, and never rolled back)', async () => {
    vi.spyOn(FileService, 'linkForModule').mockRejectedValue(new Error('file_links insert failed'));
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      successClient(FILE_ID, STUDY_DOCUMENT_ID),
    );

    const result = await AIDraftService.finalizeDraft(
      DRAFT_ID,
      { study_name: 'Study A' },
      makeCtx(),
    );

    expect(result.id).toBe(STUDY_ID);
  });

  it('never exposes a public URL from the Document Center link', async () => {
    vi.spyOn(FileService, 'linkForModule').mockResolvedValue({
      id: 'link-uuid',
      company_id: COMPANY_ID,
      file_id: FILE_ID,
      site_id: null,
      module: 'study_documents',
      record_id: STUDY_DOCUMENT_ID,
      created_by: USER_ID,
      created_at: new Date().toISOString(),
    } as FileLink);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      successClient(FILE_ID, STUDY_DOCUMENT_ID),
    );

    const result = await AIDraftService.finalizeDraft(
      DRAFT_ID,
      { study_name: 'Study A' },
      makeCtx(),
    );

    expect(result).not.toHaveProperty('url');
    expect(result).not.toHaveProperty('signedUrl');
  });

  it('does NOT create a file_link for the source study_drafts record — relinkForModule is never used', async () => {
    const linkSpy = vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const relinkSpy = vi.spyOn(FileService, 'relinkForModule');
    vi.mocked(createServerSupabaseClient).mockResolvedValue(
      successClient(FILE_ID, STUDY_DOCUMENT_ID),
    );

    await AIDraftService.finalizeDraft(DRAFT_ID, { study_name: 'Study A' }, makeCtx());

    // Only one linkForModule call ever happens, and it targets the
    // study_documents row — never a second call for study_drafts.
    expect(linkSpy).toHaveBeenCalledTimes(1);
    expect(linkSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ module: 'study_drafts' }),
      expect.anything(),
    );
    expect(relinkSpy).not.toHaveBeenCalled();
  });

  it('existing permission enforcement is unaffected by the retrofit', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockRejectedValue(
      new PermissionDeniedError('create_study'),
    );

    await expect(
      AIDraftService.finalizeDraft(DRAFT_ID, { study_name: 'Study A' }, makeCtx()),
    ).rejects.toThrow(PermissionDeniedError);
  });
});

describe('AIDraftService.deleteDraft', () => {
  it('throws BusinessRuleError when the draft is already finalized', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeClient([
      {
        data: {
          id: DRAFT_ID,
          company_id: COMPANY_ID,
          file_id: FILE_ID,
          status: 'finalized',
          confidence: null,
          uncertain_fields: [],
          extracted_profile: {},
          extracted_visit_items: [],
          extracted_extra: {},
          error_message: null,
          study_id: STUDY_ID,
          created_by: USER_ID,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      },
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await expect(AIDraftService.deleteDraft(DRAFT_ID, makeCtx())).rejects.toThrow(
      BusinessRuleError,
    );
  });

  it('deletes the row and writes an audit log', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const client = makeClient([
      {
        data: {
          id: DRAFT_ID,
          company_id: COMPANY_ID,
          file_id: FILE_ID,
          status: 'ready',
          confidence: 0.9,
          uncertain_fields: [],
          extracted_profile: {},
          extracted_visit_items: [],
          extracted_extra: {},
          error_message: null,
          study_id: null,
          created_by: USER_ID,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      },
      { data: null }, // delete
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await AIDraftService.deleteDraft(DRAFT_ID, makeCtx());

    expect(AuditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'study.ai_draft_discarded', record_id: DRAFT_ID }),
    );
  });

  it('performs no Document Center operation — no file_link was ever created for a never-finalized draft, so there is nothing to unlink on discard', async () => {
    vi.spyOn(PermissionService, 'requirePermission').mockResolvedValue(undefined);
    const linkSpy = vi.spyOn(FileService, 'linkForModule').mockResolvedValue({} as FileLink);
    const relinkSpy = vi.spyOn(FileService, 'relinkForModule');
    const client = makeClient([
      {
        data: {
          id: DRAFT_ID,
          company_id: COMPANY_ID,
          file_id: FILE_ID,
          status: 'ready',
          confidence: 0.9,
          uncertain_fields: [],
          extracted_profile: {},
          extracted_visit_items: [],
          extracted_extra: {},
          error_message: null,
          study_id: null,
          created_by: USER_ID,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      },
      { data: null }, // delete
    ]);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(client);

    await AIDraftService.deleteDraft(DRAFT_ID, makeCtx());

    expect(linkSpy).not.toHaveBeenCalled();
    expect(relinkSpy).not.toHaveBeenCalled();
  });
});
