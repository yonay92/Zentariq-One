'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { usePermissions } from '@/hooks/usePermissions';
import type { Lead, LeadPriority, LeadTask } from '@/types/recruitment';

const PRIORITY_OPTIONS: Array<{ value: LeadPriority; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

export function LeadTasksSection({ lead }: { lead: Lead }) {
  const { hasPermission } = usePermissions();
  const canManage = hasPermission('manage_lead_tasks');

  const [tasks, setTasks] = useState<LeadTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<LeadPriority>('medium');
  const [dueAt, setDueAt] = useState('');
  const [overrideReason, setOverrideReason] = useState('');

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/leads/${lead.id}/tasks`);
      if (res.ok) {
        const json = (await res.json()) as { data: LeadTask[] };
        setTasks(json.data);
      }
    } finally {
      setLoading(false);
    }
  }, [lead.id]);

  useEffect(() => {
    if (canManage) void fetchTasks();
    else setLoading(false);
  }, [canManage, fetchTasks]);

  async function handleCreate() {
    if (!title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${lead.id}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          priority,
          due_at: dueAt ? new Date(dueAt).toISOString() : undefined,
          override_reason: lead.do_not_contact ? overrideReason.trim() || undefined : undefined,
        }),
      });
      const json = (await res.json()) as { success: boolean; error?: { message: string } };
      if (!res.ok || !json.success) {
        setError(json.error?.message ?? 'Failed to create task');
        return;
      }
      setOpen(false);
      setTitle('');
      setDueAt('');
      setOverrideReason('');
      void fetchTasks();
    } finally {
      setSaving(false);
    }
  }

  async function handleComplete(taskId: string) {
    const res = await fetch(`/api/leads/${lead.id}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });
    if (res.ok) void fetchTasks();
  }

  if (!canManage) return null;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">Tasks</h3>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          New Task
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-4">
          <LoadingSpinner size="sm" />
        </div>
      ) : tasks.length === 0 ? (
        <p className="text-sm text-gray-500">No tasks yet.</p>
      ) : (
        <ul className="space-y-2">
          {tasks.map((task) => (
            <li key={task.id} className="flex items-start justify-between gap-3 text-sm">
              <div>
                <p
                  className={
                    task.status === 'completed'
                      ? 'text-gray-400 line-through'
                      : 'font-medium text-gray-900'
                  }
                >
                  {task.title}
                </p>
                <p className="text-xs text-gray-400">
                  {task.priority} priority
                  {task.due_at && ` · due ${new Date(task.due_at).toLocaleDateString()}`}
                </p>
              </div>
              {task.status !== 'completed' && task.status !== 'cancelled' && (
                <Button size="sm" variant="outline" onClick={() => void handleComplete(task.id)}>
                  Complete
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="New Task">
        <div className="space-y-4">
          {lead.do_not_contact && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
              This lead is marked do-not-contact. Creating a task requires an override reason.
            </p>
          )}
          <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value as LeadPriority)}
              options={PRIORITY_OPTIONS}
            />
            <Input
              label="Due (optional)"
              type="datetime-local"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
            />
          </div>
          {lead.do_not_contact && (
            <Input
              label="Override reason"
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              placeholder="Required to create a task on a do-not-contact lead"
            />
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={saving}
              disabled={saving || !title.trim() || (lead.do_not_contact && !overrideReason.trim())}
              onClick={() => void handleCreate()}
            >
              Create
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
