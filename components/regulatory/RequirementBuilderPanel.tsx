'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import type { DocumentType, RegulatoryDocumentRequirement } from '@/types/regulatory';

type RequirementBuilderPanelProps = {
  open: boolean;
  onClose: () => void;
  // Awaited before busy/creating state clears — the checkbox must not
  // re-enable until the parent's refetch has actually landed new data,
  // otherwise it briefly shows stale (unchecked) state while interactive.
  onChanged: () => Promise<void>;
  scope: { studyId?: string | undefined; siteId?: string | undefined };
  documentTypes: DocumentType[];
  requirements: RegulatoryDocumentRequirement[];
  loading: boolean;
};

type ApiEnvelope<T> = { success: boolean; data?: T; error?: { message: string } };

// Only requirements scoped exactly to this study/site are shown and toggled
// here — company-wide requirements (both study_id and site_id null) cascade
// in automatically but aren't editable from a single study/site's builder.
export function RequirementBuilderPanel({
  open,
  onClose,
  onChanged,
  scope,
  documentTypes,
  requirements,
  loading,
}: RequirementBuilderPanelProps) {
  const [busyTypeId, setBusyTypeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [newTypeName, setNewTypeName] = useState('');
  const [newTypeCategory, setNewTypeCategory] = useState('');
  const [newTypeHasExpiration, setNewTypeHasExpiration] = useState(false);
  const [creatingType, setCreatingType] = useState(false);

  function requirementFor(documentTypeId: string): RegulatoryDocumentRequirement | undefined {
    return requirements.find(
      (r) =>
        r.document_type_id === documentTypeId &&
        (r.study_id ?? undefined) === scope.studyId &&
        (r.site_id ?? undefined) === scope.siteId,
    );
  }

  async function toggleRequired(documentTypeId: string, nextRequired: boolean) {
    setBusyTypeId(documentTypeId);
    setError(null);
    try {
      const existing = requirementFor(documentTypeId);
      const res = existing
        ? await fetch(`/api/regulatory/requirements/${existing.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ required: nextRequired }),
          })
        : await fetch('/api/regulatory/requirements', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              document_type_id: documentTypeId,
              ...(scope.studyId ? { study_id: scope.studyId } : {}),
              ...(scope.siteId ? { site_id: scope.siteId } : {}),
              required: nextRequired,
            }),
          });
      const json = (await res.json()) as ApiEnvelope<unknown>;
      if (!res.ok || !json.success) {
        setError(json.error?.message ?? 'Failed to update requirement');
        return;
      }
      // Awaited deliberately — the checkbox stays disabled until the new
      // requirement is actually reflected in the refetched `requirements`
      // prop, not just until the write itself completes.
      await onChanged();
    } finally {
      setBusyTypeId(null);
    }
  }

  async function toggleExpirationRequired(documentTypeId: string, nextValue: boolean) {
    const existing = requirementFor(documentTypeId);
    if (!existing) return;
    setBusyTypeId(documentTypeId);
    setError(null);
    try {
      const res = await fetch(`/api/regulatory/requirements/${existing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiration_required: nextValue }),
      });
      const json = (await res.json()) as ApiEnvelope<unknown>;
      if (!res.ok || !json.success) {
        setError(json.error?.message ?? 'Failed to update requirement');
        return;
      }
      await onChanged();
    } finally {
      setBusyTypeId(null);
    }
  }

  async function handleCreateType() {
    if (!newTypeName.trim()) {
      setError('A document type name is required.');
      return;
    }
    setCreatingType(true);
    setError(null);
    try {
      const res = await fetch('/api/regulatory/document-types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newTypeName.trim(),
          category: newTypeCategory.trim() || undefined,
          has_expiration: newTypeHasExpiration,
        }),
      });
      const json = (await res.json()) as ApiEnvelope<DocumentType>;
      if (!res.ok || !json.success) {
        setError(json.error?.message ?? 'Failed to create document type');
        return;
      }
      setNewTypeName('');
      setNewTypeCategory('');
      setNewTypeHasExpiration(false);
      await onChanged();
    } finally {
      setCreatingType(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Document Requirements" size="lg">
      {loading ? (
        <div className="flex h-32 items-center justify-center">
          <LoadingSpinner />
        </div>
      ) : (
        <div className="space-y-4">
          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="max-h-80 overflow-y-auto rounded-lg border border-gray-200">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200 bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-gray-600">Document Type</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-600">Category</th>
                  <th className="px-3 py-2 text-center font-medium text-gray-600">Required</th>
                  <th className="px-3 py-2 text-center font-medium text-gray-600">
                    Requires Expiration Tracking
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {documentTypes.map((type) => {
                  const requirement = requirementFor(type.id);
                  const busy = busyTypeId === type.id;
                  const inputId = `requirement-${type.id}`;
                  const expirationInputId = `requirement-expiration-${type.id}`;
                  return (
                    <tr key={type.id}>
                      <td className="px-3 py-2 text-gray-900">{type.name}</td>
                      <td className="px-3 py-2 text-gray-500">{type.category ?? 'Other'}</td>
                      <td className="px-3 py-2 text-center">
                        <label htmlFor={inputId} className="sr-only">
                          Required for {type.name}
                        </label>
                        <input
                          id={inputId}
                          type="checkbox"
                          disabled={busy}
                          checked={requirement?.required ?? false}
                          onChange={(e) => void toggleRequired(type.id, e.target.checked)}
                        />
                      </td>
                      <td className="px-3 py-2 text-center">
                        <label htmlFor={expirationInputId} className="sr-only">
                          Requires expiration tracking for {type.name}
                        </label>
                        <input
                          id={expirationInputId}
                          type="checkbox"
                          disabled={busy || !requirement?.required}
                          checked={requirement?.expiration_required ?? false}
                          onChange={(e) => void toggleExpirationRequired(type.id, e.target.checked)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="rounded-lg border border-gray-200 p-3">
            <h4 className="mb-2 text-sm font-semibold text-gray-900">New Document Type</h4>
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Name"
                value={newTypeName}
                onChange={(e) => setNewTypeName(e.target.value)}
              />
              <Input
                label="Category (free text)"
                value={newTypeCategory}
                onChange={(e) => setNewTypeCategory(e.target.value)}
                placeholder="e.g. Essential Documents"
              />
            </div>
            <label className="mt-2 flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={newTypeHasExpiration}
                onChange={(e) => setNewTypeHasExpiration(e.target.checked)}
              />
              Has an expiration date
            </label>
            <div className="mt-3 flex justify-end">
              <Button
                size="sm"
                loading={creatingType}
                disabled={creatingType}
                onClick={() => void handleCreateType()}
              >
                Add Document Type
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
