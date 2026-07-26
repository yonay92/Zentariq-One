import { createServerSupabaseClient } from '@/lib/supabase/server';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import { NotFoundError, DatabaseError } from '@/lib/api/errors';
import type {
  DocumentType,
  CreateDocumentTypeInput,
  UpdateDocumentTypeInput,
} from '@/types/regulatory';
import type { RequestContext } from '@/types/api';

const DOCUMENT_TYPE_COLUMNS =
  'id, company_id, name, category, has_expiration, expiration_rule, default_alert_days, requires_version, required_by_default, created_at, updated_at';

// document_types.category is free-text, configured per company — nothing in
// this service (or anywhere in the app) hardcodes a document name/category.
export const DocumentTypeService = {
  async list(ctx: RequestContext): Promise<DocumentType[]> {
    await PermissionService.requirePermission(ctx.user.id, 'view_regulatory');
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('document_types')
      .select(DOCUMENT_TYPE_COLUMNS)
      .eq('company_id', ctx.company.id)
      .order('category', { ascending: true, nullsFirst: false })
      .order('name', { ascending: true });

    if (error) throw new DatabaseError(error.message);
    return (data as DocumentType[]) ?? [];
  },

  async create(input: CreateDocumentTypeInput, ctx: RequestContext): Promise<DocumentType> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_regulatory_requirements');
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('document_types')
      .insert({
        company_id: ctx.company.id,
        name: input.name,
        category: input.category ?? null,
        has_expiration: input.has_expiration ?? false,
        default_alert_days: input.default_alert_days ?? [90, 60, 30, 14, 7],
        requires_version: input.requires_version ?? true,
        required_by_default: input.required_by_default ?? false,
      })
      .select(DOCUMENT_TYPE_COLUMNS)
      .single();

    if (error || !data) throw new DatabaseError(error?.message ?? 'Failed to create document type');

    const documentType = data as DocumentType;
    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'document_type.created',
      module: 'regulatory',
      record_type: 'document_types',
      record_id: documentType.id,
      new_value: { name: documentType.name, category: documentType.category },
    });

    return documentType;
  },

  async update(
    documentTypeId: string,
    input: UpdateDocumentTypeInput,
    ctx: RequestContext,
  ): Promise<DocumentType> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_regulatory_requirements');
    const supabase = await createServerSupabaseClient();

    const { data: existing, error: existingError } = await supabase
      .from('document_types')
      .select('id')
      .eq('id', documentTypeId)
      .eq('company_id', ctx.company.id)
      .single();

    if (existingError || !existing) throw new NotFoundError('Document type');

    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.category !== undefined) patch.category = input.category;
    if (input.has_expiration !== undefined) patch.has_expiration = input.has_expiration;
    if (input.default_alert_days !== undefined) patch.default_alert_days = input.default_alert_days;
    if (input.requires_version !== undefined) patch.requires_version = input.requires_version;
    if (input.required_by_default !== undefined)
      patch.required_by_default = input.required_by_default;

    const { data, error } = await supabase
      .from('document_types')
      .update(patch)
      .eq('id', documentTypeId)
      .eq('company_id', ctx.company.id)
      .select(DOCUMENT_TYPE_COLUMNS)
      .single();

    if (error || !data) throw new DatabaseError(error?.message ?? 'Failed to update document type');

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'document_type.updated',
      module: 'regulatory',
      record_type: 'document_types',
      record_id: documentTypeId,
      new_value: patch,
    });

    return data as DocumentType;
  },
};
