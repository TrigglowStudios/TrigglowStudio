/**
 * Trigglow data written straight into OBS text sources (latest follower/sub/donation, quest & goal progress) — no
 * browser source, no overlay. Pure logic + a small class with injected dependencies (see main.ts for the wiring).
 */

export type BindingId = 'latest_follower' | 'latest_sub' | 'latest_donation' | `widget:${string}`;

export interface TextBinding {
  id: BindingId;
  /** Name of the OBS text input that receives the text. */
  source: string;
  template: string;
}

/** A quest or community goal, as the overlay widgets endpoint reports it. */
export interface Widget {
  widgetId: string;
  kind?: string;
  title: string;
  current: number;
  target: number;
  ratio: number;
  metric: string;
  currency?: string;
}

export interface TextData {
  follower: string | null;
  sub: string | null;
  donation: { name: string; amount: string } | null;
  widgets: Widget[];
}

type TextStatus = 'ok' | 'missing' | 'nodata' | 'offline' | 'error';
export type WriteResult = 'ok' | 'missing' | 'error';

const FIXED: BindingId[] = ['latest_follower', 'latest_sub', 'latest_donation'];

export const isBindingId = (v: unknown): v is BindingId =>
  typeof v === 'string' && (FIXED.includes(v as BindingId) || /^widget:[\w-]{1,80}$/.test(v));

/** OBS input names: printable, trimmed, bounded. */
export function cleanSourceName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s.length > 0 && s.length <= 100 ? s : null;
}

export function cleanTemplate(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null;
}

export function defaultTemplate(id: BindingId): string {
  if (id === 'latest_donation') return '{name} · {amount}';
  if (id.startsWith('widget:')) return '{title}: {current}/{target} ({percent}%)';
  return '{name}';
}

const FIXED_NAMES: Record<string, string> = {
  latest_follower: 'Trigglow Latest Follower',
  latest_sub: 'Trigglow Latest Subscriber',
  latest_donation: 'Trigglow Latest Donation',
};

export function defaultSourceName(id: BindingId, widgetTitle?: string): string {
  if (FIXED_NAMES[id]) return FIXED_NAMES[id]!;
  return cleanSourceName(`Trigglow ${widgetTitle ?? 'Progress'}`.slice(0, 60)) ?? 'Trigglow Progress';
}

/** `{key}` → value; unknown keys become empty so a typo never leaks braces onto the stream. */
export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : ''));
}

export function formatMoney(cents: number, currency = 'eur', locale = 'en'): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** Placeholders for a binding, or null while there is no data yet (nothing is written then). */
export function varsFor(id: BindingId, data: TextData, locale = 'en'): Record<string, string | number> | null {
  if (id === 'latest_follower') return data.follower ? { name: data.follower } : null;
  if (id === 'latest_sub') return data.sub ? { name: data.sub } : null;
  if (id === 'latest_donation') return data.donation ? { name: data.donation.name, amount: data.donation.amount } : null;
  const w = data.widgets.find((x) => x.widgetId === id.slice('widget:'.length));
  if (!w) return null;
  const money = w.metric === 'donations';
  const fmt = (n: number) => (money ? formatMoney(n, w.currency, locale) : String(Math.round(n)));
  const ratio = Math.min(Math.max(w.ratio, 0), 1);
  const filled = Math.round(ratio * 10);
  return {
    title: w.title,
    current: fmt(w.current),
    target: fmt(w.target),
    remaining: fmt(Math.max(w.target - w.current, 0)),
    percent: Math.round(ratio * 100),
    bar: '█'.repeat(filled) + '░'.repeat(10 - filled),
  };
}

interface TextDeps {
  connected(): boolean;
  setText(source: string, text: string): Promise<WriteResult>;
  createSource(scene: string | null, name: string, text: string): Promise<boolean>;
  fetchData(): Promise<TextData>;
  locale: string;
  /** Persist the bindings (config.json). */
  save(bindings: TextBinding[]): void;
  onChange(): void;
}

const MIN_GAP_MS = 3000;

export class TextSources {
  bindings: TextBinding[];
  widgets: Widget[] = [];
  readonly status = new Map<BindingId, TextStatus>();
  readonly values = new Map<BindingId, string>();
  private last = new Map<string, string>(); // OBS source → text we last wrote there
  private running = false;
  private again = false;
  private lastRun = 0;
  private timer: NodeJS.Timeout | null = null;
  private tick: NodeJS.Timeout | null = null;

