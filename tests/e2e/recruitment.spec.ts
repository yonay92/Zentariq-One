/**
 * E2E tests: Recruitment & Patient Management (Sprint 5).
 * Runs against the Next.js dev/prod server (baseURL from playwright.config.ts)
 * with a real Supabase backend — see tests/e2e/global-setup.ts /
 * tests/e2e/README.md for the shared fixture design (admin/phi/nophi
 * personas, seeded company/site).
 *
 * Covers the golden path end to end through the real UI: create a Study with
 * a prescreening questionnaire, create a Lead in the company-wide pool, add
 * its PHI-gated contact info, submit a prescreening (verifying the automatic
 * eligibility scoring), and convert it into a real enrolled Subject. Also
 * verifies the no-PHI persona can navigate the pipeline but never sees
 * contact details — the same PHI-gating guarantee already proven for
 * Subjects in phi-contact-info.spec.ts, now extended to Leads.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scaffoldActiveStudy } from './helpers/apiScaffold';

const AUTH_DIR = join(__dirname, '.auth');
const ADMIN_STATE = join(AUTH_DIR, 'admin.json');
const NOPHI_STATE = join(AUTH_DIR, 'nophi.json');

const fixtures = JSON.parse(readFileSync(join(AUTH_DIR, 'fixtures.json'), 'utf-8')) as {
  siteName: string;
};

const runId = Date.now();
const STUDY_NAME = `E2E Recruitment Study ${runId}`;
const ELIGIBILITY_QUESTION = `Is the patient 18 or older? (${runId})`;
const SUBJECT_NUMBER = `E2E-REC-${runId}`;
// Run-scoped so a repeat run of this spec never collides with a lead left
// over from a previous run — with duplicate detection now live, a fixed
// literal name/phone across runs would trip the duplicate-warning gate on
// every run's very first save.
const LEAD_LAST_NAME = `Rivera${runId}`;
const LEAD_FULL_NAME = `Jordan ${LEAD_LAST_NAME}`;
const LEAD_PHONE = `555-${String(runId).slice(-7, -4)}-${String(runId).slice(-4)}`;

let studyId = '';
let leadId = '';

test.describe.serial('Recruitment & Patient Management', () => {
  test.describe('Admin: configure study, run the full lead lifecycle', () => {
    test.use({ storageState: ADMIN_STATE });

    // Prerequisite scaffolding (Study/Site/Visit-Template/activation), not
    // the feature under test — study-creation.spec.ts already covers this
    // flow through the real UI; here it's driven through the same real API
    // that flow ends up calling.
    test('scaffolds an active study with a Baseline visit template', async ({ page }) => {
      const sitesRes = await page.request.get('/api/sites');
      const sites = ((await sitesRes.json()) as { data: Array<{ id: string; name: string }> }).data;
      const site = sites.find((s) => s.name === fixtures.siteName);
      expect(site).toBeTruthy();

      const { studyId: id } = await scaffoldActiveStudy(page.request, {
        studyName: STUDY_NAME,
        siteId: site!.id,
        items: [
          {
            visit_name: 'Baseline',
            visit_order: 0,
            offset_days: 0,
            window_before: 0,
            window_after: 0,
            visit_type: 'scheduled',
            is_baseline: true,
            is_required: true,
          },
        ],
      });
      studyId = id;
      expect(studyId).toMatch(/^[0-9a-f-]{36}$/);
    });

    test('configures a prescreening question for the study via the UI', async ({ page }) => {
      await page.goto(`/studies/${studyId}`);
      await page.getByRole('button', { name: 'Prescreening' }).click();
      await page.getByRole('link', { name: 'Manage Prescreening Questions' }).click();

      await expect(page).toHaveURL(new RegExp(`/studies/${studyId}/prescreening-questions$`));
      await page.getByLabel('Question text').fill(ELIGIBILITY_QUESTION);
      // Answer type defaults to Yes / No; eligible answer defaults to Yes.
      await page.getByLabel('Hard exclusion', { exact: false }).check();
      await page.getByRole('button', { name: 'Add Question' }).click();

      await expect(page.getByText(ELIGIBILITY_QUESTION)).toBeVisible({ timeout: 10000 });
      await expect(page.getByText('Hard exclusion', { exact: true })).toBeVisible();
    });

    test('creates a lead in the pool, matched to the study and site', async ({ page }) => {
      await page.goto('/recruitment/new');
      await page.getByLabel('Study (optional)').selectOption({ label: STUDY_NAME });

      const siteSelect = page.getByLabel('Site (optional)');
      if (await siteSelect.count()) {
        await siteSelect.selectOption({ label: fixtures.siteName });
      }

      await page.getByRole('button', { name: 'Create Lead' }).click();
      await expect(page).toHaveURL(/\/recruitment\/[0-9a-f-]{36}$/, { timeout: 10000 });
      leadId = page.url().split('/recruitment/')[1] ?? '';
      expect(leadId).toMatch(/^[0-9a-f-]{36}$/);
    });

    test('adds contact information — Administrator has lead PHI by default', async ({ page }) => {
      await page.goto(`/recruitment/${leadId}`);
      await expect(page.getByRole('heading', { name: 'Add Contact Information' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Restricted' })).not.toBeVisible();

      await page.getByLabel('First Name').fill('Jordan');
      await page.getByLabel('Last Name').fill(LEAD_LAST_NAME);
      // Both required before conversion — subject_contact_info needs them
      // NOT NULL even though they're optional at the recruitment stage.
      await page.getByLabel('Date of Birth (optional)').fill('1985-06-15');
      await page.getByLabel('Sex (optional)').fill('Female');
      await page.getByLabel('Primary Phone').fill(LEAD_PHONE);
      await page.getByRole('button', { name: 'Save', exact: true }).click();

      // exact: true — "Add Contact Information" (the form heading, still
      // mounted for a moment during the transition) contains this string too.
      await expect(
        page.getByRole('heading', { name: 'Contact Information', exact: true }),
      ).toBeVisible();
      await expect(page.getByText(LEAD_FULL_NAME)).toBeVisible();
    });

    test('assigns the lead to a user', async ({ page }) => {
      await page.goto(`/recruitment/${leadId}`);
      await page.getByRole('button', { name: 'Assign' }).click();
      // The seeded Administrator fixture is always a valid assignment target
      // — no second-user fixture is required for this check.
      await page.getByLabel('Assigned to').selectOption({ index: 1 });
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Reassign' })).toBeVisible({ timeout: 10000 });
    });

    test('adds a note', async ({ page }) => {
      await page.goto(`/recruitment/${leadId}`);
      await page.getByPlaceholder('Add a note…').fill(`E2E note ${runId}`);
      await page.getByRole('button', { name: 'Add Note' }).click();
      await expect(page.getByText(`E2E note ${runId}`)).toBeVisible({ timeout: 10000 });
    });

    test('logs a call', async ({ page }) => {
      await page.goto(`/recruitment/${leadId}`);
      await page.getByRole('button', { name: 'Log Call' }).click();
      await page.getByLabel('Outcome').selectOption('answered');
      // Scoped to exact "Save" inside the modal — "Save Anyway"/other Save
      // buttons on the page would otherwise ambiguously match.
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('outbound · answered')).toBeVisible({ timeout: 10000 });
    });

    test('creates and completes a task', async ({ page }) => {
      await page.goto(`/recruitment/${leadId}`);
      await page.getByRole('button', { name: 'New Task' }).click();
      await page.getByLabel('Title').fill(`E2E follow-up ${runId}`);
      await page.getByRole('button', { name: 'Create' }).click();

      await expect(page.getByText(`E2E follow-up ${runId}`)).toBeVisible({ timeout: 10000 });
      await page.getByRole('button', { name: 'Complete' }).click();
      // Completed tasks render with a strikethrough and lose their Complete
      // button — asserting the button is gone confirms the state actually
      // changed, not just that the click didn't error.
      await expect(page.getByRole('button', { name: 'Complete' })).not.toBeVisible({
        timeout: 10000,
      });
    });

    test('detects a possible duplicate by matching contact info, and does not silently block or merge', async ({
      page,
      request,
    }) => {
      const dupRes = await request.post('/api/leads', { data: {} });
      const dupLeadId = ((await dupRes.json()) as { data: { id: string } }).data.id;

      await page.goto(`/recruitment/${dupLeadId}`);
      // Same name/DOB/phone as the lead created earlier in this file — a
      // real duplicate by every match rule.
      await page.getByLabel('First Name').fill('Jordan');
      await page.getByLabel('Last Name').fill(LEAD_LAST_NAME);
      await page.getByLabel('Date of Birth (optional)').fill('1985-06-15');
      await page.getByLabel('Primary Phone').fill(LEAD_PHONE);
      await page.getByRole('button', { name: 'Save', exact: true }).click();

      await expect(page.getByText(/possible existing lead/)).toBeVisible({ timeout: 10000 });
      await expect(page.getByText('same name and date of birth', { exact: false })).toBeVisible();

      // Not a hard block — the duplicate is never silently merged, the
      // caller explicitly confirms and the record is created as its own row.
      await page.getByRole('button', { name: 'Save Anyway' }).click();
      await expect(
        page.getByRole('heading', { name: 'Contact Information', exact: true }),
      ).toBeVisible({ timeout: 10000 });
    });

    test('submits a prescreening and the outcome is scored automatically', async ({ page }) => {
      await page.goto(`/recruitment/${leadId}`);
      await page.getByRole('button', { name: 'New Prescreening' }).click();
      await page.getByLabel('Study').selectOption({ label: STUDY_NAME });

      await expect(page.getByText(ELIGIBILITY_QUESTION)).toBeVisible();
      await page.getByLabel(ELIGIBILITY_QUESTION).selectOption('yes');
      await page.getByRole('button', { name: 'Submit' }).click();

      await expect(page.getByText('Potentially Eligible')).toBeVisible({ timeout: 10000 });
    });

    test('converts the lead into a real, enrolled Subject', async ({ page }) => {
      await page.goto(`/recruitment/${leadId}`);
      await page.getByRole('button', { name: 'Convert to Subject' }).click();
      await page.getByLabel('Subject number').fill(SUBJECT_NUMBER);
      // Scoped to exact "Convert" — the trigger button ("Convert to Subject")
      // stays mounted behind the modal, so an unscoped/substring match would
      // hit both.
      await page.getByRole('button', { name: 'Convert', exact: true }).click();

      await expect(page.getByText('Converted to Subject.')).toBeVisible({ timeout: 10000 });
      const subjectLink = page.getByRole('link', { name: 'View Subject profile' });
      await expect(subjectLink).toBeVisible();

      // Following through confirms the copied contact info really landed in
      // subject_contact_info, not just that the lead row flipped to converted.
      await subjectLink.click();
      await expect(page).toHaveURL(/\/subjects\/[0-9a-f-]{36}$/);
      await page.getByRole('button', { name: 'Contact Info' }).click();
      await expect(page.getByText(LEAD_FULL_NAME)).toBeVisible({ timeout: 10000 });
    });
  });

  // Uses its own throwaway lead rather than the primary leadId above — status
  // transitions and archiving must never risk interfering with the primary
  // lead's prescreening/conversion flow still running in the describe block
  // above (archiving in particular hides the Convert to Subject action).
  test.describe('Admin: status transitions and archiving', () => {
    test.use({ storageState: ADMIN_STATE });
    let statusLeadId = '';

    test('changes status through a valid transition without a reason', async ({ request }) => {
      const res = await request.post('/api/leads', { data: {} });
      statusLeadId = ((await res.json()) as { data: { id: string } }).data.id;

      const statusRes = await request.post(`/api/leads/${statusLeadId}/status`, {
        data: { new_status: 'contact_attempted' },
      });
      expect(statusRes.ok()).toBe(true);
      const body = (await statusRes.json()) as { data: { status: string } };
      expect(body.data.status).toBe('contact_attempted');
    });

    test('rejects an invalid (non-normal) transition without a reason', async ({ request }) => {
      // contact_attempted -> screened is not a normal transition and no
      // reason is supplied — must be rejected, not silently applied.
      const res = await request.post(`/api/leads/${statusLeadId}/status`, {
        data: { new_status: 'screened' },
      });
      expect(res.status()).toBe(422);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toMatch(/not a normal transition/);
    });

    test('allows the same exceptional transition once a reason is supplied', async ({
      request,
    }) => {
      const res = await request.post(`/api/leads/${statusLeadId}/status`, {
        data: { new_status: 'screened', reason: 'sponsor fast-tracked this participant' },
      });
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as { data: { status: string } };
      expect(body.data.status).toBe('screened');
    });

    test('archives the lead and excludes it from the default active list', async ({
      page,
      request,
    }) => {
      const archiveRes = await request.fetch(`/api/leads/${statusLeadId}`, {
        method: 'DELETE',
        data: {},
      });
      expect(archiveRes.ok()).toBe(true);

      // Sprint 7.2: LeadService.list() (and therefore GET /api/leads) returns
      // a paginated { data: LeadListItem[], total, page, page_size } object,
      // not a bare array — the response is now nested one level deeper.
      const listRes = await request.get('/api/leads');
      const activeLeads = ((await listRes.json()) as { data: { data: Array<{ id: string }> } }).data
        .data;
      expect(activeLeads.some((l) => l.id === statusLeadId)).toBe(false);

      const includeArchivedRes = await request.get('/api/leads?include_archived=true');
      const allLeads = (
        (await includeArchivedRes.json()) as { data: { data: Array<{ id: string }> } }
      ).data.data;
      expect(allLeads.some((l) => l.id === statusLeadId)).toBe(true);

      await page.goto(`/recruitment/${statusLeadId}`);
      await expect(page.getByText('This lead is archived.')).toBeVisible();
    });
  });

  test.describe('No-PHI user: can navigate the pipeline but never sees contact details', () => {
    test.use({ storageState: NOPHI_STATE });

    test('sees the lead in the pipeline list without any contact info', async ({ page }) => {
      await page.goto('/recruitment');
      await expect(page.getByRole('heading', { name: 'Recruitment' })).toBeVisible();
      // The pipeline list itself never renders raw contact fields — only
      // initials, study/site, status, and attempt count — so no PHI value
      // should ever appear here, only the auto-generated initials.
      await expect(page.getByText(LEAD_FULL_NAME)).not.toBeVisible();
    });

    test('Contact Info is restricted on the lead detail page', async ({ page }) => {
      await page.goto(`/recruitment/${leadId}`);
      await expect(page.getByRole('heading', { name: 'Restricted' })).toBeVisible();
      await expect(page.getByText(LEAD_FULL_NAME)).not.toBeVisible();
      await expect(page.getByText(LEAD_PHONE)).not.toBeVisible();
    });
  });
});
