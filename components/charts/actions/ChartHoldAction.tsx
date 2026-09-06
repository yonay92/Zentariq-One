'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { usePermissions } from '@/hooks/usePermissions';
import type { Chart } from '@/types/charts';

export function ChartHoldAction({ chart, onChanged }: { chart: Chart; onChanged: () => void }) {
  const { hasPermission } = usePermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (chart.status !== 'chart_ready' && chart.status !== 'in_progress') return null;
  if (!hasPermission('mark_chart_ready')) return null;

  async function handleHold() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/charts/${chart.id}/hold`, { method: 'POST' });
      const json = (await res.json()) as {
        success: boolean;
        message?: string;
        error?: { code: string; message: string };
      };
      if (!res.ok || !json.success) {
        setError(json.error?.message ?? json.message ?? 'Failed to hold chart');
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
        variant="outline"
        loading={busy}
        disabled={busy}
        onClick={() => void handleHold()}
      >
        Hold
      </Button>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
