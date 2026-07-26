import { createServerSupabaseClient } from '@/lib/supabase/server';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import { NotFoundError, DatabaseError } from '@/lib/api/errors';
import type {
  RegulatoryDocumentRequirement,
  CreateRegulatoryRequirementInput,
  UpdateRegulatoryRequirementInput,
} from '@/types/regulatory';
import type { RequestContext } from '@/types/api';

const REQUIREMENT_COLUMNS =
  'id, company_id, study_id, site_id, document_type_id, required, expiration_required, applies_to, created_at';

export const RegulatoryRequirementService = {
  async list(
    filters: { study_id?: string | undefined; site_id?: string | undefined },
    ctx: RequestContext,
  ): Promise<RegulatoryDocumentRequirement[]> {
    await PermissionService.requirePermission(ctx.user.id, 'view_regulatory');

    const supabase = await createServerSupabaseClient();
    let query = supabase
      .from('study_document_requirements')
      .select(REQUIREMENT_COLUMNS)
      .eq('company_id', ctx.company.id);

    if (filters.study_id) query = query.eq('study_id', filters.study_id);
    if (filters.site_id) query = query.eq('site_id', filters.site_id);

    const { data, error } = await query;
    if (error) throw new DatabaseError(error.message);
    return (data as RegulatoryDocumentRequirement[]) ?? [];
  },

  async create(
    input: CreateRegulatoryRequirementInput,
    ctx: RequestContext,
  ): Promise<RegulatoryDocumentRequirement> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_regulatory_requirements');
    if (input.site_id) await PermissionService.requireSiteAccess(ctx.user.id, input.site_id);

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('study_document_requirements')
      .insert({
        company_id: ctx.company.id,
        study_id: input.study_id ?? null,
        site_id: input.site_id ?? null,
        document_type_id: input.document_type_id,
        required: input.required ?? true,
        expiration_required: input.expiration_required ?? false,
      })
      .select(REQUIREMENT_COLUMNS)
      .single();

    if (error || !data) throw new DatabaseError(error?.message ?? 'Failed to create requirement');

    const requirement = data as RegulatoryDocumentRequirement;
    await AuditService.log({
      company_id: ctx.company.id,
      site_id: requirement.site_id,
      user_id: ctx.user.id,
      action: 'regulatory_requirement.created',
      module: 'regulatory',
      record_type: 'study_document_requirements',
      record_id: requirement.id,
      new_value: {
        document_type_id: requirement.document_type_id,
        study_id: requirement.study_id,
        site_id: requirement.site_id,
      },
    });

    return requirement;
  },

  async update(
    requirementId: string,
    input: UpdateRegulatoryRequirementInput,
    ctx: RequestContext,
  ): Promise<RegulatoryDocumentRequirement> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_regulatory_requirements');

    const supabase = await createServerSupabaseClient();
    const { data: existing, error: existingError } = await supabase
      .from('study_document_requirements')
      .select(REQUIREMENT_COLUMNS)
      .eq('id', requirementId)
      .eq('company_id', ctx.company.id)
      .single();

    if (existingError || !existing) throw new NotFoundError('Regulatory requirement');

    const patch: Record<string, unknown> = {};
    if (input.required !== undefined) patch.required = input.required;
    if (input.expiration_required !== undefined)
      patch.expiration_required = input.expiration_required;

    const { data, error } = await supabase
      .from('study_document_requirements')
      .update(patch)
      .eq('id', requirementId)
      .eq('company_id', ctx.company.id)
      .select(REQUIREMENT_COLUMNS)
      .single();

    if (error || !data) throw new DatabaseError(error?.message ?? 'Failed to update requirement');

    const requirement = data as RegulatoryDocumentRequirement;
    await AuditService.log({
      company_id: ctx.company.id,
      site_id: requirement.site_id,
      user_id: ctx.user.id,
      action: 'regulatory_requirement.updated',
      module: 'regulatory',
      record_type: 'study_document_requirements',
      record_id: requirementId,
      old_value: existing as Record<string, unknown>,
      new_value: patch,
    });

    return requirement;
  },
};
