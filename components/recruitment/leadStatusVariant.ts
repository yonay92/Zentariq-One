import type { LeadStatus } from '@/types/recruitment';

type BadgeVariant = 'success' | 'warning' | 'danger' | 'default' | 'primary' | 'info';

// Shared between the pipeline table and the lead profile header so a given
// status always renders with the same badge color everywhere.
export const LEAD_STATUS_VARIANT: Record<LeadStatus, BadgeVariant> = {
  new: 'default',
  contact_attempted: 'default',
  contacted: 'info',
  voicemail_left: 'default',
  interested: 'info',
  not_interested: 'danger',
  prescreening: 'primary',
  prescreen_scheduled: 'primary',
  prescreen_in_progress: 'primary',
  prescreen_complete: 'primary',
  qualified: 'success',
  not_qualified: 'danger',
  screening_scheduled: 'primary',
  screened: 'primary',
  screen_failed: 'danger',
  withdrawn: 'danger',
  waitlisted: 'warning',
  converted: 'success',
  declined: 'danger',
  lost: 'danger',
};
