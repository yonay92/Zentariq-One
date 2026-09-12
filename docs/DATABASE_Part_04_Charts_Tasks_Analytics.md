# DATABASE_Part_04.md

# Zentariq One Database Architecture — Part 04

## Charts, Data Entry, Task Center, Analytics

Version: 1.0  
Project: Zentariq One

---

## 1. Purpose

This part defines the Data Entry Pipeline, Chart lifecycle, Task Center, and Analytics storage.

---

## 2. Table: charts

Stores the chart record created from completed visits.

```sql
charts
- id uuid primary key
- company_id uuid references companies(id)
- site_id uuid references sites(id)
- study_id uuid references studies(id)
- subject_id uuid references subjects(id)
- visit_id uuid references visits(id)
- chart_ready_date timestamptz
- entered_in_edc_date timestamptz
- entered_by uuid references profiles(id)
- entered_by_role text
- days_until_entry numeric
- priority text default 'low'
- status text default 'chart_ready'
- created_at timestamptz default now()
- updated_at timestamptz default now()
```

### Status Values

- chart_ready
- in_progress
- entered_in_edc
- on_hold

### Priority Values

- critical
- high
- medium
- low

### Rule

Priority is calculated by the Task Engine, not manually selected.

---

## 3. Table: chart_history

```sql
chart_history
- id uuid primary key
- company_id uuid references companies(id)
- chart_id uuid references charts(id)
- old_status text
- new_status text
- changed_by uuid references profiles(id)
- changed_at timestamptz default now()
- reason text
```

---

## 4. Table: chart_comments

```sql
chart_comments
- id uuid primary key
- company_id uuid references companies(id)
- chart_id uuid references charts(id)
- comment text not null
- created_by uuid references profiles(id)
- created_at timestamptz default now()
```

Implemented in migration `029_chart_comments_metrics.sql`. Append-only —
no UPDATE/DELETE RLS policy exists at all (Milestone 4.3): no edit, no
delete, no hard-delete route. Postable on a locked (`entered_in_edc`)
chart; requires the dedicated `comment_chart` permission, independent of
`view_charts`/`mark_chart_ready`/`mark_chart_entered`/`reopen_chart`.

---

## 5. Table: chart_metrics

Stores calculated chart metrics.

```sql
chart_metrics
- id uuid primary key
- company_id uuid references companies(id)
- chart_id uuid references charts(id) — UNIQUE (Milestone 4.3: one current
  row per chart, recalculated in place via upsert, never an append-only
  history)
- ready_to_entry_hours numeric
- total_entry_hours numeric
- overdue_days numeric
- out_of_window boolean default false
- sponsor_priority boolean default false
- calculated_at timestamptz default now()
```

Implemented in migration `029_chart_comments_metrics.sql`. `overdue_days`
reuses `ChartService.computeChartAging`'s exact formula (Decision 3) — see
`GAP_ANALYSIS.md`'s amended GAP-DUP-03. `sponsor_priority` is currently
always `false` — see `BUSINESS_RULES_05_Charts_DataEntry.md`'s "Known
limitation" note.

---

## 6. Table: chart_assignments

Prepared for future manual or automated chart assignment.

```sql
chart_assignments
- id uuid primary key
- company_id uuid references companies(id)
- chart_id uuid references charts(id)
- assigned_to uuid references profiles(id)
- assigned_at timestamptz default now()
- assigned_by uuid references profiles(id)
- active boolean default true
```

---

## 7. Table: tasks

Central operational work queue.

```sql
tasks
- id uuid primary key
- company_id uuid references companies(id)
- site_id uuid references sites(id)
- assigned_to uuid references profiles(id)
- assigned_role text
- source_module text not null
- source_record_type text
- source_record_id uuid
- title text not null
- description text
- priority text default 'medium'
- status text default 'new'
- due_date timestamptz
- created_by_system boolean default true
- created_at timestamptz default now()
- updated_at timestamptz default now()
```

### Task Status

- new
- assigned
- in_progress
- waiting
- completed
- cancelled

### Task Priority

- critical
- high
- medium
- low

---

## 8. Table: task_history

```sql
task_history
- id uuid primary key
- company_id uuid references companies(id)
- task_id uuid references tasks(id)
- old_status text
- new_status text
- changed_by uuid references profiles(id)
- changed_at timestamptz default now()
- reason text
```

---

## 9. Table: task_comments

```sql
task_comments
- id uuid primary key
- company_id uuid references companies(id)
- task_id uuid references tasks(id)
- comment text not null
- created_by uuid references profiles(id)
- created_at timestamptz default now()
```

---

## 10. Table: analytics_kpis

Stores calculated KPI values.

```sql
analytics_kpis
- id uuid primary key
- company_id uuid references companies(id)
- site_id uuid references sites(id)
- kpi_name text not null
- kpi_value numeric
- period_type text
- period_start date
- period_end date
- calculated_at timestamptz default now()
```

---

## 11. Table: saved_reports

```sql
saved_reports
- id uuid primary key
- company_id uuid references companies(id)
- user_id uuid references profiles(id)
- report_name text not null
- report_type text not null
- filters jsonb
- created_at timestamptz default now()
```

---

## 12. Table: saved_filters

```sql
saved_filters
- id uuid primary key
- company_id uuid references companies(id)
- user_id uuid references profiles(id)
- module_name text not null
- filter_name text not null
- filters jsonb
- created_at timestamptz default now()
```

---

## 13. Table: report_exports

```sql
report_exports
- id uuid primary key
- company_id uuid references companies(id)
- user_id uuid references profiles(id)
- report_type text not null
- file_id uuid references files(id)
- status text default 'completed'
- created_at timestamptz default now()
```

---

## 14. Automation

```text
Chart Ready
→ Calculate Priority
→ Create Task
→ Show in Data Entry Queue
```

```text
Entered in EDC
→ Complete Task
→ Update Chart Metrics
→ Update Analytics
→ Write Audit Log
```

---

## 15. Implementation Notes for Claude

- CRC can view EDC completion fields but cannot edit them once entered by Data Entry.
- Data Entry and authorized CRCs may mark Entered in EDC.
- Always record `entered_by`.
- Tasks should be generated by rules, not manually by default.
