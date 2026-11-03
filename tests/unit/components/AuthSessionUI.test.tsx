/**
 * Login, Dashboard and TopBar behaviour around authentication failures
 * (G7 remediation): accurate login errors, actionable dashboard states instead
 * of a blank page, and a sign-out that always leaves for /login.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoginPage from '@/app/(auth)/login/page';
import DashboardPage from '@/app/(app)/dashboard/page';
import { TopBar } from '@/components/layout/TopBar';
import { hardNavigate } from '@/lib/utils/navigation';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/utils/navigation', () => ({ hardNavigate: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({
  createBrowserSupabaseClient: () => ({
    auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }) },
  }),
}));
vi.mock('@/components/layout/NotificationBell', () => ({ NotificationBell: () => null }));

const PROFILE = {
  id: 'user-1',
  company_id: 'company-1',
  full_name: 'Ada Lovelace',
  email: 'ada@example.test',
  phone: null,
  status: 'active',
  avatar_file_id: null,
  last_login_at: null,
  created_at: '',
  updated_at: '',
};
const COMPANY = { id: 'company-1', name: 'Example Research Co', status: 'active' };

type Reply = { status: number; body?: unknown; raw?: string; reject?: boolean };

function stubFetch(routes: Record<string, Reply | Reply[]>) {
  const counters: Record<string, number> = {};
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
    const entry = routes[key]!;
    const list = Array.isArray(entry) ? entry : [entry];
    const i = Math.min(counters[key] ?? 0, list.length - 1);
    counters[key] = (counters[key] ?? 0) + 1;
    const r = list[i]!;
    if (r.reject) throw new TypeError('Failed to fetch');
    return new Response(r.raw ?? JSON.stringify(r.body ?? {}), { status: r.status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const callsTo = (fetchMock: ReturnType<typeof vi.fn>, prefix: string) =>
  fetchMock.mock.calls.filter(([u]) => String(u).startsWith(prefix)).length;

const ME_OK: Reply = {
  status: 200,
  body: { success: true, data: { profile: PROFILE, company: COMPANY } },
};
const ME_401: Reply = { status: 401, body: { success: false, error: { code: 'UNAUTHORIZED' } } };
const ME_500: Reply = { status: 500, body: { success: false, error: { code: 'INTERNAL_ERROR' } } };

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function submitLogin() {
  const user = userEvent.setup();
  render(<LoginPage />);
  await user.type(screen.getByLabelText(/email address/i), 'ada@example.test');
  await user.type(screen.getByLabelText(/^password/i), 'correct-horse');
  await user.click(screen.getByRole('button', { name: /sign in/i }));
}

describe('LoginPage error messages', () => {
  it('correct password + profile loaded: navigates to the dashboard', async () => {
    stubFetch({
      '/api/auth/signin': { status: 200, body: { success: true, data: { profile: PROFILE } } },
    });
    await submitLogin();
    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('incorrect password: shows the server message from error.message', async () => {
    stubFetch({
      '/api/auth/signin': {
        status: 401,
        body: {
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Invalid email or password' },
        },
      },
    });
    await submitLogin();
    expect((await screen.findByRole('alert')).textContent).toContain('Invalid email or password');
    expect(push).not.toHaveBeenCalled();
  });

  it('correct password + profile lookup denied: shows the load failure, not "invalid credentials"', async () => {
    stubFetch({
      '/api/auth/signin': {
        status: 503,
        body: {
          success: false,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Your account could not be loaded.' },
        },
      },
    });
    await submitLogin();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Your account could not be loaded.');
    expect(alert.textContent).not.toMatch(/invalid email or password/i);
  });

  it('unexpected 500 from the API: generic message even if the body carries details', async () => {
    stubFetch({
      '/api/auth/signin': {
        status: 500,
        body: {
          success: false,
          error: { code: 'INTERNAL_ERROR', message: 'relation "x" does not exist' },
        },
      },
    });
    await submitLogin();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/temporarily unavailable/i);
    expect(alert.textContent).not.toContain('relation');
  });

  it('unexpected server error with a non-JSON body: generic message, no internals', async () => {
    stubFetch({
      '/api/auth/signin': { status: 502, raw: '<html>Bad gateway: upstream 10.0.0.5</html>' },
    });
    await submitLogin();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/temporarily unavailable/i);
    expect(alert.textContent).not.toContain('10.0.0.5');
  });

  it('rate limited: shows the server rate-limit message', async () => {
    stubFetch({
      '/api/auth/signin': {
        status: 429,
        body: {
          success: false,
          error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts.' },
        },
      },
    });
    await submitLogin();
    expect((await screen.findByRole('alert')).textContent).toContain('Too many sign-in attempts.');
  });

  it('network failure: says the server could not be reached', async () => {
    stubFetch({ '/api/auth/signin': { status: 0, reject: true } });
    await submitLogin();
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not reach the server/i);
  });
});

describe('DashboardPage identity states', () => {
  it('401 from /api/users/me: "session ended" with a working "Sign in again" (signs out first)', async () => {
    const fetchMock = stubFetch({
      '/api/users/me': ME_401,
      '/api/auth/signout': { status: 200, body: { success: true, data: null } },
    });
    const user = userEvent.setup();
    render(<DashboardPage />);

    expect(await screen.findByText('Your session has ended')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Sign in again' }));

    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith('/login'));
    expect(callsTo(fetchMock, '/api/auth/signout')).toBe(1);
    expect(callsTo(fetchMock, '/api/users/me')).toBe(1); // no automatic refetch loop
  });

  it('500 from /api/users/me: retryable error state, "Try again" refetches and recovers', async () => {
    const fetchMock = stubFetch({ '/api/users/me': [ME_500, ME_OK] });
    const user = userEvent.setup();
    render(<DashboardPage />);

    expect(await screen.findByText("We couldn't load your account")).toBeTruthy();
    expect(screen.queryByText('Your session has ended')).toBeNull();
    expect(callsTo(fetchMock, '/api/users/me')).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/Welcome back, Ada/)).toBeTruthy();
    expect(callsTo(fetchMock, '/api/users/me')).toBe(2);
  });

  it('network failure loading the identity is an error state, not "signed out"', async () => {
    stubFetch({ '/api/users/me': { status: 0, reject: true } });
    render(<DashboardPage />);
    expect(await screen.findByText("We couldn't load your account")).toBeTruthy();
  });

  it('profile loaded: greets the administrator and names the company', async () => {
    stubFetch({ '/api/users/me': ME_OK });
    render(<DashboardPage />);
    expect(await screen.findByText('Welcome back, Ada')).toBeTruthy();
    expect(screen.getByText(/Example Research Co/)).toBeTruthy();
  });
});

describe('TopBar identity and sign out', () => {
  it('shows the administrator initials, name and company once the profile loads', async () => {
    stubFetch({ '/api/users/me': ME_OK });
    render(<TopBar />);
    expect(await screen.findByText('AL')).toBeTruthy();
    expect(screen.getByText('Example Research Co')).toBeTruthy();
    expect(screen.getAllByText('Ada Lovelace').length).toBeGreaterThan(0);
    expect(screen.queryByText('?')).toBeNull();
  });

  it('sign out with a valid profile: calls the API, then leaves for /login', async () => {
    const fetchMock = stubFetch({
      '/api/users/me': ME_OK,
      '/api/auth/signout': { status: 200, body: { success: true, data: null } },
    });
    const user = userEvent.setup();
    render(<TopBar />);
    await user.click(await screen.findByRole('button', { name: /Ada Lovelace/ }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith('/login'));
    expect(callsTo(fetchMock, '/api/auth/signout')).toBe(1);
    expect(push).not.toHaveBeenCalledWith('/dashboard');
  });

  it('sign out with a missing profile still works (the G7 stuck-session case)', async () => {
    stubFetch({
      '/api/users/me': ME_401,
      '/api/auth/signout': { status: 200, body: { success: true, data: null } },
    });
    const user = userEvent.setup();
    render(<TopBar />);
    expect(await screen.findByText('?')).toBeTruthy();
    await user.click(screen.getByText('?'));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith('/login'));
  });

  it('sign-out API failure: stays on the page and shows an actionable error', async () => {
    stubFetch({
      '/api/users/me': ME_OK,
      '/api/auth/signout': {
        status: 500,
        body: { success: false, error: { code: 'INTERNAL_ERROR' } },
      },
    });
    const user = userEvent.setup();
    render(<TopBar />);
    await user.click(await screen.findByRole('button', { name: /Ada Lovelace/ }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Sign out failed. Please try again.',
    );
    expect(hardNavigate).not.toHaveBeenCalled();
  });
});
