import { Badge } from '@/components/ui/Badge';
import type { ChartStatus, ChartPriority } from '@/types/charts';

type BadgeVariant = 'success' | 'warning' | 'danger' | 'default' | 'primary' | 'info';

const STATUS_VARIANT: Record<ChartStatus, BadgeVariant> = {
  chart_ready: 'default',
  in_progress: 'primary',
  entered_in_edc: 'success',
  on_hold: 'warning',
};

const PRIORITY_VARIANT: Record<ChartPriority, BadgeVariant> = {
  critical: 'danger',
  high: 'warning',
  medium: 'info',
  low: 'default',
};

export function ChartStatusBadge({ status }: { status: ChartStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{status.replace(/_/g, ' ')}</Badge>;
}

export function ChartPriorityBadge({ priority }: { priority: ChartPriority }) {
  return <Badge variant={PRIORITY_VARIANT[priority]}>{priority}</Badge>;
}
