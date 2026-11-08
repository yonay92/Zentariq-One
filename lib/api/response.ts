import { NextResponse } from 'next/server';

type ApiSuccessResponse<T> = {
  success: true;
  data: T;
  message?: string;
};

type ApiErrorResponse = {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export function successResponse<T>(
  data: T,
  message?: string,
  status: number = 200,
): NextResponse<ApiSuccessResponse<T>> {
  const body: ApiSuccessResponse<T> =
    message !== undefined ? { success: true, data, message } : { success: true, data };
  return NextResponse.json(body, { status });
}

export function errorResponse(
  code: string,
  status: number,
  details?: { message?: string; issues?: unknown },
): NextResponse<ApiErrorResponse> {
  const messages: Record<string, string> = {
    UNAUTHORIZED: 'Authentication required',
    FORBIDDEN: 'You do not have permission to perform this action',
    NOT_FOUND: 'The requested resource was not found',
    VALIDATION_ERROR: 'Request validation failed',
    DUPLICATE_RECORD: 'A record with this value already exists',
    BUSINESS_RULE_FAILED: 'Operation blocked by a business rule',
    AI_REVIEW_REQUIRED: 'AI response requires review before applying',
    FILE_UPLOAD_FAILED: 'File upload failed',
    CONFLICT: 'Conflict with existing data',
    INTERNAL_ERROR: 'An internal error occurred',
    SIGN_IN_SYNC_FAILED: 'The account status was saved, but sign-in access could not be updated',
  };

  return NextResponse.json(
    {
      success: false,
      error: {
        code,
        message: details?.message ?? messages[code] ?? 'An error occurred',
        ...(details?.issues ? { details: details.issues } : {}),
      },
    },
    { status },
  );
}
