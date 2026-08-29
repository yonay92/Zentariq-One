# E2E test infrastructure

## Running

The server is **not** started automatically outside CI (see
`playwright.config.ts` — `webServer` is CI-only, and runs `pnpm start`, i.e.
a production build). Start one yourself first:

```
pnpm build && pnpm start   # matches CI — do this before trusting a full run
pnpm test:e2e
```

`pnpm dev` also works, but Next's on-demand route compilation in dev mode
adds enough latency to the _first_ hit of an unvisited route that a handful
of specs can flake past their timeout under `fullyParallel` load — this is a
dev-server artifact, not a real bug. If a test fails only under `pnpm dev`,
re-run it against `pnpm build && pnpm start` before assuming it's real.

`PLAYWRIGHT_BASE_URL` overrides the target (default `http://localhost:3000`).

## What global-setup.ts does

Runs once before the whole suite (`playwright.config.ts` → `globalSetup`):

1. **Identity fixtures** (`helpers/seed.ts`, idempotent — find-or-create,
   safe to run every invocation without accumulating duplicates): a dedicated
   company ("Zentariq E2E Tests"), one site, and four roles:
   - `e2e_admin` — every permission except the standard deliberate-override
     exclusions (`force_archive_*`, `reopen_visit`) — mirrors a real
     bootstrapped Administrator, which includes `view_subject_phi` /
     `edit_subject_phi` by default since migration 013 (product decision).
   - `e2e_phi` — base subject/visit read access + both PHI permissions,
     granted the same way a company owner would grant them to a non-admin
     role via Settings > Roles.
   - `e2e_nophi` — the same base access, deliberately without PHI — proves
     the gate still blocks a role that was never granted it.
   - `e2e_reopener` — the same base access as `e2e_phi`/`e2e_nophi` plus
     `manage_visits` and `reopen_visit`. Added for `visit-calendar.spec.ts`'s
     Reopen coverage: `e2e_admin` deliberately excludes `reopen_visit` (see
     above) and neither other persona holds it, so none of the three original
     personas could exercise the "has the permission" side of that gate. Both
     permissions are required to actually perform a reopen: `reopen_visit`
     satisfies `VisitService.reopenVisit`'s app-level "dangerous operation"
     override check, while `manage_visits` satisfies the separate RLS gate
     that any UPDATE on `visits` requires (migration
     `010_visit_calendar.sql`) — without it the write is silently blocked by
     RLS regardless of `reopen_visit`.

   One user per role (`e2e-admin@zentariq-e2e.test`, etc., password in
   `E2E_PASSWORD`). All four roles are granted `view_all_sites`, so no
   `user_sites` bookkeeping is needed.

2. **Study fixtures** — NOT idempotent, created fresh every run: as the admin
   persona, over the real API (never raw SQL, so GAP-REQ-03's approved-template
   gate and `activateStudy`'s approved-template requirement are exercised
   exactly as the UI would trigger them) — two studies, each assigned to the
   seeded Site:
   - The PHI suite's study, with a 2-item Visit Template (`Baseline`,
     `is_baseline: true`, offset 0; a second item titled `Visit 2 (<runId>)`,
     also offset 0), approved and activated.
   - `visit-calendar.spec.ts`'s Calendar study, with a 4-item Visit Template
     (`Baseline` plus three independent non-baseline items — Lifecycle,
     Reschedule, and Cancel visits, one per action under test so they don't
     collide on a shared visit), approved and activated. The admin persona is
     also assigned as this study's active CRC directly via `study_staff`
     (`helpers/seed.ts`'s `assignCrcStaff`) — there is no app-level API/UI to
     manage study staff yet, so this is a raw write for the same reason the
     identity fixtures above are, giving the Calendar's CRC filter a real,
     deterministic option.

   A fresh study per run means each spec always starts from a clean,
   subject-free study — no cross-run cleanup needed. Item titles that include
   the run's timestamp do so deliberately: this suite never deletes what it
   creates (a dedicated, disposable e2e project — see below), so a fixed
   title would collide with same-day runs' calendar events landing on the
   same day.

3. **Auth** — a real `POST /api/auth/signin` per persona via
   `request.newContext()`, then `storageState()` saved to
   `tests/e2e/.auth/{admin,phi,nophi,reopener}.json` (gitignored — these are
   live session cookies). Spec files load a persona via
   `test.use({ storageState: ... })` — currently all specs run as
   `admin.json` except `phi-contact-info.spec.ts`'s PHI/no-PHI blocks and
   `visit-calendar.spec.ts`'s Reopen block (`reopener.json`).

4. `tests/e2e/.auth/fixtures.json` — `{ siteName, studyName, studyId,
visit2Name, calendarStudyName, calendarStudyId, lifecycleVisitName,
rescheduleVisitName, cancelVisitName, crcFullName }` for spec files to read.

`helpers/apiScaffold.ts` (`scaffoldActiveStudy`) is the shared "Study →
assign Site → Visit Template → approve → activate" API sequence — used by
global-setup.ts for the shared PHI-suite study, and again by
`subject-creation.spec.ts` to build its own throwaway study rather than
coupling to another file's fixtures.

## Why real backend, not mocks

This exercises actual RLS policies and `PermissionService` checks end to
end — the thing that matters for a PHI-permission test is that a real
`view_subject_phi`-less session really can't read the row, not that a mocked
`fetch` was told to return 403.

**This is safe only because the target Supabase project
(`NEXT_PUBLIC_SUPABASE_URL` in `.env.local`) is a dedicated dev/e2e project.**
Do not point `PLAYWRIGHT_BASE_URL` / `.env.local` at a project holding real
data and run this suite against it.

## Why Confirm/Start/Complete-Baseline run via `page.request`, not UI clicks

Both `tests/e2e/phi-contact-info.spec.ts`'s admin block and
`tests/e2e/visit-calendar.spec.ts`'s first block progress their subject's
Baseline visit through `page.request.post(...)` calls to the same
`/api/subjects/[id]/visits/[visitId]/confirm` / `/start` and
`/api/subjects/[id]/baseline` endpoints `VisitConfirmer` / `VisitStarter` /
`SubjectBaselineCompleter` already call. This is prerequisite scaffolding (a
calendar-visible non-baseline visit needs a real `target_date`, which only
exists once Baseline is completed — see
`VisitService.upsertCalendarEventForVisit`), not the feature under test, and
those UI components already have their own coverage. What each suite exists
to test — the PHI Contact Info / Appointment Confirmation workflow, and the
Visit Calendar's views/filters/lifecycle actions, respectively — is driven
entirely through the browser from that point on.
