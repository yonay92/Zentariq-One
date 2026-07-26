'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { countActiveStudies, countEnrolledSubjects } from '@/lib/utils/dashboardStats';
import type { Study } from '@/types/studies';
import type { Subject } from '@/types/subjects';

type StatCardProps = {
  label: string;
  value: string | number;
  description?: string | undefined;
};

function StatCard({ label, value, description }: StatCardProps) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6">
      <p className="text-sm font-medium text-gray-500">{label}</p>
      <p className="mt-2 text-3xl font-bold text-gray-900">{value}</p>
      {description && <p className="mt-1 text-xs text-gray-400">{description}</p>}
    </div>
  );
}

function useDashboardSummary() {
  const [activeStudies, setActiveStudies] = useState<number | null>(null);
  const [enrolledSubjects, setEnrolledSubjects] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setLoading(true);
      setError(false);
      try {
        const [studiesRes, subjectsRes] = await Promise.all([
          fetch('/api/studies?status=active'),
          fetch('/api/subjects'),
        ]);
        if (!studiesRes.ok || !subjectsRes.ok) throw new Error('Failed to load dashboard summary');

        const studiesJson = (await studiesRes.json()) as { data: Study[] };
        const subjectsJson = (await subjectsRes.json()) as { data: Subject[] };
        if (cancelled) return;

        setActiveStudies(countActiveStudies(studiesJson.data));
        setEnrolledSubjects(countEnrolledSubjects(subjectsJson.data));
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return { activeStudies, enrolledSubjects, loading, error };
}

export default function DashboardPage() {
  const auth = useAuth();
  const summary = useDashboardSummary();

  if (auth.status === 'loading') {
    return (
      <div className="flex h-64 items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (auth.status === 'unauthenticated') {
    return null;
  }

  const { profile, company } = auth;

  const studiesValue = summary.loading || summary.error ? '—' : (summary.activeStudies ?? 0);
  const subjectsValue = summary.loading || summary.error ? '—' : (summary.enrolledSubjects ?? 0);
  const summaryDescription = summary.loading
    ? 'Loading…'
    : summary.error
      ? 'Failed to load'
      : undefined;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">
          Welcome back, {profile.full_name.split(' ').at(0) ?? profile.full_name}
        </h1>
        <p className="mt-1 text-sm text-gray-500">{company.name} · Clinical Research Operations</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Active Studies" value={studiesValue} description={summaryDescription} />
        <StatCard
          label="Enrolled Subjects"
          value={subjectsValue}
          description={summaryDescription}
        />
        <StatCard label="Open Tasks" value="—" description="Coming in a future sprint" />
        <StatCard label="Pending Documents" value="—" description="Coming in a future sprint" />
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-base font-semibold text-gray-900">Recent Activity</h2>
        <p className="text-sm text-gray-500">
          Activity feed will appear here as you use Zentariq One.
        </p>
      </div>
    </div>
  );
}
