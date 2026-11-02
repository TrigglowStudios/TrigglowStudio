import { randomBytes } from 'node:crypto';
import { isValidAccelerator, isValidHoldKey } from './hotkey';
import { TRANSITIONS } from './studio-settings';

/**
 * Trigglow Studio's scene collection: the data saved to <userData>/studio/scenes.json and rebuilt into the engine
 * on start (studio.ts). Pure: no engine here, so it can be validated and tested on its own.
 *
 * Model (the one OBS uses): sources are shared, scenes hold items that point at a source by name with their own
 * transform. Desktop audio and the mic are sources on an output channel, heard in every scene.
 */

export type TrigglowOverlay = 'alerts' | 'chat' | 'activity' | 'goals' | 'quests' | 'giveaway' | 'loyalty' | 'music' | 'credits' | 'emotes';

/** The Trigglow overlays Studio can add as a source: URL suffix after /overlay/<id>, and the fixed source name. */
export const TRIGGLOW_OVERLAYS: Record<TrigglowOverlay, { suffix: string; name: string }> = {
  alerts: { suffix: '', name: 'Trigglow Alerts' },
  chat: { suffix: '/chat', name: 'Trigglow Chat' },
  activity: { suffix: '/activity', name: 'Trigglow Activity' },
  goals: { suffix: '/goals', name: 'Trigglow Goals' },
  quests: { suffix: '/quests', name: 'Trigglow Quests' },
  giveaway: { suffix: '/giveaway', name: 'Trigglow Giveaways' },
  loyalty: { suffix: '/loyalty', name: 'Trigglow Loyalty' },
  music: { suffix: '/music-requests', name: 'Trigglow Music' },
  credits: { suffix: '/credits', name: 'Trigglow Credits' },
  emotes: { suffix: '/emotes', name: 'Trigglow Emotes' },
};

/**
 * The overlays of a ready-made "Trigglow" scene, bottom to top (the alerts on top). Whatever overlay collection or
 * pack the streamer applies, these same sources show its look: their URLs never change.
 */
export const TRIGGLOW_SCENE_OVERLAYS: TrigglowOverlay[] = ['activity', 'goals', 'chat', 'emotes', 'alerts'];

/** Source types the Add source menu offers (libobs input ids, Windows). */
export const SOURCE_TYPES = [
  'game_capture',
  'monitor_capture',
  'window_capture',
  'dshow_input',
  'wasapi_input_capture',
  'wasapi_output_capture',
  'wasapi_process_output_capture',
  'image_source',
  'slideshow',
  'ffmpeg_source',
  'text_gdiplus_v3',
  'browser_source',
  'color_source_v3',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** Filters the Studio page offers, by the libobs id, with their name key in obs-filters' locale files. */
export const VIDEO_FILTERS: Record<string, string> = {
  color_filter_v2: 'ColorFilter',
  chroma_key_filter_v2: 'ChromaKeyFilter',
  color_key_filter_v2: 'ColorKeyFilter',
  luma_key_filter_v2: 'LumaKeyFilter',
  crop_filter: 'CropFilter',
  sharpness_filter_v2: 'SharpnessFilter',
  scroll_filter: 'ScrollFilter',
  mask_filter_v2: 'MaskFilter',
  scale_filter: 'ScaleFilter',
  clut_filter: 'ColorGradeFilter',
  gpu_delay: 'GPUDelayFilter',
  async_delay_filter: 'AsyncDelayFilter',
};
export const AUDIO_FILTERS: Record<string, string> = {
  noise_suppress_filter_v2: 'NoiseSuppress',
  noise_gate_filter: 'NoiseGate',
  gain_filter: 'Gain',
  compressor_filter: 'Compressor',
  limiter_filter: 'Limiter',
  expander_filter: 'Expander',
  basic_eq_filter: '3BandEq',
  invert_polarity_filter: 'InvertPolarity',
};

export interface SavedFilter {
  type: string;
  name: string;
  enabled: boolean;
  settings: Record<string, unknown>;
}

/** `key="value"` lines of a libobs locale file (its own strings: source and filter names, property labels). */
export function parseLocaleIni(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_.]+)="(.*)"\s*$/.exec(line);
    if (m) out.set(m[1], m[2].replace(/\\n/g, ' ').replace(/\\"/g, '"'));
  }
  return out;
}

