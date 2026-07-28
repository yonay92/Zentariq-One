import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@/lib/supabase/admin';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import { NotificationService } from '@/services/notifications/NotificationService';
import { VisitTemplateService } from '@/services/visit-templates/VisitTemplateService';
import { NotFoundError, DatabaseError, BusinessRuleError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';
import type {
  Study,
  StudyStatus,
  CreateStudyInput,
  UpdateStudyInput,
  StudySite,
  StudyAssignedSite,
  StudyAiExtraction,
  FileRecord,
  CrcOption,
  CreateVisitTemplateItemInput,
  ActivationReadiness,
  ActivationReadinessItem,
} from '@/types/studies';
import type { RequestContext } from '@/types/api';

const STUDY_COLUMNS =
  'id, company_id, study_name, protocol_number, sponsor, cro, phase, therapeutic_area, status, start_date, end_date, protocol_version, ai_generated, created_by, created_at, updated_at';

// AI protocol extraction is instructed to mark exactly one visit is_baseline: true
// (see supabase/functions/protocol-ai), but nothing in that pipeline enforces it — a
// model response can omit the flag on every item even when a Baseline visit is clearly
// named. VisitTemplateService.createTemplate correctly rejects anything but exactly one
// baseline, so recover deterministically here rather than leaving the reviewer stuck
// with an "Approve" button that always fails. Ambiguous cases still fail loudly.
export function resolveAiVisitTemplateBaseline(
  items: CreateVisitTemplateItemInput[],
): CreateVisitTemplateItemInput[] {
  const markedCount = items.filter((item) => item.is_baseline).length;
  if (markedCount === 1) return items;

  const byName = items.filter((item) => /^baseline$/i.test(item.visit_name.trim()));
  const byOffset = items.filter((item) => item.offset_days === 0);
  const resolved = byName.length === 1 ? byName[0] : byOffset.length === 1 ? byOffset[0] : null;

  if (!resolved) {
    throw new BusinessRuleError(
      markedCount === 0
        ? 'The AI extraction did not mark a Baseline visit, and none could be identified automatically (no visit named "Baseline" and no single visit at offset_days 0). Edit the extraction data or create the Visit Template manually.'
        : `The AI extraction marked ${markedCount} visits as Baseline. Edit the extraction data or create the Visit Template manually.`,
    );
  }

  return items.map((item) => ({ ...item, is_baseline: item === resolved }));
}

export type StudyListFilters = {
  status?: StudyStatus | undefined;
  site_id?: string | undefined;
  sponsor?: string | undefined;
  therapeutic_area?: string | undefined;
  // Archived studies are hidden from the default list. Pass 'archived' or 'all'
  // to see them; an explicit `status` filter always takes precedence over this.
  view?: 'active' | 'archived' | 'all' | undefined;
};

export type UpdateStudyServiceInput = UpdateStudyInput & { site_ids?: string[] };

export const StudyService = {
  async list(filters: StudyListFilters, ctx: RequestContext): Promise<Study[]> {
    await PermissionService.requirePermission(ctx.user.id, 'view_studies');

    const supabase = await createServerSupabaseClient();

    if (filters.site_id) {
      const { data } = await supabase
        .from('study_sites')
        .select(`studies!inner(${STUDY_COLUMNS})`)
        .eq('company_id', ctx.company.id)
        .eq('site_id', filters.site_id);

      let studies = ((data as Array<{ studies: Study }> | null) ?? []).map((r) => r.studies);
      if (filters.status) {
        studies = studies.filter((s) => s.status === filters.status);
      } else if (filters.view === 'archived') {
        studies = studies.filter((s) => s.status === 'archived');
      } else if (filters.view !== 'all') {
        studies = studies.filter((s) => s.status !== 'archived');
      }
      if (filters.sponsor) studies = studies.filter((s) => s.sponsor === filters.sponsor);
      if (filters.therapeutic_area) {
        studies = studies.filter((s) => s.therapeutic_area === filters.therapeutic_area);
      }
      return studies;
    }

    let query = supabase.from('studies').select(STUDY_COLUMNS).eq('company_id', ctx.company.id);
    if (filters.status) {
      query = query.eq('status', filters.status);
    } else if (filters.view === 'archived') {
      query = query.eq('status', 'archived');
    } else if (filters.view !== 'all') {
      query = query.neq('status', 'archived');
    }
    if (filters.sponsor) query = query.eq('sponsor', filters.sponsor);
    if (filters.therapeutic_area) query = query.eq('therapeutic_area', filters.therapeutic_area);

    const { data } = await query.order('created_at', { ascending: false });
    return (data as Study[]) ?? [];
  },

  async getById(studyId: string, ctx: RequestContext): Promise<Study> {
    await PermissionService.requirePermission(ctx.user.id, 'view_studies');

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('studies')
      .select(STUDY_COLUMNS)
      .eq('id', studyId)
      .eq('company_id', ctx.company.id)
      .single();

    if (error || !data) throw new NotFoundError('Study');
    return data as Study;
  },

  async create(input: CreateStudyInput, ctx: RequestContext): Promise<Study> {
    await PermissionService.requirePermission(ctx.user.id, 'create_study');

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('studies')
      .insert({
        company_id: ctx.company.id,
        created_by: ctx.user.id,
        status: 'draft',
        ai_generated: false,
        ...input,
      })
      .select(STUDY_COLUMNS)
      .single();

    if (error || !data) throw new DatabaseError(error?.message ?? 'Failed to create study');

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'study.created',
      module: 'studies',
      record_type: 'studies',
      record_id: (data as Study).id,
      new_value: input as Record<string, unknown>,
    });

    return data as Study;
  },

  async uploadProtocol(
    studyId: string,
    file: File,
    ctx: RequestContext,
  ): Promise<{ file: FileRecord; extraction_id: string | null }> {
    await PermissionService.requireAnyPermission(ctx.user.id, [
      'create_study',
      'edit_study',
      'manage_studies',
    ]);

    const study = await this.getById(studyId, ctx);

    const supabase = await createServerSupabaseClient();
    const storagePath = `${ctx.company.id}/${studyId}/${Date.now()}_${file.name}`;

    const { error: uploadError } = await supabase.storage
      .from('protocols')
      .upload(storagePath, file, { contentType: file.type, upsert: false });

    if (uploadError) {
      throw new DatabaseError(`Protocol upload failed: ${uploadError.message}`);
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
        storage_path: storagePath,
        uploaded_by: ctx.user.id,
      })
      .select(
        'id, company_id, file_name, original_name, file_extension, mime_type, file_size, storage_path, uploaded_by, uploaded_at, checksum, ai_processed',
      )
      .single();

    if (fileError || !fileRow) {
      throw new DatabaseError(fileError?.message ?? 'Failed to record uploaded file');
    }

    await supabase.from('study_documents').insert({
      company_id: ctx.company.id,
      study_id: studyId,
      file_id: (fileRow as FileRecord).id,
      document_type: 'protocol',
      uploaded_by: ctx.user.id,
    });

    const isAmendment = study.status === 'active';

    let extractionId: string | null = null;
    try {
      const { data: fnData, error: fnError } = await supabase.functions.invoke('protocol-ai', {
        body: { file_id: (fileRow as FileRecord).id, study_id: studyId },
      });
      if (fnError) {
        logger.error('protocol-ai invocation failed', { error: fnError.message, studyId });
      } else {
        extractionId = (fnData as { extraction_id?: string } | null)?.extraction_id ?? null;
      }
    } catch (err) {
      logger.error('protocol-ai invocation threw', {
        error: err instanceof Error ? err.message : String(err),
        studyId,
      });
    }

    if (isAmendment) {
      await supabase
        .from('studies')
        .update({ protocol_version: `${study.protocol_version ?? '1.0'}-amended-${Date.now()}` })
        .eq('id', studyId)
        .eq('company_id', ctx.company.id);

      await this.notifyAssignedSites(
        studyId,
        ctx.company.id,
        'protocol_amendment',
        ['regulatory', 'crc'],
        {
          study_name: study.study_name,
        },
      );
    }

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: isAmendment ? 'study.protocol_amended' : 'study.protocol_uploaded',
      module: 'studies',
      record_type: 'studies',
      record_id: studyId,
      new_value: { file_name: file.name, extraction_id: extractionId },
    });

    return { file: fileRow as FileRecord, extraction_id: extractionId };
  },

  async approveAIExtraction(
    extractionId: string,
    ctx: RequestContext,
    expectedStudyId?: string,
  ): Promise<StudyAiExtraction> {
    await PermissionService.requireAnyPermission(ctx.user.id, ['edit_study', 'manage_studies']);

    const supabase = await createServerSupabaseClient();
    const { data: extraction, error } = await supabase
      .from('study_ai_extractions')
      .select(
        'id, company_id, study_id, extraction_type, confidence, extracted_data, reviewed_by, reviewed_at, approved, created_at',
      )
      .eq('id', extractionId)
      .eq('company_id', ctx.company.id)
      .single();

    if (error || !extraction) throw new NotFoundError('AI extraction');
    if (expectedStudyId && (extraction as StudyAiExtraction).study_id !== expectedStudyId) {
      throw new NotFoundError('AI extraction');
    }

    const row = extraction as StudyAiExtraction;
    const extracted = row.extracted_data ?? {};

    if (row.extraction_type === 'study_profile') {
      const fields = [
        'study_name',
        'protocol_number',
        'protocol_version',
        'sponsor',
        'cro',
        'phase',
        'therapeutic_area',
        'indication',
        'estimated_enrollment',
        'study_duration',
        'study_design',
        'primary_endpoint',
        'start_date',
        'end_date',
      ] as const;
      const update: Record<string, unknown> = {};
      for (const field of fields) {
        if (extracted[field] !== undefined) update[field] = extracted[field];
      }
      if (Object.keys(update).length > 0) {
        await supabase
          .from('studies')
          .update(update)
          .eq('id', row.study_id)
          .eq('company_id', ctx.company.id);
      }
    }

    if (row.extraction_type === 'visit_template') {
      const items = Array.isArray(extracted.items) ? extracted.items : [];
      if (items.length > 0) {
        const resolvedItems = resolveAiVisitTemplateBaseline(items);
        await VisitTemplateService.createTemplate(row.study_id, resolvedItems, ctx, 'ai_generated');
      }
    }

    const { data: updated, error: updateError } = await supabase
      .from('study_ai_extractions')
      .update({ approved: true, reviewed_by: ctx.user.id, reviewed_at: new Date().toISOString() })
      .eq('id', extractionId)
      .select(
        'id, company_id, study_id, extraction_type, confidence, extracted_data, reviewed_by, reviewed_at, approved, created_at',
      )
      .single();

    if (updateError || !updated) {
      throw new DatabaseError(updateError?.message ?? 'Failed to approve extraction');
    }

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'study.ai_extraction_approved',
      module: 'studies',
      record_type: 'study_ai_extractions',
      record_id: extractionId,
      new_value: { extraction_type: row.extraction_type, study_id: row.study_id },
    });

    return updated as StudyAiExtraction;
  },

  async listAiExtractions(studyId: string, ctx: RequestContext): Promise<StudyAiExtraction[]> {
    await PermissionService.requirePermission(ctx.user.id, 'view_studies');
    await this.getById(studyId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data } = await supabase
      .from('study_ai_extractions')
      .select(
        'id, company_id, study_id, extraction_type, confidence, extracted_data, reviewed_by, reviewed_at, approved, created_at',
      )
      .eq('study_id', studyId)
      .eq('company_id', ctx.company.id)
      .order('created_at', { ascending: false });

    return (data as StudyAiExtraction[]) ?? [];
  },

  async assignSites(studyId: string, siteIds: string[], ctx: RequestContext): Promise<StudySite[]> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_studies');
    await this.getById(studyId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('study_sites')
      .upsert(
        siteIds.map((siteId) => ({
          company_id: ctx.company.id,
          study_id: studyId,
          site_id: siteId,
          status: 'active',
        })),
        { onConflict: 'study_id,site_id', ignoreDuplicates: true },
      )
      .select('id, company_id, study_id, site_id, status, created_at');

    if (error) throw new DatabaseError(error.message);

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'study.sites_assigned',
      module: 'studies',
      record_type: 'studies',
      record_id: studyId,
      new_value: { site_ids: siteIds },
    });

    return (data as StudySite[]) ?? [];
  },

  async listAssignedSites(studyId: string, ctx: RequestContext): Promise<StudyAssignedSite[]> {
    await PermissionService.requirePermission(ctx.user.id, 'view_studies');
    await this.getById(studyId, ctx);

    const supabase = await createServerSupabaseClient();
    const { data } = await supabase
      .from('study_sites')
      .select('id, status, site_id, sites!inner(name, site_code)')
      .eq('study_id', studyId)
      .eq('company_id', ctx.company.id);

    type Row = {
      id: string;
      status: StudyAssignedSite['status'];
      site_id: string;
      sites: { name: string; site_code: string | null };
    };

    return ((data as Row[] | null) ?? []).map((row) => ({
      id: row.id,
      site_id: row.site_id,
      name: row.sites.name,
      site_code: row.sites.site_code,
      status: row.status,
    }));
  },

  // Company-wide list of active CRC study staff, for filter dropdowns (e.g. Subject
  // List "Assigned CRC"). study_staff has no read path anywhere else yet.
  async listCrcOptions(ctx: RequestContext): Promise<CrcOption[]> {
    await PermissionService.requirePermission(ctx.user.id, 'view_studies');

    const supabase = await createServerSupabaseClient();
    const { data } = await supabase
      .from('study_staff')
      .select('user_id, profiles!inner(full_name)')
      .eq('company_id', ctx.company.id)
      .eq('staff_role', 'crc')
      .eq('active', true);

    type Row = { user_id: string; profiles: { full_name: string } };
    const seen = new Map<string, CrcOption>();
    for (const row of (data as Row[] | null) ?? []) {
      if (!seen.has(row.user_id)) {
        seen.set(row.user_id, { user_id: row.user_id, full_name: row.profiles.full_name });
      }
    }
    return [...seen.values()].sort((a, b) => a.full_name.localeCompare(b.full_name));
  },

  async unassignSite(studyId: string, siteId: string, ctx: RequestContext): Promise<void> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_studies');
    await this.getById(studyId, ctx);

    const supabase = await createServerSupabaseClient();
    const { error } = await supabase
      .from('study_sites')
      .delete()
      .eq('study_id', studyId)
      .eq('site_id', siteId)
      .eq('company_id', ctx.company.id);

    if (error) throw new DatabaseError(error.message);

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'study.site_unassigned',
      module: 'studies',
      record_type: 'studies',
      record_id: studyId,
      new_value: { site_id: siteId },
    });
  },

  async activateStudy(studyId: string, ctx: RequestContext): Promise<Study> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_studies');

    const study = await this.getById(studyId, ctx);
    if (study.status === 'active') return study;
    if (study.status === 'closed' || study.status === 'archived') {
      throw new BusinessRuleError(`Cannot activate a study with status "${study.status}"`);
    }

    const hasApprovedTemplate = await VisitTemplateService.hasApprovedTemplate(
      studyId,
      ctx.company.id,
    );
    if (!hasApprovedTemplate) {
      throw new BusinessRuleError(
        'Study cannot be activated until it has an approved visit template',
      );
    }

    const supabase = await createServerSupabaseClient();
    const { data: updated, error } = await supabase
      .from('studies')
      .update({ status: 'active' })
      .eq('id', studyId)
      .eq('company_id', ctx.company.id)
      .select(STUDY_COLUMNS)
      .single();

    if (error || !updated) throw new DatabaseError(error?.message ?? 'Failed to activate study');

    // GAP-BL-05: auto-populate study_document_requirements from document_types.required_by_default.
    // Implemented as a plain synchronous step here — revisit via the Business Rule Engine (Sprint 9).
    // Existence-checked rather than upserted on a column-list conflict target:
    // migration 016 (Sprint 6) replaced this table's plain (study_id,
    // document_type_id) unique constraint with a COALESCE-based expression
    // index (site_id is now part of the scope), which a plain onConflict
    // column list can no longer resolve.
    const { data: requiredTypes } = await supabase
      .from('document_types')
      .select('id')
      .eq('company_id', ctx.company.id)
      .eq('required_by_default', true);

    if (requiredTypes && requiredTypes.length > 0) {
      const { data: existingReqs } = await supabase
        .from('study_document_requirements')
        .select('document_type_id')
        .eq('study_id', studyId)
        .is('site_id', null);

      const existingTypeIds = new Set(
        ((existingReqs as Array<{ document_type_id: string }>) ?? []).map(
          (r) => r.document_type_id,
        ),
      );
      const toInsert = (requiredTypes as Array<{ id: string }>).filter(
        (t) => !existingTypeIds.has(t.id),
      );

      if (toInsert.length > 0) {
        await supabase.from('study_document_requirements').insert(
          toInsert.map((t) => ({
            company_id: ctx.company.id,
            study_id: studyId,
            document_type_id: t.id,
            required: true,
          })),
        );
      }
    }

    await this.notifyAssignedSites(studyId, ctx.company.id, 'study_activated', ['pi', 'crc'], {
      study_name: study.study_name,
    });

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'study.activated',
      module: 'studies',
      record_type: 'studies',
      record_id: studyId,
    });

    return updated as Study;
  },

  // Single source of truth for "can this study be activated, and if not,
  // why" — read by the frontend's ActivationReadiness panel instead of the
  // frontend re-deriving any of this itself. `blocking: true` items reuse
  // the exact same checks activateStudy() itself enforces (an approved
  // visit template, and the caller holding manage_studies) — every other
  // item is real, computed data, but non-blocking, since none of the other
  // conditions are currently enforced rules in activateStudy() and this
  // endpoint must not silently invent new ones.
  async getActivationReadiness(studyId: string, ctx: RequestContext): Promise<ActivationReadiness> {
    const study = await this.getById(studyId, ctx);
    const supabase = await createServerSupabaseClient();

    const canManage = await PermissionService.hasPermission(ctx.user.id, 'manage_studies');

    // Reuses VisitTemplateService's own check — not reimplemented — so this
    // endpoint can never drift from what activateStudy() actually enforces.
    const hasApprovedTemplate = await VisitTemplateService.hasApprovedTemplate(
      studyId,
      ctx.company.id,
    );

    const { data: templateRows } = await supabase
      .from('visit_templates')
      .select('id')
      .eq('study_id', studyId)
      .eq('company_id', ctx.company.id)
      .limit(1);
    const hasAnyTemplate = (templateRows?.length ?? 0) > 0;

    const { data: siteRows } = await supabase
      .from('study_sites')
      .select('id')
      .eq('study_id', studyId)
      .eq('company_id', ctx.company.id)
      .limit(1);
    const hasSite = (siteRows?.length ?? 0) > 0;

    const { data: protocolDocRows } = await supabase
      .from('study_documents')
      .select('id')
      .eq('study_id', studyId)
      .eq('company_id', ctx.company.id)
      .eq('document_type', 'protocol')
      .limit(1);
    const hasProtocolDoc = (protocolDocRows?.length ?? 0) > 0;

    // A study whose row already exists only ever got here either by manual
    // creation or by AIDraftService.finalizeDraft() — the latter is what
    // performs "AI extraction" and "AI review" in the first place, so both
    // are trivially satisfied for any already-existing AI-generated study.
    // The one way review can still be genuinely incomplete on an existing
    // study is a pending (unreviewed) amendment extraction.
    const { data: pendingExtractionRows } = await supabase
      .from('study_ai_extractions')
      .select('id')
      .eq('study_id', studyId)
      .eq('company_id', ctx.company.id)
      .eq('approved', false)
      .limit(1);
    const hasPendingExtraction = (pendingExtractionRows?.length ?? 0) > 0;

    const { data: requirementRows } = await supabase
      .from('study_document_requirements')
      .select('id')
      .eq('company_id', ctx.company.id)
      .or(`study_id.eq.${studyId},and(study_id.is.null,site_id.is.null)`)
      .limit(1);
    const hasRegulatoryRequirements = (requirementRows?.length ?? 0) > 0;

    const items: ActivationReadinessItem[] = [];

    if (study.ai_generated) {
      items.push({
        key: 'ai_extraction_completed',
        label: 'AI extraction completed',
        met: true,
        blocking: false,
        reason: null,
        fixAction: null,
      });
      items.push({
        key: 'ai_review_completed',
        label: 'AI Review completed',
        met: !hasPendingExtraction,
        blocking: false,
        reason: hasPendingExtraction
          ? 'A protocol amendment extraction is still pending human review.'
          : null,
        fixAction: hasPendingExtraction ? { label: 'Open AI Review', href: null } : null,
      });
    }

    items.push(
      {
        key: 'protocol_uploaded',
        label: 'Protocol uploaded',
        met: hasProtocolDoc,
        blocking: false,
        reason: hasProtocolDoc ? null : 'No protocol document has been uploaded for this study.',
        fixAction: hasProtocolDoc ? null : { label: 'Upload Protocol', href: null },
      },
      {
        key: 'required_fields_completed',
        label: 'Required study fields completed',
        met: Boolean(study.study_name) && Boolean(study.phase),
        blocking: false,
        reason:
          Boolean(study.study_name) && Boolean(study.phase)
            ? null
            : 'Study name and phase should be set before activation.',
        fixAction:
          Boolean(study.study_name) && Boolean(study.phase)
            ? null
            : { label: 'Edit Study', href: null },
      },
      {
        key: 'sponsor_assigned',
        label: 'Sponsor assigned',
        met: Boolean(study.sponsor),
        blocking: false,
        reason: study.sponsor ? null : 'No sponsor is set for this study.',
        fixAction: study.sponsor ? null : { label: 'Edit Study', href: null },
      },
      {
        key: 'protocol_number_assigned',
        label: 'Protocol number assigned',
        met: Boolean(study.protocol_number),
        blocking: false,
        reason: study.protocol_number ? null : 'No protocol number is set for this study.',
        fixAction: study.protocol_number ? null : { label: 'Edit Study', href: null },
      },
      {
        key: 'visit_templates_generated',
        label: 'Visit Templates generated',
        met: hasAnyTemplate,
        blocking: false,
        reason: hasAnyTemplate ? null : 'No visit template has been created for this study yet.',
        fixAction: hasAnyTemplate
          ? null
          : { label: 'Build Visit Template', href: `/studies/${studyId}/visit-templates` },
      },
      {
        key: 'visit_templates_approved',
        label: 'Visit Templates approved',
        met: hasApprovedTemplate,
        blocking: true,
        reason: hasApprovedTemplate
          ? null
          : 'The visit schedule has not been approved yet — this is required before activation.',
        fixAction: hasApprovedTemplate
          ? null
          : { label: 'Review Visit Templates', href: `/studies/${studyId}/visit-templates` },
      },
      {
        key: 'site_assigned',
        label: 'At least one Site assigned',
        met: hasSite,
        blocking: false,
        reason: hasSite ? null : 'No site is assigned to this study.',
        fixAction: hasSite ? null : { label: 'Assign Site', href: null },
      },
      {
        key: 'regulatory_requirements_configured',
        label: 'Regulatory requirements configured',
        met: hasRegulatoryRequirements,
        blocking: false,
        reason: hasRegulatoryRequirements
          ? null
          : 'No regulatory document requirements are configured for this study.',
        fixAction: hasRegulatoryRequirements
          ? null
          : { label: 'Configure Requirements', href: `/studies/${studyId}/regulatory` },
      },
      {
        key: 'user_has_permission',
        label: 'User has permission to activate',
        met: canManage,
        blocking: true,
        reason: canManage ? null : 'You do not have permission to activate studies.',
        fixAction: null,
      },
    );

    const blockingItems = items.filter((i) => !i.met && i.blocking);
    const warnings = items.filter((i) => !i.met && !i.blocking);

    return {
      canActivate: blockingItems.length === 0,
      blockingItems,
      warnings,
      items,
    };
  },

  async closeStudy(studyId: string, ctx: RequestContext): Promise<Study> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_studies');

    const study = await this.getById(studyId, ctx);
    if (study.status === 'closed') return study;

    const supabase = await createServerSupabaseClient();
    const { data: updated, error } = await supabase
      .from('studies')
      .update({ status: 'closed' })
      .eq('id', studyId)
      .eq('company_id', ctx.company.id)
      .select(STUDY_COLUMNS)
      .single();

    if (error || !updated) throw new DatabaseError(error?.message ?? 'Failed to close study');

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'study.closed',
      module: 'studies',
      record_type: 'studies',
      record_id: studyId,
    });

    return updated as Study;
  },

  async archiveStudy(studyId: string, ctx: RequestContext, reason?: string): Promise<Study> {
    await PermissionService.requirePermission(ctx.user.id, 'manage_studies');

    const study = await this.getById(studyId, ctx);
    if (study.status === 'archived') return study;

    const supabase = await createServerSupabaseClient();

    const { count: enrolledSubjectCount } = await supabase
      .from('subjects')
      .select('id', { count: 'exact', head: true })
      .eq('study_id', studyId)
      .eq('company_id', ctx.company.id);

    const subjectCount = enrolledSubjectCount ?? 0;

    await PermissionService.guardDangerousOperation(ctx.user.id, 'force_archive_study', {
      blocked: subjectCount > 0,
      reason,
      blockedMessage: `Cannot archive a study with ${subjectCount} enrolled subject(s). Requires the Force Archive Study permission.`,
    });

    const { data: updated, error } = await supabase
      .from('studies')
      .update({ status: 'archived' })
      .eq('id', studyId)
      .eq('company_id', ctx.company.id)
      .select(STUDY_COLUMNS)
      .single();

    if (error || !updated) throw new DatabaseError(error?.message ?? 'Failed to archive study');

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'study.archived',
      module: 'studies',
      record_type: 'studies',
      record_id: studyId,
      old_value: { status: study.status },
      new_value: {
        status: 'archived',
        enrolled_subject_count: subjectCount,
        forced: subjectCount > 0,
        reason: reason?.trim() || null,
      },
    });

    return updated as Study;
  },

  async update(
    studyId: string,
    input: UpdateStudyServiceInput,
    ctx: RequestContext,
  ): Promise<Study> {
    const { status, site_ids, ...fields } = input;
    let study = await this.getById(studyId, ctx);

    if (Object.keys(fields).length > 0) {
      await PermissionService.requireAnyPermission(ctx.user.id, ['edit_study', 'manage_studies']);

      const supabase = await createServerSupabaseClient();
      const { data: updated, error } = await supabase
        .from('studies')
        .update(fields)
        .eq('id', studyId)
        .eq('company_id', ctx.company.id)
        .select(STUDY_COLUMNS)
        .single();

      if (error || !updated) throw new DatabaseError(error?.message ?? 'Failed to update study');

      await AuditService.log({
        company_id: ctx.company.id,
        user_id: ctx.user.id,
        action: 'study.updated',
        module: 'studies',
        record_type: 'studies',
        record_id: studyId,
        old_value: study as unknown as Record<string, unknown>,
        new_value: fields as Record<string, unknown>,
      });

      study = updated as Study;
    }

    if (site_ids && site_ids.length > 0) {
      await this.assignSites(studyId, site_ids, ctx);
    }

    if (status && status !== study.status) {
      if (status === 'active') {
        study = await this.activateStudy(studyId, ctx);
      } else if (status === 'closed') {
        study = await this.closeStudy(studyId, ctx);
      } else if (status === 'archived') {
        study = await this.archiveStudy(studyId, ctx);
      } else {
        await PermissionService.requirePermission(ctx.user.id, 'manage_studies');
        const supabase = await createServerSupabaseClient();
        const { data: updated, error } = await supabase
          .from('studies')
          .update({ status })
          .eq('id', studyId)
          .eq('company_id', ctx.company.id)
          .select(STUDY_COLUMNS)
          .single();

        if (error || !updated) {
          throw new DatabaseError(error?.message ?? 'Failed to update study status');
        }

        await AuditService.log({
          company_id: ctx.company.id,
          user_id: ctx.user.id,
          action: 'study.status_changed',
          module: 'studies',
          record_type: 'studies',
          record_id: studyId,
          old_value: { status: study.status },
          new_value: { status },
        });

        study = updated as Study;
      }
    }

    return study;
  },

  async notifyAssignedSites(
    studyId: string,
    companyId: string,
    type: 'study_activated' | 'protocol_amendment',
    roleKeys: string[],
    context: Record<string, string>,
  ): Promise<void> {
    const admin = createAdminSupabaseClient();
    const { data: studySites } = await admin
      .from('study_sites')
      .select('site_id')
      .eq('study_id', studyId)
      .eq('company_id', companyId);

    const siteIds = ((studySites as Array<{ site_id: string }>) ?? []).map((s) => s.site_id);

    for (const siteId of siteIds) {
      for (const roleKey of roleKeys) {
        await NotificationService.dispatch({
          type,
          companyId,
          siteId,
          recipientRole: roleKey,
          relatedModule: 'studies',
          relatedRecordId: studyId,
          relatedRecordType: 'studies',
          context,
        });
      }
    }
  },
};
