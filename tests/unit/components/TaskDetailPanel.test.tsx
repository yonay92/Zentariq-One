import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TaskDetailPanel } from '@/components/tasks/TaskDetailPanel';
import type { Task, TaskQueueItem } from '@/types/tasks';
import { ME, OTHER, SITE, calls, makeFetch, makeItem, makeTask } from './taskTestUtils';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    status: 'authenticated',
    profile: { id: 'user-1' },
    company: {},
    refresh: vi.fn(),
  }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const users = [
  { id: ME, label: 'Me Myself (me@x.com)' },
  { id: OTHER, label: 'Other Person (o@x.com)' },
];
const userNames = { [ME]: 'Me Myself', [OTHER]: 'Other Person' };
const siteNames = { [SITE]: 'Main Site' };

function renderPanel(cfg: Parameters<typeof makeFetch>[0], opts: { task?: TaskQueueItem } = {}) {
  const task = opts.task ?? makeItem();
  const fetchMock = makeFetch({ ...cfg, task });
  vi.stubGlobal('fetch', fetchMock);
  const onChanged = vi.fn();
  const onClose = vi.fn();
  render(
    <TaskDetailPanel
      taskId={task.id}
      users={users}
      userNames={userNames}
      siteNames={siteNames}
      onClose={onClose}
      onChanged={onChanged}
    />,
  );
  return { fetchMock, onChanged, onClose, task };
}

async function ready() {
  await screen.findByText('Chart ready for entry: Week 8');
}

