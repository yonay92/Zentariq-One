import { type NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { successResponse, errorResponse } from '@/lib/api/response';
import { uploadDocumentVersionSchema } from '@/lib/utils/validation';
import { RegulatoryDocumentService } from '@/services/regulatory/RegulatoryDocumentService';
import { PermissionDeniedError, NotFoundError, BusinessRuleError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25MB

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) return errorResponse('UNAUTHORIZED', 401);

  const { id } = await params;

  const formData = await request.formData().catch(() => null);
  const file = formData?.get('file');

  if (!file || !(file instanceof File)) {
    return errorResponse('VALIDATION_ERROR', 400, { message: 'A file is required' });
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return errorResponse('VALIDATION_ERROR', 400, { message: 'File exceeds the 25MB limit' });
  }

  const confirmDuplicateRaw = formData?.get('confirm_duplicate');
  const validated = uploadDocumentVersionSchema.safeParse({
    effective_date: formData?.get('effective_date') || undefined,
    expiration_date: formData?.get('expiration_date') || undefined,
    replacement_reason: formData?.get('replacement_reason') || undefined,
    confirm_duplicate: confirmDuplicateRaw === 'true' ? true : undefined,
  });
  if (!validated.success) {
    return errorResponse('VALIDATION_ERROR', 400, { issues: validated.error.issues });
  }

  try {
    const result = await RegulatoryDocumentService.replace(id, file, validated.data, {
      user: auth.user,
      company: auth.company,
    });

    if ('duplicate_detected' in result) {
      return errorResponse('CONFLICT', 409, {
        message:
          'This file is identical to an existing version. Confirm to upload it as a new version anyway.',
        issues: result,
      });
    }

    return successResponse(result, 'New version uploaded — pending review');
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    if (error instanceof NotFoundError) return errorResponse('NOT_FOUND', 404);
    if (error instanceof BusinessRuleError) {
      return errorResponse('BUSINESS_RULE_FAILED', 422, { message: error.message });
    }
    logger.error('POST /api/regulatory/documents/[id]/replace failed', {
      id,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}
