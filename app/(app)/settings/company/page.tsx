'use client';

import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { AlertBanner } from '@/components/ui/AlertBanner';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import type { CompanySettings } from '@/types/users';

const TIMEZONE_OPTIONS = [
  { value: 'America/New_York', label: 'Eastern Time (ET)' },
  { value: 'America/Chicago', label: 'Central Time (CT)' },
  { value: 'America/Denver', label: 'Mountain Time (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
  { value: 'UTC', label: 'UTC' },
  { value: 'Europe/London', label: 'London (GMT)' },
  { value: 'Europe/Paris', label: 'Paris (CET)' },
];

const DATE_FORMAT_OPTIONS = [
  { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY' },
  { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY' },
  { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD (ISO)' },
];

const LANGUAGE_OPTIONS = [{ value: 'en', label: 'English' }];

type SettingsForm = {
  default_timezone: string;
  date_format: string;
  language: string;
  primary_color: string;
  secondary_color: string;
  enable_ai: boolean;
  enable_task_center: boolean;
};

export default function CompanySettingsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<SettingsForm>({
    default_timezone: 'America/New_York',
    date_format: 'MM/DD/YYYY',
    language: 'en',
    primary_color: '#2563eb',
    secondary_color: '#64748b',
    enable_ai: true,
    enable_task_center: true,
  });
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/company/settings');
      if (!res.ok) throw new Error('Failed to load settings');
      const json = (await res.json()) as { data: { settings: CompanySettings | null } };
      const s = json.data.settings;
      if (s) {
        setForm({
          default_timezone: s.default_timezone,
          date_format: s.date_format,
          language: s.language,
          primary_color: s.primary_color,
          secondary_color: s.secondary_color,
          enable_ai: s.enable_ai,
          enable_task_center: s.enable_task_center,
        });
      }
    } catch {
      setError('Failed to load settings. Please refresh.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      const res = await fetch('/api/company/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const json = (await res.json()) as { success: boolean; message?: string };
      if (!res.ok || !json.success) {
        setSaveError(json.message ?? 'Failed to save settings');
        return;
      }
      setSaveSuccess(true);
      void fetchSettings();
    } catch {
      setSaveError('An unexpected error occurred');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Company Settings"
        description="Configure organization-wide preferences and modules"
      />

      {error && (
        <div className="mb-4">
          <AlertBanner variant="error" message={error} onDismiss={() => setError(null)} />
        </div>
      )}

      <form onSubmit={(e) => void handleSave(e)} className="max-w-2xl space-y-6">
        {saveSuccess && (
          <AlertBanner
            variant="success"
            message="Settings saved successfully"
            onDismiss={() => setSaveSuccess(false)}
          />
        )}
        {saveError && (
          <AlertBanner variant="error" message={saveError} onDismiss={() => setSaveError(null)} />
        )}

        <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-6">
          <h2 className="text-base font-semibold text-gray-900">Regional</h2>
          <Select
            label="Timezone"
            value={form.default_timezone}
            onChange={(e) => setForm((f) => ({ ...f, default_timezone: e.target.value }))}
            options={TIMEZONE_OPTIONS}
          />
          <Select
            label="Date format"
            value={form.date_format}
            onChange={(e) => setForm((f) => ({ ...f, date_format: e.target.value }))}
            options={DATE_FORMAT_OPTIONS}
          />
          <Select
            label="Language"
            value={form.language}
            onChange={(e) => setForm((f) => ({ ...f, language: e.target.value }))}
            options={LANGUAGE_OPTIONS}
          />
        </div>

        <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-6">
          <h2 className="text-base font-semibold text-gray-900">Branding</h2>
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Primary color"
              type="color"
              value={form.primary_color}
              onChange={(e) => setForm((f) => ({ ...f, primary_color: e.target.value }))}
            />
            <Input
              label="Secondary color"
              type="color"
              value={form.secondary_color}
              onChange={(e) => setForm((f) => ({ ...f, secondary_color: e.target.value }))}
            />
          </div>
        </div>

        <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-6">
          <h2 className="text-base font-semibold text-gray-900">Modules</h2>
          <label className="flex cursor-pointer items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-900">Clinical Intelligence (AI)</p>
              <p className="text-xs text-gray-500">
                Enable AI agents and suggestions across Zentariq One
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={form.enable_ai}
              onClick={() => setForm((f) => ({ ...f, enable_ai: !f.enable_ai }))}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:outline-none ${form.enable_ai ? 'bg-blue-600' : 'bg-gray-200'}`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${form.enable_ai ? 'translate-x-6' : 'translate-x-1'}`}
              />
            </button>
          </label>
          <label className="flex cursor-pointer items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-900">Task Center</p>
              <p className="text-xs text-gray-500">
                Show the task center and automated task generation
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={form.enable_task_center}
              onClick={() => setForm((f) => ({ ...f, enable_task_center: !f.enable_task_center }))}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:outline-none ${form.enable_task_center ? 'bg-blue-600' : 'bg-gray-200'}`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${form.enable_task_center ? 'translate-x-6' : 'translate-x-1'}`}
              />
            </button>
          </label>
        </div>

        <div className="flex justify-end">
          <Button type="submit" loading={saving} disabled={saving}>
            Save Settings
          </Button>
        </div>
      </form>
    </div>
  );
}
