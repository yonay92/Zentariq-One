import { describe, it, expect } from 'vitest';
import {
  databaseWriteError,
  ConflictError,
  DatabaseError,
  CHECK_VIOLATION_SQLSTATE,
} from '@/lib/api/errors';

// Owner decision (E1 §10.2-3): a PostgreSQL check_violation (23514) raised by
// a 039 workflow rule is returned as HTTP 409 (ConflictError).
describe('databaseWriteError', () => {
  it('maps a 039 workflow rule (23514) to ConflictError with the rule text', () => {
    const err = databaseWriteError(
      {
        code: CHECK_VIOLATION_SQLSTATE,
        message:
          'visits: complete the required earlier visits first, or record an authorized sequence exception',
      },
      'fallback',
    );
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toBe(
      'Complete the required earlier visits first, or record an authorized sequence exception.',
    );
  });

  it('maps every 039 table prefix, including the window rule (O-1)', () => {
    const err = databaseWriteError(
      {
        code: '23514',
        message: 'visits: a visit performed outside its window must be recorded as out_of_window',
      },
      'fallback',
    );
    expect(err.message).toBe(
      'A visit performed outside its window must be recorded as out_of_window.',
    );
    expect(
      databaseWriteError(
        { code: '23514', message: 'leads: the lead is closed (lost) and its status cannot change' },
        'x',
      ).message,
    ).toBe('The lead is closed (lost) and its status cannot change.');
  });

  it('uses a generic 409 message for other CHECK constraints (no constraint internals leaked)', () => {
    const err = databaseWriteError(
      {
        code: '23514',
        message: 'new row for relation "visits" violates check constraint "chk_visits_status"',
      },
      'fallback',
    );
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toBe(
      'This change conflicts with the current state of the record. Refresh and try again.',
    );
    expect(err.message).not.toContain('chk_visits_status');
  });

  it('keeps other database errors as DatabaseError (500)', () => {
    expect(databaseWriteError({ code: '42501', message: 'denied' }, 'fallback')).toBeInstanceOf(
      DatabaseError,
    );
    const missing = databaseWriteError(null, 'Failed to update visit');
    expect(missing).toBeInstanceOf(DatabaseError);
    expect(missing.message).toContain('Failed to update visit');
  });
});
