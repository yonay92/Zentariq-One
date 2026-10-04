'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { AlertBanner } from '@/components/ui/AlertBanner';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { usePermissions } from '@/hooks/usePermissions';
import { useTaskFilters } from '@/hooks/useTaskFilters';
import { TaskTable } from './TaskTable';
import { TaskDetailPanel } from './TaskDetailPanel';
import { TaskCreateModal } from './TaskCreateModal';
import { TASK_API } from './taskApi';
import type { AssignableUser } from './TaskActions';
import type { TaskQueueItem, TaskQueueResult, TaskPriority, TaskStatus } from '@/types/tasks';
import type { UserWithAccess } from '@/types/users';
import type { Site } from '@/types/sites';

// in_progress / waiting exist in the state machine but have no Milestone 5.0
// UI or API action, so they are not offered as filters either.
const STATUS_OPTIONS: Array<{ value: TaskStatus; label: string }> = [
  { value: 'new', label: 'New' },
  { value: 'assigned', label: 'Assigned' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

// Filters the COMPUTED effective priority (TaskService.listTasks semantics).
const PRIORITY_OPTIONS: Array<{ value: TaskPriority; label: string }> = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

const PAGE_SIZE = 25;

type View = 'queue' | 'today';

export function TaskCenterView() {
  const { hasPermission, loading: permsLoading } = usePermissions();
  const { get, setMany } = useTaskFilters();

  const canViewQueue = hasPermission('view_tasks');
  const requestedView = get('view');
  // Users without view_tasks only ever get My Today (self-scoped by the API).
  const view: View = canViewQueue && requestedView !== 'today' ? 'queue' : 'today';

  const siteFilter = get('site_id');
  const assigneeFilter = get('assigned_to');
  const statusFilter = get('status');
  const priorityFilter = get('priority');
  const page = Number(get('page')) || 1;

  const [sites, setSites] = useState<Site[]>([]);
  const [users, setUsers] = useState<UserWithAccess[]>([]);
  const [queue, setQueue] = useState<TaskQueueResult | null>(null);
  const [today, setToday] = useState<TaskQueueItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [sitesRes, usersRes] = await Promise.all([fetch('/api/sites'), fetch('/api/users')]);
        if (sitesRes.ok) setSites(((await sitesRes.json()) as { data: Site[] }).data);
        if (usersRes.ok) setUsers(((await usersRes.json()) as { data: UserWithAccess[] }).data);
      } catch {
        // Names are a display convenience; the lists still render without them.
      }
    })();
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (view === 'queue') {
        const params = new URLSearchParams();
        if (siteFilter) params.set('site_id', siteFilter);
        if (assigneeFilter) params.set('assigned_to', assigneeFilter);
        if (statusFilter) params.set('status', statusFilter);
        if (priorityFilter) params.set('priority', priorityFilter);
        params.set('page', String(page));
        params.set('page_size', String(PAGE_SIZE));
        const res = await fetch(`${TASK_API.list}?${params.toString()}`);
        if (!res.ok) throw new Error('Failed to load tasks');
        setQueue(((await res.json()) as { data: TaskQueueResult }).data);
      } else {
        const res = await fetch(TASK_API.myToday);
        if (!res.ok) throw new Error('Failed to load tasks');
        setToday(((await res.json()) as { data: TaskQueueItem[] }).data);
      }
    } catch {
      setError(
        view === 'queue'
          ? 'Failed to load the task queue. Please refresh.'
          : 'Failed to load your tasks. Please refresh.',
      );
    } finally {
      setLoading(false);
    }
  }, [view, siteFilter, assigneeFilter, statusFilter, priorityFilter, page]);

  // Wait for the permission list so a user without view_tasks never fires a
  // request to the queue endpoint before the view is resolved.
  useEffect(() => {
    if (permsLoading) return;
    void load();
  }, [load, permsLoading, reloadKey]);

  const userNames = useMemo(
    () => Object.fromEntries(users.map((u) => [u.id, u.full_name])),
    [users],
  );
  const siteNames = useMemo(() => Object.fromEntries(sites.map((s) => [s.id, s.name])), [sites]);
  const assignable: AssignableUser[] = useMemo(
    () =>
      users
        .filter((u) => u.status === 'active')
        .map((u) => ({ id: u.id, label: `${u.full_name} (${u.email})` })),
    [users],
  );

  const items = view === 'queue' ? (queue?.data ?? []) : (today ?? []);
  const totalPages = queue ? Math.max(1, Math.ceil(queue.total / queue.page_size)) : 1;

  function handleChanged(message: string) {
    setNotice(message);
    setReloadKey((k) => k + 1);
  }

  const tabClass = (active: boolean) =>
    `rounded-lg px-3 py-1.5 text-sm font-medium ${
      active ? 'bg-blue-600 text-white' : 'text-slate-700 hover:bg-slate-100'
    }`;

  return (
    <div>
      <PageHeader
        title="Task Center"
        description="Track, assign and complete operational work"
        action={
          hasPermission('create_task') ? (
            <Button onClick={() => setCreating(true)}>Create Task</Button>
          ) : undefined
        }
      />

      <div role="tablist" aria-label="Task views" className="mb-4 flex gap-2">
        {canViewQueue && (
          <button
            type="button"
            role="tab"
            aria-selected={view === 'queue'}
            className={tabClass(view === 'queue')}
            onClick={() => setMany({ view: 'queue' })}
          >
            Queue
          </button>
        )}
        <button
          type="button"
          role="tab"
          aria-selected={view === 'today'}
          className={tabClass(view === 'today')}
          onClick={() => setMany({ view: 'today' })}
        >
          My Today
        </button>
      </div>

      {view === 'queue' && (
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Select
            label="Site"
            placeholder="All sites"
            value={siteFilter}
            onChange={(e) => setMany({ site_id: e.target.value || null })}
            options={sites.map((s) => ({ value: s.id, label: s.name }))}
          />
          <Select
            label="Assignee"
            placeholder="All assignees"
            value={assigneeFilter}
            onChange={(e) => setMany({ assigned_to: e.target.value || null })}
            options={users.map((u) => ({ value: u.id, label: u.full_name }))}
          />
          <Select
            label="Status"
            placeholder="All statuses"
            value={statusFilter}
            onChange={(e) => setMany({ status: e.target.value || null })}
            options={STATUS_OPTIONS}
          />
          <Select
            label="Priority"
            placeholder="All priorities"
            value={priorityFilter}
            onChange={(e) => setMany({ priority: e.target.value || null })}
            options={PRIORITY_OPTIONS}
          />
        </div>
      )}

      {notice && (
        <div className="mb-4">
          <AlertBanner variant="success" message={notice} onDismiss={() => setNotice(null)} />
        </div>
      )}
      {error && (
        <div className="mb-4">
          <AlertBanner variant="error" message={error} onDismiss={() => setError(null)} />
        </div>
      )}

      {loading || permsLoading ? (
        <div className="flex h-48 items-center justify-center">
          <LoadingSpinner size="lg" />
        </div>
      ) : error ? null : items.length === 0 ? (
        view === 'queue' ? (
          <EmptyState
            title="No tasks match these filters"
            description="Tasks are created automatically by workflows such as Charts, or manually."
          />
        ) : (
          <EmptyState
            title="Nothing assigned to you"
            description="Tasks assigned to you that still need action will appear here."
          />
        )
      ) : (
        <TaskTable
          items={items}
          userNames={userNames}
          siteNames={siteNames}
          onOpen={(task) => setSelectedId(task.id)}
        />
      )}

      {view === 'queue' && queue && totalPages > 1 && !error && (
        <div className="mt-4 flex items-center justify-between text-sm text-gray-600">
          <span>
            Page {queue.page} of {totalPages} ({queue.total} task{queue.total === 1 ? '' : 's'})
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setMany({ page: String(page - 1) }, { resetPage: false })}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setMany({ page: String(page + 1) }, { resetPage: false })}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {selectedId && (
        <TaskDetailPanel
          taskId={selectedId}
          users={assignable}
          userNames={userNames}
          siteNames={siteNames}
          onClose={() => setSelectedId(null)}
          onChanged={handleChanged}
        />
      )}

      <TaskCreateModal
        open={creating}
        sites={sites}
        users={assignable}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          handleChanged('Task created');
        }}
      />
    </div>
  );
}
