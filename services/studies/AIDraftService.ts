import { createServerSupabaseClient } from '@/lib/supabase/server';
import { PermissionService } from '@/services/permissions/PermissionService';
import { AuditService } from '@/services/audit/AuditService';
import { VisitTemplateService } from '@/services/visit-templates/VisitTemplateService';
import { FileService } from '@/services/files/FileService';
import { NotFoundError, DatabaseError, BusinessRuleError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';
import type { StudyDraft, Study } from '@/types/studies';
import type { FinalizeAiDraftSchema } from '@/lib/utils/validation';
import type { RequestContext } from '@/types/api';

const DRAFT_COLUMNS =
  'id, company_id, file_id, status, confidence, uncertain_fields, extracted_profile, extracted_visit_items, extracted_extra, error_message, study_id, created_by, created_at, updated_at';

const STUDY_COLUMNS =
  'id, company_id, study_name, protocol_number, sponsor, cro, phase, therapeutic_area, indication, estimated_enrollment, study_duration, study_design, primary_endpoint, status, start_date, end_date, protocol_version, ai_generated, created_by, created_at, updated_at';

// Best-effort Document Center visibility — never blocks the primary
// finalize write. Same failure semantics as
// StudyService.linkToDocumentCenter (see its comment for the full
// rationale). Deliberately NOT called from createDraft(): study_drafts is
// an intermediate AI/workflow artifact, not part of the canonical Document
// Center, and can be hard-deleted via deleteDraft() with no cascade into
// file_links — linking it would risk a permanently orphaned association.
// The canonical association is created here, exactly once, using the
// study_documents row this same call just inserted — never the
// study_drafts row.
async function linkToDocumentCenter(
  fileId: string,
  studyDocumentId: string,
  ctx: RequestContext,
): Promise<void> {
  try {
    await FileService.linkForModule(
      {
        file_id: fileId,
        module: 'study_documents',
        record_id: studyDocumentId,
        site_id: null,
      },
      ctx,
    );
  } catch (err) {
    logger.error('AIDraftService: linkForModule failed', {
      study_document_id: studyDocumentId,
      file_id: fileId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export const AIDraftService = {
  async createDraft(file: File, ctx: RequestContext): Promise<StudyDraft> {
    await PermissionService.requirePermission(ctx.user.id, 'create_study');

    const supabase = await createServerSupabaseClient();
    const storagePath = `${ctx.company.id}/drafts/${Date.now()}_${file.name}`;

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
      .select('id')
      .single();

    if (fileError || !fileRow) {
      throw new DatabaseError(fileError?.message ?? 'Failed to record uploaded file');
    }

    const fileId = (fileRow as { id: string }).id;

    const { data: draftRow, error: draftError } = await supabase
      .from('study_drafts')
      .insert({
        company_id: ctx.company.id,
        file_id: fileId,
        status: 'processing',
        created_by: ctx.user.id,
      })
      .select(DRAFT_COLUMNS)
      .single();

    if (draftError || !draftRow) {
      throw new DatabaseError(draftError?.message ?? 'Failed to create AI draft');
    }

    const draftId = (draftRow as StudyDraft).id;

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'study.ai_draft_created',
      module: 'studies',
      record_type: 'study_drafts',
      record_id: draftId,
      new_value: { file_name: file.name },
    });

    try {
      const { error: fnError } = await supabase.functions.invoke('protocol-ai', {
        body: { file_id: fileId, draft_id: draftId },
      });
      if (fnError) {
        logger.error('protocol-ai invocation failed', { error: fnError.message, draftId });
        await supabase
          .from('study_drafts')
          .update({ status: 'failed', error_message: fnError.message })
          .eq('id', draftId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('protocol-ai invocation threw', { error: message, draftId });
      await supabase
        .from('study_drafts')
        .update({ status: 'failed', error_message: message })
        .eq('id', draftId);
    }

    return this.getDraft(draftId, ctx);
  },

  async getDraft(draftId: string, ctx: RequestContext): Promise<StudyDraft> {
    await PermissionService.requirePermission(ctx.user.id, 'create_study');

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from('study_drafts')
      .select(DRAFT_COLUMNS)
      .eq('id', draftId)
      .eq('company_id', ctx.company.id)
      .single();

    if (error || !data) throw new NotFoundError('AI draft');
    return data as StudyDraft;
  },

  async finalizeDraft(
    draftId: string,
    input: FinalizeAiDraftSchema,
    ctx: RequestContext,
  ): Promise<Study> {
    await PermissionService.requirePermission(ctx.user.id, 'create_study');

    const draft = await this.getDraft(draftId, ctx);
    if (draft.status === 'finalized') {
      throw new BusinessRuleError('This AI draft has already been finalized');
    }

    const { visit_template_items, ...profileInput } = input;

    if (visit_template_items && visit_template_items.length > 0) {
      const baselineCount = visit_template_items.filter((item) => item.is_baseline).length;
      if (baselineCount !== 1) {
        throw new BusinessRuleError('Mark exactly one visit as Baseline before finalizing');
      }
    }

    const supabase = await createServerSupabaseClient();

    const { data: studyRow, error: studyError } = await supabase
      .from('studies')
      .insert({
        company_id: ctx.company.id,
        created_by: ctx.user.id,
        status: 'draft',
        ai_generated: true,
        ...profileInput,
      })
      .select(STUDY_COLUMNS)
      .single();

    if (studyError || !studyRow) {
      throw new DatabaseError(studyError?.message ?? 'Failed to create study from AI draft');
    }

    const study = studyRow as Study;

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'study.created',
      module: 'studies',
      record_type: 'studies',
      record_id: study.id,
      new_value: { source: 'ai_draft_finalized', draft_id: draftId },
    });

    if (visit_template_items && visit_template_items.length > 0) {
      await VisitTemplateService.createTemplate(
        study.id,
        visit_template_items,
        ctx,
        'ai_generated',
      );
    }

    const { data: studyDocumentRow, error: studyDocumentError } = await supabase
      .from('study_documents')
      .insert({
        company_id: ctx.company.id,
        study_id: study.id,
        file_id: draft.file_id,
        document_type: 'protocol',
        uploaded_by: ctx.user.id,
        ai_processed: true,
      })
      .select('id')
      .single();

    if (studyDocumentError || !studyDocumentRow) {
      throw new DatabaseError(studyDocumentError?.message ?? 'Failed to record protocol document');
    }

    const studyDocumentId = (studyDocumentRow as { id: string }).id;

    await supabase
      .from('study_drafts')
      .update({ status: 'finalized', study_id: study.id })
      .eq('id', draftId)
      .eq('company_id', ctx.company.id);

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'study.ai_draft_finalized',
      module: 'studies',
      record_type: 'studies',
      record_id: study.id,
      new_value: { draft_id: draftId, visit_count: visit_template_items?.length ?? 0 },
    });

    await linkToDocumentCenter(draft.file_id, studyDocumentId, ctx);

    return study;
  },

  async deleteDraft(draftId: string, ctx: RequestContext): Promise<void> {
    await PermissionService.requirePermission(ctx.user.id, 'create_study');

    const draft = await this.getDraft(draftId, ctx);
    if (draft.status === 'finalized') {
      throw new BusinessRuleError('Cannot discard an AI draft that has already been finalized');
    }

    const supabase = await createServerSupabaseClient();
    await supabase.from('study_drafts').delete().eq('id', draftId).eq('company_id', ctx.company.id);

    await AuditService.log({
      company_id: ctx.company.id,
      user_id: ctx.user.id,
      action: 'study.ai_draft_discarded',
      module: 'studies',
      record_type: 'study_drafts',
      record_id: draftId,
    });
  },
};
