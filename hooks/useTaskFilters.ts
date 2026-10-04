'use client';

// The Task Center uses the same URL-backed filter behavior as the Chart Queue
// (query-string state: view, site_id, assigned_to, status, priority, page).
// useChartFilters is fully generic over keys, so it is reused rather than
// duplicated.
export { useChartFilters as useTaskFilters } from '@/hooks/useChartFilters';
