import { type NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { successResponse, errorResponse } from '@/lib/api/response';
import { TaskService } from '@/services/tasks/TaskService';
import { PermissionDeniedError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';

// Self-scoped by construction inside TaskService.getMyToday — accepts no
// user/company/filter input from the request.
export async function GET(request: NextRequest) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) return errorResponse('UNAUTHORIZED', 401);

  try {
    const tasks = await TaskService.getMyToday({ user: auth.user, company: auth.company });
    return successResponse(tasks);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    logger.error('GET /api/tasks/my-today failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}
