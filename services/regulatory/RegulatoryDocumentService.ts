import { createHash, randomUUID } from 'crypto';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import { NotFoundError, DatabaseError, BusinessRuleError } from '@/lib/api/errors';
import type {
  RegulatoryDocument,
  RegulatoryDocumentWithType,
  RegulatoryDocumentStatus,
  DocumentVersion,
  DocumentHistoryEntry,
  CreateRegulatoryDocumentInput,
  UploadDocumentVersionInput,
  RejectDocumentInput,
  ArchiveDocumentInput,
  OverrideDocumentStatusInput,
  DuplicateChecksumWarning,
} from '@/types/regulatory';
import type { RequestContext } from '@/types/api';

const DOCUMENT_COLUMNS =
  'id, company_id, site_id, study_id, document_type_id, file_id, document_name, version, effective_date, expiration_date, status, uploaded_by, created_at, updated_at';

const DOCUMENT_WITH_TYPE_COLUMNS = `${DOCUMENT_COLUMNS}, document_type:document_types(id, name, category, has_expiration)`;

const VERSION_COLUMNS =
  'id, company_id, document_id, staff_document_id, previous_version_id, version, file_id, checksum, is_current, status, effective_date, expiration_date, replacement_reason, duplicate_of_version_id, uploaded_by, uploaded_at, reviewed_by, reviewed_at, file:files(id, file_name, original_name, file_size, mime_type)';

const TERMINAL_SLOT_STATUSES: RegulatoryDocumentStatus[] = ['archived'];

async function getDocumentOrThrow(
  documentId: string,
  ctx: RequestContext,
): Promise<RegulatoryDocument> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from('regulatory_documents')
    .select(DOCUMENT_COLUMNS)
    .eq('id', documentId)
    .eq('company_id', ctx.company.id)
    .single();

  if (error || !data) throw new NotFoundError('Regulatory document');
  return data as RegulatoryDocument;
}

async function getCurrentVersion(documentId: string): Promise<DocumentVersion | null> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from('document_versions')
    .select(VERSION_COLUMNS)
    .eq('document_id', documentId)
    .eq('is_current', true)
    .maybeSingle();

  return (data as DocumentVersion | null) ?? null;
}