describe('TaskDetailPanel — detail', () => {
  it('renders effective priority and overdue state straight from the detail API response', async () => {
    renderPanel(
      { permissions: [] },
      {
        task: makeItem({
          priority: 'low',
          status: 'assigned',
          assigned_to: OTHER,
          assigned_role: null,
          effective_priority: 'critical',
          is_overdue: true,
          days_overdue: 2,
        }),
      },
    );
    await ready();
    expect(screen.getByText('Enter the Week 8 chart')).toBeTruthy();
    expect(screen.getByText('critical')).toBeTruthy();
    expect(screen.getByText('base: low')).toBeTruthy();
    expect(screen.getByText(/Overdue · 2d/)).toBeTruthy();
    expect(screen.getByText('Other Person')).toBeTruthy();
    expect(screen.getByText('Main Site')).toBeTruthy();
    expect(screen.getByText(/charts · chart \(automatic\)/)).toBeTruthy();
  });

  it('shows no base-priority note and no overdue text when the detail response has none', async () => {
    renderPanel(
      { permissions: [] },
      { task: makeItem({ priority: 'low', effective_priority: 'low' }) },
    );
    await ready();
    expect(screen.getByText('low')).toBeTruthy();
    expect(screen.queryByText(/base:/)).toBeNull();
    expect(screen.queryByText(/Overdue/)).toBeNull();
  });

  it('a terminal detail response renders its (base) priority with no overdue state', async () => {
    renderPanel(
      { permissions: [] },
      {
        task: makeItem({
          status: 'completed',
          priority: 'medium',
          effective_priority: 'medium',
          is_overdue: false,
          days_overdue: null,
        }),
      },
    );
    await ready();
    expect(screen.getByText('medium')).toBeTruthy();
    expect(screen.queryByText(/Overdue/)).toBeNull();
  });

  it('is correct with no list data at all (panel takes no row prop) and refetches after a mutation', async () => {
    const { fetchMock, onChanged } = renderPanel({
      permissions: ['complete_task'],
      mutations: { 'POST /api/tasks/task-1/complete': { data: {} } },
    });
    await ready();
    await userEvent.click(await screen.findByRole('button', { name: 'Complete Task' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const detailGets = calls(fetchMock).filter(
      (c) => c.method === 'GET' && c.url === '/api/tasks/task-1',
    );
    expect(detailGets.length).toBeGreaterThanOrEqual(2);
  });

  it('does not compute priority or overdue state in the browser (source-level)', () => {
    const src = readFileSync(
      resolve(__dirname, '../../../components/tasks/TaskDetailPanel.tsx'),
      'utf8',
    );
    expect(src).not.toMatch(
      /listItem|computeTaskEffectivePriority|86_?400|\.getTime\(\)|Date\.now/,
    );
    expect(src).toContain('task.effective_priority');
    expect(src).toContain('task.is_overdue');
    expect(src).toContain('task.days_overdue');
  });

  it('shows not-found for a 404', async () => {
    renderPanel({ permissions: [], taskReply: { ok: false, status: 404 } });
    expect(await screen.findByText('Task not found')).toBeTruthy();
  });

  it('shows an error banner on a server failure', async () => {
    renderPanel({ permissions: [], taskReply: { ok: false, status: 500 } });
    expect(await screen.findByText(/Failed to load this task/)).toBeTruthy();
  });
});

describe('TaskDetailPanel — terminal tasks', () => {
  it.each(['completed', 'cancelled'] as const)('%s task offers no actions', async (status) => {
    renderPanel(
      { permissions: ['complete_task', 'cancel_task', 'assign_task', 'comment_task'] },
      { task: makeItem({ status }) },
    );
    await ready();
    expect(screen.getByText(/can no longer be changed/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Complete Task' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel Task' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reassign' })).toBeNull();
  });
});

describe('TaskDetailPanel — complete', () => {
  it('completes via POST /api/tasks/[id]/complete then notifies for refresh', async () => {
    const { fetchMock, onChanged } = renderPanel({
      permissions: ['complete_task'],
      mutations: { 'POST /api/tasks/task-1/complete': { data: makeTask({ status: 'completed' }) } },
    });
    await ready();
    await userEvent.click(await screen.findByRole('button', { name: 'Complete Task' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('Task completed'));
    const post = calls(fetchMock).find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/api/tasks/task-1/complete');
    expect(post.body).toBeUndefined(); // no arbitrary status selection
  });

  it('shows Complete to the assignee even without complete_task', async () => {
    renderPanel(
      { permissions: [] },
      { task: makeItem({ status: 'assigned', assigned_to: ME, assigned_role: null }) },
    );
    await ready();
    expect(await screen.findByRole('button', { name: 'Complete Task' })).toBeTruthy();
  });

  it('hides Complete from a non-assignee without complete_task', async () => {
    renderPanel(
      { permissions: ['comment_task'] },
      { task: makeItem({ status: 'assigned', assigned_to: OTHER, assigned_role: null }) },
    );
    await ready();
    await screen.findByText('No actions available for this task.');
    expect(screen.queryByRole('button', { name: 'Complete Task' })).toBeNull();
  });

  it('surfaces an API rejection and does not pretend success', async () => {
    const { onChanged } = renderPanel({
      permissions: ['complete_task'],
      mutations: {
        'POST /api/tasks/task-1/complete': {
          ok: false,
          status: 422,
          message: 'A task in "cancelled" status cannot be completed.',
        },
      },
    });
    await ready();
    await userEvent.click(await screen.findByRole('button', { name: 'Complete Task' }));
    expect(await screen.findByText(/cannot be completed/)).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('prevents a double submit while the request is in flight', async () => {
    let release: (v: Response) => void = () => {};
    const pending = new Promise<Response>((r) => {
      release = r;
    });
    const base = makeFetch({ permissions: ['complete_task'], task: makeItem() });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === 'POST' ? pending : base(input, init),
      ),
    );
    render(
      <TaskDetailPanel
        taskId="task-1"
        users={users}
        userNames={userNames}
        siteNames={siteNames}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    const button = await screen.findByRole('button', { name: 'Complete Task' });
    await userEvent.click(button);
    await userEvent.click(button);
    const posts = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(posts).toHaveLength(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    release({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true, data: {} }),
    } as Response);
  });
});

describe('TaskDetailPanel — cancel', () => {
  it('is hidden without cancel_task', async () => {
    renderPanel({ permissions: ['complete_task'] });
    await ready();
    await screen.findByRole('button', { name: 'Complete Task' });
    expect(screen.queryByRole('button', { name: 'Cancel Task' })).toBeNull();
  });

  it('requires a non-blank reason', async () => {
    const { fetchMock } = renderPanel({ permissions: ['cancel_task'] });
    await ready();
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel Task' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel Task' });
    await userEvent.type(within(dialog).getByLabelText('Reason'), '   ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm Cancel' }));
    expect(within(dialog).getByText('A reason is required')).toBeTruthy();
    expect(calls(fetchMock).some((c) => c.method === 'POST')).toBe(false);
  });

  it('cancels with a reason via POST /api/tasks/[id]/cancel', async () => {
    const { fetchMock, onChanged } = renderPanel({
      permissions: ['cancel_task'],
      mutations: { 'POST /api/tasks/task-1/cancel': { data: makeTask({ status: 'cancelled' }) } },
    });
    await ready();
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel Task' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel Task' });
    await userEvent.type(within(dialog).getByLabelText('Reason'), ' duplicate ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm Cancel' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('Task cancelled'));
    const post = calls(fetchMock).find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/api/tasks/task-1/cancel');
    expect(post.body).toEqual({ reason: 'duplicate' });
  });

  it('shows an API rejection and keeps the dialog open', async () => {
    const { onChanged } = renderPanel({
      permissions: ['cancel_task'],
      mutations: {
        'POST /api/tasks/task-1/cancel': {
          ok: false,
          status: 403,
          message: 'You do not have permission',
        },
      },
    });
    await ready();
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel Task' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel Task' });
    await userEvent.type(within(dialog).getByLabelText('Reason'), 'why');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm Cancel' }));
    expect(await within(dialog).findByText('You do not have permission')).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('TaskDetailPanel — reassign', () => {
  it('is hidden without assign_task', async () => {
    renderPanel({ permissions: ['complete_task'] });
    await ready();
    await screen.findByRole('button', { name: 'Complete Task' });
    expect(screen.queryByRole('button', { name: 'Reassign' })).toBeNull();
  });

  it('reassigns via POST /api/tasks/[id]/reassign with only assigned_to', async () => {
    const { fetchMock, onChanged } = renderPanel({
      permissions: ['assign_task'],
      mutations: { 'POST /api/tasks/task-1/reassign': { data: makeTask() } },
    });
    await ready();
    await userEvent.click(await screen.findByRole('button', { name: 'Reassign' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reassign Task' });
    await userEvent.selectOptions(within(dialog).getByLabelText('New assignee'), OTHER);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reassign Task' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('Task reassigned'));
    const post = calls(fetchMock).find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/api/tasks/task-1/reassign');
    expect(post.body).toEqual({ assigned_to: OTHER });
  });

  it('requires a target user', async () => {
    const { fetchMock } = renderPanel({ permissions: ['assign_task'] });
    await ready();
    await userEvent.click(await screen.findByRole('button', { name: 'Reassign' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reassign Task' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reassign Task' }));
    expect(within(dialog).getByText('Please choose a user')).toBeTruthy();
    expect(calls(fetchMock).some((c) => c.method === 'POST')).toBe(false);
  });

  it('a target-access rejection is shown and local state is unchanged', async () => {
    const { onChanged } = renderPanel(
      {
        permissions: ['assign_task'],
        mutations: {
          'POST /api/tasks/task-1/reassign': {
            ok: false,
            status: 422,
            message: "The selected user does not have access to this task's site.",
          },
        },
      },
      { task: makeItem({ status: 'assigned', assigned_to: ME, assigned_role: null }) },
    );
    await ready();
    await userEvent.click(await screen.findByRole('button', { name: 'Reassign' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reassign Task' });
    await userEvent.selectOptions(within(dialog).getByLabelText('New assignee'), OTHER);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reassign Task' }));
    expect(
      await within(dialog).findByText(/does not have access to this task's site/),
    ).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
    // Detail still shows the original assignee.
    expect(screen.getAllByText('Me Myself').length).toBeGreaterThan(0);
  });
});

describe('TaskDetailPanel — comments', () => {
  const existing = [
    {
      id: 'c1',
      company_id: 'c',
      task_id: 'task-1',
      comment: 'First note',
      created_by: OTHER,
      created_at: '2026-03-02T00:00:00Z',
    },
  ];

  it('loads and displays comments without an add form when comment_task is missing', async () => {
    renderPanel({ permissions: [], comments: existing });
    expect(await screen.findByText('First note')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add Comment' })).toBeNull();
  });

  it('blocks blank submission', async () => {
    renderPanel({ permissions: ['comment_task'], comments: existing });
    await screen.findByText('First note');
    const button = screen.getByRole('button', { name: 'Add Comment' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Add a comment'), '   ');
    expect(button.disabled).toBe(true);
  });

  it('creates a comment via POST /api/tasks/[id]/comments', async () => {
    const { fetchMock } = renderPanel({
      permissions: ['comment_task'],
      comments: existing,
      mutations: { 'POST /api/tasks/task-1/comments': { data: { id: 'c2' } } },
    });
    await screen.findByText('First note');
    await userEvent.type(screen.getByLabelText('Add a comment'), ' Second note ');
    await userEvent.click(screen.getByRole('button', { name: 'Add Comment' }));
    await waitFor(() =>
      expect(calls(fetchMock).find((c) => c.method === 'POST')?.body).toEqual({
        comment: 'Second note',
      }),
    );
    await waitFor(() =>
      expect((screen.getByLabelText('Add a comment') as HTMLTextAreaElement).value).toBe(''),
    );
  });

  it('shows a mutation rejection and keeps the text', async () => {
    renderPanel({
      permissions: ['comment_task'],
      comments: existing,
      mutations: {
        'POST /api/tasks/task-1/comments': {
          ok: false,
          status: 403,
          message: 'You do not have permission',
        },
      },
    });
    await screen.findByText('First note');
    await userEvent.type(screen.getByLabelText('Add a comment'), 'Denied');
    await userEvent.click(screen.getByRole('button', { name: 'Add Comment' }));
    expect(await screen.findByText('You do not have permission')).toBeTruthy();
    expect((screen.getByLabelText('Add a comment') as HTMLTextAreaElement).value).toBe('Denied');
  });
});

describe('TaskDetailPanel — history', () => {
  it('renders a read-only timeline with reason and known actor', async () => {
    renderPanel({
      permissions: [],
      history: [
        {
          id: 'h1',
          company_id: 'c',
          task_id: 'task-1',
          old_status: null,
          new_status: 'new',
          changed_by: null,
          changed_at: '2026-03-01T00:00:00Z',
          reason: null,
        },
        {
          id: 'h2',
          company_id: 'c',
          task_id: 'task-1',
          old_status: 'new',
          new_status: 'cancelled',
          changed_by: OTHER,
          changed_at: '2026-03-02T00:00:00Z',
          reason: 'duplicate',
        },
      ],
    });
    expect(await screen.findByText('created → new')).toBeTruthy();
    expect(screen.getByText('new → cancelled')).toBeTruthy();
    expect(screen.getByText('duplicate')).toBeTruthy();
    expect(screen.getByText(/Other Person ·/)).toBeTruthy();
    // No history mutation controls.
    const list = screen.getByText('created → new').closest('ul') as HTMLElement;
    expect(within(list).queryAllByRole('button')).toHaveLength(0);
  });
});

describe('Task Center UI — security boundary', () => {
  it('detail panel exposes no generic status selector or in_progress/waiting action', async () => {
    renderPanel({ permissions: ['complete_task', 'cancel_task', 'assign_task', 'comment_task'] });
    await ready();
    await screen.findByRole('button', { name: 'Complete Task' });
    expect(screen.queryByRole('combobox', { name: /status/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /in progress|waiting|start/i })).toBeNull();
    expect(screen.queryByText(/reconcil|repair|sync/i)).toBeNull();
  });

  it('every Task Center source file avoids Supabase, task table writes and reconciliation', () => {
    const dir = resolve(__dirname, '../../../components/tasks');
    for (const name of readdirSync(dir)) {
      const src = readFileSync(join(dir, name), 'utf8');
      expect(src, name).not.toMatch(/supabase|from\('tasks'\)|task_history|reconcile/i);
    }
  });

  it('all Task mutation URLs are approved /api/tasks routes (source-level)', () => {
    const dir = resolve(__dirname, '../../../components/tasks');
    const urls = new Set<string>();
    for (const name of readdirSync(dir)) {
      const src = readFileSync(join(dir, name), 'utf8');
      for (const m of src.matchAll(/['"`](\/api\/[^'"`?]*)/g))
        urls.add(m[1]!.replace(/\$\{[^}]+\}/g, '{id}'));
    }
    const allowed = [
      '/api/tasks',
      '/api/tasks/my-today',
      '/api/tasks/{id}',
      '/api/tasks/{id}/complete',
      '/api/tasks/{id}/cancel',
      '/api/tasks/{id}/reassign',
      '/api/tasks/{id}/comments',
      '/api/tasks/{id}/history',
      '/api/sites',
      '/api/users',
      '/api/roles',
    ];
    for (const u of urls) expect(allowed, u).toContain(u);
  });
});
