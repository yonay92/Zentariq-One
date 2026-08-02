'use client';

import { useState, useEffect, useCallback, useRef, use } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { LeadContactInfoSection } from '@/components/recruitment/LeadContactInfoSection';
import { LeadActionsPanel } from '@/components/recruitment/LeadActionsPanel';
import { LeadPrescreeningSection } from '@/components/recruitment/LeadPrescreeningSection';
import { LeadNotesSection } from '@/components/recruitment/LeadNotesSection';
import { LeadCallsSection } from '@/components/recruitment/LeadCallsSection';
import { LeadTasksSection } from '@/components/recruitment/LeadTasksSection';
import { LEAD_STATUS_VARIANT } from '@/components/recruitment/leadStatusVariant';
import type { Lead } from '@/types/recruitment';
import type { Study } from '@/types/studies';
import type { Site } from '@/types/sites';

export default function LeadProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id: leadId } = use(params);
  const [lead, setLead] = useState<Lead | null>(null);
  const [studyName, setStudyName] = useState('—');
  const [siteName, setSiteName] = useState('Unassigned (pool)');
  const [loading, setLoading] = useState(true);
  // Only the *first* load shows the blocking full-page spinner. Every action
  // on this page (save contact info, log a contact, submit a prescreening,
  // convert) refreshes the lead afterward via this same function — without
  // this guard, each of those would flip `loading` back to true, unmounting
  // the entire subtree (including whichever section just successfully saved)
  // behind a spinner and forcing it to refetch its own state from scratch.
  const hasLoadedRef = useRef(false);

  const fetchLead = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true);
    try {
      const res = await fetch(`/api/leads/${leadId}`);
      if (!res.ok) {
        setLead(null);
        return;
      }
      const json = (await res.json()) as { data: Lead };
      const leadData = json.data;
      setLead(leadData);

      const [studiesRes, sitesRes] = await Promise.all([
        fetch('/api/studies'),
        fetch('/api/sites'),
      ]);
      if (leadData.study_id && studiesRes.ok) {
        const studies = ((await studiesRes.json()) as { data: Study[] }).data;
        setStudyName(studies.find((s) => s.id === leadData.study_id)?.study_name ?? '—');
      }
      if (leadData.site_id && sitesRes.ok) {
        const sites = ((await sitesRes.json()) as { data: Site[] }).data;
        setSiteName(sites.find((s) => s.id === leadData.site_id)?.name ?? '—');
      } else {
        setSiteName('Unassigned (pool)');
      }
    } finally {
      setLoading(false);
      hasLoadedRef.current = true;
    }
  }, [leadId]);

  useEffect(() => {
    void fetchLead();
  }, [fetchLead]);

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (!lead) {
    return <EmptyState title="Lead not found" description="It may have been removed" />;
  }

  return (
    <div>
      <PageHeader
        title={lead.initials ?? 'Lead'}
        description={`${studyName} · ${siteName}`}
        action={
          <Badge variant={LEAD_STATUS_VARIANT[lead.status]}>{lead.status.replace(/_/g, ' ')}</Badge>
        }
      />

      {lead.status === 'converted' && lead.converted_subject_id && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">
          Converted to Subject.{' '}
          <a
            href={`/subjects/${lead.converted_subject_id}`}
            className="font-medium hover:underline"
          >
            View Subject profile
          </a>
        </div>
      )}
      {lead.status === 'declined' && lead.declined_reason && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          Declined: {lead.declined_reason}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <LeadContactInfoSection leadId={lead.id} onSaved={() => void fetchLead()} />
          <LeadActionsPanel lead={lead} onChanged={() => void fetchLead()} />
        </div>
        <div className="space-y-4">
          <LeadPrescreeningSection
            leadId={lead.id}
            defaultStudyId={lead.study_id}
            onChanged={() => void fetchLead()}
          />
          <LeadTasksSection lead={lead} />
          <LeadCallsSection lead={lead} />
          <LeadNotesSection leadId={lead.id} />
        </div>
      </div>
    </div>
  );
}
