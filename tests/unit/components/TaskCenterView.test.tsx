import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter, useSearchParams } from 'next/navigation';
import { TaskCenterView } from '@/components/tasks/TaskCenterView';
import { ME, OTHER, SITE, calls, makeFetch, makeItem } from './taskTestUtils';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    status: 'authenticated',
    profile: { id: 'user-1' },
    company: {},
    refresh: vi.fn(),
  }),
}));

const replace = vi.fn();

function setup(search = '') {
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams(search) as never);
  vi.mocked(useRouter).mockReturnValue({ push: vi.fn(), replace } as never);
}

beforeEach(() => {
  replace.mockClear();
  setup();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function install(cfg: Parameters<typeof makeFetch>[0]) {
  const fetchMock = makeFetch(cfg);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('TaskCenterView — Queue', () => {
  it('renders the queue from GET /api/tasks and shows API-provided effective priority and overdue state', async () => {
    const fetchMock = install({
      permissions: ['view_tasks'],
      queue: [
        makeItem({
          id: 't1',
          title: 'Escalated task',
          priority: 'low', // stored base priority
          effective_priority: 'critical', // API-computed — this must be what is displayed
          is_overdue: true,
          days_overdue: 3,
          due_date: '2026-03-01T00:00:00Z',
          assigned_to: OTHER,
          assigned_role: null,
          status: 'assigned',
        }),
      ],
    });
    render(<TaskCenterView />);

    const row = (await screen.findByText('Escalated task')).closest('tr') as HTMLElement;
    expect(within(row).getByText('critical')).toBeTruthy();
    expect(within(row).queryByText('low')).toBeNull();
    expect(within(row).getByText(/Overdue · 3d/)).toBeTruthy();
    expect(within(row).getByText('assigned')).toBeTruthy();
    expect(within(row).getByText('Other Person')).toBeTruthy();
    expect(within(row).getByText('Main Site')).toBeTruthy();
    expect(calls(fetchMock).some((c) => c.url.startsWith('/api/tasks?'))).toBe(true);
    expect(screen.getByRole('tab', { name: 'Queue' }).getAttribute('aria-selected')).toBe('true');
  });

  it('shows a role-queue label for unassigned role tasks and no overdue text when not overdue', async () => {
    install({ permissions: ['view_tasks'], queue: [makeItem({ title: 'Role task' })] });
    render(<TaskCenterView />);
    const row = (await screen.findByText('Role task')).closest('tr') as HTMLElement;
    expect(within(row).getByText('data entry queue')).toBeTruthy();
    expect(within(row).queryByText(/Overdue/)).toBeNull();
  });

  it('shows a loading indicator, then the empty state', async () => {
    let release: (v: Response) => void = () => {};
    const pending = new Promise<Response>((r) => {
      release = r;
    });
    const base = makeFetch({ permissions: ['view_tasks'] });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        String(input).startsWith('/api/tasks?') ? pending : base(input, init),
      ),
    );
    const { container } = render(<TaskCenterView />);
    await waitFor(() => expect(container.querySelector('svg.animate-spin')).toBeTruthy());
    expect(screen.queryByText('No tasks match these filters')).toBeNull();

    release({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { data: [], total: 0, page: 1, page_size: 25 } }),
    } as Response);
    expect(await screen.findByText('No tasks match these filters')).toBeTruthy();
  });

  it('shows an actionable error when the API fails', async () => {
    install({ permissions: ['view_tasks'], queueReply: { ok: false, status: 500 } });
    render(<TaskCenterView />);
    expect(await screen.findByText(/Failed to load the task queue/)).toBeTruthy();
    expect(screen.queryByText('No tasks match these filters')).toBeNull();
  });

  it('passes only supported filter parameters to GET /api/tasks', async () => {
    setup(`site_id=${SITE}&assigned_to=${ME}&status=assigned&priority=high&page=2`);
    const fetchMock = install({ permissions: ['view_tasks'], queue: [] });
    render(<TaskCenterView />);
    await waitFor(() =>
      expect(calls(fetchMock).some((c) => c.url.startsWith('/api/tasks?'))).toBe(true),
    );
    const url = new URL(
      calls(fetchMock).find((c) => c.url.startsWith('/api/tasks?'))!.url,
      'http://x',
    );
    expect([...url.searchParams.keys()].sort()).toEqual(
      ['assigned_to', 'page', 'page_size', 'priority', 'site_id', 'status'].sort(),
    );
    expect(url.searchParams.get('priority')).toBe('high');
    expect(url.searchParams.get('status')).toBe('assigned');
    expect(url.searchParams.get('site_id')).toBe(SITE);
    expect(url.searchParams.get('assigned_to')).toBe(ME);
  });

  it('changing a filter updates the URL-backed filter state', async () => {
    install({ permissions: ['view_tasks'], queue: [makeItem()] });
    render(<TaskCenterView />);
    await screen.findByText('Chart ready for entry: Week 8');
    await userEvent.selectOptions(screen.getByLabelText('Priority'), 'high');
    expect(replace).toHaveBeenCalledWith(expect.stringContaining('priority=high'));
  });

  it('offers no in_progress/waiting status filter', async () => {
    install({ permissions: ['view_tasks'], queue: [] });
    render(<TaskCenterView />);
    await screen.findByText('No tasks match these filters');
    const statusSelect = screen.getByLabelText('Status');
    const labels = within(statusSelect)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(labels).not.toContain('In Progress');
    expect(labels).not.toContain('Waiting');
  });
});

