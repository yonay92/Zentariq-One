'use client';

import { use } from 'react';
import { ChartDetailView } from '@/components/charts/ChartDetailView';

// A dedicated page (Phase A/B decision P5), not a modal like VisitDetailPanel
// — Charts are the primary object of a queue-driven workflow and need a
// stable, refreshable, directly-navigable route. All rendering logic lives
// in ChartDetailView (plain chartId prop) so it can be unit-tested directly.
export default function ChartDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: chartId } = use(params);
  return <ChartDetailView chartId={chartId} />;
}
