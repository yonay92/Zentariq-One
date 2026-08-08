import { type NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { successResponse, errorResponse } from '@/lib/api/response';
import { pipelineCountsSchema } from '@/lib/utils/validation';
import { LeadService } from '@/services/recruitment/LeadService';
import { PermissionDeniedError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';

export async function GET(request: NextRequest) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) return errorResponse('UNAUTHORIZED', 401);

  const { searchParams } = request.nextUrl;
  const validated = pipelineCountsSchema.safeParse({
    site_id: searchParams.get('site_id') ?? undefined,
    study_id: searchParams.get('study_id') ?? undefined,
    assigned_user_id: searchParams.get('assigned_user_id') ?? undefined,
    priority: searchParams.get('priority') ?? undefined,
  });
  if (!validated.success) {
    return errorResponse('VALIDATION_ERROR', 400, { issues: validated.error.issues });
  }

  try {
    const result = await LeadService.getPipelineCounts(validated.data, {
      user: auth.user,
      company: auth.company,
    });
    return successResponse(result);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    logger.error('GET /api/leads/pipeline-counts failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}
