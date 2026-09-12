# BUSINESS RULES 05 - Charts & Data Entry

## Chart Creation

Trigger: Visit status becomes Completed.

Actions:

- Create Chart.
- Link Visit, Subject, Study and Site.
- Calculate initial priority.
- Create Data Entry Task.
- Update Timeline.

## Priority Rules

Critical:

- Sponsor Visit approaching.
- > 7 days overdue.
- Out of Window.

**Known limitation (Milestone 4.1–4.3):** "Sponsor Visit approaching" is not
currently detectable. `calendar_events` has an `event_type='sponsor_visit'`
value defined in its schema, but no existing service, API route, or UI can
ever create such a row — `VisitService` only ever writes `'patient_visit'`
events, and no `CalendarService`/manual-create UI exists. `ChartService`'s
`sponsorVisitApproaching` therefore stays hardcoded `false` (both in the
live queue-priority computation and in `chart_metrics.sponsor_priority`,
Milestone 4.3). Building the missing write path is out of scope for the
Charts milestones — it requires its own scoped Calendar/scheduling design.

High:

- 4-7 days overdue.

Medium:

- 1-3 days overdue.

Low:

- All others.

## Entered in EDC

Only authorized Data Entry (or approved CRC) may mark Entered in EDC.
System records:

- entered_by
- entered_at
- audit log
- KPI update

CRC may view but not edit these fields after completion.
