'use client';

import { useCallback, useMemo } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';

// Same URL-backed filter pattern as useRecruitmentFilters — state lives in
// the query string (site_id, study_id, status, priority, page), not local
// component state, so it survives navigation/back and is shareable. Charts
// has its own hook (mirroring the per-module convention) rather than a
// shared generic one, since useRecruitmentFilters is itself module-scoped.
export function useChartFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const get = useCallback((key: string): string => searchParams.get(key) ?? '', [searchParams]);

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
