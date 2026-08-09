'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Select';
import { AlertBanner } from '@/components/ui/AlertBanner';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table, type Column } from '@/components/ui/Table';
import { RecruitmentViewTabs } from '@/components/recruitment/RecruitmentViewTabs';
import { LeadBulkActionsBar } from '@/components/recruitment/LeadBulkActionsBar';
import { LEAD_STATUS_VARIANT } from '@/components/recruitment/leadStatusVariant';
import { useRecruitmentFilters } from '@/hooks/useRecruitmentFilters';
import { usePermissions } from '@/hooks/usePermissions';
import type {
  LeadListItem,
  LeadStatus,
  LeadPriority,
  LeadSortField,
  ReferralSource,
} from '@/types/recruitment';
import type { Study } from '@/types/studies';
import type { Site } from '@/types/sites';
import type { Profile } from '@/types/users';

const STATUS_OPTIONS: Array<{ value: LeadStatus; label: string }> = (
  Object.keys(LEAD_STATUS_VARIANT) as LeadStatus[]
).map((status) => ({ value: status, label: status.replace(/_/g, ' ') }));

const PRIORITY_OPTIONS: Array<{ value: LeadPriority; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

const ALL_COLUMNS = [
  { key: 'lead', label: 'Lead name' },
  { key: 'study', label: 'Study' },
  { key: 'site', label: 'Site' },
  { key: 'status', label: 'Status' },
  { key: 'priority', label: 'Priority' },
  { key: 'source', label: 'Source' },
  { key: 'assigned', label: 'Assigned user' },
  { key: 'last_contacted', label: 'Last contacted' },
  { key: 'next_follow_up', label: 'Next follow-up' },
  { key: 'open_tasks', label: 'Open tasks' },
  { key: 'duplicate', label: 'Duplicate warning' },
  { key: 'created', label: 'Created date' },
] as const;

type ColumnKey = (typeof ALL_COLUMNS)[number]['key'];
const DEFAULT_VISIBLE_COLUMNS: ColumnKey[] = ALL_COLUMNS.map((c) => c.key);
const COLUMN_STORAGE_KEY = 'recruitment-table-visible-columns';

const FILTER_KEYS = [
  'status',
  'site_id',
  'study_id',
  'referral_source_id',
  'priority',
  'assigned_user_id',
  'include_archived',
  'search',
  'has_overdue_tasks',
  'has_duplicate_warning',
  'next_follow_up_from',
  'next_follow_up_to',
  'created_from',
  'created_to',
  'page',
  'page_size',
  'sort_by',
  'sort_dir',
];

function SortableHeader({
  label,
  field,
  sortBy,
  sortDir,
  onSort,
}: {
  label: string;
  field: LeadSortField;
  sortBy: string;
  sortDir: string;
  onSort: (field: LeadSortField) => void;
}) {
  const isActive = sortBy === field;
  return (
    <button
      type="button"
      className="flex items-center gap-1 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      onClick={() => onSort(field)}
    >
      {label}
      {isActive && <span aria-hidden="true">{sortDir === 'asc' ? '▲' : '▼'}</span>}
      <span className="sr-only">
        {isActive ? `sorted ${sortDir === 'asc' ? 'ascending' : 'descending'}` : 'not sorted'}
      </span>
    </button>
  );
}

function RecruitmentTableContent() {
  const { get, setMany, clearAll } = useRecruitmentFilters();
  const { hasPermission } = usePermissions();
  const canViewPhi = hasPermission('view_lead_phi');

  const [leads, setLeads] = useState<LeadListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [studies, setStudies] = useState<Study[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [referralSources, setReferralSources] = useState<ReferralSource[]>([]);
  const [users, setUsers] = useState<Profile[]>([]);

  const [searchInput, setSearchInput] = useState(get('search'));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [visibleColumns, setVisibleColumns] = useState<ColumnKey[]>(DEFAULT_VISIBLE_COLUMNS);
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);

  const page = Number(get('page')) || 1;
  const pageSize = Number(get('page_size')) || 25;
  const sortBy = (get('sort_by') || 'created_at') as LeadSortField;
  const sortDir = get('sort_dir') || 'desc';
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  useEffect(() => {
    void (async () => {
      const [studiesRes, sitesRes, sourcesRes, usersRes] = await Promise.all([
        fetch('/api/studies'),
        fetch('/api/sites'),
        fetch('/api/referral-sources'),
        fetch('/api/users'),
      ]);
      if (studiesRes.ok) setStudies(((await studiesRes.json()) as { data: Study[] }).data);
      if (sitesRes.ok) setSites(((await sitesRes.json()) as { data: Site[] }).data);
      if (sourcesRes.ok) {
        setReferralSources(((await sourcesRes.json()) as { data: ReferralSource[] }).data);
      }
      if (usersRes.ok) setUsers(((await usersRes.json()) as { data: Profile[] }).data);
    })();
  }, []);

  useEffect(() => {
    const stored = window.localStorage.getItem(COLUMN_STORAGE_KEY);
    if (!stored) return;
    try {
      const parsed = JSON.parse(stored) as string[];
      setVisibleColumns(ALL_COLUMNS.map((c) => c.key).filter((k) => parsed.includes(k)));
    } catch {
      // ignore malformed stored preference — DEFAULT_VISIBLE_COLUMNS already set
    }
  }, []);

  function toggleColumn(key: ColumnKey) {
    setVisibleColumns((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      window.localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }

  // Debounced — only pushes to the URL (and triggers a refetch) 300ms after
  // the user stops typing, not on every keystroke.
  useEffect(() => {
    const handle = setTimeout(() => {
      if (searchInput !== get('search')) setMany({ search: searchInput || null });
    }, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      for (const key of FILTER_KEYS) {
        const value = get(key);
        if (value) params.set(key, value);
      }
      const res = await fetch(`/api/leads?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to load leads');
      const json = (await res.json()) as {
        data: { data: LeadListItem[]; total: number };
      };
      setLeads(json.data.data);
      setTotal(json.data.total);
      setSelected(new Set());
    } catch {
      setError('Failed to load leads. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [get]);

  useEffect(() => {
    void fetchLeads();
  }, [fetchLeads]);

  function handleSort(field: LeadSortField) {
    const nextDir = sortBy === field && sortDir === 'asc' ? 'desc' : 'asc';
    setMany({ sort_by: field, sort_dir: nextDir });
  }

  function toggleSelect(leadId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(leadId)) next.delete(leadId);
      else next.add(leadId);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) =>
      prev.size === leads.length ? new Set() : new Set(leads.map((l) => l.id)),
    );
  }

  const studyName = (id: string | null) => studies.find((s) => s.id === id)?.study_name ?? '—';
  const siteName = (id: string | null) =>
    id ? (sites.find((s) => s.id === id)?.name ?? '—') : 'Unassigned (pool)';
  const sourceName = (id: string | null) =>
    id ? (referralSources.find((s) => s.id === id)?.name ?? '—') : '—';
  const userName = (id: string | null) =>
    id ? (users.find((u) => u.id === id)?.full_name ?? '—') : 'Unassigned';

  const columnDefs: Record<ColumnKey, Column<LeadListItem>> = {
    lead: {
      key: 'lead',
      header: (
        <span className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={leads.length > 0 && selected.size === leads.length}
            onChange={toggleSelectAll}
            aria-label="Select all leads on this page"
          />
          Lead
        </span>
      ),
      render: (lead) => (
        <span className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={selected.has(lead.id)}
            onChange={() => toggleSelect(lead.id)}
            aria-label={`Select ${lead.initials ?? 'lead'}`}
          />
          <Link
            href={`/recruitment/${lead.id}`}
            className="font-medium text-gray-900 hover:underline"
          >
            {lead.initials ?? 'New lead'}
          </Link>
        </span>
      ),
    },
    study: { key: 'study', header: 'Study', render: (l) => studyName(l.study_id) },
    site: { key: 'site', header: 'Site', render: (l) => siteName(l.site_id) },
    status: {
      key: 'status',
      header: (
        <SortableHeader
          label="Status"
          field="status"
          sortBy={sortBy}
          sortDir={sortDir}
          onSort={handleSort}
        />
      ),
      render: (l) => (
        <Badge variant={LEAD_STATUS_VARIANT[l.status]}>{l.status.replace(/_/g, ' ')}</Badge>
      ),
    },
    priority: {
      key: 'priority',
      header: (
        <SortableHeader
          label="Priority"
          field="priority"
          sortBy={sortBy}
          sortDir={sortDir}
          onSort={handleSort}
        />
      ),
      render: (l) => <span className="capitalize">{l.priority}</span>,
    },
    source: { key: 'source', header: 'Source', render: (l) => sourceName(l.referral_source_id) },
    assigned: {
      key: 'assigned',
      header: 'Assigned user',
      render: (l) => userName(l.assigned_user_id),
    },
    last_contacted: {
      key: 'last_contacted',
      header: (
        <SortableHeader
          label="Last contacted"
          field="last_contacted_at"
          sortBy={sortBy}
          sortDir={sortDir}
          onSort={handleSort}
        />
      ),
      render: (l) =>
        l.last_contacted_at ? new Date(l.last_contacted_at).toLocaleDateString() : '—',
    },
    next_follow_up: {
      key: 'next_follow_up',
      header: (
        <SortableHeader
          label="Next follow-up"
          field="next_contact_at"
          sortBy={sortBy}
          sortDir={sortDir}
          onSort={handleSort}
        />
      ),
      render: (l) => {
        if (!l.next_contact_at) return '—';
        const overdue = new Date(l.next_contact_at).getTime() < Date.now();
        return (
          <span className={overdue ? 'font-medium text-red-600' : ''}>
            {new Date(l.next_contact_at).toLocaleDateString()}
            {overdue ? ' (overdue)' : ''}
          </span>
        );
      },
    },
    open_tasks: {
      key: 'open_tasks',
      header: 'Open tasks',
      render: (l) => (
        <span className={l.has_overdue_task ? 'font-medium text-red-600' : ''}>
          {l.open_task_count}
          {l.has_overdue_task ? ' ⚠' : ''}
        </span>
      ),
    },
    duplicate: {
      key: 'duplicate',
      header: 'Duplicate warning',
      render: (l) =>
        l.has_duplicate_warning ? (
          <span className="font-medium text-yellow-700">⚠ Possible duplicate</span>
        ) : (
          ''
        ),
    },
    created: {
      key: 'created',
      header: (
        <SortableHeader
          label="Created"
          field="created_at"
          sortBy={sortBy}
          sortDir={sortDir}
          onSort={handleSort}
        />
      ),
      render: (l) => new Date(l.created_at).toLocaleDateString(),
    },
  };

  const columns: Array<Column<LeadListItem>> = [
    ...ALL_COLUMNS.filter((c) => visibleColumns.includes(c.key)).map((c) => columnDefs[c.key]),
    {
      key: 'actions',
      header: 'Actions',
      render: (l) => (
        <Link href={`/recruitment/${l.id}`}>
          <Button variant="outline" size="sm">
            View
          </Button>
        </Link>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Recruitment"
        description="Track prospective participants from first contact through eligibility triage"
        action={
          <Link href="/recruitment/new">
            <Button>New Lead</Button>
          </Link>
        }
      />

      <RecruitmentViewTabs />

      <div className="mb-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by initials"
            aria-label="Search leads by initials"
            className="block h-9 w-full max-w-xs rounded-lg border border-slate-300 px-3 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
          />
          <div className="relative ml-auto">
            <Button size="sm" variant="outline" onClick={() => setColumnsMenuOpen((v) => !v)}>
              Columns
            </Button>
            {columnsMenuOpen && (
              <div className="absolute right-0 z-10 mt-1 w-56 rounded-lg border border-gray-200 bg-white p-3 shadow-lg">
                {ALL_COLUMNS.map((c) => (
                  <label key={c.key} className="flex items-center gap-2 py-1 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={visibleColumns.includes(c.key)}
                      onChange={() => toggleColumn(c.key)}
                    />
                    {c.label}
                  </label>
                ))}
              </div>
            )}
          </div>
          <Button size="sm" variant="ghost" onClick={clearAll}>
            Reset Filters
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
          <Select
            value={get('status')}
            onChange={(e) => setMany({ status: e.target.value })}
            placeholder="All statuses"
            options={STATUS_OPTIONS}
          />
          <Select
            value={get('site_id')}
            onChange={(e) => setMany({ site_id: e.target.value })}
            placeholder="All sites (incl. pool)"
            options={sites.map((s) => ({ value: s.id, label: s.name }))}
          />
          <Select
            value={get('study_id')}
            onChange={(e) => setMany({ study_id: e.target.value })}
            placeholder="All studies"
            options={studies.map((s) => ({ value: s.id, label: s.study_name }))}
          />
          <Select
            value={get('priority')}
            onChange={(e) => setMany({ priority: e.target.value })}
            placeholder="All priorities"
            options={PRIORITY_OPTIONS}
          />
          <Select
            value={get('referral_source_id')}
            onChange={(e) => setMany({ referral_source_id: e.target.value })}
            placeholder="All sources"
            options={referralSources.map((s) => ({ value: s.id, label: s.name }))}
          />
          <Select
            value={get('assigned_user_id')}
            onChange={(e) => setMany({ assigned_user_id: e.target.value })}
            placeholder="All owners"
            options={users.map((u) => ({ value: u.id, label: u.full_name }))}
          />
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="space-y-1">
            <label htmlFor="created-from" className="block text-xs font-medium text-slate-600">
              Created from
            </label>
            <input
              id="created-from"
              type="date"
              value={get('created_from').slice(0, 10)}
              onChange={(e) =>
                setMany({
                  created_from: e.target.value ? new Date(e.target.value).toISOString() : null,
                })
              }
              className="block h-9 w-full rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="created-to" className="block text-xs font-medium text-slate-600">
              Created to
            </label>
            <input
              id="created-to"
              type="date"
              value={get('created_to').slice(0, 10)}
              onChange={(e) =>
                setMany({
                  created_to: e.target.value ? new Date(e.target.value).toISOString() : null,
                })
              }
              className="block h-9 w-full rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="follow-up-from" className="block text-xs font-medium text-slate-600">
              Next follow-up from
            </label>
            <input
              id="follow-up-from"
              type="date"
              value={get('next_follow_up_from').slice(0, 10)}
              onChange={(e) =>
                setMany({
                  next_follow_up_from: e.target.value
                    ? new Date(e.target.value).toISOString()
                    : null,
                })
              }
              className="block h-9 w-full rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="follow-up-to" className="block text-xs font-medium text-slate-600">
              Next follow-up to
            </label>
            <input
              id="follow-up-to"
              type="date"
              value={get('next_follow_up_to').slice(0, 10)}
              onChange={(e) =>
                setMany({
                  next_follow_up_to: e.target.value ? new Date(e.target.value).toISOString() : null,
                })
              }
              className="block h-9 w-full rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-sm text-gray-600">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={get('has_overdue_tasks') === 'true'}
              onChange={(e) => setMany({ has_overdue_tasks: e.target.checked ? 'true' : null })}
            />
            Has overdue tasks
          </label>
          {canViewPhi && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={get('has_duplicate_warning') === 'true'}
                onChange={(e) =>
                  setMany({ has_duplicate_warning: e.target.checked ? 'true' : null })
                }
              />
              Has duplicate warning
            </label>
          )}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={get('include_archived') === 'true'}
              onChange={(e) => setMany({ include_archived: e.target.checked ? 'true' : null })}
            />
            Include archived
          </label>
        </div>
      </div>

      <LeadBulkActionsBar
        selectedIds={Array.from(selected)}
        onClear={() => setSelected(new Set())}
        onApplied={() => void fetchLeads()}
      />

      {error && (
        <div className="mb-4">
          <AlertBanner variant="error" message={error} onDismiss={() => setError(null)} />
        </div>
      )}

      {loading ? (
        <div
          className="overflow-hidden rounded-xl border border-gray-200 bg-white"
          aria-busy="true"
          aria-live="polite"
        >
          <div className="space-y-3 p-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-6 animate-pulse rounded bg-gray-100" />
            ))}
          </div>
          <span className="sr-only">Loading leads…</span>
        </div>
      ) : leads.length === 0 ? (
        <EmptyState
          title="No leads match these filters"
          description="Try adjusting or resetting your filters, or add a new lead"
          action={
            <Link href="/recruitment/new">
              <Button>New Lead</Button>
            </Link>
          }
        />
      ) : (
        <>
          <Table columns={columns} data={leads} rowKey={(l) => l.id} />
          <div className="flex items-center justify-between border-t border-gray-200 bg-white px-4 py-3 text-sm text-gray-600">
            <p aria-live="polite">
              {total === 0
                ? '0 leads'
                : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`}
            </p>
            <div className="flex items-center gap-3">
              <Select
                value={String(pageSize)}
                onChange={(e) => setMany({ page_size: e.target.value })}
                options={PAGE_SIZE_OPTIONS.map((n) => ({ value: String(n), label: `${n} / page` }))}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={page <= 1}
                onClick={() => setMany({ page: String(page - 1) }, { resetPage: false })}
              >
                Previous
              </Button>
              <span>
                Page {page} of {totalPages}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={page >= totalPages}
                onClick={() => setMany({ page: String(page + 1) }, { resetPage: false })}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function RecruitmentPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-48 items-center justify-center">
          <LoadingSpinner size="lg" />
        </div>
      }
    >
      <RecruitmentTableContent />
    </Suspense>
  );
}
