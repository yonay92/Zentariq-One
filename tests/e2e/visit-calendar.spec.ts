/**
 * E2E tests: Visit Calendar (Milestone 2).
 * Runs against the Next.js dev/prod server (baseURL from playwright.config.ts)
 * with a real Supabase backend — see tests/e2e/global-setup.ts, which
 * provisions a dedicated Calendar study (4 items: Baseline + 3 independent
 * non-baseline visits, one per lifecycle action under test) and assigns the
 * admin persona as that study's CRC, and tests/e2e/README.md for the full
 * fixture design.
 *
 * Grouped as one test.describe.serial() block because the scenarios are
 * genuinely sequential — they share a single created subject and its three
 * generated visits, exercised first by the admin persona (views, filters,
 * Confirm/Start/Complete, Reschedule, Cancel) and then by the reopener
 * persona (Reopen, gated by the reopen_visit permission).
 *
 * Out of scope (per the approved Milestone 2 plan): drag-and-drop
 * rescheduling, operational/non-patient calendar events, Chart/Task
 * auto-creation.
 *
 * Site isolation: the deeper, permission-level case (a user restricted to a
 * subset of sites via user_sites, lacking view_all_sites) is already covered
 * by tests/integration/site-isolation.test.ts (SiteService /
 * PermissionService.canAccessSite) — every seeded e2e persona holds
 * view_all_sites, so there is no existing site-scoped persona to reuse and
 * this suite deliberately does not stand up new site/user_sites fixtures
 * just to duplicate that coverage at the E2E layer (see tests/e2e/README.md's
 * "reuse, don't duplicate" convention). What this suite verifies instead is
 * the Calendar's own Site filter: selecting the seeded site correctly scopes
 * the visible events.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { format, addDays } from 'date-fns';

const AUTH_DIR = join(__dirname, '.auth');
const ADMIN_STATE = join(AUTH_DIR, 'admin.json');
const REOPENER_STATE = join(AUTH_DIR, 'reopener.json');

const fixtures = JSON.parse(readFileSync(join(AUTH_DIR, 'fixtures.json'), 'utf-8')) as {
  siteName: string;
  calendarStudyName: string;
  calendarStudyId: string;
  lifecycleVisitName: string;
  rescheduleVisitName: string;
  cancelVisitName: string;
  crcFullName: string;
};

type VisitSummary = { id: string; visit_name: string };

let subjectId = '';

test.describe.serial('Visit Calendar', () => {
  test.describe('Admin: scaffold subject + progress Baseline (prerequisite, not the feature under test)', () => {
    test.use({ storageState: ADMIN_STATE });

    // Driven via page.request, not UI clicks — same rationale as
    // phi-contact-info.spec.ts: a calendar-visible non-baseline visit needs a
    // real target_date, which only exists once Baseline is completed (see
    // VisitService.upsertCalendarEventForVisit / SubjectService's baseline
    // completion). Those components already have their own coverage; the
    // Calendar UI itself is what this file exists to test.
    test('creates a subject against the Calendar study and completes Baseline', async ({
      page,
    }) => {
      const sitesRes = await page.request.get('/api/sites');
      const sites = ((await sitesRes.json()) as { data: Array<{ id: string; name: string }> }).data;
      const site = sites.find((s) => s.name === fixtures.siteName);
      expect(site).toBeTruthy();

      const createRes = await page.request.post('/api/subjects', {
        data: {
          study_id: fixtures.calendarStudyId,
          site_id: site!.id,
          subject_number: `E2E-CAL-${Date.now()}`,
        },
      });
      expect(createRes.ok()).toBeTruthy();
      subjectId = ((await createRes.json()) as { data: { id: string } }).data.id;

      const visitsRes = await page.request.get(`/api/subjects/${subjectId}/visits`);
      expect(visitsRes.ok()).toBeTruthy();
      const visits = ((await visitsRes.json()) as { data: VisitSummary[] }).data;
      const baseline = visits.find((v) => v.visit_name === 'Baseline');
      expect(baseline).toBeTruthy();

      const confirmRes = await page.request.post(
        `/api/subjects/${subjectId}/visits/${baseline!.id}/confirm`,
      );
      expect(confirmRes.ok()).toBeTruthy();

      const startRes = await page.request.post(
        `/api/subjects/${subjectId}/visits/${baseline!.id}/start`,
      );
      expect(startRes.ok()).toBeTruthy();

      const today = format(new Date(), 'yyyy-MM-dd');
      const baselineRes = await page.request.post(`/api/subjects/${subjectId}/baseline`, {
        data: { baseline_date: today },
      });
      expect(baselineRes.ok()).toBeTruthy();
    });
  });

  test.describe('Admin: Month / Week / Day views', () => {
    test.use({ storageState: ADMIN_STATE });

    test('Month view (the default) shows all three seeded visits', async ({ page }) => {
      await page.goto('/calendar');
      await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
      await expect(page.getByRole('button', { name: fixtures.lifecycleVisitName })).toBeVisible({
        timeout: 10000,
      });
      await expect(page.getByRole('button', { name: fixtures.rescheduleVisitName })).toBeVisible();
      await expect(page.getByRole('button', { name: fixtures.cancelVisitName })).toBeVisible();
    });

    test('Week view shows the same visits', async ({ page }) => {
      await page.goto('/calendar');
      await page.getByRole('button', { name: /^week$/i }).click();
      await expect(page.getByRole('button', { name: fixtures.lifecycleVisitName })).toBeVisible({
        timeout: 10000,
      });
      await expect(page.getByRole('button', { name: fixtures.rescheduleVisitName })).toBeVisible();
      await expect(page.getByRole('button', { name: fixtures.cancelVisitName })).toBeVisible();
    });

    test("Day view shows the same visits under today's date heading", async ({ page }) => {
      await page.goto('/calendar');
      await page.getByRole('button', { name: /^day$/i }).click();

      const heading = format(new Date(), 'EEEE, MMMM d, yyyy');
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      await expect(page.getByRole('button', { name: fixtures.lifecycleVisitName })).toBeVisible({
        timeout: 10000,
      });
      await expect(page.getByRole('button', { name: fixtures.rescheduleVisitName })).toBeVisible();
      await expect(page.getByRole('button', { name: fixtures.cancelVisitName })).toBeVisible();
    });
  });

  test.describe('Admin: Site / Study / Status / CRC filters', () => {
    test.use({ storageState: ADMIN_STATE });

    test('each filter narrows without hiding the seeded visits', async ({ page }) => {
      await page.goto('/calendar');
      await expect(page.getByRole('button', { name: fixtures.lifecycleVisitName })).toBeVisible({
        timeout: 10000,
      });

      await page.getByLabel('Site').selectOption({ label: fixtures.siteName });
      await expect(page.getByRole('button', { name: fixtures.lifecycleVisitName })).toBeVisible();

      await page.getByLabel('Study').selectOption({ label: fixtures.calendarStudyName });
      await expect(page.getByRole('button', { name: fixtures.lifecycleVisitName })).toBeVisible();

      // All three visits are still 'scheduled' at this point in the file —
      // this block runs before the Confirm/Start/Complete, Reschedule, and
      // Cancel blocks below, deliberately.
      await page.getByLabel('Status').selectOption({ label: 'Scheduled' });
      await expect(page.getByRole('button', { name: fixtures.lifecycleVisitName })).toBeVisible();
      await expect(page.getByRole('button', { name: fixtures.rescheduleVisitName })).toBeVisible();
      await expect(page.getByRole('button', { name: fixtures.cancelVisitName })).toBeVisible();

      await page.getByLabel('CRC').selectOption({ label: fixtures.crcFullName });
      await expect(page.getByRole('button', { name: fixtures.lifecycleVisitName })).toBeVisible();

      await page.getByRole('button', { name: 'Reset filters' }).click();
      await expect(page.getByLabel('Site')).toHaveValue('');
      await expect(page.getByLabel('Study')).toHaveValue('');
      await expect(page.getByLabel('Status')).toHaveValue('');
      await expect(page.getByLabel('CRC')).toHaveValue('');
    });

    test('an active filter survives switching view mode and navigating the date', async ({
      page,
    }) => {
      await page.goto('/calendar');
      await expect(page.getByRole('button', { name: fixtures.lifecycleVisitName })).toBeVisible({
        timeout: 10000,
      });

      await page.getByLabel('Study').selectOption({ label: fixtures.calendarStudyName });
      const studySelect = page.getByLabel('Study');
      await expect(studySelect).toHaveValue(fixtures.calendarStudyId);

      await page.getByRole('button', { name: /^week$/i }).click();
      await expect(studySelect).toHaveValue(fixtures.calendarStudyId);

      await page.getByRole('button', { name: /^day$/i }).click();
      await expect(studySelect).toHaveValue(fixtures.calendarStudyId);

      await page.getByRole('button', { name: 'Next' }).click();
      await expect(studySelect).toHaveValue(fixtures.calendarStudyId);

      await page.getByRole('button', { name: 'Previous' }).click();
      await page.getByRole('button', { name: 'Today' }).click();
      await expect(studySelect).toHaveValue(fixtures.calendarStudyId);

      await page.getByRole('button', { name: /^month$/i }).click();
      await expect(studySelect).toHaveValue(fixtures.calendarStudyId);
    });
  });

  test.describe('Admin: Confirm -> Start -> Complete lifecycle via the Calendar UI', () => {
    test.use({ storageState: ADMIN_STATE });

    test('progresses the Lifecycle visit through its full state machine from the detail panel', async ({
      page,
    }) => {
      await page.goto('/calendar');
      const event = page.getByRole('button', { name: fixtures.lifecycleVisitName });
      await expect(event).toBeVisible({ timeout: 10000 });
      await event.click();

      const dialog = page.getByRole('dialog', { name: fixtures.lifecycleVisitName, exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('scheduled', { exact: true })).toBeVisible();

      await dialog.getByRole('button', { name: 'Confirm' }).click();
      await expect(dialog.getByText('confirmed', { exact: true })).toBeVisible();

      await dialog.getByRole('button', { name: 'Start' }).click();
      await expect(dialog.getByText('in progress', { exact: true })).toBeVisible();

      await dialog.getByRole('button', { name: 'Complete' }).click();
      const completeModal = page.getByRole('dialog', {
        name: `Complete ${fixtures.lifecycleVisitName}`,
        exact: true,
      });
      await expect(completeModal).toBeVisible();
      await completeModal.getByLabel('Completion date').fill(format(new Date(), 'yyyy-MM-dd'));
      await completeModal.getByRole('button', { name: 'Save' }).click();

      await expect(completeModal).not.toBeVisible();
      await expect(dialog.getByText('completed', { exact: true })).toBeVisible();
    });
  });

  test.describe('Admin: Reschedule', () => {
    test.use({ storageState: ADMIN_STATE });

    test('reschedules the Reschedule visit to a new target date with a reason', async ({
      page,
    }) => {
      await page.goto('/calendar');
      const event = page.getByRole('button', { name: fixtures.rescheduleVisitName });
      await expect(event).toBeVisible({ timeout: 10000 });
      await event.click();

      const dialog = page.getByRole('dialog', {
        name: fixtures.rescheduleVisitName,
        exact: true,
      });
      await expect(dialog).toBeVisible();

      await dialog.getByRole('button', { name: 'Reschedule' }).click();
      const modal = page.getByRole('dialog', {
        name: `Reschedule ${fixtures.rescheduleVisitName}`,
        exact: true,
      });
      await expect(modal).toBeVisible();

      const newDate = format(addDays(new Date(), 5), 'yyyy-MM-dd');
      await modal.getByLabel('New target date').fill(newDate);
      await modal.getByLabel('Reason').fill('E2E Milestone 2 reschedule test');
      await modal.getByRole('button', { name: 'Save' }).click();

      await expect(modal).not.toBeVisible();
      // Scoped to the Target Date field specifically — rescheduling also adds
      // a visit_note ("Rescheduled from ... to <newDate>: ..."), which would
      // make an unscoped getByText(newDate) match two elements once the
      // Notes section renders it.
      await expect(dialog.locator('dt:has-text("Target Date") + dd')).toHaveText(newDate);
    });
  });

  test.describe('Admin: Cancel', () => {
    test.use({ storageState: ADMIN_STATE });

    test('cancels the Cancel visit with a reason', async ({ page }) => {
      await page.goto('/calendar');
      const event = page.getByRole('button', { name: fixtures.cancelVisitName });
      await expect(event).toBeVisible({ timeout: 10000 });
      await event.click();

      const dialog = page.getByRole('dialog', { name: fixtures.cancelVisitName, exact: true });
      await expect(dialog).toBeVisible();

      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      const modal = page.getByRole('dialog', {
        name: `Cancel ${fixtures.cancelVisitName}`,
        exact: true,
      });
      await expect(modal).toBeVisible();

      await modal.getByLabel('Reason').fill('E2E Milestone 2 cancel test');
      await modal.getByRole('button', { name: 'Cancel Visit' }).click();

      await expect(modal).not.toBeVisible();
      await expect(dialog.getByText('cancelled', { exact: true })).toBeVisible();
    });
  });

  test.describe('Admin: Reopen is gated by reopen_visit — admin does not hold it', () => {
    test.use({ storageState: ADMIN_STATE });

    // e2e_admin deliberately excludes reopen_visit (mirrors a real
    // bootstrapped Administrator — see helpers/seed.ts's
    // ADMIN_EXCLUDED_PERMISSIONS), so it doubles as the "without the
    // permission" side of this test without needing a fourth persona.
    test('the completed Lifecycle visit shows no Reopen control, and the API itself rejects reopen', async ({
      page,
    }) => {
      await page.goto('/calendar');
      const event = page.getByRole('button', { name: fixtures.lifecycleVisitName });
      await expect(event).toBeVisible({ timeout: 10000 });
      await event.click();

      const dialog = page.getByRole('dialog', { name: fixtures.lifecycleVisitName, exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('completed', { exact: true })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Reopen' })).toHaveCount(0);

      const visitsRes = await page.request.get(`/api/subjects/${subjectId}/visits`);
      expect(visitsRes.ok()).toBeTruthy();
      const visits = ((await visitsRes.json()) as { data: VisitSummary[] }).data;
      const lifecycle = visits.find((v) => v.visit_name === fixtures.lifecycleVisitName);
      expect(lifecycle).toBeTruthy();

      // Server-side enforcement, not just the UI hiding the button — a real
      // request through the same endpoint VisitReopener calls, from a
      // session that genuinely lacks reopen_visit.
      const reopenRes = await page.request.post(
        `/api/subjects/${subjectId}/visits/${lifecycle!.id}/reopen`,
        { data: { reason: 'attempted without reopen_visit' } },
      );
      // 422, not 403: reopen is gated via PermissionService.guardDangerousOperation
      // (shared with force_archive_study/site, override_do_not_contact), which
      // treats a missing override permission as a blocked business rule rather
      // than a bare permission failure — see VisitService.reopenVisit and
      // tests/unit/services/VisitService.test.ts's "throws BusinessRuleError
      // when the caller lacks reopen_visit" case.
      expect(reopenRes.status()).toBe(422);
      const reopenBody = (await reopenRes.json()) as { error: { code: string } };
      expect(reopenBody.error.code).toBe('BUSINESS_RULE_FAILED');
    });
  });

  test.describe('Reopener persona: holds reopen_visit and can reopen the completed visit', () => {
    test.use({ storageState: REOPENER_STATE });

    test('reopens the Lifecycle visit from the Calendar detail panel', async ({ page }) => {
      await page.goto('/calendar');
      const event = page.getByRole('button', { name: fixtures.lifecycleVisitName });
      await expect(event).toBeVisible({ timeout: 10000 });
      await event.click();

      const dialog = page.getByRole('dialog', { name: fixtures.lifecycleVisitName, exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('completed', { exact: true })).toBeVisible();

      await dialog.getByRole('button', { name: 'Reopen' }).click();
      const modal = page.getByRole('dialog', {
        name: `Reopen ${fixtures.lifecycleVisitName}`,
        exact: true,
      });
      await expect(modal).toBeVisible();
      await modal.getByLabel('Reason').fill('E2E Milestone 2 reopen test');
      await modal.getByRole('button', { name: 'Reopen Visit' }).click();

      await expect(modal).not.toBeVisible();
      await expect(dialog.getByText('in progress', { exact: true })).toBeVisible();
    });
  });
});
