# DATABASE_Part_05.md

# Zentariq One Database Architecture — Part 05

## Regulatory, Enterprise Document Center, Business Rules, Clinical Intelligence, Audit Trail

Version: 1.0  
Project: Zentariq One

---

## 1. Purpose

This part defines the document architecture, regulatory binder, Business Rules, Clinical Intelligence, and Audit Trail.

---

# Regulatory & Documents

## 2. Table: document_types

```sql
document_types
- id uuid primary key
- company_id uuid references companies(id)
- name text not null
- category text
- has_expiration boolean default false
- expiration_rule jsonb
- default_alert_days integer[]
- requires_version boolean default false
- required_by_default boolean default false
- created_at timestamptz default now()
- updated_at timestamptz default now()
```

---

## 3. Table: regulatory_binders

```sql
regulatory_binders
- id uuid primary key
- company_id uuid references companies(id)
- study_id uuid references studies(id)
- site_id uuid references sites(id)
- status text default 'active'
- created_at timestamptz default now()
```

---

## 4. Table: regulatory_documents

```sql
regulatory_documents
- id uuid primary key
- company_id uuid references companies(id)
- site_id uuid references sites(id)
- study_id uuid references studies(id)
- document_type_id uuid references document_types(id)
- file_id uuid references files(id)
- document_name text
- version text
- effective_date date
- expiration_date date
- status text default 'current'
- uploaded_by uuid references profiles(id)
- created_at timestamptz default now()
- updated_at timestamptz default now()
```

### Status Values

- current
- expiring_soon
- expired
- pending
- archived

---

## 5. Table: document_versions

```sql
document_versions
- id uuid primary key
- company_id uuid references companies(id)
- document_id uuid references regulatory_documents(id)
- version text
- file_id uuid references files(id)
- uploaded_by uuid references profiles(id)
- uploaded_at timestamptz default now()
- status text
```

---

## 6. Table: document_history

```sql
document_history
- id uuid primary key
- company_id uuid references companies(id)
- document_id uuid references regulatory_documents(id)
- old_status text
- new_status text
- changed_by uuid references profiles(id)
- changed_at timestamptz default now()
- reason text
```

---

## 7. Table: study_document_requirements

Defines required documents for a study.

```sql
study_document_requirements
- id uuid primary key
- company_id uuid references companies(id)
- study_id uuid references studies(id)
- document_type_id uuid references document_types(id)
- required boolean default true
- expiration_required boolean default false
- applies_to text
```

---

## 8. Table: staff_documents

Stores staff-level documents like GCP, CV, Medical License.

```sql
staff_documents
- id uuid primary key
- company_id uuid references companies(id)
- user_id uuid references profiles(id)
- site_id uuid references sites(id)
- document_type_id uuid references document_types(id)
- file_id uuid references files(id)
- effective_date date
- expiration_date date
- status text default 'current'
- created_at timestamptz default now()
- updated_at timestamptz default now()
```

---

# Enterprise Document Center

## 9. Table: files

```sql
files
- id uuid primary key
- company_id uuid references companies(id)
- file_name text not null
- original_name text
- file_extension text
- mime_type text
- file_size bigint
- storage_path text not null
- uploaded_by uuid references profiles(id)
- uploaded_at timestamptz default now()
- checksum text
- ai_processed boolean default false
```

---

## 10. Table: file_folders

Logical folders.

```sql
file_folders
- id uuid primary key
- company_id uuid references companies(id)
- name text not null
- parent_folder_id uuid references file_folders(id)
- created_at timestamptz default now()
```

---

## 11. Table: file_links

Links files to any module record.

```sql
file_links
- id uuid primary key
- company_id uuid references companies(id)
- file_id uuid references files(id)
- module text not null
- record_id uuid not null
- created_at timestamptz default now()
```

---

## 12. Table: file_versions

```sql
file_versions
- id uuid primary key
- company_id uuid references companies(id)
- file_id uuid references files(id)
- version text
- storage_path text
- uploaded_by uuid references profiles(id)
- uploaded_at timestamptz default now()
```

---

## 13. Table: file_ai_metadata

```sql
file_ai_metadata
- id uuid primary key
- company_id uuid references companies(id)
- file_id uuid references files(id)
- extracted_text text
- document_type text
- confidence numeric
- expiration_date date
- detected_people jsonb
- detected_study jsonb
- created_at timestamptz default now()
```

---

# Business Rules

## 14. Table: business_rules

```sql
business_rules
- id uuid primary key
- company_id uuid references companies(id)
- rule_name text not null
- rule_type text not null
- conditions jsonb not null
- actions jsonb not null
- active boolean default true
- created_by uuid references profiles(id)
- created_at timestamptz default now()
- updated_at timestamptz default now()
```

### Rule Types

- document_expiration
- visit_generation
- chart_priority
- task_creation
- notification
- ai_workflow

---

## 15. Table: rule_execution_logs

```sql
rule_execution_logs
- id uuid primary key
- company_id uuid references companies(id)
- rule_id uuid references business_rules(id)
- source_record_type text
- source_record_id uuid
- result text
- executed_at timestamptz default now()
```

**Note:** `BUSINESS_RULE_ENGINE.md §3.2` extends this table with additional operational columns required by the BRE execution model: `trigger_event text`, `conditions_matched boolean`, `actions_executed jsonb`, `error_message text`. The migration for Sprint 9 must include all columns from that document.

---

# Clinical Intelligence

## 16. Table: ai_agents

```sql
ai_agents
- id uuid primary key
- company_id uuid references companies(id)
- agent_key text not null
- name text not null
- description text
- enabled boolean default true
- created_at timestamptz default now()
```

### Agent Keys (MVP)

- protocol_agent
- regulatory_agent
- subject_agent
- data_agent
- analytics_agent
- executive_agent

**Note:** `training_agent` is excluded from the v1.0 MVP seed data. It must not be inserted into `ai_agents` during initial provisioning. See `AI_PROVIDER_ARCHITECTURE.md §12` and `GAP_ANALYSIS.md GAP-AI-03`.

---

## 17. Table: ai_requests

```sql
ai_requests
- id uuid primary key
- company_id uuid references companies(id)
- user_id uuid references profiles(id)
- agent_key text
- input_type text
- input_data jsonb
- status text default 'pending'
- created_at timestamptz default now()
```

---

## 18. Table: ai_responses

```sql
ai_responses
- id uuid primary key
- company_id uuid references companies(id)
- ai_request_id uuid references ai_requests(id)
- output_data jsonb
- confidence numeric
- requires_review boolean default true
- approved_by uuid references profiles(id)
- approved_at timestamptz
- created_at timestamptz default now()
```

---

# Audit Trail

## 19. Table: audit_logs

```sql
audit_logs
- id uuid primary key
- company_id uuid references companies(id)
- site_id uuid references sites(id)
- user_id uuid references profiles(id)
- action text not null
- module text not null
- record_type text
- record_id uuid
- old_value jsonb
- new_value jsonb
- ip_address text
- user_agent text
- created_at timestamptz default now()
```

---

## 20. Automation

```text
Document Uploaded
→ AI Metadata Extracted
→ Business Rule Evaluated
→ Expiration Calculated
→ Task Created
→ Audit Log Written
```

```text
Protocol Uploaded
→ AI Protocol Extraction
→ Admin Review
→ Study Draft Created
→ Visit Template Draft Created
```

---

## 21. Implementation Notes for Claude

- Files are never public.
- All modules reference files through `file_id`.
- AI never writes final production data without approval.
- Business Rules log every execution.
- Audit logs are immutable.
- Document versions are never overwritten.
