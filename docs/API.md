# API.md

# Zentariq One API Specification

Version: 1.0  
Project: Zentariq One  
Purpose: Define the API structure, service boundaries, endpoint conventions, request/response patterns, permissions, and backend implementation rules for Zentariq One.

---

## 1. API Philosophy

Zentariq One uses a Supabase-backed architecture with a Next.js frontend.

The API layer must provide a clean and secure abstraction over:

- Supabase database operations
- Business Rules
- Task Engine
- Clinical Intelligence
- Enterprise Document Center
- Analytics
- Audit Trail

The frontend should never directly implement business logic.

Business logic belongs in:

- Supabase functions
- server-side actions
- API routes
- Business Rules Engine
- Task Engine services

---

## 2. Core API Principles

1. Every request must be authenticated.
2. Every request must be scoped by `company_id`.
3. Site-specific records must be scoped by authorized `site_id`.
4. Role and permission checks are mandatory.
5. All important actions must write to Audit Trail.
6. AI may suggest data, but production writes require review/approval.
7. API responses must be consistent.
8. Frontend must not bypass backend validation.
9. Files must never be exposed through public permanent URLs.
10. API must be designed for multi-company SaaS from day one.

---

## 3. Standard Response Format

### Success Response

```json
{
  "success": true,
  "data": {},
  "message": "Operation completed successfully"
}
```

