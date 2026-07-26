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
   company ("Zentariq E2E Tests"), one site, and three roles:
   - `e2e_admin` — every permission except the standard deliberate-override
     exclusions (`force_archive_*`, `reopen_visit`) — mirrors a real
     bootstrapped Administrator, which includes `view_subject_phi` /
     `edit_subject_phi` by default since migration 013 (product decision).
   - `e2e_phi` — base subject/visit read access + both PHI permissions,
     granted the same way a company owner would grant them to a non-admin
     role via Settings > Roles.
   - `e2e_nophi` — the same base access, deliberately without PHI — proves
     the gate still blocks a role that was never granted it.

   One user per role (`e2e-admin@zentariq-e2e.test`, etc., password in
   `E2E_PASSWORD`). All three roles are granted `view_all_sites`, so no
   `user_sites` bookkeeping is needed.

2. **Study fixtures** — NOT idempotent, created fresh every run: as the admin
   persona, over the real API (never raw SQL, so GAP-REQ-03's approved-template
   gate and `activateStudy`'s approved-template requirement are exercised
   exactly as the UI would trigger them) — a new Study, assigned to the
   seeded Site, with a 2-item Visit Template (`Baseline`, `is_baseline: true`,
   offset 0; a second item titled `Visit 2 (<runId>)`, also offset 0),
   approved and activated. A fresh study per run means the spec always starts
   from a clean, subject-free study — no cross-run cleanup needed.

   The second item's title includes the run's timestamp deliberately: this
   suite never deletes what it creates (a dedicated, disposable e2e project —
   see below), so a fixed title would collide with same-day runs' calendar
   events landing on the same day.

3. **Auth** — a real `POST /api/auth/signin` per persona via
   `request.newContext()`, then `storageState()` saved to
   `tests/e2e/.auth/{admin,phi,nophi}.json` (gitignored — these are live
   session cookies). Spec files load a persona via
   `test.use({ storageState: ... })` — currently all specs run as
   `admin.json` except `phi-contact-info.spec.ts`'s PHI/no-PHI blocks.

4. `tests/e2e/.auth/fixtures.json` — `{ siteName, studyName, studyId,
visit2Name }` for spec files to read.

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

`tests/e2e/phi-contact-info.spec.ts`'s admin block progresses the Baseline
visit through `page.request.post(...)` calls to the same
`/api/subjects/[id]/visits/[visitId]/confirm` / `/start` and
`/api/subjects/[id]/baseline` endpoints `VisitConfirmer` / `VisitStarter` /
`SubjectBaselineCompleter` already call. This is prerequisite scaffolding
(a calendar-visible Visit 2 needs a real `target_date`, which only exists
once Baseline is completed — see `VisitService.upsertCalendarEventForVisit`),
not the feature under test, and those UI components already have their own
coverage. The PHI Contact Info / Appointment Confirmation workflow itself —
the thing this suite exists to test — is driven entirely through the browser.
