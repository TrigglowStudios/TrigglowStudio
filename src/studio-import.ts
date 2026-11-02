/**
 * Migration into Trigglow Studio (docs/design/trigglow-studio.md §5): an OBS Studio or Streamlabs Desktop scene
 * collection becomes a Studio collection, plus a report of what came across as is, what was converted and what could
 * not come (with why). Pure: the files are read and the engine is asked what it supports in studio-import-files.ts and
 * main.ts. Nothing here ever writes to OBS's or Streamlabs' files.
 */
import type { TRANSITIONS } from './studio-settings';
import { createHash } from 'node:crypto';
import { AUDIO_FILTERS, TRIGGLOW_OVERLAYS, VIDEO_FILTERS, cleanHotkeys, cleanName, isHeldHotkey, newId, uniqueName, type Collection, type SavedFilter, type SavedItem, type SavedScene, type SavedSource, type TrigglowOverlay } from './studio-scenes';

/** One line of the report. `converted` and `lost` say what to do about it (main.ts / the page turn codes into text). */
export interface ImportNote {
  level: 'converted' | 'lost';
  code:
    | 'trigglow_overlay' // a browser source showing one of our overlays → a native Trigglow source
    | 'alerts_centred' // the alerts were not centred: they are now (team rule)
    | 'streamlabs_widget' // a Streamlabs widget → the Trigglow overlay of the same kind (its look is set in Trigglow)
    | 'streamlabs_widget_unsupported' // a Streamlabs widget with no Trigglow counterpart → placeholder
    | 'plugin_source' // a source type this engine doesn't have (a plugin) → placeholder with its name and place
    | 'plugin_filter' // a filter Studio doesn't offer → dropped
    | 'group_folder' // a group (Streamlabs: a folder) becomes a folder in the source list, its items in the scene
    | 'group_transform' // …and the group was turned or boxed: its items may sit slightly differently
    | 'hotkeys_imported' // shortcuts for scenes, items and audio came along (detail: how many)
    | 'alignment' // an item anchored to something other than its top-left corner: placed by its corner
    | 'transition' // a transition Studio doesn't have yet → fade
    | 'file_missing' // a picture, video or stinger file that isn't on this PC
    | 'hotkeys' // shortcuts that couldn't come (detail: how many): keys Studio can't use, or the app's own (stream, record…)
    | 'audio_channel'; // global audio beyond Studio's six channels
  name?: string;
  detail?: string;
}

export interface ImportResult {
  collection: Collection;
  notes: ImportNote[];
  /** Counts for the report's headline. */
  stats: { scenes: number; sources: number };
  /** The transition the collection used, in Studio's terms. */
  transition: { kind: (typeof TRANSITIONS)[number]; ms: number; stingerFile?: string; stingerPointMs?: number } | null;
}

export interface ImportContext {
  /** libobs input ids this engine can create (InputFactory.types()). */
  inputTypes: Set<string>;
  /** Whether a local file exists (fs.existsSync in the app; a stub in tests). */
  fileExists: (p: string) => boolean;
  /** The canvas when the collection doesn't say (Streamlabs keeps it in its profile). */
  fallbackCanvas: { width: number; height: number };
}

/* ------------------------------- shared helpers ------------------------------- */

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const KNOWN_FILTERS = new Set([...Object.keys(VIDEO_FILTERS), ...Object.keys(AUDIO_FILTERS)]);
/** Older libobs filter ids that the versioned ones replaced. */
const FILTER_ALIASES: Record<string, string> = {
  color_filter: 'color_filter_v2',
  chroma_key_filter: 'chroma_key_filter_v2',
  color_key_filter: 'color_key_filter_v2',
  luma_key_filter: 'luma_key_filter_v2',
  sharpness_filter: 'sharpness_filter_v2',
  mask_filter: 'mask_filter_v2',
  noise_suppress_filter: 'noise_suppress_filter_v2',
};

/** Our overlay URLs: `<web origin>/overlay/<id>[/<suffix>]`. The kind comes from the suffix. */
export function trigglowOverlayOf(url: unknown): TrigglowOverlay | null {
  if (typeof url !== 'string') return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (!(host === 'trigglow.com' || host.endsWith('.trigglow.com') || host === 'localhost' || host === '127.0.0.1')) return null;
  const m = /^\/overlay\/[^/]+(\/[a-z-]+)?\/?$/.exec(u.pathname);
  if (!m) return null;
  const suffix = m[1] ?? '';
  const hit = (Object.entries(TRIGGLOW_OVERLAYS) as [TrigglowOverlay, { suffix: string }][]).find(([, o]) => o.suffix === suffix);
  return hit ? hit[0] : null;
}

/** Local files a source depends on (to warn about the ones that aren't on this PC). */
export function filesOf(type: string, settings: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (type === 'image_source' && typeof settings.file === 'string') out.push(settings.file);
  if (type === 'ffmpeg_source' && settings.is_local_file !== false && typeof settings.local_file === 'string') out.push(settings.local_file);
  if (type === 'slideshow' && Array.isArray(settings.files)) for (const f of settings.files) if (isObj(f) && typeof f.value === 'string') out.push(f.value);
  if (type.startsWith('text_') && settings.read_from_file === true && typeof settings.file === 'string') out.push(settings.file);
  return out.filter((f) => f && !/^https?:/i.test(f));
}

