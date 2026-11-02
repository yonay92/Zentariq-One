import { type NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { successResponse, errorResponse } from '@/lib/api/response';

export async function GET(request: NextRequest) {
  const auth = await resolveAuthContext(request);
  if (!auth.ok) {
    // A failed lookup is a server fault, not a missing session — report it as
    // such so the client shows a retryable error instead of "signed out".
    return auth.kind === 'unavailable'
      ? errorResponse('SERVICE_UNAVAILABLE', 503)
      : errorResponse('UNAUTHORIZED', 401);
  }

  return successResponse({ profile: auth.user, company: auth.company });
}
