'use client';

import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { TASK_API } from './taskApi';
import type { NameLookup } from './TaskTable';
import type { TaskHistoryEntry } from '@/types/tasks';

// Read-only timeline. Same rendering shape as ChartHistoryList. The actor is
// shown only when the API's changed_by resolves to a known user — never
// guessed.
export function TaskHistoryList({
  taskId,
  refreshKey,
  userNames,
}: {
  taskId: string;
  refreshKey: number;
  userNames: NameLookup;
}) {
  const [history, setHistory] = useState<TaskHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void (async () => {
      try {
        const res = await fetch(TASK_API.history(taskId));
        if (cancelled) return;
        if (res.ok) {
          setHistory(((await res.json()) as { data: TaskHistoryEntry[] }).data);
        } else {
          setFailed(true);
        }
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId, refreshKey]);

  if (loading) {
    return (
      <div className="flex justify-center py-6">
        <LoadingSpinner />
      </div>
    );
  }
  if (failed) return <p className="text-sm text-red-600">Failed to load history.</p>;
  if (history.length === 0) {
    return <EmptyState title="No status changes yet" description="Status changes appear here" />;
  }

  return (
    <ul className="space-y-2">
      {history.map((entry) => {
        const actor = entry.changed_by ? userNames[entry.changed_by] : undefined;
        return (
          <li key={entry.id} className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-sm text-gray-900">
              {entry.old_status ? entry.old_status.replace(/_/g, ' ') : 'created'} →{' '}
              {entry.new_status.replace(/_/g, ' ')}
            </p>
            {entry.reason && <p className="text-sm text-gray-600">{entry.reason}</p>}
            <p className="text-xs text-gray-400">
              {actor ? `${actor} · ` : ''}
              {new Date(entry.changed_at).toLocaleString()}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
