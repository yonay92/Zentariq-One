// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { ChartService } from '@/services/charts/ChartService';
import { PermissionDeniedError, NotFoundError, DatabaseError } from '@/lib/api/errors';
import { POST as commentsPOST } from '@/app/api/charts/[id]/comments/route';
import type { AddedChartComment } from '@/types/charts';

// G8 M038 rule A: HTTP contract of POST /api/charts/[id]/comments. The service
// decides (see ChartService.test.ts); these tests pin the status codes and that
// no internal detail reaches the client.

vi.mock('@/lib/api/middleware', () => ({ resolveAuthContext: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/services/charts/ChartService', () => ({
  ChartService: { addComment: vi.fn(), getComments: vi.fn() },
}));

const CHART_ID = '44444444-4444-4444-8444-444444444444';
const AUTH_USER = { id: 'auth-user' };
const AUTH_COMPANY = { id: 'auth-company' };

function post(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/charts/${CHART_ID}/comments`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}
const params = { params: Promise.resolve({ id: CHART_ID }) };

async function json(res: Response) {
  return (await res.json()) as {
    success: boolean;
    data?: unknown;
    error?: { code: string; message: string };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveAuthContext).mockResolvedValue({
    ok: true,
    user: AUTH_USER,
    company: AUTH_COMPANY,
  } as never);
});

describe('POST /api/charts/[id]/comments', () => {
  it('returns 200 with the comment for an authorized same-site commenter', async () => {
    const comment: AddedChartComment = {
      id: 'c1',
      company_id: AUTH_COMPANY.id,
      chart_id: CHART_ID,
      comment: 'ok',
      created_by: AUTH_USER.id,
      created_at: '2026-11-17T10:00:00.123456+00:00',
    };
    vi.mocked(ChartService.addComment).mockResolvedValue(comment);

    const res = await commentsPOST(post({ comment: 'ok' }), params);

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ success: true, data: comment, message: 'Comment added' });
    expect(ChartService.addComment).toHaveBeenCalledWith(
      CHART_ID,
      { comment: 'ok' },
      { user: AUTH_USER, company: AUTH_COMPANY },
    );
  });

  it('passes a null created_at through unchanged (caller without view_charts)', async () => {
    const comment: AddedChartComment = {
      id: 'c2',
      company_id: AUTH_COMPANY.id,
      chart_id: CHART_ID,
      comment: 'ok',
      created_by: AUTH_USER.id,
      created_at: null,
    };
    vi.mocked(ChartService.addComment).mockResolvedValue(comment);

    const res = await commentsPOST(post({ comment: 'ok' }), params);
    const data = (await json(res)).data as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(Object.keys(data).sort()).toEqual(
      ['chart_id', 'comment', 'company_id', 'created_at', 'created_by', 'id'].sort(),
    );
    expect(data.created_at).toBeNull();
  });

  it('returns 403 when the caller lacks comment_chart', async () => {
    vi.mocked(ChartService.addComment).mockRejectedValue(
      new PermissionDeniedError('comment_chart'),
    );

    const res = await commentsPOST(post({ comment: 'x' }), params);

    expect(res.status).toBe(403);
    expect((await json(res)).error?.code).toBe('FORBIDDEN');
  });

  it('returns the same 404 body for a missing, cross-tenant, cross-site or DB-refused chart', async () => {
    // The service raises NotFoundError('Chart') in all four cases; the
    // client must not be able to tell them apart.
    const bodies: string[] = [];
    for (let i = 0; i < 4; i++) {
      vi.mocked(ChartService.addComment).mockRejectedValueOnce(new NotFoundError('Chart'));
      const res = await commentsPOST(post({ comment: 'x' }), params);
      expect(res.status).toBe(404);
      bodies.push(JSON.stringify(await json(res)));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0] as string).error.code).toBe('NOT_FOUND');
  });

  it('returns 500 without leaking the database message for an unexpected error', async () => {
    vi.mocked(ChartService.addComment).mockRejectedValue(
      new DatabaseError('new row violates check constraint "secret_internal_name"'),
    );

    const res = await commentsPOST(post({ comment: 'x' }), params);
    const body = await json(res);

    expect(res.status).toBe(500);
    expect(body.error?.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain('secret_internal_name');
  });

  it('returns 401 without calling the service when unauthenticated', async () => {
    vi.mocked(resolveAuthContext).mockResolvedValue({
      ok: false,
      kind: 'unauthenticated',
      reason: 'none',
    } as never);

    const res = await commentsPOST(post({ comment: 'x' }), params);

    expect(res.status).toBe(401);
    expect(ChartService.addComment).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid body without calling the service', async () => {
    const res = await commentsPOST(post({ comment: '' }), params);

    expect(res.status).toBe(400);
    expect(ChartService.addComment).not.toHaveBeenCalled();
  });
});
