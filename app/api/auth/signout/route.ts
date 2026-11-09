import { type NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { successResponse, errorResponse } from '@/lib/api/response';
import { AuthService } from '@/services/auth/AuthService';
import { clearSupabaseAuthCookies } from '@/lib/supabase/session';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  // Resolve the application identity only to attribute the audit entry; the
  // session is ended whether or not a profile could be loaded.
  const auth = await resolveAuthContext(request);
  const actor = auth.ok ? { userId: auth.user.id, companyId: auth.company.id } : null;

  try {
    await AuthService.signOut(actor);
    return successResponse(null, 'Signed out successfully');
  } catch (error) {
    logger.error('POST /api/auth/signout failed', {
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    await clearSupabaseAuthCookies().catch(() => 0);
    return errorResponse('INTERNAL_ERROR', 500, {
      message: 'Sign out could not be completed. Please try again.',
    });
  }
}
