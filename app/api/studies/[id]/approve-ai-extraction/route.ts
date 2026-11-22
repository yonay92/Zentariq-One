import { type NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { successResponse, errorResponse } from '@/lib/api/response';
import { approveAiExtractionSchema } from '@/lib/utils/validation';
import { StudyService } from '@/services/studies/StudyService';
import {
  PermissionDeniedError,
  NotFoundError,
  BusinessRuleError,
  ConflictError,
} from '@/lib/api/errors';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) return errorResponse('UNAUTHORIZED', 401);

  const { id } = await params;

  const body = await request.json().catch(() => null);
  if (!body) return errorResponse('VALIDATION_ERROR', 400, { message: 'Invalid JSON body' });

  const validated = approveAiExtractionSchema.safeParse(body);
  if (!validated.success) {
    return errorResponse('VALIDATION_ERROR', 400, { issues: validated.error.issues });
  }

  try {
    const extraction = await StudyService.approveAIExtraction(
      validated.data.extraction_id,
      { user: auth.user, company: auth.company },
      id,
    );
    return successResponse(extraction, 'AI extraction approved');
  } catch (error) {
    if (error instanceof ConflictError) {
      return errorResponse('CONFLICT', 409, { message: error.message });
    }
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    if (error instanceof NotFoundError) return errorResponse('NOT_FOUND', 404);
    if (error instanceof BusinessRuleError) {
      return errorResponse('BUSINESS_RULE_FAILED', 422, { message: error.message });
    }
    logger.error('POST /api/studies/[id]/approve-ai-extraction failed', {
      id,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}
