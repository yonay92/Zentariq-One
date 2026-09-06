'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { AlertBanner } from '@/components/ui/AlertBanner';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table, type Column } from '@/components/ui/Table';
import { ChartStatusBadge, ChartPriorityBadge } from '@/components/charts/ChartStatusBadge';
import { useChartFilters } from '@/hooks/useChartFilters';
import type { ChartQueueItem, ChartQueueResult, ChartStatus, ChartPriority } from '@/types/charts';
import type { Study } from '@/types/studies';
import type { Site } from '@/types/sites';

const STATUS_OPTIONS: Array<{ value: ChartStatus; label: string }> = [
  { value: 'chart_ready', label: 'Chart Ready' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'entered_in_edc', label: 'Entered in EDC' },
  { value: 'on_hold', label: 'On Hold' },
];

const PRIORITY_OPTIONS: Array<{ value: ChartPriority; label: string }> = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

const PAGE_SIZE = 25;

function ChartQueueContent() {
  const { get, setMany } = useChartFilters();
  const [studies, setStudies] = useState<Study[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [result, setResult] = useState<ChartQueueResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const siteFilter = get('site_id');
  const studyFilter = get('study_id');
  const statusFilter = get('status');
  const priorityFilter = get('priority');
  const page = Number(get('page')) || 1;

  useEffect(() => {
    void (async () => {
      const [studiesRes, sitesRes] = await Promise.all([
        fetch('/api/studies'),
        fetch('/api/sites'),
      ]);
      if (studiesRes.ok) setStudies(((await studiesRes.json()) as { data: Study[] }).data);
      if (sitesRes.ok) setSites(((await sitesRes.json()) as { data: Site[] }).data);
    })();
  }, []);

  const fetchCharts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (siteFilter) params.set('site_id', siteFilter);
      if (studyFilter) params.set('study_id', studyFilter);
      if (statusFilter) params.set('status', statusFilter);
      if (priorityFilter) params.set('priority', priorityFilter);
      params.set('page', String(page));
      params.set('page_size', String(PAGE_SIZE));

      const res = await fetch(`/api/charts?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to load charts');
      const json = (await res.json()) as { data: ChartQueueResult };
      setResult(json.data);
    } catch {
      setError('Failed to load the chart queue. Please refresh.');
    } finally {
      setLoading(false);
    }
  }, [siteFilter, studyFilter, statusFilter, priorityFilter, page]);

  useEffect(() => {
    void fetchCharts();
  }, [fetchCharts]);

  const items = result?.data ?? [];
  const totalPages = result ? Math.max(1, Math.ceil(result.total / result.page_size)) : 1;

  // docs/UI_UX_09_Charts.md: the queue is grouped by Site within the fixed
  // priority-order sort ChartService.listCharts already applies — grouping
  // is presentational only, scoped to the current page of results.
  const groups = new Map<string, ChartQueueItem[]>();
  for (const item of items) {
    const key = item.site_name;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  const columns: Column<ChartQueueItem>[] = [
    {
      key: 'subject',
      header: 'Subject',
      render: (row) => (
        <Link
          href={`/subjects/${row.subject_id}`}
          className="font-medium text-blue-600 hover:underline"
        >
          {row.subject_number}
        </Link>
      ),
    },
    { key: 'visit', header: 'Visit', render: (row) => row.visit_name },
    { key: 'study', header: 'Study', render: (row) => row.study_name },
    {
      key: 'days_pending',
      header: 'Days Pending',
      render: (row) =>
        row.days_since_ready === null ? (
          '—'
        ) : (
          <span>
            {row.days_since_ready} {row.is_out_of_window ? '(Out of Window)' : ''}
          </span>
        ),
    },
    {
      key: 'priority',
      header: 'Priority',
      render: (row) => <ChartPriorityBadge priority={row.effective_priority} />,
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <ChartStatusBadge status={row.status} />,
    },
    {
      key: 'actions',
      header: '',
      render: (row) => (
        <Link href={`/charts/${row.id}`}>
          <Button variant="outline" size="sm">
            Open Chart
          </Button>
        </Link>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="Chart Queue" description="Charts awaiting or in Data Entry" />

      <div className="mb-4 grid grid-cols-4 gap-3">
        <Select
          value={siteFilter}
          onChange={(e) => setMany({ site_id: e.target.value || null })}
          label="Site"
          placeholder="All sites"
          options={sites.map((s) => ({ value: s.id, label: s.name }))}
        />
        <Select
          value={studyFilter}
          onChange={(e) => setMany({ study_id: e.target.value || null })}
          label="Study"
          placeholder="All studies"
          options={studies.map((s) => ({ value: s.id, label: s.study_name }))}
        />
        <Select
          value={statusFilter}
          onChange={(e) => setMany({ status: e.target.value || null })}
          label="Status"
          placeholder="All statuses"
          options={STATUS_OPTIONS}
        />
        <Select
          value={priorityFilter}
          onChange={(e) => setMany({ priority: e.target.value || null })}
          label="Priority"
          placeholder="All priorities"
          options={PRIORITY_OPTIONS}
        />
      </div>

      {error && (
        <div className="mb-4">
          <AlertBanner variant="error" message={error} onDismiss={() => setError(null)} />
        </div>
      )}

      {loading ? (
        <div className="flex h-48 items-center justify-center">
          <LoadingSpinner size="lg" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title="No charts match these filters"
          description="Charts are created automatically when a Visit is completed."
        />
      ) : (
        <div className="space-y-6">
          {[...groups.entries()].map(([siteName, groupItems]) => (
            <div key={siteName}>
              <h3 className="mb-2 text-sm font-semibold text-gray-900">{siteName}</h3>
              <Table columns={columns} data={groupItems} rowKey={(row) => row.id} />
            </div>
          ))}
        </div>
      )}

      {result && totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-gray-600">
          <span>
            Page {result.page} of {totalPages} ({result.total} chart{result.total === 1 ? '' : 's'})
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setMany({ page: String(page - 1) }, { resetPage: false })}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setMany({ page: String(page + 1) }, { resetPage: false })}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ChartQueuePage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-48 items-center justify-center">
          <LoadingSpinner size="lg" />
        </div>
      }
    >
      <ChartQueueContent />
    </Suspense>
  );
}
