import { type NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { successResponse, errorResponse } from '@/lib/api/response';
import { createRegulatoryRequirementSchema } from '@/lib/utils/validation';
import { RegulatoryRequirementService } from '@/services/regulatory/RegulatoryRequirementService';
import { PermissionDeniedError, BusinessRuleError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';

export async function GET(request: NextRequest) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) return errorResponse('UNAUTHORIZED', 401);

  const { searchParams } = request.nextUrl;
  const filters = {
    study_id: searchParams.get('study_id') ?? undefined,
    site_id: searchParams.get('site_id') ?? undefined,
  };

  try {
    const requirements = await RegulatoryRequirementService.list(filters, {
      user: auth.user,
      company: auth.company,
    });
    return successResponse(requirements);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    logger.error('GET /api/regulatory/requirements failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}

export async function POST(request: NextRequest) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) return errorResponse('UNAUTHORIZED', 401);

  const body = await request.json().catch(() => null);
  if (!body) return errorResponse('VALIDATION_ERROR', 400, { message: 'Invalid JSON body' });

  const validated = createRegulatoryRequirementSchema.safeParse(body);
  if (!validated.success) {
    return errorResponse('VALIDATION_ERROR', 400, { issues: validated.error.issues });
  }

  try {
    const requirement = await RegulatoryRequirementService.create(validated.data, {
      user: auth.user,
      company: auth.company,
    });
    return successResponse(requirement, 'Requirement created', 201);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    if (error instanceof BusinessRuleError) {
      return errorResponse('BUSINESS_RULE_FAILED', 422, { message: error.message });
    }
    logger.error('POST /api/regulatory/requirements failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}
