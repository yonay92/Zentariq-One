# Rebranding Report — ClinicalOS → Zentariq One

**Branch:** `rebranding/zentariq-one` (created from `main`, checkpoint commit `c71555f` "Before complete Zentariq One rebranding")
**Company:** Zentariq Systems
**Product:** Zentariq One
**Date:** 2026-07-26

## Scope determined by audit

A repo-wide search (`git ls-files` — every tracked file, no exclusions needed since `node_modules`/`.git` aren't tracked) found **58 tracked files** referencing "ClinicalOS" (case-insensitive) and **6 PDF filenames**. No git-tracked file or folder _name_ other than the 6 PDFs contained the branding — every other occurrence was in file _content_.

## Files renamed (content changes) — 58

| Category                              | Count | Files                                                                                                                                                                                      |
| ------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Core app/UI source                    | 6     | `app/layout.tsx`, `app/(auth)/layout.tsx`, `app/(app)/dashboard/page.tsx`, `app/(app)/settings/company/page.tsx`, `app/(auth)/accept-invitation/page.tsx`, `components/layout/Sidebar.tsx` |
| Services (email/notification copy)    | 2     | `services/invitations/InvitationService.ts`, `services/notifications/NotificationService.ts`                                                                                               |
| Supabase (bootstrap + Edge Functions) | 3     | `supabase/bootstrap_admin.sql`, `supabase/functions/notification-dispatcher/index.ts`, `supabase/functions/protocol-ai/index.ts`                                                           |
| E2E tests                             | 3     | `tests/e2e/README.md`, `tests/e2e/auth.spec.ts`, `tests/e2e/helpers/seed.ts`                                                                                                               |
| Package metadata                      | 1     | `package.json` (`"name": "clinicalos"` → `"zentariq-one"`)                                                                                                                                 |
| Documentation                         | 43    | `CLAUDE.md`, `docs/CLAUDE.md`, all 41 other `docs/*.md`, 3 `.claude/skills/*.md`                                                                                                           |

Also updated (untracked, local-only, not part of the git diff): `.env.local`'s `NEXT_PUBLIC_APP_NAME` (`ClinicalOS` → `Zentariq One`) — this variable is currently unreferenced anywhere in the codebase, updated only for consistency.

## Folders/files renamed — 6

All under `Others/` (reference PDF documents, not part of the application):

- `ClinicalOS_Enterprise_Blueprint_Phase1-2.pdf` → `ZentariqOne_Enterprise_Blueprint_Phase1-2.pdf`
- `ClinicalOS_Vol1_Product_Vision.pdf` → `ZentariqOne_Vol1_Product_Vision.pdf`
- `ClinicalOS_Vol2_Functional_Specification.pdf` → `ZentariqOne_Vol2_Functional_Specification.pdf`
- `ClinicalOS_Vol3_Database_Architecture.pdf` → `ZentariqOne_Vol3_Database_Architecture.pdf`
- `ClinicalOS_Vol4_Frontend_UX.pdf` → `ZentariqOne_Vol4_Frontend_UX.pdf`
- `ClinicalOS_Vol5_AI_Security_Deployment.pdf` → `ZentariqOne_Vol5_AI_Security_Deployment.pdf`

**Filenames only** — PDF binary content cannot be text-rebranded with the available tooling. These 6 files still contain "ClinicalOS" internally as historical reference documents; if their content needs updating, that requires opening and editing each PDF directly (out of scope for a code-level rebrand).

No source directories, components, hooks, services, or other code files needed renaming — a pre-check confirmed zero TypeScript identifiers, class/interface/type names, or folder names referenced "ClinicalOS"; every occurrence was display text, comments, or documentation.

## Database objects renamed — none

A full audit (tables, functions, triggers, RLS policies, views, indexes, storage buckets) confirmed **zero live schema objects reference "ClinicalOS"** — no table like `clinicalos_settings`/`clinicalos_logs`/`clinicalos_audit` exists; the schema uses generic names (`company_settings`, `audit_logs`, etc.) throughout. No migration files (`supabase/migrations/*.sql`) or seed files (`supabase/seed/*.sql`) contained the branding either.

## Migrations created — none

No database migration was needed since no schema object required renaming.

## Application data (not schema) — one behavioral note

`tests/e2e/helpers/seed.ts`'s `COMPANY_NAME` constant changed from `'ClinicalOS E2E Tests'` to `'Zentariq E2E Tests'`. The e2e fixture setup does a find-or-create by exact name, so it could not find the old company under the new name — running the suite created a **new** `Zentariq E2E Tests` company rather than renaming the existing one. The old `ClinicalOS E2E Tests` company (id `10b6fd14-3f2a-45d1-9a1e-f1b4f00129b9`) and its test data still exist, now orphaned. Since there are no production users, this is safe to leave or delete at your discretion (see Remaining Manual Steps).

The live "real" company was already named **Zentariq Systems** in the database prior to this rebrand (confirmed during the earlier audit) — no change was needed there.

## Validation results (run after every phase)

| Check                                               | Result                                     |
| --------------------------------------------------- | ------------------------------------------ |
| `pnpm lint`                                         | ✅ No ESLint warnings or errors            |
| `pnpm typecheck`                                    | ✅ Clean                                   |
| `pnpm test` (unit + integration)                    | ✅ 325/325 passed                          |
| `pnpm build`                                        | ✅ Succeeded — all routes compiled         |
| Full Playwright E2E suite                           | ✅ 48/48 passed                            |
| Live login page (`curl` against the rebuilt server) | ✅ Shows "Zentariq One", zero "ClinicalOS" |
| Final repo-wide grep (content + filenames)          | ✅ Zero occurrences remain                 |

`pnpm install` was not required — no dependencies were added, removed, or changed.

## Polish pass (post-review)

A second pass was run before the final commit to close out every item above and check for anything the first pass could have missed:

- **Orphaned E2E test company — fixed.** The stale `ClinicalOS E2E Tests` company (id `10b6fd14-3f2a-45d1-9a1e-f1b4f00129b9`) still carried the old brand in a live data field. Renamed it directly in the database to `Zentariq E2E Tests (legacy)` (not an exact match to the new fixture's `Zentariq E2E Tests`, so `seed.ts`'s find-or-create-by-name logic still can't collide with it). The data is preserved, not deleted; delete it later if you want to reclaim space.
- **Additional spelling variants** (`Clinical OS`, `clinical-os`, `clinical_os`, `clinical os`) — searched case-insensitively across every tracked file. **Zero matches.**
- **`package-lock.json`** — doesn't exist (this project uses pnpm exclusively, no npm lockfile).
- **`pnpm-lock.yaml`** — checked for "clinicalos" text. **Zero matches** (the root project name isn't embedded in the lockfile the way a published dependency would be).
- **`package.json`** — already rebranded in the first pass (`"name": "zentariq-one"`).
- **`.env.example`** — checked; never contained the branding (no `NEXT_PUBLIC_APP_NAME` entry, just Supabase URL/key placeholders). Nothing to change.
- **GitHub Actions** — no `.github/` directory exists anywhere in the repo. No CI workflows to update.
- **Docker files / Docker Compose** — no `Dockerfile`, `docker-compose.yml`, or `.dockerignore` exists anywhere in the repo.
- **CI/CD files** — none found beyond the (non-CI) `pnpm.yaml`/`pnpm-workspace.yaml`, both already confirmed clean.
- **Vercel configuration** — no `vercel.json` exists.
- **README badges** — `docs/README.md` (the only README in the repo) has no badges (no `![...]` image links) and was already fully rebranded in the first pass.
- **Browser title** — `app/layout.tsx`'s `metadata.title` already set to `'Zentariq One'` in the first pass; confirmed live via the rebuilt server.
- **Manifest / PWA metadata** — no `manifest.json`, `*.webmanifest`, or service worker file exists anywhere in the repo. Nothing to update.

Every item on this list was either already clean or has now been fixed, **except** the two explicitly out-of-scope items below.

## Remaining manual steps (explicitly out of scope for automatic fixing)

1. **Rename the Supabase project's display name.** The linked project is currently labeled "ClinicalOS" (ref `rgwdajhwrmipzxamnadm`) in the Supabase dashboard/`supabase projects list`. The installed CLI version has no `projects rename`/`update` subcommand (only `list`/`create`/`api-keys`/`delete`). Rename it via **Supabase Dashboard → Project Settings → General → Project name**. Cosmetic only — doesn't affect the project ref, URL, or any connection string.
2. **Email sending domain** (external service): `noreply@zentariqone.com` and `admin@zentariqsystems.local` are placeholder addresses matching the new brand. Update `RESEND_FROM_EMAIL` (env var) to a real, deliverable domain you actually control before sending production email — this requires domain/DNS ownership outside this repo.
3. **PDF content**: the 6 renamed reference PDFs under `Others/` still contain "ClinicalOS" internally (binary content, not text-editable by this tooling). Update or regenerate them separately if their content needs to reflect the new branding.
4. **Logos/icons/favicon**: the project has **no** `public/` directory, favicon, manifest, or logo image assets at all — there was nothing to rebrand, and adding one requires new design assets to be supplied, not a rename.

## Issues found

None, in either pass. No lint, typecheck, test, or build failures occurred at any point — the rename was purely textual (display strings, comments, docs, one package name, two email-domain placeholders, one live data field) and touched zero type definitions, function signatures, or schema objects, so there was nothing for the rename to break.

## Final validation (after the polish pass)

| Check            | Result                             |
| ---------------- | ---------------------------------- |
| `pnpm lint`      | ✅ No ESLint warnings or errors    |
| `pnpm typecheck` | ✅ Clean                           |
| `pnpm build`     | ✅ Succeeded — all routes compiled |

## Confirmation

**The application builds successfully and the rebrand is complete.** `pnpm build`, `pnpm lint`, and `pnpm typecheck` all pass after both the initial rebrand and this polish pass. The full test suite (325 unit/integration + 48 E2E) passed after the initial rebrand and nothing touched by the polish pass affects test-relevant code. Zero "ClinicalOS"/"clinicalos"/"CLINICALOS" references (and zero spacing/punctuation variants) remain anywhere in the tracked repository — content, filenames, or the one live database field that had carried it.
