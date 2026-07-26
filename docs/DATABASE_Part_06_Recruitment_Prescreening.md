# DATABASE_Part_06.md

# Zentariq One Database Architecture — Part 06

## Recruitment & Patient Management

Version: 1.0
Project: Zentariq One

---

## 1. Purpose

Defines the lead pipeline, referral source catalog, and study-specific prescreening
questionnaire/scoring introduced in Sprint 5. See `BUSINESS_RULES_13_Recruitment.md` for the
lifecycle, scoring, and conversion rules these tables implement.

---

## 2. Table: referral_sources

Company-configurable lookup, mirrors `document_types`.

```sql
referral_sources
- id uuid primary key
- company_id uuid references companies(id)
- name text not null
- category text not null  -- physician_referral | advertisement | patient_database | self_referral | social_media | other
- active boolean default true
- created_at timestamptz default now()
- updated_at timestamptz default now()
```

---

## 3. Table: leads

Operational/pipeline table — deliberately carries no PHI (see `lead_contact_info` below).
`site_id` is nullable: a lead may exist in a company-wide pool before being assigned to a site.

```sql
leads
- id uuid primary key
- company_id uuid references companies(id)
- site_id uuid references sites(id)              -- nullable
- study_id uuid references studies(id)            -- nullable
- referral_source_id uuid references referral_sources(id)
- initials text                                   -- auto-generated on first contact-info save
- status text default 'new'                       -- new | contacted | prescreening | waitlisted | converted | declined | lost
- contact_attempt_count integer default 0
- last_contacted_at timestamptz
- next_contact_at timestamptz
- waitlisted_at timestamptz
- converted_subject_id uuid references subjects(id) unique
- converted_at timestamptz
- declined_reason text
- created_by uuid references profiles(id)
- updated_by uuid references profiles(id)
- created_at timestamptz default now()
- updated_at timestamptz default now()
```

---

## 4. Table: lead_contact_info

1:1 with `leads`. PHI — kept in its own table for the same reason as `subject_contact_info`
(migration 012): RLS enforces the PHI permission at the database level regardless of which
application query touches `leads`.

```sql
lead_contact_info
- id uuid primary key
- company_id uuid references companies(id)
- site_id uuid references sites(id)               -- nullable, denormalized from leads.site_id
- lead_id uuid unique references leads(id)
- first_name text not null
- last_name text not null
- date_of_birth date                              -- nullable ("DOB if available")
- sex text                                        -- nullable
- phone_primary text not null
- phone_secondary text
- email text
- preferred_contact_method text default 'phone'   -- phone | email | sms
- created_by uuid references profiles(id)
- updated_by uuid references profiles(id)
- created_at timestamptz default now()
- updated_at timestamptz default now()
```

### Rule

`date_of_birth` and `sex` are optional here but required (`NOT NULL`) on `subject_contact_info`.
`LeadService.convertToSubject` blocks conversion with a clear error if either is missing, rather
than letting the copy step fail on the target table's constraint.

---

## 5. Table: lead_contact_log

Append-only per-attempt log — same shape and precedent as `appointment_confirmation_log`.

```sql
lead_contact_log
- id uuid primary key
- company_id uuid references companies(id)
- lead_id uuid references leads(id)
- contact_method text
- old_status text
- new_status text not null
- notes text
- contacted_by uuid references profiles(id)
- contacted_at timestamptz default now()
```

### Rule

Gated by `view_lead_phi` / `edit_lead_phi`, not `view_leads` / `edit_lead` — notes may carry
PHI-adjacent contact context, same reasoning as `appointment_confirmation_log`.

---

## 6. Table: study_prescreening_questions

Per-study, editable prescreening questionnaire. No draft/approve versioning (unlike
`visit_templates`) — scoped out for MVP.

```sql
study_prescreening_questions
- id uuid primary key
- company_id uuid references companies(id)
- study_id uuid references studies(id)
- question_order integer default 0
- question_text text not null
- question_type text default 'yes_no'    -- yes_no | number | text
- eligible_answer text                   -- yes_no only
- min_eligible_value numeric             -- number only
- max_eligible_value numeric             -- number only
- is_hard_exclusion boolean default false
- is_active boolean default true
- created_by uuid references profiles(id)
- created_at timestamptz default now()
- updated_at timestamptz default now()
```

---

## 7. Table: lead_prescreenings

One row per prescreening **attempt** — a lead may be prescreened for multiple studies, or
re-prescreened for the same study, without ever overwriting a prior attempt. The most recent row
per `(lead_id, study_id)` is authoritative for conversion eligibility.

```sql
lead_prescreenings
- id uuid primary key
- company_id uuid references companies(id)
- lead_id uuid references leads(id)
- study_id uuid references studies(id)
- computed_outcome text not null          -- potentially_eligible | needs_review | not_eligible
- manual_outcome text                     -- same enum, nullable
- manual_override_reason text
- manual_override_by uuid references profiles(id)
- manual_override_at timestamptz
- completed_by uuid references profiles(id)
- completed_at timestamptz default now()
```

---

## 8. Table: lead_prescreening_answers

Snapshots `question_text`/`question_type` at answer time so a later edit or deactivation of the
source question never changes the meaning of a historical answer.

```sql
lead_prescreening_answers
- id uuid primary key
- company_id uuid references companies(id)
- lead_prescreening_id uuid references lead_prescreenings(id)
- question_id uuid references study_prescreening_questions(id)  -- nullable (question may be deleted later)
- question_text text not null
- question_type text not null
- answer_value text not null
- is_eligible_answer boolean              -- null for text questions (never scored)
```

---

## 9. Permissions

`view_leads`, `create_lead`, `edit_lead`, `view_lead_phi`, `edit_lead_phi`, `convert_lead`,
`manage_referral_sources` — module `recruitment`. `view_lead_phi`/`edit_lead_phi` are part of the
Administrator role's default grant (migration 015), matching Subject PHI's current state. Every
other role requires a conscious per-role grant via Settings > Roles. CRC gets the four non-PHI
operational permissions by default.

`study_prescreening_questions` writes are gated by the existing `edit_study` / `manage_studies`
permissions, not a new one — same as `visit_templates`.

---

## 10. Automation

```text
Lead Converted
→ Create Subject (SubjectService.create, unchanged business rules)
→ Copy contact info to subject_contact_info
→ Mark Lead converted, link converted_subject_id
→ Write Audit Log
```
