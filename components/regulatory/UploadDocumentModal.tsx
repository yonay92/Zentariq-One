'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import type {
  DocumentType,
  DuplicateChecksumWarning,
  RegulatoryDocument,
} from '@/types/regulatory';

type UploadDocumentModalProps = {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  documentTypes: DocumentType[];
  // 'document' posts to /api/regulatory/documents(/[id]/replace) with
  // document_name + study_id/site_id scope. 'staff-credential' posts to
  // /api/staff-credentials(/[id]/replace) with user_id instead — staff
  // credentials have no document_name field at all (see StaffDocument in
  // types/regulatory.ts).
  target: 'document' | 'staff-credential';
  scope: {
    studyId?: string | undefined;
    siteId?: string | undefined;
    staffUserId?: string | undefined;
  };
  mode: { kind: 'create' } | { kind: 'replace'; documentId: string; currentDocumentName: string };
};

type ApiEnvelope<T> = {
  success: boolean;
  data?: T;
  error?: { message: string; details?: unknown };
};

export function UploadDocumentModal({
  open,
  onClose,
  onSaved,
  documentTypes,
  target,
  scope,
  mode,
}: UploadDocumentModalProps) {
  const [documentTypeId, setDocumentTypeId] = useState('');
  const [documentName, setDocumentName] = useState(
    mode.kind === 'replace' ? mode.currentDocumentName : '',
  );
  const [effectiveDate, setEffectiveDate] = useState('');
  const [expirationDate, setExpirationDate] = useState('');
  const [replacementReason, setReplacementReason] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState<DuplicateChecksumWarning | null>(null);

  const selectedType = documentTypes.find((t) => t.id === documentTypeId);
  const expirationRequired = selectedType?.has_expiration ?? false;

  function reset() {
    setDocumentTypeId('');
    setDocumentName(mode.kind === 'replace' ? mode.currentDocumentName : '');
    setEffectiveDate('');
    setExpirationDate('');
    setReplacementReason('');
    setFile(null);
    setError(null);
    setDuplicateWarning(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function submit(confirmDuplicate: boolean) {
    if (!file) {
      setError('A file is required.');
      return;
    }
    if (mode.kind === 'create' && !documentTypeId) {
      setError('A document type is required.');
      return;
    }
    if (mode.kind === 'create' && target === 'document' && !documentName.trim()) {
      setError('A document name is required.');
      return;
    }
    if (mode.kind === 'replace' && !replacementReason.trim()) {
      setError('A reason is required when replacing a document version.');
      return;
    }
    if (expirationRequired && !expirationDate) {
      setError('This document type requires an expiration date.');
      return;
    }

    setBusy(true);
    setError(null);

    const formData = new FormData();
    formData.append('file', file);
    if (effectiveDate) formData.append('effective_date', effectiveDate);
    if (expirationDate) formData.append('expiration_date', expirationDate);

    const basePath = target === 'document' ? 'regulatory/documents' : 'staff-credentials';
    let url: string;
    if (mode.kind === 'create') {
      formData.append('document_type_id', documentTypeId);
      if (target === 'document') {
        formData.append('document_name', documentName.trim());
        if (scope.studyId) formData.append('study_id', scope.studyId);
        if (scope.siteId) formData.append('site_id', scope.siteId);
      } else {
        if (scope.staffUserId) formData.append('user_id', scope.staffUserId);
        if (scope.siteId) formData.append('site_id', scope.siteId);
      }
      url = `/api/${basePath}`;
    } else {
      formData.append('replacement_reason', replacementReason.trim());
      formData.append('confirm_duplicate', confirmDuplicate ? 'true' : 'false');
      url = `/api/${basePath}/${mode.documentId}/replace`;
    }

    try {
      const res = await fetch(url, { method: 'POST', body: formData });
      const json = (await res.json()) as ApiEnvelope<RegulatoryDocument>;

      if (res.status === 409 && json.error?.details) {
        setDuplicateWarning(json.error.details as DuplicateChecksumWarning);
        return;
      }
      if (!res.ok || !json.success) {
        setError(json.error?.message ?? 'Failed to upload document');
        return;
      }

      handleClose();
      onSaved();
    } catch {
      setError('An unexpected error occurred');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={mode.kind === 'create' ? 'Upload Document' : 'Replace Document Version'}
    >
      {duplicateWarning ? (
        <div className="space-y-4">
          <p className="text-sm text-gray-700">
            A file with identical content was already uploaded as{' '}
            <span className="font-medium">{duplicateWarning.matching_version.version}</span> on{' '}
            {new Date(duplicateWarning.matching_version.uploaded_at).toLocaleDateString()}. Upload
            it again anyway?
          </p>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => setDuplicateWarning(null)}>
              Cancel
            </Button>
            <Button loading={busy} disabled={busy} onClick={() => void submit(true)}>
              Upload Anyway
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {mode.kind === 'create' && (
            <>
              <Select
                label="Document Type"
                value={documentTypeId}
                onChange={(e) => setDocumentTypeId(e.target.value)}
                placeholder="Select a document type"
                options={documentTypes.map((t) => ({ value: t.id, label: t.name }))}
              />
              {target === 'document' && (
                <Input
                  label="Document Name"
                  value={documentName}
                  onChange={(e) => setDocumentName(e.target.value)}
                  placeholder="e.g. Site 4 — Lab Certification"
                />
              )}
            </>
          )}

          <div className="space-y-1">
            <label
              htmlFor="regulatory-doc-file"
              className="block text-sm font-medium text-slate-700"
            >
              File
            </label>
            <input
              id="regulatory-doc-file"
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-lg file:border-0 file:bg-blue-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-blue-700 hover:file:bg-blue-100"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Effective Date (optional)"
              type="date"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
            />
            <Input
              label={`Expiration Date${expirationRequired ? '' : ' (optional)'}`}
              type="date"
              value={expirationDate}
              onChange={(e) => setExpirationDate(e.target.value)}
            />
          </div>

          {mode.kind === 'replace' && (
            <div className="space-y-1">
              <label
                htmlFor="regulatory-replace-reason"
                className="block text-sm font-medium text-slate-700"
              >
                Reason for replacement
              </label>
              <textarea
                id="regulatory-replace-reason"
                className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                rows={3}
                value={replacementReason}
                onChange={(e) => setReplacementReason(e.target.value)}
              />
            </div>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button loading={busy} disabled={busy} onClick={() => void submit(false)}>
              {mode.kind === 'create' ? 'Upload' : 'Replace'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
