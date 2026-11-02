import { isValidAccelerator } from './hotkey';

/**
 * Trigglow Studio's output settings: what the stream and recordings look like and where the stream goes. Saved in the
 * app's config.json (config.ts).
 *
 * Where it goes (`target`), like Streamlabs:
 * - `multistream`: Trigglow's multistream ingest, every enabled channel at once;
 * - `account:youtube` / `account:twitch`: the linked account, its key read by the API right before going live;
 * - a Multistream channel's id (uuid): that channel alone, its key read from the API too;
 * - `key:<id>`: a stream key the streamer pasted here (StudioKey), kept encrypted on this PC only.
 */

export const MULTISTREAM_TARGET = 'multistream';
export const ACCOUNT_TARGETS = ['account:youtube', 'account:twitch'] as const;

/** Pasted stream keys: a platform with a known ingest server, or any server ("custom"). */
export const KEY_PLATFORMS = ['twitch', 'youtube', 'kick', 'tiktok', 'custom'] as const;
export type KeyPlatform = (typeof KEY_PLATFORMS)[number];
/** Servers the streamer doesn't have to copy (the key is theirs); Kick, TikTok and others show theirs with the key. */
export const KEY_SERVERS: Partial<Record<KeyPlatform, string>> = {
  twitch: 'rtmp://live.twitch.tv/app',
  youtube: 'rtmp://a.rtmp.youtube.com/live2',
};

export interface StudioKey {
  id: string;
  platform: KeyPlatform;
  label: string;
  server: string;
  /** In memory only; config.ts writes it encrypted. */
  key: string;
}
export const MAX_KEYS = 20;

/** Output sizes: the canvas follows the screen (up to 4K), and the output is the canvas or smaller (studio.ts). */
export const OUTPUT_SIZES = ['3840x2160', '2560x1440', '1920x1080', '1600x900', '1280x720', '960x540'] as const;
export type OutputSize = (typeof OUTPUT_SIZES)[number];
/** OBS's common frame rates; 29.97 and 59.94 are 30000/1001 and 60000/1001 (fpsOf). */
export const FPS = [24, 25, 29.97, 30, 48, 50, 59.94, 60, 120] as const;
export const RECORD_FORMATS = ['mkv', 'mp4', 'mov', 'flv', 'ts'] as const;
/** OBS's Simple output qualities: share the stream's encode, or a separate one at a quality level. */
export const RECORD_QUALITIES = ['stream', 'high', 'higher', 'lossless'] as const;
export const SPLIT_MODES = ['off', 'time', 'size'] as const;
export const SCALE_FILTERS = ['bilinear', 'bicubic', 'lanczos', 'area'] as const;
export const COLOR_FORMATS = ['NV12', 'I420', 'I444'] as const;
export const COLOR_SPACES = ['601', '709', 'sRGB'] as const;
export const COLOR_RANGES = ['partial', 'full'] as const;
export const SAMPLE_RATES = [44100, 48000] as const;
export const CHANNEL_LAYOUTS = ['mono', 'stereo', '2.1', '4.0', '4.1', '5.1', '7.1'] as const;
export const AUDIO_BITRATES = [64, 96, 128, 160, 192, 224, 256, 320] as const;
/** An encoder's own settings (preset, profile, rate control…), as its properties window saves them: plain values only. */
export type EncoderSettings = Record<string, string | number | boolean>;
export const TRANSITIONS = ['cut', 'fade', 'swipe', 'slide', 'fade_to_color', 'wipe', 'stinger'] as const;
/** The canvas (base resolution): 'auto' follows the main screen (canvasFor); a size keeps that one, like OBS's. */
export const CANVAS_SIZES = ['auto', '3840x2160', '2560x1440', '1920x1080', '1280x720'] as const;
/** The engine process's priority, like OBS's Advanced → Process priority. */
export const PROCESS_PRIORITIES = ['High', 'AboveNormal', 'Normal', 'BelowNormal', 'Idle'] as const;
/** Dynamic Delay: the lowest height the delayed picture keeps (fewer seconds fit in memory when it's higher). */
export const DYN_DELAY_QUALITIES = [480, 720, 1080] as const;
/** Same range as the plugin's filters. */
export const DYN_DELAY_SECONDS = { min: 1, max: 60 };

