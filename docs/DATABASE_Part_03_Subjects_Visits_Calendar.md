# DATABASE_Part_03.md

# Zentariq One Database Architecture — Part 03

## Subjects, Visits, Calendar, Timelines

Version: 1.0  
Project: Zentariq One

---

## 1. Purpose

This part defines the subject lifecycle and the operational calendar.

Subjects are the central clinical records. Visits are generated from Study Visit Templates. Calendar Events visualize operational activity.

---

## 2. Table: subjects

Stores each study subject.

```sql
subjects
- id uuid primary key
- company_id uuid references companies(id)
- site_id uuid references sites(id)
- study_id uuid references studies(id)
- subject_number text not null
- initials text
- status text default 'screening'
- screening_date date
- baseline_date date
- randomization_date date
- randomization_number text
- end_of_study_date date
- created_by uuid references profiles(id)
- created_at timestamptz default now()
- updated_at timestamptz default now()
```

### Status Values

- pre_screening
- screening
- screen_failed
- randomized
- active
- completed
- early_terminated
- lost_to_follow_up

### Rule

Subjects are not assigned to a fixed CRC. Actions are attributed to the user who performs them.

---

## 3. Table: subject_status_history

Stores subject status changes.

```sql
subject_status_history
- id uuid primary key
- company_id uuid references companies(id)
- subject_id uuid references subjects(id)
- old_status text
- new_status text
- changed_by uuid references profiles(id)
- changed_at timestamptz default now()
- reason text
```

---

## 4. Table: subject_notes

Stores internal notes.

```sql
subject_notes
- id uuid primary key
- company_id uuid references companies(id)
- subject_id uuid references subjects(id)
- note text not null
- visibility text default 'internal'
- created_by uuid references profiles(id)
- created_at timestamptz default now()
```

### Visibility Values

- internal
- crc_only
- admin_only

---

## 5. Table: subject_documents

Connects subject-related files.

```sql
subject_documents
- id uuid primary key
- company_id uuid references companies(id)
- subject_id uuid references subjects(id)
- file_id uuid references files(id)
- document_type text
- uploaded_by uuid references profiles(id)
- uploaded_at timestamptz default now()
- notes text
```

---

## 6. Table: subject_milestones

Stores key subject milestones.

```sql
subject_milestones
- id uuid primary key
- company_id uuid references companies(id)
- subject_id uuid references subjects(id)
- milestone_type text not null
- milestone_date date not null
- created_by uuid references profiles(id)
- created_at timestamptz default now()
```

### Milestone Examples

- consent_signed
- screening
- randomized
- first_dose
- last_dose
- end_of_treatment
- end_of_study

---

## 7. Table: subject_timeline

Stores a clinical timeline of subject events.

```sql
subject_timeline
- id uuid primary key
- company_id uuid references companies(id)
- subject_id uuid references subjects(id)
- event_type text not null
- event_date timestamptz not null
- description text
- related_record_type text
- related_record_id uuid
- created_by uuid references profiles(id)
- created_at timestamptz default now()
```

---

## 8. Table: visits

Stores scheduled and unscheduled subject visits.

```sql
visits
- id uuid primary key
- company_id uuid references companies(id)
- site_id uuid references sites(id)
- study_id uuid references studies(id)
- subject_id uuid references subjects(id)
- visit_template_item_id uuid references visit_template_items(id)
- visit_name text not null
- visit_type text default 'scheduled'
- target_date date
- scheduled_date date
- window_start date
- window_end date
- status text default 'scheduled'
- created_by uuid references profiles(id)
- created_at timestamptz default now()
- updated_at timestamptz default now()
```

### Visit Types

- scheduled
- unscheduled

### Visit Status

- scheduled
- confirmed
- in_progress
- completed
- missed
- rescheduled
- cancelled
- out_of_window

---

## 9. Table: visit_history

```sql
visit_history
- id uuid primary key
- company_id uuid references companies(id)
- visit_id uuid references visits(id)
- old_status text
- new_status text
- changed_by uuid references profiles(id)
- changed_at timestamptz default now()
- reason text
```

---

## 10. Table: visit_notes

```sql
visit_notes
- id uuid primary key
- company_id uuid references companies(id)
- visit_id uuid references visits(id)
- note text not null
- created_by uuid references profiles(id)
- created_at timestamptz default now()
```

---

## 11. Table: calendar_events

Displays patient visits and operational events.

```sql
calendar_events
- id uuid primary key
- company_id uuid references companies(id)
- site_id uuid references sites(id)
- event_type text not null
- title text not null
- description text
- start_datetime timestamptz not null
- end_datetime timestamptz
- related_record_type text
- related_record_id uuid
- status text default 'scheduled'
- created_by uuid references profiles(id)
- created_at timestamptz default now()
- updated_at timestamptz default now()
```

