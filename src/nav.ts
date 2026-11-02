import { isTrustedUrl } from './trust';

/**
 * What to do with a navigation from the app window:
 * - `allow`    stay in the window (only /app/** on a trusted origin)
 * - `link`     an account-link start (API /auth/<provider>/start) → finish it in the system browser with a
 *              one-use ticket (apps/api/src/lib/desktop-link.ts); provider pages never load in the app
 * - `signin`   the web wants its login page → show the app's own sign-in screen instead
 * - `external` hand it to the system browser
 * - `ignore`   not http(s) — drop it
 */
type NavVerdict = 'allow' | 'link' | 'signin' | 'external' | 'ignore';

const LINK_START = /^\/auth\/(kick|twitch|youtube|discord|spotify)\/start$/;

export function classifyNav(rawUrl: string): NavVerdict {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return 'ignore';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'ignore';
  if (isTrustedUrl(rawUrl)) {
    const p = u.pathname;
    if (p === '/app' || p.startsWith('/app/')) return 'allow';
    if (p === '/' || p === '/login' || p.startsWith('/login/')) return 'signin';
    if (LINK_START.test(p)) return 'link';
  }
  return 'external';
}
