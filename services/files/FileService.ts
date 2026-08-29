import { createHash, randomUUID } from 'crypto';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@/lib/supabase/admin';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import { NotFoundError, DatabaseError, PermissionDeniedError } from '@/lib/api/errors';
import type {
  FileRecord,
  FileLink,
  FileWithLinks,
  LinkFileToRecordInput,
  ListFilesFilters,
} from '@/types/files';
import type { RequestContext } from '@/types/api';

const BUCKET = 'documents';
const FILE_COLUMNS =
  'id, company_id, file_name, original_name, file_extension, mime_type, file_size, storage_path, uploaded_by, uploaded_at, checksum, ai_processed';
const LINK_COLUMNS = 'id, company_id, file_id, site_id, module, record_id, created_by, created_at';

function computeChecksum(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

// Deliberately uses the admin client, bypassing file_links' own RLS, for this
// one lookup only — the caller has already proven company ownership of
// fileId via a prior RLS-protected `files` row fetch, so this is safe. It
// must see the FULL set of site-scoped links (not just the subset the
// caller's own site access would let file_links' RLS reveal), otherwise a
// user without access to the file's linked site would see an empty result —
// indistinguishable from "no site restriction at all" — and get waved
// through instead of correctly rejected.
async function getLinkedSiteIds(fileId: string): Promise<string[]> {
  const supabase = createAdminSupabaseClient();
  const { data } = await supabase
    .from('file_links')
    .select('site_id')
    .eq('file_id', fileId)
    .not('site_id', 'is', null);

  const rows = (data as Array<{ site_id: string }> | null) ?? [];
  return Array.from(new Set(rows.map((r) => r.site_id)));
}

// A file with no site-scoped links at all is company-wide (e.g. uploaded but
// not yet linked, or linked only to company-wide records) — access to any
// ONE of its linked sites is sufficient, matching how a user with access to
// a specific subject can already see files linked to that subject.
async function assertSiteAuthorized(userId: string, fileId: string): Promise<void> {
  const siteIds = await getLinkedSiteIds(fileId);
  if (siteIds.length === 0) return;

  for (const siteId of siteIds) {
    if (await PermissionService.canAccessSite(userId, siteId)) return;
  }
  throw new PermissionDeniedError('file:site_access');
}

export const FileService = {
  /**
   * Uploads a file into the private `documents` bucket and records its
   * metadata in `files`. Does not link it to anything — call linkToRecord
   * separately.
   */
  async upload(file: File, ctx: RequestContext): Promise<FileRecord> {
    await PermissionService.requirePermission(ctx.user.id, 'upload_documents');

    const supabase = await createServerSupabaseClient();
    const buffer = Buffer.from(await file.arrayBuffer());
    const checksum = computeChecksum(buffer);
    const fileExtension = file.name.includes('.') ? (file.name.split('.').pop() ?? null) : null;
    const storageKey = `${ctx.company.id}/${randomUUID()}_${file.name}`;

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(storageKey, buffer, { contentType: file.type, upsert: false });

    if (uploadError) {
      throw new DatabaseError(`File upload failed: ${uploadError.message}`);
    }

    const { data, error } = await supabase
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
      .select(FILE_COLUMNS)
      .single();

    if (error || !data) {
      // The storage object was written but the metadata row failed — clean
      // up the orphan rather than leaving an unreferenced object behind.
      await supabase.storage.from(BUCKET).remove([storageKey]);
      throw new DatabaseError(error?.message ?? 'Failed to record uploaded file');
    }

    const fileRecord = data as FileRecord;

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'file.uploaded',
      module: 'documents',
      record_type: 'files',
      record_id: fileRecord.id,
      new_value: { file_name: fileRecord.file_name, file_size: fileRecord.file_size },
    });

    return fileRecord;
  },

  /**
   * Fetches file metadata. company_id isolation is enforced by RLS on
   * `files` (the row simply doesn't exist for a foreign-company session);
   * site-level authorization is layered on top via file_links.
   */
  async getMetadata(fileId: string, ctx: RequestContext): Promise<FileRecord> {
    await PermissionService.requirePermission(ctx.user.id, 'view_documents');

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('files')
      .select(FILE_COLUMNS)
      .eq('id', fileId)
      .eq('company_id', ctx.company.id)
      .single();

    if (error || !data) throw new NotFoundError('File');

    await assertSiteAuthorized(ctx.user.id, fileId);

    return data as FileRecord;
  },

  /** getMetadata plus every file_links row for that file — used by the Document Center preview panel. */
  async getWithLinks(fileId: string, ctx: RequestContext): Promise<FileWithLinks> {
    const file = await this.getMetadata(fileId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data } = await supabase
      .from('file_links')
      .select(LINK_COLUMNS)
      .eq('company_id', ctx.company.id)
      .eq('file_id', fileId);

    return { ...file, links: (data as FileLink[]) ?? [] };
  },

  /**
   * Company-scoped file browsing for the Document Center. Every returned row
   * has already passed the same site-authorization check getMetadata applies
   * to a single file (skipped in bulk for callers holding view_all_sites).
   * module/uploaded_by/date filters are optional and combine with AND.
   */
  async list(filters: ListFilesFilters, ctx: RequestContext): Promise<FileWithLinks[]> {
    await PermissionService.requirePermission(ctx.user.id, 'view_documents');

    const supabase = await createServerSupabaseClient();

    let matchingFileIds: string[] | null = null;
    if (filters.module) {
      const { data: moduleLinks } = await supabase
        .from('file_links')
        .select('file_id')
        .eq('company_id', ctx.company.id)
        .eq('module', filters.module);
      matchingFileIds = Array.from(
        new Set(((moduleLinks as Array<{ file_id: string }> | null) ?? []).map((r) => r.file_id)),
      );
      if (matchingFileIds.length === 0) return [];
    }

    let query = supabase
      .from('files')
      .select(FILE_COLUMNS)
      .eq('company_id', ctx.company.id)
      .order('uploaded_at', { ascending: false });

    if (matchingFileIds) query = query.in('id', matchingFileIds);
    if (filters.uploaded_by) query = query.eq('uploaded_by', filters.uploaded_by);
    if (filters.uploaded_after) query = query.gte('uploaded_at', filters.uploaded_after);
    if (filters.uploaded_before) query = query.lte('uploaded_at', filters.uploaded_before);

    const { data } = await query;
    const files = (data as FileRecord[] | null) ?? [];
    if (files.length === 0) return [];

    const { data: linkRows } = await supabase
      .from('file_links')
      .select(LINK_COLUMNS)
      .eq('company_id', ctx.company.id)
      .in(
        'file_id',
        files.map((f) => f.id),
      );

    const linksByFile = new Map<string, FileLink[]>();
    for (const link of (linkRows as FileLink[] | null) ?? []) {
      const existing = linksByFile.get(link.file_id) ?? [];
      existing.push(link);
      linksByFile.set(link.file_id, existing);
    }

    const hasAllSites = await PermissionService.hasPermission(ctx.user.id, 'view_all_sites');

    const results: FileWithLinks[] = [];
    for (const file of files) {
      const links = linksByFile.get(file.id) ?? [];

      if (!hasAllSites) {
        const siteIds = Array.from(
          new Set(links.map((l) => l.site_id).filter((s): s is string => Boolean(s))),
        );
        if (siteIds.length > 0) {
          let authorized = false;
          for (const siteId of siteIds) {
            if (await PermissionService.canAccessSite(ctx.user.id, siteId)) {
              authorized = true;
              break;
            }
          }
          if (!authorized) continue;
        }
      }

      results.push({ ...file, links });
    }

    return results;
  },

  /**
   * Issues a time-limited signed URL. Authorization (company + site) is
   * fully resolved by getMetadata before storage.createSignedUrl is ever
   * called — see this migration's authorization-model comment
   * (022_document_center_foundation.sql) for why the actual signed-url call
   * still goes through the session-scoped (RLS-respecting) client rather
   * than the admin client, even after that check passes.
   */
  async getSignedUrl(
    fileId: string,
    ctx: RequestContext,
    expiresInSeconds = 3600,
  ): Promise<string> {
    const file = await this.getMetadata(fileId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(file.storage_path, expiresInSeconds);

    if (error || !data) {
      throw new DatabaseError(error?.message ?? 'Failed to create signed URL');
    }

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'file.signed_url_issued',
      module: 'documents',
      record_type: 'files',
      record_id: fileId,
    });

    return data.signedUrl;
  },

  /**
   * Links a file to any domain record. site_id must be resolved by the
   * caller (the only party that knows what the target module/record
   * actually is) — FileService does not attempt module-specific lookups.
   */
  async linkToRecord(input: LinkFileToRecordInput, ctx: RequestContext): Promise<FileLink> {
    await PermissionService.requirePermission(ctx.user.id, 'upload_documents');

    // Confirms the file belongs to the caller's company (and that the caller
    // can already see it) before attempting the insert — RLS's file_links_insert
    // EXISTS check enforces the same thing at the database level; this gives
    // a clean NotFoundError instead of an opaque RLS-denial error.
    await this.getMetadata(input.file_id, ctx);

    if (input.site_id) {
      await PermissionService.requireSiteAccess(ctx.user.id, input.site_id);
    }

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('file_links')
      .insert({
        company_id: ctx.company.id,
        file_id: input.file_id,
        site_id: input.site_id ?? null,
        module: input.module,
        record_id: input.record_id,
        created_by: ctx.user.id,
      })
      .select(LINK_COLUMNS)
      .single();

    if (error || !data) {
      throw new DatabaseError(error?.message ?? 'Failed to link file to record');
    }

    const link = data as FileLink;

    await AuditService.log({
      company_id: ctx.company.id,
      site_id: link.site_id,
      user_id: ctx.user.id,
      action: 'file.linked',
      module: 'documents',
      record_type: 'file_links',
      record_id: link.id,
      new_value: { file_id: input.file_id, module: input.module, record_id: input.record_id },
    });

    return link;
  },

  /** Removes a file_links row. The underlying file/storage object is untouched. */
  async unlink(fileLinkId: string, ctx: RequestContext): Promise<void> {
    await PermissionService.requirePermission(ctx.user.id, 'upload_documents');

    const supabase = await createServerSupabaseClient();
    const { data: existing } = await supabase
      .from('file_links')
      .select(LINK_COLUMNS)
      .eq('id', fileLinkId)
      .eq('company_id', ctx.company.id)
      .maybeSingle();

    if (!existing) throw new NotFoundError('File link');

    const link = existing as FileLink;

    const { error } = await supabase
      .from('file_links')
      .delete()
      .eq('id', fileLinkId)
      .eq('company_id', ctx.company.id);

    if (error) throw new DatabaseError(error.message);

    await AuditService.log({
      company_id: ctx.company.id,
      site_id: link.site_id,
      user_id: ctx.user.id,
      action: 'file.unlinked',
      module: 'documents',
      record_type: 'file_links',
      record_id: fileLinkId,
      old_value: { file_id: link.file_id, module: link.module, record_id: link.record_id },
    });
  },

  /** All files linked to a given domain record. */
  async listLinksForRecord(
    moduleName: string,
    recordId: string,
    ctx: RequestContext,
  ): Promise<FileLink[]> {
    await PermissionService.requirePermission(ctx.user.id, 'view_documents');

    const supabase = await createServerSupabaseClient();
    const { data } = await supabase
      .from('file_links')
      .select(LINK_COLUMNS)
      .eq('company_id', ctx.company.id)
      .eq('module', moduleName)
      .eq('record_id', recordId);

    return (data as FileLink[]) ?? [];
  },
};
