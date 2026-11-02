import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeControlHotkeys, type ControlHotkeys } from './hotkey';
import { normalizeTextBindings, type TextBinding } from './text-sources';
import { toAppLocale, type LocalePrefs } from './locale';
import { defaultStudioSettings, normalizeStudioKeys, normalizeStudioSettings, type StudioKey, type StudioSettings } from './studio-settings';

export interface ObsConfig {
  host: string;
  port: number;
  password?: string;
}

/** `auto` reads OBS's own WebSocket settings (nothing to type); `manual` uses the values below. */
export interface ObsSettings extends ObsConfig {
  mode: 'auto' | 'manual';
}

export interface Prefs extends LocalePrefs {
  /** Closing the window hides it to the tray instead of quitting. */
  closeToTray: boolean;
  /** Start OBS (if it isn't running) whenever Trigglow starts. */
  openObsOnLaunch: boolean;
  /** Global shortcut that saves OBS's Replay Buffer as a Trigglow clip. */
  clipEnabled: boolean;
  clipHotkey: string;
  /** Replay Buffer length the user picked in Trigglow; null = never chose, leave OBS's own. */
  clipSeconds: number | null;
  /** Global shortcuts for the overlay controls (skip alert, mute, pause, clear, repeat). */
  controlHotkeys: ControlHotkeys;
  /** Live highlight detection (audio + picture activity → automatic clip). */
  autoHighlights: 'off' | 'low' | 'medium' | 'high';
  /** Read League of Legends' local Live Client Data API while live and send kills/objectives/results as stream moments. */
  lolDetect: boolean;
  /** Check for and download app updates in the background (a manual check always works). */
  autoUpdate: boolean;
  /**
   * When clips go up: right away, or kept on this PC and uploaded once OBS stops streaming/recording or closes
   * (no upload bandwidth spent mid-stream, like Medal does when the game closes).
   */
  clipUploadMode: 'now' | 'after_stream';
  /** Largest size the clip is encoded at before upload ('source' keeps OBS's output resolution, e.g. 1440p). FPS is always kept. */
  clipQuality: ClipQuality;
  /** Who can see a new desktop clip. A clip announced in chat is at least unlisted, so its link works. */
  clipVisibility: ClipVisibility;
  /** Title template: {game} (filled by the server from the live category) and {date}. */
  clipTitle: string;
  /** TrigglowBot posts the link in chat when a Stream Deck key asks for the clip. */
  clipAnnounce: boolean;
  /** Chat message template ({link}); empty = the server's default line. */
  clipAnnounceText: string;
  /** Save the replay when the game writes an NVIDIA Highlights video (game-highlights.ts). */
  gameHighlights: boolean;
  /** Where the game writes them; empty = NVIDIA's default temp folder. */
  gameHighlightsDir: string;
  /**
   * Which engine the streamer uses: their own OBS (the bridge, as always) or Trigglow Studio (libobs inside this app,
   * studio.ts). F0: only builds with the engine's binaries can pick 'studio'; the onboarding step and the Settings
   * switch come in F1 (docs/design/trigglow-studio.md).
   */
  engine: 'obs' | 'studio';
  /**
   * The account may use Studio (its staged launch, Admin → Ajustes → studioAudience), as /auth/me said last time:
   * the engine starts before sign-in, so the last answer decides until the next one comes.
   */
  studioAccess: boolean;
}

export const CLIP_QUALITIES = ['source', '1080p', '720p'] as const;
export type ClipQuality = (typeof CLIP_QUALITIES)[number];
export const CLIP_VISIBILITIES = ['private', 'unlisted', 'public'] as const;
export type ClipVisibility = (typeof CLIP_VISIBILITIES)[number];
export const CLIP_TITLE_DEFAULT = '{game} — {date}';
const pick = <T extends string>(list: readonly T[], v: unknown, d: T): T => (list.includes(v as T) ? (v as T) : d);

export interface Config {
  obs: ObsSettings;
  prefs: Prefs;
  /** First-run setup finished (or skipped). */
  onboarded: boolean;
  /** Trigglow data mirrored into OBS text sources. */
  textSources: TextBinding[];
  /** Last window size/position, restored on launch. */
  window?: { x: number; y: number; width: number; height: number; maximized: boolean };
  /** Trigglow Studio's output settings (studio-settings.ts). */
  studio: StudioSettings;
  /** Stream keys pasted into Trigglow Studio; written encrypted with the OS keychain, like the OBS password. */
  studioKeys: StudioKey[];
  /**
   * Studio's profiles, like OBS's: named sets of output settings. The current one's settings are `studio`; the others
   * keep theirs here. A name of '' is the first profile, shown with its default name.
   */
  studioProfiles: StudioProfiles;
}

