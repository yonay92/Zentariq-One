// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { VisitService } from '@/services/visits/VisitService';
import {
  PermissionDeniedError,
  NotFoundError,
  BusinessRuleError,
  ConflictError,
} from '@/lib/api/errors';
import { POST } from '@/app/api/subjects/[id]/visits/[visitId]/sequence-exception/route';

// Owner decision M4-D5 / migration 039: authorized visit sequence exceptions.

vi.mock('@/lib/api/middleware', () => ({ resolveAuthContext: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/services/visits/VisitService', () => ({
  VisitService: { authorizeSequenceException: vi.fn() },
}));

const SUBJECT_ID = '11111111-1111-4111-8111-111111111111';
const VISIT_ID = '22222222-2222-4222-8222-222222222222';
const params = { params: Promise.resolve({ id: SUBJECT_ID, visitId: VISIT_ID }) };
const REASON = 'Screening performed at the partner site on the same day';

function post(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/subjects/${SUBJECT_ID}/visits/${VISIT_ID}/sequence-exception`,
    {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveAuthContext).mockResolvedValue({
    ok: true,
    user: { id: 'u' },
    company: { id: 'c' },
  } as never);
});

describe('POST /api/subjects/[id]/visits/[visitId]/sequence-exception', () => {
  it('401 without a session', async () => {
    vi.mocked(resolveAuthContext).mockResolvedValue({ ok: false } as never);
    const res = await POST(post({ reason: REASON }), params);
    expect(res.status).toBe(401);
  });

  it('400 when the reason is missing or shorter than 10 characters (trimmed)', async () => {
    expect((await POST(post({}), params)).status).toBe(400);
    expect((await POST(post({ reason: '   short   ' }), params)).status).toBe(400);
    expect((await POST(post('not json'), params)).status).toBe(400);
    expect(VisitService.authorizeSequenceException).not.toHaveBeenCalled();
  });

  it('201 and forwards the trimmed reason', async () => {
    vi.mocked(VisitService.authorizeSequenceException).mockResolvedValue({ id: 'e' } as never);
    const res = await POST(post({ reason: `  ${REASON}  ` }), params);
    expect(res.status).toBe(201);
    expect(VisitService.authorizeSequenceException).toHaveBeenCalledWith(
      SUBJECT_ID,
      VISIT_ID,
      { reason: REASON },
      expect.objectContaining({ user: { id: 'u' }, company: { id: 'c' } }),
    );
  });

  it('403 without override_visit_sequence', async () => {
    vi.mocked(VisitService.authorizeSequenceException).mockRejectedValue(
      new PermissionDeniedError('override_visit_sequence'),
    );
    expect((await POST(post({ reason: REASON }), params)).status).toBe(403);
  });

  it('404 for a visit the caller cannot see', async () => {
    vi.mocked(VisitService.authorizeSequenceException).mockRejectedValue(
      new NotFoundError('Visit'),
    );
    expect((await POST(post({ reason: REASON }), params)).status).toBe(404);
  });

  it('409 with the database rule text when the visit is not blocked / already has an exception', async () => {
    vi.mocked(VisitService.authorizeSequenceException).mockRejectedValue(
      new ConflictError('The visit is not blocked by earlier visits.'),
    );
    const res = await POST(post({ reason: REASON }), params);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error).toEqual({
      code: 'CONFLICT',
      message: 'The visit is not blocked by earlier visits.',
    });
  });

  it('422 for an application business rule (visit not open)', async () => {
    vi.mocked(VisitService.authorizeSequenceException).mockRejectedValue(
      new BusinessRuleError('A sequence exception can only be recorded for an open visit'),
    );
    expect((await POST(post({ reason: REASON }), params)).status).toBe(422);
  });

  it('500 for an unexpected error', async () => {
    vi.mocked(VisitService.authorizeSequenceException).mockRejectedValue(new Error('boom'));
    expect((await POST(post({ reason: REASON }), params)).status).toBe(500);
  });
});
