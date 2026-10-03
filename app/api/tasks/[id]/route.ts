import { type NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { successResponse, errorResponse } from '@/lib/api/response';
import { taskIdSchema } from '@/lib/utils/validation';
import { TaskService } from '@/services/tasks/TaskService';
import { PermissionDeniedError, NotFoundError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) return errorResponse('UNAUTHORIZED', 401);

  const parsedId = taskIdSchema.safeParse((await params).id);
  if (!parsedId.success) {
    return errorResponse('VALIDATION_ERROR', 400, { issues: parsedId.error.issues });
  }
  const id = parsedId.data;

  try {
    const task = await TaskService.getTaskById(id, { user: auth.user, company: auth.company });
    return successResponse(task);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    if (error instanceof NotFoundError) return errorResponse('NOT_FOUND', 404);
    logger.error('GET /api/tasks/[id] failed', {
      id,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}