export interface StudioProfiles {
  current: string;
  list: { id: string; name: string; settings?: StudioSettings }[];
}
const PROFILE_ID = /^(main|prf-[0-9a-f]{12})$/;
function normalizeProfiles(raw: unknown, base: StudioSettings): StudioProfiles {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { current?: unknown; list?: unknown };
  const list: StudioProfiles['list'] = [];
  for (const p of (Array.isArray(r.list) ? r.list : []).slice(0, 50) as { id?: unknown; name?: unknown; settings?: unknown }[]) {
    if (typeof p?.id !== 'string' || !PROFILE_ID.test(p.id) || list.some((x) => x.id === p.id)) continue;
    list.push({ id: p.id, name: typeof p.name === 'string' ? p.name.trim().slice(0, 80) : '', ...(p.settings ? { settings: normalizeStudioSettings(p.settings, base) } : {}) });
  }
  if (!list.length) list.push({ id: 'main', name: '' });
  const current = list.some((p) => p.id === r.current) ? (r.current as string) : list[0].id;
  // The current one's settings live in `studio`, never twice.
  return { current, list: list.map((p) => (p.id === current ? { id: p.id, name: p.name } : p)) };
}

const validWindow = (w: Config['window']) =>
  w && [w.x, w.y, w.width, w.height].every(Number.isFinite) && w.width >= 900 && w.height >= 600 ? w : undefined;

const file = () => path.join(app.getPath('userData'), 'config.json');

const DEFAULT_PROFILES: StudioProfiles = { current: 'main', list: [{ id: 'main', name: '' }] };
const DEFAULT: Config = { obs: { mode: 'auto', host: '127.0.0.1', port: 4455 }, prefs: { closeToTray: process.platform !== 'linux' /* stock GNOME has no tray: closing would "lose" the app */, openObsOnLaunch: false, clipEnabled: true, clipHotkey: 'CommandOrControl+Alt+C', clipSeconds: null, controlHotkeys: {}, autoHighlights: 'off', lolDetect: true, autoUpdate: true, clipUploadMode: 'now', clipQuality: 'source', clipVisibility: 'private', clipTitle: CLIP_TITLE_DEFAULT, clipAnnounce: true, clipAnnounceText: '', gameHighlights: true, gameHighlightsDir: '', engine: 'obs', studioAccess: false, locale: null, localePending: false }, onboarded: false, textSources: [], studio: defaultStudioSettings(''), studioKeys: [], studioProfiles: DEFAULT_PROFILES };

