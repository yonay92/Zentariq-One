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
import type { Site } from '@/types/sites';

// Split out from app/(app)/sites/[id]/regulatory/page.tsx — same reasoning
// as StudyRegulatoryPageContent (Next.js's route-type checking forbids
// extra named exports from a page.tsx file, and use()/Suspense makes the
// default export awkward to render directly in a test).
export function SiteRegulatoryPageContent({ siteId }: { siteId: string }) {
  const [site, setSite] = useState<Site | null>(null);
  const [documents, setDocuments] = useState<RegulatoryDocumentWithType[]>([]);
  const [health, setHealth] = useState<RegulatoryHealthScore | null>(null);
  const [requirements, setRequirements] = useState<RegulatoryDocumentRequirement[]>([]);
  const [documentTypes, setDocumentTypes] = useState<DocumentType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requirementsError, setRequirementsError] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);

  // Each of the four fetches is handled independently via Promise.allSettled.
  // An unrelated fetch failing (e.g. the binder summary) must never suppress
  // an otherwise-successful requirements refetch, and a section whose own
  // fetch fails keeps its last valid data instead of being reset to empty —
  // same fix as the study regulatory page's fetchAll().
  const fetchAll = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true);
    setError(null);
    setRequirementsError(null);

    const [siteResult, binderResult, requirementsResult, typesResult] = await Promise.allSettled([
      fetch(`/api/sites/${siteId}`),
      fetch(`/api/sites/${siteId}/regulatory`),
      fetch(`/api/regulatory/requirements?site_id=${siteId}`),
      fetch('/api/regulatory/document-types'),
    ]);

    if (siteResult.status === 'fulfilled' && siteResult.value.ok) {
      try {
        const json = (await siteResult.value.json()) as { data: Site };
        setSite(json.data);
      } catch {
        // Non-critical section — keep whatever site data was last shown.
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
  }, [siteId]);

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
        description={site ? site.name : 'Site regulatory binder'}
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
          scope={{ siteId }}
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
