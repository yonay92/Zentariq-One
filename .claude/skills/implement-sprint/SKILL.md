---
name: implement-sprint
description: Structured workflow for implementing a Zentariq One sprint. Reads the relevant spec docs, proposes a plan, waits for approval, then builds module by module with audit trail, permissions, business rules, and tests.
disable-model-invocation: true
---

You are implementing a sprint for Zentariq One. Follow these steps exactly.

## Step 1: Identify the Sprint

If $ARGUMENTS specifies a sprint number (e.g. "sprint 3" or "3"), use that. Otherwise ask the user which sprint to implement.

Read `@docs/DEVELOPMENT_PLAN.md` to find the sprint's modules and deliverables.

## Step 2: Read All Relevant Specs

For the sprint's modules, read every applicable doc:

- Business rules: `docs/BUSINESS_RULES_*.md` relevant sections
- Database schema: `docs/DATABASE_Part_*.md` relevant tables
- UI/UX: `docs/UI_UX_*.md` relevant screens
- API: `docs/API.md` relevant endpoints
- Backend services: `docs/BACKEND_SERVICES.md`

Do not start writing code until you have read all applicable specs.

## Step 3: Propose the Implementation Plan

Present a numbered plan covering:

1. Database migrations (tables, RLS policies, indexes, functions)
2. Supabase seed data (if any)
3. Service layer (one service per domain)
4. API routes (Next.js route handlers)
5. UI components and pages (reference `docs/UI_UX_*.md` for each screen)
6. Business Rules integration points
7. Audit Trail events
8. Task Engine integration (if applicable)
9. Analytics update hooks (if applicable)
10. Tests (unit with Vitest, E2E with Playwright)

Cite the specific doc file for each decision. Wait for user approval before writing any code.

## Step 4: Implement Module by Module

Work through the approved plan one module at a time. After each module:

- Confirm RLS is enabled on new tables
- Confirm company_id and site_id are on all relevant tables
- Confirm the Audit Trail event is wired
- Confirm Business Rules triggers are in place (if applicable)

## Step 5: Verify Definition of Done

Before declaring the sprint complete, confirm:

- [ ] Unit tests pass (`pnpm test`)
- [ ] E2E tests pass (`pnpm test:e2e`)
- [ ] TypeScript compiles (`pnpm typecheck`)
- [ ] Lint passes (`pnpm lint`)
- [ ] RLS enabled on every new table
- [ ] Audit Trail writes on every critical action
- [ ] Permissions validated at API layer
- [ ] UI is responsive
- [ ] No placeholder or TODO code remains
