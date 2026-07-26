'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { AlertBanner } from '@/components/ui/AlertBanner';
import { RegulatoryBinder } from '@/components/regulatory/RegulatoryBinder';
import type {
  RegulatoryDocumentWithType,
  RegulatoryDocumentRequirement,
  DocumentType,
  RegulatoryHealthScore,
} from '@/types/regulatory';
import type { Study } from '@/types/studies';

// Split out from app/(app)/studies/[id]/regulatory/page.tsx (which only
// unwraps the routed `params` promise and renders this) so it can be
// unit-tested directly with a plain `studyId` prop — Next.js's route-type
// checking also forbids extra named exports from a page.tsx file, so this
// couldn't live there even as a named export.
export function StudyRegulatoryPageContent({ studyId }: { studyId: string }) {
  const [study, setStudy] = useState<Study | null>(null);
  const [documents, setDocuments] = useState<RegulatoryDocumentWithType[]>([]);
  const [health, setHealth] = useState<RegulatoryHealthScore | null>(null);
  const [requirements, setRequirements] = useState<RegulatoryDocumentRequirement[]>([]);
  const [documentTypes, setDocumentTypes] = useState<DocumentType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requirementsError, setRequirementsError] = useState<string | null>(null);
  // Only the first load blocks with the full-page spinner — every action on
  // this page refreshes via this same function afterward, and re-triggering
  // the spinner on every refresh would unmount the whole subtree (including
  // whatever modal/section just successfully acted).
  const hasLoadedRef = useRef(false);

  // Each of the four fetches is handled independently via Promise.allSettled.
  // An unrelated fetch failing (e.g. the binder summary) must never suppress
  // an otherwise-successful requirements refetch — a prior bug threw out of
  // the whole function on a binder failure, skipping setRequirements()
  // entirely even when the requirements fetch itself had already succeeded.
  // A section whose own fetch fails keeps its last valid data instead of
  // being reset to empty.
  const fetchAll = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true);
    setError(null);
    setRequirementsError(null);

    const [studyResult, binderResult, requirementsResult, typesResult] = await Promise.allSettled([
      fetch(`/api/studies/${studyId}`),
      fetch(`/api/studies/${studyId}/regulatory`),
      fetch(`/api/regulatory/requirements?study_id=${studyId}`),
      fetch('/api/regulatory/document-types'),
    ]);

    if (studyResult.status === 'fulfilled' && studyResult.value.ok) {
      try {
        const json = (await studyResult.value.json()) as { data: Study };
        setStudy(json.data);
      } catch {
        // Non-critical section — keep whatever study data was last shown.
      }
    }

    if (binderResult.status === 'fulfilled' && binderResult.value.ok) {
      try {
        const binderJson = (await binderResult.value.json()) as {
          data: { documents: RegulatoryDocumentWithType[]; health: RegulatoryHealthScore };
        };
        setDocuments(binderJson.data.documents);
        setHealth(binderJson.data.health);
      } catch {
        setError('Failed to load the regulatory binder. Please refresh.');
      }
    } else {
      setError('Failed to load the regulatory binder. Please refresh.');
    }

    if (requirementsResult.status === 'fulfilled' && requirementsResult.value.ok) {
      try {
        const json = (await requirementsResult.value.json()) as {
          data: RegulatoryDocumentRequirement[];
        };
        setRequirements(json.data);
      } catch {
        setRequirementsError('Failed to load document requirements. Please try again.');
      }
    } else {
      setRequirementsError('Failed to load document requirements. Please try again.');
    }

    if (typesResult.status === 'fulfilled' && typesResult.value.ok) {
      try {
        const json = (await typesResult.value.json()) as { data: DocumentType[] };
        setDocumentTypes(json.data);
      } catch {
        // Non-critical section — keep whatever document types were last shown.
      }
    }

    setLoading(false);
    hasLoadedRef.current = true;
  }, [studyId]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Regulatory Binder"
        description={study ? study.study_name : 'Study eReg binder'}
      />
      {error && (
        <div className="mb-4">
          <AlertBanner variant="error" message={error} onDismiss={() => setError(null)} />
        </div>
      )}
      {requirementsError && (
        <div className="mb-4">
          <AlertBanner
            variant="error"
            message={requirementsError}
            onDismiss={() => setRequirementsError(null)}
          />
        </div>
      )}
      {health && (
        <RegulatoryBinder
          scope={{ studyId }}
          documents={documents}
          requirements={requirements}
          documentTypes={documentTypes}
          health={health}
          onChanged={fetchAll}
        />
      )}
    </div>
  );
}
