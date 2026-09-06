'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { usePermissions } from '@/hooks/usePermissions';
import type { Chart } from '@/types/charts';

// Direct port of VisitReopener's pattern — only rendered for a caller
// holding reopen_chart (hidden, not disabled), required non-empty reason,
// disabled-while-busy, inline server error. reopen_chart is granted to no
// role by default (CompanyService.ADMIN_EXCLUDED_PERMISSIONS), so this is
// invisible to everyone until an Administrator deliberately grants it.
export function ChartReopenAction({ chart, onChanged }: { chart: Chart; onChanged: () => void }) {
  const { hasPermission } = usePermissions();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (chart.status !== 'entered_in_edc') return null;
  if (!hasPermission('reopen_chart')) return null;

  function openModal() {
    setReason('');
    setError(null);
    setOpen(true);
  }

  async function handleReopen() {
    if (!reason.trim()) {
      setError('A reason is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/charts/${chart.id}/reopen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const json = (await res.json()) as {
        success: boolean;
        message?: string;
        error?: { code: string; message: string };
      };
      if (!res.ok || !json.success) {
        setError(json.error?.message ?? json.message ?? 'Failed to reopen chart');
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
        Reopen
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="Reopen Chart">
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Reopening returns this chart to In Progress. This overrides the normal one-way EDC-entry
            lock and requires a reason for the audit trail.
          </p>
          <div className="space-y-1">
            <label
              htmlFor="chart-reopen-reason"
              className="block text-sm font-medium text-slate-700"
            >
              Reason
            </label>
            <textarea
              id="chart-reopen-reason"
              className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Required — why is this chart being reopened?"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Back
            </Button>
            <Button loading={busy} disabled={busy} onClick={() => void handleReopen()}>
              Reopen Chart
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