  constructor(
    initial: TextBinding[],
    private deps: TextDeps,
  ) {
    this.bindings = [...initial];
  }

  /** Periodic refresh (data also arrives as nudges from the server) + a first pass. */
  start(everyMs = 60_000): void {
    this.stop();
    this.tick = setInterval(() => void this.sync(), everyMs);
    void this.sync(true);
  }

  stop(): void {
    if (this.tick) clearInterval(this.tick);
    if (this.timer) clearTimeout(this.timer);
    this.tick = this.timer = null;
  }

  /** Something changed on the server: refetch soon (bursts collapse into one fetch). */
  nudge(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sync();
    }, 1500);
  }

  private commit(next: TextBinding[]) {
    this.bindings = next;
    this.deps.save(next);
  }

  add(id: BindingId, source: string, template: string): void {
    if (this.bindings.some((b) => b.id === id)) return;
    this.commit([...this.bindings, { id, source, template }]);
  }

  update(id: BindingId, patch: { source?: string; template?: string }): void {
    this.commit(this.bindings.map((b) => (b.id === id ? { ...b, ...patch } : b)));
    this.last.clear(); // the source may have changed: rewrite everything
  }

  remove(id: BindingId): void {
    this.commit(this.bindings.filter((b) => b.id !== id));
    this.status.delete(id);
    this.values.delete(id);
  }

  /** Create the OBS text input for a binding (in `scene`, or OBS's current scene), then fill it. */
  async create(id: BindingId, scene: string | null): Promise<boolean> {
    const b = this.bindings.find((x) => x.id === id);
    if (!b) return false;
    let ok = false;
    if (this.deps.connected()) {
      ok = await this.deps.createSource(scene, b.source, this.values.get(id) ?? '');
      this.last.clear();
    }
    await this.sync(true); // fills it (or records that OBS is offline)
    return ok;
  }

  async sync(force = false): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    const wait = MIN_GAP_MS - (Date.now() - this.lastRun);
    if (!force && wait > 0) {
      this.nudge();
      return;
    }
    this.running = true;
    try {
      let data: TextData;
      try {
        data = await this.deps.fetchData();
        this.widgets = data.widgets;
      } catch {
        for (const b of this.bindings) this.status.set(b.id, 'error');
        return;
      }
      for (const b of this.bindings) {
        const vars = varsFor(b.id, data, this.deps.locale);
        if (!vars) {
          this.status.set(b.id, 'nodata');
          continue;
        }
        const text = renderTemplate(b.template, vars);
        this.values.set(b.id, text);
        if (!this.deps.connected()) {
          this.status.set(b.id, 'offline');
          continue;
        }
        if (!force && this.last.get(b.source) === text && this.status.get(b.id) === 'ok') continue;
        const r = await this.deps.setText(b.source, text);
        if (r === 'ok') this.last.set(b.source, text);
        else this.last.delete(b.source);
        this.status.set(b.id, r === 'ok' ? 'ok' : r);
      }
    } finally {
      this.running = false;
      this.lastRun = Date.now();
      this.deps.onChange();
      if (this.again) {
        this.again = false;
        this.nudge();
      }
    }
  }

  /** What the settings panel can add: the three "latest" values plus every quest/goal that exists. */
  available(): { id: BindingId; label: string; kind: 'latest' | 'quest' | 'goal' }[] {
    return [
      { id: 'latest_follower', label: 'Latest follower', kind: 'latest' },
      { id: 'latest_sub', label: 'Latest subscriber', kind: 'latest' },
      { id: 'latest_donation', label: 'Latest donation', kind: 'latest' },
      ...this.widgets
        .filter((w) => /^[\w-]{1,80}$/.test(w.widgetId))
        .map((w) => ({ id: `widget:${w.widgetId}` as BindingId, label: w.title, kind: (w.kind === 'goal' ? 'goal' : 'quest') as 'quest' | 'goal' })),
    ];
  }
}

/** Defensive parse of the saved bindings: valid id, source name and template only; one binding per id. */
export function normalizeTextBindings(raw: unknown): TextBinding[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: TextBinding[] = [];
  for (const b of raw) {
    const o = (b ?? {}) as Record<string, unknown>;
    const source = cleanSourceName(o.source);
    const template = cleanTemplate(o.template);
    if (!isBindingId(o.id) || !source || !template || seen.has(o.id)) continue;
    seen.add(o.id);
    out.push({ id: o.id, source, template });
  }
  return out.slice(0, 30);
}
