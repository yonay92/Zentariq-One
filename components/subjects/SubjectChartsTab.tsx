'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';
import { ChartStatusBadge, ChartPriorityBadge } from '@/components/charts/ChartStatusBadge';
import type { ChartQueueItem, ChartQueueResult } from '@/types/charts';

// docs/UI_UX_07_Subjects.md's Subject Profile "Charts" tab. Calls the exact
// same GET /api/charts -> ChartService.listCharts contract as the main Chart
// Queue (filtered by subject_id) — one authorized read path, not a second,
// independent data-access implementation (Milestone 4.1 Phase A/B
// requirement).
export function SubjectChartsTab({ subjectId }: { subjectId: string }) {
  const [charts, setCharts] = useState<ChartQueueItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const res = await fetch(`/api/charts?subject_id=${subjectId}`);
      if (!cancelled && res.ok) {
        const json = (await res.json()) as { data: ChartQueueResult };
        setCharts(json.data.data);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [subjectId]);

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <LoadingSpinner />
      </div>
    );
  }

  if (charts.length === 0) {
    return (
      <EmptyState
        title="No charts yet"
        description="A chart is created automatically when a Visit is completed."
      />
    );
  }

  return (
    <div className="space-y-2">
      {charts.map((chart) => (
        <div
          key={chart.id}
          className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-4"
        >
          <div>
            <p className="text-sm font-medium text-gray-900">{chart.visit_name}</p>
            <p className="text-xs text-gray-500">
              {chart.visit_date ?? '—'} · {chart.study_name}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ChartPriorityBadge priority={chart.effective_priority} />
            <ChartStatusBadge status={chart.status} />
            <Link href={`/charts/${chart.id}`}>
              <Button variant="outline" size="sm">
                Open
              </Button>
            </Link>
          </div>
        </div>
      ))}
    </div>
  );
}
