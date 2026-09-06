'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { usePermissions } from '@/hooks/usePermissions';
import type { Chart } from '@/types/charts';

// entered_by_role (Milestone 4.0's MarkEnteredInEdcInput) is an existing,
// unmodified backend contract requiring the acting capacity as a string —
// BUSINESS_RULES_05 names exactly two roles who may perform this action
// ("authorized Data Entry (or approved CRC)"), so the choice is a fixed
// Select of those two rather than free text, avoiding a fabricated/typo-able
// audit field while still not inventing anything beyond what's documented.
const ROLE_OPTIONS = [
  { value: 'Data Entry', label: 'Data Entry' },
  { value: 'CRC', label: 'CRC' },
];

export function ChartMarkEnteredAction({
  chart,
  onChanged,
}: {
  chart: Chart;
  onChanged: () => void;
}) {
  const { hasPermission } = usePermissions();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (chart.status !== 'in_progress') return null;
  if (!hasPermission('mark_chart_entered')) return null;

  function openModal() {
    setRole('');
    setError(null);
    setOpen(true);
  }

  async function handleMarkEntered() {
    if (!role) {
      setError('Select the role this entry is being recorded under');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/charts/${chart.id}/mark-entered`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entered_by_role: role }),
      });
      const json = (await res.json()) as {
        success: boolean;
        message?: string;
        error?: { code: string; message: string };
      };
      if (!res.ok || !json.success) {
        setError(json.error?.message ?? json.message ?? 'Failed to mark chart Entered in EDC');
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
      <Button size="sm" variant="primary" onClick={openModal}>
        Mark Entered in EDC
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="Mark Entered in EDC">
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            This marks the chart as Entered in EDC. Once entered, the chart becomes locked and can
            only be changed through an authorized Reopen.
          </p>
          <Select
            label="Recorded as"
            options={ROLE_OPTIONS}
            placeholder="Select a role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button loading={busy} disabled={busy} onClick={() => void handleMarkEntered()}>
              Mark Entered
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
