import { createServerSupabaseClient } from '@/lib/supabase/server';
import { PermissionService } from '@/services/permissions/PermissionService';
import { DatabaseError } from '@/lib/api/errors';
import type {
  RegulatoryHealthScope,
  RegulatoryHealthScore,
  RegulatoryHealthBreakdown,
  RegulatoryDocumentStatus,
} from '@/types/regulatory';
import type { RequestContext } from '@/types/api';

type RequirementRow = {
  document_type_id: string;
  study_id: string | null;
  site_id: string | null;
};

type DocumentStatusRow = {
  document_type_id: string;
  study_id: string | null;
  site_id: string | null;
  status: RegulatoryDocumentStatus;
};

function emptyBreakdown(): RegulatoryHealthBreakdown {
  return { current: 0, expiring_soon: 0, expired: 0, missing: 0, pending_review: 0, rejected: 0 };
}

// Formula per docs/BUSINESS_RULES_06_Regulatory.md: 100% = all required
// documents current. `expiring_soon` still counts as satisfied (it exists
// and hasn't lapsed) but is surfaced separately in the breakdown so a score
// never hides a looming expiration behind a green number. Archived documents
// and non-required document types are excluded entirely. denominator = 0
// yields score = null (never a misleading 100%) per the approved spec.
function scoreFromMatches(
  requirements: RequirementRow[],
  documents: DocumentStatusRow[],
  matches: (req: RequirementRow, doc: DocumentStatusRow) => boolean,
): RegulatoryHealthScore {
  const breakdown = emptyBreakdown();

  for (const req of requirements) {
    const doc = documents.find((d) => matches(req, d));
    if (!doc) {
      breakdown.missing += 1;
      continue;
    }
    switch (doc.status) {
      case 'current':
        breakdown.current += 1;
        break;
      case 'expiring_soon':
        breakdown.expiring_soon += 1;
        break;
      case 'expired':
        breakdown.expired += 1;
        break;
      case 'pending_review':
      case 'draft':
        breakdown.pending_review += 1;
        break;
      case 'rejected':
        breakdown.rejected += 1;
        break;
      case 'missing':
      case 'archived':
        breakdown.missing += 1;
        break;
    }
  }

  const denominator = requirements.length;
  const numerator = breakdown.current + breakdown.expiring_soon;
  const score = denominator > 0 ? Math.round((numerator / denominator) * 100) : null;

  return { scope: 'company', scope_id: null, score, numerator, denominator, breakdown };
}

export const RegulatoryHealthService = {
  async compute(
    scope: RegulatoryHealthScope,
    scopeId: string | null,
    ctx: RequestContext,
  ): Promise<RegulatoryHealthScore> {
    await PermissionService.requirePermission(ctx.user.id, 'view_regulatory');
    const supabase = await createServerSupabaseClient();

    if (scope === 'staff') {
      if (!scopeId) throw new DatabaseError('A staff scope requires a user_id');

      const { data: requiredTypes, error: typesError } = await supabase
        .from('document_types')
        .select('id')
        .eq('company_id', ctx.company.id)
        .eq('required_by_default', true);

      if (typesError) throw new DatabaseError(typesError.message);

      const requirements: RequirementRow[] = ((requiredTypes as Array<{ id: string }>) ?? []).map(
        (t) => ({ document_type_id: t.id, study_id: null, site_id: null }),
      );

      const { data: staffDocs, error: docsError } = await supabase
        .from('staff_documents')
        .select('document_type_id, status')
        .eq('company_id', ctx.company.id)
        .eq('user_id', scopeId)
        .neq('status', 'archived');

      if (docsError) throw new DatabaseError(docsError.message);

      const documents: DocumentStatusRow[] = (
        (staffDocs as Array<{
          document_type_id: string;
          status: RegulatoryDocumentStatus;
        }>) ?? []
      ).map((d) => ({
        document_type_id: d.document_type_id,
        study_id: null,
        site_id: null,
        status: d.status,
      }));

      const result = scoreFromMatches(
        requirements,
        documents,
        (req, doc) => req.document_type_id === doc.document_type_id,
      );
      return { ...result, scope: 'staff', scope_id: scopeId };
    }

    let requirementQuery = supabase
      .from('study_document_requirements')
      .select('document_type_id, study_id, site_id')
      .eq('company_id', ctx.company.id)
      .eq('required', true);

    if (scope === 'study') {
      requirementQuery = requirementQuery.or(
        `study_id.eq.${scopeId},and(study_id.is.null,site_id.is.null)`,
      );
    } else if (scope === 'site') {
      requirementQuery = requirementQuery.or(
        `and(site_id.eq.${scopeId},study_id.is.null),and(study_id.is.null,site_id.is.null)`,
      );
    }
    // scope === 'company': every requirement in the company counts, no filter.

    const { data: requirementData, error: reqError } = await requirementQuery;
    if (reqError) throw new DatabaseError(reqError.message);
    const requirements = (requirementData as RequirementRow[]) ?? [];

    const { data: documentData, error: docError } = await supabase
      .from('regulatory_documents')
      .select('document_type_id, study_id, site_id, status')
      .eq('company_id', ctx.company.id)
      .neq('status', 'archived');

    if (docError) throw new DatabaseError(docError.message);
    const documents = (documentData as DocumentStatusRow[]) ?? [];

    const result = scoreFromMatches(requirements, documents, (req, doc) => {
      if (req.document_type_id !== doc.document_type_id) return false;
      if (req.study_id || req.site_id) {
        // Scoped requirement — must match the same scope exactly.
        return req.study_id === doc.study_id && req.site_id === doc.site_id;
      }
      // Company-wide requirement — cascades to a document scoped to the
      // binder currently being scored (study or site), or a company-wide
      // document when scoring the whole company.
      if (scope === 'study') return doc.study_id === scopeId;
      if (scope === 'site') return doc.site_id === scopeId && !doc.study_id;
      return !doc.study_id && !doc.site_id;
    });

    return { ...result, scope, scope_id: scopeId };
  },
};
