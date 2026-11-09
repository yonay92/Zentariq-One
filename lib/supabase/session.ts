import { cookies } from 'next/headers';

// @supabase/ssr stores the session as `sb-<project-ref>-auth-token`, split into
// `.0`, `.1`, … chunks when large, plus a `-code-verifier` cookie for PKCE.
const SUPABASE_AUTH_COOKIE = /^sb-[a-z0-9]+-auth-token(?:[.-].*)?$/;

/**
 * Expires every Supabase auth cookie on the current response.
 *
 * `supabase.auth.signOut()` only removes the session cookies when the Auth
 * server call succeeds; when it fails (network error, Auth outage) the cookies
 * would survive and the browser would stay signed in. Route handlers call this
 * afterwards so a sign-out always ends the local session. Cookie values are
 * never read or logged — only names are matched. Returns the number of cookies
 * expired.
 */
export async function clearSupabaseAuthCookies(): Promise<number> {
  const cookieStore = await cookies();
  let cleared = 0;
  for (const { name } of cookieStore.getAll()) {
    if (!SUPABASE_AUTH_COOKIE.test(name)) continue;
    try {
      cookieStore.delete(name);
      cleared++;
    } catch {
      // Server Component context — cookies are read-only there; route
      // handlers (the only callers) can always write them.
    }
  }
  return cleared;
}
