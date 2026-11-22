# BUSINESS RULES 04 - Visits

## Visit Generation

The Baseline visit and the rest of the protocol schedule are generated in two steps:

**At Subject creation:**

- Read the approved Visit Template's designated Baseline item (`is_baseline`).
- Create a placeholder Baseline visit (status Scheduled, no date yet).

**At Baseline visit completion (trigger: Baseline Date entered):**

- Mark the Baseline visit Completed with the entered date.
- Read the approved Visit Template's remaining items.
- Generate all other scheduled visits.
- Calculate target dates and visit windows, anchored to Baseline Date.
- Create calendar events.

## Unscheduled Visits

Users may create an unscheduled visit.

Rules:

- Must belong to an existing subject.
- Appears in Calendar.
- Creates Chart after completion.
- Creates Task automatically.

## Visit Completion

Trigger:
Status = Completed

Actions:

- Create Chart.
- Create Data Entry Task.
- Update Timeline.
- Update Analytics.

## Out of Window

If completion date is outside visit window:

- Mark Out of Window.
- Increase chart priority.
- Notify CRC.
- Record Audit Trail.

Out of Window is a warning state, never a block (owner decision M4-D5). The
database enforces the status (migration 039, decision O-1): a visit whose
completion date falls outside its window must be `out_of_window`, never
`completed`, and `out_of_window` requires a date outside the window. A visit
without a window is `completed`.

## Visit Sequence

A visit can be completed (Completed or Out of Window) only when every
**required** visit of the same template with a lower `visit_order` is
Completed or Out of Window. Sequencing is driven by `visit_order` and
`is_required`, never by visit names. Unscheduled visits (no template item)
and optional visits never block. The application checks this first
(`lib/utils/visitSequencing.ts`) and the database re-checks it on every
completion (migration 039), so a direct Data API call cannot skip it.

## Visit Integrity

The sequence and the window are only meaningful if the visit rows they read
cannot be rearranged. For direct Data API writes the database therefore also
enforces (migration 039, final review H-1):

- A visit keeps its subject, study, site and template visit for life.
- A visit belongs to its subject's study and site, and a template visit must
  come from the study's **approved** visit template.
- A subject has at most one visit per template visit, cancelled visits
  included (the schedule never re-creates a cancelled visit), so a duplicate
  cannot stand in for a required predecessor.
- The target date and window follow the template: the window contains the
  target date and stays within the template's window (it may be narrower,
  never wider), an unscheduled visit's window is its target date, and a
  target date is never cleared once set. Scheduled and Confirmed visits can be
  rescheduled; an In Progress visit's dates change only through the baseline
  completion or the schedule recalculation anchored to the baseline date;
  closed visits keep their dates.
- The visit date (`scheduled_date`) is recorded only while the visit is In
  Progress, and is not set at creation.
- The subject's baseline date is the date of its completed baseline visit and
  is not set at creation.

The database cannot verify that the visit date a user records is the real
one, and rescheduling a Scheduled or Confirmed visit stays possible exactly as
in the application (its reason is enforced in the database with 044).

## Sequence Exceptions

An authorized user may record a justified exception so that one completion of
a blocked visit can proceed (owner decision M4-D5):

- Requires the `override_visit_sequence` permission and access to the visit's
  site. The permission is granted to no role by default (like `reopen_visit`);
  a company owner grants it per role in Settings > Roles.
- `POST /api/subjects/{id}/visits/{visitId}/sequence-exception` with a reason
  of 10–2000 characters. Only for an open visit (Scheduled, Confirmed or In
  Progress) that the database confirms is blocked; otherwise HTTP 409.
- The database records who authorized it and when, and which required visits
  were pending (`blocked_by`); none of these can be supplied by the client.
- One open exception per visit. It covers exactly one completion: the
  completion closes it (`consumed_at`, `consumed_status`), even if it was no
  longer needed, so it cannot be reused after a reopen.
- Recorded exceptions cannot be edited or deleted. The application writes a
  subject timeline entry and an audit event
  (`visit.sequence_exception_authorized`); the completion audit records
  `sequence_exception: true` when an exception was used.
- A user interface for recording exceptions is a separate, later unit.