/** libobs' own texts name OBS or Streamlabs ("Control audio via Streamlabs Desktop"); in our UI that app is Trigglow Studio. */
export function ownBrand(text: string): string {
  return text.replace(/Streamlabs(?:[ -](?:Desktop|OBS))?|OBS(?:[ -]Studio)?\b/g, 'Trigglow Studio');
}

/**
 * A stable engine name for a new source or scene (`src-…`, `scn-…`). The streamer's name is only a label: libobs can't
 * rename a source through OSN, and settings that point at another source (a compressor's sidechain) keep working
 * across renames and restarts.
 */
export function newId(prefix: 'src' | 'scn'): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}
const ID_RE = /^(src|scn)-[0-9a-f]{12}$/;

export interface SavedSource {
  /** Engine name (newId): never shown. */
  id: string;
  name: string;
  type: string;
  settings: Record<string, unknown>;
  /** Linear volume, 0..1 (OBS's "mul"). */
  volume: number;
  muted: boolean;
  /** Global audio (desktop audio, mic): an output channel instead of a scene item. */
  channel?: number;
  /** A Trigglow overlay: its URL is rebuilt from the signed-in account on every start, never trusted from disk. */
  trigglow?: TrigglowOverlay;
  /** Filters, in the order libobs applies them. */
  filters?: SavedFilter[];
  /** Advanced audio (OBS's Advanced Audio Properties): 1 = monitor only, 2 = monitor and output. */
  monitoring?: 1 | 2;
  /** Audio sync offset in milliseconds (−950…20000, like OBS). */
  syncMs?: number;
  /** Down-mix to mono. */
  mono?: boolean;
  /** OBS's audio tracks 1–6 this source goes to, as bits (1 = track 1 … 32 = track 6); absent = all six. */
  tracks?: number;
}

export interface Crop {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface SavedItem {
  /** A source's name, or another scene's (a nested scene). */
  source: string;
  visible: boolean;
  x: number;
  y: number;
  /** Negative = flipped. */
  scaleX: number;
  scaleY: number;
  /** Fit-to-canvas box (captures): width, height and libobs bounds type; absent = plain scale. */
  bounds?: { width: number; height: number; type: number };
  /** Degrees, clockwise, around the item's top-left corner (libobs' pivot). */
  rotation?: number;
  /** Source pixels cut from each edge. */
  crop?: Crop;
  /** Locked: can't be moved or resized on the preview. */
  locked?: boolean;
  /** The folder (SavedScene.folders) it's listed in. */
  folder?: string;
}

/** A folder in a scene's source list, like Streamlabs': just a way to list, hide and lock items together. */
export interface SavedFolder {
  id: string;
  name: string;
  /** Folded in the list. */
  closed?: boolean;
}

/** OBS's per-scene transition override ("transition into this scene"). */
export interface SceneTransition {
  type: (typeof TRANSITIONS)[number];
  ms: number;
}

/**
 * Shortcuts of a collection, like OBS's Settings → Hotkeys for scenes and sources. Keys: `scene:<scene id>` (switch
 * to it), `show:<scene id>:<source id>` / `hide:…` (that item), `mute:<source id>` / `unmute:…`, and the held ones
 * `ptt:<source id>` (push to talk) / `ptm:…` (push to mute). Ids, so renaming keeps them.
 */
export type CollectionHotkeys = Record<string, string>;
const HOTKEY_KEY = /^(scene:scn-[0-9a-f]{12}|(show|hide):scn-[0-9a-f]{12}:(src|scn)-[0-9a-f]{12}|(mute|unmute|ptt|ptm):src-[0-9a-f]{12})$/;
export const isHeldHotkey = (key: string) => key.startsWith('ptt:') || key.startsWith('ptm:');

/** Saved shortcuts kept: known keys, valid combinations (held ones may be a single key or a mouse side button). */
export function cleanHotkeys(raw: unknown): CollectionHotkeys {
  const out: CollectionHotkeys = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw).slice(0, 2000)) {
    if (!HOTKEY_KEY.test(k) || typeof v !== 'string') continue;
    if (isHeldHotkey(k) ? isValidHoldKey(v) : isValidAccelerator(v)) out[k] = v;
  }
  return out;
}

