'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { usePermissions } from '@/hooks/usePermissions';
import { LEAD_STATUS_VARIANT } from '@/components/recruitment/leadStatusVariant';
import type { FollowUpQueueEntry, FollowUpQueueScope } from '@/types/recruitment';

const SCOPE_OPTIONS: Array<{ value: FollowUpQueueScope; label: string }> = [
  { value: 'due_today', label: 'Due Today' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'completed_recently', label: 'Completed Recently' },
];

const PAGE_SIZE = 10;

// No assigned_user_id is ever sent — GET /api/leads/follow-ups defaults an
// omitted assigned_user_id to the caller, which is exactly "my" queue and
// avoids the extra assign_lead permission the endpoint requires to view
// anyone else's.
export function MyFollowUpsPanel({ siteId, studyId }: { siteId: string; studyId: string }) {
  const { hasPermission } = usePermissions();
  const canView = hasPermission('manage_lead_tasks');

  const [scope, setScope] = useState<FollowUpQueueScope>('due_today');
  const [page, setPage] = useState(1);
  const [entries, setEntries] = useState<FollowUpQueueEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        scope,
        page: String(page),
        page_size: String(PAGE_SIZE),
      });
      if (siteId) params.set('site_id', siteId);
      if (studyId) params.set('study_id', studyId);
      const res = await fetch(`/api/leads/follow-ups?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to load follow-ups');
      const json = (await res.json()) as { data: { data: FollowUpQueueEntry[]; total: number } };
      setEntries(json.data.data);
      setTotal(json.data.total);
    } catch {
      setError('Failed to load follow-ups. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [scope, page, siteId, studyId]);

  useEffect(() => {
    if (canView) void fetchQueue();
    else setLoading(false);
  }, [canView, fetchQueue]);

  // Any filter/scope change invalidates the current page — reset before the
  // fetch effect above re-runs, instead of risking a page past the new total.
  useEffect(() => {
    setPage(1);
  }, [scope, siteId, studyId]);

  if (!canView) return null;

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-gray-900">My Follow-ups</h3>
        <Select
          value={scope}
          onChange={(e) => setScope(e.target.value as FollowUpQueueScope)}
          options={SCOPE_OPTIONS}
        />
      </div>

      {loading ? (
        <div className="flex justify-center py-4">
          <LoadingSpinner size="sm" />
        </div>
      ) : error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-gray-500">No follow-ups in this view.</p>
      ) : (
        <>
          <ul className="space-y-2">
            {entries.map((entry) => (
              <li key={entry.id} className="flex items-start justify-between gap-3 text-sm">
                <div>
                  <Link
                    href={`/recruitment/${entry.lead_id}`}
                    className="font-medium text-gray-900 hover:underline"
                  >
                    {entry.lead_initials ?? 'Lead'}
                  </Link>{' '}
                  <Badge variant={LEAD_STATUS_VARIANT[entry.lead_status]}>
                    {entry.lead_status.replace(/_/g, ' ')}
                  </Badge>
                  <p className="text-gray-600">{entry.title}</p>
                </div>
                <p className="shrink-0 text-xs text-gray-400">
                  {entry.completed_at
                    ? `completed ${new Date(entry.completed_at).toLocaleDateString()}`
                    : entry.due_at
                      ? `due ${new Date(entry.due_at).toLocaleDateString()}`
                      : 'no due date'}
                </p>
              </li>
            ))}
          </ul>
          {totalPages > 1 && (
            <div className="mt-3 flex items-center justify-between border-t border-gray-100 pt-3 text-sm text-gray-600">
              <span>
                Page {page} of {totalPages}
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
