---
name: db-migration
description: Creates a properly structured Supabase SQL migration for Zentariq One — correct naming, UUID keys, company_id/site_id, RLS policies, indexes, and seed data. Run when adding or altering database tables.
disable-model-invocation: true
---

Create a Supabase SQL migration for $ARGUMENTS (describe the tables or changes needed). Follow every rule below.

## Step 1: Read the Schema Spec

Before writing any SQL, read the relevant `docs/DATABASE_Part_*.md` section(s) for the tables you're creating or modifying. Cite the doc section in a comment at the top of the migration file.

## Step 2: Naming Convention

Migration files go in `/supabase/migrations/`.

Filename format: `YYYYMMDDHHMMSS_<description>.sql`
Example: `20240615120000_create_subjects_table.sql`

Use the current timestamp. One migration per logical change.

## Step 3: Migration Contents

Every migration must include in order:

1. **Table creation** (if new table):
   - UUID primary key: `id uuid primary key default gen_random_uuid()`
   - `company_id uuid not null references companies(id)` on all business tables
   - `site_id uuid references sites(id)` on site-scoped tables
   - `created_at timestamptz not null default now()`
   - `updated_at timestamptz not null default now()`
   - Soft-delete field where appropriate: `deleted_at timestamptz`
   - No hardcoded company-specific values

2. **Indexes**:
   - Always index `company_id`
   - Index `site_id` if present
   - Index foreign keys
   - Index any column used in WHERE clauses

3. **Row Level Security**:

   ```sql
   alter table <table_name> enable row level security;

   create policy "<table>_company_isolation" on <table_name>
     for all using (company_id = (select company_id from user_profiles where user_id = auth.uid()));
   ```

   Add more specific policies for INSERT/UPDATE/DELETE as needed.

4. **Updated_at trigger** (if table has `updated_at`):

   ```sql
   create trigger set_updated_at
     before update on <table_name>
     for each row execute function set_updated_at();
   ```

5. **Rollback section** at the bottom as a comment block showing the reverse SQL.

## Step 4: Seed Data (if applicable)

If this migration requires initial lookup data (roles, permissions, document types, status values), create a separate seed file: `/supabase/seed/<description>.sql`

## Step 5: Verify

After writing the migration, check:

- [ ] RLS enabled on every new table
- [ ] `company_id` present on all business tables
- [ ] All foreign keys have indexes
- [ ] No hardcoded UUIDs or company-specific values
- [ ] Rollback SQL is included as a comment
- [ ] File is in `/supabase/migrations/` with correct timestamp name
