import { type NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { successResponse, errorResponse } from '@/lib/api/response';
import { updateLeadTaskSchema } from '@/lib/utils/validation';
import { LeadService } from '@/services/recruitment/LeadService';
import { PermissionDeniedError, NotFoundError, BusinessRuleError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';

// A single PATCH endpoint covers both "update fields" and "complete" —
// completing goes through LeadService.completeTask (which stamps
// completed_at/completed_by and guards against double-completion) rather
// than a generic status write, whenever the caller sets status: 'completed'.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) return errorResponse('UNAUTHORIZED', 401);

  const { id, taskId } = await params;

  const body = await request.json().catch(() => null);
  if (!body) return errorResponse('VALIDATION_ERROR', 400, { message: 'Invalid JSON body' });

  const validated = updateLeadTaskSchema.safeParse(body);
  if (!validated.success) {
    return errorResponse('VALIDATION_ERROR', 400, { issues: validated.error.issues });
  }

  const input = Object.fromEntries(
    Object.entries(validated.data).filter(([, v]) => v !== undefined),
  ) as Parameters<typeof LeadService.updateTask>[2];

  try {
    const ctx = { user: auth.user, company: auth.company };
    const task =
      validated.data.status === 'completed'
        ? await LeadService.completeTask(id, taskId, ctx)
        : await LeadService.updateTask(id, taskId, input, ctx);
    return successResponse(task, 'Task updated');
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    if (error instanceof NotFoundError) return errorResponse('NOT_FOUND', 404);
    if (error instanceof BusinessRuleError) {
      return errorResponse('BUSINESS_RULE_FAILED', 422, { message: error.message });
    }
    logger.error('PATCH /api/leads/[id]/tasks/[taskId] failed', {
      id,
      taskId,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}
