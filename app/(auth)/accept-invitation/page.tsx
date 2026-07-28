'use client';

import { Suspense, useState, useEffect, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { AlertBanner } from '@/components/ui/AlertBanner';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

type ValidateResponse =
  { success: true; data: { valid: true; email: string } } | { success: false; message: string };

function AcceptInvitationForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [validating, setValidating] = useState(true);
  const [validEmail, setValidEmail] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);

  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token) {
      setTokenError('No invitation token provided.');
      setValidating(false);
      return;
    }

    fetch(`/api/invitations/validate?token=${encodeURIComponent(token)}`)
      .then(async (res) => {
        const json = (await res.json()) as ValidateResponse;
        if (!res.ok || !json.success) {
          setTokenError(
            (json as { success: false; message: string }).message ??
              'Invalid or expired invitation.',
          );
        } else if (json.data.valid) {
          setValidEmail(json.data.email);
        } else {
          // json.success is true but data.valid is false — a structurally
          // valid response for an unknown/expired token, not a request error.
          setTokenError('Invalid or expired invitation.');
        }
      })
      .catch(() => {
        setTokenError('Failed to validate invitation. Please try again.');
      })
      .finally(() => {
        setValidating(false);
      });
  }, [token]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    setLoading(true);

    try {
      const res = await fetch('/api/invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, full_name: fullName, password }),
      });

      const json = (await res.json()) as { success: boolean; message?: string };

      if (!res.ok || !json.success) {
        setError(json.message ?? 'Failed to accept invitation. Please try again.');
        return;
      }

      router.push('/dashboard');
    } catch {
      setError('An unexpected error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  if (validating) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (tokenError) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        <AlertBanner variant="error" message={tokenError} />
        <p className="mt-4 text-center text-sm text-gray-500">
          Please contact your administrator for a new invitation.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
      <h2 className="mb-2 text-xl font-semibold text-gray-900">Accept your invitation</h2>
      <p className="mb-6 text-sm text-gray-500">
        You&apos;ve been invited to Zentariq One as <strong>{validEmail}</strong>. Create your
        account to get started.
      </p>

      {error && (
        <div className="mb-4">
          <AlertBanner variant="error" message={error} onDismiss={() => setError(null)} />
        </div>
      )}

      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        <Input label="Email address" type="email" value={validEmail ?? ''} disabled />

        <Input
          label="Full name"
          type="text"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          required
          autoComplete="name"
          placeholder="Jane Smith"
        />

        <Input
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="new-password"
          placeholder="At least 8 characters"
          hint="Minimum 8 characters"
        />

        <Input
          label="Confirm password"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          autoComplete="new-password"
          placeholder="Repeat your password"
        />

        <Button type="submit" className="w-full" loading={loading} disabled={loading}>
          Create account
        </Button>
      </form>
    </div>
  );
}

export default function AcceptInvitationPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
          <LoadingSpinner size="lg" />
        </div>
      }
    >
      <AcceptInvitationForm />
    </Suspense>
  );
}
