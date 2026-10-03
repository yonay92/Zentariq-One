'use client';

import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { TASK_API, postTask } from './taskApi';
import type { AssignableUser } from './TaskActions';
import type { Task, TaskPriority } from '@/types/tasks';

const PRIORITY_OPTIONS: Array<{ value: TaskPriority; label: string }> = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

type RoleOption = { key: string; name: string };

// Manual creation. The request body is limited to the approved create
// contract (site_id, title, description, priority, due_date, and assigned_to
// OR assigned_role). No identity, status, source or computed field is ever
// sent. Client validation is UX only; the API validates and authorizes.
export function TaskCreateModal({
  open,
  sites,
  users,
  onClose,
  onCreated,
}: {
  open: boolean;
  sites: Array<{ id: string; name: string }>;
  users: AssignableUser[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [siteId, setSiteId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [dueDate, setDueDate] = useState('');
  const [assignKind, setAssignKind] = useState<'user' | 'role'>('user');
  const [assignedTo, setAssignedTo] = useState('');
  const [assignedRole, setAssignedRole] = useState('');
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [apiError, setApiError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSiteId('');
    setTitle('');
    setDescription('');
    setPriority('medium');
    setDueDate('');
    setAssignKind('user');
    setAssignedTo('');
    setAssignedRole('');
    setErrors({});
    setApiError(null);
    void (async () => {
      try {
        const res = await fetch('/api/roles');
        if (res.ok) {
          setRoles(((await res.json()) as { data: { roles: RoleOption[] } }).data.roles);
        }
      } catch {
        setRoles([]);
      }
    })();
  }, [open]);

  async function handleSubmit() {
    if (busy) return;
    const next: Record<string, string> = {};
    if (!siteId) next.site = 'Please choose a site';
    if (!title.trim()) next.title = 'A title is required';
    if (assignKind === 'user' && !assignedTo) next.assignee = 'Please choose a user';
    if (assignKind === 'role' && !assignedRole) next.assignee = 'Please choose a role';
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setBusy(true);
    setApiError(null);
    const result = await postTask<Task>(TASK_API.list, {
      site_id: siteId,
      title: title.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      priority,
      ...(dueDate ? { due_date: new Date(dueDate).toISOString() } : {}),
      ...(assignKind === 'user' ? { assigned_to: assignedTo } : { assigned_role: assignedRole }),
    });
    setBusy(false);
    if (!result.ok) {
      setApiError(result.message);
      return;
    }
    onCreated();
  }

  return (
    <Modal open={open} onClose={onClose} title="Create Task" size="lg">
      <div className="space-y-4">
        <Select
          label="Site"
          id="task-create-site"
          placeholder="Select a site"
          value={siteId}
          onChange={(e) => setSiteId(e.target.value)}
          error={errors.site ?? ''}
          options={sites.map((s) => ({ value: s.id, label: s.name }))}
        />
        <Input
          label="Title"
          id="task-create-title"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          error={errors.title ?? ''}
        />
        <div className="space-y-1">
          <label htmlFor="task-description" className="block text-sm font-medium text-slate-700">
            Description (optional)
          </label>
          <textarea
            id="task-description"
            rows={3}
            maxLength={4000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Select
            label="Priority"
            id="task-create-priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value as TaskPriority)}
            options={PRIORITY_OPTIONS}
          />
          <Input
            label="Due date (optional)"
            id="task-create-due"
            type="datetime-local"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-slate-700">Assign to</legend>
          <div className="flex gap-4 text-sm text-slate-700">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="task-assign-kind"
                checked={assignKind === 'user'}
                onChange={() => setAssignKind('user')}
              />
              A user
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="task-assign-kind"
                checked={assignKind === 'role'}
                onChange={() => setAssignKind('role')}
              />
              A role queue
            </label>
          </div>
          {assignKind === 'user' ? (
            <Select
              label="User"
              id="task-create-user"
              placeholder="Select a user"
              value={assignedTo}
              onChange={(e) => setAssignedTo(e.target.value)}
              error={errors.assignee ?? ''}
              options={users.map((u) => ({ value: u.id, label: u.label }))}
            />
          ) : (
            <Select
              label="Role"
              id="task-create-role"
              placeholder="Select a role"
              value={assignedRole}
              onChange={(e) => setAssignedRole(e.target.value)}
              error={errors.assignee ?? ''}
              options={roles.map((r) => ({ value: r.key, label: r.name }))}
            />
          )}
        </fieldset>

        {apiError && (
          <p className="text-sm text-red-600" role="alert">
            {apiError}
          </p>
        )}
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="outline" onClick={onClose}>
            Back
          </Button>
          <Button loading={busy} disabled={busy} onClick={() => void handleSubmit()}>
            Create Task
          </Button>
        </div>
      </div>
    </Modal>
  );
}