describe('TaskCenterView — My Today', () => {
  it('defaults to My Today (and never calls the queue endpoint) without view_tasks', async () => {
    const fetchMock = install({
      permissions: [],
      today: [makeItem({ title: 'Mine', effective_priority: 'high', assigned_to: ME })],
    });
    render(<TaskCenterView />);
    expect(await screen.findByText('Mine')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Queue' })).toBeNull();
    const urls = calls(fetchMock).map((c) => c.url);
    expect(urls).toContain('/api/tasks/my-today');
    expect(urls.some((u) => u.startsWith('/api/tasks?'))).toBe(false);
  });

  it('renders My Today from ?view=today with the same priority/overdue language', async () => {
    setup('view=today');
    install({
      permissions: ['view_tasks'],
      today: [
        makeItem({
          title: 'Late one',
          effective_priority: 'high',
          is_overdue: true,
          days_overdue: 1,
        }),
      ],
    });
    render(<TaskCenterView />);
    const row = (await screen.findByText('Late one')).closest('tr') as HTMLElement;
    expect(within(row).getByText('high')).toBeTruthy();
    expect(within(row).getByText(/Overdue · 1d/)).toBeTruthy();
  });

  it('shows a clear empty state when nothing is assigned', async () => {
    install({ permissions: [], today: [] });
    render(<TaskCenterView />);
    expect(await screen.findByText('Nothing assigned to you')).toBeTruthy();
  });

  it('shows an error state when My Today fails', async () => {
    install({ permissions: [], todayReply: { ok: false, status: 500 } });
    render(<TaskCenterView />);
    expect(await screen.findByText(/Failed to load your tasks/)).toBeTruthy();
  });
});

describe('TaskCenterView — Create Task', () => {
  it('shows Create Task only with create_task', async () => {
    install({ permissions: ['view_tasks'], queue: [] });
    const { unmount } = render(<TaskCenterView />);
    await screen.findByText('No tasks match these filters');
    expect(screen.queryByRole('button', { name: 'Create Task' })).toBeNull();
    unmount();

    install({ permissions: ['view_tasks', 'create_task'], queue: [] });
    render(<TaskCenterView />);
    expect(await screen.findByRole('button', { name: 'Create Task' })).toBeTruthy();
  });

  async function openCreate(fetchMock: ReturnType<typeof makeFetch>) {
    void fetchMock;
    render(<TaskCenterView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Create Task' }));
    return screen.findByRole('dialog', { name: 'Create Task' });
  }

  it('validates required fields client-side without calling the API', async () => {
    const fetchMock = install({ permissions: ['view_tasks', 'create_task'], queue: [] });
    const dialog = await openCreate(fetchMock);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create Task' }));
    expect(within(dialog).getByText('Please choose a site')).toBeTruthy();
    expect(within(dialog).getByText('A title is required')).toBeTruthy();
    expect(within(dialog).getByText('Please choose a user')).toBeTruthy();
    expect(calls(fetchMock).some((c) => c.method === 'POST')).toBe(false);
  });

  it('submits only the approved create contract fields', async () => {
    const fetchMock = install({
      permissions: ['view_tasks', 'create_task'],
      queue: [],
      mutations: { 'POST /api/tasks': { data: { id: 'new-task' } } },
    });
    const dialog = await openCreate(fetchMock);

    await userEvent.selectOptions(within(dialog).getByLabelText('Site'), SITE);
    await userEvent.type(within(dialog).getByLabelText('Title'), '  Call sponsor ');
    await userEvent.type(within(dialog).getByLabelText('Description (optional)'), 'Details');
    await userEvent.selectOptions(within(dialog).getByLabelText('Priority'), 'high');
    await userEvent.selectOptions(within(dialog).getByLabelText('User'), OTHER);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create Task' }));

    await waitFor(() =>
      expect(calls(fetchMock).some((c) => c.method === 'POST' && c.url === '/api/tasks')).toBe(
        true,
      ),
    );
    const post = calls(fetchMock).find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({
      site_id: SITE,
      title: 'Call sponsor',
      description: 'Details',
      priority: 'high',
      assigned_to: OTHER,
    });
    for (const forbidden of [
      'company_id',
      'user_id',
      'status',
      'created_by',
      'created_by_system',
      'source_module',
      'source_record_type',
      'source_record_id',
      'effective_priority',
      'is_overdue',
      'days_overdue',
    ]) {
      expect(post.body).not.toHaveProperty(forbidden);
    }
    expect(await screen.findByText('Task created')).toBeTruthy();
  });

  it('can assign to a role queue instead of a user (assigned_role only)', async () => {
    const fetchMock = install({
      permissions: ['view_tasks', 'create_task'],
      queue: [],
      mutations: { 'POST /api/tasks': { data: { id: 'new-task' } } },
    });
    const dialog = await openCreate(fetchMock);
    await userEvent.selectOptions(within(dialog).getByLabelText('Site'), SITE);
    await userEvent.type(within(dialog).getByLabelText('Title'), 'Queue task');
    await userEvent.click(within(dialog).getByLabelText('A role queue'));
    await userEvent.selectOptions(await within(dialog).findByLabelText('Role'), 'data_entry');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create Task' }));

    await waitFor(() => expect(calls(fetchMock).some((c) => c.method === 'POST')).toBe(true));
    const body = calls(fetchMock).find((c) => c.method === 'POST')!.body!;
    expect(body).toMatchObject({ assigned_role: 'data_entry' });
    expect(body).not.toHaveProperty('assigned_to');
  });

  it('shows the API rejection and stays open', async () => {
    const fetchMock = install({
      permissions: ['view_tasks', 'create_task'],
      queue: [],
      mutations: {
        'POST /api/tasks': {
          ok: false,
          status: 422,
          message: 'The assigned user does not have access to this site.',
        },
      },
    });
    const dialog = await openCreate(fetchMock);
    await userEvent.selectOptions(within(dialog).getByLabelText('Site'), SITE);
    await userEvent.type(within(dialog).getByLabelText('Title'), 'X');
    await userEvent.selectOptions(within(dialog).getByLabelText('User'), OTHER);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create Task' }));
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(within(dialog).getByText(/does not have access to this site/)).toBeTruthy();
    expect(screen.queryByText('Task created')).toBeNull();
  });
});

describe('TaskCenterView — boundary', () => {
  it('exposes no reconciliation/repair controls or generic status selector', async () => {
    install({
      permissions: ['view_tasks', 'create_task', 'complete_task', 'cancel_task', 'assign_task'],
      queue: [makeItem()],
    });
    render(<TaskCenterView />);
    await screen.findByText('Chart ready for entry: Week 8');
    expect(screen.queryByText(/reconcil|repair|sync task|maintenance/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /in progress|waiting|start task/i })).toBeNull();
  });

  it('only ever calls approved /api/tasks endpoints plus read-only lookups', async () => {
    const fetchMock = install({ permissions: ['view_tasks'], queue: [makeItem()] });
    render(<TaskCenterView />);
    await screen.findByText('Chart ready for entry: Week 8');
    for (const c of calls(fetchMock)) {
      expect(c.url).toMatch(
        /^\/api\/(tasks(\/my-today)?(\?.*)?|sites|users|users\/me\/permissions)$/,
      );
      expect(c.method).toBe('GET');
    }
  });
});

describe('TaskCenterView — detail read model', () => {
  it('the detail modal shows the detail API priority/overdue, not the (stale) list row values', async () => {
    install({
      permissions: ['view_tasks'],
      queue: [makeItem({ title: 'Stale row', effective_priority: 'low', is_overdue: false })],
      // Detail fetched later: the task has since escalated.
      task: makeItem({
        title: 'Stale row',
        priority: 'low',
        effective_priority: 'critical',
        is_overdue: true,
        days_overdue: 5,
      }),
    });
    render(<TaskCenterView />);
    const row = (await screen.findByText('Stale row')).closest('tr') as HTMLElement;
    expect(within(row).getByText('low')).toBeTruthy();

    await userEvent.click(within(row).getByRole('button', { name: /View task: Stale row/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Task Details' });
    expect(await within(dialog).findByText('critical')).toBeTruthy();
    expect(within(dialog).getByText(/Overdue · 5d/)).toBeTruthy();
    expect(within(dialog).queryByText('low')).toBeNull();
  });
});
