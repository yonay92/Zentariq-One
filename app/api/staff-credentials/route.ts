import { type NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { successResponse, errorResponse } from '@/lib/api/response';
import { createStaffDocumentSchema } from '@/lib/utils/validation';
import { StaffCredentialService } from '@/services/regulatory/StaffCredentialService';
import { PermissionDeniedError, BusinessRuleError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25MB

export async function GET(request: NextRequest) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) return errorResponse('UNAUTHORIZED', 401);

  const { searchParams } = request.nextUrl;
  const userId = searchParams.get('user_id');
  if (!userId) {
    return errorResponse('VALIDATION_ERROR', 400, { message: 'user_id is required' });
  }

  try {
    const credentials = await StaffCredentialService.listForUser(userId, {
      user: auth.user,
      company: auth.company,
    });
    return successResponse(credentials);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    logger.error('GET /api/staff-credentials failed', {
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

  const validated = createStaffDocumentSchema.safeParse({
    user_id: formData?.get('user_id') || undefined,
    document_type_id: formData?.get('document_type_id') || undefined,
    site_id: formData?.get('site_id') || undefined,
    effective_date: formData?.get('effective_date') || undefined,
    expiration_date: formData?.get('expiration_date') || undefined,
  });
  if (!validated.success) {
    return errorResponse('VALIDATION_ERROR', 400, { issues: validated.error.issues });
  }

  try {
    const credential = await StaffCredentialService.create(validated.data, file, {
      user: auth.user,
      company: auth.company,
    });
    return successResponse(credential, 'Credential uploaded', 201);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    if (error instanceof BusinessRuleError) {
      return errorResponse('BUSINESS_RULE_FAILED', 422, { message: error.message });
    }
    logger.error('POST /api/staff-credentials failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}
