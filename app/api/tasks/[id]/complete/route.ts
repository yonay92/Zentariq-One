import { type NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { successResponse, errorResponse } from '@/lib/api/response';
import { taskIdSchema } from '@/lib/utils/validation';
import { TaskService } from '@/services/tasks/TaskService';
import { PermissionDeniedError, NotFoundError, BusinessRuleError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';

// No request body: completing a task takes no client input beyond the path
// ID. complete_task / self-assignee authorization lives in TaskService.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) return errorResponse('UNAUTHORIZED', 401);

  const parsedId = taskIdSchema.safeParse((await params).id);
  if (!parsedId.success) {
    return errorResponse('VALIDATION_ERROR', 400, { issues: parsedId.error.issues });
  }
  const id = parsedId.data;

  try {
    const task = await TaskService.completeTask(id, { user: auth.user, company: auth.company });
    return successResponse(task, 'Task completed');
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    if (error instanceof NotFoundError) return errorResponse('NOT_FOUND', 404);
    if (error instanceof BusinessRuleError) {
      return errorResponse('BUSINESS_RULE_FAILED', 422, { message: error.message });
    }
    logger.error('POST /api/tasks/[id]/complete failed', {
      id,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}
