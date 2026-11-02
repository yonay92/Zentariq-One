'use client';

import { useAuth } from '@/hooks/useAuth';
import { useSignOut } from '@/hooks/useSignOut';
import { NotificationBell } from './NotificationBell';
import { useState } from 'react';

export function TopBar() {
  const auth = useAuth();
  const { signOut, signingOut, error: signOutError } = useSignOut();
  const [menuOpen, setMenuOpen] = useState(false);

  const profile = auth.status === 'authenticated' ? auth.profile : null;
  const company = auth.status === 'authenticated' ? auth.company : null;

  const initials = profile?.full_name
    ? profile.full_name
        .split(' ')
        .map((n) => n.at(0) ?? '')
        .filter(Boolean)
        .slice(0, 2)
        .join('')
        .toUpperCase()
    : '?';

  return (
    <header className="flex h-16 flex-shrink-0 items-center justify-between border-b border-gray-200 bg-white px-6">
      <div className="flex items-center gap-3">
        <span className="text-sm font-semibold text-gray-900">{company?.name ?? ''}</span>
      </div>

      <div className="flex items-center gap-3">
        {signOutError && (
          <p role="alert" className="text-xs text-red-600">
            {signOutError}
          </p>
        )}

        <NotificationBell />

        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-gray-100 focus:ring-2 focus:ring-blue-500 focus:outline-none"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white">
              {initials}
            </div>
            <span className="hidden text-sm text-gray-700 sm:block">
              {profile?.full_name ?? ''}
            </span>
            <svg
              className="h-4 w-4 text-gray-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 z-20 mt-2 w-48 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                <div className="border-b border-gray-100 px-4 py-2">
                  <p className="truncate text-xs font-medium text-gray-900">{profile?.full_name}</p>
                  <p className="truncate text-xs text-gray-500">{profile?.email}</p>
                </div>
                <button
                  type="button"
                  disabled={signingOut}
                  onClick={() => {
                    setMenuOpen(false);
                    void signOut();
                  }}
                  className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  {signingOut ? 'Signing out…' : 'Sign out'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
