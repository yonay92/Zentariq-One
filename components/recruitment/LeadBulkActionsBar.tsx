'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { usePermissions } from '@/hooks/usePermissions';
import { LEAD_STATUS_VARIANT } from '@/components/recruitment/leadStatusVariant';
import type {
  LeadStatus,
  LeadPriority,
  BulkActionResult,
  BulkChangeStatusPreview,
} from '@/types/recruitment';
import type { Profile } from '@/types/users';

const PRIORITY_OPTIONS: Array<{ value: LeadPriority; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

// Only normal transitions are ever proposed here — the backend rejects the
// whole batch as a hard business rule if any selected lead isn't eligible
// (see LeadService.bulkChangeStatus), so the picker itself doesn't need to
// (and shouldn't) offer exceptional/reason-only targets.
const STATUS_OPTIONS: Array<{ value: LeadStatus; label: string }> = (
  Object.keys(LEAD_STATUS_VARIANT) as LeadStatus[]
)
  .filter((s) => s !== 'converted')
  .map((status) => ({ value: status, label: status.replace(/_/g, ' ') }));

type ActiveModal = 'assign' | 'priority' | 'task' | 'status' | 'archive' | null;

async function postJson<T>(
  url: string,
  body: unknown,
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { success: boolean; data?: T; error?: { message: string } };
  if (!res.ok || !json.success) {
    return { ok: false, error: json.error?.message ?? 'Action failed' };
  }
  return json.data !== undefined ? { ok: true, data: json.data } : { ok: true };
}

function ResultSummary({ result }: { result: BulkActionResult }) {
  return (
    <div className="rounded-md bg-gray-50 p-3 text-sm text-gray-700">
      <p className="font-medium">
        {result.succeeded_count} succeeded, {result.skipped_count} skipped
      </p>
      {result.skipped_count > 0 && (
        <ul className="mt-2 max-h-32 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs text-gray-500">
          {result.outcomes
            .filter((o) => !o.succeeded)
            .map((o) => (
              <li key={o.lead_id}>{o.reason ?? 'Failed'}</li>
            ))}
        </ul>
      )}
    </div>
  );
}

export function LeadBulkActionsBar({
  selectedIds,
  onClear,
  onApplied,
}: {
  selectedIds: string[];
  onClear: () => void;
  onApplied: () => void;
}) {
  const { hasPermission } = usePermissions();
  const canBulkManage = hasPermission('bulk_manage_recruitment_leads');

  const [activeModal, setActiveModal] = useState<ActiveModal>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkActionResult | null>(null);
  const [users, setUsers] = useState<Profile[]>([]);

  const [assignedUserId, setAssignedUserId] = useState('');
  const [priority, setPriority] = useState<LeadPriority>('medium');
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDueAt, setTaskDueAt] = useState('');
  const [taskOverrideReason, setTaskOverrideReason] = useState('');
  const [newStatus, setNewStatus] = useState<LeadStatus>('contacted');
  const [statusPreview, setStatusPreview] = useState<BulkChangeStatusPreview | null>(null);
  const [archiveReason, setArchiveReason] = useState('');

  useEffect(() => {
    if (!canBulkManage) return;
    void (async () => {
      const res = await fetch('/api/users');
      if (res.ok) setUsers(((await res.json()) as { data: Profile[] }).data);
    })();
  }, [canBulkManage]);

  function closeModal() {
    setActiveModal(null);
    setError(null);
    setResult(null);
    setStatusPreview(null);
  }

  function finishSuccessfully() {
    onApplied();
    onClear();
  }

  async function handleAssign() {
    setBusy(true);
    setError(null);
    const res = await postJson<BulkActionResult>('/api/leads/bulk/assign', {
      lead_ids: selectedIds,
      assigned_user_id: assignedUserId || null,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? 'Failed to assign leads');
      return;
    }
    setResult(res.data ?? null);
  }

  async function handlePriority() {
    setBusy(true);
    setError(null);
    const res = await postJson<BulkActionResult>('/api/leads/bulk/priority', {
      lead_ids: selectedIds,
      priority,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? 'Failed to update priority');
      return;
    }
    setResult(res.data ?? null);
  }

  async function handleTask() {
    setBusy(true);
    setError(null);
    const res = await postJson<BulkActionResult>('/api/leads/bulk/tasks', {
      lead_ids: selectedIds,
      title: taskTitle,
      due_at: taskDueAt ? new Date(taskDueAt).toISOString() : undefined,
      override_reason: taskOverrideReason.trim() || undefined,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? 'Failed to create tasks');
      return;
    }
    setResult(res.data ?? null);
  }

  async function handleArchive() {
    setBusy(true);
    setError(null);
    const res = await postJson<BulkActionResult>('/api/leads/bulk/archive', {
      lead_ids: selectedIds,
      reason: archiveReason.trim() || undefined,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? 'Failed to archive leads');
      return;
    }
    setResult(res.data ?? null);
  }

  async function handlePreviewStatus() {
    setBusy(true);
    setError(null);
    const res = await postJson<BulkChangeStatusPreview>('/api/leads/bulk/status-preview', {
      lead_ids: selectedIds,
      new_status: newStatus,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? 'Failed to validate status change');
      return;
    }
    setStatusPreview(res.data ?? null);
  }

  async function handleApplyStatus() {
    setBusy(true);
    setError(null);
    const res = await postJson<BulkActionResult>('/api/leads/bulk/status', {
      lead_ids: selectedIds,
      new_status: newStatus,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? 'Failed to change status');
      return;
    }
    setResult(res.data ?? null);
  }

  if (!canBulkManage || selectedIds.length === 0) return null;

  return (
    <div
      className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3"
      role="region"
      aria-label="Bulk actions"
    >
      <p className="text-sm font-medium text-blue-900">{selectedIds.length} selected</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setActiveModal('assign')}>
          Assign
        </Button>
        <Button size="sm" variant="outline" onClick={() => setActiveModal('priority')}>
          Change Priority
        </Button>
        <Button size="sm" variant="outline" onClick={() => setActiveModal('task')}>
          Create Task
        </Button>
        <Button size="sm" variant="outline" onClick={() => setActiveModal('status')}>
          Change Status
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setActiveModal('archive')}>
          Archive
        </Button>
      </div>
      <button
        type="button"
        className="ml-auto text-xs text-blue-700 hover:underline"
        onClick={onClear}
      >
        Clear selection
      </button>

      <Modal open={activeModal === 'assign'} onClose={closeModal} title="Bulk Assign">
        <div className="space-y-4">
          {!result ? (
            <>
              <Select
                label="Assign to"
                value={assignedUserId}
                onChange={(e) => setAssignedUserId(e.target.value)}
                placeholder="Unassigned"
                options={users.map((u) => ({ value: u.id, label: u.full_name }))}
              />
              {error && <p className="text-sm text-red-600">{error}</p>}
              <div className="flex justify-end gap-3 pt-2">
                <Button variant="outline" onClick={closeModal}>
                  Cancel
                </Button>
                <Button loading={busy} disabled={busy} onClick={() => void handleAssign()}>
                  Apply to {selectedIds.length} leads
                </Button>
              </div>
            </>
          ) : (
            <>
              <ResultSummary result={result} />
              <div className="flex justify-end pt-2">
                <Button onClick={finishSuccessfully}>Done</Button>
              </div>
            </>
          )}
        </div>
      </Modal>

      <Modal open={activeModal === 'priority'} onClose={closeModal} title="Bulk Change Priority">
        <div className="space-y-4">
          {!result ? (
            <>
              <Select
                label="Priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value as LeadPriority)}
                options={PRIORITY_OPTIONS}
              />
              {error && <p className="text-sm text-red-600">{error}</p>}
              <div className="flex justify-end gap-3 pt-2">
                <Button variant="outline" onClick={closeModal}>
                  Cancel
                </Button>
                <Button loading={busy} disabled={busy} onClick={() => void handlePriority()}>
                  Apply to {selectedIds.length} leads
                </Button>
              </div>
            </>
          ) : (
            <>
              <ResultSummary result={result} />
              <div className="flex justify-end pt-2">
                <Button onClick={finishSuccessfully}>Done</Button>
              </div>
            </>
          )}
        </div>
      </Modal>

      <Modal open={activeModal === 'task'} onClose={closeModal} title="Bulk Create Follow-up Task">
        <div className="space-y-4">
          {!result ? (
            <>
              <Input
                label="Title"
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
              />
              <Input
                label="Due (optional)"
                type="datetime-local"
                value={taskDueAt}
                onChange={(e) => setTaskDueAt(e.target.value)}
              />
              <Input
                label="Do-not-contact override reason (optional)"
                value={taskOverrideReason}
                onChange={(e) => setTaskOverrideReason(e.target.value)}
                hint="Required only for any selected leads marked do-not-contact — those are otherwise skipped."
              />
              {error && <p className="text-sm text-red-600">{error}</p>}
              <div className="flex justify-end gap-3 pt-2">
                <Button variant="outline" onClick={closeModal}>
                  Cancel
                </Button>
                <Button
                  loading={busy}
                  disabled={busy || !taskTitle.trim()}
                  onClick={() => void handleTask()}
                >
                  Apply to {selectedIds.length} leads
                </Button>
              </div>
            </>
          ) : (
            <>
              <ResultSummary result={result} />
              <div className="flex justify-end pt-2">
                <Button onClick={finishSuccessfully}>Done</Button>
              </div>
            </>
          )}
        </div>
      </Modal>

      <Modal open={activeModal === 'status'} onClose={closeModal} title="Bulk Change Status">
        <div className="space-y-4">
          {!result ? (
            <>
              <Select
                label="New status"
                value={newStatus}
                onChange={(e) => {
                  setNewStatus(e.target.value as LeadStatus);
                  setStatusPreview(null);
                }}
                options={STATUS_OPTIONS}
              />
              <p className="text-xs text-gray-500">
                Only a normal pipeline transition is allowed in bulk — if any selected lead
                isn&apos;t eligible, none are changed.
              </p>
              {!statusPreview && (
                <Button
                  size="sm"
                  variant="outline"
                  loading={busy}
                  disabled={busy}
                  onClick={() => void handlePreviewStatus()}
                >
                  Check Eligibility
                </Button>
              )}
              {statusPreview && (
                <div
                  className={`rounded-md p-3 text-sm ${
                    statusPreview.all_eligible
                      ? 'bg-green-50 text-green-800'
                      : 'bg-red-50 text-red-800'
                  }`}
                >
                  <p className="font-medium">
                    {statusPreview.eligible_lead_ids.length} of {selectedIds.length} leads are
                    eligible
                  </p>
                  {!statusPreview.all_eligible && (
                    <ul className="mt-2 max-h-32 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs">
                      {statusPreview.ineligible.map((item) => (
                        <li key={item.lead_id}>{item.reason}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {error && <p className="text-sm text-red-600">{error}</p>}
              <div className="flex justify-end gap-3 pt-2">
                <Button variant="outline" onClick={closeModal}>
                  Cancel
                </Button>
                <Button
                  loading={busy}
                  disabled={busy || !statusPreview?.all_eligible}
                  onClick={() => void handleApplyStatus()}
                >
                  Apply to {selectedIds.length} leads
                </Button>
              </div>
            </>
          ) : (
            <>
              <ResultSummary result={result} />
              <div className="flex justify-end pt-2">
                <Button onClick={finishSuccessfully}>Done</Button>
              </div>
            </>
          )}
        </div>
      </Modal>

      <Modal open={activeModal === 'archive'} onClose={closeModal} title="Bulk Archive">
        <div className="space-y-4">
          {!result ? (
            <>
              <p className="text-sm text-gray-500">
                Archiving removes these leads from default active views. They are not deleted.
              </p>
              <Input
                label="Reason (optional)"
                value={archiveReason}
                onChange={(e) => setArchiveReason(e.target.value)}
              />
              {error && <p className="text-sm text-red-600">{error}</p>}
              <div className="flex justify-end gap-3 pt-2">
                <Button variant="outline" onClick={closeModal}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  loading={busy}
                  disabled={busy}
                  onClick={() => void handleArchive()}
                >
                  Archive {selectedIds.length} leads
                </Button>
              </div>
            </>
          ) : (
            <>
              <ResultSummary result={result} />
              <div className="flex justify-end pt-2">
                <Button onClick={finishSuccessfully}>Done</Button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}
