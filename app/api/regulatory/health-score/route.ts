import { type NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { successResponse, errorResponse } from '@/lib/api/response';
import { RegulatoryHealthService } from '@/services/regulatory/RegulatoryHealthService';
import { PermissionDeniedError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';
import type { RegulatoryHealthScope } from '@/types/regulatory';

const VALID_SCOPES: RegulatoryHealthScope[] = ['company', 'site', 'study', 'staff'];

export async function GET(request: NextRequest) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) return errorResponse('UNAUTHORIZED', 401);

  const { searchParams } = request.nextUrl;
  const scope = searchParams.get('scope');
  const id = searchParams.get('id');

  if (!scope || !VALID_SCOPES.includes(scope as RegulatoryHealthScope)) {
    return errorResponse('VALIDATION_ERROR', 400, {
      message: 'scope must be one of: company, site, study, staff',
    });
  }
  if (scope !== 'company' && !id) {
    return errorResponse('VALIDATION_ERROR', 400, { message: 'id is required for this scope' });
  }

  try {
    const health = await RegulatoryHealthService.compute(scope as RegulatoryHealthScope, id, {
      user: auth.user,
      company: auth.company,
    });
    return successResponse(health);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    logger.error('GET /api/regulatory/health-score failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}
