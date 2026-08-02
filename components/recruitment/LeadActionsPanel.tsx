'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { usePermissions } from '@/hooks/usePermissions';
import { LEAD_STATUS_VARIANT } from '@/components/recruitment/leadStatusVariant';
import type { Lead, LeadContactLogEntry, LeadStatus } from '@/types/recruitment';
import type { Profile } from '@/types/users';

const CONTACT_STATUS_OPTIONS: Array<{ value: LeadStatus; label: string }> = [
  { value: 'contacted', label: 'Contacted' },
  { value: 'prescreening', label: 'In Prescreening' },
];

const ALL_STATUS_OPTIONS: Array<{ value: LeadStatus; label: string }> = (
  Object.keys(LEAD_STATUS_VARIANT) as LeadStatus[]
)
  .filter((s) => s !== 'converted')
  .map((status) => ({ value: status, label: status.replace(/_/g, ' ') }));

export function LeadActionsPanel({ lead, onChanged }: { lead: Lead; onChanged: () => void }) {
  const { hasPermission } = usePermissions();
  const canViewPhi = hasPermission('view_lead_phi');
  const canEditPhi = hasPermission('edit_lead_phi');
  const canEdit = hasPermission('edit_lead');
  const canConvert = hasPermission('convert_lead');
  const canAssign = hasPermission('assign_lead');
  const canArchive = hasPermission('archive_lead');

  const [log, setLog] = useState<LeadContactLogEntry[]>([]);
  const [loadingLog, setLoadingLog] = useState(true);
  const [users, setUsers] = useState<Profile[]>([]);

  const [contactOpen, setContactOpen] = useState(false);
  const [contactStatus, setContactStatus] = useState<LeadStatus>('contacted');
  const [contactNotes, setContactNotes] = useState('');
  const [contactOverrideReason, setContactOverrideReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState('');

  const [convertOpen, setConvertOpen] = useState(false);
  const [subjectNumber, setSubjectNumber] = useState('');

  const [statusOpen, setStatusOpen] = useState(false);
  const [newStatus, setNewStatus] = useState<LeadStatus>('contacted');
  const [statusReason, setStatusReason] = useState('');

  const [assignOpen, setAssignOpen] = useState(false);
  const [assignedUserId, setAssignedUserId] = useState('');

  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveReason, setArchiveReason] = useState('');

  const isTerminal = [
    'converted',
    'declined',
    'lost',
    'not_interested',
    'not_qualified',
    'screen_failed',
    'withdrawn',
  ].includes(lead.status);

  const fetchLog = useCallback(async () => {
    if (!canViewPhi) {
      setLoadingLog(false);
      return;
    }
    setLoadingLog(true);
    try {
      const res = await fetch(`/api/leads/${lead.id}/contact-log`);
      if (res.ok) {
        const json = (await res.json()) as { data: LeadContactLogEntry[] };
        setLog(json.data);
      }
    } finally {
      setLoadingLog(false);
    }
  }, [lead.id, canViewPhi]);

  useEffect(() => {
    void fetchLog();
  }, [fetchLog]);

  useEffect(() => {
    if (!canAssign) return;
    void (async () => {
      const res = await fetch('/api/users');
      if (res.ok) setUsers(((await res.json()) as { data: Profile[] }).data);
    })();
  }, [canAssign]);

  async function handleLogContact() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${lead.id}/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          new_status: contactStatus,
          notes: contactNotes.trim() || undefined,
          override_reason: lead.do_not_contact
            ? contactOverrideReason.trim() || undefined
            : undefined,
        }),
      });
      const json = (await res.json()) as { success: boolean; error?: { message: string } };
      if (!res.ok || !json.success) {
        setError(json.error?.message ?? 'Failed to log contact attempt');
        return;
      }
      setContactOpen(false);
      setContactNotes('');
      setContactOverrideReason('');
      onChanged();
      void fetchLog();
    } catch {
      setError('An unexpected error occurred');
    } finally {
      setBusy(false);
    }
  }

  async function handleWaitlist() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${lead.id}/waitlist`, { method: 'POST' });
      const json = (await res.json()) as { success: boolean; error?: { message: string } };
      if (!res.ok || !json.success) {
        setError(json.error?.message ?? 'Failed to waitlist lead');
        return;
      }
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function handleDecline() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${lead.id}/decline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ declined_reason: declineReason }),
      });
      const json = (await res.json()) as { success: boolean; error?: { message: string } };
      if (!res.ok || !json.success) {
        setError(json.error?.message ?? 'Failed to decline lead');
        return;
      }
      setDeclineOpen(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function handleConvert() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${lead.id}/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject_number: subjectNumber }),
      });
      const json = (await res.json()) as { success: boolean; error?: { message: string } };
      if (!res.ok || !json.success) {
        setError(json.error?.message ?? 'Failed to convert lead');
        return;
      }
      setConvertOpen(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function handleChangeStatus() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${lead.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_status: newStatus, reason: statusReason.trim() || undefined }),
      });
      const json = (await res.json()) as { success: boolean; error?: { message: string } };
      if (!res.ok || !json.success) {
        setError(json.error?.message ?? 'Failed to change status');
        return;
      }
      setStatusOpen(false);
      setStatusReason('');
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function handleAssign() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${lead.id}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assigned_user_id: assignedUserId || null }),
      });
      const json = (await res.json()) as { success: boolean; error?: { message: string } };
      if (!res.ok || !json.success) {
        setError(json.error?.message ?? 'Failed to assign lead');
        return;
      }
      setAssignOpen(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function handleArchive() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${lead.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: archiveReason.trim() || undefined }),
      });
      const json = (await res.json()) as { success: boolean; error?: { message: string } };
      if (!res.ok || !json.success) {
        setError(json.error?.message ?? 'Failed to archive lead');
        return;
      }
      setArchiveOpen(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  if (loadingLog) {
    return (
      <div className="flex justify-center py-4">
        <LoadingSpinner size="sm" />
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <h3 className="mb-3 text-sm font-semibold text-gray-900">Pipeline Actions</h3>

      {lead.archived_at ? (
        <p className="text-sm text-gray-500">This lead is archived.</p>
      ) : (
        <>
          {lead.do_not_contact && (
            <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
              Do not contact{lead.do_not_contact_reason ? `: ${lead.do_not_contact_reason}` : ''}.
              Contact actions require an authorized override.
            </p>
          )}

          {isTerminal ? (
            <p className="text-sm text-gray-500">
              This lead is {lead.status.replace(/_/g, ' ')} — no further pipeline actions available.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {canEditPhi && (
                <Button size="sm" onClick={() => setContactOpen(true)}>
                  Log Contact Attempt
                </Button>
              )}
              {canEdit && (
                <Button size="sm" variant="outline" onClick={() => setStatusOpen(true)}>
                  Change Status
                </Button>
              )}
              {canEdit && (
                <Button
                  size="sm"
                  variant="outline"
                  loading={busy}
                  onClick={() => void handleWaitlist()}
                >
                  Waitlist
                </Button>
              )}
              {canConvert && (
                <Button size="sm" variant="outline" onClick={() => setConvertOpen(true)}>
                  Convert to Subject
                </Button>
              )}
              {canEdit && (
                <Button size="sm" variant="ghost" onClick={() => setDeclineOpen(true)}>
                  Decline
                </Button>
              )}
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-2 border-t border-gray-100 pt-3">
            {canAssign && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setAssignedUserId(lead.assigned_user_id ?? '');
                  setAssignOpen(true);
                }}
              >
                {lead.assigned_user_id ? 'Reassign' : 'Assign'}
              </Button>
            )}
            {canArchive && (
              <Button size="sm" variant="ghost" onClick={() => setArchiveOpen(true)}>
                Archive
              </Button>
            )}
          </div>
        </>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {canViewPhi && (
        <div className="mt-4 border-t border-gray-100 pt-4">
          <h4 className="mb-2 text-sm font-semibold text-gray-900">Contact History</h4>
          {log.length === 0 ? (
            <p className="text-sm text-gray-500">No contact attempts logged yet.</p>
          ) : (
            <ul className="space-y-2">
              {log.map((entry) => (
                <li key={entry.id} className="text-sm text-gray-700">
                  <p>
                    {entry.old_status ? entry.old_status.replace(/_/g, ' ') : 'created'} →{' '}
                    {entry.new_status.replace(/_/g, ' ')}
                    {entry.contact_method && ` (${entry.contact_method})`}
                  </p>
                  {entry.notes && <p className="text-gray-600">{entry.notes}</p>}
                  <p className="text-xs text-gray-400">
                    {new Date(entry.contacted_at).toLocaleString()}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Modal open={contactOpen} onClose={() => setContactOpen(false)} title="Log Contact Attempt">
        <div className="space-y-4">
          {lead.do_not_contact && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
              This lead is marked do-not-contact. Logging a contact attempt requires an override
              reason.
            </p>
          )}
          <Select
            label="Outcome"
            value={contactStatus}
            onChange={(e) => setContactStatus(e.target.value as LeadStatus)}
            options={CONTACT_STATUS_OPTIONS}
          />
          <div className="space-y-1">
            <label
              htmlFor="lead-contact-notes"
              className="block text-sm font-medium text-slate-700"
            >
              Notes (optional)
            </label>
            <textarea
              id="lead-contact-notes"
              className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
              rows={3}
              value={contactNotes}
              onChange={(e) => setContactNotes(e.target.value)}
            />
          </div>
          {lead.do_not_contact && (
            <div className="space-y-1">
              <label
                htmlFor="lead-contact-override-reason"
                className="block text-sm font-medium text-slate-700"
              >
                Override reason
              </label>
              <input
                id="lead-contact-override-reason"
                className="block h-9 w-full rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                value={contactOverrideReason}
                onChange={(e) => setContactOverrideReason(e.target.value)}
              />
            </div>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => setContactOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={busy || (lead.do_not_contact && !contactOverrideReason.trim())}
              onClick={() => void handleLogContact()}
            >
              Save
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={declineOpen} onClose={() => setDeclineOpen(false)} title="Decline Lead">
        <div className="space-y-4">
          <div className="space-y-1">
            <label
              htmlFor="lead-decline-reason"
              className="block text-sm font-medium text-slate-700"
            >
              Reason
            </label>
            <textarea
              id="lead-decline-reason"
              className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
              rows={3}
              value={declineReason}
              onChange={(e) => setDeclineReason(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => setDeclineOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={busy || !declineReason.trim()}
              onClick={() => void handleDecline()}
            >
              Decline
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={convertOpen} onClose={() => setConvertOpen(false)} title="Convert to Subject">
        <div className="space-y-4">
          <p className="text-sm text-gray-500">
            This creates a real, enrolled Subject in the matched study using this lead&apos;s
            contact information. Requires the lead to have a supporting prescreening for the matched
            study (any outcome other than Not Eligible).
          </p>
          <div className="space-y-1">
            <label
              htmlFor="lead-subject-number"
              className="block text-sm font-medium text-slate-700"
            >
              Subject number
            </label>
            <input
              id="lead-subject-number"
              className="block h-9 w-full rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
              value={subjectNumber}
              onChange={(e) => setSubjectNumber(e.target.value)}
              placeholder="001-001"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => setConvertOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={busy || !subjectNumber.trim()}
              onClick={() => void handleConvert()}
            >
              Convert
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={statusOpen} onClose={() => setStatusOpen(false)} title="Change Status">
        <div className="space-y-4">
          <Select
            label="New status"
            value={newStatus}
            onChange={(e) => setNewStatus(e.target.value as LeadStatus)}
            options={ALL_STATUS_OPTIONS}
          />
          <div className="space-y-1">
            <label
              htmlFor="lead-status-reason"
              className="block text-sm font-medium text-slate-700"
            >
              Reason (required for an exceptional transition)
            </label>
            <input
              id="lead-status-reason"
              className="block h-9 w-full rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
              value={statusReason}
              onChange={(e) => setStatusReason(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => setStatusOpen(false)}>
              Cancel
            </Button>
            <Button loading={busy} disabled={busy} onClick={() => void handleChangeStatus()}>
              Save
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={assignOpen} onClose={() => setAssignOpen(false)} title="Assign Lead">
        <div className="space-y-4">
          <Select
            label="Assigned to"
            value={assignedUserId}
            onChange={(e) => setAssignedUserId(e.target.value)}
            placeholder="Unassigned"
            options={users.map((u) => ({ value: u.id, label: u.full_name }))}
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => setAssignOpen(false)}>
              Cancel
            </Button>
            <Button loading={busy} disabled={busy} onClick={() => void handleAssign()}>
              Save
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={archiveOpen} onClose={() => setArchiveOpen(false)} title="Archive Lead">
        <div className="space-y-4">
          <p className="text-sm text-gray-500">
            Archiving removes this lead from default active views. It is not deleted and can still
            be found via Include Archived.
          </p>
          <div className="space-y-1">
            <label
              htmlFor="lead-archive-reason"
              className="block text-sm font-medium text-slate-700"
            >
              Reason (optional)
            </label>
            <input
              id="lead-archive-reason"
              className="block h-9 w-full rounded-lg border border-slate-300 px-3 text-sm text-slate-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
              value={archiveReason}
              onChange={(e) => setArchiveReason(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => setArchiveOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={busy}
              onClick={() => void handleArchive()}
            >
              Archive
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
