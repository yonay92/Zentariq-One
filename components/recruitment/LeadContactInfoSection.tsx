'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { usePermissions } from '@/hooks/usePermissions';
import type {
  LeadPreferredContactMethod,
  LeadContactInfo as ContactInfo,
  DuplicateMatch,
  DuplicateMatchReason,
} from '@/types/recruitment';

const CONTACT_METHOD_OPTIONS: Array<{ value: LeadPreferredContactMethod; label: string }> = [
  { value: 'phone', label: 'Phone' },
  { value: 'email', label: 'Email' },
  { value: 'sms', label: 'SMS' },
];

const DUPLICATE_REASON_LABEL: Record<DuplicateMatchReason, string> = {
  phone_match: 'same phone number',
  email_match: 'same email address',
  name_dob_match: 'same name and date of birth',
  name_postal_code_match: 'same name and postal code',
};

type FormState = {
  first_name: string;
  last_name: string;
  date_of_birth: string;
  sex: string;
  phone_primary: string;
  phone_secondary: string;
  email: string;
  preferred_contact_method: LeadPreferredContactMethod;
};

const EMPTY_FORM: FormState = {
  first_name: '',
  last_name: '',
  date_of_birth: '',
  sex: '',
  phone_primary: '',
  phone_secondary: '',
  email: '',
  preferred_contact_method: 'phone',
};

function toFormState(contactInfo: ContactInfo): FormState {
  return {
    first_name: contactInfo.first_name,
    last_name: contactInfo.last_name,
    date_of_birth: contactInfo.date_of_birth ?? '',
    sex: contactInfo.sex ?? '',
    phone_primary: contactInfo.phone_primary,
    phone_secondary: contactInfo.phone_secondary ?? '',
    email: contactInfo.email ?? '',
    preferred_contact_method: contactInfo.preferred_contact_method,
  };
}

