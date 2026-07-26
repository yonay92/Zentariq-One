import type { ReactNode } from 'react';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-gray-900">Zentariq One</h1>
          <p className="mt-1 text-sm text-gray-500">Clinical Research Operations Platform</p>
        </div>
        {children}
      </div>
    </div>
  );
}
