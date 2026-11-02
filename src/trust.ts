const TRUSTED_HOSTS = new Set(['trigglow.com', 'www.trigglow.com', 'api.trigglow.com']);
/** The develop stack: trusted only by builds pointed at it (and unpackaged dev runs), never by a production install. */
const DEV_HOST = 'dev.trigglow.com';
/** The develop API (the develop web is on Vercel, like production). */
const DEV_API_HOST = 'apidev.trigglow.com';

let allowLocal = false;
let allowDev = false;

export function allowDevStack(value: boolean): void {
  allowDev = value;
}

/** Dev (unpackaged) builds may talk to a localhost web/API. Set once at startup. */
export function allowLocalhost(value: boolean): void {
  allowLocal = value;
}

/** Only these origins may receive the session cookie or be loaded inside the app window. */
export function isTrustedUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:') {
      return TRUSTED_HOSTS.has(u.hostname) || (allowDev && (u.hostname === DEV_HOST || u.hostname === DEV_API_HOST));
    }
    return allowLocal && u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/** The web origins the docks are served from (the dock lives under /dock/ of the web app). */
const DOCK_HOSTS = new Set(['www.trigglow.com', 'trigglow.com']);
const DOCK_PATHS: Record<string, 'activity' | 'chat'> = { '/dock/activity': 'activity', '/dock/chat': 'chat' };

/**
 * The only outside URLs the OBS dock installer accepts (OBS_ACTIVITY_FEED.md 14.2): `<web origin>/dock/activity`
 * or `/dock/chat`, either public (no fragment: the dock shows a code) or with a one-use desktop ticket
 * (`#e=tgde_…`). The old secret URLs (`#k=tgdr_…`) are no longer issued and are refused, and so is the old
 * `dock.trigglow.com` host, which never served the dock.
 */
export function isTrigglowDockUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    const host =
      u.protocol === 'https:'
        ? !u.port && (DOCK_HOSTS.has(u.hostname) || (allowDev && u.hostname === DEV_HOST))
        : allowLocal && u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
    if (!host || !DOCK_PATHS[u.pathname] || u.search || u.username || u.password) return false;
    return u.hash === '' || /^#e=tgde_[A-Za-z0-9_-]{43}$/.test(u.hash);
  } catch {
    return false;
  }
}

/** `activity` / `chat` of a dock URL already accepted by isTrigglowDockUrl. */
export function dockKindOf(raw: string): 'activity' | 'chat' | null {
  try {
    return DOCK_PATHS[new URL(raw).pathname] ?? null;
  } catch {
    return null;
  }
}