### Error Response

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable error message",
    "details": {}
  }
}
```

---

## 4. Standard Error Codes

- `UNAUTHORIZED`
- `FORBIDDEN`
- `NOT_FOUND`
- `VALIDATION_ERROR`
- `DUPLICATE_RECORD`
- `BUSINESS_RULE_FAILED`
- `AI_REVIEW_REQUIRED`
- `FILE_UPLOAD_FAILED`
- `INTERNAL_ERROR`

---

## 5. Authentication API

Supabase Auth handles authentication.

### Required Auth Flows

- Sign in
- Sign out
- Password reset
- Invite user
- Accept invitation
- Session refresh

### POST /api/invitations/accept

Accepts an invitation and creates the user account.

Auth: None — this is a public endpoint. The `token` is the credential.

Required:

- token
- full_name
- password

On success: creates Supabase auth user, profile record, assigns roles and sites, marks invitation accepted.

Response: `{ user_id, session }`

### GET /api/invitations/validate

Validates an invitation token before showing the acceptance form.

Auth: None — public endpoint.

Query:

- token

Response: `{ valid: true/false, email }` — never returns the full invitation record.

### Frontend Rule

After login, the frontend must load:

- user profile
- company
- roles
- permissions
- authorized sites
- enabled modules

---

## 6. Companies API

### GET /api/company/current

Returns current user's company.

### PATCH /api/company/settings

Updates company settings.

Permissions:

- Admin only

---

## 7. Users API

### GET /api/users

Returns users in the current company, each with their assigned `roles` and `sites`.

Filters:

- role
- site
- status

### POST /api/users/invite

Invites a user.

Required:

- email
- role_ids (array of UUID)
- site_ids (array of UUID)

Note: `full_name` is NOT collected at invite time. The invitee enters their own name during account setup via `POST /api/invitations/accept`.

Permissions:

- Admin

### GET /api/users/invitations

Returns all invitations for the current company.

Query filters:

- status (pending | accepted | expired | revoked)

Permissions:

- Admin

### DELETE /api/users/invitations/:id

Revokes a pending invitation.

Permissions:

- Admin

### POST /api/users/invitations/:id/resend

Resends an invitation email with a refreshed token and extended expiry.

Permissions:

- Admin

### PATCH /api/users/:id

Updates user profile or status.

Permissions:

- Admin (or self, for own profile)

### POST /api/users/:id/roles

Assigns a role to a user.

Required:

- role_id

Permissions:

- manage_users

### DELETE /api/users/:id/roles/:roleId

Removes a role from a user.

Permissions:

- manage_users

### POST /api/users/:id/sites

Assigns a site to a user.

Required:

- site_id

Permissions:

- manage_users

### DELETE /api/users/:id/sites/:siteId

Removes a site assignment from a user.

Permissions:

- manage_users

### DELETE /api/users/:id

Soft-deactivates user.

Permissions:

- Admin

### GET /api/roles

Returns all roles for the company, each with its assigned permissions.

### PATCH /api/roles/:id/permissions

Grants or revokes a single permission on a role.

Required:

- permission_key
- allowed (boolean)

Permissions:

- manage_users

---

## 8. Sites API

### GET /api/sites

Returns sites available to the user.

Filters:

- search (matches name, site number, or city)
- view (`active` | `archived` | `all` — defaults to `active`, which excludes
  archived sites)

### POST /api/sites

Creates a site.

Business Rules:

- If this is the first site created for the company, every user holding the
  `admin` role is automatically assigned to it via `user_sites` (in addition to
  the `view_all_sites` permission they already hold, which grants access to
  every site regardless of explicit assignment).

Permissions:

- manage_sites

### GET /api/sites/:id

Returns a single site.

### PATCH /api/sites/:id

Updates a site (name, site number, PI, address, phone, timezone, status).

Permissions:

- manage_sites

### POST /api/sites/:id/archive

Archives a site (see `BUSINESS_RULES` — Site Archive, in
`DATABASE_Part_01_Core_SaaS_Users_Roles_Sites.md`). Zentariq One never
hard-deletes a site; this is the only "remove" operation available.

Optional:

- reason (required only when overriding the enrolled-subjects block)

Business Rules:

- Blocked if the site has enrolled subjects, unless the caller holds
  `force_archive_site`, in which case a `reason` is mandatory.
- Idempotent — archiving an already-archived site is a no-op.

Permissions:

- manage_sites (+ force_archive_site to override the enrolled-subjects block)

### GET /api/sites/:id/studies

Returns studies assigned to this site.

### GET /api/sites/:id/users

Returns staff (users) assigned to this site, each with their role(s).

---

## 9. Studies API

### GET /api/studies

Returns studies filtered by company and site access.

Filters:

- site_id
- status (exact match)
- sponsor
- therapeutic_area
- view (`active` | `archived` | `all` — defaults to `active`, which excludes
  archived studies; an explicit `status` filter takes precedence over `view`)

### POST /api/studies

Creates a study manually.

Permissions:

- Admin

### POST /api/studies/ai-drafts

Uploads a protocol PDF and starts AI extraction into a temporary draft. **No `studies` row is
created by this call** — the extraction lands in `study_drafts` for guided human review.

Flow:

1. Upload protocol file.
2. Create `study_drafts` row (`status: 'processing'`).
3. Run AI Protocol Agent.
4. Store the extracted study profile, visit schedule, and confidence/uncertain-fields on the
   draft (`status: 'ready'`, or `'failed'` with `error_message` if extraction errors out).
5. Return the draft for the guided review screen.

Permissions:

- create_study

### GET /api/studies/ai-drafts/:id

Fetches an AI draft for review.

Permissions:

- create_study

### DELETE /api/studies/ai-drafts/:id

Discards an AI draft that hasn't been finalized yet.

Permissions:

- create_study

### POST /api/studies/ai-drafts/:id/finalize

Creates the real study from a (possibly edited) AI draft — validated by `finalizeAiDraftSchema`.
Creates the `studies` row with every submitted field, creates the visit template if any visit
items were submitted, attaches the originally uploaded protocol PDF under Documents
(`study_documents`, `document_type: 'protocol'`), and marks the draft `finalized`.

Permissions:

- create_study

### POST /api/studies/:id/approve-ai-extraction

Approves an AI-generated extraction on an **existing** study (protocol amendments — see
`POST /api/studies/:id/protocol`). Not used by the ai-drafts flow above, which creates the study
directly on finalize instead of an approve-per-extraction step.

Permissions:

- Admin

### PATCH /api/studies/:id

Updates study fields (name, protocol number, sponsor, CRO, phase,
therapeutic area, dates).

Permissions:

- edit_study or manage_studies

### POST /api/studies/:id/close

Closes study.

Permissions:

- Admin

### POST /api/studies/:id/archive

Archives a study (see Business Rules — Study Archive). Zentariq One never
hard-deletes a study; this is the only "remove" operation available.

Optional:

- reason (required only when overriding the enrolled-subjects block)

Business Rules:

- Blocked if the study has enrolled subjects, unless the caller holds
  `force_archive_study`, in which case a `reason` is mandatory.
- Idempotent — archiving an already-archived study is a no-op.

Permissions:

- manage_studies (+ force_archive_study to override the enrolled-subjects
  block)

### GET /api/studies/:id/sites

Returns sites assigned to this study.

### DELETE /api/studies/:id/sites/:siteId

Removes a site assignment from this study. (Assigning a site reuses
`PATCH /api/studies/:id` with a `site_ids` array — see above.)

Permissions:

- manage_studies

---

## 10. Visit Templates API

### GET /api/studies/:study_id/visit-templates

Returns templates for a study.

### POST /api/studies/:study_id/visit-templates

Creates visit template manually.

### POST /api/visit-templates/:id/approve

Approves visit template.

### POST /api/visit-templates/:id/archive

Archives visit template.

Rules:

- Never overwrite an approved template.
- Protocol amendments create new template versions.

---

## 11. Subjects API

### GET /api/subjects

Filters:

- site_id
- study_id
- status
- subject_number

### POST /api/subjects

Creates subject.

Required:

- site_id
- study_id
- subject_number

Optional:

- initials
- screening_date

`baseline_date` and `randomization_date` are not accepted here — see
`POST /api/subjects/:id/baseline` and `POST /api/subjects/:id/randomize` below.

Business Rules:

- Validate active study.
- Validate site is assigned to study.
- Schedule a placeholder Baseline visit from the approved template's `is_baseline` item.
- Create timeline entry.
- Create audit log.

### GET /api/subjects/:id

Returns full subject profile (overview tab only by default).

Includes:

- overview
- visits (lazy-loaded — pass `?include=visits` or use dedicated endpoint below)
- charts
- timeline
- notes
- documents
- history

### GET /api/subjects/:id/visits

Returns all visits for a subject. Used by the Subject Profile Visits tab.

Filters:

- status
- date range

### PATCH /api/subjects/:id

Updates subject.

### POST /api/subjects/:id/status

Changes subject status.

### POST /api/subjects/:id/baseline

Completes the Baseline visit.

Required:

- baseline_date

Business Rules:

- Reject if the subject's baseline date is already recorded.
- Mark the subject's placeholder Baseline visit Completed with this date.
- Record `baseline_date` on the subject.
- Generate the remaining scheduled visits from the approved visit template, anchored
  to `baseline_date`.
- Create timeline entry and audit log.

### POST /api/subjects/:id/randomize

Records randomization and moves the subject to Randomized status.

Required:

- randomization_number
- randomization_date

Business Rules:

- Reject if the subject is already randomized.
- Reject if the subject's current status is not Screening.
- Record `randomization_number` and `randomization_date`; set status to `randomized`.
- Write status history, timeline entry, audit log, and PI/CRC notification.

### POST /api/subjects/:id/notes

Adds note.

### POST /api/subjects/:id/documents

Links document.

---

## 12. Visits API

### GET /api/visits

Filters:

- site_id
- study_id
- subject_id
- status
- date range

### POST /api/visits/unscheduled

Creates unscheduled visit.

Required:

- subject_id
- visit_date
- reason

### PATCH /api/visits/:id/status

Changes visit status.

Important transitions:

- Scheduled → Confirmed
- Confirmed → In Progress
- In Progress → Completed
- Scheduled → Missed
- Scheduled → Cancelled

### POST /api/visits/:id/reschedule

Reschedules visit.

Payload:

```json
{
  "new_date": "2026-07-01",
  "apply_to": "only_this_visit"
}
```

Options:

- only_this_visit
- this_and_future_visits
- keep_original_future_schedule

### POST /api/visits/:id/complete

Completes visit.

Business Rules:

- Mark visit completed.
- Check visit window.
- Create Chart.
- Create Data Entry Task.
- Update Timeline.
- Update Analytics.
- Write Audit Log.

---

## 13. Calendar API

### GET /api/calendar/events

Filters:

- site_id
- date range
- event_type

### POST /api/calendar/events

Creates manual event.

Allowed event types:

- monitoring_visit
- sponsor_visit
- investigator_meeting
- staff_meeting
- training

### PATCH /api/calendar/events/:id

Updates event.

### DELETE /api/calendar/events/:id

Soft-cancels event.

Rule:

- Do not hard delete operational events.

---

## 14. Charts API

**Amendment (Milestone 4.1/4.3 — shipped shape supersedes the routes originally sketched below):** there is no separate `GET /api/charts/queue` or generic `PATCH /api/charts/:id/status`. `GET /api/charts` itself returns the prioritized, paginated queue (`ChartService.listCharts`), and each status transition has its own dedicated route instead of one generic status endpoint — matching the state machine in migration 026.

### GET /api/charts

Filters: `site_id`, `study_id`, `subject_id`, `status`, `priority`, `page`, `page_size`. Returns the prioritized Data Entry queue directly (ordering: priority tier desc, then days-pending desc, then `created_at` asc — see `ChartService.compareChartQueueItems`).

### GET /api/charts/:id

Returns a single chart.

### POST /api/charts/:id/start

Starts data entry (`chart_ready`/`on_hold` → `in_progress`).

### POST /api/charts/:id/hold

Puts a chart on hold (`chart_ready`/`in_progress` → `on_hold`).

### POST /api/charts/:id/release

Releases a hold (`on_hold` → `chart_ready`).

### POST /api/charts/:id/mark-entered

Marks chart as Entered in EDC (`in_progress` → `entered_in_edc`).

Business Rules:

- Set entered_in_edc_date.
- Set entered_by, entered_by_role.
- Write chart_history + audit log.
- Recalculate chart_metrics (Milestone 4.3).

### POST /api/charts/:id/reopen

Reopens an Entered-in-EDC chart (requires `reopen_chart` + a reason).

### GET /api/charts/:id/history

Returns the chart's status-transition ledger.

### GET /api/charts/:id/comments

Returns the chart's comment thread, newest first (Milestone 4.3).

### POST /api/charts/:id/comments

Adds a comment. Requires the dedicated `comment_chart` permission — independent of `view_charts`/`mark_chart_ready`/`mark_chart_entered`/`reopen_chart`. Postable on a locked (`entered_in_edc`) chart without `reopen_chart`, since a comment never mutates the chart itself. Comments are permanent — no edit or delete route exists.

### GET /api/charts/:id/metrics

Returns the chart's current `chart_metrics` row (Milestone 4.3): `ready_to_entry_hours`, `total_entry_hours`, `overdue_days`, `out_of_window`, `sponsor_priority`. One row per chart, recalculated in place at chart creation, start of entry, mark entered, and reopen. `sponsor_priority` is currently always `false` — no `calendar_events` row of `event_type='sponsor_visit'` can be produced by any existing code path (verified during Milestone 4.3 planning); see `docs/BUSINESS_RULES_05_Charts_DataEntry.md`.

---

## 15. Regulatory API

### GET /api/regulatory/binders

Returns binders by study/site.

### GET /api/regulatory/documents

Filters:

- site_id
- study_id
- document_type
- status
- expiration range

### POST /api/regulatory/documents

Uploads/links regulatory document.

Flow:

1. Upload file.
2. Create file record.
3. Run AI Regulatory Agent.
4. Extract metadata.
5. Apply Document Type Rules.
6. Calculate expiration.
7. Create renewal tasks if needed.

### PATCH /api/regulatory/documents/:id

Updates regulatory document metadata (document name, version, effective date, expiration date, document type).

Use case: correcting metadata before or after AI review, without creating a new version.

Permissions:

- Regulatory

### POST /api/regulatory/documents/:id/archive

Archives document.

### POST /api/regulatory/documents/:id/version

Uploads new version.

---

## 16. Enterprise Document Center API

### POST /api/files/upload

Uploads file to secure storage.

### GET /api/files/:id

Returns file metadata.

### GET /api/files/:id/signed-url

Returns temporary signed URL.

### POST /api/files/:id/link

Links file to module record.

### GET /api/files/search

Search files using metadata and extracted text.

### POST /api/files/:id/ai-extract

Runs AI extraction.

### POST /api/files/compare

Compares two files using AI.

---

## 17. Task Center API

### GET /api/tasks

Returns tasks assigned to current user or role.

Filters:

- site_id
- priority
- status
- due date

### GET /api/tasks/my-today

Returns today's work queue.

### PATCH /api/tasks/:id/status

Updates task status.

### POST /api/tasks/:id/comments

Adds task comment.

### POST /api/tasks/:id/complete

Completes task and executes completion workflow.

---

## 18. Business Rules API

### GET /api/business-rules

Returns rules.

### POST /api/business-rules

Creates rule.

Permissions:

- Admin

### PATCH /api/business-rules/:id

Updates rule.

### POST /api/business-rules/:id/test

Tests rule against sample data.

### POST /api/business-rules/:id/execute

Executes rule manually.

Permissions:

- Admin

---

## 19. Clinical Intelligence API

### POST /api/ai/protocol/analyze

Runs Protocol Agent.

### POST /api/ai/regulatory/analyze

Runs Regulatory Agent.

### POST /api/ai/subject/review

Runs Subject Agent.

### POST /api/ai/data/review-chart

Runs Data Agent.

### POST /api/ai/analytics/ask

Answers analytics questions.

### POST /api/ai/copilot

General Zentariq One Copilot.

### POST /api/ai/suggestions

Returns proactive suggestions.

Rule:

AI output requiring data changes must be stored as pending review.

---

## 20. Analytics API

### GET /api/analytics/dashboard

Returns dashboard data by role.

### GET /api/analytics/kpis

Returns KPIs.

### GET /api/analytics/reports

Returns available reports.

### POST /api/analytics/reports/export

Creates export file.

### POST /api/analytics/saved-reports

Saves report configuration.

---

## 21. Audit Trail API

### GET /api/audit-logs

Filters:

- module
- record_type
- user_id
- date range
- site_id

Permissions:

- Admin
- CEO limited
- Regulatory limited to documents

Audit logs must never be editable.

---

## 22. Notifications API

### GET /api/notifications

Returns the current user's notifications, most recent first.

Query filters:

- is_read (true | false)
- limit (default 50)

### GET /api/notifications/unread-count

Returns the count of unread notifications for the current user.

Response: `{ count: number }`

### PATCH /api/notifications/:id/read

Marks one notification as read.

### POST /api/notifications/mark-all-read

Marks all of the current user's notifications as read.

### GET /api/notifications/preferences

Returns all notification preferences for the current user.

Response: array of `{ event_type, in_app, email }`

### PUT /api/notifications/preferences/:event_type

Updates notification channel preferences for one event type.

Body: `{ in_app: boolean, email: boolean }`

---

## 23. Settings API

### GET /api/settings

Returns company settings.

### PATCH /api/settings

Updates settings.

### GET /api/settings/document-types

Returns document types.

### POST /api/settings/document-types

Creates document type.

### PATCH /api/settings/document-types/:id

Updates document type.

---

## 23. Backend Implementation Rules

Claude must implement services in layers:

- API route
- Validation
- Permission check
- Business Rule evaluation
- Database operation
- Task creation
- Audit log
- Response

Do not place business logic directly in React components.

---

## 24. Required Backend Services

- AuthService
- InvitationService
- PermissionService
- SiteAccessService
- StudyService
- SubjectService
- VisitService
- ChartService
- RegulatoryService
- FileService
- TaskService
- BusinessRuleEngine
- ClinicalIntelligenceService
- AnalyticsService
- NotificationService
- AuditService

---

## 25. Final Implementation Instruction

Implement APIs incrementally.

Recommended order:

1. Auth
2. Companies/Sites/Users
3. Studies
4. Subjects
5. Visits/Calendar
6. Charts
7. Task Center
8. Regulatory/Documents
9. Business Rules
10. Clinical Intelligence
11. Analytics
12. Audit Trail
13. Settings
