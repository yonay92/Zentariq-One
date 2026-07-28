# DATABASE_Part_02.md

# Zentariq One Database Architecture — Part 02

## Studies, Study Sites, Study Staff, Visit Templates, Study Documents

Version: 1.0  
Project: Zentariq One

---

## 1. Purpose

This part defines how Zentariq One stores studies, staff assignments, study sites, protocol versions, AI extractions, and visit templates.

A Study is not just a record. It is the operational foundation for Subjects, Visits, Charts, Regulatory Documents, Analytics, and Business Rules.

---

## 2. Table: studies

Stores the primary study record.

```sql
studies
- id uuid primary key
- company_id uuid references companies(id)
- study_name text not null
- protocol_number text
- sponsor text
- cro text
- phase text
- therapeutic_area text
- status text default 'draft'
- start_date date
- end_date date
- protocol_version text
- ai_generated boolean default false
- created_by uuid references profiles(id)
- created_at timestamptz default now()
- updated_at timestamptz default now()
```

### Status Values

- draft
- active
- on_hold
- closed
- archived

### Notes

A study may be created manually or from AI protocol extraction.

---

## 3. Table: study_sites

Connects studies to one or more sites.

```sql
study_sites
- id uuid primary key
- company_id uuid references companies(id)
- study_id uuid references studies(id)
- site_id uuid references sites(id)
- status text default 'active'
- created_at timestamptz default now()
```

### Rule

Subjects can only be created for study-site combinations that exist in this table.

---

## 4. Table: study_staff

Assigns users to studies.

```sql
study_staff
- id uuid primary key
- company_id uuid references companies(id)
- study_id uuid references studies(id)
- user_id uuid references profiles(id)
- staff_role text not null
- start_date date
- end_date date
- active boolean default true
- created_at timestamptz default now()
```

### Staff Roles

- PI
- Sub-I
- CRC
- Data Entry
- Regulatory
- Site Director
- Other

### Notes

Do not store PI or CRC directly inside `studies`. Staff changes over time.

---

## 5. Table: visit_templates

Represents a versioned visit schedule template for a study.

```sql
visit_templates
- id uuid primary key
- company_id uuid references companies(id)
- study_id uuid references studies(id)
- version text not null
- source text default 'manual'
- status text default 'draft'
- approved_by uuid references profiles(id)
- approved_at timestamptz
- created_at timestamptz default now()
```

### Source Values

- manual
- ai_generated
- imported

### Status Values

- draft
- approved
- archived

### Rule

Only one approved visit template should be active per study unless future protocol versions require multiple active templates.

---

## 6. Table: visit_template_items

Stores individual visits inside a visit template.

```sql
visit_template_items
- id uuid primary key
- company_id uuid references companies(id)
- template_id uuid references visit_templates(id)
- visit_name text not null
- visit_order integer not null
- offset_days integer not null
- window_before integer default 0
- window_after integer default 0
- visit_type text default 'scheduled'
- is_required boolean default true
- is_baseline boolean default false
- notes text
- created_at timestamptz default now()
```

### Rule

Exactly one item per template must have `is_baseline = true`. This is the visit a
Subject's Baseline Date anchors to and the one scheduled as a placeholder at Subject
creation (see `DATABASE_Part_03` §12).

### Example

| Visit    | Offset | Window |
| -------- | -----: | ------ |
| Baseline |      0 | 0      |
| Week 4   |     28 | ±7     |
| Week 8   |     56 | ±7     |

---

## 7. Table: study_documents

Stores documents directly related to a study.

```sql
study_documents
- id uuid primary key
- company_id uuid references companies(id)
- study_id uuid references studies(id)
- document_type text not null
- version text
- file_id uuid references files(id)
- uploaded_by uuid references profiles(id)
- uploaded_at timestamptz default now()
- ai_processed boolean default false
```

### Document Types

- Protocol
- ICF
- Investigator Brochure
- Pharmacy Manual
- Laboratory Manual
- Schedule of Assessments
- Other

---

## 8. Table: study_ai_extractions

Stores AI extraction results from protocols and study documents.

```sql
study_ai_extractions
- id uuid primary key
- company_id uuid references companies(id)
- study_id uuid references studies(id)
- extraction_type text not null
- confidence numeric
- extracted_data jsonb not null
- reviewed_by uuid references profiles(id)
- approved boolean default false
- created_at timestamptz default now()
```

### Extraction Types

- study_profile
- visit_template
- inclusion_criteria
- exclusion_criteria
- schedule_of_assessments
- protocol_amendment_comparison

### Rule

AI extraction never becomes production data until reviewed and approved.

`study_ai_extractions` is only used for **amendments to an existing study**
(`POST /api/studies/:id/protocol`). The new-study-from-protocol flow uses `study_drafts`
(below) instead, since no `studies` row exists yet to attach an extraction to.

---

## 9. Table: study_drafts

Temporary holding area for a protocol upload that has **not yet become a study**. The Guided
AI Draft workflow (`POST /api/studies/ai-drafts`) uploads the protocol PDF and runs the Protocol
Agent against this table instead of a real `studies` row; a human reviews and edits every field
and the visit schedule before "Finalize" creates the real study.

```sql
study_drafts
- id uuid primary key
- company_id uuid references companies(id)
- file_id uuid references files(id)              -- the uploaded protocol PDF
- status text not null default 'processing'      -- processing | ready | failed | finalized
- confidence numeric
- uncertain_fields jsonb not null default '[]'    -- ["field — reason", ...]
- extracted_profile jsonb not null default '{}'   -- study_name, sponsor, indication, ... (nulls left blank, never guessed)
- extracted_visit_items jsonb not null default '[]'
- extracted_extra jsonb not null default '{}'     -- inclusion/exclusion criteria, schedule of assessments, required documents
- error_message text
- study_id uuid references studies(id)            -- populated once finalized
- created_by uuid references profiles(id)
- created_at timestamptz default now()
- updated_at timestamptz default now()
```

### Rule

A draft never becomes a study on its own. `POST /api/studies/ai-drafts/:id/finalize` is the only
path that creates the `studies` row, the visit template (if any items were submitted), and the
`study_documents` row attaching the protocol PDF — all from the (possibly human-edited) draft
contents, validated by `finalizeAiDraftSchema`.

---

## 10. Suggested Indexes

```sql
create index idx_studies_company on studies(company_id);
create index idx_study_sites_study on study_sites(study_id);
create index idx_study_sites_site on study_sites(site_id);
create index idx_study_staff_study on study_staff(study_id);
create index idx_visit_templates_study on visit_templates(study_id);
create index idx_visit_template_items_template on visit_template_items(template_id);
create index idx_study_drafts_company on study_drafts(company_id);
```

---

## 11. Workflow

```text
Upload Protocol
→ AI extracts a study_drafts row (study profile + visit schedule; unknowns left blank)
→ Human reviews and edits every field on the guided review screen
→ Human finalizes: real Study + Visit Template + protocol Document are created together
→ Admin selects sites
→ Admin approves the visit template
→ Visit Template becomes active
→ Subjects can be created
```

---

## 12. Implementation Notes for Claude

- Do not allow automatic activation of AI-extracted templates.
- Always require Review & Approve.
- Support manual template creation.
- Support protocol amendments by creating new template versions.
- Never overwrite old visit templates.
- New-study-from-protocol uploads must not create a `studies` row until the human finalizes the
  `study_drafts` review — see `POST /api/studies/ai-drafts/:id/finalize`.
