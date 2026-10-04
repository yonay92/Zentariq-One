export type TaskStatus = 'new' | 'assigned' | 'in_progress' | 'waiting' | 'completed' | 'cancelled';

export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

// Generic, cross-module work item (docs/DATABASE_Part_04_Charts_Tasks_Analytics.md
// §7). source_module/source_record_type/source_record_id is the same
// polymorphic-reference pattern already used by file_links — Charts is the
// first producer, not a Charts-specific engine.
export type Task = {
  id: string;
  company_id: string;
  site_id: string;
  assigned_to: string | null;
  assigned_role: string | null;
  source_module: string;
  source_record_type: string | null;
  source_record_id: string | null;
  title: string;
  description: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  due_date: string | null;
  created_by_system: boolean;
  created_at: string;
  updated_at: string;
};

export type TaskHistoryEntry = {
  id: string;
  company_id: string;
  task_id: string;
  old_status: TaskStatus | null;
  new_status: TaskStatus;
  changed_by: string | null;
  changed_at: string;
  reason: string | null;
};

// Append-only, permanent (no edit/delete surface — enforced at the RLS
// level by task_comments having no UPDATE/DELETE policy, migration 030).
export type TaskComment = {
  id: string;
  company_id: string;
  task_id: string;
  comment: string;
  created_by: string | null;
  created_at: string;
};

export type AddTaskCommentInput = {
  comment: string;
};

export type CancelTaskInput = {
  reason: string;
};

export type ReassignTaskInput = {
  assigned_to: string;
};

// Manual creation (TaskService.createTask, create_task permission). At
// least one of assigned_to / assigned_role is required, matching
// tasks.chk_tasks_assignee (migration 030). source_module/source_record_type
// /source_record_id are optional here — a manually created task has no
// producing module by default (defaults to 'manual', no source record).
export type CreateTaskInput = {
  site_id: string;
  title: string;
  description?: string | undefined;
  priority?: TaskPriority | undefined;
  due_date?: string | undefined;
  assigned_to?: string | undefined;
  assigned_role?: string | undefined;
  source_module?: string | undefined;
  source_record_type?: string | undefined;
  source_record_id?: string | undefined;
};

// Computed, never persisted (Milestone 5 Phase B §H — compute-on-read,
// mirroring Charts' ChartAging). effective_priority = max(base priority,
// due-date escalation); terminal (completed/cancelled) tasks never escalate
// and are never overdue.
export type TaskEffectivePriority = {
  effective_priority: TaskPriority;
  is_overdue: boolean;
  days_overdue: number | null;
};

export type TaskQueueItem = Task & TaskEffectivePriority;

// priority here filters by the COMPUTED effective_priority, applied by
// TaskService.listTasks after computation — never a DB column filter,
// same reasoning as ChartQueueFilters.priority.
export type TaskQueueFilters = {
  site_id?: string | undefined;
  status?: TaskStatus | undefined;
  priority?: TaskPriority | undefined;
  assigned_to?: string | undefined;
  page?: number | undefined;
  page_size?: number | undefined;
};

export type TaskQueueResult = {
  data: TaskQueueItem[];
  total: number;
  page: number;
  page_size: number;
};
