'use client';

import { useCallback, useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { AlertBanner } from '@/components/ui/AlertBanner';
import { useAuth } from '@/hooks/useAuth';
import { usePermissions } from '@/hooks/usePermissions';
import { TaskStatusBadge, TaskPriorityBadge, TaskOverdueIndicator } from './TaskBadges';
import { TaskCompleteAction, TaskCancelAction, TaskReassignAction } from './TaskActions';
import { TaskHistoryList } from './TaskHistoryList';
import { TaskCommentsSection } from './TaskCommentsSection';
import { TASK_API, isTerminalTask } from './taskApi';
import { assigneeLabel, formatDate, type NameLookup } from './TaskTable';
import type { AssignableUser } from './TaskActions';
import type { TaskQueueItem } from '@/types/tasks';

// Modal detail panel — the same pattern as VisitDetailPanel. GET
// /api/tasks/[id] is authoritative for the detail view: it returns the stored
// Task plus the read-time fields effective_priority / is_overdue /
// days_overdue (same computation as the list endpoints). Nothing here is
// computed in the browser and nothing depends on the list row that opened the
// modal, so a stale row or a task that left the list cannot skew the detail.
export function TaskDetailPanel({
  taskId,
  users,
  userNames,
  siteNames,
  onClose,
  onChanged,
}: {
  taskId: string;
  users: AssignableUser[];
  userNames: NameLookup;
  siteNames: NameLookup;
  onClose: () => void;
  onChanged: (message: string) => void;
}) {
  const auth = useAuth();
  const { hasAnyPermission, loading: permsLoading } = usePermissions();
  const currentUserId = auth.status === 'authenticated' ? auth.profile.id : null;

  const [task, setTask] = useState<TaskQueueItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<'not_found' | 'error' | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    try {
      const res = await fetch(TASK_API.task(taskId));
      if (!res.ok) {
        setFailure(res.status === 404 || res.status === 403 ? 'not_found' : 'error');
        return;
      }
      setTask(((await res.json()) as { data: TaskQueueItem }).data);
    } catch {
      setFailure('error');
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  function handleChanged(message: string) {
    setRefreshKey((k) => k + 1);
    void load();
    onChanged(message);
  }

  const terminal = task ? isTerminalTask(task) : false;
  const isSelfAssignee =
    task !== null && currentUserId !== null && task.assigned_to === currentUserId;
  const hasAnyAction =
    task !== null &&
    !terminal &&
    (isSelfAssignee || hasAnyPermission('complete_task', 'cancel_task', 'assign_task'));

  return (
    <Modal open onClose={onClose} title="Task Details" size="lg">
      {loading && !task ? (
        <div className="flex h-32 items-center justify-center">
          <LoadingSpinner size="lg" />
        </div>
      ) : failure === 'not_found' ? (
        <EmptyState
          title="Task not found"
          description="It may have been removed, or you may not have access to it."
        />
      ) : failure === 'error' && !task ? (
        <AlertBanner variant="error" message="Failed to load this task. Please try again." />
      ) : task ? (
        <div className="space-y-6">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">{task.title}</h3>
            {task.description && (
              <p className="mt-1 text-sm whitespace-pre-wrap text-gray-600">{task.description}</p>
            )}
          </div>

          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-gray-500">Status</dt>
              <dd className="mt-0.5">
                <TaskStatusBadge status={task.status} />
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">Priority</dt>
              <dd className="mt-0.5 flex flex-wrap items-center gap-2">
                <TaskPriorityBadge priority={task.effective_priority} />
                {task.effective_priority !== task.priority && (
                  <span className="text-xs text-gray-500">base: {task.priority}</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">Due</dt>
              <dd className="mt-0.5 flex flex-col gap-0.5 text-gray-900">
                <span>{formatDate(task.due_date)}</span>
                <TaskOverdueIndicator isOverdue={task.is_overdue} daysOverdue={task.days_overdue} />
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">Assigned to</dt>
              <dd className="mt-0.5 text-gray-900">{assigneeLabel(task, userNames)}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Site</dt>
              <dd className="mt-0.5 text-gray-900">{siteNames[task.site_id] ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Source</dt>
              <dd className="mt-0.5 text-gray-900">
                {task.source_module.replace(/_/g, ' ')}
                {task.source_record_type ? ` · ${task.source_record_type}` : ''}
                {task.created_by_system ? ' (automatic)' : ''}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">Created</dt>
              <dd className="mt-0.5 text-gray-900">{new Date(task.created_at).toLocaleString()}</dd>
            </div>
          </dl>

          {terminal && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
              This task is {task.status} and can no longer be changed.
            </div>
          )}

          {!terminal && (
            <div className="flex flex-wrap items-start gap-2 border-t border-gray-100 pt-4">
              {hasAnyAction ? (
                <>
                  <TaskCompleteAction
                    task={task}
                    currentUserId={currentUserId}
                    onChanged={handleChanged}
                  />
                  <TaskReassignAction task={task} users={users} onChanged={handleChanged} />
                  <TaskCancelAction
                    task={task}
                    currentUserId={currentUserId}
                    onChanged={handleChanged}
                  />
                </>
              ) : (
                !permsLoading && (
                  <p className="text-sm text-gray-500">No actions available for this task.</p>
                )
              )}
            </div>
          )}

          <div>
            <h4 className="mb-2 text-sm font-semibold text-gray-900">History</h4>
            <TaskHistoryList taskId={task.id} refreshKey={refreshKey} userNames={userNames} />
          </div>

          <div>
            <h4 className="mb-2 text-sm font-semibold text-gray-900">Comments</h4>
            <TaskCommentsSection taskId={task.id} userNames={userNames} />
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
