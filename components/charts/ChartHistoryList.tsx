'use client';

import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import type { ChartHistoryEntry } from '@/types/charts';

// Same rendering shape as the Subject Profile's History tab
// (old_status -> new_status, optional reason, timestamp) — chart_history is
// structurally identical to subject_status_history, so the display
// convention is reused rather than invented.
export function ChartHistoryList({ chartId }: { chartId: string }) {
  const [history, setHistory] = useState<ChartHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const res = await fetch(`/api/charts/${chartId}/history`);
      if (!cancelled && res.ok) {
        const json = (await res.json()) as { data: ChartHistoryEntry[] };
        setHistory(json.data);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [chartId]);

  if (loading) {
    return (
      <div className="flex justify-center py-6">
        <LoadingSpinner />
      </div>
    );
  }

  if (history.length === 0) {
    return <EmptyState title="No status changes yet" description="Status changes appear here" />;
  }

  return (
    <ul className="space-y-2">
      {history.map((entry) => (
        <li key={entry.id} className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-sm text-gray-900">
            {entry.old_status ? entry.old_status.replace(/_/g, ' ') : 'created'} →{' '}
            {entry.new_status.replace(/_/g, ' ')}
          </p>
          {entry.reason && <p className="text-sm text-gray-600">{entry.reason}</p>}
          <p className="text-xs text-gray-400">{new Date(entry.changed_at).toLocaleString()}</p>
        </li>
      ))}
    </ul>
  );
}
