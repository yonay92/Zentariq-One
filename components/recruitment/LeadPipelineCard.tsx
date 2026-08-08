'use client';

import Link from 'next/link';
import { useDraggable } from '@dnd-kit/core';
import { Badge } from '@/components/ui/Badge';
import type { LeadListItem, LeadPriority } from '@/types/recruitment';

const PRIORITY_DOT: Record<LeadPriority, string> = {
  low: 'bg-gray-300',
  medium: 'bg-blue-400',
  high: 'bg-orange-400',
  urgent: 'bg-red-500',
};

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts
    .slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase())
    .join('');
}

export function LeadPipelineCard({
  lead,
  assignedUserName,
  onOpenMoveMenu,
}: {
  lead: LeadListItem;
  assignedUserName: string | null;
  onOpenMoveMenu: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: lead.id,
  });

  const overdueFollowUp = lead.next_contact_at
    ? new Date(lead.next_contact_at).getTime() < Date.now()
    : false;

  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`space-y-2 rounded-lg border border-gray-200 bg-white p-3 text-sm shadow-sm ${
        isDragging ? 'opacity-50' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2" {...attributes} {...listeners}>
          <span
            className={`h-2.5 w-2.5 shrink-0 rounded-full ${PRIORITY_DOT[lead.priority]}`}
            title={`${lead.priority} priority`}
            aria-hidden="true"
          />
          <Link
            href={`/recruitment/${lead.id}`}
            className="font-medium text-gray-900 hover:underline"
            // Prevent the drag listener on the parent from swallowing the click.
            onPointerDown={(e) => e.stopPropagation()}
          >
            {lead.initials ?? 'New lead'}
          </Link>
        </div>
        <button
          type="button"
          onClick={onOpenMoveMenu}
          className="shrink-0 text-xs font-medium text-blue-600 hover:underline"
        >
          Move to…
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {lead.do_not_contact && <Badge variant="danger">Do not contact</Badge>}
        {lead.has_duplicate_warning && <Badge variant="warning">Possible duplicate</Badge>}
        {lead.has_overdue_task && <Badge variant="warning">Overdue task</Badge>}
        {overdueFollowUp && <Badge variant="warning">Follow-up overdue</Badge>}
      </div>

      <div className="flex items-center justify-between text-xs text-gray-500">
        <span
          className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-100 font-medium text-gray-600"
          title={assignedUserName ?? 'Unassigned'}
        >
          {assignedUserName ? initialsOf(assignedUserName) : '—'}
        </span>
        {lead.open_task_count > 0 && <span>{lead.open_task_count} open task(s)</span>}
      </div>
    </div>
  );
}
