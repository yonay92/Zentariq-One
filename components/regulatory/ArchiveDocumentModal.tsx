'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';

type ArchiveDocumentModalProps = {
  open: boolean;
  onClose: () => void;
  onArchived: () => void;
  documentId: string;
  documentName: string;
  basePath: 'regulatory/documents' | 'staff-credentials';
};

type ApiEnvelope = { success: boolean; error?: { message: string } };

export function ArchiveDocumentModal({
  open,
  onClose,
  onArchived,
  documentId,
  documentName,
  basePath,
}: ArchiveDocumentModalProps) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleClose() {
    setReason('');
    setError(null);
    onClose();
  }

  async function handleArchive() {
    if (!reason.trim()) {
      setError('A reason is required to archive a document.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/${basePath}/${documentId}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      const json = (await res.json()) as ApiEnvelope;
      if (!res.ok || !json.success) {
        setError(json.error?.message ?? 'Failed to archive document');
        return;
      }
      handleClose();
      onArchived();
    } catch {
      setError('An unexpected error occurred');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={handleClose} title={`Archive — ${documentName}`}>
      <div className="space-y-4">
        <p className="text-sm text-gray-500">
          Archiving does not delete any prior version — the full history remains accessible.
        </p>
        <div className="space-y-1">
          <label
            htmlFor="regulatory-archive-reason"
            className="block text-sm font-medium text-slate-700"
          >
            Reason
          </label>
          <textarea
            id="regulatory-archive-reason"
            className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={busy}
            onClick={() => void handleArchive()}
          >
            Archive
          </Button>
        </div>
      </div>
    </Modal>
  );
}
