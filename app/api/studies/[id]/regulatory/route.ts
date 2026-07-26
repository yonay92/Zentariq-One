import { type NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { successResponse, errorResponse } from '@/lib/api/response';
import { RegulatoryDocumentService } from '@/services/regulatory/RegulatoryDocumentService';
import { RegulatoryHealthService } from '@/services/regulatory/RegulatoryHealthService';
import { PermissionDeniedError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';

// Study eReg Binder convenience route — bundles the document list and health
// score for a study into one response. The two reads are independent, so
// they run in parallel (Promise.all) rather than sequentially.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) return errorResponse('UNAUTHORIZED', 401);

  const { id } = await params;
  const ctx = { user: auth.user, company: auth.company };

  try {
    const [documents, health] = await Promise.all([
      RegulatoryDocumentService.list({ study_id: id }, ctx),
      RegulatoryHealthService.compute('study', id, ctx),
    ]);
    return successResponse({ documents, health });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    logger.error('GET /api/studies/[id]/regulatory failed', {
      id,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}