/**
 * The same collection with every local file a source uses (images, media, slideshows, text from a file) swapped
 * through `to` (a copy in Studio's own folder, so the collection keeps working if OBS or its files go away).
 */
export function relocateFiles(c: Collection, to: (file: string) => string | null): Collection {
  const swap = (f: unknown) => (typeof f === 'string' && f && !/^https?:/i.test(f) ? (to(f) ?? f) : f);
  return {
    ...c,
    sources: c.sources.map((src) => {
      const s = { ...src.settings };
      if (src.type === 'image_source') s.file = swap(s.file);
      if (src.type === 'ffmpeg_source' && s.is_local_file !== false) s.local_file = swap(s.local_file);
      if (src.type === 'slideshow' && Array.isArray(s.files)) s.files = s.files.map((f) => (isObj(f) ? { ...f, value: swap(f.value) } : f));
      if (src.type.startsWith('text_') && s.read_from_file === true) s.file = swap(s.file);
      return { ...src, settings: s };
    }),
  };
}

/**
 * OBS's custom browser docks (user.ini → [BasicWindow] ExtraBrowserDocks, a JSON list of { title, url }): the https
 * ones, except Trigglow's own activity and chat docks, which Studio has built in.
 */
export function obsBrowserDocks(raw: string | undefined): { name: string; url: string }[] {
  let list: unknown;
  try {
    list = JSON.parse(raw ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: { name: string; url: string }[] = [];
  for (const d of list.filter(isObj)) {
    const name = typeof d.title === 'string' ? d.title.trim().slice(0, 60) : '';
    if (!name || typeof d.url !== 'string') continue;
    let u: URL;
    try {
      u = new URL(d.url);
    } catch {
      continue;
    }
    if (u.protocol !== 'https:' || u.username || u.password) continue;
    if (/(^|\.)trigglow\.com$/.test(u.hostname) && /^\/dock\/(activity|chat)\/?$/.test(u.pathname)) continue;
    out.push({ name, url: u.toString() });
  }
  return out.slice(0, 20);
}

/** Builds the collection and its report as sources and scenes arrive (both importers share it). */
class Builder {
  readonly notes: ImportNote[] = [];
  readonly sources: SavedSource[] = [];
  readonly scenes: SavedScene[] = [];
  private readonly names = new Set<string>();
  /** Original name → our name (renamed when two things shared one). */
  readonly rename = new Map<string, string>();
  private readonly trigglowSeen = new Map<TrigglowOverlay, string>();
  /** Shortcuts found, by our names (ids only exist once the collection is built): kind, scene, source, combination. */
  readonly hotkeys: { kind: 'scene' | 'show' | 'hide' | 'mute' | 'unmute' | 'ptt' | 'ptm'; scene?: string; source?: string; accelerator: string }[] = [];
  hotkeysSkipped = 0;

  constructor(private ctx: ImportContext) {}

  fileExists(p: string) {
    return this.ctx.fileExists(p);
  }

  note(n: ImportNote) {
    this.notes.push(n);
  }

  private take(name: string) {
    const clean = cleanName(name) ?? 'Source';
    const unique = uniqueName(clean, this.names);
    this.names.add(unique);
    return unique;
  }

  reserveScene(original: string): string {
    const name = this.take(original);
    this.rename.set(`scene:${original}`, name);
    return name;
  }

  /**
   * A source as Studio will keep it. `box` is where its first item sits (to size a placeholder). Returns our name, or
   * null when it was dropped.
   */
  addSource(
    original: string,
    rawType: string,
    settings: Record<string, unknown>,
    audio: { volume?: number; muted?: boolean; syncMs?: number; monitoring?: number; mono?: boolean; channel?: number },
    filters: { type: string; name: string; enabled: boolean; settings: Record<string, unknown> }[],
    widget?: { trigglow: TrigglowOverlay | null; label: string },
  ): string | null {
    let type = rawType;
    let s: Record<string, unknown> = { ...settings };
    let trigglow: TrigglowOverlay | undefined;
    if (widget) {
      if (widget.trigglow) {
        trigglow = widget.trigglow;
        type = 'browser_source';
        this.note({ level: 'converted', code: 'streamlabs_widget', name: original, detail: widget.label });
      } else {
        this.note({ level: 'lost', code: 'streamlabs_widget_unsupported', name: original, detail: widget.label });
        type = 'color_source_v3';
        s = { color: 0, width: num(settings.width, 400), height: num(settings.height, 300) };
      }
    } else if (type === 'browser_source') {
      const kind = trigglowOverlayOf(s.url);
      if (kind) {
        trigglow = kind;
        this.note({ level: 'converted', code: 'trigglow_overlay', name: original });
      }
    }
    if (trigglow) {
      delete s.url;
      // One Studio source per overlay: a second copy in OBS points at the same one.
      const seen = this.trigglowSeen.get(trigglow);
      if (seen) {
        this.rename.set(original, seen);
        return seen;
      }
    }
    if (!trigglow && !this.ctx.inputTypes.has(type)) {
      // A plugin's source: keep its name and its place, as an empty (transparent) block.
      this.note({ level: 'lost', code: 'plugin_source', name: original, detail: rawType });
      type = 'color_source_v3';
      s = { color: 0, width: num(settings.width, 400), height: num(settings.height, 300) };
    }
    for (const f of filesOf(type, s)) if (!this.ctx.fileExists(f)) this.note({ level: 'lost', code: 'file_missing', name: original, detail: f });
    const keptFilters: SavedFilter[] = [];
    for (const f of filters) {
      const ftype = FILTER_ALIASES[f.type] ?? f.type;
      if (!KNOWN_FILTERS.has(ftype)) {
        this.note({ level: 'lost', code: 'plugin_filter', name: original, detail: `${f.name} (${f.type})` });
        continue;
      }
      const fname = uniqueName(cleanName(f.name) ?? ftype, keptFilters.map((x) => x.name));
      keptFilters.push({ type: ftype, name: fname, enabled: f.enabled, settings: { ...f.settings } });
    }
    const name = this.take(original);
    this.rename.set(original, name);
    if (trigglow) this.trigglowSeen.set(trigglow, name);
    const syncMs = Math.round(num(audio.syncMs));
    this.sources.push({
      id: '',
      name,
      type,
      settings: s,
      volume: Math.min(20, Math.max(0, num(audio.volume, 1))),
      muted: audio.muted === true,
      ...(audio.channel ? { channel: audio.channel } : {}),
      ...(trigglow ? { trigglow } : {}),
      ...(keptFilters.length ? { filters: keptFilters } : {}),
      ...(audio.monitoring === 1 || audio.monitoring === 2 ? { monitoring: audio.monitoring } : {}),
      ...(syncMs ? { syncMs } : {}),
      ...(audio.mono ? { mono: true } : {}),
    });
    return name;
  }

  result(canvas: { width: number; height: number }, current: string | null, transition: ImportResult['transition']): ImportResult {
    const scenes = this.scenes.length ? this.scenes : [{ id: '', name: 'Scene', items: [] }];
    // The alerts are always centred in Studio (team rule): say so when the old layout had them elsewhere.
    const alerts = this.sources.find((s) => s.trigglow === 'alerts');
    if (alerts) {
      const w = num(alerts.settings.width, 700);
      const h = num(alerts.settings.height, 440);
      const off = scenes.some((sc) =>
        sc.items.some((i) => i.source === alerts.name && (Math.abs(i.x + (w * i.scaleX) / 2 - canvas.width / 2) > 2 || Math.abs(i.y + (h * i.scaleY) / 2 - canvas.height / 2) > 2)),
      );
      if (off) this.note({ level: 'converted', code: 'alerts_centred', name: alerts.name });
    }
    // Ids now, so the shortcuts can point at them (normalizeCollection keeps valid ones).
    for (const src of this.sources) src.id ||= newId('src');
    for (const sc of scenes) sc.id ||= newId('scn');
    const idOf = (name?: string) => this.sources.find((x) => x.name === name)?.id ?? scenes.find((x) => x.name === name)?.id;
    const raw: Record<string, string> = {};
    for (const h of this.hotkeys) {
      const key =
        h.kind === 'scene' ? `scene:${idOf(h.scene)}` : h.kind === 'show' || h.kind === 'hide' ? `${h.kind}:${idOf(h.scene)}:${idOf(h.source)}` : `${h.kind}:${idOf(h.source)}`;
      if (!key.includes('undefined')) raw[key] = h.accelerator;
    }
    const hotkeys = cleanHotkeys(raw);
    const kept = Object.keys(hotkeys).length;
    const lost = this.hotkeysSkipped + this.hotkeys.length - kept;
    if (kept) this.note({ level: 'converted', code: 'hotkeys_imported', detail: String(kept) });
    if (lost > 0) this.note({ level: 'lost', code: 'hotkeys', detail: String(lost) });
    const collection: Collection = {
      version: 1,
      canvas: { width: Math.round(canvas.width), height: Math.round(canvas.height) },
      current: scenes.some((s) => s.name === current) ? current! : scenes[0].name,
      sources: this.sources,
      scenes,
      ...(kept ? { hotkeys } : {}),
    };
    return { collection, notes: this.notes, stats: { scenes: scenes.length, sources: this.sources.filter((s) => !s.channel).length }, transition };
  }
}

const LIBOBS_TRANSITIONS: Record<string, (typeof TRANSITIONS)[number]> = {
  cut_transition: 'cut',
  fade_transition: 'fade',
  swipe_transition: 'swipe',
  slide_transition: 'slide',
  fade_to_color_transition: 'fade_to_color',
  wipe_transition: 'wipe',
  obs_stinger_transition: 'stinger',
};

/** libobs transition ids → Studio's; others (plugins: Move…) fall back to fade and go to the report. */
function transitionOf(id: unknown, ms: unknown, b: Builder, name?: string, settings: Record<string, unknown> = {}): ImportResult['transition'] {
  const t = typeof id === 'string' ? id : '';
  const duration = Math.round(Math.min(5000, Math.max(50, num(ms, 300))));
  const kind = LIBOBS_TRANSITIONS[t];
  if (kind === 'stinger') {
    const file = typeof settings.path === 'string' ? settings.path : '';
    if (file && b.fileExists(file)) return { kind, ms: duration, stingerFile: file, stingerPointMs: Math.round(Math.max(0, num(settings.transition_point, 500))) };
    b.note({ level: 'lost', code: 'file_missing', name: name ?? t, detail: file || t });
    return { kind: 'fade', ms: duration };
  }
  if (kind) return { kind, ms: duration };
  if (t) b.note({ level: 'converted', code: 'transition', name: name ?? t, detail: t });
  return { kind: 'fade', ms: duration };
}

/* ----------------------------------- OBS ----------------------------------- */

type ObsSource = Record<string, unknown> & { name?: unknown; id?: unknown; versioned_id?: unknown; settings?: unknown; filters?: unknown };
type ObsItem = Record<string, unknown> & { name?: unknown; pos?: unknown; scale?: unknown; bounds?: unknown };

const OBS_CHANNELS: [string, number][] = [
  ['DesktopAudioDevice1', 1],
  ['DesktopAudioDevice2', 2],
  ['AuxAudioDevice1', 3],
  ['AuxAudioDevice2', 4],
  ['AuxAudioDevice3', 5],
  ['AuxAudioDevice4', 6],
];

function vec(v: unknown, d = { x: 0, y: 0 }) {
  return isObj(v) ? { x: num(v.x, d.x), y: num(v.y, d.y) } : d;
}

function obsAudio(s: ObsSource) {
  const sync = num(s.sync); // nanoseconds
  return {
    volume: num(s.volume, 1),
    muted: s.muted === true,
    syncMs: sync / 1_000_000,
    monitoring: num(s.monitoring_type),
    mono: (num(s.flags) & 2) !== 0, // OBS_SOURCE_FLAG_FORCE_MONO
  };
}

function obsFilters(s: ObsSource) {
  return (Array.isArray(s.filters) ? s.filters : []).filter(isObj).map((f) => ({
    type: String(f.versioned_id ?? f.id ?? ''),
    name: String(f.name ?? f.id ?? ''),
    enabled: f.enabled !== false,
    settings: isObj(f.settings) ? f.settings : {},
  }));
}

/** A folder id that is the same every time the same collection is imported. */
const folderId = (scene: string, name: string) => `fld-${createHash('sha256').update(`${scene}\u0000${name}`).digest('hex').slice(0, 12)}`;

/**
 * An OBS key binding ({ key: 'OBS_KEY_F1', control: true, … }) as an Electron accelerator, or null for keys Studio
 * can't use (keypad, media keys…). `held`: push to talk/mute, where a single key or a mouse side button is fine.
 */
export function obsAccelerator(binding: unknown, held: boolean): string | null {
  if (!isObj(binding) || typeof binding.key !== 'string') return null;
  const k = binding.key.replace(/^OBS_KEY_/, '');
  const named: Record<string, string> = { SPACE: 'Space', TAB: 'Tab', RETURN: 'Enter', ENTER: 'Enter', HOME: 'Home', END: 'End', PAGEUP: 'PageUp', PAGEDOWN: 'PageDown', INSERT: 'Insert', DELETE: 'Delete', UP: 'Up', DOWN: 'Down', LEFT: 'Left', RIGHT: 'Right', MINUS: 'Minus', EQUAL: 'Equal', PLUS: 'Plus', CAPSLOCK: 'CapsLock', ASCIITILDE: 'Backquote', QUOTELEFT: 'Backquote', MOUSE4: 'Mouse4', MOUSE5: 'Mouse5' };
  const key = /^[A-Z0-9]$/.test(k) ? k : /^F([1-9]|1\d|2[0-4])$/.test(k) ? k : named[k];
  if (!key) return null;
  const mods = [...(binding.control === true || binding.command === true ? ['CommandOrControl'] : []), ...(binding.alt === true ? ['Alt'] : []), ...(binding.shift === true ? ['Shift'] : [])];
  if (!held && !mods.length && !/^F\d/.test(key)) return null; // a lone key would be taken from every app
  if (!held && key.startsWith('Mouse')) return null;
  return [...mods, key].join('+');
}

/** The first binding of an OBS hotkey entry, as an accelerator ('' = none set, null = can't be used). */
function obsHotkey(hotkeys: unknown, name: string, held: boolean): string | null | '' {
  const list = isObj(hotkeys) && Array.isArray(hotkeys[name]) ? (hotkeys[name] as unknown[]) : [];
  if (!list.length) return '';
  return obsAccelerator(list[0], held);
}

/** An OBS scene item as Studio's, in canvas pixels. */
function obsItem(it: ObsItem, source: string, b: Builder): SavedItem {
  const pos = vec(it.pos);
  const scale = vec(it.scale, { x: 1, y: 1 });
  const bt = num(it.bounds_type);
  const bounds = vec(it.bounds);
  const align = num(it.align, 5);
  if (align !== 5) b.note({ level: 'converted', code: 'alignment', name: source });
  const crop = { left: num(it.crop_left), top: num(it.crop_top), right: num(it.crop_right), bottom: num(it.crop_bottom) };
  return {
    source,
    visible: it.visible !== false,
    x: pos.x,
    y: pos.y,
    scaleX: scale.x || 1,
    scaleY: scale.y || 1,
    ...(bt ? { bounds: { width: bounds.x || 1, height: bounds.y || 1, type: bt } } : {}),
    ...(num(it.rot) ? { rotation: num(it.rot) } : {}),
    ...(crop.left || crop.top || crop.right || crop.bottom ? { crop } : {}),
    ...(it.locked === true ? { locked: true } : {}),
  };
}

/** Parses an OBS Studio scene collection (`basic/scenes/<name>.json`). */
export function importObsCollection(raw: unknown, ctx: ImportContext): ImportResult {
  const c = isObj(raw) ? raw : {};
  const b = new Builder(ctx);
  const all = (Array.isArray(c.sources) ? c.sources : []).filter(isObj) as ObsSource[];
  const groups = (Array.isArray(c.groups) ? c.groups : []).filter(isObj) as ObsSource[];
  const byName = new Map<string, ObsSource>();
  for (const s of [...all, ...groups]) if (typeof s.name === 'string') byName.set(s.name, s);
  const typeOf = (s: ObsSource) => String(s.versioned_id ?? s.id ?? '');
  const sceneSources = all.filter((s) => typeOf(s) === 'scene');
  // Scenes in the order of OBS's Scenes dock.
  const order = (Array.isArray(c.scene_order) ? c.scene_order : []).map((o) => (isObj(o) ? String(o.name ?? '') : '')).filter(Boolean);
  sceneSources.sort((a, z) => {
    const ia = order.indexOf(String(a.name));
    const iz = order.indexOf(String(z.name));
    return (ia < 0 ? 1e9 : ia) - (iz < 0 ? 1e9 : iz);
  });
  for (const sc of sceneSources) b.reserveScene(String(sc.name));

  // Global audio (Settings → Audio in OBS): Studio's channels 1..6.
  for (const [key, channel] of OBS_CHANNELS) {
    const s = c[key];
    if (!isObj(s) || typeof s.name !== 'string') continue;
    const ours = b.addSource(s.name, typeOf(s as ObsSource), isObj(s.settings) ? s.settings : {}, { ...obsAudio(s as ObsSource), channel }, obsFilters(s as ObsSource));
    if (ours) addAudioHotkeys(s as ObsSource, ours);
  }

  // Sources the scenes show (made once, shared, like in OBS).
  const made = new Map<string, string | null>();
  const sourceFor = (name: string): string | null => {
    if (made.has(name)) return made.get(name)!;
    const s = byName.get(name);
    let ours: string | null = null;
    if (s) ours = b.addSource(name, typeOf(s), isObj(s.settings) ? s.settings : {}, obsAudio(s), obsFilters(s));
    made.set(name, ours);
    if (s && ours) addAudioHotkeys(s, ours);
    return ours;
  };
  // A source's mute / unmute / push to talk / push to mute shortcuts.
  function addAudioHotkeys(s: ObsSource, ours: string) {
    for (const [obs, kind] of [['libobs.mute', 'mute'], ['libobs.unmute', 'unmute'], ['libobs.push-to-talk', 'ptt'], ['libobs.push-to-mute', 'ptm']] as const) {
      const acc = obsHotkey(s.hotkeys, obs, kind === 'ptt' || kind === 'ptm');
      if (acc === null) b.hotkeysSkipped++;
      else if (acc) b.hotkeys.push({ kind, source: ours, accelerator: acc });
    }
  };

  for (const sc of sceneSources) {
    const name = b.rename.get(`scene:${String(sc.name)}`)!;
    const items: SavedItem[] = [];
    const folders: { id: string; name: string }[] = [];
    const settings = isObj(sc.settings) ? sc.settings : {};
    const select = obsHotkey(sc.hotkeys, 'OBSBasic.SelectScene', false);
    if (select === null) b.hotkeysSkipped++;
    else if (select) b.hotkeys.push({ kind: 'scene', scene: name, accelerator: select });
    for (const it of (Array.isArray(settings.items) ? settings.items : []).filter(isObj) as ObsItem[]) {
      const ref = String(it.name ?? '');
      const target = byName.get(ref);
      if (!target) continue;
      const kind = typeOf(target);
      // Show / hide this item (OBS keys them by the item's id in the scene).
      const itemHotkeys = (source: string) => {
        for (const show of ['show', 'hide'] as const) {
          const acc = obsHotkey(sc.hotkeys, `libobs.${show}_scene_item.${num(it.id)}`, false);
          if (acc === null) b.hotkeysSkipped++;
          else if (acc) b.hotkeys.push({ kind: show, scene: name, source, accelerator: acc });
        }
      };
      if (kind === 'scene') {
        const nested = b.rename.get(`scene:${ref}`);
        if (nested) {
          items.push(obsItem(it, nested, b));
          itemHotkeys(nested);
        }
        continue;
      }
      if (kind === 'group') {
        // Studio's groups are folders in the source list: the group's items go into the scene, carried by the group's
        // position and scale, listed in a folder with its name.
        b.note({ level: 'converted', code: 'group_folder', name: ref });
        const folder = { id: folderId(name, ref), name: cleanName(ref) ?? 'Folder' };
        if (!folders.some((f) => f.id === folder.id)) folders.push(folder);
        const g = obsItem(it, ref, b);
        if (g.rotation || g.bounds || g.crop) b.note({ level: 'converted', code: 'group_transform', name: ref });
        const gs = isObj(target.settings) ? target.settings : {};
        for (const child of (Array.isArray(gs.items) ? gs.items : []).filter(isObj) as ObsItem[]) {
          const cname = String(child.name ?? '');
          const ours = byName.get(cname) && typeOf(byName.get(cname)!) !== 'scene' ? sourceFor(cname) : b.rename.get(`scene:${cname}`) ?? null;
          if (!ours) continue;
          const ci = obsItem(child, ours, b);
          items.push({
            ...ci,
            x: g.x + ci.x * g.scaleX,
            y: g.y + ci.y * g.scaleY,
            scaleX: ci.scaleX * g.scaleX,
            scaleY: ci.scaleY * g.scaleY,
            ...(ci.bounds ? { bounds: { ...ci.bounds, width: ci.bounds.width * g.scaleX, height: ci.bounds.height * g.scaleY } } : {}),
            visible: ci.visible && g.visible,
            ...(g.locked ? { locked: true } : {}),
            folder: folder.id,
          });
        }
        continue;
      }
      const ours = sourceFor(ref);
      if (ours) {
        items.push(obsItem(it, ours, b));
        itemHotkeys(ours);
      }
    }
    b.scenes.push({ id: '', name, items, ...(folders.length ? { folders } : {}) });
  }

  // The collection's own top-level shortcuts are OBS's (stream, record…): Studio has its own in Settings.
  b.hotkeysSkipped += isObj(c.hotkeys) ? Object.values(c.hotkeys).filter((v) => Array.isArray(v) && v.length).length : 0;

  const res = vec(c.resolution, { x: 0, y: 0 });
  const canvas = res.x >= 320 && res.y >= 180 ? { width: res.x, height: res.y } : ctx.fallbackCanvas;
  const transitions = (Array.isArray(c.transitions) ? c.transitions : []).filter(isObj);
  const currentName = typeof c.current_transition === 'string' ? c.current_transition : '';
  const cur = transitions.find((t) => t.name === currentName);
  // Built-in transitions aren't in `transitions` (only user-made ones are); the name says which.
  const builtIn = /^(cut|corte|schnitt|coupure|taglio)$/i.test(currentName) ? 'cut_transition' : 'fade_transition';
  const transition = transitionOf(cur ? (cur.id ?? cur.versioned_id) : builtIn, c.transition_duration, b, currentName || undefined, cur && isObj(cur.settings) ? cur.settings : {});
  const current = typeof c.current_scene === 'string' ? (b.rename.get(`scene:${c.current_scene}`) ?? null) : null;
  return b.result(canvas, current, transition);
}

/* ------------------------------ Streamlabs Desktop ------------------------------ */

/**
 * Streamlabs widget types (its `WidgetType` enum) → the Trigglow overlay that does the same job. Their look stays in
 * Streamlabs; the Trigglow overlay uses the streamer's Trigglow settings.
 */
const SLOBS_WIDGETS: Record<number, { label: string; trigglow: TrigglowOverlay | null }> = {
  0: { label: 'Alert Box', trigglow: 'alerts' },
  1: { label: 'Donation Goal', trigglow: 'goals' },
  2: { label: 'Follower Goal', trigglow: 'goals' },
  3: { label: 'Subscriber Goal', trigglow: 'goals' },
  4: { label: 'Bit Goal', trigglow: 'goals' },
  5: { label: 'Donation Ticker', trigglow: null },
  6: { label: 'Chat Box', trigglow: 'chat' },
  7: { label: 'Event List', trigglow: 'activity' },
  8: { label: 'Tip Jar', trigglow: null },
  9: { label: 'Viewer Count', trigglow: null },
  10: { label: 'Stream Boss', trigglow: null },
  11: { label: 'Credits', trigglow: 'credits' },
  12: { label: 'Spin Wheel', trigglow: null },
  13: { label: 'Sponsor Banner', trigglow: null },
  14: { label: 'Media Share', trigglow: 'music' },
  15: { label: 'Sub Goal', trigglow: 'goals' },
  16: { label: 'Chat Highlight', trigglow: null },
  17: { label: 'Super Chat Goal', trigglow: 'goals' },
  18: { label: 'Character Goal', trigglow: 'goals' },
  19: { label: 'Emote Wall', trigglow: 'emotes' },
};
/** Older collections only have the widget's URL: its path says which widget. */
const SLOBS_WIDGET_PATHS: [RegExp, number][] = [
  [/\/alert-?box\//i, 0],
  [/\/chat-?box\//i, 6],
  [/\/event-?list\//i, 7],
  [/\/(donation|follower|subscriber|bit|sub)-?goal\//i, 1],
  [/\/end-?credits\//i, 11],
  [/\/emote-?wall\//i, 19],
  [/\/media-?share\//i, 14],
];

function slobsWidget(s: Record<string, unknown>, settings: Record<string, unknown>): { trigglow: TrigglowOverlay | null; label: string } | undefined {
  const pm = isObj(s.propertiesManagerSettings) ? s.propertiesManagerSettings : {};
  const isWidget = s.propertiesManager === 'widget' || typeof pm.widgetType === 'number';
  let type = typeof pm.widgetType === 'number' ? pm.widgetType : null;
  const url = typeof settings.url === 'string' ? settings.url : '';
  if (type === null && /streamlabs\.com/i.test(url)) type = SLOBS_WIDGET_PATHS.find(([re]) => re.test(url))?.[1] ?? -1;
  if (!isWidget && type === null) return undefined;
  const w = type !== null ? SLOBS_WIDGETS[type] : undefined;
  return w ?? { trigglow: null, label: url ? new URL(url, 'https://streamlabs.com').pathname.split('/').filter(Boolean)[0] ?? 'widget' : 'widget' };
}

/** Parses a Streamlabs Desktop scene collection (`SceneCollections/<id>.json`). */
export function importSlobsCollection(raw: unknown, ctx: ImportContext): ImportResult {
  const c = isObj(raw) ? raw : {};
  const b = new Builder(ctx);
  const items = (node: unknown) => (isObj(node) && Array.isArray(node.items) ? node.items.filter(isObj) : []);
  const sources = items(c.sources);
  const scenes = items(c.scenes);
  const sourceById = new Map(sources.map((s) => [String(s.id ?? ''), s]));
  const sceneById = new Map(scenes.map((s) => [String(s.id ?? ''), s]));
  for (const sc of scenes) b.reserveScene(String(sc.name ?? 'Scene'));

  const made = new Map<string, string | null>();
  const sourceFor = (id: string): string | null => {
    if (made.has(id)) return made.get(id)!;
    const s = sourceById.get(id);
    let ours: string | null = null;
    if (s) {
      const settings = isObj(s.settings) ? s.settings : {};
      const sync = isObj(s.syncOffset) ? num(s.syncOffset.sec) * 1000 + num(s.syncOffset.nsec) / 1_000_000 : 0;
      const filters = items(s.filters).map((f) => ({ type: String(f.type ?? ''), name: String(f.name ?? f.type ?? ''), enabled: f.visible !== false, settings: isObj(f.settings) ? f.settings : {} }));
      const channel = num(s.channel);
      ours = b.addSource(
        String(s.name ?? id),
        String(s.type ?? ''),
        settings,
        { volume: num(s.volume, 1), muted: s.muted === true, syncMs: sync, monitoring: num(s.monitoringType), mono: s.forceMono === true, ...(channel >= 1 && channel <= 6 ? { channel } : {}) },
        filters,
        slobsWidget(s, settings),
      );
    }
    made.set(id, ours);
    return ours;
  };
  // Global audio first (a source with a channel is in every scene, not an item).
  for (const s of sources) {
    const ch = num(s.channel);
    if (ch >= 1 && ch <= 6) sourceFor(String(s.id ?? ''));
    else if (ch > 6) b.note({ level: 'lost', code: 'audio_channel', name: String(s.name ?? '') });
  }

  for (const sc of scenes) {
    const name = b.rename.get(`scene:${String(sc.name ?? 'Scene')}`)!;
    const out: SavedItem[] = [];
    const nodes = items(sc.sceneItems);
    const folders = new Map(nodes.filter((n) => n.sceneNodeType === 'folder').map((f) => [String(f.id ?? ''), f]));
    for (const f of folders.values()) b.note({ level: 'converted', code: 'group_folder', name: String(f.name ?? '') });
    const ourFolders = [...folders.values()].map((f) => ({ id: folderId(name, String(f.id ?? f.name ?? '')), name: cleanName(f.name) ?? 'Folder' }));
    // Streamlabs lists a scene's items top first; Studio (and libobs) keep them bottom first.
    for (const n of [...nodes].reverse()) {
      if (n.sceneNodeType === 'folder') continue;
      const sid = String(n.sourceId ?? '');
      const ours = sceneById.has(sid) ? (b.rename.get(`scene:${String(sceneById.get(sid)!.name ?? '')}`) ?? null) : sourceFor(sid);
      if (!ours) continue;
      const crop = isObj(n.crop) ? { left: num(n.crop.left), top: num(n.crop.top), right: num(n.crop.right), bottom: num(n.crop.bottom) } : null;
      const parent = folders.get(String(n.parentId ?? ''));
      out.push({
        source: ours,
        visible: n.visible !== false && (!parent || parent.visible !== false),
        x: num(n.x),
        y: num(n.y),
        scaleX: num(n.scaleX, 1) || 1,
        scaleY: num(n.scaleY, 1) || 1,
        ...(num(n.rotation) ? { rotation: num(n.rotation) } : {}),
        ...(crop && (crop.left || crop.top || crop.right || crop.bottom) ? { crop } : {}),
        ...(n.locked === true ? { locked: true } : {}),
        ...(parent ? { folder: folderId(name, String(parent.id ?? parent.name ?? '')) } : {}),
      });
    }
    b.scenes.push({ id: '', name, items: out, ...(ourFolders.length ? { folders: ourFolders } : {}) });
  }

  const tr = isObj(c.transitions) ? c.transitions : {};
  const list = Array.isArray(tr.transitions) ? tr.transitions.filter(isObj) : [];
  const def = list.find((t) => t.id === tr.defaultTransitionId) ?? list[0];
  const transition = def ? transitionOf(def.type, def.duration, b, typeof def.name === 'string' ? def.name : undefined, isObj(def.settings) ? def.settings : {}) : null;
  const active = scenes.find((s) => s.id === (isObj(c.scenes) ? c.scenes.activeId : undefined));
  const current = active ? (b.rename.get(`scene:${String(active.name ?? '')}`) ?? null) : null;
  return b.result(ctx.fallbackCanvas, current, transition);
}

/* ------------------------------- profile (basic.ini) ------------------------------- */

/** `[Section]` / `key=value` lines of an OBS ini file. */
export function parseIni(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let section = '';
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const s = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (s) {
      section = s[1];
      out[section] ??= {};
      continue;
    }
    const kv = /^\s*([^=;#][^=]*)=(.*)$/.exec(line);
    // OBS escapes backslashes in its ini files (C:\\Users\\…).
    if (kv && section) out[section][kv[1].trim()] = kv[2].trim().replace(/\\\\/g, '\\');
  }
  return out;
}

/** What an OBS profile says about video and recording, in Studio's settings' terms (only what it can take). */
export function profileSettings(ini: Record<string, Record<string, string>>): { canvas?: { width: number; height: number }; output?: string; fps?: number; recordFolder?: string; recordFormat?: 'mkv' | 'mp4' } {
  const v = ini.Video ?? {};
  const out: ReturnType<typeof profileSettings> = {};
  const bw = Number(v.BaseCX);
  const bh = Number(v.BaseCY);
  if (bw >= 320 && bh >= 180) out.canvas = { width: bw, height: bh };
  const ow = Number(v.OutputCX);
  const oh = Number(v.OutputCY);
  if (ow >= 320 && oh >= 180) out.output = `${ow}x${oh}`;
  const fps = v.FPSType === '1' ? Number(v.FPSInt) : v.FPSType === '2' ? Number(v.FPSNum) / Math.max(1, Number(v.FPSDen)) : Number(String(v.FPSCommon ?? '').split(' ')[0]);
  if (Number.isFinite(fps) && fps > 0) out.fps = fps >= 45 ? 60 : 30;
  const advanced = ini.Output?.Mode === 'Advanced';
  const folder = advanced ? ini.AdvOut?.RecFilePath : ini.SimpleOutput?.FilePath;
  if (folder) out.recordFolder = folder;
  const fmt = (advanced ? ini.AdvOut?.RecFormat2 ?? ini.AdvOut?.RecFormat : ini.SimpleOutput?.RecFormat2 ?? ini.SimpleOutput?.RecFormat) ?? '';
  if (/mp4/i.test(fmt)) out.recordFormat = 'mp4';
  else if (/mkv/i.test(fmt)) out.recordFormat = 'mkv';
  return out;
}

/**
 * The stream destination of OBS's `service.json`: a platform picked from OBS's list (its server is Studio's own for
 * that platform) or a custom server, with the key. null when there is no key or nothing Studio can use.
 */
export function obsService(raw: unknown): { platform: 'twitch' | 'youtube' | 'custom'; server: string | null; key: string } | null {
  const s = isObj(raw) && isObj(raw.settings) ? raw.settings : null;
  if (!s || typeof s.key !== 'string' || !s.key.trim()) return null;
  const service = typeof s.service === 'string' ? s.service.toLowerCase() : '';
  if (service.startsWith('twitch')) return { platform: 'twitch', server: null, key: s.key.trim() };
  if (service.startsWith('youtube')) return { platform: 'youtube', server: null, key: s.key.trim() };
  const server = typeof s.server === 'string' && /^(rtmps?|srt):\/\//i.test(s.server) ? s.server : null;
  return server ? { platform: 'custom', server, key: s.key.trim() } : null;
}
