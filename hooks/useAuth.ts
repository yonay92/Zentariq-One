'use client';

import { useEffect, useState, useCallback } from 'react';
import { createBrowserSupabaseClient } from '@/lib/supabase/client';
import type { Profile } from '@/types/users';
import type { Company } from '@/types/users';

/**
 * `unauthenticated` — the server rejected the session (401): there is no
 * usable identity and the user has to sign in again.
 * `error` — the identity could not be loaded (5xx, network failure, malformed
 * response): a retryable fault that must not be presented as "signed out".
 */
export type AuthState =
  | { status: 'loading' }
  | { status: 'authenticated'; profile: Profile; company: Company }
  | { status: 'unauthenticated' }
  | { status: 'error' };

export function useAuth(): AuthState & { refresh: () => Promise<void> } {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  const fetchMe = useCallback(async () => {
    try {
      const res = await fetch('/api/users/me');
      if (res.status === 401) {
        setState({ status: 'unauthenticated' });
        return;
      }
      if (!res.ok) {
        setState({ status: 'error' });
        return;
      }
      const json = (await res.json()) as { data?: { profile?: Profile; company?: Company } };
      if (!json.data?.profile || !json.data.company) {
        setState({ status: 'error' });
        return;
      }
      setState({ status: 'authenticated', profile: json.data.profile, company: json.data.company });
    } catch {
      setState({ status: 'error' });
    }
  }, []);

  useEffect(() => {
    const supabase = createBrowserSupabaseClient();
    void fetchMe();

    const { data: listener } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        setState({ status: 'unauthenticated' });
      } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        void fetchMe();
      }
    });

    return () => {
      listener.subscription.unsubscribe();
    };
  }, [fetchMe]);

  return { ...state, refresh: fetchMe };
}
