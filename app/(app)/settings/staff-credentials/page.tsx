'use client';

import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { AlertBanner } from '@/components/ui/AlertBanner';
import { EmptyState } from '@/components/ui/EmptyState';
import { usePermissions } from '@/hooks/usePermissions';
import { DocumentStatusBadge } from '@/components/regulatory/statusBadge';
import { UploadDocumentModal } from '@/components/regulatory/UploadDocumentModal';
import { ArchiveDocumentModal } from '@/components/regulatory/ArchiveDocumentModal';
import { DocumentHistoryDrawer } from '@/components/regulatory/DocumentHistoryDrawer';
import type { StaffDocumentWithType, DocumentType } from '@/types/regulatory';
import type { Profile } from '@/types/users';

export default function StaffCredentialsPage() {
  const { hasPermission, loading: permissionsLoading } = usePermissions();
  const canViewOthers = hasPermission('view_staff_credentials');
  const canManage = hasPermission('manage_staff_credentials');

  const [me, setMe] = useState<Profile | null>(null);
  const [users, setUsers] = useState<Profile[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [credentials, setCredentials] = useState<StaffDocumentWithType[]>([]);
  const [documentTypes, setDocumentTypes] = useState<DocumentType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [uploadOpen, setUploadOpen] = useState<
    { kind: 'create' } | { kind: 'replace'; documentId: string; currentDocumentName: string } | null
  >(null);
  const [archiveTarget, setArchiveTarget] = useState<{ id: string; name: string } | null>(null);
  const [historyTarget, setHistoryTarget] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    void (async () => {
      const meRes = await fetch('/api/users/me');
      if (meRes.ok) {
        const json = (await meRes.json()) as { data: { profile: Profile } };
        setMe(json.data.profile);
        setSelectedUserId(json.data.profile.id);
      }
      const typesRes = await fetch('/api/regulatory/document-types');
      if (typesRes.ok) {
        setDocumentTypes(((await typesRes.json()) as { data: DocumentType[] }).data);
      }
    })();
  }, []);

  useEffect(() => {
    if (!canViewOthers || permissionsLoading) return;
    void (async () => {
      const res = await fetch('/api/users');
      if (res.ok) {
        const json = (await res.json()) as { data?: Profile[] | null };
        setUsers(Array.isArray(json.data) ? json.data : []);
      }
    })();
  }, [canViewOthers, permissionsLoading]);

  const fetchCredentials = useCallback(async () => {
    if (!selectedUserId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/staff-credentials?user_id=${selectedUserId}`);
      if (!res.ok) throw new Error('Failed to load credentials');
      const json = (await res.json()) as { data: StaffDocumentWithType[] };
      setCredentials(json.data);
    } catch {
      setError('Failed to load staff credentials. Please refresh.');
    } finally {
      setLoading(false);
    }
  }, [selectedUserId]);

  useEffect(() => {
    void fetchCredentials();
  }, [fetchCredentials]);

  const isOwnRecord = selectedUserId === me?.id;
  const canManageSelected = canManage && !isOwnRecord ? true : canManage;

  return (
    <div>
      <PageHeader
        title="Staff Credentials"
        description="CVs, GCP training certificates, licenses, and other staff-level regulatory documents"
        action={
          canManageSelected ? (
            <Button size="sm" onClick={() => setUploadOpen({ kind: 'create' })}>
              Upload Credential
            </Button>
          ) : undefined
        }
      />

      {canViewOthers && users.length > 0 && (
        <div className="mb-4 max-w-xs">
          <Select
            label="Staff Member"
            value={selectedUserId}
            onChange={(e) => setSelectedUserId(e.target.value)}
            options={users.map((u) => ({ value: u.id, label: u.full_name }))}
          />
        </div>
      )}

      {error && (
        <div className="mb-4">
          <AlertBanner variant="error" message={error} onDismiss={() => setError(null)} />
        </div>
      )}

      {loading ? (
        <div className="flex h-48 items-center justify-center">
          <LoadingSpinner size="lg" />
        </div>
      ) : credentials.length === 0 ? (
        <EmptyState
          title="No credentials on file"
          description={
            canManageSelected
              ? 'Upload a credential to get started.'
              : 'This staff member has no credentials on file yet.'
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Credential</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Version</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Expiration</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {credentials.map((cred) => (
                <tr key={cred.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{cred.document_type.name}</td>
                  <td className="px-4 py-3 text-gray-600">{cred.version ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{cred.expiration_date ?? '—'}</td>
                  <td className="px-4 py-3">
                    <DocumentStatusBadge status={cred.status} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      {canManageSelected && cred.status !== 'archived' && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setUploadOpen({
                              kind: 'replace',
                              documentId: cred.id,
                              currentDocumentName: cred.document_type.name,
                            })
                          }
                        >
                          Replace
                        </Button>
                      )}
                      {canManageSelected && cred.status !== 'archived' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setArchiveTarget({ id: cred.id, name: cred.document_type.name })
                          }
                        >
                          Archive
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setHistoryTarget({ id: cred.id, name: cred.document_type.name })
                        }
                      >
                        History
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {uploadOpen && (
        <UploadDocumentModal
          open={true}
          onClose={() => setUploadOpen(null)}
          onSaved={() => void fetchCredentials()}
          documentTypes={documentTypes}
          target="staff-credential"
          scope={{ staffUserId: selectedUserId }}
          mode={uploadOpen}
        />
      )}
      {archiveTarget && (
        <ArchiveDocumentModal
          open={true}
          onClose={() => setArchiveTarget(null)}
          onArchived={() => void fetchCredentials()}
          documentId={archiveTarget.id}
          documentName={archiveTarget.name}
          basePath="staff-credentials"
        />
      )}
      {historyTarget && (
        <DocumentHistoryDrawer
          open={true}
          onClose={() => setHistoryTarget(null)}
          documentId={historyTarget.id}
          documentName={historyTarget.name}
          basePath="staff-credentials"
        />
      )}
    </div>
  );
}
