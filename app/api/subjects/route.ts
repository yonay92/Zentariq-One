import { type NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { successResponse, errorResponse } from '@/lib/api/response';
import { createSubjectSchema } from '@/lib/utils/validation';
import { SubjectService, type SubjectListFilters } from '@/services/subjects/SubjectService';
import {
  PermissionDeniedError,
  NotFoundError,
  BusinessRuleError,
  DuplicateRecordError,
  ConflictError,
} from '@/lib/api/errors';
import { logger } from '@/lib/logger';
import type { SubjectStatus } from '@/types/subjects';

export async function GET(request: NextRequest) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) return errorResponse('UNAUTHORIZED', 401);

  const { searchParams } = new URL(request.url);
  const filters: SubjectListFilters = {
    study_id: searchParams.get('study_id') ?? undefined,
    site_id: searchParams.get('site_id') ?? undefined,
    status: (searchParams.get('status') as SubjectStatus | null) ?? undefined,
    subject_number: searchParams.get('subject_number') ?? undefined,
    search: searchParams.get('search') ?? undefined,
    assigned_crc: searchParams.get('assigned_crc') ?? undefined,
  };

  try {
    const subjects = await SubjectService.list(filters, { user: auth.user, company: auth.company });
    return successResponse(subjects);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    logger.error('GET /api/subjects failed', {
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

  const validated = createSubjectSchema.safeParse(body);
  if (!validated.success) {
    return errorResponse('VALIDATION_ERROR', 400, { issues: validated.error.issues });
  }

  const input = Object.fromEntries(
    Object.entries(validated.data).filter(([, v]) => v !== undefined),
  ) as Parameters<typeof SubjectService.create>[0];

  try {
    const subject = await SubjectService.create(input, {
      user: auth.user,
      company: auth.company,
    });
    return successResponse(subject, 'Subject created', 201);
  } catch (error) {
    if (error instanceof ConflictError) {
      return errorResponse('CONFLICT', 409, { message: error.message });
    }
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    if (error instanceof NotFoundError) return errorResponse('NOT_FOUND', 404);
    if (error instanceof DuplicateRecordError) return errorResponse('DUPLICATE_RECORD', 409);
    if (error instanceof BusinessRuleError) {
      return errorResponse('BUSINESS_RULE_FAILED', 422, { message: error.message });
    }
    logger.error('POST /api/subjects failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}
