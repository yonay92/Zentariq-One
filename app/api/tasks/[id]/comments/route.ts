import { type NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { successResponse, errorResponse } from '@/lib/api/response';
import { taskIdSchema, addTaskCommentSchema } from '@/lib/utils/validation';
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
    const comments = await TaskService.getComments(id, {
      user: auth.user,
      company: auth.company,
    });
    return successResponse(comments);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    if (error instanceof NotFoundError) return errorResponse('NOT_FOUND', 404);
    logger.error('GET /api/tasks/[id]/comments failed', {
      id,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}

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

  const validated = addTaskCommentSchema.safeParse(body);
  if (!validated.success) {
    return errorResponse('VALIDATION_ERROR', 400, { issues: validated.error.issues });
  }

  try {
    const comment = await TaskService.addComment(id, validated.data, {
      user: auth.user,
      company: auth.company,
    });
    return successResponse(comment, 'Comment added', 201);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    if (error instanceof NotFoundError) return errorResponse('NOT_FOUND', 404);
    logger.error('POST /api/tasks/[id]/comments failed', {
      id,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}
