# CLAUDE.md

This file is the single source of truth for working on Zentariq One with Claude Code. **Part 1** documents the project itself (what it is, how it's built, how to set it up). **Part 2** is the authoritative engineering policy — mandatory for every development session unless the user explicitly overrides it.

## Table of Contents

**Part 1 — Project Documentation**

- [Project Overview](#project-overview)
- [Tech Stack](#tech-stack)
- [Repository Structure](#repository-structure)
- [Environment Variables](#environment-variables)
- [Development Setup](#development-setup)
- [Branch Naming](#branch-naming)
- [Sprint Workflow & Definition of Done](#sprint-workflow--definition-of-done)
- [Non-Negotiable Architecture Conventions](#non-negotiable-architecture-conventions)
- [Key Documentation References](#key-documentation-references)

**Part 2 — Engineering Handbook (Authoritative Policy)**

- [Git Workflow](#git-workflow)
- [Coding Rules](#coding-rules)
- [Performance](#performance)
- [Testing](#testing)
- [Architecture](#architecture)
- [Documentation](#documentation)
- [UI](#ui)
- [Security](#security)
- [Clinical Research Domain Rules](#clinical-research-domain-rules)
- [Product Roadmap Priorities](#product-roadmap-priorities)
- [AI Behavior](#ai-behavior)

---

# Part 1 — Project Documentation

## Project Overview

Zentariq One is an enterprise SaaS platform for clinical research operations, combining CTMS, eRegulatory, Business Rules Engine, Clinical Intelligence, Task Center, Enterprise Document Center, and Analytics.

Full specification lives in `docs/`. Always read the relevant doc before implementing anything — reference it explicitly when making decisions (see [AI Behavior](#ai-behavior)).

## Tech Stack

- **Frontend**: Next.js, React, TypeScript, Tailwind CSS
- **Backend**: Supabase (PostgreSQL, Auth, Storage, Edge Functions, Realtime)
- **Package manager**: pnpm
- **Tests**: Vitest, Playwright, React Testing Library
- **Deploy**: Vercel (auto-deploy on main)

## Repository Structure

```
/app          Next.js app router pages and API routes
/components   Shared UI components
/features     Feature-based modules (one folder per domain)
/lib          Utilities and shared logic
/services     Service layer (business logic, not UI)
/hooks        React hooks
/types        TypeScript type definitions
/supabase     migrations/, seed/, functions/, policies/
/docs         Full specification — source of truth
/public       Static assets
```

## Environment Variables

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY   ← NEVER expose to the frontend
```

## Development Setup

When scaffolding or bootstrapping the app (`pnpm create next-app`), set up:

- ESLint (Next.js includes it; configure `eslint.config.mjs` with TypeScript rules)
- Prettier (`pnpm add -D prettier`) with a `.prettierrc` and a `format` script in `package.json`: `"format": "prettier --write"`
- `pnpm install`
- `.env.local` with the three Supabase env vars above

The format-on-edit hook in `.claude/settings.json` auto-activates once `package.json` exists with a `format` script.

## Branch Naming

`feature/sprint-N-module-name` — e.g. `feature/sprint-1-auth`, `feature/sprint-3-subjects`.

## Sprint Workflow & Definition of Done

Implement one sprint at a time. Before writing code, run `/implement-sprint` to read specs and propose a plan. See sprint sequence in `@docs/DEVELOPMENT_PLAN.md`.

A sprint is done when it meets every rule in the [Testing](#testing) section, plus:

- End-to-end tests pass (Playwright)
- Responsive UI
- Audit Trail writes
- Permissions validated
- Business Rules trigger where applicable

## Non-Negotiable Architecture Conventions

Concrete schema/code conventions specific to this project (see [Architecture](#architecture) and [Security](#security) for the general policy these implement):

- Every business table has `company_id`; site-scoped tables also have `site_id`.
- UUID primary keys everywhere.
- Schema changes via migrations only — never modify production schema manually. All changes live in `/supabase/migrations/`.
- No company-specific or hardcoded tenant logic — everything must be configurable.
- Strict TypeScript: no `any`. Server-side validation required.
- AI-assisted features follow one flow, always: `User Action → AI Analysis → User Review → Business Rules → DB Update`. AI suggestions must go through an approval step before touching the database.
- Every module integrates with Audit Trail, Task Engine, Analytics, and Clinical Intelligence, where applicable.

## Key Documentation References

- Architecture: `@docs/SYSTEM_ARCHITECTURE.md`
- Development plan & sprints: `@docs/DEVELOPMENT_PLAN.md`
- Business rules: `@docs/BUSINESS_RULES_01_Core_Workflow.md` (through `_12_Edge_Cases.md`)
- **Business Rule Engine schema**: `@docs/BUSINESS_RULE_ENGINE.md` ← read before implementing any rule or BRE call
- Database schema: `@docs/DATABASE_Part_01_Core_SaaS_Users_Roles_Sites.md` (through `_05`)
- UI/UX specs: `@docs/UI_UX_01_Design_System.md` (through `_16`)
- Supabase setup: `@docs/SUPABASE_SETUP.md`
- Security: `@docs/SECURITY.md`
- Testing: `@docs/TESTING.md`
- Clinical Intelligence agents: `@docs/CI_01_Architecture.md` (through `_10`)
- **AI provider & model config**: `@docs/AI_PROVIDER_ARCHITECTURE.md` ← read before implementing any AI agent
- **Notifications**: `@docs/NOTIFICATIONS.md` ← defines tables, event catalog, and dispatch service
- **User invitations**: `@docs/INVITATIONS.md` ← defines invite flow, token lifecycle, acceptance API

---

# Part 2 — Engineering Handbook (Authoritative Policy)

## Git Workflow

- Never commit directly to main.
- Always work on a feature branch.
- Use Conventional Commits.
- Push only after all tests pass.
- Open a Pull Request when a feature is complete.
- Never merge unless I explicitly request it.

## Coding Rules

- Preserve business rules unless I explicitly approve changes.
- Avoid breaking API contracts.
- Avoid unnecessary schema changes.
- Prefer the smallest safe change.
- Reuse existing architecture before creating new abstractions.
- Keep company/site permission isolation intact.

## Performance

- Never optimize based on assumptions.
- Measure first.
- Identify the bottleneck.
- Optimize only the proven bottleneck.
- Remove temporary instrumentation before committing.

## Testing

- Run TypeScript checks.
- Run ESLint.
- Run all applicable unit tests.
- Run integration tests when applicable.
- Never commit if tests fail.

## Architecture

- Keep services cohesive.
- Avoid duplicated queries.
- Parallelize only independent reads.
- Keep writes deterministic and ordered.
- Reuse existing project patterns before introducing new abstractions.

## Documentation

- Update documentation when behavior changes.
- Use clear Conventional Commit messages.
- Create comprehensive Pull Request descriptions.

## UI

- Follow the existing design system.
- Prefer consistency over redesign.
- Show proper loading states.
- Show proper empty states.
- Show actionable error messages.

## Security

- Respect RLS.
- Never bypass authorization.
- Never weaken permission checks.

## Clinical Research Domain Rules

- A Study must be approved before Subjects can be created.
- Subjects must always follow the approved Visit Template.
- Visit sequencing is driven by visit_order and required predecessors, never visit names.
- Timeline and audit entries are required for state-changing actions.
- Multi-company isolation must always be preserved.
- Site isolation must always be preserved.
- Every mutation must remain auditable.
- Maintain compatibility with AI-generated studies.

## Product Roadmap Priorities

Current development priority:

1. Visit Calendar
2. Document Center
3. Task Engine
4. EDC
5. Reports
6. Patient Portal
7. Sponsor Portal

Avoid implementing lower-priority features unless I explicitly request them.

## AI Behavior

- Ask before making architectural decisions.
- Do not introduce speculative optimizations.
- Explain tradeoffs before major refactors.
- Prefer production-ready implementations over prototypes.
- Before adding new modules, search the codebase to verify the feature does not already exist.
- Prefer extending existing components and services over creating duplicate functionality.
- If a requested feature already exists partially, complete and harden it instead of rebuilding it.
- Keep the project modular, scalable, and maintainable.
- Think like a senior software architect building a commercial SaaS CTMS product.
- Propose a plan before implementing any sprint and wait for approval before writing code.
- Reference the relevant `docs/` file explicitly when making architecture or implementation decisions.
- Never generate placeholder or TODO code — every function must be fully implemented or explicitly flagged for a follow-up sprint.

---

These rules are mandatory unless explicitly overridden by the user.
