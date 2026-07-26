import { Badge } from '@/components/ui/Badge';
import type { RegulatoryDocumentStatus } from '@/types/regulatory';

type BadgeVariant = 'success' | 'warning' | 'danger' | 'default' | 'primary' | 'info';

export const STATUS_VARIANT: Record<RegulatoryDocumentStatus, BadgeVariant> = {
  missing: 'default',
  draft: 'default',
  pending_review: 'info',
  current: 'success',
  expiring_soon: 'warning',
  expired: 'danger',
  rejected: 'danger',
  archived: 'default',
};

export function DocumentStatusBadge({ status }: { status: RegulatoryDocumentStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{status.replace(/_/g, ' ')}</Badge>;
}
