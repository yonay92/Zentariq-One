'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { usePermissions } from '@/hooks/usePermissions';
import { HealthScoreBreakdown } from '@/components/regulatory/HealthScoreBreakdown';
import { DocumentStatusBadge } from '@/components/regulatory/statusBadge';
import { UploadDocumentModal } from '@/components/regulatory/UploadDocumentModal';
import { ReviewDocumentModal } from '@/components/regulatory/ReviewDocumentModal';
import { ArchiveDocumentModal } from '@/components/regulatory/ArchiveDocumentModal';
import { DocumentHistoryDrawer } from '@/components/regulatory/DocumentHistoryDrawer';
import { RequirementBuilderPanel } from '@/components/regulatory/RequirementBuilderPanel';
import type {
  RegulatoryDocumentWithType,
  RegulatoryDocumentRequirement,
  DocumentType,
  RegulatoryHealthScore,
} from '@/types/regulatory';

type RegulatoryBinderProps = {
  scope: { studyId?: string | undefined; siteId?: string | undefined };
  documents: RegulatoryDocumentWithType[];
  requirements: RegulatoryDocumentRequirement[];
  documentTypes: DocumentType[];
  health: RegulatoryHealthScore;
  // Promise-returning so RequirementBuilderPanel can await the refetch
  // before re-enabling its checkboxes — a () => Promise<void> is still
  // assignable to the other modals' () => void onSaved/onDecided/onArchived
  // props below, which don't need to await it.
  onChanged: () => Promise<void>;
};

