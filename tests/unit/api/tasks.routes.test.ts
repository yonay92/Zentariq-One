// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NextRequest } from 'next/server';
import { resolveAuthContext } from '@/lib/api/middleware';
import { TaskService } from '@/services/tasks/TaskService';
import { PermissionDeniedError, NotFoundError, BusinessRuleError } from '@/lib/api/errors';
import { GET as listGET, POST as createPOST } from '@/app/api/tasks/route';
import { GET as myTodayGET } from '@/app/api/tasks/my-today/route';
import { GET as byIdGET } from '@/app/api/tasks/[id]/route';
import { POST as completePOST } from '@/app/api/tasks/[id]/complete/route';
import { POST as cancelPOST } from '@/app/api/tasks/[id]/cancel/route';
import { POST as reassignPOST } from '@/app/api/tasks/[id]/reassign/route';
import { GET as commentsGET, POST as commentsPOST } from '@/app/api/tasks/[id]/comments/route';
import { GET as historyGET } from '@/app/api/tasks/[id]/history/route';

vi.mock('@/lib/api/middleware', () => ({ resolveAuthContext: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/services/tasks/TaskService', () => ({
  TaskService: {
    listTasks: vi.fn(),
    createTask: vi.fn(),
    getMyToday: vi.fn(),
    getTaskById: vi.fn(),
    completeTask: vi.fn(),
    cancelTask: vi.fn(),
    reassignTask: vi.fn(),
    getComments: vi.fn(),
    addComment: vi.fn(),
    getHistory: vi.fn(),
    ensureTaskForChartReady: vi.fn(),
    completeTaskForChart: vi.fn(),
  },
}));

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const USER_B = '33333333-3333-4333-8333-333333333333';
const AUTH_USER = { id: 'auth-user' };
const AUTH_COMPANY = { id: 'auth-company' };

function req(path: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
      : {}),
  });
}
const idParams = (id: string = TASK_ID) => ({ params: Promise.resolve({ id }) });

async function json(res: Response) {
  return (await res.json()) as { success: boolean; data?: unknown; error?: { code: string } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveAuthContext).mockResolvedValue({
    ok: true,
    user: AUTH_USER,
    company: AUTH_COMPANY,
  } as never);
});

const ctxMatcher = { user: AUTH_USER, company: AUTH_COMPANY };

