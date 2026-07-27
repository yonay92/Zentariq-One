'use client';

import { useState, useEffect, useCallback, use } from 'react';
import Link from 'next/link';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';
import { ComingSoon } from '@/components/ui/ComingSoon';
import { StudyProfileHeader } from '@/components/studies/StudyProfileHeader';
import { StudySitesTab } from '@/components/studies/StudySitesTab';
import { ProtocolUploader } from '@/components/studies/ProtocolUploader';
import { AIReviewPanel } from '@/components/studies/AIReviewPanel';
import { StudyRegulatoryPageContent } from '@/components/regulatory/StudyRegulatoryPageContent';
import type { Study } from '@/types/studies';

const TABS = [
  'Overview',
  'Sites',
  'Visit Templates',
  'Prescreening',
  'Documents',
  'AI Review',
  'Subjects',
  'Regulatory',
  'Analytics',
  'Timeline',
] as const;

type Tab = (typeof TABS)[number];

export default function StudyProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id: studyId } = use(params);
  const [study, setStudy] = useState<Study | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('Overview');

  const fetchStudy = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/studies/${studyId}`);
      if (!res.ok) {
        setStudy(null);
        return;
      }
      const json = (await res.json()) as { data: Study };
      setStudy(json.data);
    } finally {
      setLoading(false);
    }
  }, [studyId]);

  useEffect(() => {
    void fetchStudy();
  }, [fetchStudy]);

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (!study) {
    return <EmptyState title="Study not found" description="It may have been removed" />;
  }

  return (
    <div>
      <StudyProfileHeader
        study={study}
        onChanged={() => void fetchStudy()}
        onNavigateTab={(t) => setTab(t as Tab)}
      />

      <div className="mb-6 flex gap-1 border-b border-gray-200">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium ${
              tab === t
                ? 'border-b-2 border-blue-600 text-blue-600'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Overview' && (
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold text-gray-900">Study Details</h3>
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-gray-500">Protocol number</dt>
                <dd className="text-gray-900">{study.protocol_number ?? '—'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Sponsor</dt>
                <dd className="text-gray-900">{study.sponsor ?? '—'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">CRO</dt>
                <dd className="text-gray-900">{study.cro ?? '—'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Phase</dt>
                <dd className="text-gray-900">{study.phase ?? '—'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Therapeutic area</dt>
                <dd className="text-gray-900">{study.therapeutic_area ?? '—'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Protocol version</dt>
                <dd className="text-gray-900">{study.protocol_version ?? '—'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Indication</dt>
                <dd className="text-gray-900">{study.indication ?? '—'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Estimated enrollment</dt>
                <dd className="text-gray-900">{study.estimated_enrollment ?? '—'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Study duration</dt>
                <dd className="text-gray-900">{study.study_duration ?? '—'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Study design</dt>
                <dd className="text-gray-900">{study.study_design ?? '—'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Primary endpoint</dt>
                <dd className="text-gray-900">{study.primary_endpoint ?? '—'}</dd>
              </div>
            </dl>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <h3 className="mb-2 text-sm font-semibold text-gray-900">Visit Templates</h3>
            <p className="mb-3 text-sm text-gray-500">
              Build and approve the visit schedule before this study can be activated.
            </p>
            <Link href={`/studies/${study.id}/visit-templates`}>
              <Button variant="outline" size="sm">
                Manage Visit Templates
              </Button>
            </Link>
          </div>
        </div>
      )}

      {tab === 'Sites' && <StudySitesTab studyId={study.id} />}

      {tab === 'Visit Templates' && (
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="mb-3 text-sm text-gray-500">
            Open the full Visit Template Builder to add, remove, and reorder visits.
          </p>
          <Link href={`/studies/${study.id}/visit-templates`}>
            <Button size="sm">Open Visit Template Builder</Button>
          </Link>
        </div>
      )}

      {tab === 'Prescreening' && (
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="mb-3 text-sm text-gray-500">
            Configure this study&apos;s eligibility triage questionnaire, used by Recruitment when
            prescreening leads.
          </p>
          <Link href={`/studies/${study.id}/prescreening-questions`}>
            <Button size="sm">Manage Prescreening Questions</Button>
          </Link>
        </div>
      )}

      {tab === 'Documents' && (
        <div className="max-w-xl">
          <p className="mb-4 text-sm text-gray-500">
            Upload a new or amended protocol. Amendments on an active study automatically create a
            new visit template version and notify Regulatory and CRC staff.
          </p>
          <ProtocolUploader studyId={study.id} onUploaded={() => void fetchStudy()} />
        </div>
      )}

      {tab === 'AI Review' && <AIReviewPanel studyId={study.id} />}

      {tab === 'Subjects' && <ComingSoon module="Subjects" />}
      {tab === 'Regulatory' && <StudyRegulatoryPageContent studyId={study.id} />}
      {tab === 'Analytics' && <ComingSoon module="Analytics" />}
      {tab === 'Timeline' && <ComingSoon module="Timeline" />}
    </div>
  );
}
