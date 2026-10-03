'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { usePermissions } from '@/hooks/usePermissions';
import { TASK_API, postTask, isTerminalTask } from './taskApi';
import type { Task } from '@/types/tasks';

// Visibility mirrors the approved permission model but is NOT authorization:
// the API/TaskService remain the security boundary and their rejections
// (403/404/422) are shown verbatim, never treated as success.

type ActionProps = {
  task: Task;
  currentUserId: string | null;
  onChanged: (message: string) => void;
};

// Complete: complete_task OR self-assignee (TaskService's approved rule), for
// any non-terminal task. The button is offered to an assignee even without
// complete_task.
export function TaskCompleteAction({ task, currentUserId, onChanged }: ActionProps) {
  const { hasPermission } = usePermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isTerminalTask(task)) return null;
  const isSelfAssignee = currentUserId !== null && task.assigned_to === currentUserId;
  if (!hasPermission('complete_task') && !isSelfAssignee) return null;

  async function handleComplete() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await postTask<Task>(TASK_API.complete(task.id));
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onChanged('Task completed');
  }

  return (
    <div className="space-y-1">
      <Button size="sm" loading={busy} disabled={busy} onClick={() => void handleComplete()}>
        Complete Task
      </Button>
      {error && (
        <p className="text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function TaskCancelAction({ task, onChanged }: ActionProps) {
  const { hasPermission } = usePermissions();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isTerminalTask(task)) return null;
  if (!hasPermission('cancel_task')) return null;

  function openModal() {
    setReason('');
    setError(null);
    setOpen(true);
  }

  async function handleCancel() {
    if (busy) return;
    if (!reason.trim()) {
      setError('A reason is required');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await postTask<Task>(TASK_API.cancel(task.id), { reason: reason.trim() });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setOpen(false);
    onChanged('Task cancelled');
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={openModal}>
        Cancel Task
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Cancel Task">
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Cancelling is final. A reason is required for the audit trail.
          </p>
          <div className="space-y-1">
            <label
              htmlFor="task-cancel-reason"
              className="block text-sm font-medium text-slate-700"
            >
              Reason
            </label>
            <textarea
              id="task-cancel-reason"
              className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
              rows={3}
              maxLength={2000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Required — why is this task being cancelled?"
            />
          </div>
          {error && (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Back
            </Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={busy}
              onClick={() => void handleCancel()}
            >
              Confirm Cancel
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

export type AssignableUser = { id: string; label: string };

// Reassign. The target list is every active company user: the UI does NOT
// decide who has access to the task's site — TaskService is authoritative and
// its rejection is shown without changing any local state.
export function TaskReassignAction({
  task,
  users,
  onChanged,
}: Pick<ActionProps, 'task' | 'onChanged'> & { users: AssignableUser[] }) {
  const { hasPermission } = usePermissions();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isTerminalTask(task)) return null;
  if (!hasPermission('assign_task')) return null;

  function openModal() {
    setTarget('');
    setError(null);
    setOpen(true);
  }

  async function handleReassign() {
    if (busy) return;
    if (!target) {
      setError('Please choose a user');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await postTask<Task>(TASK_API.reassign(task.id), { assigned_to: target });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setOpen(false);
    onChanged('Task reassigned');
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={openModal}>
        Reassign
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Reassign Task">
        <div className="space-y-4">
          <Select
            label="New assignee"
            placeholder="Select a user"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            options={users
              .filter((u) => u.id !== task.assigned_to)
              .map((u) => ({ value: u.id, label: u.label }))}
          />
          {error && (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Back
            </Button>
            <Button loading={busy} disabled={busy} onClick={() => void handleReassign()}>
              Reassign Task
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