export interface SavedScene {
  /** Engine name (newId): never shown. */
  id: string;
  name: string;
  items: SavedItem[];
  folders?: SavedFolder[];
  transition?: SceneTransition;
}

export interface Collection {
  version: 1;
  /** The canvas the positions are in; a collection opened on another canvas is rescaled (rescaleCollection). */
  canvas: { width: number; height: number };
  current: string;
  sources: SavedSource[];
  scenes: SavedScene[];
  hotkeys?: CollectionHotkeys;
}

/** The canvas collections had before it followed the screen (and the one the overlay layout table is drawn on). */
export const CANVAS = { width: 1920, height: 1080 };
/** The alerts overlay is always centred on the canvas; only its size is configurable. Size on a 1080p canvas. */
export const ALERTS_SIZE = { width: 700, height: 440 };

/**
 * The canvas for a screen: 16:9 at the tallest standard height the screen has (1080p, 1440p or 2160p), never below
 * 1080p. `physicalHeight` is in device pixels (a 2560×1440 monitor at 125 % is still 1440).
 */
export function canvasFor(physicalHeight: number) {
  const height = [2160, 1440, 1080].find((h) => physicalHeight >= h) ?? 1080;
  return { width: Math.round((height * 16) / 9), height };
}

/** The alerts box for a canvas (the 1080p size, scaled). */
export function alertsSize(canvas: { width: number; height: number }) {
  const k = canvas.height / CANVAS.height;
  return { width: Math.round(ALERTS_SIZE.width * k), height: Math.round(ALERTS_SIZE.height * k) };
}

export function centred(size: { width: number; height: number }, canvas = CANVAS) {
  return { x: Math.round((canvas.width - size.width) / 2), y: Math.round((canvas.height - size.height) / 2) };
}

const MAX_NAME = 80;
const MAX_SOURCES = 200;
const MAX_SCENES = 100;
const MAX_ITEMS = 200;
const MAX_FILTERS = 30;

/** A trimmed, length-capped name, or null when nothing usable is left. */
export function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f]/g, '').trim().slice(0, MAX_NAME);
  return s || null;
}

/** `base`, or `base 2`, `base 3`… so names stay unique (sources and scenes are looked up by name). */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let n = 2; ; n++) if (!set.has(`${base} ${n}`)) return `${base} ${n}`;
}

const num = (v: unknown, d: number, min = -100_000, max = 100_000) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d);
/** A scale factor: −100…100, never (almost) zero. Negative = flipped. */
const scaleOf = (v: unknown) => {
  const n = num(v, 1, -100, 100);
  return Math.abs(n) < 0.01 ? (n < 0 ? -0.01 : 0.01) : n;
};
/** A crop (whole source pixels per edge), or undefined when it cuts nothing. */
export function cropOf(v: unknown): Crop | undefined {
  const c = v as Partial<Crop> | null;
  if (!c || typeof c !== 'object') return undefined;
  const out = { left: num(c.left, 0, 0, 16384) | 0, top: num(c.top, 0, 0, 16384) | 0, right: num(c.right, 0, 0, 16384) | 0, bottom: num(c.bottom, 0, 0, 16384) | 0 };
  return out.left || out.top || out.right || out.bottom ? out : undefined;
}

