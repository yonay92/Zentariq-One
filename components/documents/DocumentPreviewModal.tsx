'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { AlertBanner } from '@/components/ui/AlertBanner';
import { usePermissions } from '@/hooks/usePermissions';
import { formatFileSize } from '@/lib/utils/formatFileSize';
import type { FileWithLinks } from '@/types/files';

export function DocumentPreviewModal({
  file,
  uploaderName,
  onClose,
}: {
  file: FileWithLinks | null;
  uploaderName: string;
  onClose: () => void;
}) {
  const { hasPermission } = usePermissions();
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!file) return null;

  async function handleDownload() {
    if (!file) return;
    setDownloading(true);
    setError(null);
    try {
      const res = await fetch(`/api/files/${file.id}/signed-url`);
      const json = (await res.json()) as { success: boolean; data?: { url: string } };
      if (!res.ok || !json.success || !json.data) {
        setError('Failed to generate a download link');
        return;
      }
      // A fresh signed URL is fetched on every click — never cached, never
      // rendered as a persistent href — per Milestone 1's "signed URLs are
      // issued only after authorization, right before use" model.
      window.open(json.data.url, '_blank', 'noopener,noreferrer');
    } catch {
      setError('Failed to generate a download link');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Modal open={Boolean(file)} onClose={onClose} title={file.file_name} size="md">
      {error && (
        <div className="mb-4">
          <AlertBanner variant="error" message={error} onDismiss={() => setError(null)} />
        </div>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <div>
          <dt className="text-slate-500">File Size</dt>
          <dd className="font-medium text-slate-900">{formatFileSize(file.file_size)}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Type</dt>
          <dd className="font-medium text-slate-900">{file.mime_type ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Uploaded By</dt>
          <dd className="font-medium text-slate-900">{uploaderName}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Uploaded At</dt>
          <dd className="font-medium text-slate-900">
            {new Date(file.uploaded_at).toLocaleString()}
          </dd>
        </div>
      </dl>

      <div className="mt-5">
        <h3 className="mb-2 text-sm font-semibold text-slate-900">Linked Records</h3>
        {file.links.length === 0 ? (
          <p className="text-sm text-slate-500">No linked records</p>
        ) : (
          <ul className="space-y-1.5">
            {file.links.map((link) => (
              <li key={link.id} className="flex items-center gap-2 text-sm">
                <Badge variant="info">{link.module}</Badge>
                <span className="text-slate-600">{link.record_id}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-6 flex justify-end gap-2 border-t border-slate-100 pt-4">
        {hasPermission('view_documents') && (
          <Button variant="primary" loading={downloading} onClick={() => void handleDownload()}>
            Download
          </Button>
        )}
      </div>
    </Modal>
  );
}
