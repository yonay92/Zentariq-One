'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import type { Study } from '@/types/studies';

export function ArchiveStudyModal({ study, onChanged }: { study: Study; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openModal() {
    setReason('');
    setError(null);
    setOpen(true);
  }

  async function handleArchive() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/studies/${study.id}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reason.trim() ? { reason: reason.trim() } : {}),
      });
      const json = (await res.json()) as {
        success: boolean;
        error?: { message?: string };
      };
      if (!res.ok || !json.success) {
        setError(json.error?.message ?? 'Failed to archive study');
        return;
      }
      setOpen(false);
      onChanged();
    } catch {
      setError('An unexpected error occurred');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={openModal}>
        Archive
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="Archive Study">
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Archive &ldquo;{study.study_name}&rdquo;? Archived studies are hidden from the default
            list and can only be found via the Archived/All filter.
          </p>
          <div className="space-y-1">
            <label htmlFor="archive-reason" className="block text-sm font-medium text-slate-700">
              Reason
            </label>
            <textarea
              id="archive-reason"
              className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Optional — required only if this study has enrolled subjects"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
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
    </>
  );
}
