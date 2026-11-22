import { createServerSupabaseClient } from '@/lib/supabase/server';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import {
  NotFoundError,
  DatabaseError,
  BusinessRuleError,
  databaseWriteError,
} from '@/lib/api/errors';
import type {
  VisitTemplate,
  VisitTemplateItem,
  VisitTemplateWithItems,
  VisitTemplateSource,
  CreateVisitTemplateItemInput,
} from '@/types/studies';
import type { RequestContext } from '@/types/api';

const TEMPLATE_COLUMNS =
  'id, company_id, study_id, version, source, status, approved_by, approved_at, created_by, created_at, updated_at';
const ITEM_COLUMNS =
  'id, company_id, template_id, visit_name, visit_order, offset_days, window_before, window_after, visit_type, is_required, is_baseline, notes, created_at, updated_at';

export const VisitTemplateService = {
  async listByStudy(studyId: string, ctx: RequestContext): Promise<VisitTemplateWithItems[]> {
    await PermissionService.requirePermission(ctx.user.id, 'view_studies');

    const supabase = await createServerSupabaseClient();
    const { data: templates } = await supabase
      .from('visit_templates')
      .select(TEMPLATE_COLUMNS)
      .eq('study_id', studyId)
      .eq('company_id', ctx.company.id)
      .order('version', { ascending: false });

    if (!templates || templates.length === 0) return [];

    const { data: items } = await supabase
      .from('visit_template_items')
      .select(ITEM_COLUMNS)
      .in(
        'template_id',
        (templates as VisitTemplate[]).map((t) => t.id),
      )
      .order('visit_order');

    const itemsByTemplate = new Map<string, VisitTemplateItem[]>();
    for (const item of (items as VisitTemplateItem[]) ?? []) {
      const list = itemsByTemplate.get(item.template_id) ?? [];
      list.push(item);
      itemsByTemplate.set(item.template_id, list);
    }

    return (templates as VisitTemplate[]).map((t) => ({
      ...t,
      items: itemsByTemplate.get(t.id) ?? [],
    }));
  },

  async getById(templateId: string, ctx: RequestContext): Promise<VisitTemplateWithItems> {
    await PermissionService.requirePermission(ctx.user.id, 'view_studies');

    const supabase = await createServerSupabaseClient();
    const { data: template, error } = await supabase
      .from('visit_templates')
      .select(TEMPLATE_COLUMNS)
      .eq('id', templateId)
      .eq('company_id', ctx.company.id)
      .single();

    if (error || !template) throw new NotFoundError('Visit template');

    const { data: items } = await supabase
      .from('visit_template_items')
      .select(ITEM_COLUMNS)
      .eq('template_id', templateId)
      .order('visit_order');

    return { ...(template as VisitTemplate), items: (items as VisitTemplateItem[]) ?? [] };
  },

  async hasApprovedTemplate(studyId: string, companyId: string): Promise<boolean> {
    const supabase = await createServerSupabaseClient();
    const { data } = await supabase
      .from('visit_templates')
      .select('id')
      .eq('study_id', studyId)
      .eq('company_id', companyId)
      .eq('status', 'approved')
      .maybeSingle();

    return data !== null;
  },

  async createTemplate(
    studyId: string,
    items: CreateVisitTemplateItemInput[],
    ctx: RequestContext,
    source: VisitTemplateSource = 'manual',
  ): Promise<VisitTemplateWithItems> {
    await PermissionService.requireAnyPermission(ctx.user.id, ['edit_study', 'manage_studies']);

    const baselineCount = items.filter((item) => item.is_baseline).length;
    if (baselineCount !== 1) {
      throw new BusinessRuleError('Exactly one visit must be marked as Baseline');
    }

    const supabase = await createServerSupabaseClient();

    const { data: existing } = await supabase
      .from('visit_templates')
      .select('version')
      .eq('study_id', studyId)
      .eq('company_id', ctx.company.id)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();

    const nextVersion = ((existing as { version: number } | null)?.version ?? 0) + 1;

    const { data: template, error } = await supabase
      .from('visit_templates')
      .insert({
        company_id: ctx.company.id,
        study_id: studyId,
        version: nextVersion,
        source,
        status: 'draft',
        created_by: ctx.user.id,
      })
      .select(TEMPLATE_COLUMNS)
      .single();

    if (error || !template) {
      throw databaseWriteError(error, 'Failed to create visit template');
    }

    const templateId = (template as VisitTemplate).id;

    const { data: insertedItems, error: itemsError } = await supabase
      .from('visit_template_items')
      .insert(
        items.map((item) => ({
          company_id: ctx.company.id,
          template_id: templateId,
          visit_name: item.visit_name,
          visit_order: item.visit_order,
          offset_days: item.offset_days ?? 0,
          window_before: item.window_before ?? 0,
          window_after: item.window_after ?? 0,
          visit_type: item.visit_type ?? 'scheduled',
          is_required: item.is_required ?? true,
          is_baseline: item.is_baseline ?? false,
          notes: item.notes ?? null,
        })),
      )
      .select(ITEM_COLUMNS);

    if (itemsError) {
      throw databaseWriteError(itemsError, 'Failed to create visit template items');
    }

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'visit_template.created',
      module: 'studies',
      record_type: 'visit_templates',
      record_id: templateId,
      new_value: { study_id: studyId, version: nextVersion, source, item_count: items.length },
    });

    return { ...(template as VisitTemplate), items: (insertedItems as VisitTemplateItem[]) ?? [] };
  },

  async approveTemplate(templateId: string, ctx: RequestContext): Promise<VisitTemplate> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_studies');

    const supabase = await createServerSupabaseClient();
    const { data: template } = await supabase
      .from('visit_templates')
      .select(TEMPLATE_COLUMNS)
      .eq('id', templateId)
      .eq('company_id', ctx.company.id)
      .maybeSingle();

    if (!template) throw new NotFoundError('Visit template');
    if ((template as VisitTemplate).status !== 'draft') {
      throw new BusinessRuleError('Only a draft template can be approved');
    }

    const studyId = (template as VisitTemplate).study_id;

    // Only one approved template may be active per study — archive the previous one.
    await supabase
      .from('visit_templates')
      .update({ status: 'archived' })
      .eq('study_id', studyId)
      .eq('company_id', ctx.company.id)
      .eq('status', 'approved');

    const { data: updated, error } = await supabase
      .from('visit_templates')
      .update({
        status: 'approved',
        approved_by: ctx.user.id,
        approved_at: new Date().toISOString(),
      })
      .eq('id', templateId)
      .select(TEMPLATE_COLUMNS)
      .single();

    if (error || !updated) throw databaseWriteError(error, 'Failed to approve template');

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'visit_template.approved',
      module: 'studies',
      record_type: 'visit_templates',
      record_id: templateId,
      new_value: { study_id: studyId },
    });

    return updated as VisitTemplate;
  },

  async archiveTemplate(templateId: string, ctx: RequestContext): Promise<VisitTemplate> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_studies');

    const supabase = await createServerSupabaseClient();
    const { data: existing } = await supabase
      .from('visit_templates')
      .select('id, study_id')
      .eq('id', templateId)
      .eq('company_id', ctx.company.id)
      .maybeSingle();

    if (!existing) throw new NotFoundError('Visit template');

    const { data: updated, error } = await supabase
      .from('visit_templates')
      .update({ status: 'archived' })
      .eq('id', templateId)
      .select(TEMPLATE_COLUMNS)
      .single();

    if (error || !updated) throw databaseWriteError(error, 'Failed to archive template');

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'visit_template.archived',
      module: 'studies',
      record_type: 'visit_templates',
      record_id: templateId,
    });

    return updated as VisitTemplate;
  },
};