function computeChecksum(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function buildStorageKey(params: {
  companyId: string;
  studyId: string | null;
  siteId: string | null;
  documentTypeId: string;
  versionId: string;
  fileName: string;
}): string {
  const scope = params.studyId
    ? `studies/${params.studyId}`
    : params.siteId
      ? `sites/${params.siteId}`
      : 'company';
  return `${params.companyId}/${scope}/${params.documentTypeId}/${params.versionId}_${params.fileName}`;
}

// Status for a version that has just been approved, given its expiration
// date (or none). Used both right after approval and by unit tests that
// verify the same math the regulatory-expiration-checker Edge Function
// reimplements independently in Deno (Edge Functions can't import Node
// service code — same split already used for visit-status-checker).
function computeSlotStatus(expirationDate: string | null): RegulatoryDocumentStatus {
  if (!expirationDate) return 'current';

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(expirationDate);
  const daysUntilExpiry = Math.floor((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  if (daysUntilExpiry < 0) return 'expired';
  if (daysUntilExpiry <= 90) return 'expiring_soon';
  return 'current';
}

async function writeHistory(
  documentId: string,
  versionId: string | null,
  oldStatus: string | null,
  newStatus: string,
  reason: string | null,
  ctx: RequestContext,
): Promise<void> {
  const supabase = await createServerSupabaseClient();
  await supabase.from('document_history').insert({
    company_id: ctx.company.id,
    document_id: documentId,
    version_id: versionId,
    old_status: oldStatus,
    new_status: newStatus,
    changed_by: ctx.user.id,
    reason,
  });
}

async function uploadFile(
  file: File,
  storageKey: string,
  ctx: RequestContext,
): Promise<{ fileId: string; checksum: string }> {
  const supabase = await createServerSupabaseClient();
  const buffer = Buffer.from(await file.arrayBuffer());
  const checksum = computeChecksum(buffer);

  const { error: uploadError } = await supabase.storage
    .from('regulatory')
    .upload(storageKey, buffer, { contentType: file.type, upsert: false });

  if (uploadError) {
    throw new DatabaseError(`Regulatory document upload failed: ${uploadError.message}`);
  }

  const fileExtension = file.name.includes('.') ? file.name.split('.').pop() : null;

  const { data: fileRow, error: fileError } = await supabase
    .from('files')
    .insert({
      company_id: ctx.company.id,
      file_name: file.name,
      original_name: file.name,
      file_extension: fileExtension,
      mime_type: file.type || null,
      file_size: file.size,
      storage_path: storageKey,
      uploaded_by: ctx.user.id,
      checksum,
    })
    .select('id')
    .single();

  if (fileError || !fileRow) {
    throw new DatabaseError(fileError?.message ?? 'Failed to record uploaded file');
  }

  return { fileId: (fileRow as { id: string }).id, checksum };
}

export const RegulatoryDocumentService = {
  async getById(documentId: string, ctx: RequestContext): Promise<RegulatoryDocumentWithType> {
    await PermissionService.requirePermission(ctx.user.id, 'view_regulatory');
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('regulatory_documents')
      .select(DOCUMENT_WITH_TYPE_COLUMNS)
      .eq('id', documentId)
      .eq('company_id', ctx.company.id)
      .single();

    if (error || !data) throw new NotFoundError('Regulatory document');
    return data as unknown as RegulatoryDocumentWithType;
  },

  async list(
    filters: { study_id?: string | undefined; site_id?: string | undefined },
    ctx: RequestContext,
  ): Promise<RegulatoryDocumentWithType[]> {
    await PermissionService.requirePermission(ctx.user.id, 'view_regulatory');

    const supabase = await createServerSupabaseClient();
    let query = supabase
      .from('regulatory_documents')
      .select(DOCUMENT_WITH_TYPE_COLUMNS)
      .eq('company_id', ctx.company.id)
      .order('document_name', { ascending: true });

    if (filters.study_id) query = query.eq('study_id', filters.study_id);
    if (filters.site_id) query = query.eq('site_id', filters.site_id);

    const { data, error } = await query;
    if (error) throw new DatabaseError(error.message);
    return (data as unknown as RegulatoryDocumentWithType[]) ?? [];
  },

  // Creates the document "slot" and its first version (status: draft). A
  // second, explicit `submit` call moves it to pending_review — matching the
  // approved lifecycle (missing -> draft -> pending_review -> current).
  async create(
    input: CreateRegulatoryDocumentInput,
    file: File,
    ctx: RequestContext,
  ): Promise<RegulatoryDocument> {
    await PermissionService.requirePermission(ctx.user.id, 'upload_regulatory_document');
    if (input.site_id) await PermissionService.requireSiteAccess(ctx.user.id, input.site_id);

    const supabase = await createServerSupabaseClient();

    const { data: slot, error: slotError } = await supabase
      .from('regulatory_documents')
      .insert({
        company_id: ctx.company.id,
        site_id: input.site_id ?? null,
        study_id: input.study_id ?? null,
        document_type_id: input.document_type_id,
        document_name: input.document_name,
        status: 'draft',
        uploaded_by: ctx.user.id,
      })
      .select(DOCUMENT_COLUMNS)
      .single();

    if (slotError || !slot) {
      if (slotError?.code === '23505') {
        throw new BusinessRuleError(
          'A document already exists for this document type and scope — use Replace to add a new version instead.',
        );
      }
      throw new DatabaseError(slotError?.message ?? 'Failed to create regulatory document');
    }

    const document = slot as RegulatoryDocument;
    const versionId = randomUUID();
    const storageKey = buildStorageKey({
      companyId: ctx.company.id,
      studyId: document.study_id,
      siteId: document.site_id,
      documentTypeId: document.document_type_id,
      versionId,
      fileName: file.name,
    });

    const { fileId, checksum } = await uploadFile(file, storageKey, ctx);

    const { error: versionError } = await supabase.from('document_versions').insert({
      id: versionId,
      company_id: ctx.company.id,
      document_id: document.id,
      version: 'v1',
      file_id: fileId,
      checksum,
      is_current: true,
      status: 'pending_review',
      effective_date: input.effective_date ?? null,
      expiration_date: input.expiration_date ?? null,
      uploaded_by: ctx.user.id,
    });

    if (versionError) {
      throw new DatabaseError(`Failed to record document version: ${versionError.message}`);
    }

    const { data: updatedSlot, error: updateError } = await supabase
      .from('regulatory_documents')
      .update({
        file_id: fileId,
        version: 'v1',
        effective_date: input.effective_date ?? null,
        expiration_date: input.expiration_date ?? null,
        status: 'pending_review',
      })
      .eq('id', document.id)
      .select(DOCUMENT_COLUMNS)
      .single();

    if (updateError || !updatedSlot) {
      throw new DatabaseError(updateError?.message ?? 'Failed to finalize regulatory document');
    }

    await writeHistory(document.id, versionId, 'draft', 'pending_review', null, ctx);

    await AuditService.log({
      company_id: ctx.company.id,
      site_id: document.site_id,
      user_id: ctx.user.id,
      action: 'regulatory_document.uploaded',
      module: 'regulatory',
      record_type: 'regulatory_documents',
      record_id: document.id,
      new_value: { document_type_id: document.document_type_id, version: 'v1' },
    });

    return updatedSlot as RegulatoryDocument;
  },

  async approve(documentId: string, ctx: RequestContext): Promise<RegulatoryDocument> {
    await PermissionService.requirePermission(ctx.user.id, 'edit_regulatory_document');
    const document = await getDocumentOrThrow(documentId, ctx);
    if (document.status !== 'pending_review') {
      throw new BusinessRuleError('Only a document pending review can be approved.');
    }

    const version = await getCurrentVersion(documentId);
    if (!version) throw new BusinessRuleError('No version is on file for this document.');

    const supabase = await createServerSupabaseClient();
    const { error: versionError } = await supabase
      .from('document_versions')
      .update({
        status: 'approved',
        reviewed_by: ctx.user.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', version.id);

    if (versionError) throw new DatabaseError(versionError.message);

    const newStatus = computeSlotStatus(version.expiration_date);

    const { data: updated, error: updateError } = await supabase
      .from('regulatory_documents')
      .update({ status: newStatus })
      .eq('id', documentId)
      .select(DOCUMENT_COLUMNS)
      .single();

    if (updateError || !updated)
      throw new DatabaseError(updateError?.message ?? 'Failed to approve');

    await writeHistory(documentId, version.id, document.status, newStatus, null, ctx);
    await AuditService.log({
      company_id: ctx.company.id,
      site_id: document.site_id,
      user_id: ctx.user.id,
      action: 'regulatory_document.approved',
      module: 'regulatory',
      record_type: 'regulatory_documents',
      record_id: documentId,
      old_value: { status: document.status },
      new_value: { status: newStatus },
    });

    return updated as RegulatoryDocument;
  },

  async reject(
    documentId: string,
    input: RejectDocumentInput,
    ctx: RequestContext,
  ): Promise<RegulatoryDocument> {
    await PermissionService.requirePermission(ctx.user.id, 'edit_regulatory_document');
    const document = await getDocumentOrThrow(documentId, ctx);
    if (document.status !== 'pending_review') {
      throw new BusinessRuleError('Only a document pending review can be rejected.');
    }

    const version = await getCurrentVersion(documentId);
    if (!version) throw new BusinessRuleError('No version is on file for this document.');

    const supabase = await createServerSupabaseClient();
    const { error: versionError } = await supabase
      .from('document_versions')
      .update({
        status: 'rejected',
        is_current: false,
        reviewed_by: ctx.user.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', version.id);

    if (versionError) throw new DatabaseError(versionError.message);

    const { data: updated, error: updateError } = await supabase
      .from('regulatory_documents')
      .update({ status: 'rejected' })
      .eq('id', documentId)
      .select(DOCUMENT_COLUMNS)
      .single();

    if (updateError || !updated)
      throw new DatabaseError(updateError?.message ?? 'Failed to reject');

    await writeHistory(documentId, version.id, document.status, 'rejected', input.reason, ctx);
    await AuditService.log({
      company_id: ctx.company.id,
      site_id: document.site_id,
      user_id: ctx.user.id,
      action: 'regulatory_document.rejected',
      module: 'regulatory',
      record_type: 'regulatory_documents',
      record_id: documentId,
      old_value: { status: document.status },
      new_value: { status: 'rejected', reason: input.reason },
    });

    return updated as RegulatoryDocument;
  },

  // Replace never overwrites — a new document_versions row is always
  // inserted, the previous current version is marked superseded (terminal,
  // read-only from that point on per the migration's RLS policy), and the
  // new version re-enters pending_review. The slot's denormalized fields
  // continue pointing at the (now superseded) previous version's data until
  // the replacement is approved, so the binder always shows a valid
  // last-known document rather than a gap during review.
  async replace(
    documentId: string,
    file: File,
    input: UploadDocumentVersionInput,
    ctx: RequestContext,
  ): Promise<RegulatoryDocument | DuplicateChecksumWarning> {
    await PermissionService.requirePermission(ctx.user.id, 'upload_regulatory_document');
    const document = await getDocumentOrThrow(documentId, ctx);
    if (TERMINAL_SLOT_STATUSES.includes(document.status)) {
      throw new BusinessRuleError('An archived document cannot be replaced — restore it first.');
    }
    if (!input.replacement_reason?.trim()) {
      throw new BusinessRuleError('A reason is required when replacing a document version.');
    }

    const supabase = await createServerSupabaseClient();
    const buffer = Buffer.from(await file.arrayBuffer());
    const checksum = computeChecksum(buffer);

    if (!input.confirm_duplicate) {
      const { data: existingMatch } = await supabase
        .from('document_versions')
        .select('id, version, uploaded_at, uploaded_by')
        .eq('document_id', documentId)
        .eq('checksum', checksum)
        .order('uploaded_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingMatch) {
        const match = existingMatch as {
          id: string;
          version: string;
          uploaded_at: string;
          uploaded_by: string | null;
        };
        return {
          duplicate_detected: true,
          matching_version: {
            id: match.id,
            version: match.version,
            uploaded_at: match.uploaded_at,
            uploaded_by: match.uploaded_by,
          },
        };
      }
    }

    const previousVersion = await getCurrentVersion(documentId);
    if (!previousVersion) {
      throw new BusinessRuleError('This document has no existing version to replace.');
    }

    const { error: supersedeError } = await supabase
      .from('document_versions')
      .update({ is_current: false, status: 'superseded' })
      .eq('id', previousVersion.id);

    if (supersedeError) throw new DatabaseError(supersedeError.message);

    const versionId = randomUUID();
    const storageKey = buildStorageKey({
      companyId: ctx.company.id,
      studyId: document.study_id,
      siteId: document.site_id,
      documentTypeId: document.document_type_id,
      versionId,
      fileName: file.name,
    });

    const { fileId } = await uploadFile(file, storageKey, ctx);

    const nextVersionLabel = `v${Number.parseInt(previousVersion.version.replace(/\D/g, ''), 10) + 1 || 2}`;

    const isDuplicateConfirmed = Boolean(input.confirm_duplicate);
    const { error: versionError } = await supabase.from('document_versions').insert({
      id: versionId,
      company_id: ctx.company.id,
      document_id: documentId,
      previous_version_id: previousVersion.id,
      version: nextVersionLabel,
      file_id: fileId,
      checksum,
      is_current: false,
      status: 'pending_review',
      effective_date: input.effective_date ?? null,
      expiration_date: input.expiration_date ?? null,
      replacement_reason: input.replacement_reason,
      duplicate_of_version_id: isDuplicateConfirmed ? previousVersion.id : null,
      uploaded_by: ctx.user.id,
    });

    if (versionError) throw new DatabaseError(versionError.message);

    const { data: updated, error: updateError } = await supabase
      .from('regulatory_documents')
      .update({ status: 'pending_review' })
      .eq('id', documentId)
      .select(DOCUMENT_COLUMNS)
      .single();

    if (updateError || !updated)
      throw new DatabaseError(updateError?.message ?? 'Failed to replace');

    await writeHistory(
      documentId,
      previousVersion.id,
      previousVersion.status,
      'superseded',
      input.replacement_reason,
      ctx,
    );
    await writeHistory(documentId, versionId, null, 'pending_review', null, ctx);

    await AuditService.log({
      company_id: ctx.company.id,
      site_id: document.site_id,
      user_id: ctx.user.id,
      action: 'regulatory_document.replaced',
      module: 'regulatory',
      record_type: 'regulatory_documents',
      record_id: documentId,
      old_value: { superseded_version: previousVersion.version },
      new_value: { new_version: nextVersionLabel, replacement_reason: input.replacement_reason },
    });
    await AuditService.log({
      company_id: ctx.company.id,
      site_id: document.site_id,
      user_id: ctx.user.id,
      action: 'regulatory_document.version_superseded',
      module: 'regulatory',
      record_type: 'document_versions',
      record_id: previousVersion.id,
      new_value: { superseded_by_version: nextVersionLabel },
    });

    return updated as RegulatoryDocument;
  },

  async archive(
    documentId: string,
    input: ArchiveDocumentInput,
    ctx: RequestContext,
  ): Promise<RegulatoryDocument> {
    await PermissionService.requirePermission(ctx.user.id, 'archive_regulatory_document');
    const document = await getDocumentOrThrow(documentId, ctx);

    const supabase = await createServerSupabaseClient();
    const version = await getCurrentVersion(documentId);
    if (version) {
      await supabase
        .from('document_versions')
        .update({ status: 'archived', is_current: false })
        .eq('id', version.id);
    }

    const { data: updated, error } = await supabase
      .from('regulatory_documents')
      .update({ status: 'archived' })
      .eq('id', documentId)
      .select(DOCUMENT_COLUMNS)
      .single();

    if (error || !updated) throw new DatabaseError(error?.message ?? 'Failed to archive');

    await writeHistory(
      documentId,
      version?.id ?? null,
      document.status,
      'archived',
      input.reason,
      ctx,
    );
    await AuditService.log({
      company_id: ctx.company.id,
      site_id: document.site_id,
      user_id: ctx.user.id,
      action: 'regulatory_document.archived',
      module: 'regulatory',
      record_type: 'regulatory_documents',
      record_id: documentId,
      old_value: { status: document.status },
      new_value: { status: 'archived', reason: input.reason },
    });

    return updated as RegulatoryDocument;
  },

  // Manual status override — excluded from every role's default grant
  // (override_regulatory_status), since it can mask a real compliance lapse.
  async overrideStatus(
    documentId: string,
    input: OverrideDocumentStatusInput,
    ctx: RequestContext,
  ): Promise<RegulatoryDocument> {
    await PermissionService.requirePermission(ctx.user.id, 'override_regulatory_status');
    const document = await getDocumentOrThrow(documentId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data: updated, error } = await supabase
      .from('regulatory_documents')
      .update({ status: input.new_status })
      .eq('id', documentId)
      .select(DOCUMENT_COLUMNS)
      .single();

    if (error || !updated) throw new DatabaseError(error?.message ?? 'Failed to override status');

    await writeHistory(documentId, null, document.status, input.new_status, input.reason, ctx);
    await AuditService.log({
      company_id: ctx.company.id,
      site_id: document.site_id,
      user_id: ctx.user.id,
      action: 'regulatory_document.status_overridden',
      module: 'regulatory',
      record_type: 'regulatory_documents',
      record_id: documentId,
      old_value: { status: document.status },
      new_value: { status: input.new_status, reason: input.reason },
    });

    return updated as RegulatoryDocument;
  },

  async listVersions(documentId: string, ctx: RequestContext): Promise<DocumentVersion[]> {
    await PermissionService.requirePermission(ctx.user.id, 'view_regulatory');
    await getDocumentOrThrow(documentId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('document_versions')
      .select(VERSION_COLUMNS)
      .eq('document_id', documentId)
      .order('uploaded_at', { ascending: false });

    if (error) throw new DatabaseError(error.message);
    return (data as unknown as DocumentVersion[]) ?? [];
  },

  async listHistory(documentId: string, ctx: RequestContext): Promise<DocumentHistoryEntry[]> {
    await PermissionService.requirePermission(ctx.user.id, 'view_regulatory_audit');
    await getDocumentOrThrow(documentId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('document_history')
      .select(
        'id, company_id, document_id, staff_document_id, version_id, old_status, new_status, changed_by, changed_at, reason',
      )
      .eq('document_id', documentId)
      .order('changed_at', { ascending: false });

    if (error) throw new DatabaseError(error.message);
    return (data as DocumentHistoryEntry[]) ?? [];
  },
};

// Re-exported for the Edge Function and unit tests, which need the pure
// status-computation logic without the full service's permission/DB wiring.
export { computeSlotStatus };
