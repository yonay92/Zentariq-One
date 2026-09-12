'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { usePermissions } from '@/hooks/usePermissions';
import type { ChartComment } from '@/types/charts';

// Milestone 4.3 — the Chart Detail page is the canonical comment
// interaction surface (P3): the Queue's "Comment" quick action navigates
// here rather than opening an inline modal. Comments are append-only —
// no edit/delete UI exists here because no edit/delete API exists
// (chart_comments has no UPDATE/DELETE RLS policy at all, migration 029).
export function ChartCommentsSection({ chartId }: { chartId: string }) {
  const { hasPermission } = usePermissions();
  const [comments, setComments] = useState<ChartComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/charts/${chartId}/comments`);
      if (res.ok) {
        const json = (await res.json()) as { data: ChartComment[] };
        setComments(json.data);
      }
    } finally {
      setLoading(false);
    }
  }, [chartId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSubmit() {
    if (!text.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/charts/${chartId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: text }),
      });
      const json = (await res.json()) as {
        success: boolean;
        message?: string;
        error?: { code: string; message: string };
      };
      if (!res.ok || !json.success) {
        setError(json.error?.message ?? json.message ?? 'Failed to add comment');
        return;
      }
      setText('');
      await load();
    } catch {
      setError('An unexpected error occurred');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div id="comments" className="space-y-3">
      {hasPermission('comment_chart') && (
        <div className="space-y-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Add a comment…"
            rows={3}
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
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-6">
          <LoadingSpinner />
        </div>
      ) : comments.length === 0 ? (
        <EmptyState title="No comments yet" description="Comments appear here" />
      ) : (
        <ul className="space-y-2">
          {comments.map((c) => (
            <li key={c.id} className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="text-sm whitespace-pre-wrap text-gray-900">{c.comment}</p>
              <p className="mt-1 text-xs text-gray-400">
                {new Date(c.created_at).toLocaleString()}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
