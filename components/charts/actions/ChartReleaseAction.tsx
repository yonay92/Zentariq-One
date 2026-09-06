'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { usePermissions } from '@/hooks/usePermissions';
import type { Chart } from '@/types/charts';

export function ChartReleaseAction({ chart, onChanged }: { chart: Chart; onChanged: () => void }) {
  const { hasPermission } = usePermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (chart.status !== 'on_hold') return null;
  if (!hasPermission('mark_chart_ready')) return null;

  async function handleRelease() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/charts/${chart.id}/release`, { method: 'POST' });
      const json = (await res.json()) as {
        success: boolean;
        message?: string;
        error?: { code: string; message: string };
      };
      if (!res.ok || !json.success) {
        setError(json.error?.message ?? json.message ?? 'Failed to release chart');
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
        onClick={() => void handleRelease()}
      >
        Release
      </Button>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
