'use client';

import { useEffect, useState } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import type { ChartMetrics } from '@/types/charts';

function formatHours(hours: number | null): string {
  if (hours === null) return '—';
  return `${hours.toFixed(1)}h`;
}

// Milestone 4.3 — read-only projection of the single upserted chart_metrics
// row (ChartService.getMetrics). Renders nothing (not an error state) if no
// row exists yet — this is a derived/background value, not something the
// user needs to be alerted is "missing."
export function ChartMetricsPanel({ chartId }: { chartId: string }) {
  const [metrics, setMetrics] = useState<ChartMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const res = await fetch(`/api/charts/${chartId}/metrics`);
      if (!cancelled && res.ok) {
        const json = (await res.json()) as { data: ChartMetrics };
        setMetrics(json.data);
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

  if (!metrics) return null;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-gray-500">Ready to Entry</dt>
          <dd className="mt-0.5 text-gray-900">{formatHours(metrics.ready_to_entry_hours)}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Total Entry Time</dt>
          <dd className="mt-0.5 text-gray-900">{formatHours(metrics.total_entry_hours)}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Overdue Days</dt>
          <dd className="mt-0.5 text-gray-900">{metrics.overdue_days ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Out of Window</dt>
          <dd className="mt-0.5 text-gray-900">{metrics.out_of_window ? 'Yes' : 'No'}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Sponsor Priority</dt>
          <dd className="mt-0.5 text-gray-900">{metrics.sponsor_priority ? 'Yes' : 'No'}</dd>
        </div>
      </dl>
    </div>
  );
}
