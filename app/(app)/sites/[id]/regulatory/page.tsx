'use client';

import { use } from 'react';
import { SiteRegulatoryPageContent } from '@/components/regulatory/SiteRegulatoryPageContent';

export default function SiteRegulatoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: siteId } = use(params);
  return <SiteRegulatoryPageContent siteId={siteId} />;
}