/** Whether `inner` is `outer` or shown somewhere inside it (nested scenes, any depth): adding it would loop. */
export function sceneContains(scenes: { name: string; items: { source: string }[] }[], outer: string, inner: string): boolean {
  const byName = new Map(scenes.map((s) => [s.name, s]));
  const seen = new Set<string>();
  const walk = (name: string): boolean => {
    if (name === inner) return true;
    if (seen.has(name)) return false;
    seen.add(name);
    return (byName.get(name)?.items ?? []).some((i) => byName.has(i.source) && walk(i.source));
  };
  return walk(outer);
}

/** Names for the starter collection, in the streamer's language (main.ts passes nt() strings). */
export interface DefaultNames {
  scene: string;
  display: string;
  game: string;
  desktop: string;
  mic: string;
  /** The first scene collection's name. */
  collection?: string;
}

/** First run: one scene with display capture, game capture on top and the alerts, plus desktop audio and mic. */
export function defaultCollection(n: DefaultNames, canvas = CANVAS): Collection {
  const fit = { width: canvas.width, height: canvas.height, type: 2 }; // scale inner: whatever the monitor or game size
  const alerts = TRIGGLOW_OVERLAYS.alerts.name;
  const size = alertsSize(canvas);
  const at = centred(size, canvas);
  return {
    version: 1,
    canvas: { ...canvas },
    current: n.scene,
    sources: [
      { id: newId('src'), name: n.display, type: 'monitor_capture', settings: { monitor: 0 }, volume: 1, muted: false },
      { id: newId('src'), name: n.game, type: 'game_capture', settings: { capture_mode: 'any_fullscreen' }, volume: 1, muted: false },
      { id: newId('src'), name: alerts, type: 'browser_source', settings: { width: size.width, height: size.height, shutdown: false }, volume: 1, muted: false, trigglow: 'alerts' },
      { id: newId('src'), name: n.desktop, type: 'wasapi_output_capture', settings: { device_id: 'default' }, volume: 1, muted: false, channel: 1 },
      { id: newId('src'), name: n.mic, type: 'wasapi_input_capture', settings: { device_id: 'default' }, volume: 1, muted: false, channel: 3 },
    ],
    scenes: [
      {
        id: newId('scn'),
        name: n.scene,
        items: [
          { source: n.display, visible: true, x: 0, y: 0, scaleX: 1, scaleY: 1, bounds: fit },
          { source: n.game, visible: true, x: 0, y: 0, scaleX: 1, scaleY: 1, bounds: fit },
          { source: alerts, visible: true, ...at, scaleX: 1, scaleY: 1 },
        ],
      },
    ],
  };
}

/**
 * Makes a collection read from disk safe to rebuild: drops anything malformed, duplicate or dangling, caps sizes,
 * keeps the alerts overlay centred, and falls back to `fallback` when nothing usable is left.
 */
