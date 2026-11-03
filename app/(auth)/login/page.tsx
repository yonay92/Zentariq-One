'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { AlertBanner } from '@/components/ui/AlertBanner';

type SignInErrorBody = { success?: boolean; error?: { code?: string; message?: string } };

const UNAVAILABLE = 'Sign-in is temporarily unavailable. Please try again in a few minutes.';

/**
 * Maps a failed /api/auth/signin response to the message shown to the user.
 * 401, 429 and 503 messages are fixed end-user strings written by the server
 * (wrong credentials, deactivated account, rate limit, account could not be
 * loaded). Any other status — including a 500 or a non-JSON platform error —
 * gets a generic retry message so internal details never surface.
 */
function signInErrorMessage(status: number, body: SignInErrorBody | null): string {
  const serverMessage = body?.error?.message;
  if (status === 401) return serverMessage ?? 'Invalid email or password';
  if (status === 429)
    return serverMessage ?? 'Too many sign-in attempts. Please wait and try again.';
  if (status === 503) return serverMessage ?? UNAVAILABLE;
  if (status === 400) return 'Enter a valid email address and password.';
  return UNAVAILABLE;
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch('/api/auth/signin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      // Error bodies are `{ success: false, error: { code, message } }`; a
      // proxy/platform failure may not be JSON at all.
      const json = (await res.json().catch(() => null)) as SignInErrorBody | null;

      if (!res.ok || json?.success !== true) {
        setError(res.ok ? UNAVAILABLE : signInErrorMessage(res.status, json));
        return;
      }

      router.push('/dashboard');
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
      <h2 className="mb-6 text-xl font-semibold text-gray-900">Sign in to your account</h2>

      {error && (
        <div className="mb-4">
          <AlertBanner variant="error" message={error} onDismiss={() => setError(null)} />
        </div>
      )}

      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        <Input
          label="Email address"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
          placeholder="you@example.com"
        />

        <Input
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
          placeholder="••••••••"
        />

        <div className="flex items-center justify-end">
          <Link href="/forgot-password" className="text-sm text-blue-600 hover:underline">
            Forgot password?
          </Link>
        </div>

        <Button type="submit" className="w-full" loading={loading} disabled={loading}>
          Sign in
        </Button>
      </form>
    </div>
  );
}
