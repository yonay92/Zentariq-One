// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { SubjectService } from '@/services/subjects/SubjectService';
import { PermissionDeniedError, NotFoundError, BusinessRuleError } from '@/lib/api/errors';
import { PATCH as subjectPATCH } from '@/app/api/subjects/[id]/route';

// G8 M038 rule B: a subject's site_id / study_id can never be changed through
// PATCH /api/subjects/[id]. updateSubjectSchema strips both keys, so the
// service never receives them, whatever else the payload contains.

vi.mock('@/lib/api/middleware', () => ({ resolveAuthContext: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/services/subjects/SubjectService', () => ({
  SubjectService: { update: vi.fn(), getById: vi.fn() },
}));

const SUBJECT_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_SITE_ID = '66666666-6666-4666-8666-666666666666';
const OTHER_STUDY_ID = '77777777-7777-4777-8777-777777777777';
const OTHER_TENANT_ID = '88888888-8888-4888-8888-888888888888';
const AUTH_USER = { id: 'auth-user' };
const AUTH_COMPANY = { id: 'auth-company' };

function patch(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/subjects/${SUBJECT_ID}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}
const params = { params: Promise.resolve({ id: SUBJECT_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveAuthContext).mockResolvedValue({
    ok: true,
    user: AUTH_USER,
    company: AUTH_COMPANY,
  } as never);
  vi.mocked(SubjectService.update).mockResolvedValue({ id: SUBJECT_ID } as never);
});

function serviceInput(): Record<string, unknown> {
  return vi.mocked(SubjectService.update).mock.calls[0]?.[1] as Record<string, unknown>;
}

describe('PATCH /api/subjects/[id] — site/study reassignment is impossible', () => {
  it('drops a same-tenant site_id change and forwards only the valid field', async () => {
    const res = await subjectPATCH(patch({ site_id: OTHER_SITE_ID, initials: 'AB' }), params);

    expect(res.status).toBe(200);
    expect(serviceInput()).toEqual({ initials: 'AB' });
  });

  it('drops a same-tenant study_id change', async () => {
    await subjectPATCH(patch({ study_id: OTHER_STUDY_ID, screening_date: '2026-01-02' }), params);

    expect(serviceInput()).toEqual({ screening_date: '2026-01-02' });
  });

  it('drops cross-tenant reassignment fields (company_id, site_id, study_id)', async () => {
    await subjectPATCH(
      patch({
        company_id: OTHER_TENANT_ID,
        site_id: OTHER_SITE_ID,
        study_id: OTHER_STUDY_ID,
        end_of_study_date: '2026-03-01',
      }),
      params,
    );

    expect(serviceInput()).toEqual({ end_of_study_date: '2026-03-01' });
  });

  it('rejects a payload of only site_id/study_id with 400, without calling the service', async () => {
    const res = await subjectPATCH(
      patch({ site_id: OTHER_SITE_ID, study_id: OTHER_STUDY_ID }),
      params,
    );

    expect(res.status).toBe(400);
    expect(SubjectService.update).not.toHaveBeenCalled();
  });

  it('forwards every valid unrelated field unchanged', async () => {
    const res = await subjectPATCH(
      patch({ initials: 'XY', screening_date: '2026-01-02', end_of_study_date: '2026-06-30' }),
      params,
    );

    expect(res.status).toBe(200);
    expect(serviceInput()).toEqual({
      initials: 'XY',
      screening_date: '2026-01-02',
      end_of_study_date: '2026-06-30',
    });
    expect(SubjectService.update).toHaveBeenCalledWith(SUBJECT_ID, expect.anything(), {
      user: AUTH_USER,
      company: AUTH_COMPANY,
    });
  });

  it('rejects an invalid valid-field value with 400 and changes nothing', async () => {
    const res = await subjectPATCH(
      patch({ site_id: OTHER_SITE_ID, screening_date: 'not-a-date' }),
      params,
    );

    expect(res.status).toBe(400);
    expect(SubjectService.update).not.toHaveBeenCalled();
  });
});

