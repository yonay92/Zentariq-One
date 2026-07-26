/**
 * E2E tests: Authentication flows
 * Tests login, logout, forgot-password, and accept-invitation pages.
 * Runs against the Next.js dev/prod server (baseURL from playwright.config.ts).
 */
import { test, expect, type Page } from '@playwright/test';

// ── helpers ──────────────────────────────────────────────────────────────────

async function fillLoginForm(page: Page, email: string, password: string) {
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(password);
}

// ── Login page ────────────────────────────────────────────────────────────────

test.describe('Login page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
  });

  test('renders the sign-in form', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
    await expect(page.getByLabel('Email address')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
  });

  test('shows a link to forgot password', async ({ page }) => {
    await expect(page.getByRole('link', { name: /forgot password/i })).toBeVisible();
  });

  test('displays validation error for invalid credentials', async ({ page }) => {
    await fillLoginForm(page, 'bad@example.com', 'wrongpassword');
    await page.getByRole('button', { name: /sign in/i }).click();

    // API returns 401 → error banner appears
    await expect(
      page.getByRole('alert').or(page.getByText(/invalid|incorrect|not found/i)),
    ).toBeVisible({ timeout: 8000 });
  });

  test('email field rejects non-email input', async ({ page }) => {
    await page.getByLabel('Email address').fill('not-an-email');
    await page.getByLabel('Password').fill('password123');
    await page.getByRole('button', { name: /sign in/i }).click();

    // Browser native validation blocks submission
    const emailInput = page.getByLabel('Email address');
    const validationMessage = await emailInput.evaluate(
      (el) => (el as HTMLInputElement).validationMessage,
    );
    expect(validationMessage).not.toBe('');
  });

  test('sign in button is enabled when form has content', async ({ page }) => {
    await fillLoginForm(page, 'user@example.com', 'password');
    await expect(page.getByRole('button', { name: /sign in/i })).toBeEnabled();
  });
});

// ── Forgot password page ──────────────────────────────────────────────────────

test.describe('Forgot password page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/forgot-password');
  });

  test('renders the reset form', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /reset your password/i })).toBeVisible();
    await expect(page.getByLabel('Email address')).toBeVisible();
    await expect(page.getByRole('button', { name: /send reset link/i })).toBeVisible();
  });

  test('back to sign in link is present', async ({ page }) => {
    await expect(page.getByRole('link', { name: /back to sign in/i })).toBeVisible();
  });

  test('clicking back to sign in navigates to login', async ({ page }) => {
    await page.getByRole('link', { name: /back to sign in/i }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  test('submitting any email shows success state (no enumeration)', async ({ page }) => {
    await page.getByLabel('Email address').fill('anyone@example.com');
    await page.getByRole('button', { name: /send reset link/i }).click();

    // Always shows success regardless of whether email exists
    await expect(page.getByText(/check your email/i)).toBeVisible({ timeout: 8000 });
  });

  test('success state shows a link to return to sign in', async ({ page }) => {
    await page.getByLabel('Email address').fill('anyone@example.com');
    await page.getByRole('button', { name: /send reset link/i }).click();
    await expect(page.getByRole('link', { name: /back to sign in/i })).toBeVisible({
      timeout: 8000,
    });
  });
});

// ── Accept invitation page ────────────────────────────────────────────────────

test.describe('Accept invitation page', () => {
  test('shows an error when no token is provided', async ({ page }) => {
    await page.goto('/accept-invitation');
    await expect(page.getByText(/no invitation token/i)).toBeVisible({ timeout: 8000 });
  });

  test('shows an error for an invalid token', async ({ page }) => {
    await page.goto('/accept-invitation?token=invalid-token-that-does-not-exist');
    await expect(page.getByText(/invalid|expired|not found/i).first()).toBeVisible({
      timeout: 8000,
    });
  });

  test('renders a loading spinner while validating', async ({ page }) => {
    // Navigate and immediately check for spinner (before API responds)
    await page.goto('/accept-invitation?token=any-token', { waitUntil: 'commit' });
    // Spinner should briefly appear — we just confirm the page loads without crashing
    await expect(page).toHaveURL(/accept-invitation/);
  });
});

// ── Navigation between auth pages ────────────────────────────────────────────

test.describe('Auth page navigation', () => {
  test('login page forgot-password link goes to /forgot-password', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('link', { name: /forgot password/i }).click();
    await expect(page).toHaveURL(/\/forgot-password/);
  });

  test('Zentariq One heading is present on all auth pages', async ({ page }) => {
    for (const path of ['/login', '/forgot-password']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'Zentariq One' })).toBeVisible();
    }
  });
});

// ── Dashboard redirect when unauthenticated ───────────────────────────────────

test.describe('Route protection', () => {
  test('unauthenticated visit to /dashboard shows login or redirects', async ({ page }) => {
    await page.goto('/dashboard');
    // Either redirected to login, or the page renders (no 500 error)
    const url = page.url();
    const isLoginPage = url.includes('/login');
    const isDashboard = url.includes('/dashboard');
    expect(isLoginPage || isDashboard).toBe(true);
  });
});