export interface StudioSettings {
  /** MULTISTREAM_TARGET or the id of one of the streamer's Multistream destinations (a channel). */
  target: string;
  output: OutputSize;
  fps: (typeof FPS)[number];
  scaleFilter: (typeof SCALE_FILTERS)[number];
  colorFormat: (typeof COLOR_FORMATS)[number];
  colorSpace: (typeof COLOR_SPACES)[number];
  colorRange: (typeof COLOR_RANGES)[number];
  /** Audio: needs no stream or recording running to change (libobs resets its audio). */
  sampleRate: (typeof SAMPLE_RATES)[number];
  channels: (typeof CHANNEL_LAYOUTS)[number];
  audioBitrate: (typeof AUDIO_BITRATES)[number];
  /** Where monitored audio plays: 'default' or a device id. */
  monitoringDevice: string;
  /** Windows lowers other apps' volume while a call-like stream runs; OBS lets you turn that off. */
  disableDucking: boolean;
  /** Per encoder id, what its properties window changed (Trigglow keeps the bitrate itself). */
  encoderSettings: Record<string, EncoderSettings>;
  recordQuality: (typeof RECORD_QUALITIES)[number];
  /**
   * OBS's multitrack recording: which of the audio tracks 1–6 the recording keeps, as bits (1 = track 1 only, the
   * usual). More than track 1 records with its own encoder at the stream's settings (the quality setting doesn't apply).
   */
  recordTracks: number;
  /** After an mkv / flv / ts recording ends, also write an mp4 copy (the original stays). */
  remux: boolean;
  splitMode: (typeof SPLIT_MODES)[number];
  splitMinutes: number;
  splitMB: number;
  reconnect: boolean;
  reconnectDelay: number;
  reconnectRetries: number;
  /** Stream delay (OBS's Advanced → Stream delay): seconds, and keep the cut-off point when reconnecting. */
  delay: boolean;
  delaySec: number;
  delayPreserve: boolean;
  /** Network: the local IP to send from ('default' = any), dynamic bitrate, low-latency mode, new networking code. */
  bindIP: string;
  dynamicBitrate: boolean;
  lowLatency: boolean;
  networkOptimizations: boolean;
  processPriority: (typeof PROCESS_PRIORITIES)[number];
  /** The engine runs as `obs64.exe`, so Discord sees streaming software and its automatic streamer mode turns on. */
  discordStreamerMode: boolean;
  /** A libobs encoder id, or 'auto' (hardware first: NVENC, AMF, Quick Sync, then x264). */
  encoder: string;
  /** Video bitrate in kbps. */
  bitrate: number;
  recordFolder: string;
  recordFormat: (typeof RECORD_FORMATS)[number];
  transition: (typeof TRANSITIONS)[number];
  transitionMs: number;
  /** Stinger: the video file played over the cut, and when (ms into it) the scene switches. */
  stingerFile: string;
  stingerPointMs: number;
  canvas: (typeof CANVAS_SIZES)[number];
  /** Global shortcuts (Electron accelerators) that start/stop the stream and the recording; '' = none. */
  hotkeyStream: string;
  hotkeyRecord: string;
  /**
   * Trigglow Dynamic Delay (the plugin's own controller inside the engine, studio.ts): how many seconds behind the
   * stream goes without reconnecting, the picture's lowest height, the live scene that goes out delayed (a scene id,
   * required to turn it on; '' = none chosen yet), the scene shown while the delay fills ('' = keep the current one; a
   * scene id), the "Delay Ns" badge and its corner (0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right).
   */
  dynDelaySeconds: number;
  dynDelayQuality: (typeof DYN_DELAY_QUALITIES)[number];
  dynDelayLive: string;
  dynDelayLoading: string;
  dynDelayBadge: boolean;
  dynDelayCorner: number;
  hotkeyDelay: string;
  /** Custom browser docks (OBS's Docks → Custom browser docks): a web page next to the editor. https only. */
  customDocks: CustomDock[];
}