export function normalizeCollection(raw: unknown, fallback: Collection): Collection {
  const r = raw as Partial<Collection> | null;
  if (!r || r.version !== 1 || !Array.isArray(r.sources) || !Array.isArray(r.scenes)) return fallback;
  // Files from before the canvas followed the screen have none: they were made on 1080p.
  const cw = num(r.canvas?.width, 0, 0, 7680);
  const ch = num(r.canvas?.height, 0, 0, 4320);
  const canvas = cw >= 640 && ch >= 360 ? { width: Math.round(cw), height: Math.round(ch) } : { ...CANVAS };
  const sources: SavedSource[] = [];
  const names = new Set<string>();
  const ids = new Set<string>();
  const freshId = (v: unknown, prefix: 'src' | 'scn') => {
    // Files from before ids (or a broken one) get new ones.
    const id = typeof v === 'string' && ID_RE.test(v) && v.startsWith(prefix) && !ids.has(v) ? v : newId(prefix);
    ids.add(id);
    return id;
  };
  const channels = new Set<number>();
  for (const s of r.sources.slice(0, MAX_SOURCES)) {
    const name = cleanName(s?.name);
    if (!name || names.has(name) || typeof s.type !== 'string' || !/^[a-z0-9_]{1,64}$/.test(s.type)) continue;
    const trigglow = typeof s.trigglow === 'string' && s.trigglow in TRIGGLOW_OVERLAYS ? (s.trigglow as TrigglowOverlay) : undefined;
    if (s.trigglow !== undefined && (!trigglow || s.type !== 'browser_source')) continue;
    let channel: number | undefined;
    if (s.channel !== undefined) {
      if (!Number.isInteger(s.channel) || s.channel < 1 || s.channel > 6 || channels.has(s.channel)) continue;
      channel = s.channel;
      channels.add(channel);
    }
    const settings = s.settings && typeof s.settings === 'object' && !Array.isArray(s.settings) ? { ...s.settings } : {};
    if (trigglow) delete settings.url; // rebuilt from the account, never from disk
    names.add(name);
    const filters: SavedFilter[] = [];
    for (const f of Array.isArray(s.filters) ? s.filters.slice(0, MAX_FILTERS) : []) {
      const fname = cleanName(f?.name);
      if (!fname || filters.some((x) => x.name === fname) || !(f.type in VIDEO_FILTERS || f.type in AUDIO_FILTERS)) continue;
      const fsettings = f.settings && typeof f.settings === 'object' && !Array.isArray(f.settings) ? { ...f.settings } : {};
      filters.push({ type: f.type, name: fname, enabled: f.enabled !== false, settings: fsettings });
    }
    const syncMs = Math.round(num(s.syncMs, 0, -950, 20000));
    sources.push({
      id: freshId(s.id, 'src'),
      name,
      type: s.type,
      settings,
      volume: num(s.volume, 1, 0, 20),
      muted: s.muted === true,
      ...(channel ? { channel } : {}),
      ...(trigglow ? { trigglow } : {}),
      ...(filters.length ? { filters } : {}),
      ...(s.monitoring === 1 || s.monitoring === 2 ? { monitoring: s.monitoring } : {}),
      ...(syncMs ? { syncMs } : {}),
      ...(s.mono === true ? { mono: true } : {}),
      ...(Number.isInteger(s.tracks) && (s.tracks as number) >= 0 && (s.tracks as number) < 63 ? { tracks: s.tracks } : {}),
    });
  }
  // Scene names first: an item can show another scene (nested), declared before or after it.
  const sceneRaw: { id?: unknown; name: string; items: Partial<SavedItem>[]; folders?: unknown; transition?: unknown }[] = [];
  for (const sc of r.scenes.slice(0, MAX_SCENES)) {
    const name = cleanName(sc?.name);
    if (!name || names.has(name) || !Array.isArray(sc.items)) continue;
    names.add(name);
    sceneRaw.push({ id: sc.id, name, items: sc.items, folders: sc.folders, transition: sc.transition });
  }
  const sceneNames = new Set(sceneRaw.map((sc) => sc.name));
  const scenes: SavedScene[] = [];
  for (const sc of sceneRaw) {
    const items: SavedItem[] = [];
    const folders: SavedFolder[] = [];
    for (const f of Array.isArray(sc.folders) ? (sc.folders as Partial<SavedFolder>[]).slice(0, MAX_ITEMS) : []) {
      const fname = cleanName(f?.name);
      if (!fname || typeof f.id !== 'string' || !/^fld-[0-9a-f]{12}$/.test(f.id) || folders.some((x) => x.id === f.id)) continue;
      folders.push({ id: f.id, name: fname, ...(f.closed === true ? { closed: true } : {}) });
    }
    for (const it of sc.items.slice(0, MAX_ITEMS)) {
      const src = sources.find((s) => s.name === it?.source && s.channel === undefined);
      const nested = !src && typeof it?.source === 'string' && sceneNames.has(it.source) && it.source !== sc.name;
      if (!src && !nested) continue;
      const item: SavedItem = { source: src ? src.name : (it.source as string), visible: it.visible !== false, x: num(it.x, 0), y: num(it.y, 0), scaleX: scaleOf(it.scaleX), scaleY: scaleOf(it.scaleY) };
      const b = it.bounds;
      if (b && typeof b === 'object') item.bounds = { width: num(b.width, CANVAS.width, 1, 16384), height: num(b.height, CANVAS.height, 1, 16384), type: num(b.type, 2, 0, 6) };
      const rotation = num(it.rotation, 0, -360, 360);
      if (rotation) item.rotation = rotation;
      const crop = cropOf(it.crop);
      if (crop) item.crop = crop;
      if (it.locked === true) item.locked = true;
      if (typeof it.folder === 'string' && folders.some((f) => f.id === it.folder)) item.folder = it.folder;
      if (src?.trigglow === 'alerts') {
        // Always centred and upright: the size can change, nothing else.
        item.scaleX = Math.abs(item.scaleX);
        item.scaleY = Math.abs(item.scaleY);
        delete item.rotation;
        delete item.crop;
        const w = (num(src.settings.width, ALERTS_SIZE.width, 1, 3840) * item.scaleX) | 0;
        const h = (num(src.settings.height, ALERTS_SIZE.height, 1, 2160) * item.scaleY) | 0;
        Object.assign(item, centred({ width: w, height: h }, canvas));
      }
      items.push(item);
    }
    // Folders nothing is in any more go.
    const used = folders.filter((f) => items.some((it) => it.folder === f.id));
    const tr = sc.transition as Partial<SceneTransition> | undefined;
    const transition = tr && (TRANSITIONS as readonly string[]).includes(tr.type as string) ? { type: tr.type as SceneTransition['type'], ms: Math.round(num(tr.ms, 300, 50, 5000)) } : null;
    scenes.push({ id: freshId(sc.id, 'scn'), name: sc.name, items, ...(used.length ? { folders: used } : {}), ...(transition ? { transition } : {}) });
  }
  if (!scenes.length) return fallback;
  // A scene shown inside itself (directly or through others) would loop forever: nested items are added back one by
  // one, in file order, and the one that would close a loop goes.
  // `kept` is what is accepted so far: only scenes, which is all the loop check looks at.
  const kept = scenes.map((sc) => ({ name: sc.name, items: [] as SavedItem[] }));
  for (const [i, sc] of scenes.entries()) {
    sc.items = sc.items.filter((it) => {
      if (!sceneNames.has(it.source)) return true;
      if (sceneContains(kept, it.source, sc.name)) return false;
      kept[i].items.push(it);
      return true;
    });
  }
  const current = scenes.some((s) => s.name === r.current) ? (r.current as string) : scenes[0].name;
  const hotkeys = cleanHotkeys(r.hotkeys);
  return { version: 1, canvas, current, sources, scenes, ...(Object.keys(hotkeys).length ? { hotkeys } : {}) };
}

