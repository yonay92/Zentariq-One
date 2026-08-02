'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { usePermissions } from '@/hooks/usePermissions';
import type { CallDirection, CallOutcome, Lead, LeadCall } from '@/types/recruitment';

const DIRECTION_OPTIONS: Array<{ value: CallDirection; label: string }> = [
  { value: 'outbound', label: 'Outbound' },
  { value: 'inbound', label: 'Inbound' },
];

const OUTCOME_OPTIONS: Array<{ value: CallOutcome; label: string }> = [
  { value: 'answered', label: 'Answered' },
  { value: 'no_answer', label: 'No Answer' },
  { value: 'voicemail_left', label: 'Voicemail Left' },
  { value: 'busy', label: 'Busy' },
  { value: 'wrong_number', label: 'Wrong Number' },
  { value: 'disconnected', label: 'Disconnected' },
  { value: 'interested', label: 'Interested' },
  { value: 'not_interested', label: 'Not Interested' },
  { value: 'callback_requested', label: 'Callback Requested' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'other', label: 'Other' },
];

export function LeadCallsSection({ lead }: { lead: Lead }) {
  const { hasPermission } = usePermissions();
  const canLog = hasPermission('log_lead_call');

  const [calls, setCalls] = useState<LeadCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [direction, setDirection] = useState<CallDirection>('outbound');
  const [outcome, setOutcome] = useState<CallOutcome>('answered');
  const [summary, setSummary] = useState('');
  const [overrideReason, setOverrideReason] = useState('');

  const fetchCalls = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/leads/${lead.id}/calls`);
      if (res.ok) {
        const json = (await res.json()) as { data: LeadCall[] };
        setCalls(json.data);
      }
    } finally {
      setLoading(false);
    }
  }, [lead.id]);

  useEffect(() => {
    if (canLog) void fetchCalls();
    else setLoading(false);
  }, [canLog, fetchCalls]);

  async function handleLog() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${lead.id}/calls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          direction,
          outcome,
          started_at: new Date().toISOString(),
          summary: summary.trim() || undefined,
          override_reason: lead.do_not_contact ? overrideReason.trim() || undefined : undefined,
        }),
      });
      const json = (await res.json()) as { success: boolean; error?: { message: string } };
      if (!res.ok || !json.success) {
        setError(json.error?.message ?? 'Failed to log call');
        return;
      }
      setOpen(false);
      setSummary('');
      setOverrideReason('');
      void fetchCalls();
    } finally {
      setSaving(false);
    }
  }

  if (!canLog) return null;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">Calls</h3>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Log Call
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-4">
          <LoadingSpinner size="sm" />
        </div>
      ) : calls.length === 0 ? (
        <p className="text-sm text-gray-500">No calls logged yet.</p>
      ) : (
        <ul className="space-y-2">
          {calls.map((call) => (
            <li key={call.id} className="text-sm text-gray-700">
              <p className="capitalize">
                {call.direction} · {call.outcome.replace(/_/g, ' ')}
              </p>
              {call.summary && <p className="text-gray-600">{call.summary}</p>}
              <p className="text-xs text-gray-400">{new Date(call.started_at).toLocaleString()}</p>
            </li>
          ))}
        </ul>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Log Call">
        <div className="space-y-4">
          {lead.do_not_contact && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
              This lead is marked do-not-contact. Logging a call requires an override reason.
            </p>
          )}
          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Direction"
              value={direction}
              onChange={(e) => setDirection(e.target.value as CallDirection)}
              options={DIRECTION_OPTIONS}
            />
            <Select
              label="Outcome"
              value={outcome}
              onChange={(e) => setOutcome(e.target.value as CallOutcome)}
              options={OUTCOME_OPTIONS}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="call-summary" className="block text-sm font-medium text-slate-700">
              Summary (optional)
            </label>
            <textarea
              id="call-summary"
              className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
              rows={3}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
          </div>
          {lead.do_not_contact && (
            <Input
              label="Override reason"
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              placeholder="Required to log a call on a do-not-contact lead"
            />
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={saving}
              disabled={saving || (lead.do_not_contact && !overrideReason.trim())}
              onClick={() => void handleLog()}
            >
              Save
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
