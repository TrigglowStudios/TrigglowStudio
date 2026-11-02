/** Mirrors `DesktopNotification` in @trigglow/shared (the desktop app doesn't depend on that package). */
export interface DesktopNotification {
  kind: string;
  title: string;
  body: string;
  url?: string;
}

const APP_PATH = /^\/app(\/|\?|$)/;

/** Re-validates what the server sends: text only, bounded, and a click target that stays inside /app. */
export function parseNotification(raw: unknown): DesktopNotification | null {
  if (!raw || typeof raw !== 'object') return null;
  const n = raw as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : null);
  const title = text(n.title, 120);
  const body = text(n.body, 400);
  const kind = text(n.kind, 40);
  if (!title || body === null || !kind) return null;
  return { kind, title, body, url: typeof n.url === 'string' && n.url.length <= 200 && APP_PATH.test(n.url) ? n.url : undefined };
}

/**
 * Anti-flood: a raid or a burst of subs must not bury the desktop in toasts. The first `max` notifications inside the
 * window are shown; the rest are counted and summarised once with `flush()`.
 */
export class Burst {
  private stamps: number[] = [];
  private held = 0;

  constructor(
    private max = 4,
    private windowMs = 10_000,
  ) {}

  /** true → show it now; false → held for the summary. */
  take(now: number): boolean {
    this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
    if (this.stamps.length < this.max) {
      this.stamps.push(now);
      return true;
    }
    this.held += 1;
    return false;
  }

  flush(): number {
    const n = this.held;
    this.held = 0;
    return n;
  }
}
