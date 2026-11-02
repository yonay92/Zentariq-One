import { type NextRequest } from 'next/server';
import { successResponse, errorResponse } from '@/lib/api/response';
import { signInSchema } from '@/lib/utils/validation';
import { AuthService, SIGN_IN_MESSAGES } from '@/services/auth/AuthService';
import {
  AuthError,
  NotFoundError,
  RateLimitError,
  ServiceUnavailableError,
} from '@/lib/api/errors';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body) return errorResponse('VALIDATION_ERROR', 400, { message: 'Invalid JSON body' });

  const validated = signInSchema.safeParse(body);
  if (!validated.success) {
    return errorResponse('VALIDATION_ERROR', 400, { issues: validated.error.issues });
  }

  try {
    const { profile } = await AuthService.signIn(validated.data.email, validated.data.password);
    return successResponse({ profile }, 'Signed in successfully');
  } catch (error) {
    if (error instanceof AuthError) {
      return errorResponse('UNAUTHORIZED', 401, { message: error.message });
    }
    if (error instanceof NotFoundError) {
      return errorResponse('UNAUTHORIZED', 401, {
        message: 'No active account is linked to these credentials. Contact your administrator.',
      });
    }
    if (error instanceof RateLimitError) {
      return errorResponse('RATE_LIMITED', 429, { message: error.message });
    }
    if (error instanceof ServiceUnavailableError) {
      return errorResponse('SERVICE_UNAVAILABLE', 503, { message: error.message });
    }
    logger.error('POST /api/auth/signin failed', {
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    return errorResponse('INTERNAL_ERROR', 500, { message: SIGN_IN_MESSAGES.unavailable });
  }
}
