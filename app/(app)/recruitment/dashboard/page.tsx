'use client';

import { useState, useEffect } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import type { RecruitmentDashboard, LeadStatus } from '@/types/recruitment';

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

export default function RecruitmentDashboardPage() {
  const [dashboard, setDashboard] = useState<RecruitmentDashboard | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/recruitment/dashboard');
        if (res.ok) {
          const json = (await res.json()) as { data: RecruitmentDashboard };
          setDashboard(json.data);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div>
      <PageHeader
        title="Recruitment Dashboard"
        description="Funnel counts, conversion rate, and referral source performance"
      />

      {loading ? (
        <div className="flex h-48 items-center justify-center">
          <LoadingSpinner size="lg" />
        </div>
      ) : !dashboard || dashboard.total_leads === 0 ? (
        <EmptyState title="No leads yet" description="Data will appear here once leads are added" />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="text-xs font-medium tracking-wide text-gray-500 uppercase">
                Total Leads
              </p>
              <p className="mt-1 text-2xl font-bold text-gray-900">{dashboard.total_leads}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="text-xs font-medium tracking-wide text-gray-500 uppercase">
                Conversion Rate
              </p>
              <p className="mt-1 text-2xl font-bold text-gray-900">
                {(dashboard.conversion_rate * 100).toFixed(1)}%
              </p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="text-xs font-medium tracking-wide text-gray-500 uppercase">Converted</p>
              <p className="mt-1 text-2xl font-bold text-green-600">{dashboard.funnel.converted}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="text-xs font-medium tracking-wide text-gray-500 uppercase">
                In Prescreening
              </p>
              <p className="mt-1 text-2xl font-bold text-blue-600">
                {dashboard.funnel.prescreening}
              </p>
            </div>
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
        </div>
      )}
    </div>
  );
}
