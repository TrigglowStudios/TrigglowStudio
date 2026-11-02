/**
 * libobs source properties for Trigglow Studio's properties window: which kind of field each one is, and which values
 * the page may send back. Pure, so it can be tested without the engine (studio.ts reads the engine's properties).
 */

/** A field of the properties window. */
export type PropertyKind =
  | 'bool'
  | 'int'
  | 'float'
  | 'slider'
  | 'text'
  | 'password'
  | 'textarea'
  | 'info'
  | 'path'
  | 'list'
  | 'color'
  | 'color-alpha'
  | 'font'
  | 'button'
  | 'files';

/** A source property, flattened for the page's properties panel. Only the kinds it can edit are kept. */
export interface StudioProperty {
  name: string;
  label: string;
  kind: PropertyKind;
  value: unknown;
  enabled: boolean;
  hint?: string;
  items?: { name: string; value: string | number }[];
  min?: number;
  max?: number;
  step?: number;
  /** path: 0 = open a file, 1 = save a file, 2 = a folder. files: 0 = text lines, 1 = files, 2 = files and URLs. */
  pathType?: number;
  /** A Qt-style file filter ("Images (*.png *.jpg);;All files (*.*)"). */
  filter?: string;
  defaultPath?: string;
}

/** libobs property types (OSN's EPropertyType) → the field the page draws; null = not shown. */
export function propertyKind(p: { type: number; details?: { type?: number } }): PropertyKind | null {
  const sub = p.details?.type ?? 0;
  switch (p.type) {
    case 1:
      return 'bool';
    case 2:
      return sub === 1 ? 'slider' : 'int';
    case 3:
      return sub === 1 ? 'slider' : 'float';
    case 4:
      return (['text', 'password', 'textarea', 'info'] as const)[sub] ?? 'text';
    case 5:
      return 'path';
    case 6:
      return 'list';
    case 7:
      return 'color';
    case 8:
      return 'button';
    case 9:
      return 'font';
    case 10:
      return 'files';
    case 13:
      return 'color-alpha';
    default:
      return null; // frame rate, group, capture: not editable here yet
  }
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const int = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(max, Math.max(min, v))) : undefined);

/** The value to hand libobs for a field of this kind, or undefined when the page sent something of the wrong shape. */
export function cleanPropertyValue(kind: PropertyKind, v: unknown): unknown {
  switch (kind) {
    case 'bool':
      return typeof v === 'boolean' ? v : undefined;
    case 'int':
    case 'float':
    case 'slider':
      if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
      return kind === 'int' ? Math.round(v) : v;
    case 'text':
    case 'password':
    case 'textarea':
    case 'path':
      return str(v, 10_000);
    case 'list':
      return typeof v === 'string' || typeof v === 'number' ? v : undefined;
    case 'color':
    case 'color-alpha':
      return int(v, 0, 0xffffffff);
    case 'font': {
      const f = v as { face?: unknown; style?: unknown; size?: unknown; flags?: unknown } | null;
      if (!f || typeof f !== 'object') return undefined;
      const face = str(f.face, 100);
      const size = int(f.size, 4, 1000);
      if (!face || size === undefined) return undefined;
      return { face, style: str(f.style, 50) ?? '', size, flags: int(f.flags, 0, 15) ?? 0 };
    }
    case 'files': {
      if (!Array.isArray(v)) return undefined;
      const out: { value: string; selected: boolean; hidden: boolean }[] = [];
      for (const it of v.slice(0, 1000)) {
        const value = str((it as { value?: unknown })?.value, 2000);
        if (value) out.push({ value, selected: false, hidden: (it as { hidden?: unknown }).hidden === true });
      }
      return out;
    }
    default:
      return undefined; // info and buttons carry no value
  }
}

/** A libobs (Qt-style) file filter, "Images (*.png *.jpg);;All files (*.*)", as Electron dialog filters. */
export function dialogFilters(filter: string): { name: string; extensions: string[] }[] {
  return filter
    .split(';;')
    .map((part) => {
      const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(part.trim());
      if (!m) return null;
      const extensions = m[2]
        .split(/\s+/)
        .map((x) => (x === '*.*' || x === '*' ? '' : x.replace(/^\*\./, '')))
        .filter((x) => /^[\w-]{1,10}$/.test(x) || x === '');
      return { name: m[1].slice(0, 80) || '*', extensions: extensions.some((x) => x === '') ? ['*'] : extensions };
    })
    .filter((f): f is { name: string; extensions: string[] } => Boolean(f && f.extensions.length));
}

/**
 * The bounding box of an item on the canvas: libobs draws the (possibly flipped) `size` rectangle from `pos`, turned
 * `rotation` degrees clockwise around `pos`.
 */
export function boxOf(pos: { x: number; y: number }, size: { w: number; h: number }, rotation: number) {
  const a = (rotation * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const pts = [
    [0, 0],
    [size.w, 0],
    [0, size.h],
    [size.w, size.h],
  ].map(([x, y]) => ({ x: pos.x + x * cos - y * sin, y: pos.y + x * sin + y * cos }));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
