'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Select';
import { AlertBanner } from '@/components/ui/AlertBanner';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { LEAD_STATUS_VARIANT } from '@/components/recruitment/leadStatusVariant';
import type { Lead, LeadStatus, LeadPriority, ReferralSource } from '@/types/recruitment';
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

export default function RecruitmentPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [studies, setStudies] = useState<Study[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [referralSources, setReferralSources] = useState<ReferralSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [users, setUsers] = useState<Profile[]>([]);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [siteFilter, setSiteFilter] = useState('');
  const [studyFilter, setStudyFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [assignedFilter, setAssignedFilter] = useState('');

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

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (siteFilter) params.set('site_id', siteFilter);
      if (studyFilter) params.set('study_id', studyFilter);
      if (priorityFilter) params.set('priority', priorityFilter);
      if (sourceFilter) params.set('referral_source_id', sourceFilter);
      if (assignedFilter) params.set('assigned_user_id', assignedFilter);

      const res = await fetch(`/api/leads?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to load leads');
      const json = (await res.json()) as { data: Lead[] };
      setLeads(json.data);
    } catch {
      setError('Failed to load leads. Please refresh.');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, siteFilter, studyFilter, priorityFilter, sourceFilter, assignedFilter]);

  useEffect(() => {
    void fetchLeads();
  }, [fetchLeads]);

  const studyName = (studyId: string | null) =>
    studies.find((s) => s.id === studyId)?.study_name ?? '—';
  const siteName = (siteId: string | null) =>
    siteId ? (sites.find((s) => s.id === siteId)?.name ?? '—') : 'Unassigned (pool)';
  const sourceName = (sourceId: string | null) =>
    sourceId ? (referralSources.find((s) => s.id === sourceId)?.name ?? '—') : '—';
  const assignedName = (userId: string | null) =>
    userId ? (users.find((u) => u.id === userId)?.full_name ?? '—') : 'Unassigned';

  // Client-side only, matched against initials (never PHI — initials are the
  // only identifying value ever present on the pipeline row itself).
  const visibleLeads = search.trim()
    ? leads.filter((l) => l.initials?.toLowerCase().includes(search.trim().toLowerCase()))
    : leads;

  return (
    <div>
      <PageHeader
        title="Recruitment"
        description="Track prospective participants from first contact through eligibility triage"
        action={
          <div className="flex gap-2">
            <Link href="/recruitment/dashboard">
              <Button variant="outline">Dashboard</Button>
            </Link>
            <Link href="/recruitment/new">
              <Button>New Lead</Button>
            </Link>
          </div>
        }
      />

      <div className="mb-4 space-y-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by initials"
          className="block h-9 w-full max-w-xs rounded-lg border border-slate-300 px-3 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
        />
        <div className="grid grid-cols-3 gap-3 lg:grid-cols-6">
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            placeholder="All statuses"
            options={STATUS_OPTIONS}
          />
          <Select
            value={siteFilter}
            onChange={(e) => setSiteFilter(e.target.value)}
            placeholder="All sites (incl. pool)"
            options={sites.map((s) => ({ value: s.id, label: s.name }))}
          />
          <Select
            value={studyFilter}
            onChange={(e) => setStudyFilter(e.target.value)}
            placeholder="All studies"
            options={studies.map((s) => ({ value: s.id, label: s.study_name }))}
          />
          <Select
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value)}
            placeholder="All priorities"
            options={PRIORITY_OPTIONS}
          />
          <Select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            placeholder="All sources"
            options={referralSources.map((s) => ({ value: s.id, label: s.name }))}
          />
          <Select
            value={assignedFilter}
            onChange={(e) => setAssignedFilter(e.target.value)}
            placeholder="All owners"
            options={users.map((u) => ({ value: u.id, label: u.full_name }))}
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
      ) : visibleLeads.length === 0 ? (
        <EmptyState
          title="No leads yet"
          description="Add your first lead to start the recruitment pipeline"
          action={
            <Link href="/recruitment/new">
              <Button>New Lead</Button>
            </Link>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Lead</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Study</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Site</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Referral Source</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Status</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Priority</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Owner</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Contact Attempts</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visibleLeads.map((lead) => (
                <tr key={lead.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">
                    <Link href={`/recruitment/${lead.id}`} className="hover:underline">
                      {lead.initials ?? 'New lead'}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{studyName(lead.study_id)}</td>
                  <td className="px-4 py-3 text-gray-600">{siteName(lead.site_id)}</td>
                  <td className="px-4 py-3 text-gray-600">{sourceName(lead.referral_source_id)}</td>
                  <td className="px-4 py-3">
                    <Badge variant={LEAD_STATUS_VARIANT[lead.status]}>
                      {lead.status.replace(/_/g, ' ')}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-gray-600 capitalize">{lead.priority}</td>
                  <td className="px-4 py-3 text-gray-600">{assignedName(lead.assigned_user_id)}</td>
                  <td className="px-4 py-3 text-gray-600">{lead.contact_attempt_count}</td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/recruitment/${lead.id}`}>
                      <Button variant="outline" size="sm">
                        View
                      </Button>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
