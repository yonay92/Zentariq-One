'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { usePermissions } from '@/hooks/usePermissions';
import { TASK_API, postTask } from './taskApi';
import type { NameLookup } from './TaskTable';
import type { TaskComment } from '@/types/tasks';

// Append-only: no edit/delete UI exists because no edit/delete API exists.
// The add form is shown only to callers holding comment_task (visibility
// only — the API/TaskService enforce it).
export function TaskCommentsSection({
  taskId,
  userNames,
}: {
  taskId: string;
  userNames: NameLookup;
}) {
  const { hasPermission } = usePermissions();
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const res = await fetch(TASK_API.comments(taskId));
      if (res.ok) {
        setComments(((await res.json()) as { data: TaskComment[] }).data);
      } else {
        setLoadFailed(true);
      }
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSubmit() {
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    const result = await postTask<TaskComment>(TASK_API.comments(taskId), { comment: text.trim() });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setText('');
    await load();
  }

  return (
    <div className="space-y-3">
      {hasPermission('comment_task') && (
        <div className="space-y-2">
          <label htmlFor="task-comment" className="block text-sm font-medium text-slate-700">
            Add a comment
          </label>
          <textarea
            id="task-comment"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            maxLength={4000}
            className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
          />
          <Button
            size="sm"
            loading={submitting}
            disabled={submitting || !text.trim()}
            onClick={() => void handleSubmit()}
          >
            Add Comment
          </Button>
          {error && (
            <p className="text-xs text-red-600" role="alert">
              {error}
            </p>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-6">
          <LoadingSpinner />
        </div>
      ) : loadFailed ? (
        <p className="text-sm text-red-600">Failed to load comments.</p>
      ) : comments.length === 0 ? (
        <EmptyState title="No comments yet" description="Comments appear here" />
      ) : (
        <ul className="space-y-2">
          {comments.map((c) => {
            const author = c.created_by ? userNames[c.created_by] : undefined;
            return (
              <li key={c.id} className="rounded-xl border border-gray-200 bg-white p-4">
                <p className="text-sm whitespace-pre-wrap text-gray-900">{c.comment}</p>
                <p className="mt-1 text-xs text-gray-400">
                  {author ? `${author} · ` : ''}
                  {new Date(c.created_at).toLocaleString()}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
