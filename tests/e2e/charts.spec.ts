/**
 * E2E tests: Charts / Data Entry UI (Milestone 4.1).
 * Runs against the Next.js dev/prod server with a real Supabase backend —
 * see tests/e2e/global-setup.ts / tests/e2e/README.md for the shared e2e
 * fixture design. Uses the shared Chart study fixture (Baseline + one
 * follow-up visit, shared with tasks.spec.ts's Chart -> Task automation and
 * kept off the Calendar study so visit-calendar.spec.ts's visits stay
 * unique) — the chart under test is the one automatically created by
 * completing that study's Baseline visit (SubjectService.completeBaselineVisit ->
 * ChartService.ensureChartForCompletedVisit, migration 026), never created
 * directly (Charts has no manual-create path, by design).
 *
 * Personas reused, none added: e2e_admin (view_charts + mark_chart_ready +
 * mark_chart_entered, NOT reopen_chart — matches a real bootstrapped
 * Administrator), e2e_nophi (lacks view_charts entirely — the base access
 * list never included it), e2e_reopener (now also holds view_charts +
 * reopen_chart, extended for this milestone in helpers/seed.ts).
 *
 * Company isolation is intentionally NOT re-proven here — it's already
 * covered at the layer that actually enforces it (RLS/service): see
 * tests/integration/company-isolation.test.ts's "ChartService — company
 * isolation" suite (3 tests, Milestone 4.0). This suite verifies the
 * consequence at the UI/API boundary instead: a request for a
 * nonexistent/out-of-scope chart id renders as not-found, never a
 * permission-revealing error (same resolution tests/e2e/visit-calendar.spec.ts
 * already uses for the site-isolation question — verifying the feature's own
 * filter rather than duplicating service-level coverage).
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const AUTH_DIR = join(__dirname, '.auth');
const ADMIN_STATE = join(AUTH_DIR, 'admin.json');
const NOPHI_STATE = join(AUTH_DIR, 'nophi.json');
const REOPENER_STATE = join(AUTH_DIR, 'reopener.json');

const fixtures = JSON.parse(readFileSync(join(AUTH_DIR, 'fixtures.json'), 'utf-8')) as {
  siteName: string;
  chartStudyName: string;
  chartStudyId: string;
};

// Selects a Chart Queue filter through its real control and waits for the
// list request that carries it (filters change one at a time, so responses
// never overlap).
async function selectChartFilter(
  page: Page,
  label: string,
  option: string,
  param: string,
): Promise<void> {
  await Promise.all([
    page.waitForResponse((res) => {
      const url = new URL(res.url());
      return (
        url.pathname === '/api/charts' &&
        res.request().method() === 'GET' &&
        url.searchParams.has(param)
      );
    }),
    page.getByRole('combobox', { name: label, exact: true }).selectOption({ label: option }),
  ]);
}

// The Chart Queue paginates (25) over every chart the company has ever had —
// this suite never deletes what it creates, and the approved order (priority
// tier, days pending, oldest first) puts a new chart last. The run-specific
// Chart study from global-setup.ts holds only this run's charts, so the
// Study filter isolates the run; the single-page guard then proves the
// visible page is the whole filtered result, so a lookup can't silently miss
// a row that sits on page 2. Waits out the initial load first so a late
// unfiltered response can't overwrite the filtered one.
async function filterToRunChartStudy(page: Page): Promise<void> {
  const settled = page.locator('table').first().or(page.getByText('No charts match these filters'));
  await expect(settled).toBeVisible({ timeout: 10000 });
  await selectChartFilter(page, 'Study', fixtures.chartStudyName, 'study_id');
  await expect(settled).toBeVisible({ timeout: 10000 });
  await expect(
    page.getByText(/^Page \d+ of \d+/),
    'the run-scoped Chart Queue must fit on a single page',
  ).toHaveCount(0);
}

let subjectId = '';
let subjectNumber = '';
let baselineVisitId = '';
let chartId = '';

test.describe.serial('Charts / Data Entry UI', () => {
  test.describe('Admin: scaffold a subject and complete Baseline (prerequisite — creates the chart under test)', () => {
    test.use({ storageState: ADMIN_STATE });

    test('creates a subject, completes Baseline, and finds the auto-created chart', async ({
      page,
    }) => {
      const sitesRes = await page.request.get('/api/sites');
      const sites = ((await sitesRes.json()) as { data: Array<{ id: string; name: string }> }).data;
      const site = sites.find((s) => s.name === fixtures.siteName);
      expect(site).toBeTruthy();

      // This suite never deletes what it creates (a dedicated, disposable e2e
      // project — safe to accumulate across runs, same convention as
      // visit-calendar.spec.ts), so every locator below matches this run's
      // exact subject_number, never a generic prefix that would become
      // ambiguous once a second run's chart is also in the queue.
      subjectNumber = `E2E-CHART-${Date.now()}`;
      const createRes = await page.request.post('/api/subjects', {
        data: {
          study_id: fixtures.chartStudyId,
          site_id: site!.id,
          subject_number: subjectNumber,
        },
      });
      expect(createRes.ok()).toBeTruthy();
      subjectId = ((await createRes.json()) as { data: { id: string } }).data.id;

      const visitsRes = await page.request.get(`/api/subjects/${subjectId}/visits`);
      const visits = (
        (await visitsRes.json()) as {
          data: Array<{ id: string; visit_name: string }>;
        }
      ).data;
      const baseline = visits.find((v) => v.visit_name === 'Baseline');
      expect(baseline).toBeTruthy();
      baselineVisitId = baseline!.id;

      const confirmRes = await page.request.post(
        `/api/subjects/${subjectId}/visits/${baselineVisitId}/confirm`,
      );
      expect(confirmRes.ok()).toBeTruthy();
      const startRes = await page.request.post(
        `/api/subjects/${subjectId}/visits/${baselineVisitId}/start`,
      );
      expect(startRes.ok()).toBeTruthy();

      const today = new Date().toISOString().slice(0, 10);
      const baselineRes = await page.request.post(`/api/subjects/${subjectId}/baseline`, {
        data: { baseline_date: today },
      });
      expect(baselineRes.ok()).toBeTruthy();

      const chartsRes = await page.request.get(`/api/charts?subject_id=${subjectId}`);
      expect(chartsRes.ok()).toBeTruthy();
      const chartsJson = (await chartsRes.json()) as {
        data: { data: Array<{ id: string; status: string }> };
      };
      expect(chartsJson.data.data).toHaveLength(1);
      expect(chartsJson.data.data[0]?.status).toBe('chart_ready');
      chartId = chartsJson.data.data[0]!.id;
    });
  });

  test.describe('Admin: Chart Queue', () => {
    test.use({ storageState: ADMIN_STATE });

    test('shows the new chart, grouped by Site, with Subject/Study/Priority/Status columns', async ({
      page,
    }) => {
      await page.goto('/charts');
      await expect(page.getByRole('heading', { name: 'Chart Queue' })).toBeVisible();
      await filterToRunChartStudy(page);
      await expect(page.getByRole('heading', { name: fixtures.siteName })).toBeVisible({
        timeout: 10000,
      });
      const row = page.locator('tr', { hasText: subjectNumber });
      await expect(row).toBeVisible();
      await expect(row.getByText('Baseline')).toBeVisible();
    });

    test('the Site filter narrows without hiding the seeded chart', async ({ page }) => {
      await page.goto('/charts');
      await filterToRunChartStudy(page);
      await expect(page.getByRole('link', { name: subjectNumber, exact: true })).toBeVisible({
        timeout: 10000,
      });

      await selectChartFilter(page, 'Site', fixtures.siteName, 'site_id');
      await expect(page.getByRole('link', { name: subjectNumber, exact: true })).toBeVisible();

      await selectChartFilter(page, 'Status', 'Chart Ready', 'status');
      await expect(page.getByRole('link', { name: subjectNumber, exact: true })).toBeVisible();
    });

    test('Open Chart navigates to the Chart Detail page', async ({ page }) => {
      await page.goto('/charts');
      await filterToRunChartStudy(page);
      const row = page.locator('tr', { hasText: subjectNumber });
      await expect(row).toBeVisible({ timeout: 10000 });
      await row.getByRole('link', { name: 'Open Chart' }).click();
      await expect(page).toHaveURL(new RegExp(`/charts/${chartId}$`));
    });
  });

  test.describe('Admin: full pre-entry lifecycle from the Chart Detail page', () => {
    test.use({ storageState: ADMIN_STATE });

    test('Start Data Entry moves chart_ready -> in_progress', async ({ page }) => {
      await page.goto(`/charts/${chartId}`);
      await expect(page.getByRole('button', { name: 'Start Data Entry' })).toBeVisible({
        timeout: 10000,
      });
      await page.getByRole('button', { name: 'Start Data Entry' }).click();

      await expect(page.getByText('in progress', { exact: false })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Mark Entered in EDC' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Start Data Entry' })).toHaveCount(0);
    });

    test('Mark Entered in EDC locks the chart and hides the pre-entry actions', async ({
      page,
    }) => {
      await page.goto(`/charts/${chartId}`);
      await expect(page.getByRole('button', { name: 'Mark Entered in EDC' })).toBeVisible({
        timeout: 10000,
      });
      await page.getByRole('button', { name: 'Mark Entered in EDC' }).click();
      await page.getByLabel('Recorded as').selectOption({ label: 'Data Entry' });
      await page.getByRole('button', { name: 'Mark Entered', exact: true }).click();

      await expect(page.getByText(/This chart is Entered in EDC and is locked/)).toBeVisible({
        timeout: 10000,
      });
      await expect(page.getByRole('button', { name: 'Hold' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Mark Entered in EDC' })).toHaveCount(0);
    });

    test('e2e_admin (no reopen_chart) sees no actions on the locked chart', async ({ page }) => {
      await page.goto(`/charts/${chartId}`);
      await expect(page.getByText(/This chart is Entered in EDC and is locked/)).toBeVisible({
        timeout: 10000,
      });
      await expect(page.getByText('No actions available for this chart.')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Reopen' })).toHaveCount(0);
    });

    // Milestone 4.3 / R4: comment_chart is independent of reopen_chart — a
    // comment must be postable on this locked (entered_in_edc) chart even
    // though the section above just proved this same persona has NO other
    // action available on it. Explicitly waits for the real POST response
    // (asserting it actually succeeded server-side) rather than trusting
    // getByText alone against the rendered list — the textarea keeps
    // displaying its typed value until the request resolves, so a
    // text-only assertion here could theoretically pass without a real
    // round trip having completed.
    test('Milestone 4.3: e2e_admin (comment_chart, no reopen_chart) can still add a comment on the locked chart', async ({
      page,
    }) => {
      await page.goto(`/charts/${chartId}#comments`);
      await expect(page.getByPlaceholder('Add a comment…')).toBeVisible({ timeout: 10000 });
      await page.getByPlaceholder('Add a comment…').fill('E2E comment on a locked chart');

      const [postResponse] = await Promise.all([
        page.waitForResponse(
          (res) =>
            res.url().includes(`/api/charts/${chartId}/comments`) &&
            res.request().method() === 'POST',
          { timeout: 10000 },
        ),
        page.getByRole('button', { name: 'Add Comment' }).click(),
      ]);
      expect(postResponse.ok()).toBeTruthy();
      const postBody = (await postResponse.json()) as { success: boolean; data?: { id: string } };
      expect(postBody.success).toBe(true);
      expect(postBody.data?.id).toBeTruthy();

      await expect(page.getByPlaceholder('Add a comment…')).toHaveValue('');
      await expect(page.getByText('E2E comment on a locked chart')).toBeVisible({
        timeout: 10000,
      });
    });

    test('Milestone 4.3: the Metrics panel reflects the completed lifecycle (total entry time recorded, not out of window)', async ({
      page,
    }) => {
      await page.goto(`/charts/${chartId}`);
      await expect(page.getByText('Total Entry Time')).toBeVisible({ timeout: 10000 });
      await expect(page.getByText('Out of Window')).toBeVisible();
      // Baseline was completed on time in the scaffolding step above, so
      // Out of Window must read "No" — this is the one deterministic
      // assertion available without depending on exact elapsed-hours timing.
      const outOfWindowRow = page.locator('div', { hasText: 'Out of Window' }).last();
      await expect(outOfWindowRow.getByText('No')).toBeVisible();
    });
  });

  test.describe('Unauthorized access — e2e_nophi persona (lacks view_charts)', () => {
    test.use({ storageState: NOPHI_STATE });

    test('the Charts nav item is not shown in the sidebar', async ({ page }) => {
      await page.goto('/dashboard');
      await expect(page.getByRole('link', { name: 'Charts' })).toHaveCount(0);
    });

    test('GET /api/charts is rejected with 403', async ({ page }) => {
      const res = await page.request.get('/api/charts');
      expect(res.status()).toBe(403);
    });

    test('GET /api/charts/[id] for a real chart is rejected with 403', async ({ page }) => {
      const res = await page.request.get(`/api/charts/${chartId}`);
      expect(res.status()).toBe(403);
    });

    test('a nonexistent chart id renders as not-found, not a permission error', async ({
      page,
    }) => {
      await page.goto('/charts/00000000-0000-0000-0000-000000000000');
      await expect(page.getByText('Chart not found')).toBeVisible({ timeout: 10000 });
    });

    test('Milestone 4.3: POST /api/charts/[id]/comments is rejected with 403 (lacks comment_chart)', async ({
      page,
    }) => {
      const res = await page.request.post(`/api/charts/${chartId}/comments`, {
        data: { comment: 'Should never be persisted' },
      });
      expect(res.status()).toBe(403);
    });

    test('Milestone 4.3: GET /api/charts/[id]/metrics is rejected with 403 (lacks view_charts)', async ({
      page,
    }) => {
      const res = await page.request.get(`/api/charts/${chartId}/metrics`);
      expect(res.status()).toBe(403);
    });
  });

  test.describe('Authorized reopen — e2e_reopener persona (view_charts + reopen_chart)', () => {
    test.use({ storageState: REOPENER_STATE });

    // Note: "Reopen" is deliberately matched with { exact: true } throughout
    // this block — the reopener persona's own header display name ("ER E2E
    // Reopener") contains "Reopen" as a substring, which Playwright's
    // default (non-exact) getByRole name matching would otherwise also
    // match, misfiring the click against the header user-menu button
    // instead of the chart's own Reopen action.
    test('Reopen requires a non-empty reason', async ({ page }) => {
      await page.goto(`/charts/${chartId}`);
      await expect(page.getByRole('button', { name: 'Reopen', exact: true })).toBeVisible({
        timeout: 10000,
      });
      await page.getByRole('button', { name: 'Reopen', exact: true }).click();
      await page.getByRole('button', { name: 'Reopen Chart' }).click();
      await expect(page.getByText('A reason is required')).toBeVisible();
    });

    test('a reopen with a reason returns the chart to In Progress and records history', async ({
      page,
    }) => {
      await page.goto(`/charts/${chartId}`);
      await expect(page.getByRole('button', { name: 'Reopen', exact: true })).toBeVisible({
        timeout: 10000,
      });
      await page.getByRole('button', { name: 'Reopen', exact: true }).click();
      await page
        .getByPlaceholder('Required — why is this chart being reopened?')
        .fill('E2E correction test');
      await page.getByRole('button', { name: 'Reopen Chart' }).click();

      await expect(page.getByText(/This chart is Entered in EDC and is locked/)).toHaveCount(0);
      await expect(page.getByText('E2E correction test')).toBeVisible({ timeout: 10000 });
      await expect(page.getByText(/entered in edc → in progress/i)).toBeVisible();
    });
  });
});
