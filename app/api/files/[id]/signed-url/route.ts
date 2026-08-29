import { type NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { successResponse, errorResponse } from '@/lib/api/response';
import { FileService } from '@/services/files/FileService';
import { PermissionDeniedError, NotFoundError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';

const SIGNED_URL_EXPIRY_SECONDS = 3600; // 1 hour — matches SECURITY.md's signed-URL policy

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) return errorResponse('UNAUTHORIZED', 401);

  const { id } = await params;

  try {
    const url = await FileService.getSignedUrl(
      id,
      { user: auth.user, company: auth.company },
      SIGNED_URL_EXPIRY_SECONDS,
    );
    return successResponse({ url, expires_in: SIGNED_URL_EXPIRY_SECONDS });
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    if (error instanceof NotFoundError) return errorResponse('NOT_FOUND', 404);
    logger.error('GET /api/files/[id]/signed-url failed', {
      id,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}
