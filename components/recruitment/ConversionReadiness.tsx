'use client';

import { useState, useEffect, useCallback } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import type { ConversionReadiness as ConversionReadinessData } from '@/types/recruitment';

type ConversionReadinessProps = {
  leadId: string;
  onReadinessChange?: (readiness: ConversionReadinessData | null) => void;
};

// Mirrors components/studies/ActivationReadiness.tsx — the backend remains
// the single source of truth for conversion eligibility; this only renders
// the response. Unlike ActivationReadinessItem, ConversionReadinessItem has
// no fixAction — every blocking item here is resolved elsewhere on this same
// profile page (contact info, prescreening), not via a cross-page link.
export function ConversionReadiness({ leadId, onReadinessChange }: ConversionReadinessProps) {
  const [readiness, setReadiness] = useState<ConversionReadinessData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReadiness = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/conversion-readiness`);
      const json = (await res.json()) as {
        success: boolean;
        data?: ConversionReadinessData;
        error?: { message?: string };
      };
      if (!res.ok || !json.success || !json.data) {
        setError(json.error?.message ?? 'Failed to load conversion readiness');
        setReadiness(null);
        onReadinessChange?.(null);
        return;
      }
      setReadiness(json.data);
      onReadinessChange?.(json.data);
    } catch {
      setError('Failed to load conversion readiness');
      setReadiness(null);
      onReadinessChange?.(null);
    } finally {
      setLoading(false);
    }
    // onReadinessChange is intentionally not a dependency — it's a fresh
    // closure from the parent on every render, and including it would
    // refetch on every parent re-render instead of only on mount (this
    // component lives inside a Modal that unmounts on close, so a fresh
    // mount already means a fresh check every time it's opened).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  useEffect(() => {
    void fetchReadiness();
  }, [fetchReadiness]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-gray-100 bg-gray-50 p-3 text-sm text-gray-400">
        <LoadingSpinner size="sm" />
        Checking conversion readiness…
      </div>
    );
  }

  if (error || !readiness) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
        {error ?? 'Could not load conversion readiness.'}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
      <p className="mb-3 text-xs font-medium tracking-wide text-gray-500 uppercase">
        Conversion Readiness
      </p>

      {!readiness.can_convert && (
        <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
          This lead cannot be converted until all required items below are resolved.
        </p>
      )}

      <ul className="space-y-2">
        {readiness.items.map((item) => (
          <li key={item.key} className="flex items-start gap-2 text-sm">
            <span
              className={
                item.met ? 'text-green-600' : item.blocking ? 'text-red-600' : 'text-yellow-600'
              }
              aria-hidden="true"
            >
              {item.met ? '✅' : item.blocking ? '❌' : '⚠️'}
            </span>
            <div>
              <span className={item.met ? 'text-gray-600' : 'text-gray-900'}>
                {item.label}
                {!item.met && !item.blocking && (
                  <span className="ml-1 text-xs text-gray-400">(recommended)</span>
                )}
              </span>
              {!item.met && item.reason && <p className="text-xs text-gray-500">{item.reason}</p>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
