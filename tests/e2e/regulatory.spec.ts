/**
 * E2E tests: Regulatory Compliance & eReg Binder (Sprint 6).
 * Runs against the Next.js production server (baseURL from playwright.config.ts)
 * with a real Supabase backend — see tests/e2e/global-setup.ts /
 * tests/e2e/README.md for the shared fixture design (admin/phi/nophi
 * personas, seeded company/site).
 *
 * Covers the golden path end to end through the real UI: configure a
 * document type + requirement for a study, upload a document, approve it,
 * verify the health score updates, exercise the duplicate-checksum
 * confirmation flow on replace, and archive. Also verifies a no-regulatory
 * user cannot see the binder's action buttons or the requirement builder.
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
const STUDY_NAME = `E2E Regulatory Study ${runId}`;
const DOCUMENT_TYPE_NAME = `1572 Form (${runId})`;
const DOCUMENT_NAME = `Site 1572 — ${runId}`;
const FILE_CONTENT = `%PDF-1.4 e2e regulatory fixture ${runId}`;

let studyId = '';

test.describe.serial('Regulatory Compliance & eReg Binder', () => {
  test.describe('Admin: configure requirement, upload, review, replace, archive', () => {
    test.use({ storageState: ADMIN_STATE });

    test('scaffolds an active study', async ({ page }) => {
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

    test('creates a document type and marks it required for this study', async ({ page }) => {
      await page.goto(`/studies/${studyId}/regulatory`);
      await expect(page.getByRole('heading', { name: 'Regulatory Binder' })).toBeVisible();

      await page.getByRole('button', { name: 'Manage Requirements' }).click();
      await expect(page.getByRole('heading', { name: 'Document Requirements' })).toBeVisible();

      await page.getByLabel('Name').fill(DOCUMENT_TYPE_NAME);
      await page.getByLabel('Category (free text)').fill('Essential Documents');
      await page.getByLabel('Has an expiration date').check();
      await page.getByRole('button', { name: 'Add Document Type' }).click();

      // exact: true — the row's checkbox cells also carry sr-only labels
      // ("Required for {name}", "Requires expiration tracking for {name}")
      // whose accessible name contains DOCUMENT_TYPE_NAME as a substring too.
      await expect(page.getByRole('cell', { name: DOCUMENT_TYPE_NAME, exact: true })).toBeVisible({
        timeout: 10000,
      });
      // Plain click + a separately-awaited assertion, not .check() — the
      // checkbox is disabled while its POST is in flight (prevents
      // double-submit), and .check()'s own fast internal retry loop can give
      // up with "did not change its state" if that round trip to the remote
      // Supabase project is slower than its retry budget, even though the
      // state does correctly resolve moments later.
      const requiredCheckbox = page.getByLabel(`Required for ${DOCUMENT_TYPE_NAME}`);
      await requiredCheckbox.click();
      await expect(requiredCheckbox).toBeChecked({ timeout: 15000 });

      await page.getByRole('button', { name: 'Close' }).click();

      // The requirement now has no matching document — it shows up in
      // Missing Documents, computed client-side by diffing requirements
      // against uploaded documents. The company's 4 required_by_default
      // types (Protocol, ICF, etc., auto-attached by activateStudy's
      // GAP-BL-05 step) are also missing for this fresh study, so this
      // asserts our type is present among them rather than an exact count.
      await expect(page.getByText(/Missing Documents \(\d+\)/)).toBeVisible({ timeout: 10000 });
      await expect(page.getByText(DOCUMENT_TYPE_NAME)).toBeVisible();
    });

    test('uploads the required document — it starts pending review', async ({ page }) => {
      await page.goto(`/studies/${studyId}/regulatory`);
      await page.getByRole('button', { name: 'Upload Document' }).click();
      await expect(page.getByRole('heading', { name: 'Upload Document' })).toBeVisible();

      await page.getByLabel('Document Type').selectOption({ label: DOCUMENT_TYPE_NAME });
      await page.getByLabel('Document Name').fill(DOCUMENT_NAME);

      const futureExpiration = new Date();
      futureExpiration.setFullYear(futureExpiration.getFullYear() + 1);
      await page.getByLabel(/Expiration Date/).fill(futureExpiration.toISOString().slice(0, 10));

      await page.setInputFiles('#regulatory-doc-file', {
        name: 'form-1572.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from(FILE_CONTENT),
      });
      await page.getByRole('button', { name: 'Upload', exact: true }).click();

      await expect(page.getByText(DOCUMENT_NAME)).toBeVisible({ timeout: 10000 });
      // Scoped to the document's own table row — HealthScoreBreakdown always
      // renders a "Pending Review" breakdown label elsewhere on the page once
      // any requirement exists, and unscoped text matching is case-insensitive
      // by default, so an unscoped match is ambiguous.
      const documentRow = page.getByRole('row', { name: DOCUMENT_NAME });
      await expect(documentRow.getByText('pending review', { exact: true })).toBeVisible();
      // Our type has a version on file now, so it drops out of the Missing
      // Documents list — but the company's other required_by_default types
      // (Protocol, ICF, etc.) are still missing for this fresh study, so the
      // section itself stays visible; only our specific type's absence from
      // it is asserted.
      const missingSection = page.getByText(/Missing Documents \(\d+\)/).locator('..');
      await expect(missingSection.getByText(DOCUMENT_TYPE_NAME)).not.toBeVisible();
    });

    test('approving moves the document to current and updates the health score', async ({
      page,
    }) => {
      await page.goto(`/studies/${studyId}/regulatory`);
      await page.getByRole('button', { name: 'Review' }).click();
      await expect(page.getByRole('heading', { name: `Review — ${DOCUMENT_NAME}` })).toBeVisible();
      await page.getByRole('button', { name: 'Approve' }).click();

      // Scoped to the row, same reasoning as the pending_review assertion
      // above — HealthScoreBreakdown also renders a "Current" label.
      const documentRow = page.getByRole('row', { name: DOCUMENT_NAME });
      await expect(documentRow.getByText('current', { exact: true })).toBeVisible({
        timeout: 10000,
      });
      // The health score is never a bare number — the numerator/denominator
      // sentence must always accompany it. Denominator isn't asserted as an
      // exact value: the e2e company's 4 required_by_default document types
      // (Protocol, ICF, etc.) are also counted for this study, so the exact
      // fraction depends on shared fixture state, not just this test's type.
      await expect(
        page.getByText(/\d+ of \d+ required documents current or expiring soon/),
      ).toBeVisible();
      await expect(page.getByText(/^\d+%$/)).toBeVisible();
    });

    test('replacing with identical content is flagged as a possible duplicate and requires confirmation', async ({
      page,
    }) => {
      await page.goto(`/studies/${studyId}/regulatory`);
      await page.getByRole('button', { name: 'Replace' }).click();
      await expect(page.getByRole('heading', { name: 'Replace Document Version' })).toBeVisible();

      await page.setInputFiles('#regulatory-doc-file', {
        name: 'form-1572.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from(FILE_CONTENT), // identical bytes to the first upload
      });
      await page.getByLabel('Reason for replacement').fill('Routine annual renewal');
      // The row's "Replace" trigger button stays mounted behind the modal
      // overlay, so an unscoped match would hit both it and the modal's own
      // "Replace" submit button — scope to the dialog.
      await page.getByRole('dialog').getByRole('button', { name: 'Replace', exact: true }).click();

      await expect(page.getByText(/identical content was already uploaded/)).toBeVisible({
        timeout: 10000,
      });
      await page.getByRole('button', { name: 'Upload Anyway' }).click();

      // Replacement re-enters pending_review — approval is required again,
      // even though the caller explicitly confirmed the duplicate content.
      // Row-scoped for the same reason as the earlier pending_review check.
      const documentRow = page.getByRole('row', { name: DOCUMENT_NAME });
      await expect(documentRow.getByText('pending review', { exact: true })).toBeVisible({
        timeout: 10000,
      });
    });

    test('version history shows both the original and the replacement version', async ({
      page,
    }) => {
      await page.goto(`/studies/${studyId}/regulatory`);
      await page.getByRole('button', { name: 'History' }).click();
      const historyDialog = page.getByRole('dialog');
      await expect(
        historyDialog.getByRole('heading', { name: DOCUMENT_NAME, exact: false }),
      ).toBeVisible();
      // Exact, event-specific timeline text — not a bare "v1"/"v2" substring
      // match, which is ambiguous once v1 has both an "uploaded" and an
      // "approved" timeline entry (each containing "v1").
      await expect(historyDialog.getByText('Version v1 uploaded')).toBeVisible();
      await expect(historyDialog.getByText('Version v2 uploaded (replacement)')).toBeVisible();
      await page.getByRole('button', { name: 'Close' }).click();
    });

    test('archiving requires a reason and never deletes prior versions', async ({ page }) => {
      await page.goto(`/studies/${studyId}/regulatory`);
      await page.getByRole('button', { name: 'Archive' }).click();
      await expect(page.getByRole('heading', { name: `Archive — ${DOCUMENT_NAME}` })).toBeVisible();
      const archiveDialog = page.getByRole('dialog');

      // Empty reason is rejected client-side. Scoped to the dialog — the
      // row's "Archive" trigger button stays mounted behind the overlay and
      // shares the exact same accessible name as the modal's submit button.
      await archiveDialog.getByRole('button', { name: 'Archive', exact: true }).click();
      await expect(page.getByText('A reason is required to archive a document.')).toBeVisible();

      await page.getByLabel('Reason').fill('Superseded by an updated protocol version');
      await archiveDialog.getByRole('button', { name: 'Archive', exact: true }).click();

      // Row-scoped for consistency with the other status assertions, even
      // though HealthScoreBreakdown has no "Archived" breakdown label today.
      const documentRow = page.getByRole('row', { name: DOCUMENT_NAME });
      await expect(documentRow.getByText('archived', { exact: true })).toBeVisible({
        timeout: 10000,
      });

      // The version history is still intact after archiving — exact,
      // event-specific text, same reasoning as the earlier history test.
      await page.getByRole('button', { name: 'History' }).click();
      const postArchiveHistoryDialog = page.getByRole('dialog');
      await expect(postArchiveHistoryDialog.getByText('Version v1 uploaded')).toBeVisible();
      await expect(
        postArchiveHistoryDialog.getByText('Version v2 uploaded (replacement)'),
      ).toBeVisible();
    });
  });

  test.describe('View-only user: sees the binder but has no mutation permissions', () => {
    test.use({ storageState: NOPHI_STATE });

    test('sees the binder read-only, with no upload/review/archive/requirement actions', async ({
      page,
    }) => {
      await page.goto(`/studies/${studyId}/regulatory`);
      await expect(page.getByRole('heading', { name: 'Regulatory Binder' })).toBeVisible();

      await expect(page.getByRole('button', { name: 'Upload Document' })).not.toBeVisible();
      await expect(page.getByRole('button', { name: 'Manage Requirements' })).not.toBeVisible();
      await expect(page.getByRole('button', { name: 'Replace' })).not.toBeVisible();
      await expect(page.getByRole('button', { name: 'Archive' })).not.toBeVisible();
    });
  });
});
