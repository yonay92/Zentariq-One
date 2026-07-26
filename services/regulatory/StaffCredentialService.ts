import { createHash, randomUUID } from 'crypto';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import { NotFoundError, DatabaseError, BusinessRuleError } from '@/lib/api/errors';
import { computeSlotStatus } from '@/services/regulatory/RegulatoryDocumentService';
import type {
  StaffDocument,
  StaffDocumentWithType,
  DocumentVersion,
  DocumentHistoryEntry,
  CreateStaffDocumentInput,
  UploadDocumentVersionInput,
  ArchiveDocumentInput,
  DuplicateChecksumWarning,
} from '@/types/regulatory';
import type { RequestContext } from '@/types/api';

const STAFF_DOC_COLUMNS =
  'id, company_id, user_id, site_id, document_type_id, file_id, version, effective_date, expiration_date, status, created_at, updated_at';

const STAFF_DOC_WITH_TYPE_COLUMNS = `${STAFF_DOC_COLUMNS}, document_type:document_types(id, name, category, has_expiration)`;

const VERSION_COLUMNS =
  'id, company_id, document_id, staff_document_id, previous_version_id, version, file_id, checksum, is_current, status, effective_date, expiration_date, replacement_reason, duplicate_of_version_id, uploaded_by, uploaded_at, reviewed_by, reviewed_at, file:files(id, file_name, original_name, file_size, mime_type)';

async function getStaffDocumentOrThrow(id: string, ctx: RequestContext): Promise<StaffDocument> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from('staff_documents')
    .select(STAFF_DOC_COLUMNS)
    .eq('id', id)
    .eq('company_id', ctx.company.id)
    .single();

  if (error || !data) throw new NotFoundError('Staff credential');
  return data as StaffDocument;
}

async function getCurrentVersion(staffDocumentId: string): Promise<DocumentVersion | null> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from('document_versions')
    .select(VERSION_COLUMNS)
    .eq('staff_document_id', staffDocumentId)
    .eq('is_current', true)
    .maybeSingle();

  return (data as DocumentVersion | null) ?? null;
}

