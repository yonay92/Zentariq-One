'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import type {
  ActivationReadiness as ActivationReadinessData,
  ActivationReadinessItemKey,
} from '@/types/studies';

type FixActionHandlers = Partial<Record<ActivationReadinessItemKey, () => void>>;

type ActivationReadinessProps = {
  studyId: string;
  // In-page fix actions (switch tab, open a modal, etc.) — keyed by the
  // backend item's key. Items whose backend `fixAction.href` is set instead
  // render a real link and never consult this map. Adding a new backend
  // checklist item that needs an in-page action only requires adding one
  // entry here — nothing else about this component needs to change, which
  // is the point of keeping it reusable for future business rules.
  fixActionHandlers?: FixActionHandlers;
  // Bump this number from the parent to force a refetch (e.g. after an
  // action taken elsewhere on the page might have changed readiness).
  refreshSignal?: number;
  onReadinessChange?: (readiness: ActivationReadinessData | null) => void;
};

export function ActivationReadiness({
  studyId,
  fixActionHandlers,
  refreshSignal,
  onReadinessChange,
}: ActivationReadinessProps) {
  const [readiness, setReadiness] = useState<ActivationReadinessData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReadiness = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/studies/${studyId}/activation-readiness`);
      const json = (await res.json()) as {
        success: boolean;
        data?: ActivationReadinessData;
        error?: { message?: string };
      };
      if (!res.ok || !json.success || !json.data) {
        setError(json.error?.message ?? 'Failed to load activation readiness');
        setReadiness(null);
        onReadinessChange?.(null);
        return;
      }
      setReadiness(json.data);
      onReadinessChange?.(json.data);
    } catch {
      setError('Failed to load activation readiness');
      setReadiness(null);
      onReadinessChange?.(null);
    } finally {
      setLoading(false);
    }
    // onReadinessChange is intentionally not a dependency — it's a fresh
    // closure from the parent on every render, and including it would
    // refetch on every parent re-render instead of only when studyId or an
    // explicit refreshSignal bump warrants it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studyId]);

  useEffect(() => {
    void fetchReadiness();
  }, [fetchReadiness, refreshSignal]);

  if (loading) {
    return (
      <div className="mt-4 flex items-center gap-2 rounded-lg border border-gray-100 bg-gray-50 p-3 text-sm text-gray-400">
        <LoadingSpinner size="sm" />
        Checking activation readiness…
      </div>
    );
  }

  if (error || !readiness) {
    return (
      <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
        {error ?? 'Could not load activation readiness.'}
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
      <p className="mb-3 text-xs font-medium tracking-wide text-gray-500 uppercase">
        Activation Readiness
      </p>

      {!readiness.canActivate && (
        <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
          Study cannot be activated until all required items below are completed.
        </p>
      )}

      <ul className="space-y-2">
        {readiness.items.map((item) => {
          const handler = fixActionHandlers?.[item.key];
          const showFixButton = !item.met && item.fixAction;

          return (
            <li key={item.key} className="flex items-start justify-between gap-3 text-sm">
              <div className="flex items-start gap-2">
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
                  {!item.met && item.reason && (
                    <p className="text-xs text-gray-500">{item.reason}</p>
                  )}
                </div>
              </div>

              {showFixButton &&
                (item.fixAction!.href ? (
                  <Link
                    href={item.fixAction!.href}
                    className="shrink-0 text-xs font-medium text-blue-600 hover:underline"
                  >
                    {item.fixAction!.label}
                  </Link>
                ) : handler ? (
                  <button
                    type="button"
                    onClick={handler}
                    className="shrink-0 text-xs font-medium text-blue-600 hover:underline"
                  >
                    {item.fixAction!.label}
                  </button>
                ) : null)}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
