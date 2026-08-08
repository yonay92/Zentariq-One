import { type NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { successResponse, errorResponse } from '@/lib/api/response';
import { createLeadSchema, listLeadsSchema } from '@/lib/utils/validation';
import { LeadService } from '@/services/recruitment/LeadService';
import { PermissionDeniedError, NotFoundError, BusinessRuleError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';

export async function GET(request: NextRequest) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) return errorResponse('UNAUTHORIZED', 401);

  const { searchParams } = request.nextUrl;
  const statuses = searchParams.getAll('statuses');
  const validated = listLeadsSchema.safeParse({
    status: searchParams.get('status') ?? undefined,
    statuses: statuses.length > 0 ? statuses : undefined,
    site_id: searchParams.get('site_id') ?? undefined,
    study_id: searchParams.get('study_id') ?? undefined,
    referral_source_id: searchParams.get('referral_source_id') ?? undefined,
    priority: searchParams.get('priority') ?? undefined,
    assigned_user_id: searchParams.get('assigned_user_id') ?? undefined,
    include_archived: searchParams.get('include_archived') ?? undefined,
    search: searchParams.get('search') ?? undefined,
    has_overdue_tasks: searchParams.get('has_overdue_tasks') ?? undefined,
    has_duplicate_warning: searchParams.get('has_duplicate_warning') ?? undefined,
    next_follow_up_from: searchParams.get('next_follow_up_from') ?? undefined,
    next_follow_up_to: searchParams.get('next_follow_up_to') ?? undefined,
    created_from: searchParams.get('created_from') ?? undefined,
    created_to: searchParams.get('created_to') ?? undefined,
    page: searchParams.get('page') ?? undefined,
    page_size: searchParams.get('page_size') ?? undefined,
    sort_by: searchParams.get('sort_by') ?? undefined,
    sort_dir: searchParams.get('sort_dir') ?? undefined,
  });
  if (!validated.success) {
    return errorResponse('VALIDATION_ERROR', 400, { issues: validated.error.issues });
  }

  try {
    const leads = await LeadService.list(validated.data, {
      user: auth.user,
      company: auth.company,
    });
    return successResponse(leads);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    logger.error('GET /api/leads failed', {
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

  const validated = createLeadSchema.safeParse(body);
  if (!validated.success) {
    return errorResponse('VALIDATION_ERROR', 400, { issues: validated.error.issues });
  }

  try {
    const lead = await LeadService.create(validated.data, {
      user: auth.user,
      company: auth.company,
    });
    return successResponse(lead, 'Lead created', 201);
  } catch (error) {
    if (error instanceof PermissionDeniedError) return errorResponse('FORBIDDEN', 403);
    if (error instanceof NotFoundError) return errorResponse('NOT_FOUND', 404);
    if (error instanceof BusinessRuleError) {
      return errorResponse('BUSINESS_RULE_FAILED', 422, { message: error.message });
    }
    logger.error('POST /api/leads failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('INTERNAL_ERROR', 500);
  }
}