export function RegulatoryBinder({
  scope,
  documents,
  requirements,
  documentTypes,
  health,
  onChanged,
}: RegulatoryBinderProps) {
  const { hasPermission } = usePermissions();
  const canUpload = hasPermission('upload_regulatory_document');
  const canReview = hasPermission('edit_regulatory_document');
  const canArchive = hasPermission('archive_regulatory_document');
  const canViewAudit = hasPermission('view_regulatory_audit');
  const canManageRequirements = hasPermission('manage_regulatory_requirements');

  const [uploadTarget, setUploadTarget] = useState<
    { kind: 'create' } | { kind: 'replace'; documentId: string; currentDocumentName: string } | null
  >(null);
  const [reviewTarget, setReviewTarget] = useState<{ id: string; name: string } | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<{ id: string; name: string } | null>(null);
  const [historyTarget, setHistoryTarget] = useState<{ id: string; name: string } | null>(null);
  const [requirementBuilderOpen, setRequirementBuilderOpen] = useState(false);

  const sections = new Map<string, RegulatoryDocumentWithType[]>();
  for (const doc of documents) {
    const category = doc.document_type.category ?? 'Other';
    const list = sections.get(category) ?? [];
    list.push(doc);
    sections.set(category, list);
  }

  const relevantRequirements = requirements.filter(
    (r) =>
      r.required &&
      (r.study_id ?? undefined) === scope.studyId &&
      (r.site_id ?? undefined) === scope.siteId,
  );
  const missing = relevantRequirements.filter(
    (r) => !documents.some((d) => d.document_type_id === r.document_type_id),
  );
  const missingTypes = missing
    .map((r) => documentTypes.find((t) => t.id === r.document_type_id))
    .filter((t): t is DocumentType => Boolean(t));

  return (
    <div className="space-y-6">
      <HealthScoreBreakdown health={health} />

      <div className="flex flex-wrap gap-2">
        {canUpload && (
          <Button size="sm" onClick={() => setUploadTarget({ kind: 'create' })}>
            Upload Document
          </Button>
        )}
        {canManageRequirements && (
          <Button size="sm" variant="outline" onClick={() => setRequirementBuilderOpen(true)}>
            Manage Requirements
          </Button>
        )}
      </div>

      {missingTypes.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4">
          <h3 className="mb-2 text-sm font-semibold text-red-900">
            Missing Documents ({missingTypes.length})
          </h3>
          <ul className="space-y-1">
            {missingTypes.map((type) => (
              <li key={type.id} className="text-sm text-red-800">
                {type.name}
              </li>
            ))}
          </ul>
        </div>
      )}

      {documents.length === 0 && missingTypes.length === 0 ? (
        <EmptyState
          title="No regulatory documents yet"
          description={
            canManageRequirements
              ? 'Configure which document types are required for this scope to get started using the Manage Requirements button above.'
              : 'No documents have been uploaded for this scope yet.'
          }
        />
      ) : (
        Array.from(sections.entries()).map(([category, docs]) => (
          <div
            key={category}
            className="overflow-hidden rounded-xl border border-gray-200 bg-white"
          >
            <div className="border-b border-gray-200 bg-gray-50 px-4 py-2">
              <h3 className="text-sm font-semibold text-gray-700">{category}</h3>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                  <th className="px-4 py-2 font-medium">Document</th>
                  <th className="px-4 py-2 font-medium">Version</th>
                  <th className="px-4 py-2 font-medium">Expiration</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {docs.map((doc) => (
                  <tr key={doc.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{doc.document_name}</td>
                    <td className="px-4 py-3 text-gray-600">{doc.version ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-600">{doc.expiration_date ?? '—'}</td>
                    <td className="px-4 py-3">
                      <DocumentStatusBadge status={doc.status} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        {canUpload && doc.status !== 'archived' && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setUploadTarget({
                                kind: 'replace',
                                documentId: doc.id,
                                currentDocumentName: doc.document_name,
                              })
                            }
                          >
                            Replace
                          </Button>
                        )}
                        {canReview && doc.status === 'pending_review' && (
                          <Button
                            size="sm"
                            onClick={() => setReviewTarget({ id: doc.id, name: doc.document_name })}
                          >
                            Review
                          </Button>
                        )}
                        {canArchive && doc.status !== 'archived' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setArchiveTarget({ id: doc.id, name: doc.document_name })
                            }
                          >
                            Archive
                          </Button>
                        )}
                        {canViewAudit && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setHistoryTarget({ id: doc.id, name: doc.document_name })
                            }
                          >
                            History
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Staff Documents</h3>
            <p className="text-sm text-gray-500">
              Staff credentials (CVs, GCP training, licenses) are managed centrally and reused
              across every study or site a staff member is assigned to.
            </p>
          </div>
          <Link href="/settings/staff-credentials">
            <Button size="sm" variant="outline">
              View Staff Credentials
            </Button>
          </Link>
        </div>
      </div>

      {uploadTarget && (
        <UploadDocumentModal
          open={true}
          onClose={() => setUploadTarget(null)}
          onSaved={onChanged}
          documentTypes={documentTypes}
          target="document"
          scope={scope}
          mode={uploadTarget}
        />
      )}
      {reviewTarget && (
        <ReviewDocumentModal
          open={true}
          onClose={() => setReviewTarget(null)}
          onDecided={onChanged}
          documentId={reviewTarget.id}
          documentName={reviewTarget.name}
        />
      )}
      {archiveTarget && (
        <ArchiveDocumentModal
          open={true}
          onClose={() => setArchiveTarget(null)}
          onArchived={onChanged}
          documentId={archiveTarget.id}
          documentName={archiveTarget.name}
          basePath="regulatory/documents"
        />
      )}
      {historyTarget && (
        <DocumentHistoryDrawer
          open={true}
          onClose={() => setHistoryTarget(null)}
          documentId={historyTarget.id}
          documentName={historyTarget.name}
          basePath="regulatory/documents"
        />
      )}
      <RequirementBuilderPanel
        open={requirementBuilderOpen}
        onClose={() => setRequirementBuilderOpen(false)}
        onChanged={onChanged}
        scope={scope}
        documentTypes={documentTypes}
        requirements={requirements}
        loading={false}
      />
    </div>
  );
}