describe('authentication (all routes)', () => {
  it('returns 401 without calling TaskService when unauthenticated', async () => {
    vi.mocked(resolveAuthContext).mockResolvedValue({ ok: false, reason: 'none' });
    const responses = await Promise.all([
      listGET(req('/api/tasks')),
      createPOST(req('/api/tasks', 'POST', {})),
      myTodayGET(req('/api/tasks/my-today')),
      byIdGET(req(`/api/tasks/${TASK_ID}`), idParams()),
      completePOST(req('/x', 'POST'), idParams()),
      cancelPOST(req('/x', 'POST', { reason: 'r' }), idParams()),
      reassignPOST(req('/x', 'POST', { assigned_to: USER_B }), idParams()),
      commentsGET(req('/x'), idParams()),
      commentsPOST(req('/x', 'POST', { comment: 'c' }), idParams()),
      historyGET(req('/x'), idParams()),
    ]);
    for (const r of responses) expect(r.status).toBe(401);
    for (const fn of Object.values(TaskService)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('GET /api/tasks', () => {
  it('returns the TaskService result (incl. computed fields) and forwards validated filters + auth context', async () => {
    const result = {
      data: [{ id: TASK_ID, effective_priority: 'high', is_overdue: true, days_overdue: 2 }],
      total: 1,
      page: 2,
      page_size: 10,
    };
    vi.mocked(TaskService.listTasks).mockResolvedValue(result as never);

    const res = await listGET(
      req(
        `/api/tasks?site_id=${SITE_ID}&status=assigned&priority=high&assigned_to=${USER_B}&page=2&page_size=10`,
      ),
    );

    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual(result);
    expect(TaskService.listTasks).toHaveBeenCalledWith(
      {
        site_id: SITE_ID,
        status: 'assigned',
        priority: 'high',
        assigned_to: USER_B,
        page: 2,
        page_size: 10,
      },
      ctxMatcher,
    );
  });

  it.each([
    '/api/tasks?status=bogus',
    '/api/tasks?priority=urgent',
    '/api/tasks?site_id=not-a-uuid',
    '/api/tasks?assigned_to=nope',
    '/api/tasks?page=0',
    '/api/tasks?page_size=1000',
  ])('rejects invalid filter %s with 400', async (url) => {
    const res = await listGET(req(url));
    expect(res.status).toBe(400);
    expect(TaskService.listTasks).not.toHaveBeenCalled();
  });

  it('ignores client-supplied company_id/user_id query params (never forwarded)', async () => {
    vi.mocked(TaskService.listTasks).mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      page_size: 25,
    });
    await listGET(req('/api/tasks?company_id=evil&user_id=evil'));
    expect(TaskService.listTasks).toHaveBeenCalledWith({}, ctxMatcher);
  });

  it('maps PermissionDeniedError to 403', async () => {
    vi.mocked(TaskService.listTasks).mockRejectedValue(new PermissionDeniedError('view_tasks'));
    expect((await listGET(req('/api/tasks'))).status).toBe(403);
  });

  it('maps unexpected errors to 500 without leaking the message', async () => {
    vi.mocked(TaskService.listTasks).mockRejectedValue(new Error('secret db detail'));
    const res = await listGET(req('/api/tasks'));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await json(res))).not.toContain('secret db detail');
  });
});

describe('POST /api/tasks', () => {
  const valid = {
    site_id: SITE_ID,
    title: '  Call sponsor  ',
    priority: 'high',
    due_date: '2026-03-01T10:00:00Z',
    assigned_to: USER_B,
  };

  it('creates a manual task and returns 201', async () => {
    vi.mocked(TaskService.createTask).mockResolvedValue({ id: TASK_ID } as never);
    const res = await createPOST(req('/api/tasks', 'POST', valid));
    expect(res.status).toBe(201);
    expect(TaskService.createTask).toHaveBeenCalledWith(
      { ...valid, title: 'Call sponsor' },
      ctxMatcher,
    );
  });

  it.each([
    ['missing title', { site_id: SITE_ID, assigned_to: USER_B }],
    ['blank title', { ...valid, title: '   ' }],
    ['bad site uuid', { ...valid, site_id: 'x' }],
    ['bad priority', { ...valid, priority: 'urgent' }],
    ['bad due date', { ...valid, due_date: 'tomorrow' }],
    ['bad assigned_to', { ...valid, assigned_to: 'x' }],
    ['blank assigned_role', { site_id: SITE_ID, title: 't', assigned_role: ' ' }],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await createPOST(req('/api/tasks', 'POST', body));
    expect(res.status).toBe(400);
    expect(TaskService.createTask).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON with 400', async () => {
    const r = new NextRequest('http://localhost/api/tasks', { method: 'POST', body: '{nope' });
    expect((await createPOST(r)).status).toBe(400);
  });

  it.each([
    'company_id',
    'user_id',
    'created_by',
    'created_by_system',
    'status',
    'source_module',
    'source_record_type',
    'source_record_id',
    'effective_priority',
    'is_overdue',
    'days_overdue',
    'changed_by',
  ])(
    'rejects spoofed/internal field %s (strict schema) without calling TaskService',
    async (field) => {
      const res = await createPOST(req('/api/tasks', 'POST', { ...valid, [field]: 'x' }));
      expect(res.status).toBe(400);
      expect(TaskService.createTask).not.toHaveBeenCalled();
    },
  );

  it('maps PermissionDeniedError to 403 and BusinessRuleError to 422', async () => {
    vi.mocked(TaskService.createTask).mockRejectedValueOnce(
      new PermissionDeniedError('create_task'),
    );
    expect((await createPOST(req('/api/tasks', 'POST', valid))).status).toBe(403);
    vi.mocked(TaskService.createTask).mockRejectedValueOnce(
      new BusinessRuleError('The assigned user does not have access to this site.'),
    );
    expect((await createPOST(req('/api/tasks', 'POST', valid))).status).toBe(422);
  });
});

describe('GET /api/tasks/my-today', () => {
  it('delegates only to getMyToday with the auth context and no request-derived input', async () => {
    vi.mocked(TaskService.getMyToday).mockResolvedValue([]);
    const res = await myTodayGET(req('/api/tasks/my-today?user_id=evil&company_id=evil'));
    expect(res.status).toBe(200);
    expect(TaskService.getMyToday).toHaveBeenCalledWith(ctxMatcher);
    expect(TaskService.listTasks).not.toHaveBeenCalled();
  });
});

describe('GET /api/tasks/[id]', () => {
  it('returns the task', async () => {
    vi.mocked(TaskService.getTaskById).mockResolvedValue({ id: TASK_ID } as never);
    const res = await byIdGET(req('/x'), idParams());
    expect(res.status).toBe(200);
    expect(TaskService.getTaskById).toHaveBeenCalledWith(TASK_ID, ctxMatcher);
  });

  it('passes the enriched service result through unchanged (no route-side computation)', async () => {
    const enriched = {
      id: TASK_ID,
      priority: 'low',
      status: 'assigned',
      due_date: '2026-01-01T00:00:00Z',
      // Deliberately NOT what any priority algorithm would derive from the
      // fields above — the route must return it verbatim.
      effective_priority: 'high',
      is_overdue: false,
      days_overdue: 42,
    };
    vi.mocked(TaskService.getTaskById).mockResolvedValue(enriched as never);
    const res = await byIdGET(req('/x'), idParams());
    expect((await json(res)).data).toEqual(enriched);
  });

  it('the by-id route file contains no priority/overdue computation', () => {
    const src = readFileSync(resolve(__dirname, '../../../app/api/tasks/[id]/route.ts'), 'utf8');
    expect(src).not.toMatch(
      /effective_priority|is_overdue|days_overdue|computeTaskEffectivePriority|86_?400|getTime/,
    );
  });

  it('rejects an invalid UUID with 400 before calling TaskService', async () => {
    const res = await byIdGET(req('/x'), idParams('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(TaskService.getTaskById).not.toHaveBeenCalled();
  });

  it('maps not found (incl. cross-company / inaccessible-site hidden by RLS) to 404', async () => {
    vi.mocked(TaskService.getTaskById).mockRejectedValue(new NotFoundError('Task'));
    expect((await byIdGET(req('/x'), idParams())).status).toBe(404);
  });

  it('maps site-access denial to 403', async () => {
    vi.mocked(TaskService.getTaskById).mockRejectedValue(new PermissionDeniedError('site:s'));
    expect((await byIdGET(req('/x'), idParams())).status).toBe(403);
  });
});

describe('POST /api/tasks/[id]/complete', () => {
  it('completes the task', async () => {
    vi.mocked(TaskService.completeTask).mockResolvedValue({
      id: TASK_ID,
      status: 'completed',
    } as never);
    const res = await completePOST(req('/x', 'POST'), idParams());
    expect(res.status).toBe(200);
    expect(TaskService.completeTask).toHaveBeenCalledWith(TASK_ID, ctxMatcher);
  });

  it('rejects an invalid UUID', async () => {
    expect((await completePOST(req('/x', 'POST'), idParams('x'))).status).toBe(400);
    expect(TaskService.completeTask).not.toHaveBeenCalled();
  });

  it('maps service authorization rejection to 403', async () => {
    vi.mocked(TaskService.completeTask).mockRejectedValue(
      new PermissionDeniedError('complete_task'),
    );
    expect((await completePOST(req('/x', 'POST'), idParams())).status).toBe(403);
  });

  it('maps a terminal/invalid transition to 422', async () => {
    vi.mocked(TaskService.completeTask).mockRejectedValue(
      new BusinessRuleError('A task in "cancelled" status cannot be completed.'),
    );
    const res = await completePOST(req('/x', 'POST'), idParams());
    expect(res.status).toBe(422);
  });
});

describe('POST /api/tasks/[id]/cancel', () => {
  it('cancels with a reason (trimmed)', async () => {
    vi.mocked(TaskService.cancelTask).mockResolvedValue({ id: TASK_ID } as never);
    const res = await cancelPOST(req('/x', 'POST', { reason: '  duplicate  ' }), idParams());
    expect(res.status).toBe(200);
    expect(TaskService.cancelTask).toHaveBeenCalledWith(
      TASK_ID,
      { reason: 'duplicate' },
      ctxMatcher,
    );
  });

  it.each([{}, { reason: '' }, { reason: '   ' }, { reason: 'ok', status: 'completed' }])(
    'rejects body %j with 400',
    async (body) => {
      expect((await cancelPOST(req('/x', 'POST', body), idParams())).status).toBe(400);
      expect(TaskService.cancelTask).not.toHaveBeenCalled();
    },
  );

  it('maps unauthorized to 403 and invalid transition to 422', async () => {
    vi.mocked(TaskService.cancelTask).mockRejectedValueOnce(
      new PermissionDeniedError('cancel_task'),
    );
    expect((await cancelPOST(req('/x', 'POST', { reason: 'r' }), idParams())).status).toBe(403);
    vi.mocked(TaskService.cancelTask).mockRejectedValueOnce(new BusinessRuleError('terminal'));
    expect((await cancelPOST(req('/x', 'POST', { reason: 'r' }), idParams())).status).toBe(422);
  });
});

describe('POST /api/tasks/[id]/reassign', () => {
  it('reassigns to the target user', async () => {
    vi.mocked(TaskService.reassignTask).mockResolvedValue({ id: TASK_ID } as never);
    const res = await reassignPOST(req('/x', 'POST', { assigned_to: USER_B }), idParams());
    expect(res.status).toBe(200);
    expect(TaskService.reassignTask).toHaveBeenCalledWith(
      TASK_ID,
      { assigned_to: USER_B },
      ctxMatcher,
    );
  });

  it.each([{}, { assigned_to: 'not-a-uuid' }, { assigned_to: USER_B, company_id: 'x' }])(
    'rejects body %j with 400',
    async (body) => {
      expect((await reassignPOST(req('/x', 'POST', body), idParams())).status).toBe(400);
      expect(TaskService.reassignTask).not.toHaveBeenCalled();
    },
  );

  it('maps unauthorized to 403 and a cross-company/site target rejection to 422/404 (never 200)', async () => {
    vi.mocked(TaskService.reassignTask).mockRejectedValueOnce(
      new PermissionDeniedError('assign_task'),
    );
    expect(
      (await reassignPOST(req('/x', 'POST', { assigned_to: USER_B }), idParams())).status,
    ).toBe(403);
    vi.mocked(TaskService.reassignTask).mockRejectedValueOnce(
      new BusinessRuleError("The selected user does not have access to this task's site."),
    );
    expect(
      (await reassignPOST(req('/x', 'POST', { assigned_to: USER_B }), idParams())).status,
    ).toBe(422);
    vi.mocked(TaskService.reassignTask).mockRejectedValueOnce(new NotFoundError('User'));
    expect(
      (await reassignPOST(req('/x', 'POST', { assigned_to: USER_B }), idParams())).status,
    ).toBe(404);
  });
});

describe('comments', () => {
  it('lists comments', async () => {
    vi.mocked(TaskService.getComments).mockResolvedValue([]);
    const res = await commentsGET(req('/x'), idParams());
    expect(res.status).toBe(200);
    expect(TaskService.getComments).toHaveBeenCalledWith(TASK_ID, ctxMatcher);
  });

  it('creates a comment (trimmed) and returns 201', async () => {
    vi.mocked(TaskService.addComment).mockResolvedValue({ id: 'c1' } as never);
    const res = await commentsPOST(req('/x', 'POST', { comment: '  hello ' }), idParams());
    expect(res.status).toBe(201);
    expect(TaskService.addComment).toHaveBeenCalledWith(TASK_ID, { comment: 'hello' }, ctxMatcher);
  });

  it.each([{}, { comment: '' }, { comment: '   ' }, { comment: 'x', created_by: 'evil' }])(
    'rejects body %j with 400',
    async (body) => {
      expect((await commentsPOST(req('/x', 'POST', body), idParams())).status).toBe(400);
      expect(TaskService.addComment).not.toHaveBeenCalled();
    },
  );

  it('rejects an invalid UUID on both methods', async () => {
    expect((await commentsGET(req('/x'), idParams('x'))).status).toBe(400);
    expect((await commentsPOST(req('/x', 'POST', { comment: 'c' }), idParams('x'))).status).toBe(
      400,
    );
  });

  it('maps unauthorized mutation to 403 and unknown task to 404', async () => {
    vi.mocked(TaskService.addComment).mockRejectedValueOnce(
      new PermissionDeniedError('comment_task'),
    );
    expect((await commentsPOST(req('/x', 'POST', { comment: 'c' }), idParams())).status).toBe(403);
    vi.mocked(TaskService.getComments).mockRejectedValueOnce(new NotFoundError('Task'));
    expect((await commentsGET(req('/x'), idParams())).status).toBe(404);
  });
});

describe('GET /api/tasks/[id]/history', () => {
  it('lists history', async () => {
    vi.mocked(TaskService.getHistory).mockResolvedValue([]);
    const res = await historyGET(req('/x'), idParams());
    expect(res.status).toBe(200);
    expect(TaskService.getHistory).toHaveBeenCalledWith(TASK_ID, ctxMatcher);
  });

  it('rejects an inaccessible task (404 / 403) and an invalid UUID (400)', async () => {
    vi.mocked(TaskService.getHistory).mockRejectedValueOnce(new NotFoundError('Task'));
    expect((await historyGET(req('/x'), idParams())).status).toBe(404);
    vi.mocked(TaskService.getHistory).mockRejectedValueOnce(new PermissionDeniedError('site:s'));
    expect((await historyGET(req('/x'), idParams())).status).toBe(403);
    expect((await historyGET(req('/x'), idParams('x'))).status).toBe(400);
  });
});

describe('security — static route guarantees', () => {
  const root = resolve(__dirname, '../../../app/api/tasks');
  function routeFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? routeFiles(p) : name === 'route.ts' ? [p] : [];
    });
  }
  const files = routeFiles(root);

  it('covers the expected route inventory', () => {
    expect(files).toHaveLength(8);
  });

  it('exposes no internal/reconciliation TaskService or ChartService methods', () => {
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(
        /ensureTaskForChartReady|completeTaskForChart|reconcile|ChartService/,
      );
    }
  });

  it('never touches Supabase or the admin/service-role client directly', () => {
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(
        /lib\/supabase|createAdminSupabaseClient|createServerSupabaseClient|\.from\(|service_role|SERVICE_ROLE/,
      );
    }
  });

  it('every route derives identity from resolveAuthContext only', () => {
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).toContain('resolveAuthContext');
      expect(src, f).not.toMatch(
        /body\.(company_id|user_id)|searchParams\.get\('(company_id|user_id)'\)/,
      );
    }
  });
});
