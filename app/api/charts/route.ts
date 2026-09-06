import { type NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { successResponse, errorResponse } from '@/lib/api/response';
import { listChartsSchema } from '@/lib/utils/validation';
import { ChartService } from '@/services/charts/ChartService';
import { PermissionDeniedError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';

// The Chart Queue endpoint (docs/UI_UX_09_Charts.md) — also reused by the
// Subject Profile Charts tab via the subject_id filter, so there is exactly
// one authorized read path for chart lists (Milestone 4.1 Phase A/B P1).
export async function GET(request: NextRequest) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) return errorResponse('UNAUTHORIZED', 401);

  const { searchParams } = request.nextUrl;
  const validated = listChartsSchema.safeParse({
    site_id: searchParams.get('site_id') ?? undefined,
    study_id: searchParams.get('study_id') ?? undefined,
    subject_id: searchParams.get('subject_id') ?? undefined,
    status: searchParams.get('status') ?? undefined,
    priority: searchParams.get('priority') ?? undefined,
    page: searchParams.get('page') ?? undefined,
    page_size: searchParams.get('page_size') ?? undefined,
  });
  if (!validated.success) {
    return errorResponse('VALIDATION_ERROR', 400, { issues: validated.error.issues });
  }

  try {
    const result = await ChartService.listCharts(validated.data, {
      user: auth.user,
      company: auth.company,
    });
    return successResponse(result);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    logger.error('GET /api/charts failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}
