'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { usePermissions } from '@/hooks/usePermissions';
import type { Chart } from '@/types/charts';

// Self-gates on both status and permission (unlike VisitStarter, which only
// self-gates on status) — Charts' mark_chart_ready/mark_chart_entered split
// is a meaningful role boundary (BUSINESS_RULES_05: CRC vs Data Entry), not
// a broadly-shared permission, so hiding an action a caller cannot use is
// the correct convention here (same "silent self-gate" VisitReopener uses).
export function ChartStartEntryAction({
  chart,
  onChanged,
}: {
  chart: Chart;
  onChanged: () => void;
}) {
  const { hasPermission } = usePermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (chart.status !== 'chart_ready') return null;
  if (!hasPermission('mark_chart_ready')) return null;

  async function handleStart() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/charts/${chart.id}/start`, { method: 'POST' });
      const json = (await res.json()) as {
        success: boolean;
        message?: string;
        error?: { code: string; message: string };
      };
      if (!res.ok || !json.success) {
        setError(json.error?.message ?? json.message ?? 'Failed to start data entry');
        return;
      }
      onChanged();
    } catch {
      setError('An unexpected error occurred');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Button
        size="sm"
        variant="primary"
        loading={busy}
        disabled={busy}
        onClick={() => void handleStart()}
      >
        Start Data Entry
      </Button>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
