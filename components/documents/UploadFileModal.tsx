'use client';

import { useState, useRef, type DragEvent } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { AlertBanner } from '@/components/ui/AlertBanner';
import type { FileRecord } from '@/types/files';

export function UploadFileModal({
  open,
  onClose,
  onUploaded,
}: {
  open: boolean;
  onClose: () => void;
  onUploaded: (file: FileRecord) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch('/api/files/upload', { method: 'POST', body: formData });
      const json = (await res.json()) as { success: boolean; data?: FileRecord; message?: string };
      if (!res.ok || !json.success || !json.data) {
        setError(json.message ?? 'Failed to upload file');
        return;
      }
      onUploaded(json.data);
      onClose();
    } catch {
      setError('Failed to upload file');
    } finally {
      setUploading(false);
    }
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void upload(file);
  }

  return (
    <Modal open={open} onClose={onClose} title="Upload File" size="sm">
      {error && (
        <div className="mb-4">
          <AlertBanner variant="error" message={error} onDismiss={() => setError(null)} />
        </div>
      )}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
          dragActive ? 'border-blue-400 bg-blue-50' : 'border-slate-300'
        }`}
      >
        <p className="mb-3 text-sm text-slate-600">Drag and drop a file here, or</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={uploading}
          onClick={() => inputRef.current?.click()}
        >
          Choose File
        </Button>
        <input
          ref={inputRef}
          id="document-center-file"
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
            e.target.value = '';
          }}
        />
      </div>
    </Modal>
  );
}
