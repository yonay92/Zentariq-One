'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { Table, type Column } from '@/components/ui/Table';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { AlertBanner } from '@/components/ui/AlertBanner';
import { usePermissions } from '@/hooks/usePermissions';
import { formatFileSize } from '@/lib/utils/formatFileSize';
import { UploadFileModal } from './UploadFileModal';
import { DocumentPreviewModal } from './DocumentPreviewModal';
import type { FileWithLinks, FileRecord } from '@/types/files';
import type { Profile } from '@/types/users';

type ViewMode = 'list' | 'grid';

export function DocumentCenterView() {
  const { hasPermission, loading: permissionsLoading } = usePermissions();
  const [files, setFiles] = useState<FileWithLinks[]>([]);
  const [users, setUsers] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [moduleFilter, setModuleFilter] = useState('');
  const [uploaderFilter, setUploaderFilter] = useState('');
  const [uploadedAfter, setUploadedAfter] = useState('');
  const [uploadedBefore, setUploadedBefore] = useState('');
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [previewFile, setPreviewFile] = useState<FileWithLinks | null>(null);

  const uploaderNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const user of users) map.set(user.id, user.full_name);
    return map;
  }, [users]);

  const fetchFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (moduleFilter) params.set('module', moduleFilter);
      if (uploaderFilter) params.set('uploaded_by', uploaderFilter);
      if (uploadedAfter) params.set('uploaded_after', uploadedAfter);
      if (uploadedBefore) params.set('uploaded_before', uploadedBefore);

      const res = await fetch(`/api/files?${params.toString()}`);
      if (res.status === 403) {
        setError('You do not have permission to view the Document Center.');
        setFiles([]);
        return;
      }
      if (!res.ok) {
        setError('Failed to load documents. Please refresh.');
        return;
      }
      const json = (await res.json()) as { data: FileWithLinks[] };
      setFiles(json.data);
    } catch {
      setError('Failed to load documents. Please refresh.');
    } finally {
      setLoading(false);
    }
  }, [moduleFilter, uploaderFilter, uploadedAfter, uploadedBefore]);

  useEffect(() => {
    void fetchFiles();
  }, [fetchFiles]);

  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/users');
      if (res.ok) setUsers(((await res.json()) as { data: Profile[] }).data);
    })();
  }, []);

  const moduleOptions = useMemo(() => {
    const modules = new Set<string>();
    for (const file of files) {
      for (const link of file.links) modules.add(link.module);
    }
    return Array.from(modules).sort();
  }, [files]);

  function handleUploaded(uploaded: FileRecord) {
    setFiles((prev) => [{ ...uploaded, links: [] }, ...prev]);
  }

  function resetFilters() {
    setModuleFilter('');
    setUploaderFilter('');
    setUploadedAfter('');
    setUploadedBefore('');
  }

  const columns: Column<FileWithLinks>[] = [
    { key: 'name', header: 'Name', render: (f) => f.file_name },
    { key: 'size', header: 'Size', render: (f) => formatFileSize(f.file_size) },
    {
      key: 'uploaded_by',
      header: 'Uploaded By',
      render: (f) => (f.uploaded_by ? (uploaderNameById.get(f.uploaded_by) ?? '—') : '—'),
    },
    {
      key: 'uploaded_at',
      header: 'Uploaded At',
      render: (f) => new Date(f.uploaded_at).toLocaleDateString(),
    },
    {
      key: 'linked',
      header: 'Linked',
      render: (f) => (f.links.length > 0 ? f.links.map((l) => l.module).join(', ') : '—'),
    },
    {
      key: 'actions',
      header: '',
      render: (f) => (
        <Button size="sm" variant="outline" onClick={() => setPreviewFile(f)}>
          View
        </Button>
      ),
    },
  ];

  if (permissionsLoading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div>
      {error && (
        <div className="mb-4">
          <AlertBanner variant="error" message={error} onDismiss={() => setError(null)} />
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <Select
            label="Module"
            aria-label="Module"
            value={moduleFilter}
            onChange={(e) => setModuleFilter(e.target.value)}
            options={[
              { value: '', label: 'All modules' },
              ...moduleOptions.map((m) => ({ value: m, label: m })),
            ]}
          />
          <Select
            label="Uploader"
            aria-label="Uploader"
            value={uploaderFilter}
            onChange={(e) => setUploaderFilter(e.target.value)}
            options={[
              { value: '', label: 'All uploaders' },
              ...users.map((u) => ({ value: u.id, label: u.full_name })),
            ]}
          />
          <Input
            label="Uploaded After"
            aria-label="Uploaded After"
            type="date"
            value={uploadedAfter}
            onChange={(e) => setUploadedAfter(e.target.value)}
          />
          <Input
            label="Uploaded Before"
            aria-label="Uploaded Before"
            type="date"
            value={uploadedBefore}
            onChange={(e) => setUploadedBefore(e.target.value)}
          />
          <Button variant="ghost" size="sm" onClick={resetFilters}>
            Reset filters
          </Button>
        </div>

        <div className="flex items-end gap-3">
          <div className="flex overflow-hidden rounded-lg border border-slate-300">
            <button
              type="button"
              onClick={() => setViewMode('list')}
              aria-pressed={viewMode === 'list'}
              className={`px-3 py-1.5 text-sm font-medium ${
                viewMode === 'list' ? 'bg-blue-600 text-white' : 'bg-white text-slate-700'
              }`}
            >
              List
            </button>
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              aria-pressed={viewMode === 'grid'}
              className={`px-3 py-1.5 text-sm font-medium ${
                viewMode === 'grid' ? 'bg-blue-600 text-white' : 'bg-white text-slate-700'
              }`}
            >
              Grid
            </button>
          </div>
          {hasPermission('upload_documents') && (
            <Button onClick={() => setUploadModalOpen(true)}>Upload File</Button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="flex h-48 items-center justify-center">
          <LoadingSpinner size="lg" />
        </div>
      ) : files.length === 0 ? (
        <EmptyState title="No documents yet" description="Upload a file to get started." />
      ) : viewMode === 'list' ? (
        <Table columns={columns} data={files} rowKey={(f) => f.id} />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {files.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setPreviewFile(f)}
              className="flex flex-col items-start rounded-xl border border-slate-200 bg-white p-4 text-left transition-colors hover:bg-slate-50"
            >
              <span className="mb-1 line-clamp-2 text-sm font-medium text-slate-900">
                {f.file_name}
              </span>
              <span className="text-xs text-slate-500">{formatFileSize(f.file_size)}</span>
            </button>
          ))}
        </div>
      )}

      <UploadFileModal
        open={uploadModalOpen}
        onClose={() => setUploadModalOpen(false)}
        onUploaded={handleUploaded}
      />

      <DocumentPreviewModal
        file={previewFile}
        uploaderName={
          previewFile?.uploaded_by ? (uploaderNameById.get(previewFile.uploaded_by) ?? '—') : '—'
        }
        onClose={() => setPreviewFile(null)}
      />
    </div>
  );
}