/** The manual OBS WebSocket password is encrypted with the OS keychain (safeStorage) when available. */
export function loadConfig(): Config {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as {
      obs?: { mode?: string; host?: string; port?: number; password?: string; encrypted?: boolean };
      prefs?: Partial<Prefs>;
      onboarded?: boolean;
      textSources?: unknown;
      window?: Config['window'];
      studio?: unknown;
      studioProfiles?: unknown;
      studioKeys?: { id?: string; platform?: string; label?: string; server?: string; key?: string; encrypted?: boolean }[];
    };
    const o = raw.obs ?? {};
    let password: string | undefined;
    try {
      password = o.password ? (o.encrypted ? safeStorage.decryptString(Buffer.from(o.password, 'base64')) : o.password) : undefined;
    } catch {
      // The OS keychain changed (profile restore, new Windows user key): only the OBS password is lost, never the settings.
      console.warn('[config] could not decrypt the OBS password; it has to be entered again');
    }
    return {
      obs: { mode: o.mode === 'manual' ? 'manual' : 'auto', host: o.host || DEFAULT.obs.host, port: o.port || DEFAULT.obs.port, password },
      prefs: {
        closeToTray: raw.prefs?.closeToTray ?? DEFAULT.prefs.closeToTray,
        openObsOnLaunch: raw.prefs?.openObsOnLaunch === true,
        clipEnabled: raw.prefs?.clipEnabled ?? DEFAULT.prefs.clipEnabled,
        clipHotkey: raw.prefs?.clipHotkey ?? DEFAULT.prefs.clipHotkey,
        clipSeconds: typeof raw.prefs?.clipSeconds === 'number' ? raw.prefs.clipSeconds : null,
        controlHotkeys: normalizeControlHotkeys(raw.prefs?.controlHotkeys),
        autoHighlights: raw.prefs?.autoHighlights === 'low' || raw.prefs?.autoHighlights === 'medium' || raw.prefs?.autoHighlights === 'high' ? raw.prefs.autoHighlights : 'off',
        lolDetect: raw.prefs?.lolDetect !== false,
        autoUpdate: raw.prefs?.autoUpdate !== false,
        clipUploadMode: raw.prefs?.clipUploadMode === 'after_stream' ? 'after_stream' : 'now',
        clipQuality: pick(CLIP_QUALITIES, raw.prefs?.clipQuality, 'source'),
        clipVisibility: pick(CLIP_VISIBILITIES, raw.prefs?.clipVisibility, 'private'),
        clipTitle: typeof raw.prefs?.clipTitle === 'string' ? raw.prefs.clipTitle.slice(0, 100) : CLIP_TITLE_DEFAULT,
        clipAnnounce: raw.prefs?.clipAnnounce !== false,
        clipAnnounceText: typeof raw.prefs?.clipAnnounceText === 'string' ? raw.prefs.clipAnnounceText.slice(0, 200) : '',
        gameHighlights: raw.prefs?.gameHighlights !== false,
        gameHighlightsDir: typeof raw.prefs?.gameHighlightsDir === 'string' ? raw.prefs.gameHighlightsDir.slice(0, 500) : '',
        engine: raw.prefs?.engine === 'studio' ? 'studio' : 'obs',
        studioAccess: raw.prefs?.studioAccess === true,
        locale: toAppLocale(raw.prefs?.locale),
        localePending: raw.prefs?.localePending === true && Boolean(toAppLocale(raw.prefs?.locale)),
      },
      onboarded: raw.onboarded === true,
      textSources: normalizeTextBindings(raw.textSources),
      window: validWindow(raw.window),
      studio: normalizeStudioSettings(raw.studio, defaultStudioSettings(defaultRecordFolder())),
      studioKeys: normalizeStudioKeys((Array.isArray(raw.studioKeys) ? raw.studioKeys : []).map((k) => ({ ...k, key: decryptSaved(k?.key, k?.encrypted) }))),
      studioProfiles: normalizeProfiles(raw.studioProfiles, defaultStudioSettings(defaultRecordFolder())),
    };
  } catch {
    return { ...structuredClone(DEFAULT), studio: defaultStudioSettings(defaultRecordFolder()), studioKeys: [], studioProfiles: structuredClone(DEFAULT_PROFILES) };
  }
}

function defaultRecordFolder() {
  try {
    return app.getPath('videos');
  } catch {
    return app.getPath('home');
  }
}

/** A secret written by encrypt(); '' when the OS keychain can no longer read it (that key has to be added again). */
function decryptSaved(value: string | undefined, encrypted: boolean | undefined): string {
  if (!value) return '';
  try {
    return encrypted ? safeStorage.decryptString(Buffer.from(value, 'base64')) : value;
  } catch {
    console.warn('[config] could not decrypt a Studio stream key; it has to be added again');
    return '';
  }
}

/**
 * Encrypts a secret with the OS keychain. Linux without a keyring (Secret Service / KWallet) falls back to a
 * hard-coded key: no real protection, and a later keyring makes it undecryptable. Plain text there, like the
 * no-encryption case.
 */
function encrypt(secret: string | undefined): { value?: string; encrypted: boolean } {
  const weak = process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text';
  const encrypted = Boolean(secret) && !weak && safeStorage.isEncryptionAvailable();
  return { value: secret ? (encrypted ? safeStorage.encryptString(secret).toString('base64') : secret) : undefined, encrypted };
}

export function saveConfig(cfg: Config): void {
  const { mode, password, host, port } = cfg.obs;
  const { value: stored, encrypted } = encrypt(password);
  // Written beside it and renamed over: a crash or a full disk never leaves a half-written config (which would reset
  // every setting). A failed save is logged, not thrown — callers include the window's close handler.
  const tmp = `${file()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ obs: { mode, host, port, password: stored, encrypted }, prefs: cfg.prefs, onboarded: cfg.onboarded, textSources: cfg.textSources, window: cfg.window, studio: cfg.studio, studioProfiles: cfg.studioProfiles, studioKeys: cfg.studioKeys.map((k) => { const { value, encrypted } = encrypt(k.key); return { ...k, key: value, encrypted }; }) }));
    fs.renameSync(tmp, file());
  } catch (err) {
    console.error('[config] save failed:', err instanceof Error ? err.message : err);
  }
}
