'use client';

import { useCallback, useState } from 'react';
import { hardNavigate } from '@/lib/utils/navigation';

export const SIGN_OUT_ERROR = 'Sign out failed. Please try again.';

/**
 * Signs the user out through `/api/auth/signout` (which always ends the
 * Supabase session server-side, with or without a loadable profile) and then
 * performs a full navigation to `/login`. A full navigation — rather than a
 * client-side route change — discards every piece of in-memory client state
 * (including any clinical data already rendered), and guarantees the request
 * for `/login` carries the cleared cookies, so the middleware cannot bounce the
 * user back to `/dashboard`. On failure the user stays put and sees `error`.
 */
export function useSignOut(): {
  signOut: () => Promise<void>;
  signingOut: boolean;
  error: string | null;
} {
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signOut = useCallback(async () => {
    setSigningOut(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/signout', { method: 'POST' });
      if (!res.ok) {
        setError(SIGN_OUT_ERROR);
        setSigningOut(false);
        return;
      }
      hardNavigate('/login');
    } catch {
      setError(SIGN_OUT_ERROR);
      setSigningOut(false);
    }
  }, []);

  return { signOut, signingOut, error };
}
