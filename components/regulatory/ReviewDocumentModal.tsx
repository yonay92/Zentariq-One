'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';

// Staff credentials go straight to 'approved' on upload (no review gate —
// manage_staff_credentials is already a trusted permission) — this modal is
// only ever used for regulatory_documents, which do have the pending_review
// gate.
type ReviewDocumentModalProps = {
  open: boolean;
  onClose: () => void;
  onDecided: () => void;
  documentId: string;
  documentName: string;
};

type ApiEnvelope = { success: boolean; error?: { message: string } };

export function ReviewDocumentModal({
  open,
  onClose,
  onDecided,
  documentId,
  documentName,
}: ReviewDocumentModalProps) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleClose() {
    setReason('');
    setError(null);
    onClose();
  }

  async function decide(action: 'approve' | 'reject') {
    if (action === 'reject' && !reason.trim()) {
      setError('A reason is required to reject a document.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/regulatory/documents/${documentId}/${action}`, {
        method: 'POST',
        ...(action === 'reject'
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) }
          : {}),
      });
      const json = (await res.json()) as ApiEnvelope;
      if (!res.ok || !json.success) {
        setError(json.error?.message ?? `Failed to ${action} document`);
        return;
      }
      handleClose();
      onDecided();
    } catch {
      setError('An unexpected error occurred');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={handleClose} title={`Review — ${documentName}`}>
      <div className="space-y-4">
        <p className="text-sm text-gray-500">
          Approving marks this version current. Rejecting requires a reason and leaves the document
          without a valid current version until a new one is uploaded and approved.
        </p>
        <div className="space-y-1">
          <label
            htmlFor="regulatory-review-reason"
            className="block text-sm font-medium text-slate-700"
          >
            Rejection reason (required to reject)
          </label>
          <textarea
            id="regulatory-review-reason"
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
            onClick={() => void decide('reject')}
          >
            Reject
          </Button>
          <Button loading={busy} disabled={busy} onClick={() => void decide('approve')}>
            Approve
          </Button>
        </div>
      </div>
    </Modal>
  );
}
