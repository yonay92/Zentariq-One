import type { RegulatoryHealthScore } from '@/types/regulatory';

const BREAKDOWN_LABELS: Array<{ key: keyof RegulatoryHealthScore['breakdown']; label: string }> = [
  { key: 'current', label: 'Current' },
  { key: 'expiring_soon', label: 'Expiring Soon' },
  { key: 'expired', label: 'Expired' },
  { key: 'missing', label: 'Missing' },
  { key: 'pending_review', label: 'Pending Review' },
  { key: 'rejected', label: 'Rejected' },
];

function scoreColor(score: number | null): string {
  if (score === null) return 'text-slate-400';
  if (score >= 90) return 'text-green-600';
  if (score >= 70) return 'text-yellow-600';
  return 'text-red-600';
}

// Never renders a bare percentage — the numerator/denominator and full
// status breakdown are always shown alongside the score, per the approved
// Sprint 6 spec ("no misleading 100%, explainable breakdown").
export function HealthScoreBreakdown({ health }: { health: RegulatoryHealthScore }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center gap-4">
        <div className={`text-3xl font-bold ${scoreColor(health.score)}`}>
          {health.score === null ? '—' : `${health.score}%`}
        </div>
        <div className="text-sm text-gray-500">
          {health.denominator === 0
            ? 'No required documents configured for this scope yet'
            : `${health.numerator} of ${health.denominator} required documents current or expiring soon`}
        </div>
      </div>
      {health.denominator > 0 && (
        <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
          {BREAKDOWN_LABELS.map(({ key, label }) => (
            <div key={key} className="rounded-lg bg-gray-50 px-2 py-1.5 text-center">
              <div className="text-sm font-semibold text-gray-900">{health.breakdown[key]}</div>
              <div className="text-[11px] text-gray-500">{label}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
