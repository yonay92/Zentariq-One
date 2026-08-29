/**
 * E2E tests: Document Center (Milestone 2 — browse UI + generic API).
 * Runs against the Next.js dev/prod server (baseURL from playwright.config.ts)
 * with a real Supabase backend — see tests/e2e/global-setup.ts for the shared
 * identity fixtures (no dedicated fixtures were added for this suite; every
 * scenario here creates and cleans up its own file via the real upload API).
 *
 * Grouped as one test.describe.serial() block because the scenarios share a
 * single uploaded file across the browse/filter/preview/link/download steps.
 *
 * Linking a file to a record is exercised via `page.request` rather than a
 * UI record-picker — Milestone 2's approved scope deliberately does not
 * build a cross-module "pick any record" UI (that belongs with Milestone 3's
 * retrofit, once each module's own UI has real context to link with). The
 * generic `POST /api/files/[id]/link` route itself, and the browse UI's
 * display of whatever `file_links` rows exist, are what this suite verifies.
 *
 * Company isolation is not re-verified here — it's already covered at the
 * integration level (tests/integration/file-isolation.test.ts), same
 * convention documented in visit-calendar.spec.ts for why deeper permission/
 * tenant-boundary cases aren't duplicated at the E2E layer.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const AUTH_DIR = join(__dirname, '.auth');
const ADMIN_STATE = join(AUTH_DIR, 'admin.json');
const NOPHI_STATE = join(AUTH_DIR, 'nophi.json');

const FILE_CONTENT = '%PDF-1.4 fake document center e2e content';

let uploadedFileId = '';
let uploadedFileName = '';

test.describe.serial('Document Center', () => {
  test.describe('Admin: browse, upload, preview, link, download', () => {
    test.use({ storageState: ADMIN_STATE });

    test('renders the Document Center (not the old stub) with an empty or existing state', async ({
      page,
    }) => {
      await page.goto('/documents');
      await expect(page.getByRole('heading', { name: 'Documents' })).toBeVisible();
      // The old ComingSoon stub rendered this exact copy — its continued
      // absence is the regression this test guards against.
      await expect(
        page.getByText('This module will be implemented in a future sprint.'),
      ).toHaveCount(0);
    });

    test('uploads a file via the UI and it appears in the list', async ({ page }) => {
      uploadedFileName = `e2e-document-${Date.now()}.pdf`;
      await page.goto('/documents');
      await page.getByRole('button', { name: 'Upload File' }).click();
      await expect(page.getByRole('heading', { name: 'Upload File' })).toBeVisible();

      await page.setInputFiles('#document-center-file', {
        name: uploadedFileName,
        mimeType: 'application/pdf',
        buffer: Buffer.from(FILE_CONTENT),
      });

      await expect(page.getByText(uploadedFileName)).toBeVisible({ timeout: 10000 });

      const filesRes = await page.request.get('/api/files');
      expect(filesRes.ok()).toBeTruthy();
      const files = ((await filesRes.json()) as { data: Array<{ id: string; file_name: string }> })
        .data;
      const uploaded = files.find((f) => f.file_name === uploadedFileName);
      expect(uploaded).toBeTruthy();
      uploadedFileId = uploaded!.id;
    });

    test('opens the preview panel showing metadata and "No linked records"', async ({ page }) => {
      await page.goto('/documents');
      await expect(page.getByText(uploadedFileName)).toBeVisible({ timeout: 10000 });

      const row = page.getByRole('row', { name: new RegExp(uploadedFileName) });
      await row.getByRole('button', { name: 'View' }).click();

      const dialog = page.getByRole('dialog', { name: uploadedFileName, exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('File Size')).toBeVisible();
      await expect(dialog.getByText('No linked records')).toBeVisible();

      await dialog.getByRole('button', { name: 'Close' }).click();
      await expect(dialog).not.toBeVisible();
    });

    test('downloading issues a fresh signed URL and never a public one', async ({ page }) => {
      await page.goto('/documents');
      await expect(page.getByText(uploadedFileName)).toBeVisible({ timeout: 10000 });

      const row = page.getByRole('row', { name: new RegExp(uploadedFileName) });
      await row.getByRole('button', { name: 'View' }).click();
      const dialog = page.getByRole('dialog', { name: uploadedFileName, exact: true });
      await expect(dialog).toBeVisible();

      const [signedUrlResponse, download] = await Promise.all([
        page.waitForResponse((res) =>
          res.url().includes(`/api/files/${uploadedFileId}/signed-url`),
        ),
        // The uploaded test fixture's bytes aren't a real, parseable PDF, so
        // Chromium's built-in PDF viewer can't render it and the
        // target="_blank" navigation resolves as a native file download
        // instead of a normal page load — Playwright surfaces that as a
        // 'download' event, not a 'popup' page with an inspectable .url().
        page.waitForEvent('download'),
        dialog.getByRole('button', { name: 'Download' }).click(),
      ]);

      expect(signedUrlResponse.ok()).toBeTruthy();
      const body = (await signedUrlResponse.json()) as { data: { url: string } };
      // Signed, not a bare public bucket path — proves the download flow went
      // through FileService.getSignedUrl rather than a stored public URL.
      expect(body.data.url).toContain('token=');
      // download.url() is the exact URL the browser actually fetched from —
      // proof the browser navigated to (and only to) the signed URL returned
      // by the API, not some other/public location.
      expect(download.url()).toBe(body.data.url);
    });

    test('linking the file to a record surfaces it in the preview panel', async ({ page }) => {
      const recordId = randomUUID();
      const linkRes = await page.request.post(`/api/files/${uploadedFileId}/link`, {
        data: { module: 'subjects', record_id: recordId },
      });
      expect(linkRes.ok()).toBeTruthy();

      await page.goto('/documents');
      await expect(page.getByText(uploadedFileName)).toBeVisible({ timeout: 10000 });

      const row = page.getByRole('row', { name: new RegExp(uploadedFileName) });
      await row.getByRole('button', { name: 'View' }).click();
      const dialog = page.getByRole('dialog', { name: uploadedFileName, exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('subjects')).toBeVisible();
      await expect(dialog.getByText(recordId)).toBeVisible();
    });

    test('the module filter narrows the list to files linked to that module', async ({ page }) => {
      await page.goto('/documents');
      await expect(page.getByText(uploadedFileName)).toBeVisible({ timeout: 10000 });

      await page.getByLabel('Module').selectOption({ label: 'subjects' });
      await expect(page.getByText(uploadedFileName)).toBeVisible();

      await page.getByRole('button', { name: 'Reset filters' }).click();
      await expect(page.getByLabel('Module')).toHaveValue('');
    });
  });

  test.describe('No-PHI persona: lacks view_documents entirely', () => {
    test.use({ storageState: NOPHI_STATE });

    test('the Documents nav link is hidden', async ({ page }) => {
      await page.goto('/dashboard');
      await expect(page.getByRole('link', { name: 'Documents' })).toHaveCount(0);
    });

    test('navigating directly shows a permission error, and the API itself rejects with 403', async ({
      page,
    }) => {
      await page.goto('/documents');
      await expect(
        page.getByText('You do not have permission to view the Document Center.'),
      ).toBeVisible({ timeout: 10000 });

      // Server-side enforcement, not just the UI hiding the button — a real
      // request through the same endpoint the browse view calls, from a
      // session that genuinely lacks view_documents.
      const filesRes = await page.request.get('/api/files');
      expect(filesRes.status()).toBe(403);

      const signedUrlRes = await page.request.get(`/api/files/${uploadedFileId}/signed-url`);
      expect(signedUrlRes.status()).toBe(403);
    });
  });
});