function computeChecksum(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
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
    throw new DatabaseError(`Staff credential upload failed: ${uploadError.message}`);
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

async function writeHistory(
  staffDocumentId: string,
  versionId: string | null,
  oldStatus: string | null,
  newStatus: string,
  reason: string | null,
  ctx: RequestContext,
): Promise<void> {
  const supabase = await createServerSupabaseClient();
  await supabase.from('document_history').insert({
    company_id: ctx.company.id,
    staff_document_id: staffDocumentId,
    version_id: versionId,
    old_status: oldStatus,
    new_status: newStatus,
    changed_by: ctx.user.id,
    reason,
  });
}

export const StaffCredentialService = {
  async listForUser(userId: string, ctx: RequestContext): Promise<StaffDocumentWithType[]> {
    // A user may always see their own credentials; anyone else requires
    // view_staff_credentials — enforced by RLS as the source of truth, this
    // is a defense-in-depth check that produces a clearer error message.
    if (userId !== ctx.user.id) {
      await PermissionService.requirePermission(ctx.user.id, 'view_staff_credentials');
    }

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('staff_documents')
      .select(STAFF_DOC_WITH_TYPE_COLUMNS)
      .eq('company_id', ctx.company.id)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw new DatabaseError(error.message);
    return (data as unknown as StaffDocumentWithType[]) ?? [];
  },

  async create(
    input: CreateStaffDocumentInput,
    file: File,
    ctx: RequestContext,
  ): Promise<StaffDocument> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_staff_credentials');
    if (input.site_id) await PermissionService.requireSiteAccess(ctx.user.id, input.site_id);

    const supabase = await createServerSupabaseClient();

    const { data: slot, error: slotError } = await supabase
      .from('staff_documents')
      .insert({
        company_id: ctx.company.id,
        user_id: input.user_id,
        site_id: input.site_id ?? null,
        document_type_id: input.document_type_id,
        status: 'pending_review',
      })
      .select(STAFF_DOC_COLUMNS)
      .single();

    if (slotError || !slot) {
      if (slotError?.code === '23505') {
        throw new BusinessRuleError(
          'A credential of this type already exists for this staff member — use Replace to add a new version instead.',
        );
      }
      throw new DatabaseError(slotError?.message ?? 'Failed to create staff credential');
    }

    const staffDocument = slot as StaffDocument;
    const versionId = randomUUID();
    const storageKey = `${ctx.company.id}/staff/${input.user_id}/${input.document_type_id}/${versionId}_${file.name}`;

    const { fileId, checksum } = await uploadFile(file, storageKey, ctx);

    const { error: versionError } = await supabase.from('document_versions').insert({
      id: versionId,
      company_id: ctx.company.id,
      staff_document_id: staffDocument.id,
      version: 'v1',
      file_id: fileId,
      checksum,
      is_current: true,
      status: 'approved',
      effective_date: input.effective_date ?? null,
      expiration_date: input.expiration_date ?? null,
      uploaded_by: ctx.user.id,
      reviewed_by: ctx.user.id,
      reviewed_at: new Date().toISOString(),
    });

    if (versionError) throw new DatabaseError(versionError.message);

    const newStatus = computeSlotStatus(input.expiration_date ?? null);
    const { data: updated, error: updateError } = await supabase
      .from('staff_documents')
      .update({
        file_id: fileId,
        version: 'v1',
        effective_date: input.effective_date ?? null,
        expiration_date: input.expiration_date ?? null,
        status: newStatus,
      })
      .eq('id', staffDocument.id)
      .select(STAFF_DOC_COLUMNS)
      .single();

    if (updateError || !updated) {
      throw new DatabaseError(updateError?.message ?? 'Failed to finalize staff credential');
    }

    await writeHistory(staffDocument.id, versionId, null, newStatus, null, ctx);
    await AuditService.log({
      company_id: ctx.company.id,
      site_id: staffDocument.site_id,
      user_id: ctx.user.id,
      action: 'staff_document.uploaded',
      module: 'regulatory',
      record_type: 'staff_documents',
      record_id: staffDocument.id,
      new_value: { document_type_id: staffDocument.document_type_id, user_id: input.user_id },
    });

    return updated as StaffDocument;
  },

  async replace(
    staffDocumentId: string,
    file: File,
    input: UploadDocumentVersionInput,
    ctx: RequestContext,
  ): Promise<StaffDocument | DuplicateChecksumWarning> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_staff_credentials');
    const staffDocument = await getStaffDocumentOrThrow(staffDocumentId, ctx);
    if (staffDocument.status === 'archived') {
      throw new BusinessRuleError('An archived credential cannot be replaced — restore it first.');
    }
    if (!input.replacement_reason?.trim()) {
      throw new BusinessRuleError('A reason is required when replacing a credential version.');
    }

    const supabase = await createServerSupabaseClient();
    const buffer = Buffer.from(await file.arrayBuffer());
    const checksum = computeChecksum(buffer);

    if (!input.confirm_duplicate) {
      const { data: existingMatch } = await supabase
        .from('document_versions')
        .select('id, version, uploaded_at, uploaded_by')
        .eq('staff_document_id', staffDocumentId)
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

    const previousVersion = await getCurrentVersion(staffDocumentId);
    if (!previousVersion) {
      throw new BusinessRuleError('This credential has no existing version to replace.');
    }

    const { error: supersedeError } = await supabase
      .from('document_versions')
      .update({ is_current: false, status: 'superseded' })
      .eq('id', previousVersion.id);

    if (supersedeError) throw new DatabaseError(supersedeError.message);

    const versionId = randomUUID();
    const storageKey = `${ctx.company.id}/staff/${staffDocument.user_id}/${staffDocument.document_type_id}/${versionId}_${file.name}`;
    const { fileId } = await uploadFile(file, storageKey, ctx);
    const nextVersionLabel = `v${Number.parseInt(previousVersion.version.replace(/\D/g, ''), 10) + 1 || 2}`;

    const { error: versionError } = await supabase.from('document_versions').insert({
      id: versionId,
      company_id: ctx.company.id,
      staff_document_id: staffDocumentId,
      previous_version_id: previousVersion.id,
      version: nextVersionLabel,
      file_id: fileId,
      checksum,
      is_current: true,
      status: 'approved',
      effective_date: input.effective_date ?? null,
      expiration_date: input.expiration_date ?? null,
      replacement_reason: input.replacement_reason,
      duplicate_of_version_id: input.confirm_duplicate ? previousVersion.id : null,
      uploaded_by: ctx.user.id,
      reviewed_by: ctx.user.id,
      reviewed_at: new Date().toISOString(),
    });

    if (versionError) throw new DatabaseError(versionError.message);

    const newStatus = computeSlotStatus(input.expiration_date ?? null);
    const { data: updated, error: updateError } = await supabase
      .from('staff_documents')
      .update({
        file_id: fileId,
        version: nextVersionLabel,
        effective_date: input.effective_date ?? null,
        expiration_date: input.expiration_date ?? null,
        status: newStatus,
      })
      .eq('id', staffDocumentId)
      .select(STAFF_DOC_COLUMNS)
      .single();

    if (updateError || !updated)
      throw new DatabaseError(updateError?.message ?? 'Failed to replace');

    await writeHistory(
      staffDocumentId,
      previousVersion.id,
      previousVersion.status,
      'superseded',
      input.replacement_reason,
      ctx,
    );
    await writeHistory(staffDocumentId, versionId, null, newStatus, null, ctx);

    await AuditService.log({
      company_id: ctx.company.id,
      site_id: staffDocument.site_id,
      user_id: ctx.user.id,
      action: 'staff_document.replaced',
      module: 'regulatory',
      record_type: 'staff_documents',
      record_id: staffDocumentId,
      old_value: { superseded_version: previousVersion.version },
      new_value: { new_version: nextVersionLabel, replacement_reason: input.replacement_reason },
    });

    return updated as StaffDocument;
  },

  async archive(
    staffDocumentId: string,
    input: ArchiveDocumentInput,
    ctx: RequestContext,
  ): Promise<StaffDocument> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_staff_credentials');
    const staffDocument = await getStaffDocumentOrThrow(staffDocumentId, ctx);

    const supabase = await createServerSupabaseClient();
    const version = await getCurrentVersion(staffDocumentId);
    if (version) {
      await supabase
        .from('document_versions')
        .update({ status: 'archived', is_current: false })
        .eq('id', version.id);
    }

    const { data: updated, error } = await supabase
      .from('staff_documents')
      .update({ status: 'archived' })
      .eq('id', staffDocumentId)
      .select(STAFF_DOC_COLUMNS)
      .single();

    if (error || !updated) throw new DatabaseError(error?.message ?? 'Failed to archive');

    await writeHistory(
      staffDocumentId,
      version?.id ?? null,
      staffDocument.status,
      'archived',
      input.reason,
      ctx,
    );
    await AuditService.log({
      company_id: ctx.company.id,
      site_id: staffDocument.site_id,
      user_id: ctx.user.id,
      action: 'staff_document.archived',
      module: 'regulatory',
      record_type: 'staff_documents',
      record_id: staffDocumentId,
      old_value: { status: staffDocument.status },
      new_value: { status: 'archived', reason: input.reason },
    });

    return updated as StaffDocument;
  },

  async listVersions(staffDocumentId: string, ctx: RequestContext): Promise<DocumentVersion[]> {
    await PermissionService.requirePermission(ctx.user.id, 'view_staff_credentials');
    await getStaffDocumentOrThrow(staffDocumentId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('document_versions')
      .select(VERSION_COLUMNS)
      .eq('staff_document_id', staffDocumentId)
      .order('uploaded_at', { ascending: false });

    if (error) throw new DatabaseError(error.message);
    return (data as unknown as DocumentVersion[]) ?? [];
  },

  async listHistory(staffDocumentId: string, ctx: RequestContext): Promise<DocumentHistoryEntry[]> {
    await PermissionService.requirePermission(ctx.user.id, 'view_regulatory_audit');
    await getStaffDocumentOrThrow(staffDocumentId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('document_history')
      .select(
        'id, company_id, document_id, staff_document_id, version_id, old_status, new_status, changed_by, changed_at, reason',
      )
      .eq('staff_document_id', staffDocumentId)
      .order('changed_at', { ascending: false });

    if (error) throw new DatabaseError(error.message);
    return (data as DocumentHistoryEntry[]) ?? [];
  },
};
