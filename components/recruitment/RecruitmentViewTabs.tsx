'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

const TABS = [
  { href: '/recruitment/dashboard', label: 'Dashboard' },
  { href: '/recruitment', label: 'Table' },
  { href: '/recruitment/pipeline', label: 'Pipeline' },
] as const;

// Forwards the current query string to every tab so switching views never
// drops the active filters — the whole point of sharing filter state via
// useRecruitmentFilters across all three routes.
export function RecruitmentViewTabs() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const qs = searchParams.toString();

  return (
    <div className="mb-4 flex gap-1 border-b border-gray-200">
      {TABS.map((tab) => {
        const isActive = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={qs ? `${tab.href}?${qs}` : tab.href}
            className={`px-4 py-2 text-sm font-medium ${
              isActive
                ? 'border-b-2 border-blue-600 text-blue-600'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
