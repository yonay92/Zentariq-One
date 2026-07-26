'use client';

import { useEffect, useState, useCallback } from 'react';
import { Modal } from '@/components/ui/Modal';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import type { DocumentVersion, DocumentHistoryEntry } from '@/types/regulatory';

type DocumentHistoryDrawerProps = {
  open: boolean;
  onClose: () => void;
  documentId: string;
  documentName: string;
  basePath: 'regulatory/documents' | 'staff-credentials';
};

type TimelineEntry = {
  at: string;
  label: string;
  detail: string | null;
};

export function DocumentHistoryDrawer({
  open,
  onClose,
  documentId,
  documentName,
  basePath,
}: DocumentHistoryDrawerProps) {
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [history, setHistory] = useState<DocumentHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTimeline = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [versionsRes, historyRes] = await Promise.all([
        fetch(`/api/${basePath}/${documentId}/versions`),
        fetch(`/api/${basePath}/${documentId}/history`),
      ]);
      if (!versionsRes.ok || !historyRes.ok) throw new Error('Failed to load history');
      const versionsJson = (await versionsRes.json()) as { data: DocumentVersion[] };
      const historyJson = (await historyRes.json()) as { data: DocumentHistoryEntry[] };
      setVersions(versionsJson.data);
      setHistory(historyJson.data);
    } catch {
      setError('Failed to load version and status history.');
    } finally {
      setLoading(false);
    }
  }, [basePath, documentId]);

  useEffect(() => {
    if (open) void fetchTimeline();
  }, [open, fetchTimeline]);

  const timeline: TimelineEntry[] = [
    ...versions.map((v) => ({
      at: v.uploaded_at,
      label: `Version ${v.version} uploaded${v.replacement_reason ? ' (replacement)' : ''}`,
      detail: v.replacement_reason ?? v.file?.original_name ?? null,
    })),
    ...versions
      .filter((v) => v.reviewed_at)
      .map((v) => ({
        at: v.reviewed_at as string,
        label: `Version ${v.version} ${v.status === 'rejected' ? 'rejected' : 'approved'}`,
        detail: null,
      })),
    ...history
      .filter((h) => h.reason)
      .map((h) => ({
        at: h.changed_at,
        label: `Status: ${h.old_status ?? '—'} → ${h.new_status}`,
        detail: h.reason,
      })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return (
    <Modal open={open} onClose={onClose} title={`History — ${documentName}`} size="lg">
      {loading ? (
        <div className="flex h-32 items-center justify-center">
          <LoadingSpinner />
        </div>
      ) : error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : timeline.length === 0 ? (
        <EmptyState title="No history yet" description="This document has no recorded activity." />
      ) : (
        <ul className="max-h-96 space-y-3 overflow-y-auto">
          {timeline.map((entry, i) => (
            <li key={i} className="border-b border-gray-100 pb-3 last:border-0">
              <p className="text-sm font-medium text-gray-900">{entry.label}</p>
              {entry.detail && <p className="text-sm text-gray-600">{entry.detail}</p>}
              <p className="text-xs text-gray-400">{new Date(entry.at).toLocaleString()}</p>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
