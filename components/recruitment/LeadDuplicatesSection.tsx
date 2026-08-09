'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { usePermissions } from '@/hooks/usePermissions';
import { LEAD_STATUS_VARIANT } from '@/components/recruitment/leadStatusVariant';
import { DUPLICATE_MATCH_REASON_LABEL } from '@/components/recruitment/duplicateMatchReasonLabel';
import type { DuplicateMatch, LeadContactInfo } from '@/types/recruitment';

// PHI-gated the same way as Contact Information — a possible-duplicate match
// reveals that a given name/phone/email already exists in the system, which
// is materially the same class of disclosure as viewing contact info itself.
export function LeadDuplicatesSection({ leadId }: { leadId: string }) {
  const { hasPermission } = usePermissions();
  const canView = hasPermission('view_lead_phi');
  const canDismiss = hasPermission('dismiss_recruitment_duplicates');

  const [hasContactInfo, setHasContactInfo] = useState(false);
  const [matches, setMatches] = useState<DuplicateMatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [dismissTarget, setDismissTarget] = useState<DuplicateMatch | null>(null);
  const [dismissReason, setDismissReason] = useState('');
  const [dismissBusy, setDismissBusy] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);

  const fetchMatches = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const infoRes = await fetch(`/api/leads/${leadId}/contact-info`);
      if (!infoRes.ok) {
        setError('Failed to load contact information');
        return;
      }
      const infoJson = (await infoRes.json()) as { data: LeadContactInfo | null };
      const info = infoJson.data;
      setHasContactInfo(info !== null);
      if (!info) {
        setMatches([]);
        return;
      }

      const dupRes = await fetch('/api/leads/check-duplicates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lead_id: leadId,
          phone: info.phone_primary,
          email: info.email ?? undefined,
          first_name: info.first_name,
          last_name: info.last_name,
          date_of_birth: info.date_of_birth ?? undefined,
          postal_code: info.postal_code ?? undefined,
        }),
      });
      if (!dupRes.ok) {
        setError('Failed to check for duplicate leads');
        return;
      }
      const dupJson = (await dupRes.json()) as { data: { possible_matches: DuplicateMatch[] } };
      setMatches(dupJson.data.possible_matches);
    } catch {
      setError('Failed to check for duplicate leads');
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    if (canView) void fetchMatches();
    else setLoading(false);
  }, [canView, fetchMatches]);

  function openDismiss(match: DuplicateMatch) {
    setDismissTarget(match);
    setDismissReason('');
    setDismissError(null);
  }

  // Dismissal is a recorded "not a duplicate" decision, not a suppression —
  // the match is refetched (not removed locally) so it keeps appearing,
  // now flagged previously_dismissed: true (business rule: never silently
  // hide a duplicate warning).
  async function handleDismiss() {
    if (!dismissTarget) return;
    setDismissBusy(true);
    setDismissError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/duplicates/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          matched_lead_id: dismissTarget.lead_id,
          reason: dismissReason.trim(),
        }),
      });
      const json = (await res.json()) as { success: boolean; error?: { message: string } };
      if (!res.ok || !json.success) {
        setDismissError(json.error?.message ?? 'Failed to dismiss duplicate');
        return;
      }
      setDismissTarget(null);
      setDismissReason('');
      void fetchMatches();
    } catch {
      setDismissError('An unexpected error occurred');
    } finally {
      setDismissBusy(false);
    }
  }

  if (!canView) {
    return (
      <EmptyState
        title="Restricted"
        description="You do not have permission to view possible duplicate leads."
      />
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <h3 className="mb-3 text-sm font-semibold text-gray-900">Possible Duplicates</h3>

      {loading ? (
        <div className="flex justify-center py-4">
          <LoadingSpinner size="sm" />
        </div>
      ) : error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : !hasContactInfo ? (
        <p className="text-sm text-gray-500">
          Add contact information to check for duplicate leads.
        </p>
      ) : matches.length === 0 ? (
        <p className="text-sm text-gray-500">No possible duplicates found.</p>
      ) : (
        <ul className="space-y-3">
          {matches.map((match) => (
            <li
              key={match.lead_id}
              className="rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Link
                    href={`/recruitment/${match.lead_id}`}
                    className="font-medium text-gray-900 hover:underline"
                  >
                    {match.initials ?? 'Lead'}
                  </Link>
                  <Badge variant={LEAD_STATUS_VARIANT[match.status]}>
                    {match.status.replace(/_/g, ' ')}
                  </Badge>
                  {match.archived && <Badge variant="default">Archived</Badge>}
                  {match.previously_dismissed && <Badge variant="info">Previously dismissed</Badge>}
                </div>
                {canDismiss && (
                  <Button size="sm" variant="outline" onClick={() => openDismiss(match)}>
                    Dismiss
                  </Button>
                )}
              </div>
              <p className="mt-1 text-yellow-800">
                Matched on{' '}
                {match.match_reasons.map((r) => DUPLICATE_MATCH_REASON_LABEL[r]).join(', ')}
              </p>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={dismissTarget !== null}
        onClose={() => setDismissTarget(null)}
        title={`Dismiss duplicate: ${dismissTarget?.initials ?? 'Lead'}`}
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-500">
            This records that {dismissTarget?.initials ?? 'this lead'} is not a duplicate of the
            current lead. The warning stays visible to future reviewers — it is never merged or
            hidden.
          </p>
          <div className="space-y-1">
            <label
              htmlFor="duplicate-dismiss-reason"
              className="block text-sm font-medium text-slate-700"
            >
              Reason
            </label>
            <textarea
              id="duplicate-dismiss-reason"
              className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
              rows={3}
              value={dismissReason}
              onChange={(e) => setDismissReason(e.target.value)}
            />
          </div>
          {dismissError && <p className="text-sm text-red-600">{dismissError}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => setDismissTarget(null)}>
              Cancel
            </Button>
            <Button
              loading={dismissBusy}
              disabled={dismissBusy || !dismissReason.trim()}
              onClick={() => void handleDismiss()}
            >
              Dismiss
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