### Event Types

- patient_visit
- monitoring_visit
- sponsor_visit
- investigator_meeting
- staff_meeting
- training

### Rule

Patient Visit = `visits` + `calendar_events`.

Monitoring/Sponsor/Training = `calendar_events` only.

---

## 12. Table: subject_contact_info

Internal CTMS PHI — one row per subject, kept in its own table (rather than columns on
`subjects`) so RLS enforces the PHI permission at the database level regardless of which
application query touches `subjects`.

```sql
subject_contact_info
- id uuid primary key
- company_id uuid references companies(id)
- site_id uuid references sites(id)
- subject_id uuid unique references subjects(id)
- first_name text not null
- last_name text not null
- date_of_birth date not null
- sex text not null
- phone_primary text not null
- phone_secondary text
- email text
- preferred_language text not null
- preferred_contact_method text not null default 'phone'  -- phone | email | sms
- voicemail_permission boolean not null default false
- best_time_to_contact text
- created_by uuid references profiles(id)
- updated_by uuid references profiles(id)
- created_at timestamptz default now()
- updated_at timestamptz default now()
```

### Rule

Gated by `view_subject_phi` (SELECT) / `edit_subject_phi` (INSERT, UPDATE) — separate from
`view_subjects` / `edit_subject`. Included in the Administrator role's default permission
grant since migration 013 (product decision — every other role still requires a conscious
per-role grant via Settings > Roles, the same override mechanism `force_archive_study` uses;
see §8 permissions in DATABASE_Part_01). Saving the first contact info for a subject
auto-generates `subjects.initials` if not already set.

---

## 13. Table: appointment_confirmations

1:1 with `visits`, deliberately separate from `visits.status` — contacting a patient about an
upcoming visit must never change the clinical visit lifecycle (Confirm/Start/Reschedule/Cancel/
Reopen, driven entirely by `VisitService` and untouched by this table).

```sql
appointment_confirmations
- id uuid primary key
- company_id uuid references companies(id)
- site_id uuid references sites(id)
- visit_id uuid unique references visits(id)
- confirmation_status text not null default 'not_contacted'
  -- not_contacted | attempted | confirmed | left_voicemail | requested_reschedule | unable_to_reach
- last_contacted_at timestamptz
- last_contacted_by uuid references profiles(id)
- contact_attempt_count integer not null default 0
- contact_notes text
- next_contact_at timestamptz
- created_at timestamptz default now()
- updated_at timestamptz default now()
```

### Rule

Gated by `view_subject_phi` / `edit_subject_phi`, same as `subject_contact_info`. Every write
goes through `AppointmentConfirmationService.logContact`, which also appends a row to
`appointment_confirmation_log` and a `subject_timeline` entry (status/outcome only — no PHI).

---

## 14. Table: appointment_confirmation_log

Append-only per-attempt log backing `appointment_confirmations.contact_attempt_count` — same
role `visit_history` plays for `visits.status`.

```sql
appointment_confirmation_log
- id uuid primary key
- company_id uuid references companies(id)
- visit_id uuid references visits(id)
- contact_method text
- old_status text
- new_status text not null
- notes text
- contacted_by uuid references profiles(id)
- contacted_at timestamptz default now()
```

### Rule

Gated by `view_subject_phi` (SELECT) / `edit_subject_phi` (INSERT) — carries `contact_notes`,
so unlike `visit_history` it is PHI and cannot reuse a `view_visits`/`manage_visits`-level
policy. No UPDATE/DELETE policy: rows are immutable once written.

---

## 15. Automation

```text
Subject Created
→ Approved Visit Template Found
→ Baseline Visit Scheduled (placeholder, no date)
→ Calendar Events Created
→ Subject Timeline Updated
```

```text
Baseline Visit Completed (Baseline Date entered)
→ Baseline Visit Marked Completed
→ Remaining Scheduled Visits Generated (anchored to Baseline Date)
→ Calendar Events Created
→ Subject Timeline Updated
```

```text
Subject Randomized (dedicated Randomize action, Screening status only)
→ Randomization Number + Date Recorded
→ Subject Status → Randomized
→ Subject Timeline Updated
```

```text
Visit Completed
→ Chart Created
→ Data Entry Task Created
→ Analytics Updated
```

---

## 16. Implementation Notes for Claude

- Rescheduling a visit must update the related calendar event.
- Cancelled visits should not be deleted.
- Unscheduled visits should be stored in the same `visits` table with `visit_type = unscheduled`.
- Future visits may be recalculated when rescheduling, but only after user confirmation.
