import type { LeadStatus, PipelineColumnKey } from '@/types/recruitment';

// Presentation-only grouping of the 20 raw lead statuses into the 10 Kanban
// columns from the Sprint 7.2 plan — this is NOT a business rule (which
// transitions are legal is enforced server-side by LeadService's
// STATUS_TRANSITIONS map / getValidNextStatuses) and is safe to share with
// the frontend. 'waitlisted' groups under 'qualified' (its primary source
// and destination in the transition map) rather than 'closed', since it is
// an active holding state, not a terminal one.
export const PIPELINE_COLUMN_ORDER: PipelineColumnKey[] = [
  'new',
  'contact_attempted',
  'contacted',
  'interested',
  'prescreen',
  'qualified',
  'screening_scheduled',
  'screened',
  'converted',
  'closed',
];

export const PIPELINE_COLUMN_LABELS: Record<PipelineColumnKey, string> = {
  new: 'New',
  contact_attempted: 'Contact Attempted',
  contacted: 'Contacted',
  interested: 'Interested',
  prescreen: 'Prescreen',
  qualified: 'Qualified',
  screening_scheduled: 'Screening Scheduled',
  screened: 'Screened',
  converted: 'Converted',
  closed: 'Closed / Not Eligible',
};

export const PIPELINE_COLUMN_STATUSES: Record<PipelineColumnKey, LeadStatus[]> = {
  new: ['new'],
  contact_attempted: ['contact_attempted', 'voicemail_left'],
  contacted: ['contacted'],
  interested: ['interested'],
  prescreen: ['prescreening', 'prescreen_scheduled', 'prescreen_in_progress', 'prescreen_complete'],
  qualified: ['qualified', 'waitlisted'],
  screening_scheduled: ['screening_scheduled'],
  screened: ['screened'],
  converted: ['converted'],
  closed: ['not_interested', 'not_qualified', 'screen_failed', 'withdrawn', 'declined', 'lost'],
};

export function getPipelineColumnForStatus(status: LeadStatus): PipelineColumnKey {
  for (const column of PIPELINE_COLUMN_ORDER) {
    if (PIPELINE_COLUMN_STATUSES[column].includes(status)) return column;
  }
  // Unreachable given PIPELINE_COLUMN_STATUSES covers the full LeadStatus
  // union — 'closed' as a defensive fallback rather than throwing.
  return 'closed';
}