export interface CustomDock {
  id: string;
  name: string;
  url: string;
}
export const MAX_CUSTOM_DOCKS = 20;

/** A dock's address: https only, no credentials in it. */
export function validDockUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 1000) return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

function cleanDocks(raw: unknown, base: CustomDock[]): CustomDock[] {
  if (!Array.isArray(raw)) return base;
  const out: CustomDock[] = [];
  for (const d of raw.slice(0, MAX_CUSTOM_DOCKS) as Partial<CustomDock>[]) {
    const url = validDockUrl(d?.url);
    const name = typeof d?.name === 'string' ? d.name.trim().slice(0, 60) : '';
    if (!url || !name || typeof d.id !== 'string' || !/^dock-[0-9a-f]{8}$/.test(d.id) || out.some((x) => x.id === d.id)) continue;
    out.push({ id: d.id, name, url });
  }
  return out;
}

export const BITRATE = { min: 500, max: 50_000 };
export const TRANSITION_MS = { min: 50, max: 5000 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_ID = /^[a-z0-9]{8}$/;

/** A target string that can be saved (whether it still exists is checked when going live). */
export function validTarget(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  if (v === MULTISTREAM_TARGET || (ACCOUNT_TARGETS as readonly string[]).includes(v) || UUID.test(v)) return true;
  return v.startsWith('key:') && KEY_ID.test(v.slice(4));
}

export function defaultStudioSettings(recordFolder: string): StudioSettings {
  return {
    target: MULTISTREAM_TARGET,
    output: '1920x1080',
    fps: 60,
    scaleFilter: 'bicubic',
    colorFormat: 'NV12',
    colorSpace: '709',
    colorRange: 'partial',
    sampleRate: 48000,
    channels: 'stereo',
    audioBitrate: 160,
    monitoringDevice: 'default',
    disableDucking: false,
    encoderSettings: {},
    recordQuality: 'stream',
    recordTracks: 1,
    remux: true,
    splitMode: 'off',
    splitMinutes: 15,
    splitMB: 2048,
    reconnect: true,
    reconnectDelay: 2,
    reconnectRetries: 25,
    delay: false,
    delaySec: 20,
    delayPreserve: true,
    bindIP: 'default',
    dynamicBitrate: false,
    lowLatency: false,
    networkOptimizations: false,
    processPriority: 'Normal',
    discordStreamerMode: true,
    encoder: 'auto',
    bitrate: 6000,
    recordFolder,
    recordFormat: 'mkv', // survives a crash or a power cut, unlike an unfinished mp4
    transition: 'fade',
    transitionMs: 300,
    stingerFile: '',
    stingerPointMs: 500,
    canvas: 'auto',
    hotkeyStream: '',
    hotkeyRecord: '',
    dynDelaySeconds: 10,
    dynDelayQuality: 720,
    dynDelayLive: '',
    dynDelayLoading: '',
    dynDelayBadge: true,
    dynDelayCorner: 0,
    hotkeyDelay: '',
    customDocks: [],
  };
}

const pick = <T>(list: readonly T[], v: unknown, d: T): T => (list.includes(v as T) ? (v as T) : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

/** Encoder settings from disk or the page: encoder ids → plain values only, bounded. */
export function cleanEncoderSettings(raw: unknown): Record<string, EncoderSettings> {
  const out: Record<string, EncoderSettings> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, s] of Object.entries(raw).slice(0, 20)) {
    if (!/^[a-z0-9_]{1,64}$/.test(id) || !s || typeof s !== 'object' || Array.isArray(s)) continue;
    const kept: EncoderSettings = {};
    for (const [k, v] of Object.entries(s).slice(0, 100)) {
      if (!/^[\w.-]{1,64}$/.test(k)) continue;
      if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 500)) kept[k] = v;
    }
    out[id] = kept;
  }
  return out;
}

