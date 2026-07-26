import { type NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { successResponse, errorResponse } from '@/lib/api/response';
import { createRegulatoryDocumentSchema } from '@/lib/utils/validation';
import { RegulatoryDocumentService } from '@/services/regulatory/RegulatoryDocumentService';
import { PermissionDeniedError, NotFoundError, BusinessRuleError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25MB

export async function GET(request: NextRequest) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) return errorResponse('UNAUTHORIZED', 401);

  const { searchParams } = request.nextUrl;
  const filters = {
    study_id: searchParams.get('study_id') ?? undefined,
    site_id: searchParams.get('site_id') ?? undefined,
  };

  try {
    const documents = await RegulatoryDocumentService.list(filters, {
      user: auth.user,
      company: auth.company,
    });
    return successResponse(documents);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    logger.error('GET /api/regulatory/documents failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}

export async function POST(request: NextRequest) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) return errorResponse('UNAUTHORIZED', 401);

  const formData = await request.formData().catch(() => null);
  const file = formData?.get('file');

  if (!file || !(file instanceof File)) {
    return errorResponse('VALIDATION_ERROR', 400, { message: 'A file is required' });
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return errorResponse('VALIDATION_ERROR', 400, { message: 'File exceeds the 25MB limit' });
  }

  const validated = createRegulatoryDocumentSchema.safeParse({
    document_type_id: formData?.get('document_type_id') || undefined,
    study_id: formData?.get('study_id') || undefined,
    site_id: formData?.get('site_id') || undefined,
    document_name: formData?.get('document_name') || undefined,
    effective_date: formData?.get('effective_date') || undefined,
    expiration_date: formData?.get('expiration_date') || undefined,
  });
  if (!validated.success) {
    return errorResponse('VALIDATION_ERROR', 400, { issues: validated.error.issues });
  }

  try {
    const document = await RegulatoryDocumentService.create(validated.data, file, {
      user: auth.user,
      company: auth.company,
    });
    return successResponse(document, 'Document uploaded — pending review', 201);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    if (error instanceof NotFoundError) return errorResponse('NOT_FOUND', 404);
    if (error instanceof BusinessRuleError) {
      return errorResponse('BUSINESS_RULE_FAILED', 422, { message: error.message });
    }
    logger.error('POST /api/regulatory/documents failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}
