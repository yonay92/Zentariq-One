import { type NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { successResponse, errorResponse } from '@/lib/api/response';
import { followUpQueueSchema } from '@/lib/utils/validation';
import { LeadService } from '@/services/recruitment/LeadService';
import { PermissionDeniedError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';

export async function GET(request: NextRequest) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) return errorResponse('UNAUTHORIZED', 401);

  const { searchParams } = request.nextUrl;
  const validated = followUpQueueSchema.safeParse({
    scope: searchParams.get('scope') ?? undefined,
    assigned_user_id: searchParams.get('assigned_user_id') ?? undefined,
    site_id: searchParams.get('site_id') ?? undefined,
    study_id: searchParams.get('study_id') ?? undefined,
    page: searchParams.get('page') ?? undefined,
    page_size: searchParams.get('page_size') ?? undefined,
  });
  if (!validated.success) {
    return errorResponse('VALIDATION_ERROR', 400, { issues: validated.error.issues });
  }

  try {
    const result = await LeadService.getFollowUpQueue(validated.data, {
      user: auth.user,
      company: auth.company,
    });
    return successResponse(result);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    logger.error('GET /api/leads/follow-ups failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}
