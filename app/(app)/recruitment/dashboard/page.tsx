'use client';

import { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { AlertBanner } from '@/components/ui/AlertBanner';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { RecruitmentViewTabs } from '@/components/recruitment/RecruitmentViewTabs';
import { MyFollowUpsPanel } from '@/components/recruitment/MyFollowUpsPanel';
import { TeamWorkloadPanel } from '@/components/recruitment/TeamWorkloadPanel';
import { useRecruitmentFilters } from '@/hooks/useRecruitmentFilters';
import type { RecruitmentDashboard, LeadStatus } from '@/types/recruitment';
import type { Study } from '@/types/studies';
import type { Site } from '@/types/sites';
import type { Profile } from '@/types/users';

const FUNNEL_ORDER: LeadStatus[] = [
  'new',
  'contacted',
  'prescreening',
  'waitlisted',
  'converted',
  'declined',
  'lost',
];

// Deliberately covers only the 7 core funnel stages listed in FUNNEL_ORDER
// above — the dashboard funnel chart is a simplified view (out of scope for
// this phase's full status vocabulary; see Sprint 7.1 plan), not a lookup
// for every possible lead.status value.
const FUNNEL_LABEL: Partial<Record<LeadStatus, string>> = {
  new: 'New',
  contacted: 'Contacted',
  prescreening: 'Prescreening',
  waitlisted: 'Waitlisted',
  converted: 'Converted',
  declined: 'Declined',
  lost: 'Lost',
};

function todayRangeIso(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
  return { from, to };
}

function MetricCard({
  label,
  value,
  href,
  tone = 'default',
}: {
  label: string;
  value: string;
  href?: string;
  tone?: 'default' | 'warning' | 'success';
}) {
  const valueClass =
    tone === 'warning'
      ? 'text-orange-600'
      : tone === 'success'
        ? 'text-green-600'
        : 'text-gray-900';

  const content = (
    <div className="h-full rounded-xl border border-gray-200 bg-white p-4 transition-shadow hover:shadow-sm">
      <p className="text-xs font-medium tracking-wide text-gray-500 uppercase">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${valueClass}`}>{value}</p>
    </div>
  );

  return href ? (
    <Link href={href} className="block h-full">
      {content}
    </Link>
  ) : (
    content
  );
}

function RecruitmentDashboardContent() {
  const { get, setMany } = useRecruitmentFilters();

  const [dashboard, setDashboard] = useState<RecruitmentDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [sites, setSites] = useState<Site[]>([]);
  const [studies, setStudies] = useState<Study[]>([]);
  const [users, setUsers] = useState<Profile[]>([]);

  useEffect(() => {
    void (async () => {
      const [sitesRes, studiesRes, usersRes] = await Promise.all([
        fetch('/api/sites'),
        fetch('/api/studies'),
        fetch('/api/users'),
      ]);
      if (sitesRes.ok) setSites(((await sitesRes.json()) as { data: Site[] }).data);
      if (studiesRes.ok) setStudies(((await studiesRes.json()) as { data: Study[] }).data);
      if (usersRes.ok) setUsers(((await usersRes.json()) as { data: Profile[] }).data);
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        for (const key of ['site_id', 'study_id', 'assigned_user_id', 'date_from', 'date_to']) {
          const value = get(key);
          if (value) params.set(key, value);
        }
        const res = await fetch(`/api/recruitment/dashboard?${params.toString()}`);
        if (!res.ok) throw new Error('Failed to load dashboard');
        const json = (await res.json()) as { data: RecruitmentDashboard };
        setDashboard(json.data);
      } catch {
        setError('Failed to load the dashboard. Please try again.');
      } finally {
        setLoading(false);
      }
    })();
  }, [get]);

  // Base filters echoed into every card's Table deep link, so a manager
  // filtering the dashboard by site/study lands on the same scope in the
  // Table — filter state stays shared across views.
  const baseTableParams = new URLSearchParams();
  for (const key of ['site_id', 'study_id', 'assigned_user_id']) {
    const value = get(key);
    if (value) baseTableParams.set(key, value);
  }
  function tableLink(extra: Record<string, string>): string {
    const params = new URLSearchParams(baseTableParams);
    for (const [k, v] of Object.entries(extra)) params.set(k, v);
    return `/recruitment?${params.toString()}`;
  }

  const todayIso = todayRangeIso();

  return (
    <div>
      <PageHeader
        title="Recruitment Dashboard"
        description="Operational metrics, funnel counts, and referral source performance"
      />

      <RecruitmentViewTabs />

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
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
          value={get('assigned_user_id')}
          onChange={(e) => setMany({ assigned_user_id: e.target.value })}
          placeholder="All owners"
          options={users.map((u) => ({ value: u.id, label: u.full_name }))}
        />
        <div className="space-y-1">
          <label htmlFor="dash-date-from" className="block text-xs font-medium text-slate-600">
            From
          </label>
          <input
            id="dash-date-from"
            type="date"
            value={get('date_from')}
            onChange={(e) => setMany({ date_from: e.target.value || null })}
            className="block h-9 w-full rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="dash-date-to" className="block text-xs font-medium text-slate-600">
            To
          </label>
          <input
            id="dash-date-to"
            type="date"
            value={get('date_to')}
            onChange={(e) => setMany({ date_to: e.target.value || null })}
            className="block h-9 w-full rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
          />
        </div>
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
      ) : !dashboard || dashboard.total_leads === 0 ? (
        <EmptyState
          title="No leads yet"
          description="Data will appear here once leads are added"
          action={
            <Link href="/recruitment/new">
              <Button>New Lead</Button>
            </Link>
          }
        />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            <MetricCard
              label="New Leads"
              value={String(dashboard.metrics.new_leads)}
              href={tableLink({ status: 'new' })}
            />
            <MetricCard
              label="Follow-up Due Today"
              value={String(dashboard.metrics.follow_ups_due_today)}
              href={tableLink({
                next_follow_up_from: todayIso.from,
                next_follow_up_to: todayIso.to,
              })}
              tone="warning"
            />
            <MetricCard
              label="Overdue Follow-ups"
              value={String(dashboard.metrics.overdue_follow_ups)}
              href={tableLink({ next_follow_up_to: new Date().toISOString() })}
              tone="warning"
            />
            {/* Unassigned/High-priority aren't deep-linked — the Table's
                assigned_user_id/priority filters are single-value equality
                matches and can't express "is null" or "high or urgent"
                without a Table filter change, out of scope for this phase. */}
            <MetricCard
              label="Unassigned Leads"
              value={String(dashboard.metrics.unassigned_leads)}
            />
            <MetricCard
              label="High-priority Leads"
              value={String(dashboard.metrics.high_priority_leads)}
            />
            <MetricCard
              label="Prescreens Scheduled Today"
              value={String(dashboard.metrics.prescreens_scheduled_today)}
              href={tableLink({ status: 'prescreen_scheduled' })}
            />
            <MetricCard
              label="Screenings Scheduled"
              value={String(dashboard.metrics.screenings_scheduled)}
              href={tableLink({ status: 'screening_scheduled' })}
            />
            <MetricCard
              label="Qualified Leads"
              value={String(dashboard.metrics.qualified_leads)}
              href={tableLink({ status: 'qualified' })}
            />
            <MetricCard
              label="Converted This Month"
              value={String(dashboard.metrics.converted_this_month)}
              href={tableLink({ status: 'converted' })}
              tone="success"
            />
            <MetricCard
              label="Avg. New → Contacted"
              value={
                dashboard.metrics.avg_days_new_to_contacted !== null
                  ? `${dashboard.metrics.avg_days_new_to_contacted.toFixed(1)}d`
                  : '—'
              }
            />
            <MetricCard
              label="Avg. Qualified → Screening Scheduled"
              value={
                dashboard.metrics.avg_days_qualified_to_screening_scheduled !== null
                  ? `${dashboard.metrics.avg_days_qualified_to_screening_scheduled.toFixed(1)}d`
                  : '—'
              }
            />
            <MetricCard
              label="Conversion Rate"
              value={`${(dashboard.metrics.conversion_rate * 100).toFixed(1)}%`}
              tone="success"
            />
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <h3 className="mb-3 text-sm font-semibold text-gray-900">Funnel</h3>
            <div className="space-y-2">
              {FUNNEL_ORDER.map((status) => {
                const count = dashboard.funnel[status];
                const pct = dashboard.total_leads > 0 ? (count / dashboard.total_leads) * 100 : 0;
                return (
                  <div key={status} className="flex items-center gap-3">
                    <span className="w-28 text-sm text-gray-600">{FUNNEL_LABEL[status]}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
                      <div
                        className="h-full rounded-full bg-blue-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="w-10 text-right text-sm text-gray-900">{count}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <h3 className="mb-3 text-sm font-semibold text-gray-900">Referral Sources</h3>
            {dashboard.by_referral_source.length === 0 ? (
              <p className="text-sm text-gray-500">No referral source data yet.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {dashboard.by_referral_source.map((source) => (
                  <li
                    key={source.referral_source_id ?? 'none'}
                    className="flex justify-between border-t border-gray-100 py-1 first:border-t-0"
                  >
                    <span className="text-gray-700">{source.name}</span>
                    <span className="text-gray-900">{source.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <MyFollowUpsPanel siteId={get('site_id')} studyId={get('study_id')} />
            <TeamWorkloadPanel siteId={get('site_id')} studyId={get('study_id')} users={users} />
          </div>
        </div>
      )}
    </div>
  );
}

export default function RecruitmentDashboardPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-48 items-center justify-center">
          <LoadingSpinner size="lg" />
        </div>
      }
    >
      <RecruitmentDashboardContent />
    </Suspense>
  );
}
