import { vi } from 'vitest';
import type { Task, TaskQueueItem, TaskHistoryEntry, TaskComment } from '@/types/tasks';

export const ME = 'user-1';
export const OTHER = 'user-2';
export const SITE = 'site-1';

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    company_id: 'company-1',
    site_id: SITE,
    assigned_to: null,
    assigned_role: 'data_entry',
    source_module: 'charts',
    source_record_type: 'chart',
    source_record_id: 'chart-1',
    title: 'Chart ready for entry: Week 8',
    description: 'Enter the Week 8 chart',
    priority: 'low',
    status: 'new',
    due_date: '2026-03-04T00:00:00Z',
    created_by_system: true,
    created_at: '2026-03-01T00:00:00Z',
    updated_at: '2026-03-01T00:00:00Z',
    ...overrides,
  };
}

export function makeItem(overrides: Partial<TaskQueueItem> = {}): TaskQueueItem {
  return {
    ...makeTask(),
    effective_priority: 'low',
    is_overdue: false,
    days_overdue: null,
    ...overrides,
  };
}

type Reply = { ok?: boolean; status?: number; data?: unknown; message?: string };

export type FetchConfig = {
  permissions?: string[];
  queue?: TaskQueueItem[];
  queueReply?: Reply;
  today?: TaskQueueItem[];
  todayReply?: Reply;
  task?: Task | TaskQueueItem;
  taskReply?: Reply;
  history?: TaskHistoryEntry[];
  comments?: TaskComment[];
  // Keyed by "METHOD path", e.g. "POST /api/tasks/task-1/complete".
  mutations?: Record<string, Reply>;
};

function respond(reply: Reply) {
  const ok = reply.ok ?? true;
  return Promise.resolve({
    ok,
    status: reply.status ?? (ok ? 200 : 422),
    json: () =>
      Promise.resolve(
        ok
          ? { success: true, data: reply.data }
          : { success: false, error: { code: 'ERR', message: reply.message ?? 'rejected' } },
      ),
  } as Response);
}

export function makeFetch(cfg: FetchConfig = {}) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const path = url.split('?')[0] ?? url;

    const mutation = cfg.mutations?.[`${method} ${path}`];
    if (mutation) return respond(mutation);

    if (method !== 'GET') return respond({ ok: true, data: {} });

    if (path === '/api/users/me/permissions') {
      return respond({ data: { permissions: cfg.permissions ?? [] } });
    }
    if (path === '/api/tasks') {
      return respond(cfg.queueReply ?? { data: wrapQueue(cfg.queue ?? []) });
    }
    if (path === '/api/tasks/my-today') return respond(cfg.todayReply ?? { data: cfg.today ?? [] });
    if (path === '/api/sites') return respond({ data: [{ id: SITE, name: 'Main Site' }] });
    if (path === '/api/users') {
      return respond({
        data: [
          { id: ME, full_name: 'Me Myself', email: 'me@x.com', status: 'active' },
          { id: OTHER, full_name: 'Other Person', email: 'o@x.com', status: 'active' },
        ],
      });
    }
    if (path === '/api/roles')
      return respond({ data: { roles: [{ key: 'data_entry', name: 'Data Entry' }] } });
    if (path.endsWith('/history')) return respond({ data: cfg.history ?? [] });
    if (path.endsWith('/comments')) return respond({ data: cfg.comments ?? [] });
    if (path.startsWith('/api/tasks/')) {
      return respond(cfg.taskReply ?? { data: cfg.task ?? makeItem() });
    }
    return respond({ ok: false, status: 404, message: 'not found' });
  });
}

function wrapQueue(items: TaskQueueItem[]) {
  return { data: items, total: items.length, page: 1, page_size: 25 };
}

export function calls(fetchMock: ReturnType<typeof makeFetch>) {
  return fetchMock.mock.calls.map(([input, init]) => ({
    url: typeof input === 'string' ? input : input.toString(),
    method: init?.method ?? 'GET',
    body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
  }));
}
