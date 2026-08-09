'use client';

import { useCallback, useMemo } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';

// Backs the Dashboard/Table/Pipeline filter state entirely in the URL query
// string — the same param names (site_id, study_id, assigned_user_id,
// priority, etc.) are used across all three views, so switching between
// them via RecruitmentViewTabs (which forwards the current query string)
// never loses the active filters. No PHI is ever stored here — every param
// is an id, enum value, date, or the non-PHI initials search term.
export function useRecruitmentFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const get = useCallback((key: string): string => searchParams.get(key) ?? '', [searchParams]);

  // Setting any filter resets pagination back to page 1 by default (an
  // out-of-range page after narrowing results is a confusing dead end) —
  // pagination controls themselves pass resetPage: false.
  const setMany = useCallback(
    (updates: Record<string, string | null | undefined>, options?: { resetPage?: boolean }) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === undefined || value === '') {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }
      if (options?.resetPage !== false) {
        params.delete('page');
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [router, pathname, searchParams],
  );

  const clearAll = useCallback(() => {
    router.replace(pathname);
  }, [router, pathname]);

  const queryString = useMemo(() => searchParams.toString(), [searchParams]);

  return { get, setMany, clearAll, queryString };
}
