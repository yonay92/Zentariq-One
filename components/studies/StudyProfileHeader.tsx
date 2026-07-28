'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EditStudyModal } from '@/components/studies/EditStudyModal';
import { ArchiveStudyModal } from '@/components/studies/ArchiveStudyModal';
import { ActivationReadiness } from '@/components/studies/ActivationReadiness';
import { usePermissions } from '@/hooks/usePermissions';
import type {
  Study,
  StudyStatus,
  ActivationReadiness as ActivationReadinessData,
} from '@/types/studies';

type BadgeVariant = 'success' | 'warning' | 'danger' | 'default' | 'primary' | 'info';

const STATUS_VARIANT: Record<StudyStatus, BadgeVariant> = {
  draft: 'default',
  active: 'success',
  on_hold: 'warning',
  closed: 'danger',
  archived: 'default',
};

export function StudyProfileHeader({
  study,
  onChanged,
  onNavigateTab,
}: {
  study: Study;
  onChanged: () => void;
  // Lets the ActivationReadiness panel's "Documents"/"Sites"/"AI Review" fix
  // actions switch tabs on the parent StudyProfilePage — those live in
  // this same page, not a separate route, so there's nothing to link to.
  onNavigateTab?: (tab: string) => void;
}) {
  const { hasPermission } = usePermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [readiness, setReadiness] = useState<ActivationReadinessData | null>(null);
  const [readinessRefresh, setReadinessRefresh] = useState(0);

  async function updateStatus(status: StudyStatus) {
    setBusy(true);
    setError(null);
    try {
      const url =
        status === 'closed' ? `/api/studies/${study.id}/close` : `/api/studies/${study.id}`;
      const res = await fetch(url, {
        method: status === 'closed' ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        ...(status === 'closed' ? {} : { body: JSON.stringify({ status }) }),
      });
      // Error responses carry the reason at `error.message` (see
      // lib/api/response.ts's ApiErrorResponse shape) — a top-level
      // `message` only exists on success responses. Reading the wrong path
      // here previously discarded every real backend reason (e.g. "Study
      // cannot be activated until it has an approved visit template") in
      // favor of a generic "Action failed", regardless of the real cause.
      const json = (await res.json()) as {
        success: boolean;
        error?: { message?: string };
      };
      if (!res.ok || !json.success) {
        setError(json.error?.message ?? 'Action failed');
        return;
      }
      onChanged();
      setReadinessRefresh((n) => n + 1);
    } catch {
      setError('An unexpected error occurred');
    } finally {
      setBusy(false);
    }
  }

  const canManage = hasPermission('manage_studies');
  const canEdit = canManage || hasPermission('edit_study');
  const showActivateAffordance = study.status === 'draft' || study.status === 'on_hold';
  const canActivate = readiness?.canActivate ?? false;

  return (
    <div className="mb-6 rounded-xl border border-gray-200 bg-white p-6">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold text-gray-900">{study.study_name}</h1>
            <Badge variant={STATUS_VARIANT[study.status]}>{study.status}</Badge>
            {study.ai_generated && <Badge variant="info">AI Draft</Badge>}
          </div>
          <p className="mt-1 text-sm text-gray-500">
            {[study.sponsor, study.phase, study.therapeutic_area].filter(Boolean).join(' · ') ||
              '—'}
          </p>
        </div>

        {canEdit && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
              Edit
            </Button>
            {canManage && showActivateAffordance ? (
              <Button
                size="sm"
                loading={busy}
                disabled={busy || !canActivate}
                onClick={() => void updateStatus('active')}
              >
                Activate
              </Button>
            ) : null}
            {canManage && study.status === 'active' && (
              <Button
                size="sm"
                variant="danger"
                loading={busy}
                disabled={busy}
                onClick={() => void updateStatus('closed')}
              >
                Close Study
              </Button>
            )}
            {canManage && study.status !== 'archived' && (
              <ArchiveStudyModal study={study} onChanged={onChanged} />
            )}
          </div>
        )}
      </div>

      {canManage && showActivateAffordance && (
        <ActivationReadiness
          studyId={study.id}
          refreshSignal={readinessRefresh}
          onReadinessChange={setReadiness}
          fixActionHandlers={{
            protocol_uploaded: () => onNavigateTab?.('Documents'),
            ai_review_completed: () => onNavigateTab?.('AI Review'),
            required_fields_completed: () => setEditOpen(true),
            sponsor_assigned: () => setEditOpen(true),
            protocol_number_assigned: () => setEditOpen(true),
            site_assigned: () => onNavigateTab?.('Sites'),
          }}
        />
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <EditStudyModal
        study={study}
        onChanged={() => {
          onChanged();
          setReadinessRefresh((n) => n + 1);
        }}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
    </div>
  );
}