/** A frame rate as libobs wants it: numerator / denominator (29.97 = 30000/1001). */
export function fpsOf(fps: number): { num: number; den: number } {
  return Number.isInteger(fps) ? { num: fps, den: 1 } : { num: Math.round(fps * 1001 / 1000) * 1000, den: 1001 };
}
const clamp = (v: unknown, r: { min: number; max: number }, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(r.max, Math.max(r.min, v))) : d);
/** '' clears a shortcut; anything else must be a valid accelerator, or the previous one stays. */
/** A scene id ('' = none). */
const sceneId = (v: unknown, d: string) => (v === '' || (typeof v === 'string' && /^scn-[0-9a-f]{12}$/.test(v)) ? (v as string) : d);
const hotkey = (v: unknown, d: string) => (v === '' ? '' : typeof v === 'string' && isValidAccelerator(v.trim()) ? v.trim() : d);

/** An rtmp(s)/srt URL with no credentials in it, or null. Servers from the API are checked again before use. */
export function validServer(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 500) return null;
  try {
    const url = new URL(v.trim());
    return ['rtmp:', 'rtmps:', 'srt:'].includes(url.protocol) && !url.username && !url.password ? v.trim() : null;
  } catch {
    return null;
  }
}

/** Keeps only valid values from saved or submitted settings, filling the rest from `base`. */
export function normalizeStudioSettings(raw: unknown, base: StudioSettings): StudioSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof StudioSettings, unknown>>;
  return {
    target: validTarget(r.target) ? r.target : base.target,
    output: pick(OUTPUT_SIZES, r.output, base.output),
    fps: pick(FPS, r.fps, base.fps),
    scaleFilter: pick(SCALE_FILTERS, r.scaleFilter, base.scaleFilter),
    colorFormat: pick(COLOR_FORMATS, r.colorFormat, base.colorFormat),
    colorSpace: pick(COLOR_SPACES, r.colorSpace, base.colorSpace),
    colorRange: pick(COLOR_RANGES, r.colorRange, base.colorRange),
    sampleRate: pick(SAMPLE_RATES, r.sampleRate, base.sampleRate),
    channels: pick(CHANNEL_LAYOUTS, r.channels, base.channels),
    audioBitrate: pick(AUDIO_BITRATES, r.audioBitrate, base.audioBitrate),
    monitoringDevice: typeof r.monitoringDevice === 'string' && r.monitoringDevice.length > 0 && r.monitoringDevice.length <= 300 ? r.monitoringDevice : base.monitoringDevice,
    disableDucking: bool(r.disableDucking, base.disableDucking),
    encoderSettings: r.encoderSettings === undefined ? base.encoderSettings : cleanEncoderSettings(r.encoderSettings),
    recordQuality: pick(RECORD_QUALITIES, r.recordQuality, base.recordQuality),
    recordTracks: clamp(r.recordTracks, { min: 1, max: 63 }, base.recordTracks),
    remux: bool(r.remux, base.remux),
    splitMode: pick(SPLIT_MODES, r.splitMode, base.splitMode),
    splitMinutes: clamp(r.splitMinutes, { min: 1, max: 24 * 60 }, base.splitMinutes),
    splitMB: clamp(r.splitMB, { min: 50, max: 1_000_000 }, base.splitMB),
    reconnect: bool(r.reconnect, base.reconnect),
    reconnectDelay: clamp(r.reconnectDelay, { min: 1, max: 30 }, base.reconnectDelay),
    reconnectRetries: clamp(r.reconnectRetries, { min: 1, max: 10_000 }, base.reconnectRetries),
    delay: bool(r.delay, base.delay),
    delaySec: clamp(r.delaySec, { min: 1, max: 1800 }, base.delaySec),
    delayPreserve: bool(r.delayPreserve, base.delayPreserve),
    bindIP: r.bindIP === 'default' || (typeof r.bindIP === 'string' && /^[0-9a-f.:%\w-]{2,64}$/i.test(r.bindIP)) ? (r.bindIP as string) : base.bindIP,
    dynamicBitrate: bool(r.dynamicBitrate, base.dynamicBitrate),
    lowLatency: bool(r.lowLatency, base.lowLatency),
    networkOptimizations: bool(r.networkOptimizations, base.networkOptimizations),
    processPriority: pick(PROCESS_PRIORITIES, r.processPriority, base.processPriority),
    discordStreamerMode: bool(r.discordStreamerMode, base.discordStreamerMode),
    encoder: typeof r.encoder === 'string' && /^[a-z0-9_]{1,64}$/.test(r.encoder) ? r.encoder : base.encoder,
    bitrate: clamp(r.bitrate, BITRATE, base.bitrate),
    recordFolder: typeof r.recordFolder === 'string' && r.recordFolder.trim() && r.recordFolder.length <= 1000 ? r.recordFolder.trim() : base.recordFolder,
    recordFormat: pick(RECORD_FORMATS, r.recordFormat, base.recordFormat),
    transition: pick(TRANSITIONS, r.transition, base.transition),
    transitionMs: clamp(r.transitionMs, TRANSITION_MS, base.transitionMs),
    stingerFile: r.stingerFile === '' ? '' : typeof r.stingerFile === 'string' && r.stingerFile.trim() && r.stingerFile.length <= 1000 ? r.stingerFile.trim() : base.stingerFile,
    stingerPointMs: clamp(r.stingerPointMs, { min: 0, max: 30_000 }, base.stingerPointMs),
    canvas: pick(CANVAS_SIZES, r.canvas, base.canvas),
    hotkeyStream: hotkey(r.hotkeyStream, base.hotkeyStream),
    hotkeyRecord: hotkey(r.hotkeyRecord, base.hotkeyRecord),
    dynDelaySeconds: clamp(r.dynDelaySeconds, DYN_DELAY_SECONDS, base.dynDelaySeconds),
    dynDelayQuality: pick(DYN_DELAY_QUALITIES, r.dynDelayQuality, base.dynDelayQuality),
    dynDelayLive: sceneId(r.dynDelayLive, base.dynDelayLive),
    dynDelayLoading: sceneId(r.dynDelayLoading, base.dynDelayLoading),
    dynDelayBadge: bool(r.dynDelayBadge, base.dynDelayBadge),
    dynDelayCorner: clamp(r.dynDelayCorner, { min: 0, max: 3 }, base.dynDelayCorner),
    hotkeyDelay: hotkey(r.hotkeyDelay, base.hotkeyDelay),
    customDocks: cleanDocks(r.customDocks, base.customDocks),
  };
}

