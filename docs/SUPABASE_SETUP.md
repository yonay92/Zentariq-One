# SUPABASE_SETUP.md

# Zentariq One Supabase Setup Specification

Version: 1.0

## Purpose

This document defines the complete Supabase configuration required for Zentariq One.

Supabase provides:

- PostgreSQL Database
- Authentication
- Row Level Security (RLS)
- Storage
- Edge Functions
- Realtime
- SQL Migrations

---

# 1. Project Configuration

Create a dedicated Supabase project.

Enable:

- Authentication
- Storage
- Realtime
- SQL Editor
- Edge Functions
- Database Backups

---

# 2. Authentication

Provider:

- Email / Password

Future:

- Microsoft
- Google
- SSO (Enterprise)

Requirements:

- Email verification
- Password reset
- Session refresh
- Invitation workflow

---

# 3. Database

Use PostgreSQL.

Requirements:

- UUID primary keys
- Foreign keys
- Indexes
- Constraints
- Soft delete where appropriate

Never use anonymous access.

---

# 4. Row Level Security

Enable RLS on every business table.

General policy:

- company_id isolation
- site_id isolation
- role validation

Users must never access another company's data.

## Data API table grants

RLS decides _which rows_ a role may touch; table privileges decide whether the
role may touch the table _at all_. Supabase projects created on or after
2026-05-30 (and new tables in older projects from 2026-10-30) no longer grant
`anon`, `authenticated` or `service_role` any SELECT/INSERT/UPDATE/DELETE on
`public` tables automatically — without explicit GRANTs every PostgREST query
fails with `42501 permission denied`, even for `service_role` (which bypasses
RLS but not privileges).

Migration `036_data_api_grants.sql` defines the reviewed least-privilege
matrix for every existing table (pinned by
`tests/unit/migrations/dataApiGrants.test.ts`):

- `anon` gets nothing — sign-in uses Supabase Auth, and unauthenticated
  invitation reads run server-side as `service_role`.
- `authenticated` gets only operations the application performs and an RLS
  policy allows.
- `service_role` gets only what the admin client and Edge Functions use.
- Append-only ledgers (audit, history, timeline, logs, comments, notes) are
  never granted UPDATE or DELETE.

---

# 5. Storage Buckets

Required buckets:

- protocols
- regulatory
- subjects
- studies
- avatars
- reports
- exports
- ai-temp

Rules:

- Private buckets only.
- Signed URLs.
- Version support through metadata.

---

# 6. Edge Functions

Suggested functions:

- protocol-ai
- regulatory-ai
- analytics-summary
- document-ocr
- task-generator
- notification-dispatcher

Edge Functions should call external AI providers securely.

---

# 7. Database Functions

Create reusable SQL/RPC functions:

- current_company()
- current_sites()
- has_permission()
- calculate_chart_priority()
- document_health_score()
- study_health_score()

Business calculations should be reusable.

---

# 8. Realtime

Enable realtime for:

- Tasks
- Notifications
- Charts
- Calendar
- AI Suggestions

Do not enable realtime unnecessarily.

---

# 9. Migrations

Store every schema change as SQL migration.

Suggested folders:

/supabase
/migrations
/seed
/functions
/policies

Never modify production schema manually.

Every migration that creates a `public` table must, in the same migration:

1. `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and create its policies.
2. `GRANT` the minimum table privileges each API role needs (see
   [Data API table grants](#data-api-table-grants)). Never grant to `anon`
   without an owner-reviewed requirement, never grant UPDATE/DELETE on
   append-only records, and do not rely on `ALTER DEFAULT PRIVILEGES`.
3. Add the table to the matrix in `tests/unit/migrations/dataApiGrants.test.ts`.

---

# 10. Seed Data

Initial records:

- Roles
- Permissions
- Document Types
- Status values
- Default Business Rules

---

# 11. Environment Variables

NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY

Never expose the Service Role Key to the frontend.

---

# 12. Security

Enable:

- RLS
- Signed URLs
- JWT validation
- Secure storage
- API rate limiting where appropriate

Audit every sensitive operation.

---

# 13. Performance

Use:

- Indexes
- Materialized views (if needed)
- Incremental KPI calculations
- Optimized queries
- Connection pooling

Avoid N+1 query patterns.

---

# 14. Backup Strategy

- Daily automated backups
- Point-in-time recovery
- Storage redundancy
- Migration version control

---

# 15. Final Rules for Claude

- Build the database through migrations.
- Never disable RLS.
- Keep Storage private.
- Use Supabase Auth for identity.
- Keep business logic in services and Business Rules.
- Use Edge Functions only for workloads that require server-side execution or external AI integrations.
