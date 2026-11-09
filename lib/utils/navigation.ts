/**
 * Full-page navigation that replaces the current history entry. Unlike a
 * client-side router transition it discards all in-memory client state and
 * re-runs the middleware with the current cookies — used after sign-out.
 */
export function hardNavigate(path: string): void {
  window.location.replace(path);
}