export function LeadContactInfoSection({
  leadId,
  onSaved,
}: {
  leadId: string;
  onSaved?: () => void;
}) {
  const { hasPermission } = usePermissions();
  const canView = hasPermission('view_lead_phi');
  const canEdit = hasPermission('edit_lead_phi');

  const [contactInfo, setContactInfo] = useState<ContactInfo | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateMatches, setDuplicateMatches] = useState<DuplicateMatch[]>([]);

  const fetchContactInfo = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/leads/${leadId}/contact-info`);
      if (res.ok) {
        const json = (await res.json()) as { data: ContactInfo | null };
        setContactInfo(json.data);
        setForm(json.data ? toFormState(json.data) : EMPTY_FORM);
        setEditing(!json.data);
      }
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    if (canView) void fetchContactInfo();
    else setLoading(false);
  }, [canView, fetchContactInfo]);

  async function handleSave(skipDuplicateCheck = false) {
    // Duplicate detection only makes sense for a genuinely new person's
    // record — never re-run once contact info already exists, and never
    // silently block or merge (business rule): a match is a warning the
    // caller must explicitly acknowledge via "Save Anyway", not a hard stop.
    // skipDuplicateCheck (rather than reading the duplicatesAcknowledged
    // state) avoids a stale-closure read on the very call that sets it.
    if (!contactInfo && !skipDuplicateCheck) {
      try {
        const dupRes = await fetch('/api/leads/check-duplicates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phone: form.phone_primary.trim() || undefined,
            email: form.email.trim() || undefined,
            first_name: form.first_name.trim() || undefined,
            last_name: form.last_name.trim() || undefined,
            date_of_birth: form.date_of_birth || undefined,
          }),
        });
        if (dupRes.ok) {
          const json = (await dupRes.json()) as {
            data?: { possible_matches: DuplicateMatch[] };
          };
          const matches = json.data?.possible_matches ?? [];
          if (matches.length > 0) {
            setDuplicateMatches(matches);
            return;
          }
        }
      } catch {
        // Duplicate check failing must never block saving real contact info.
      }
    }

    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/contact-info`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          date_of_birth: form.date_of_birth || undefined,
          sex: form.sex.trim() || undefined,
          phone_secondary: form.phone_secondary.trim() || undefined,
          email: form.email.trim() || undefined,
        }),
      });
      const json = (await res.json()) as {
        success: boolean;
        data?: ContactInfo;
        error?: { message: string };
      };
      if (!res.ok || !json.success) {
        setError(json.error?.message ?? 'Failed to save contact information');
        return;
      }
      setContactInfo(json.data ?? null);
      setEditing(false);
      setDuplicateMatches([]);
      onSaved?.();
    } catch {
      setError('An unexpected error occurred');
    } finally {
      setSaving(false);
    }
  }

  if (!canView) {
    return (
      <EmptyState
        title="Restricted"
        description="You do not have permission to view this lead's contact information."
      />
    );
  }

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  if (!editing && contactInfo) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">Contact Information</h3>
          {canEdit && (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-gray-500">Name</dt>
            <dd className="mt-0.5 text-gray-900">
              {contactInfo.first_name} {contactInfo.last_name}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Date of Birth</dt>
            <dd className="mt-0.5 text-gray-900">{contactInfo.date_of_birth ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Sex</dt>
            <dd className="mt-0.5 text-gray-900">{contactInfo.sex ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Primary Phone</dt>
            <dd className="mt-0.5 text-gray-900">{contactInfo.phone_primary}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Secondary Phone</dt>
            <dd className="mt-0.5 text-gray-900">{contactInfo.phone_secondary ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Email</dt>
            <dd className="mt-0.5 text-gray-900">{contactInfo.email ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Preferred Contact Method</dt>
            <dd className="mt-0.5 text-gray-900 capitalize">
              {contactInfo.preferred_contact_method}
            </dd>
          </div>
        </dl>
      </div>
    );
  }

  if (!canEdit) {
    return (
      <EmptyState
        title="No contact information on file"
        description="You do not have permission to add it."
      />
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <h3 className="mb-3 text-sm font-semibold text-gray-900">
        {contactInfo ? 'Edit Contact Information' : 'Add Contact Information'}
      </h3>
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="First Name"
          value={form.first_name}
          onChange={(e) => setForm({ ...form, first_name: e.target.value })}
        />
        <Input
          label="Last Name"
          value={form.last_name}
          onChange={(e) => setForm({ ...form, last_name: e.target.value })}
        />
        <Input
          label="Date of Birth (optional)"
          type="date"
          value={form.date_of_birth}
          onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })}
        />
        <Input
          label="Sex (optional)"
          value={form.sex}
          onChange={(e) => setForm({ ...form, sex: e.target.value })}
        />
        <Input
          label="Primary Phone"
          value={form.phone_primary}
          onChange={(e) => setForm({ ...form, phone_primary: e.target.value })}
        />
        <Input
          label="Secondary Phone (optional)"
          value={form.phone_secondary}
          onChange={(e) => setForm({ ...form, phone_secondary: e.target.value })}
        />
        <Input
          label="Email (optional)"
          type="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
        <Select
          label="Preferred Contact Method"
          value={form.preferred_contact_method}
          onChange={(e) =>
            setForm({
              ...form,
              preferred_contact_method: e.target.value as LeadPreferredContactMethod,
            })
          }
          options={CONTACT_METHOD_OPTIONS}
        />
      </div>

      {duplicateMatches.length > 0 && (
        <div className="mt-3 rounded-md border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
          <p className="mb-1 font-medium">
            {duplicateMatches.length} possible existing lead
            {duplicateMatches.length > 1 ? 's' : ''} matched this information:
          </p>
          <ul className="mb-2 list-disc pl-5">
            {duplicateMatches.map((m) => (
              <li key={m.lead_id}>
                {m.initials ?? 'Lead'} — {m.status.replace(/_/g, ' ')}
                {m.archived ? ' (archived)' : ''} —{' '}
                {m.match_reasons.map((r) => DUPLICATE_REASON_LABEL[r]).join(', ')}
              </li>
            ))}
          </ul>
          <p>This is not automatically merged. Confirm this is a different person before saving.</p>
        </div>
      )}

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <div className="mt-4 flex justify-end gap-3">
        {contactInfo && (
          <Button variant="outline" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        )}
        {duplicateMatches.length > 0 ? (
          <Button
            variant="danger"
            loading={saving}
            disabled={saving}
            onClick={() => void handleSave(true)}
          >
            Save Anyway
          </Button>
        ) : (
          <Button loading={saving} disabled={saving} onClick={() => void handleSave()}>
            Save
          </Button>
        )}
      </div>
    </div>
  );
}
