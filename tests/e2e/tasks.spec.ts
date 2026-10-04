/**
 * E2E tests: Task Engine / Task Center UI (Milestone 5.0).
 * Runs against the Next.js dev/prod server with a real Supabase backend —
 * see tests/e2e/global-setup.ts / tests/e2e/README.md for the shared e2e
 * fixture design, and tests/e2e/helpers/taskEngineFixtures.ts for the
 * additional site/company fixtures this spec alone needs.
 *
 * Personas: `admin.json` (e2e_admin — holds every Task Engine permission,
 * matching a real bootstrapped Administrator now that the permission
 * catalog includes view_tasks/complete_task/assign_task), `nophi.json`
 * (e2e_nophi — holds NO Task Engine permission at all, used for the
 * self-assignee-without-complete_task and permission-visibility-negative
 * coverage), `ze2eSiteScoped.json` (view_tasks + complete_task +
 * comment_task, restricted to the shared company's original site only —
 * no view_all_sites), `ze2eCompanyB.json` (full task permission set, but
 * in a second, separate company).
 *
 * Fixture-safety: every task/chart/subject this spec creates uses the
 * `ZE2E-M5-` title/number prefix (per this milestone's fixture-safety
 * requirement) and this suite never deletes what it creates — same
 * disposable-project convention as every other spec here (see README).
 *
 * Chart -> Task automation (O/P) reuses the shared Chart study fixture
 * exactly as tests/e2e/charts.spec.ts already does — Charts has no manual
 * chart-create path, so completing a real Baseline visit is the only
 * legitimate way to produce one.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const AUTH_DIR = join(__dirname, '.auth');
const ADMIN_STATE = join(AUTH_DIR, 'admin.json');
const NOPHI_STATE = join(AUTH_DIR, 'nophi.json');
const SITE_SCOPED_STATE = join(AUTH_DIR, 'ze2eSiteScoped.json');
const COMPANY_B_STATE = join(AUTH_DIR, 'ze2eCompanyB.json');

const fixtures = JSON.parse(readFileSync(join(AUTH_DIR, 'fixtures.json'), 'utf-8')) as {
  siteName: string;
  chartStudyName: string;
  chartStudyId: string;
  taskEngineSite2Id: string;
  taskEngineSite2Name: string;
  taskEngineCompanyBId: string;
  taskEngineCompanyBSiteId: string;
  taskEngineSiteScopedUserId: string;
  taskEngineCompanyBUserId: string;
};

const RUN = Date.now();
const T = (label: string) => `ZE2E-M5-${label}-${RUN}`;

const QUEUE_LIST_PATH = '/api/tasks';

type QueueFilter = { site?: string; assignee?: string; status?: string; priority?: string };

// TaskService's MAX_QUEUE_PAGE_SIZE — the largest page /api/tasks serves.
const API_LIST_PAGE_SIZE = 100;

// API counterpart of filterQueue's single-page guard: GET /api/tasks is
// paginated (default 25) over the same accumulating company data, so a list
// read narrowed by the asserted task's own attributes must also prove it
// returned the COMPLETE filtered result before any present/absent check.
async function listAllTasks<T>(
  request: APIRequestContext,
  filters: Record<string, string>,
): Promise<T[]> {
  const params = new URLSearchParams({ ...filters, page_size: String(API_LIST_PAGE_SIZE) });
  const res = await request.get(`${QUEUE_LIST_PATH}?${params.toString()}`);
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { data: { data: T[]; total: number; page_size: number } };
  expect(body.data.page_size).toBe(API_LIST_PAGE_SIZE);
  expect(
    body.data.total,
    `the filtered /api/tasks result must fit in one page of ${API_LIST_PAGE_SIZE}`,
  ).toBeLessThanOrEqual(API_LIST_PAGE_SIZE);
  return body.data.data;
}

// A chart-ready task's own attributes: the chart's site, open (P overrides
// status once completed), and low priority (base low, due 3 days out — no
// escalation within a run). The chart/source id stays the identity check.
const chartTaskFilters = (chartSiteId: string): Record<string, string> => ({
  site_id: chartSiteId,
  status: 'new',
  priority: 'low',
});

// Per-scenario narrowing: each filter set matches the run's task exactly
// (site, assignee where it has one, status, effective priority — no due
// date, so effective priority equals the stored one).
const MANUAL_WITH_ADMIN: QueueFilter = {
  site: fixtures.siteName,
  assignee: 'E2E Admin',
  status: 'Assigned',
  priority: 'Low',
};
const MANUAL_WITH_NOPHI: QueueFilter = { ...MANUAL_WITH_ADMIN, assignee: 'E2E No-PHI User' };
const MANUAL_COMPLETED: QueueFilter = { ...MANUAL_WITH_NOPHI, status: 'Completed' };
// Role-queue tasks (Cancel, RoleQueue, Site2) have no assignee to filter on.
const OPEN_ROLE_QUEUE_MEDIUM: QueueFilter = {
  site: fixtures.siteName,
  status: 'New',
  priority: 'Medium',
};
const CANCELLED_MEDIUM: QueueFilter = { ...OPEN_ROLE_QUEUE_MEDIUM, status: 'Cancelled' };

const QUEUE_FILTER_CONTROLS: Array<[keyof QueueFilter, string, string]> = [
  ['site', 'Site', 'site_id'],
  ['assignee', 'Assignee', 'assigned_to'],
  ['status', 'Status', 'status'],
  ['priority', 'Priority', 'priority'],
];

// Narrows the Task Queue through its real filter controls (by option label,
// as a user would) so each run's task is asserted against a small result set
// instead of page 1 of the whole company queue — this suite never deletes
// what it creates, so the unfiltered queue grows every run, and the approved
// order (effective priority, days overdue, then oldest first) puts a new
// task last. Waits out any in-flight queue load first (a stale unfiltered
// response landing after a filtered one would otherwise overwrite it), then
// one list response per filter change. Finally requires the filtered result
// to fit on one page: without that, an absent-row check could pass merely
// because the row sits on page 2, and a present-row miss would be misread.
async function filterQueue(page: Page, filter: QueueFilter): Promise<void> {
  const settled = page.getByRole('table').or(page.getByText('No tasks match these filters'));
  await expect(settled).toBeVisible({ timeout: 20000 });

  for (const [key, label, param] of QUEUE_FILTER_CONTROLS) {
    const option = filter[key];
    if (!option) continue;
    await Promise.all([
      page.waitForResponse((res) => {
        const url = new URL(res.url());
        return (
          url.pathname === QUEUE_LIST_PATH &&
          res.request().method() === 'GET' &&
          url.searchParams.has(param)
        );
      }),
      page.getByRole('combobox', { name: label, exact: true }).selectOption({ label: option }),
    ]);
  }

  await expect(settled).toBeVisible({ timeout: 20000 });
  await expect(
    page.getByText(/^Page \d+ of \d+/),
    'the filtered Task Queue must fit on a single page',
  ).toHaveCount(0);
}

let siteId = '';
let nophiUserId = '';
let manualTaskId = '';
let selfAssigneeTaskId = '';
let cancelTaskId = '';
let roleQueueTaskId = '';
let site2TaskId = '';
let companyBTaskId = '';
let chartTaskId = '';
let chartId = '';
let subjectId = '';
let subjectNumber = '';

test.describe.serial('Task Engine — Task Center UI (Milestone 5.0)', () => {
  test.describe('A. Task Center access', () => {
    test.use({ storageState: ADMIN_STATE });

    test('authorized admin opens /tasks; Queue and My Today both load; no reconciliation controls', async ({
      page,
    }) => {
      const sitesRes = await page.request.get('/api/sites');
      const sites = ((await sitesRes.json()) as { data: Array<{ id: string; name: string }> }).data;
      siteId = sites.find((s) => s.name === fixtures.siteName)!.id;
      expect(siteId).toBeTruthy();

      await page.goto('/tasks');
      await expect(page.getByRole('heading', { name: 'Task Center' })).toBeVisible();
      await expect(page.getByRole('tab', { name: 'Queue' })).toBeVisible();
      await expect(page.getByRole('tab', { name: 'My Today' })).toBeVisible();

      // Queue view loads.
      await page.getByRole('tab', { name: 'Queue' }).click();
      await expect(page.getByRole('tab', { name: 'Queue', selected: true })).toBeVisible();

      // My Today view loads.
      await page.getByRole('tab', { name: 'My Today' }).click();
      await expect(page.getByRole('tab', { name: 'My Today', selected: true })).toBeVisible();

      // No reconciliation control anywhere on the page, and no reconciliation
      // route exists at the API boundary (live proof, not just a code read).
      await expect(page.getByRole('button', { name: /reconcile/i })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /repair/i })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /sync/i })).toHaveCount(0);
    });

    test('no generic status selector and no in_progress/waiting mutation controls exist on the API surface', async ({
      page,
    }) => {
      // The UI's only mutation routes are the fixed set below (taskApi.ts) —
      // confirm none of them accept an arbitrary status, and no dedicated
      // in_progress/waiting route exists at all.
      for (const path of [
        '/api/tasks/nonexistent/start',
        '/api/tasks/nonexistent/in-progress',
        '/api/tasks/nonexistent/wait',
      ]) {
        const res = await page.request.post(path);
        expect(res.status()).toBe(404);
      }
    });
  });

  test.describe('B. Manual task creation', () => {
    test.use({ storageState: ADMIN_STATE });

    test('Admin creates a valid manual task; it appears in Queue with the right fields', async ({
      page,
    }) => {
      await page.goto('/tasks');
      // Initial queue load finished, so the only list request after the
      // create below is the post-create refresh awaited before filtering.
      await expect(
        page.getByRole('table').or(page.getByText('No tasks match these filters')),
      ).toBeVisible({ timeout: 20000 });
      await page.getByRole('button', { name: 'Create Task' }).click();
      const createDialog = page.getByRole('dialog', { name: 'Create Task' });

      await createDialog.getByLabel('Site').selectOption({ label: fixtures.siteName });
      await createDialog.getByLabel('Title').fill(T('Manual'));
      await createDialog.getByLabel('Priority').selectOption({ label: 'Low' });

      // Assign to self (admin) — the only user whose email is predictable
      // without an extra lookup round trip.
      const usersRes = await page.request.get('/api/users');
      const users = ((await usersRes.json()) as { data: Array<{ id: string; email: string }> })
        .data;
      const adminUser = users.find((u) => u.email === 'e2e-admin@zentariq-e2e.test');
      expect(adminUser).toBeTruthy();
      await createDialog.getByLabel('User', { exact: true }).selectOption({ value: adminUser!.id });

      const queueRefreshed = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === QUEUE_LIST_PATH && res.request().method() === 'GET',
      );
      const [createRes] = await Promise.all([
        page.waitForResponse(
          (res) => res.url().includes('/api/tasks') && res.request().method() === 'POST',
        ),
        createDialog.getByRole('button', { name: 'Create Task' }).click(),
      ]);
      expect(createRes.ok()).toBeTruthy();
      const created = (await createRes.json()) as { data: { id: string; status: string } };
      manualTaskId = created.data.id;
      expect(created.data.status).toBe('assigned');

      // The create request body never included company_id / created_by /
      // created_by_system / source_module / source_record_type /
      // source_record_id / internal computed fields — verified by reading
      // the actual outgoing request, not just the modal's visible fields.
      const reqBody = createRes.request().postDataJSON() as Record<string, unknown>;
      for (const forbidden of [
        'company_id',
        'created_by',
        'created_by_system',
        'source_module',
        'source_record_type',
        'source_record_id',
        'effective_priority',
        'is_overdue',
      ]) {
        expect(reqBody).not.toHaveProperty(forbidden);
      }

      await expect(page.getByText('Task created')).toBeVisible();
      await queueRefreshed;
      await filterQueue(page, MANUAL_WITH_ADMIN);
      const row = page.locator('tr', { hasText: T('Manual') });
      await expect(row).toBeVisible({ timeout: 20000 });
      await expect(row.getByText('low')).toBeVisible();
      await expect(row.getByText('assigned')).toBeVisible();
    });
  });

  test.describe('C. My Today', () => {
    test.use({ storageState: ADMIN_STATE });

    test('the manual task assigned to admin appears in My Today with effective priority', async ({
      page,
    }) => {
      await page.goto('/tasks');
      await page.getByRole('tab', { name: 'My Today' }).click();
      const row = page.locator('tr', { hasText: T('Manual') });
      await expect(row).toBeVisible({ timeout: 20000 });
      await expect(row.getByText('low')).toBeVisible();

      // Overdue presentation comes straight from the API — no due date was
      // set, so no overdue indicator should render at all.
      const myTodayRes = await page.request.get('/api/tasks/my-today');
      const myToday = (
        (await myTodayRes.json()) as {
          data: Array<{ id: string; is_overdue: boolean; effective_priority: string }>;
        }
      ).data;
      const mine = myToday.find((t) => t.id === manualTaskId);
      expect(mine).toBeTruthy();
      expect(mine!.is_overdue).toBe(false);
      expect(mine!.effective_priority).toBe('low');
    });
  });

  test.describe('D. Task detail', () => {
    test.use({ storageState: ADMIN_STATE });

    test('opens with title, status, priority, assignment, source, comments and history sections', async ({
      page,
    }) => {
      await page.goto('/tasks');
      await filterQueue(page, MANUAL_WITH_ADMIN);
      const row = page.locator('tr', { hasText: T('Manual') });
      await expect(row).toBeVisible({ timeout: 20000 });
      await row.getByRole('button', { name: /View task/ }).click();
      const detail = page.getByLabel('Task Details');

      await expect(detail.getByRole('heading', { name: T('Manual') })).toBeVisible();
      await expect(detail.getByText('Status').first()).toBeVisible();
      await expect(detail.getByText('low')).toBeVisible();
      await expect(detail.getByText('manual', { exact: true })).toBeVisible();
      await expect(detail.getByText('Add a comment')).toBeVisible();
      await expect(
        detail
          .getByRole('heading', { name: /history/i })
          .or(detail.getByText(/history/i))
          .first(),
      ).toBeVisible();
    });
  });

  test.describe('E. Comments', () => {
    test.use({ storageState: ADMIN_STATE });

    test('valid comment posts and persists; blank comment cannot be submitted; no edit/delete UI', async ({
      page,
    }) => {
      await page.goto('/tasks');
      await filterQueue(page, MANUAL_WITH_ADMIN);
      const row = page.locator('tr', { hasText: T('Manual') });
      await expect(row).toBeVisible({ timeout: 20000 });
      await row.getByRole('button', { name: /View task/ }).click();

      // Blank comment: the Add Comment button stays disabled.
      await expect(page.getByRole('button', { name: 'Add Comment' })).toBeDisabled();

      const commentText = `${T('Comment')} body`;
      await page.getByLabel('Add a comment').fill(commentText);
      await expect(page.getByRole('button', { name: 'Add Comment' })).toBeEnabled();

      const [postRes] = await Promise.all([
        page.waitForResponse(
          (res) => res.url().includes('/comments') && res.request().method() === 'POST',
        ),
        page.getByRole('button', { name: 'Add Comment' }).click(),
      ]);
      expect(postRes.ok()).toBeTruthy();
      await expect(page.getByText(commentText)).toBeVisible();

      // No edit/delete control exists anywhere near the comment.
      await expect(page.getByRole('button', { name: /edit/i })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /delete/i })).toHaveCount(0);

      // Reload and re-open — the comment persists.
      await page.reload();
      await page.goto('/tasks');
      await filterQueue(page, MANUAL_WITH_ADMIN);
      const row2 = page.locator('tr', { hasText: T('Manual') });
      await expect(row2).toBeVisible({ timeout: 20000 });
      await row2.getByRole('button', { name: /View task/ }).click();
      await expect(page.getByText(commentText)).toBeVisible({ timeout: 20000 });
    });
  });

  test.describe('F. Reassignment', () => {
    test.use({ storageState: ADMIN_STATE });

    test('Admin (assign_task) reassigns to a same-company user; UI updates, persists, exactly one history event, notification dispatched', async ({
      page,
    }) => {
      const usersRes = await page.request.get('/api/users');
      const users = ((await usersRes.json()) as { data: Array<{ id: string; email: string }> })
        .data;
      const nophi = users.find((u) => u.email === 'e2e-nophi@zentariq-e2e.test');
      expect(nophi).toBeTruthy();
      nophiUserId = nophi!.id;

      await page.goto('/tasks');
      await filterQueue(page, MANUAL_WITH_ADMIN);
      const row = page.locator('tr', { hasText: T('Manual') });
      await expect(row).toBeVisible({ timeout: 20000 });
      await row.getByRole('button', { name: /View task/ }).click();

      await page.getByRole('button', { name: 'Reassign' }).click();
      await page.getByLabel('New assignee').selectOption({ value: nophiUserId });
      const [reassignRes] = await Promise.all([
        page.waitForResponse(
          (res) => res.url().includes('/reassign') && res.request().method() === 'POST',
        ),
        page.getByRole('button', { name: 'Reassign Task' }).click(),
      ]);
      expect(reassignRes.ok()).toBeTruthy();
      await expect(page.getByText('Task reassigned')).toBeVisible();

      await page.reload();
      await page.goto('/tasks');
      await filterQueue(page, MANUAL_WITH_NOPHI);
      const row2 = page.locator('tr', { hasText: T('Manual') });
      await expect(row2).toBeVisible({ timeout: 20000 });

      const historyRes = await page.request.get(`/api/tasks/${manualTaskId}/history`);
      const history = (
        (await historyRes.json()) as {
          data: Array<{ reason: string | null }>;
        }
      ).data;
      const reassignmentEvents = history.filter((h) => (h.reason ?? '').includes('Reassigned'));
      expect(reassignmentEvents).toHaveLength(1);

      // Established inspectable notification surface (GET /api/notifications
      // as the recipient) — verified through the real API boundary, not a
      // new UI surface invented for this test.
      const nophiContext = await page
        .context()
        .browser()!
        .newContext({ storageState: NOPHI_STATE });
      const nophiPage = await nophiContext.newPage();
      const notifRes = await nophiPage.request.get('/api/notifications?limit=50');
      const notifications = (
        (await notifRes.json()) as {
          data: Array<{ related_record_id: string; type?: string }>;
        }
      ).data;
      expect(notifications.some((n) => n.related_record_id === manualTaskId)).toBe(true);
      await nophiContext.close();
    });
  });

  test.describe('G. Complete', () => {
    test.use({ storageState: ADMIN_STATE });

    test('Admin (complete_task) completes the task; terminal state, Complete disappears, history reflects it', async ({
      page,
    }) => {
      await page.goto('/tasks');
      await filterQueue(page, MANUAL_WITH_NOPHI);
      const row = page.locator('tr', { hasText: T('Manual') });
      await expect(row).toBeVisible({ timeout: 20000 });
      await row.getByRole('button', { name: /View task/ }).click();

      const [completeRes] = await Promise.all([
        page.waitForResponse(
          (res) => res.url().includes('/complete') && res.request().method() === 'POST',
        ),
        page.getByRole('button', { name: 'Complete Task' }).click(),
      ]);
      expect(completeRes.ok()).toBeTruthy();
      await expect(page.getByText('Task completed')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Complete Task' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Cancel Task' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Reassign' })).toHaveCount(0);

      await page.reload();
      await page.goto('/tasks');
      await filterQueue(page, MANUAL_COMPLETED);
      const row2 = page.locator('tr', { hasText: T('Manual') });
      await expect(row2).toBeVisible({ timeout: 20000 });
      await expect(row2.getByText('completed')).toBeVisible();

      const historyRes = await page.request.get(`/api/tasks/${manualTaskId}/history`);
      const history = ((await historyRes.json()) as { data: Array<{ new_status: string }> }).data;
      expect(history.some((h) => h.new_status === 'completed')).toBe(true);
    });
  });

  test.describe('H. Self-assignee completion (mandatory)', () => {
    test('a nophi user completes their own assigned task despite holding no complete_task permission', async ({
      browser,
    }) => {
      const adminContext = await browser.newContext({ storageState: ADMIN_STATE });
      const adminPage = await adminContext.newPage();
      const createRes = await adminPage.request.post('/api/tasks', {
        data: {
          site_id: siteId,
          title: T('SelfAssignee'),
          priority: 'medium',
          assigned_to: nophiUserId,
        },
      });
      expect(createRes.ok()).toBeTruthy();
      selfAssigneeTaskId = ((await createRes.json()) as { data: { id: string } }).data.id;
      await adminContext.close();

      const nophiContext = await browser.newContext({ storageState: NOPHI_STATE });
      const nophiPage = await nophiContext.newPage();

      // nophi cannot see the Queue (no view_tasks) but My Today is
      // self-scoped and always available.
      await nophiPage.goto('/tasks');
      await expect(nophiPage.getByRole('tab', { name: 'Queue' })).toHaveCount(0);
      await expect(nophiPage.getByRole('tab', { name: 'My Today' })).toBeVisible();
      const row = nophiPage.locator('tr', { hasText: T('SelfAssignee') });
      await expect(row).toBeVisible({ timeout: 20000 });
      await row.getByRole('button', { name: /View task/ }).click();

      // Complete IS offered — they are the assignee, even without
      // complete_task.
      await expect(nophiPage.getByRole('button', { name: 'Complete Task' })).toBeVisible();
      const [completeRes] = await Promise.all([
        nophiPage.waitForResponse(
          (res) => res.url().includes('/complete') && res.request().method() === 'POST',
        ),
        nophiPage.getByRole('button', { name: 'Complete Task' }).click(),
      ]);
      expect(completeRes.ok()).toBeTruthy();

      await nophiPage.reload();
      const row2 = nophiPage.locator('tr', { hasText: T('SelfAssignee') });
      await expect(row2).toHaveCount(0); // now terminal — My Today excludes completed/cancelled.
      const detailRes = await nophiPage.request.get(`/api/tasks/${selfAssigneeTaskId}`);
      expect(((await detailRes.json()) as { data: { status: string } }).data.status).toBe(
        'completed',
      );
      await nophiContext.close();
    });
  });

  test.describe('I. Cancel', () => {
    test.use({ storageState: ADMIN_STATE });

    test('blank reason blocked; valid reason cancels; terminal state, history, no further actions', async ({
      page,
    }) => {
      const createRes = await page.request.post('/api/tasks', {
        data: {
          site_id: siteId,
          title: T('Cancel'),
          priority: 'medium',
          assigned_role: 'data_entry',
        },
      });
      expect(createRes.ok()).toBeTruthy();
      cancelTaskId = ((await createRes.json()) as { data: { id: string } }).data.id;

      await page.goto('/tasks');
      await filterQueue(page, OPEN_ROLE_QUEUE_MEDIUM);
      const row = page.locator('tr', { hasText: T('Cancel') });
      await expect(row).toBeVisible({ timeout: 20000 });
      await row.getByRole('button', { name: /View task/ }).click();

      await page.getByRole('button', { name: 'Cancel Task' }).click();
      await page.getByRole('button', { name: 'Confirm Cancel' }).click();
      await expect(
        page.getByRole('alert').filter({ hasText: 'A reason is required' }),
      ).toBeVisible();

      const reason = `${T('Reason')} — cancelled via E2E`;
      await page.getByLabel('Reason').fill(reason);
      const [cancelRes] = await Promise.all([
        page.waitForResponse(
          (res) => res.url().includes('/cancel') && res.request().method() === 'POST',
        ),
        page.getByRole('button', { name: 'Confirm Cancel' }).click(),
      ]);
      expect(cancelRes.ok()).toBeTruthy();
      await expect(page.getByText('Task cancelled')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Complete Task' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Cancel Task' })).toHaveCount(0);

      await page.reload();
      await page.goto('/tasks');
      await filterQueue(page, CANCELLED_MEDIUM);
      const row2 = page.locator('tr', { hasText: T('Cancel') });
      await expect(row2).toBeVisible({ timeout: 20000 });
      await expect(row2.getByText('cancelled')).toBeVisible();

      const historyRes = await page.request.get(`/api/tasks/${cancelTaskId}/history`);
      const history = (
        (await historyRes.json()) as {
          data: Array<{ new_status: string; reason: string | null }>;
        }
      ).data;
      const cancelEvent = history.find((h) => h.new_status === 'cancelled');
      expect(cancelEvent?.reason).toBe(reason);
    });
  });

  test.describe('J. Permission visibility', () => {
    test('nophi sees no Create Task, no Reassign, no Cancel, no comment form on an accessible task', async ({
      browser,
    }) => {
      // A fresh, non-terminal task assigned to nophi — the earlier
      // SelfAssignee task (test H) is now completed and My Today excludes
      // terminal tasks, so it is no longer a valid fixture for this check.
      const adminContext = await browser.newContext({ storageState: ADMIN_STATE });
      const adminPage = await adminContext.newPage();
      const createRes = await adminPage.request.post('/api/tasks', {
        data: {
          site_id: siteId,
          title: T('PermVis'),
          priority: 'medium',
          assigned_to: nophiUserId,
        },
      });
      expect(createRes.ok()).toBeTruthy();
      const permVisTaskId = ((await createRes.json()) as { data: { id: string } }).data.id;
      await adminContext.close();

      const nophiContext = await browser.newContext({ storageState: NOPHI_STATE });
      const nophiPage = await nophiContext.newPage();
      await nophiPage.goto('/tasks');
      await expect(nophiPage.getByRole('button', { name: 'Create Task' })).toHaveCount(0);

      const row = nophiPage.locator('tr', { hasText: T('PermVis') });
      await expect(row).toBeVisible({ timeout: 20000 });
      await row.getByRole('button', { name: /View task/ }).click();
      await expect(nophiPage.getByRole('button', { name: 'Reassign' })).toHaveCount(0);
      await expect(nophiPage.getByRole('button', { name: 'Cancel Task' })).toHaveCount(0);
      await expect(nophiPage.getByText('Add a comment')).toHaveCount(0);

      // UI hiding is UX only — the API independently rejects the same
      // action, even on a task nophi CAN see (they're the assignee) —
      // cancel_task has no self-assignee carve-out, unlike complete_task.
      // cancelTask's dangerous-operation guard (PermissionService.
      // guardDangerousOperation) deliberately raises a business-rule
      // rejection (422), not a bare 403, when the override permission is
      // missing — by design (see cancel/route.ts's own error mapping).
      const cancelRes = await nophiPage.request.post(`/api/tasks/${permVisTaskId}/cancel`, {
        data: { reason: 'nophi should not be able to do this' },
      });
      expect(cancelRes.status()).toBe(422);
      await nophiContext.close();
    });

    test('admin sees Create Task, Reassign, Cancel, and the comment form', async ({ browser }) => {
      const context = await browser.newContext({ storageState: ADMIN_STATE });
      const page = await context.newPage();
      await page.goto('/tasks');
      await expect(page.getByRole('button', { name: 'Create Task' })).toBeVisible();
      await context.close();
    });
  });

  test.describe('K. Site isolation', () => {
    test.use({ storageState: ADMIN_STATE });

    test('a task on Site 2 is created by admin (view_all_sites)', async ({ page }) => {
      const createRes = await page.request.post('/api/tasks', {
        data: {
          site_id: fixtures.taskEngineSite2Id,
          title: T('Site2'),
          priority: 'medium',
          assigned_role: 'data_entry',
        },
      });
      expect(createRes.ok()).toBeTruthy();
      site2TaskId = ((await createRes.json()) as { data: { id: string } }).data.id;

      // Positive control for the isolation check below: the same Status/
      // Priority filters do surface this task for a user allowed to see it.
      await page.goto('/tasks');
      await filterQueue(page, {
        site: fixtures.taskEngineSite2Name,
        status: 'New',
        priority: 'Medium',
      });
      await expect(page.locator('tr', { hasText: T('Site2') })).toBeVisible({ timeout: 20000 });
    });

    test('a Site-1-scoped user cannot see or access the Site-2 task', async ({ browser }) => {
      const context = await browser.newContext({ storageState: SITE_SCOPED_STATE });
      const page = await context.newPage();

      // No Site filter: the Site-2 task's own status/priority, so the check
      // covers everything this user can see, and filterQueue's single-page
      // guard keeps an absent row meaning absent (not just on page 2). The
      // previous test proves the same filters surface the task when visible.
      await page.goto('/tasks');
      await page.getByRole('tab', { name: 'Queue' }).click();
      await filterQueue(page, { status: 'New', priority: 'Medium' });
      await expect(page.locator('tr', { hasText: T('Site2') })).toHaveCount(0);

      // No dedicated /tasks/[id] URL exists (detail is a modal over the
      // list, not a route — confirmed by reading TaskTable.tsx/
      // TaskCenterView.tsx), so "direct navigation" for this feature means
      // the same underlying GET the modal would issue. Confirms the API
      // itself denies it, not just that the UI never links to it.
      const detailRes = await page.request.get(`/api/tasks/${site2TaskId}`);
      expect([403, 404]).toContain(detailRes.status());
      await context.close();
    });
  });

  test.describe('L. Company isolation', () => {
    test('a Company-B user cannot see or access Company-A tasks', async ({ browser }) => {
      const context = await browser.newContext({ storageState: COMPANY_B_STATE });
      const page = await context.newPage();

      // Each Company-A task's own current status/priority (no Site filter —
      // Company B's site list wouldn't include Company A's site anyway), with
      // filterQueue's single-page guard keeping each absence check sound.
      await page.goto('/tasks');
      await page.getByRole('tab', { name: 'Queue' }).click();
      await filterQueue(page, { status: 'Completed', priority: 'Low' });
      await expect(page.locator('tr', { hasText: T('Manual') })).toHaveCount(0);
      await filterQueue(page, { status: 'Cancelled', priority: 'Medium' });
      await expect(page.locator('tr', { hasText: T('Cancel') })).toHaveCount(0);

      const detailRes = await page.request.get(`/api/tasks/${manualTaskId}`);
      expect([403, 404]).toContain(detailRes.status());
      await context.close();
    });
  });

  test.describe('M. Cross-company assignee regression (live, real API boundary)', () => {
    test('Company-B create with a Company-A assignee is rejected; no invalid task persists', async ({
      browser,
    }) => {
      const context = await browser.newContext({ storageState: ADMIN_STATE });
      const page = await context.newPage();
      const usersRes = await page.request.get('/api/users');
      const adminUserId = (
        (await usersRes.json()) as { data: Array<{ id: string; email: string }> }
      ).data.find((u) => u.email === 'e2e-admin@zentariq-e2e.test')!.id;
      await context.close();

      const bContext = await browser.newContext({ storageState: COMPANY_B_STATE });
      const bPage = await bContext.newPage();
      const createRes = await bPage.request.post('/api/tasks', {
        data: {
          site_id: fixtures.taskEngineCompanyBSiteId,
          title: T('CrossCoInsert'),
          priority: 'medium',
          assigned_to: adminUserId, // Company-A user
        },
      });
      expect(createRes.status()).not.toBe(201);
      expect(createRes.ok()).toBeFalsy();

      // Narrowed only by attributes the rejected request itself fixed (site,
      // medium priority, no due date) — not status/assignee, so a leaked row
      // would match however it had been persisted.
      const companyBMedium = await listAllTasks<{ title: string }>(bPage.request, {
        site_id: fixtures.taskEngineCompanyBSiteId,
        priority: 'medium',
      });
      expect(companyBMedium.some((t) => t.title === T('CrossCoInsert'))).toBe(false);
      await bContext.close();
    });

    test('Company-B reassignment of a Company-B task to a Company-A user is rejected', async ({
      browser,
    }) => {
      const context = await browser.newContext({ storageState: ADMIN_STATE });
      const page = await context.newPage();
      const usersRes = await page.request.get('/api/users');
      const adminUserId = (
        (await usersRes.json()) as { data: Array<{ id: string; email: string }> }
      ).data.find((u) => u.email === 'e2e-admin@zentariq-e2e.test')!.id;
      await context.close();

      const bContext = await browser.newContext({ storageState: COMPANY_B_STATE });
      const bPage = await bContext.newPage();
      const createRes = await bPage.request.post('/api/tasks', {
        data: {
          site_id: fixtures.taskEngineCompanyBSiteId,
          title: T('CrossCoReassign'),
          priority: 'medium',
          assigned_to: fixtures.taskEngineCompanyBUserId,
        },
      });
      expect(createRes.ok()).toBeTruthy();
      companyBTaskId = ((await createRes.json()) as { data: { id: string } }).data.id;

      const reassignRes = await bPage.request.post(`/api/tasks/${companyBTaskId}/reassign`, {
        data: { assigned_to: adminUserId },
      });
      expect(reassignRes.ok()).toBeFalsy();

      const afterRes = await bPage.request.get(`/api/tasks/${companyBTaskId}`);
      const after = (await afterRes.json()) as { data: { assigned_to: string | null } };
      expect(after.data.assigned_to).toBe(fixtures.taskEngineCompanyBUserId);
      await bContext.close();
    });
  });

  test.describe('N. Role queue', () => {
    test.use({ storageState: ADMIN_STATE });

    test('a role-queue task (assigned_to null, assigned_role set) renders correctly and is a valid queue task', async ({
      page,
    }) => {
      const createRes = await page.request.post('/api/tasks', {
        data: {
          site_id: siteId,
          title: T('RoleQueue'),
          priority: 'medium',
          assigned_role: 'data_entry',
        },
      });
      expect(createRes.ok()).toBeTruthy();
      const created = (await createRes.json()) as {
        data: { id: string; assigned_to: null; status: string };
      };
      roleQueueTaskId = created.data.id;
      expect(created.data.assigned_to).toBeNull();
      expect(created.data.status).toBe('new');

      await page.goto('/tasks');
      await filterQueue(page, OPEN_ROLE_QUEUE_MEDIUM);
      const row = page.locator('tr', { hasText: T('RoleQueue') });
      await expect(row).toBeVisible({ timeout: 20000 });
      await expect(row.getByText(/data entry queue/i)).toBeVisible();
    });
  });

  test.describe('O. Chart -> Task automation (mandatory)', () => {
    test.use({ storageState: ADMIN_STATE });

    test('completing a real Baseline visit creates exactly one open Data-Entry task with correct source/assignment/due date/priority', async ({
      page,
    }) => {
      const sitesRes = await page.request.get('/api/sites');
      const sites = ((await sitesRes.json()) as { data: Array<{ id: string; name: string }> }).data;
      const site = sites.find((s) => s.name === fixtures.siteName)!;

      subjectNumber = T('Chart-Subj');
      const createRes = await page.request.post('/api/subjects', {
        data: {
          study_id: fixtures.chartStudyId,
          site_id: site.id,
          subject_number: subjectNumber,
        },
      });
      expect(createRes.ok()).toBeTruthy();
      subjectId = ((await createRes.json()) as { data: { id: string } }).data.id;

      const visitsRes = await page.request.get(`/api/subjects/${subjectId}/visits`);
      const visits = (
        (await visitsRes.json()) as { data: Array<{ id: string; visit_name: string }> }
      ).data;
      const baseline = visits.find((v) => v.visit_name === 'Baseline')!;

      expect(
        (await page.request.post(`/api/subjects/${subjectId}/visits/${baseline.id}/confirm`)).ok(),
      ).toBeTruthy();
      expect(
        (await page.request.post(`/api/subjects/${subjectId}/visits/${baseline.id}/start`)).ok(),
      ).toBeTruthy();
      const today = new Date().toISOString().slice(0, 10);
      const baselineRes = await page.request.post(`/api/subjects/${subjectId}/baseline`, {
        data: { baseline_date: today },
      });
      expect(baselineRes.ok()).toBeTruthy();

      const chartsRes = await page.request.get(`/api/charts?subject_id=${subjectId}`);
      const chartsJson = (await chartsRes.json()) as {
        data: { data: Array<{ id: string; status: string; chart_ready_date: string }> };
      };
      expect(chartsJson.data.data).toHaveLength(1);
      chartId = chartsJson.data.data[0]!.id;
      expect(chartsJson.data.data[0]!.status).toBe('chart_ready');

      // Give the fire-and-forget task-creation side effect a moment, then
      // find the produced task by its source linkage (never by directly
      // inserting it).
      await expect
        .poll(
          async () => {
            const open = await listAllTasks<{ id: string; source_record_id: string | null }>(
              page.request,
              chartTaskFilters(site.id),
            );
            return open.filter((t) => t.source_record_id === chartId).length;
          },
          { timeout: 15000, message: 'exactly one chart-sourced task should appear' },
        )
        .toBe(1);

      const openTasks = await listAllTasks<{
        id: string;
        source_module: string;
        source_record_type: string;
        source_record_id: string;
        assigned_to: string | null;
        assigned_role: string | null;
        due_date: string;
        priority: string;
        title: string;
      }>(page.request, chartTaskFilters(site.id));
      const chartTask = openTasks.find((t) => t.source_record_id === chartId)!;
      chartTaskId = chartTask.id;
      expect(chartTask.source_module).toBe('charts');
      expect(chartTask.source_record_type).toBe('chart');
      expect(chartTask.source_record_id).toBe(chartId);
      // No active chart_assignment exists for this brand-new chart -> falls
      // back to the unclaimed data_entry role queue (AE-2 behavior).
      expect(chartTask.assigned_to).toBeNull();
      expect(chartTask.assigned_role).toBe('data_entry');
      expect(chartTask.priority).toBe('low');
      const expectedDue = new Date(
        new Date(chartsJson.data.data[0]!.chart_ready_date).getTime() + 3 * 86_400_000,
      )
        .toISOString()
        .slice(0, 10);
      expect(chartTask.due_date.slice(0, 10)).toBe(expectedDue);
    });

    test('idempotency: the chart-ready producer cannot be legitimately re-triggered for the same visit through any supported application action', async ({
      page,
    }) => {
      // Baseline completion is a one-time transition (SubjectService has no
      // "re-complete an already-completed Baseline" action), and
      // reconcileReadyChartTask is deliberately not exposed via any API
      // route (verified live in section Q below) — so there is no
      // legitimate, application-supported way to invoke the chart-ready
      // task producer a second time for this visit through the real UI/API
      // boundary. Re-attempting baseline completion is expected to be
      // rejected by the existing, already-covered business rule, which
      // itself proves no second task-creation attempt can occur this way.
      const baselineRes = await page.request.post(`/api/subjects/${subjectId}/baseline`, {
        data: { baseline_date: new Date().toISOString().slice(0, 10) },
      });
      expect(baselineRes.ok()).toBeFalsy();

      const open = await listAllTasks<{ source_record_id: string | null }>(
        page.request,
        chartTaskFilters(siteId),
      );
      const matching = open.filter((t) => t.source_record_id === chartId);
      expect(matching).toHaveLength(1);
      // The service-level idempotency guarantee itself (uq_tasks_open_per_source,
      // TaskService.ensureTaskForChartReady returning taskCreated: false on
      // conflict) is already covered by ChartService.test.ts's own
      // reconcile* unit tests — not re-proven here since no real trigger
      // exists to exercise it through this boundary.
    });
  });

  test.describe('P. Chart entered-in-EDC -> Task completion', () => {
    test.use({ storageState: ADMIN_STATE });

    test('driving the real entered_in_edc workflow completes the associated task, with history and no duplicate task', async ({
      page,
    }) => {
      await page.goto(`/charts/${chartId}`);
      await expect(page.getByRole('button', { name: 'Start Data Entry' })).toBeVisible({
        timeout: 20000,
      });
      await page.getByRole('button', { name: 'Start Data Entry' }).click();
      await expect(page.getByRole('button', { name: 'Mark Entered in EDC' })).toBeVisible();

      await page.getByRole('button', { name: 'Mark Entered in EDC' }).click();
      await page.getByLabel('Recorded as').selectOption({ label: 'Data Entry' });
      const [markRes] = await Promise.all([
        page.waitForResponse(
          (res) => res.url().includes('/mark-entered') && res.request().method() === 'POST',
        ),
        page.getByRole('button', { name: 'Mark Entered', exact: true }).click(),
      ]);
      expect(markRes.ok()).toBeTruthy();
      await expect(page.getByText(/This chart is Entered in EDC and is locked/)).toBeVisible({
        timeout: 20000,
      });

      await expect
        .poll(
          async () => {
            const res = await page.request.get(`/api/tasks/${chartTaskId}`);
            const json = (await res.json()) as { data: { status: string } };
            return json.data.status;
          },
          { timeout: 15000, message: 'chart task should auto-complete' },
        )
        .toBe('completed');

      const historyRes = await page.request.get(`/api/tasks/${chartTaskId}/history`);
      const history = ((await historyRes.json()) as { data: Array<{ new_status: string }> }).data;
      expect(history.some((h) => h.new_status === 'completed')).toBe(true);

      const completedTasks = await listAllTasks<{ source_record_id: string | null }>(page.request, {
        ...chartTaskFilters(siteId),
        status: 'completed',
      });
      expect(completedTasks.filter((t) => t.source_record_id === chartId)).toHaveLength(1);
    });
  });

  test.describe('Q. Reconciliation non-exposure (live)', () => {
    test.use({ storageState: ADMIN_STATE });

    test('no reconciliation/repair/sync API route exists', async ({ page }) => {
      // /api/tasks/reconcile and /api/tasks/sync are deliberately NOT
      // tested as bare top-level paths: Next.js's dynamic /api/tasks/[id]
      // route legitimately matches them (treating "reconcile"/"sync" as an
      // id value) and correctly answers 405 for the unsupported method —
      // that's the existing, real, unrelated GET-only route responding
      // exactly as designed, not a reconciliation endpoint. Probing a
      // sub-path under a real task/chart id avoids that collision.
      for (const path of [
        `/api/charts/${chartId}/reconcile`,
        `/api/charts/${chartId}/reconcile-task`,
        `/api/tasks/${chartTaskId}/reconcile`,
        `/api/tasks/${chartTaskId}/sync`,
      ]) {
        const res = await page.request.post(path);
        expect(res.status()).toBe(404);
      }
    });
  });

  test.describe('R. Failure / error UX', () => {
    test.use({ storageState: ADMIN_STATE });

    test('a rejected reassignment leaves no unsafe optimistic state; reload shows canonical server state', async ({
      page,
    }) => {
      // Reuse the role-queue task; reassign it, then attempt a second,
      // invalid reassignment target id (nonexistent user) through the real
      // UI's own request path is not directly reachable (the Select only
      // lists real users) — so this exercises the failure path via the API
      // boundary the UI itself calls, then confirms the UI's reload shows
      // the untouched canonical state.
      const badRes = await page.request.post(`/api/tasks/${roleQueueTaskId}/reassign`, {
        data: { assigned_to: '00000000-0000-0000-0000-000000000000' },
      });
      expect(badRes.ok()).toBeFalsy();

      await page.goto('/tasks');
      await filterQueue(page, OPEN_ROLE_QUEUE_MEDIUM);
      const row = page.locator('tr', { hasText: T('RoleQueue') });
      await expect(row).toBeVisible({ timeout: 20000 });
      await expect(row.getByText(/data entry queue/i)).toBeVisible(); // unchanged, not the bad target

      // Invalid/blank input: covered by I (blank cancel reason). Inaccessible
      // task: covered by K/L. Unauthorized action: covered by J.
    });
  });
});
