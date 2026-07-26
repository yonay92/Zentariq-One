import { type NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { successResponse, errorResponse } from '@/lib/api/response';
import { updateRegulatoryRequirementSchema } from '@/lib/utils/validation';
import { RegulatoryRequirementService } from '@/services/regulatory/RegulatoryRequirementService';
import { PermissionDeniedError, NotFoundError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) return errorResponse('UNAUTHORIZED', 401);

  const { id } = await params;

  const body = await request.json().catch(() => null);
  if (!body) return errorResponse('VALIDATION_ERROR', 400, { message: 'Invalid JSON body' });

  const validated = updateRegulatoryRequirementSchema.safeParse(body);
  if (!validated.success) {
    return errorResponse('VALIDATION_ERROR', 400, { issues: validated.error.issues });
  }

  try {
    const requirement = await RegulatoryRequirementService.update(id, validated.data, {
      user: auth.user,
      company: auth.company,
    });
    return successResponse(requirement, 'Requirement updated');
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    if (error instanceof NotFoundError) return errorResponse('NOT_FOUND', 404);
    logger.error('PATCH /api/regulatory/requirements/[id] failed', {
      id,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}
