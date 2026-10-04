import { Badge } from '@/components/ui/Badge';
import type { TaskPriority, TaskStatus } from '@/types/tasks';

type BadgeVariant = 'success' | 'warning' | 'danger' | 'default' | 'primary' | 'info';

const STATUS_VARIANT: Record<TaskStatus, BadgeVariant> = {
  new: 'default',
  assigned: 'primary',
  in_progress: 'primary',
  waiting: 'warning',
  completed: 'success',
  cancelled: 'default',
};

const PRIORITY_VARIANT: Record<TaskPriority, BadgeVariant> = {
  critical: 'danger',
  high: 'warning',
  medium: 'info',
  low: 'default',
};

// Meaning is always carried by the text label, never by color alone.
export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{status.replace(/_/g, ' ')}</Badge>;
}

export function TaskPriorityBadge({ priority }: { priority: TaskPriority }) {
  return <Badge variant={PRIORITY_VARIANT[priority]}>{priority}</Badge>;
}

// Rendered strictly from API-provided is_overdue / days_overdue — never
// recomputed in the browser.
export function TaskOverdueIndicator({
  isOverdue,
  daysOverdue,
}: {
  isOverdue: boolean;
  daysOverdue: number | null;
}) {
  if (!isOverdue) return null;
  return (
    <span className="text-xs font-medium text-red-700">
      <span aria-hidden="true">⚠ </span>
      Overdue{daysOverdue !== null ? ` · ${daysOverdue}d` : ''}
    </span>
  );
}
