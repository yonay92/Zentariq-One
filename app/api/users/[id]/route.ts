import { type NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { successResponse, errorResponse } from '@/lib/api/response';
import { updateUserSchema } from '@/lib/utils/validation';
import { UserService } from '@/services/users/UserService';
import {
  PermissionDeniedError,
  NotFoundError,
  ConflictError,
  SignInSyncError,
} from '@/lib/api/errors';
import { logger } from '@/lib/logger';

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) return errorResponse('UNAUTHORIZED', 401);

  const { id } = await params;

  const body = await request.json().catch(() => null);
  if (!body) return errorResponse('VALIDATION_ERROR', 400, { message: 'Invalid JSON body' });

  const validated = updateUserSchema.safeParse(body);
  if (!validated.success) {
    return errorResponse('VALIDATION_ERROR', 400, { issues: validated.error.issues });
  }

  const input = Object.fromEntries(
    Object.entries(validated.data).filter(([, v]) => v !== undefined),
  ) as Parameters<typeof UserService.update>[1];

  try {
    const user = await UserService.update(id, input, {
      user: auth.user,
      company: auth.company,
    });
    return successResponse(user, 'User updated');
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    if (error instanceof NotFoundError) return errorResponse('NOT_FOUND', 404);
    if (error instanceof SignInSyncError) {
      return errorResponse('SIGN_IN_SYNC_FAILED', 502, { message: error.message });
    }
    if (error instanceof ConflictError) {
      return errorResponse('CONFLICT', 409, { message: error.message });
    }
    logger.error('PATCH /api/users/[id] failed', {
      id,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) return errorResponse('UNAUTHORIZED', 401);

  const { id } = await params;

  try {
    await UserService.deactivate(id, { user: auth.user, company: auth.company });
    return successResponse({ id }, 'User deactivated');
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    if (error instanceof NotFoundError) return errorResponse('NOT_FOUND', 404);
    if (error instanceof SignInSyncError) {
      return errorResponse('SIGN_IN_SYNC_FAILED', 502, { message: error.message });
    }
    logger.error('DELETE /api/users/[id] failed', {
      id,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}
