'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { usePermissions } from '@/hooks/usePermissions';
import { ChartStatusBadge, ChartPriorityBadge } from '@/components/charts/ChartStatusBadge';
import { ChartHistoryList } from '@/components/charts/ChartHistoryList';
import { ChartCommentsSection } from '@/components/charts/ChartCommentsSection';
import { ChartStartEntryAction } from '@/components/charts/actions/ChartStartEntryAction';
import { ChartHoldAction } from '@/components/charts/actions/ChartHoldAction';
import { ChartReleaseAction } from '@/components/charts/actions/ChartReleaseAction';
import { ChartMarkEnteredAction } from '@/components/charts/actions/ChartMarkEnteredAction';
import { ChartReopenAction } from '@/components/charts/actions/ChartReopenAction';
import type { Chart } from '@/types/charts';
import type { Visit } from '@/types/subjects';

// Plain chartId prop (not a route Promise) — kept separate from the
// app/(app)/charts/[id]/page.tsx route component (which only unwraps
// use(params) and renders this) so it can be unit-tested directly, the
// same separation VisitDetailPanel already has from its route.
export function ChartDetailView({ chartId }: { chartId: string }) {
  const { hasPermission } = usePermissions();
  const [chart, setChart] = useState<Chart | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [subjectNumber, setSubjectNumber] = useState('—');
  const [studyName, setStudyName] = useState('—');
  const [siteName, setSiteName] = useState('—');
  const [visit, setVisit] = useState<Visit | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/charts/${chartId}`);
      if (!res.ok) {
        setNotFound(true);
        return;
      }
      const json = (await res.json()) as { data: Chart };
      const loadedChart = json.data;
      setChart(loadedChart);

      const [subjectRes, studyRes, siteRes, visitRes] = await Promise.all([
        fetch(`/api/subjects/${loadedChart.subject_id}`),
        fetch(`/api/studies/${loadedChart.study_id}`),
        fetch(`/api/sites/${loadedChart.site_id}`),
        fetch(`/api/visits/${loadedChart.visit_id}`),
      ]);
      if (subjectRes.ok) {
        const subjectJson = (await subjectRes.json()) as { data: { subject_number: string } };
        setSubjectNumber(subjectJson.data.subject_number);
      }
      if (studyRes.ok) {
        const studyJson = (await studyRes.json()) as { data: { study_name: string } };
        setStudyName(studyJson.data.study_name);
      }
      if (siteRes.ok) {
        const siteJson = (await siteRes.json()) as { data: { name: string } };
        setSiteName(siteJson.data.name);
      }
      if (visitRes.ok) {
        const visitJson = (await visitRes.json()) as { data: Visit };
        setVisit(visitJson.data);
      }
    } finally {
      setLoading(false);
    }
  }, [chartId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (notFound || !chart) {
    return (
      <EmptyState
        title="Chart not found"
        description="It may have been removed, or you may not have access to it."
      />
    );
  }

  const isLocked = chart.status === 'entered_in_edc';

  // Restates the same visibility union the five action components below
  // self-gate on, purely to decide whether to show a fallback message — does
  // not reimplement any action's API call or validation (same convention as
  // VisitDetailPanel.hasAnyAction).
  const hasAnyAction =
    ((chart.status === 'chart_ready' || chart.status === 'in_progress') &&
      hasPermission('mark_chart_ready')) ||
    (chart.status === 'on_hold' && hasPermission('mark_chart_ready')) ||
    (chart.status === 'in_progress' && hasPermission('mark_chart_entered')) ||
    (chart.status === 'entered_in_edc' && hasPermission('reopen_chart'));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Chart — {subjectNumber}</h1>
          <p className="mt-1 text-sm text-gray-500">{visit?.visit_name ?? 'Visit'}</p>
        </div>
        <div className="flex gap-2">
          <ChartStatusBadge status={chart.status} />
          <ChartPriorityBadge priority={chart.priority} />
        </div>
      </div>

      {isLocked && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">
          This chart is Entered in EDC and is locked. It cannot be edited unless authorized and
          reopened below.
        </div>
      )}

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-gray-500">Subject</dt>
            <dd className="mt-0.5">
              <Link
                href={`/subjects/${chart.subject_id}`}
                className="font-medium text-blue-600 hover:underline"
              >
                {subjectNumber}
              </Link>
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Study</dt>
            <dd className="mt-0.5 text-gray-900">{studyName}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Site</dt>
            <dd className="mt-0.5 text-gray-900">{siteName}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Visit</dt>
            <dd className="mt-0.5 text-gray-900">{visit?.visit_name ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Visit Date</dt>
            <dd className="mt-0.5 text-gray-900">
              {visit?.scheduled_date ?? visit?.target_date ?? '—'}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Chart Ready</dt>
            <dd className="mt-0.5 text-gray-900">
              {chart.chart_ready_date ? new Date(chart.chart_ready_date).toLocaleString() : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Entered in EDC</dt>
            <dd className="mt-0.5 text-gray-900">
              {chart.entered_in_edc_date
                ? new Date(chart.entered_in_edc_date).toLocaleString()
                : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Entered By Role</dt>
            <dd className="mt-0.5 text-gray-900">{chart.entered_by_role ?? '—'}</dd>
          </div>
        </dl>
      </div>

      <div className="flex flex-wrap items-start gap-2 border-t border-gray-100 pt-4">
        {hasAnyAction ? (
          <>
            <ChartStartEntryAction chart={chart} onChanged={() => void load()} />
            <ChartHoldAction chart={chart} onChanged={() => void load()} />
            <ChartReleaseAction chart={chart} onChanged={() => void load()} />
            <ChartMarkEnteredAction chart={chart} onChanged={() => void load()} />
            <ChartReopenAction chart={chart} onChanged={() => void load()} />
          </>
        ) : (
          <p className="text-sm text-gray-500">No actions available for this chart.</p>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-gray-900">History</h3>
        <ChartHistoryList chartId={chart.id} />
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-gray-900">Comments</h3>
        <ChartCommentsSection chartId={chart.id} />
      </div>
    </div>
  );
}
