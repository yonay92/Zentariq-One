import type { VisitStatus } from './subjects';

export type VisitHistory = {
  id: string;
  company_id: string;
  visit_id: string;
  old_status: VisitStatus | null;
  new_status: VisitStatus;
  changed_by: string | null;
  changed_at: string;
  reason: string | null;
};

export type VisitNote = {
  id: string;
  company_id: string;
  visit_id: string;
  note: string;
  created_by: string | null;
  created_at: string;
};

export type ConfirmVisitInput = Record<string, never>;

export type StartVisitInput = Record<string, never>;

export type RescheduleVisitInput = {
  target_date: string;
  reason: string;
};

export type CancelVisitInput = {
  reason: string;
};

export type ReopenVisitInput = {
  reason: string;
};

export type AuthorizeVisitSequenceExceptionInput = {
  reason: string;
};

// visit_sequence_exceptions (migration 039, owner decision M4-D5). One open
// exception per visit; the database derives blocked_by, authorized_by and
// authorized_at, and consumes the exception when the visit is completed.
export type VisitSequenceException = {
  id: string;
  company_id: string;
  site_id: string;
  subject_id: string;
  visit_id: string;
  reason: string;
  // Names of the required earlier visits that were pending when the
  // exception was recorded. null when the row could not be read back.
  blocked_by: string[] | null;
  authorized_by: string;
  authorized_at: string | null;
  consumed_at: string | null;
  consumed_status: 'completed' | 'out_of_window' | null;
};

export type CreateUnscheduledVisitInput = {
  visit_name: string;
  target_date: string;
  notes?: string | undefined;
};

// ── Appointment Confirmation ─────────────────────────────────────────────────
// Tracked independently from VisitStatus — contacting a patient must never
// change visits.status, and confirming an appointment must never auto-start it.

export type AppointmentConfirmationStatus =
  | 'not_contacted'
  | 'attempted'
  | 'confirmed'
  | 'left_voicemail'
  | 'requested_reschedule'
  | 'unable_to_reach';

export type AppointmentConfirmation = {
  id: string;
  company_id: string;
  site_id: string;
  visit_id: string;
  confirmation_status: AppointmentConfirmationStatus;
  last_contacted_at: string | null;
  last_contacted_by: string | null;
  contact_attempt_count: number;
  contact_notes: string | null;
  next_contact_at: string | null;
  created_at: string;
  updated_at: string;
};

export type LogContactAttemptInput = {
  confirmation_status: AppointmentConfirmationStatus;
  contact_method?: 'phone' | 'email' | undefined;
  notes?: string | undefined;
  next_contact_at?: string | undefined;
};

export type AppointmentConfirmationLogEntry = {
  id: string;
  company_id: string;
  visit_id: string;
  contact_method: string | null;
  old_status: string | null;
  new_status: string;
  notes: string | null;
  contacted_by: string | null;
  contacted_at: string;
};
