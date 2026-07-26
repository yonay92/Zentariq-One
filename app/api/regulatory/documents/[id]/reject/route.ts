import { type NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { successResponse, errorResponse } from '@/lib/api/response';
import { rejectDocumentSchema } from '@/lib/utils/validation';
import { RegulatoryDocumentService } from '@/services/regulatory/RegulatoryDocumentService';
import { PermissionDeniedError, NotFoundError, BusinessRuleError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) return errorResponse('UNAUTHORIZED', 401);

  const { id } = await params;

  const body = await request.json().catch(() => null);
  if (!body) return errorResponse('VALIDATION_ERROR', 400, { message: 'Invalid JSON body' });

  const validated = rejectDocumentSchema.safeParse(body);
  if (!validated.success) {
    return errorResponse('VALIDATION_ERROR', 400, { issues: validated.error.issues });
  }

  try {
    const document = await RegulatoryDocumentService.reject(id, validated.data, {
      user: auth.user,
      company: auth.company,
    });
    return successResponse(document, 'Document rejected');
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    if (error instanceof NotFoundError) return errorResponse('NOT_FOUND', 404);
    if (error instanceof BusinessRuleError) {
      return errorResponse('BUSINESS_RULE_FAILED', 422, { message: error.message });
    }
    logger.error('POST /api/regulatory/documents/[id]/reject failed', {
      id,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}
