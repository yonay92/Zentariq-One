'use client';

import { useState, useEffect, useCallback } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { usePermissions } from '@/hooks/usePermissions';
import type { WorkloadSummary } from '@/types/recruitment';
import type { Profile } from '@/types/users';

// users is passed down from the Dashboard page's own already-fetched list
// rather than fetched again here — GET /api/leads/workload doesn't return
// names, only assigned_user_id, and the Dashboard already has /api/users
// loaded for its other filters.
export function TeamWorkloadPanel({
  siteId,
  studyId,
  users,
}: {
  siteId: string;
  studyId: string;
  users: Profile[];
}) {
  const { hasPermission } = usePermissions();
  const canView = hasPermission('assign_lead');

  const [summary, setSummary] = useState<WorkloadSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (siteId) params.set('site_id', siteId);
      if (studyId) params.set('study_id', studyId);
      const res = await fetch(`/api/leads/workload?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to load workload');
      const json = (await res.json()) as { data: WorkloadSummary };
      setSummary(json.data);
    } catch {
      setError('Failed to load team workload. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [siteId, studyId]);

  useEffect(() => {
    if (canView) void fetchSummary();
    else setLoading(false);
  }, [canView, fetchSummary]);

  if (!canView) return null;

  const userName = (id: string | null) => users.find((u) => u.id === id)?.full_name ?? 'Unknown';

  const sortedEntries = summary
    ? [...summary.entries].sort((a, b) => b.active_lead_count - a.active_lead_count)
    : [];

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <h3 className="mb-3 text-sm font-semibold text-gray-900">Team Workload</h3>

      {loading ? (
        <div className="flex justify-center py-4">
          <LoadingSpinner size="sm" />
        </div>
      ) : error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : !summary || (sortedEntries.length === 0 && summary.unassigned_count === 0) ? (
        <p className="text-sm text-gray-500">No active leads assigned yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left text-xs text-gray-500 uppercase">
              <th className="pb-2 font-medium">User</th>
              <th className="pb-2 text-right font-medium">Active Leads</th>
              <th className="pb-2 text-right font-medium">Overdue Tasks</th>
            </tr>
          </thead>
          <tbody>
            {sortedEntries.map((entry) => (
              <tr key={entry.assigned_user_id} className="border-b border-gray-50 last:border-0">
                <td className="py-2 text-gray-900">{userName(entry.assigned_user_id)}</td>
                <td className="py-2 text-right text-gray-900">{entry.active_lead_count}</td>
                <td
                  className={`py-2 text-right ${
                    entry.overdue_task_count > 0 ? 'font-medium text-red-600' : 'text-gray-900'
                  }`}
                >
                  {entry.overdue_task_count}
                </td>
              </tr>
            ))}
            {summary.unassigned_count > 0 && (
              <tr>
                <td className="py-2 text-gray-500 italic">Unassigned</td>
                <td className="py-2 text-right text-gray-900">{summary.unassigned_count}</td>
                <td className="py-2 text-right text-gray-400">—</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