/**
 * The same layout on another canvas: positions, scales and bounds boxes grow or shrink with the height, so a scene
 * made on 1080p looks the same on 1440p. The alerts stay centred.
 */
export function rescaleCollection(c: Collection, to: { width: number; height: number }): Collection {
  if (c.canvas.width === to.width && c.canvas.height === to.height) return c;
  const k = to.height / c.canvas.height;
  const kx = to.width / c.canvas.width;
  const alerts = new Set(c.sources.filter((s) => s.trigglow === 'alerts').map((s) => s.name));
  const alertSource = c.sources.find((s) => s.trigglow === 'alerts');
  return {
    ...c,
    canvas: { ...to },
    scenes: c.scenes.map((sc) => ({
      ...sc,
      items: sc.items.map((it) => {
        const next: SavedItem = it.bounds
          ? { ...it, x: it.x * kx, y: it.y * k, bounds: { ...it.bounds, width: it.bounds.width * kx, height: it.bounds.height * k } }
          : { ...it, x: it.x * kx, y: it.y * k, scaleX: it.scaleX * k, scaleY: it.scaleY * k };
        if (alerts.has(it.source) && alertSource) {
          const w = num(alertSource.settings.width, ALERTS_SIZE.width, 1, 3840) * next.scaleX;
          const h = num(alertSource.settings.height, ALERTS_SIZE.height, 1, 2160) * next.scaleY;
          Object.assign(next, centred({ width: w, height: h }, to));
        }
        return next;
      }),
    })),
  };
}
