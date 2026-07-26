---
name: security-check
description: Audits a feature or module for Zentariq One security requirements — RLS policies, company_id/site_id isolation, permission checks, audit trail integration, and AI data access rules. Run before marking any feature complete.
---

Perform a security audit on the code you just wrote or on $ARGUMENTS (a specific module, file, or feature name). Check every item in this list and report pass/fail with the specific file and line for any failure.

## 1. Multi-Tenant Isolation

- Every new table has `company_id` (UUID, NOT NULL).
- Site-scoped tables also have `site_id`.
- No query fetches data without filtering by `company_id`.
- No cross-company data can leak through joins or views.

## 2. Row Level Security

- RLS is ENABLED on every new business table.
- Each table has at least one policy for SELECT, INSERT, UPDATE, DELETE.
- Policies reference `company_id` and `site_id` where appropriate.
- Policies use `auth.uid()` and role checks, never hardcoded values.
- No policy disables RLS or uses `USING (true)` without explicit justification.

## 3. API Layer

- Every API route validates the user's session.
- Every API route re-checks permissions at the service layer (not just frontend).
- The `SUPABASE_SERVICE_ROLE_KEY` is only used server-side.
- No sensitive keys are exposed to `NEXT_PUBLIC_*`.

## 4. AI Data Access

- AI agents/edge functions only receive data the authenticated user is permitted to see.
- AI never writes directly to production tables — all AI outputs go through an approval step.
- No AI prompt contains raw PII beyond what the user's role permits.

## 5. Audit Trail

- Every critical action writes an audit record (subject creation, visit completion, document upload, permission change, etc.).
- Audit records include: `user_id`, `company_id`, `action`, `entity_type`, `entity_id`, `before_state` (if update), `after_state`, `timestamp`.
- Audit table itself has no UPDATE or DELETE policy.

## 6. Storage

- All storage buckets are private (no public access).
- File access uses signed URLs with expiration.
- Bucket policies enforce `company_id` scoping.

## 7. TypeScript & Validation

- No `any` types in security-sensitive paths.
- All user input is validated server-side before DB writes.
- No SQL string interpolation — only parameterized queries or Supabase client.

## Report Format

List every check with ✅ PASS or ❌ FAIL. For failures, include the file path and line number and a one-line fix recommendation.