// Finding 2 (G8 M038 rehearsal): a PATCH with nothing left to update used to
// reach SubjectService.update with {} and come back as a 500. It is a client
// error: 400, before any service call, so nothing is read, written or audited.
describe('PATCH /api/subjects/[id] — nothing to update is a 400', () => {
  async function body(res: Response) {
    return (await res.json()) as {
      success: boolean;
      error?: { code: string; message: string };
    };
  }

  it.each([
    ['an empty object', {}],
    ['only site_id', { site_id: OTHER_SITE_ID }],
    ['only study_id', { study_id: OTHER_STUDY_ID }],
    ['only company_id', { company_id: OTHER_TENANT_ID }],
    [
      'only site_id, study_id and company_id',
      { site_id: OTHER_SITE_ID, study_id: OTHER_STUDY_ID, company_id: OTHER_TENANT_ID },
    ],
    ['only non-editable columns', { id: SUBJECT_ID, status: 'active', created_at: '2026-01-01' }],
  ])('rejects %s with 400 VALIDATION_ERROR and never calls the service', async (_name, payload) => {
    const res = await subjectPATCH(patch(payload), params);
    const json = await body(res);

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.error?.code).toBe('VALIDATION_ERROR');
    expect(json.error?.message).toBe(
      'Provide at least one field to update: initials, screening_date, end_of_study_date',
    );
    expect(SubjectService.update).not.toHaveBeenCalled();
  });

  it.each([
    ['a JSON array', []],
    ['JSON null', null],
    ['a JSON string', 'initials'],
  ])('rejects %s with 400 and never calls the service', async (_name, payload) => {
    const res = await subjectPATCH(patch(payload), params);

    expect(res.status).toBe(400);
    expect((await body(res)).error?.code).toBe('VALIDATION_ERROR');
    expect(SubjectService.update).not.toHaveBeenCalled();
  });

  it.each([
    ['initials too long', { initials: 'ABCDEFGHIJK' }],
    ['screening_date not a date', { screening_date: '2026-13-40' }],
    ['end_of_study_date wrong type', { end_of_study_date: 20260101 }],
    ['initials null', { initials: null }],
  ])(
    'rejects an invalid allowed field (%s) with 400 and never calls the service',
    async (_name, payload) => {
      const res = await subjectPATCH(patch(payload), params);

      expect(res.status).toBe(400);
      expect((await body(res)).error?.code).toBe('VALIDATION_ERROR');
      expect(SubjectService.update).not.toHaveBeenCalled();
    },
  );

  it('still accepts a single valid field', async () => {
    const res = await subjectPATCH(patch({ initials: 'AB' }), params);

    expect(res.status).toBe(200);
    expect(serviceInput()).toEqual({ initials: 'AB' });
  });

  it('returns 401 without calling the service when unauthenticated, even for an empty body', async () => {
    vi.mocked(resolveAuthContext).mockResolvedValue({
      ok: false,
      kind: 'unauthenticated',
      reason: 'none',
    } as never);

    const res = await subjectPATCH(patch({}), params);

    expect(res.status).toBe(401);
    expect(SubjectService.update).not.toHaveBeenCalled();
  });

  it('keeps the service error mapping for valid payloads (403, 404 for another tenant or site, 422)', async () => {
    vi.mocked(SubjectService.update).mockRejectedValueOnce(
      new PermissionDeniedError('edit_subject'),
    );
    expect((await subjectPATCH(patch({ initials: 'AB' }), params)).status).toBe(403);

    vi.mocked(SubjectService.update).mockRejectedValueOnce(new NotFoundError('Subject'));
    expect((await subjectPATCH(patch({ initials: 'AB' }), params)).status).toBe(404);

    vi.mocked(SubjectService.update).mockRejectedValueOnce(new BusinessRuleError('blocked'));
    expect((await subjectPATCH(patch({ initials: 'AB' }), params)).status).toBe(422);
  });
});
