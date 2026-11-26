export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class PermissionDeniedError extends AppError {
  constructor(permission: string) {
    super(`Permission denied: ${permission}`, 'FORBIDDEN');
  }
}

export class BusinessRuleError extends AppError {
  constructor(message: string) {
    super(message, 'BUSINESS_RULE_FAILED');
  }
}

export class DuplicateRecordError extends AppError {
  constructor(field: string) {
    super(`Duplicate record: ${field} already exists`, 'DUPLICATE_RECORD');
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`${resource} not found`, 'NOT_FOUND');
  }
}

export class DatabaseError extends AppError {
  constructor(message: string) {
    super(`Database operation failed: ${message}`, 'INTERNAL_ERROR');
  }
}

// The account status change was saved, but Supabase Auth was not brought in
// line with it. Saving the same status again retries the synchronization.
export class SignInSyncError extends AppError {
  constructor(message: string) {
    super(message, 'SIGN_IN_SYNC_FAILED');
  }
}

export class AuthError extends AppError {
  constructor(message: string) {
    super(message, 'UNAUTHORIZED');
  }
}

export class RateLimitError extends AppError {
  constructor(message: string) {
    super(message, 'RATE_LIMITED');
  }
}

/** A dependency (Auth provider, database) failed; the caller may retry later. */
export class ServiceUnavailableError extends AppError {
  constructor(message: string) {
    super(message, 'SERVICE_UNAVAILABLE');
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 'CONFLICT');
  }
}

/**
 * PostgreSQL check_violation. Migration 039 raises it when a write breaks a
 * workflow rule (status transition, visit sequence, visit window,
 * creation precondition); CHECK constraints raise it too.
 */
export const CHECK_VIOLATION_SQLSTATE = '23514';

const WORKFLOW_RULE_MESSAGE =
  /^(subjects|visits|charts|leads|studies|visit_templates|visit_template_items|visit_sequence_exceptions): (.+)$/;

/**
 * Error for a failed write on a workflow-protected table. A check violation
 * becomes a ConflictError (HTTP 409) with the rule text from migration 039 —
 * those texts name the rule only, never other records — or a generic message
 * for other CHECK constraints. Anything else stays a DatabaseError.
 */
export function databaseWriteError(
  error: { code?: string; message?: string } | null | undefined,
  fallbackMessage: string,
): AppError {
  if (error?.code === CHECK_VIOLATION_SQLSTATE) {
    const rule = WORKFLOW_RULE_MESSAGE.exec(error.message ?? '');
    const text = rule?.[2];
    return new ConflictError(
      text
        ? `${text.charAt(0).toUpperCase()}${text.slice(1)}.`
        : 'This change conflicts with the current state of the record. Refresh and try again.',
    );
  }
  return new DatabaseError(error?.message ?? fallbackMessage);
}

export class ValidationError extends AppError {
  constructor(
    message: string,
    public readonly issues?: unknown,
  ) {
    super(message, 'VALIDATION_ERROR');
  }
}
