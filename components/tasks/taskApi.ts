import type { Task, TaskQueueItem } from '@/types/tasks';

// The ONLY network surface of the Task Center UI: the approved Milestone 5.0
// /api/tasks routes. No direct database client, no generic status mutation, and no
// reconciliation route exists here by design. The API/TaskService remain the
// authorization boundary; the UI only mirrors it for visibility.

export const TASK_API = {
  list: '/api/tasks',
  myToday: '/api/tasks/my-today',
  task: (id: string) => `/api/tasks/${id}`,
  complete: (id: string) => `/api/tasks/${id}/complete`,
  cancel: (id: string) => `/api/tasks/${id}/cancel`,
  reassign: (id: string) => `/api/tasks/${id}/reassign`,
  comments: (id: string) => `/api/tasks/${id}/comments`,
  history: (id: string) => `/api/tasks/${id}/history`,
} as const;

type ApiEnvelope<T> = {
  success: boolean;
  data?: T;
  message?: string;
  error?: { code: string; message: string; details?: unknown };
};

export type MutationResult<T> =
  { ok: true; data: T } | { ok: false; status: number; message: string };

// POST helper shared by every Task mutation. Never reports success unless the
// API did (no optimistic updates) and surfaces the API's own message for
// 403/404/422 so users see why an action was rejected.
export async function postTask<T>(url: string, body?: unknown): Promise<MutationResult<T>> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => null)) as ApiEnvelope<T> | null;
    if (!res.ok || !json?.success) {
      return {
        ok: false,
        status: res.status,
        message: json?.error?.message ?? json?.message ?? 'The request could not be completed',
      };
    }
    return { ok: true, data: json.data as T };
  } catch {
    return { ok: false, status: 0, message: 'An unexpected error occurred' };
  }
}

export const TERMINAL_TASK_STATUSES = ['completed', 'cancelled'] as const;

export function isTerminalTask(task: Pick<Task, 'status'>): boolean {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(task.status);
}

export type TaskListItem = TaskQueueItem;
