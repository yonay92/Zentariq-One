import { type NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { successResponse, errorResponse } from '@/lib/api/response';
import { AIDraftService } from '@/services/studies/AIDraftService';
import { PermissionDeniedError, ConflictError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25MB

// Uploads a protocol PDF and starts AI extraction into a temporary draft — no `studies` row is
// created until the user reviews and finalizes it via POST /api/studies/ai-drafts/:id/finalize.
export async function POST(request: NextRequest) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) return errorResponse('UNAUTHORIZED', 401);

  const formData = await request.formData().catch(() => null);
  const file = formData?.get('file');

  if (!file || !(file instanceof File)) {
    return errorResponse('VALIDATION_ERROR', 400, { message: 'A protocol file is required' });
  }
  if (file.type !== 'application/pdf') {
    return errorResponse('VALIDATION_ERROR', 400, { message: 'Only PDF protocols are supported' });
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return errorResponse('VALIDATION_ERROR', 400, { message: 'File exceeds the 25MB limit' });
  }

  try {
    const draft = await AIDraftService.createDraft(file, {
      user: auth.user,
      company: auth.company,
    });
    return successResponse({ draft }, 'Protocol uploaded — AI extraction in progress', 201);
  } catch (error) {
    if (error instanceof ConflictError) {
      return errorResponse('CONFLICT', 409, { message: error.message });
    }
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    logger.error('POST /api/studies/ai-drafts failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}
