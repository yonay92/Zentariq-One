import { type NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { successResponse, errorResponse } from '@/lib/api/response';
import { FileService } from '@/services/files/FileService';
import { PermissionDeniedError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';

export async function GET(request: NextRequest) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) return errorResponse('UNAUTHORIZED', 401);

  const { searchParams } = request.nextUrl;
  const filters = {
    module: searchParams.get('module') ?? undefined,
    uploaded_by: searchParams.get('uploaded_by') ?? undefined,
    uploaded_after: searchParams.get('uploaded_after') ?? undefined,
    uploaded_before: searchParams.get('uploaded_before') ?? undefined,
  };

  try {
    const files = await FileService.list(filters, { user: auth.user, company: auth.company });
    return successResponse(files);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    logger.error('GET /api/files failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}
