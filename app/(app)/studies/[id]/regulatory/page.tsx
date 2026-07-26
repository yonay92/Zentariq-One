'use client';

import { use } from 'react';
import { StudyRegulatoryPageContent } from '@/components/regulatory/StudyRegulatoryPageContent';

export default function StudyRegulatoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: studyId } = use(params);
  return <StudyRegulatoryPageContent studyId={studyId} />;
}
