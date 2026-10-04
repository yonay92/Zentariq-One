'use client';

import { Suspense } from 'react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { TaskCenterView } from '@/components/tasks/TaskCenterView';

// Task Center (Milestone 5.0). Rendering logic lives in TaskCenterView so it
// can be unit-tested directly, mirroring the Charts page/view separation.
export default function TasksPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-48 items-center justify-center">
          <LoadingSpinner size="lg" />
        </div>
      }
    >
      <TaskCenterView />
    </Suspense>
  );
}
