'use client';

import { useState, useEffect } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import type { Study } from '@/types/studies';

type StudyForm = {
  study_name: string;
  protocol_number: string;
  sponsor: string;
  cro: string;
  phase: string;
  therapeutic_area: string;
  start_date: string;
  end_date: string;
};

function toForm(study: Study): StudyForm {
  return {
    study_name: study.study_name,
    protocol_number: study.protocol_number ?? '',
    sponsor: study.sponsor ?? '',
    cro: study.cro ?? '',
    phase: study.phase ?? '',
    therapeutic_area: study.therapeutic_area ?? '',
    start_date: study.start_date ?? '',
    end_date: study.end_date ?? '',
  };
}

type EditStudyModalProps = {
  study: Study;
  onChanged: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

// Fully controlled — the caller owns open state and renders its own trigger.
// (Previously self-contained with its own internal state and a baked-in
// "Edit" button; lifted out so the ActivationReadiness panel's "Edit Study"
// fix action can open this same modal instead of duplicating a second one.)
export function EditStudyModal({ study, onChanged, open, onOpenChange }: EditStudyModalProps) {
  const [form, setForm] = useState<StudyForm>(() => toForm(study));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(toForm(study));
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function stripEmpty(f: StudyForm): Record<string, string> {
    return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '')) as Record<
      string,
      string
    >;
  }

  async function handleSave() {
    if (!form.study_name.trim()) {
      setError('Study name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/studies/${study.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(stripEmpty(form)),
      });
      const json = (await res.json()) as {
        success: boolean;
        error?: { message?: string };
      };
      if (!res.ok || !json.success) {
        setError(json.error?.message ?? 'Failed to update study');
        return;
      }
      onOpenChange(false);
      onChanged();
    } catch {
      setError('An unexpected error occurred');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={() => onOpenChange(false)} title="Edit Study" size="lg">
      <div className="space-y-4">
        {error && <p className="text-sm text-red-600">{error}</p>}
        <Input
          label="Study name"
          value={form.study_name}
          onChange={(e) => setForm((f) => ({ ...f, study_name: e.target.value }))}
          required
        />
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Protocol number"
            value={form.protocol_number}
            onChange={(e) => setForm((f) => ({ ...f, protocol_number: e.target.value }))}
          />
          <Input
            label="Phase"
            value={form.phase}
            onChange={(e) => setForm((f) => ({ ...f, phase: e.target.value }))}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Sponsor"
            value={form.sponsor}
            onChange={(e) => setForm((f) => ({ ...f, sponsor: e.target.value }))}
          />
          <Input
            label="CRO"
            value={form.cro}
            onChange={(e) => setForm((f) => ({ ...f, cro: e.target.value }))}
          />
        </div>
        <Input
          label="Therapeutic area"
          value={form.therapeutic_area}
          onChange={(e) => setForm((f) => ({ ...f, therapeutic_area: e.target.value }))}
        />
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Start date"
            type="date"
            value={form.start_date}
            onChange={(e) => setForm((f) => ({ ...f, start_date: e.target.value }))}
          />
          <Input
            label="End date"
            type="date"
            value={form.end_date}
            onChange={(e) => setForm((f) => ({ ...f, end_date: e.target.value }))}
          />
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button loading={saving} disabled={saving} onClick={() => void handleSave()}>
            Save Changes
          </Button>
        </div>
      </div>
    </Modal>
  );
}
