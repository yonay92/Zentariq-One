'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { AlertBanner } from '@/components/ui/AlertBanner';
import { EmptyState } from '@/components/ui/EmptyState';
import { HealthScoreBreakdown } from '@/components/regulatory/HealthScoreBreakdown';
import type { RegulatoryHealthScore, DocumentType } from '@/types/regulatory';
import type { Study } from '@/types/studies';
import type { Site } from '@/types/sites';

export default function RegulatoryDashboardPage() {
  const [health, setHealth] = useState<RegulatoryHealthScore | null>(null);
  const [studies, setStudies] = useState<Study[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [documentTypes, setDocumentTypes] = useState<DocumentType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [healthRes, studiesRes, sitesRes, typesRes] = await Promise.all([
        fetch('/api/regulatory/health-score?scope=company'),
        fetch('/api/studies'),
        fetch('/api/sites'),
        fetch('/api/regulatory/document-types'),
      ]);

      if (!healthRes.ok) throw new Error('Failed to load the regulatory health score');
      const healthJson = (await healthRes.json()) as { data: RegulatoryHealthScore };
      setHealth(healthJson.data);

      if (studiesRes.ok) setStudies(((await studiesRes.json()) as { data: Study[] }).data);
      if (sitesRes.ok) setSites(((await sitesRes.json()) as { data: Site[] }).data);
      if (typesRes.ok) setDocumentTypes(((await typesRes.json()) as { data: DocumentType[] }).data);
    } catch {
      setError('Failed to load the regulatory dashboard. Please refresh.');
    } finally {
      setLoading(false);
    }
  }, []);

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
        title="Regulatory"
        description="Company-wide regulatory compliance across studies and sites"
      />

      {error && (
        <div className="mb-4">
          <AlertBanner variant="error" message={error} onDismiss={() => setError(null)} />
        </div>
      )}

      {documentTypes.length === 0 ? (
        <EmptyState
          title="No document types configured yet"
          description="Set up document types and requirements from a study or site's regulatory binder to get started."
        />
      ) : (
        <>
          {health && <div className="mb-6">{<HealthScoreBreakdown health={health} />}</div>}

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div>
              <h2 className="mb-3 text-sm font-semibold text-gray-900">Studies</h2>
              {studies.length === 0 ? (
                <EmptyState title="No studies yet" />
              ) : (
                <div className="space-y-2">
                  {studies.map((study) => (
                    <Link
                      key={study.id}
                      href={`/studies/${study.id}/regulatory`}
                      className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm hover:bg-gray-50"
                    >
                      <span className="font-medium text-gray-900">{study.study_name}</span>
                      <Button size="sm" variant="outline">
                        View Binder
                      </Button>
                    </Link>
                  ))}
                </div>
              )}
            </div>

            <div>
              <h2 className="mb-3 text-sm font-semibold text-gray-900">Sites</h2>
              {sites.length === 0 ? (
                <EmptyState title="No sites yet" />
              ) : (
                <div className="space-y-2">
                  {sites.map((site) => (
                    <Link
                      key={site.id}
                      href={`/sites/${site.id}/regulatory`}
                      className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm hover:bg-gray-50"
                    >
                      <span className="font-medium text-gray-900">{site.name}</span>
                      <Button size="sm" variant="outline">
                        View Binder
                      </Button>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
