import { type NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { successResponse, errorResponse } from '@/lib/api/response';
import { createDocumentTypeSchema } from '@/lib/utils/validation';
import { DocumentTypeService } from '@/services/regulatory/DocumentTypeService';
import { PermissionDeniedError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';

export async function GET(request: NextRequest) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) return errorResponse('UNAUTHORIZED', 401);

  try {
    const documentTypes = await DocumentTypeService.list({
      user: auth.user,
      company: auth.company,
    });
    return successResponse(documentTypes);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    logger.error('GET /api/regulatory/document-types failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}

export async function POST(request: NextRequest) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) return errorResponse('UNAUTHORIZED', 401);

  const body = await request.json().catch(() => null);
  if (!body) return errorResponse('VALIDATION_ERROR', 400, { message: 'Invalid JSON body' });

  const validated = createDocumentTypeSchema.safeParse(body);
  if (!validated.success) {
    return errorResponse('VALIDATION_ERROR', 400, { issues: validated.error.issues });
  }

  try {
    const documentType = await DocumentTypeService.create(validated.data, {
      user: auth.user,
      company: auth.company,
    });
    return successResponse(documentType, 'Document type created', 201);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    logger.error('POST /api/regulatory/document-types failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}
