'use client';

import { Button } from '@/components/ui/Button';
import { Table, type Column } from '@/components/ui/Table';
import { TaskStatusBadge, TaskPriorityBadge, TaskOverdueIndicator } from './TaskBadges';
import type { TaskQueueItem } from '@/types/tasks';

export type NameLookup = Record<string, string>;

export function assigneeLabel(
  task: { assigned_to: string | null; assigned_role: string | null },
  userNames: NameLookup,
): string {
  if (task.assigned_to) return userNames[task.assigned_to] ?? 'Assigned user';
  if (task.assigned_role) return `${task.assigned_role.replace(/_/g, ' ')} queue`;
  return 'Unassigned';
}

export function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString() : '—';
}

// Shared by the Queue and My Today views so both use the same operational
// priority/overdue visual language. Priority is ALWAYS effective_priority as
// returned by the API.
export function TaskTable({
  items,
  userNames,
  siteNames,
  onOpen,
}: {
  items: TaskQueueItem[];
  userNames: NameLookup;
  siteNames: NameLookup;
  onOpen: (task: TaskQueueItem) => void;
}) {
  const columns: Column<TaskQueueItem>[] = [
    {
      key: 'title',
      header: 'Task',
      render: (row) => <span className="font-medium text-slate-900">{row.title}</span>,
    },
    {
      key: 'priority',
      header: 'Priority',
      render: (row) => <TaskPriorityBadge priority={row.effective_priority} />,
    },
    { key: 'status', header: 'Status', render: (row) => <TaskStatusBadge status={row.status} /> },
    { key: 'assignee', header: 'Assignee', render: (row) => assigneeLabel(row, userNames) },
    { key: 'site', header: 'Site', render: (row) => siteNames[row.site_id] ?? '—' },
    {
      key: 'due',
      header: 'Due',
      render: (row) => (
        <div className="flex flex-col gap-0.5">
          <span>{formatDate(row.due_date)}</span>
          <TaskOverdueIndicator isOverdue={row.is_overdue} daysOverdue={row.days_overdue} />
        </div>
      ),
    },
    { key: 'created', header: 'Created', render: (row) => formatDate(row.created_at) },
    {
      key: 'actions',
      header: '',
      render: (row) => (
        <Button
          variant="outline"
          size="sm"
          aria-label={`View task: ${row.title}`}
          onClick={() => onOpen(row)}
        >
          View
        </Button>
      ),
    },
  ];

  return <Table columns={columns} data={items} rowKey={(row) => row.id} />;
}
