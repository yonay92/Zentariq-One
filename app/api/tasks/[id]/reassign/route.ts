import { type NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { successResponse, errorResponse } from '@/lib/api/response';
import { taskIdSchema, reassignTaskSchema } from '@/lib/utils/validation';
import { TaskService } from '@/services/tasks/TaskService';
import { PermissionDeniedError, NotFoundError, BusinessRuleError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';

// assign_task authorization and target-user company/site validation live in
// TaskService.reassignTask; a rejected target surfaces as 422/404, never 200.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) return errorResponse('UNAUTHORIZED', 401);

  const parsedId = taskIdSchema.safeParse((await params).id);
  if (!parsedId.success) {
    return errorResponse('VALIDATION_ERROR', 400, { issues: parsedId.error.issues });
  }
  const id = parsedId.data;

  const body = await request.json().catch(() => null);
  if (!body) return errorResponse('VALIDATION_ERROR', 400, { message: 'Invalid JSON body' });

  const validated = reassignTaskSchema.safeParse(body);
  if (!validated.success) {
    return errorResponse('VALIDATION_ERROR', 400, { issues: validated.error.issues });
  }

  try {
    const task = await TaskService.reassignTask(id, validated.data, {
      user: auth.user,
      company: auth.company,
    });
    return successResponse(task, 'Task reassigned');
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    if (error instanceof NotFoundError) return errorResponse('NOT_FOUND', 404);
    if (error instanceof BusinessRuleError) {
      return errorResponse('BUSINESS_RULE_FAILED', 422, { message: error.message });
    }
    logger.error('POST /api/tasks/[id]/reassign failed', {
      id,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}
