import { type NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { successResponse, errorResponse } from '@/lib/api/response';
import { createStudySchema } from '@/lib/utils/validation';
import { StudyService, type StudyListFilters } from '@/services/studies/StudyService';
import { PermissionDeniedError, ConflictError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';
import type { StudyStatus } from '@/types/studies';

export async function GET(request: NextRequest) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) return errorResponse('UNAUTHORIZED', 401);

  const { searchParams } = new URL(request.url);
  const view = searchParams.get('view');
  const filters: StudyListFilters = {
    status: (searchParams.get('status') as StudyStatus | null) ?? undefined,
    site_id: searchParams.get('site_id') ?? undefined,
    sponsor: searchParams.get('sponsor') ?? undefined,
    therapeutic_area: searchParams.get('therapeutic_area') ?? undefined,
    view: view === 'archived' || view === 'all' || view === 'active' ? view : undefined,
  };

  try {
    const studies = await StudyService.list(filters, { user: auth.user, company: auth.company });
    return successResponse(studies);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    logger.error('GET /api/studies failed', {
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

  const validated = createStudySchema.safeParse(body);
  if (!validated.success) {
    return errorResponse('VALIDATION_ERROR', 400, { issues: validated.error.issues });
  }

  const input = Object.fromEntries(
    Object.entries(validated.data).filter(([, v]) => v !== undefined),
  ) as Parameters<typeof StudyService.create>[0];

  try {
    const study = await StudyService.create(input, { user: auth.user, company: auth.company });
    return successResponse(study, 'Study created', 201);
  } catch (error) {
    if (error instanceof ConflictError) {
      return errorResponse('CONFLICT', 409, { message: error.message });
    }
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    logger.error('POST /api/studies failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}