export function outputSize(s: StudioSettings) {
  const [width, height] = s.output.split('x').map(Number);
  return { width, height };
}

/** A stream key as pasted: printable, no spaces, at most 512 characters. */
export function validKey(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const key = v.trim();
  return /^[\x21-\x7e]{1,512}$/.test(key) ? key : null;
}

/** A new pasted key, checked; the server comes from the platform when it has a fixed one. Null when something's off. */
export function newStudioKey(raw: { platform?: unknown; label?: unknown; server?: unknown; key?: unknown }, id: string): StudioKey | null {
  const platform = KEY_PLATFORMS.includes(raw.platform as KeyPlatform) ? (raw.platform as KeyPlatform) : null;
  if (!platform || !KEY_ID.test(id)) return null;
  const server = KEY_SERVERS[platform] ?? validServer(raw.server);
  const key = validKey(raw.key);
  if (!server || !key) return null;
  const label = typeof raw.label === 'string' ? raw.label.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) : '';
  return { id, platform, label, server, key };
}

/** Saved keys read back from disk: only well-formed ones, at most MAX_KEYS, no duplicate ids. */
export function normalizeStudioKeys(raw: unknown): StudioKey[] {
  if (!Array.isArray(raw)) return [];
  const out: StudioKey[] = [];
  for (const k of raw.slice(0, MAX_KEYS)) {
    const id = typeof k?.id === 'string' ? k.id : '';
    if (out.some((x) => x.id === id)) continue;
    const key = newStudioKey({ ...k, server: k?.server }, id);
    if (key) out.push(key);
  }
  return out;
}
