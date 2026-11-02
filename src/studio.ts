/**
 * Trigglow Studio (docs/design/trigglow-studio.md): OBS's engine (libobs) running inside this app through Streamlabs'
 * obs-studio-node (OSN, GPL-2.0), so a streamer can go live without OBS installed. OSN runs libobs in its own process
 * (obs64.exe) and draws the preview straight into a native child window of ours.
 *
 * The engine is rebuilt on every start from the saved scene collection (studio-scenes.ts, <dataDir>/scenes.json),
 * and every edit made in the Studio page (scenes, sources, mixer, source properties) is saved back. The binaries are
 * not bundled: `pnpm studio:fetch` puts them in vendor/obs-studio-node, and Studio only exists in builds that have them.
 */
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { overlayPlacement, scalePlacement } from './overlay-layout';
import { boxOf, cleanPropertyValue, propertyKind, type StudioProperty } from './studio-props';
import {
  AUDIO_FILTERS,
  alertsSize,
  VIDEO_FILTERS,
  cropOf,
  newId,
  ownBrand,
  parseLocaleIni,
  sceneContains,
  SOURCE_TYPES,
  TRIGGLOW_OVERLAYS,
  TRIGGLOW_SCENE_OVERLAYS,
  centred,
  cleanName,
  defaultCollection,
  normalizeCollection,
  rescaleCollection,
  uniqueName,
  type Crop,
  type Collection,
  type DefaultNames,
  type SavedFilter,
  type SavedFolder,
  cleanHotkeys,
  isHeldHotkey,
  type SceneTransition,
  type SavedItem,
  type SavedSource,
  type SourceType,
  type TrigglowOverlay,
} from './studio-scenes';
import { FPS, OUTPUT_SIZES, TRANSITIONS, fpsOf, outputSize, type EncoderSettings, type StudioSettings } from './studio-settings';

export const OSN_DIR = path.resolve(__dirname, '../vendor/obs-studio-node');

export { ALERTS_SIZE, CANVAS, canvasFor, centred } from './studio-scenes';
export type { StudioProperty } from './studio-props';

/**
 * Studio's transition → libobs's id and settings. A stinger without a file to play falls back to a fade.
 */
export function transitionOf(s: Pick<StudioSettings, 'transition' | 'stingerFile' | 'stingerPointMs'>): [string, string, Settings] {
  const name = 'Trigglow transition';
  switch (s.transition) {
    case 'cut':
      return ['cut_transition', name, {}];
    case 'swipe':
    case 'slide':
    case 'wipe':
    case 'fade_to_color':
      return [`${s.transition}_transition`, name, {}];
    case 'stinger':
      if (s.stingerFile) return ['obs_stinger_transition', name, { path: s.stingerFile, transition_point_type: 0, transition_point: s.stingerPointMs }];
      return ['fade_transition', name, {}];
    default:
      return ['fade_transition', name, {}];
  }
}

/** Studio's settings → libobs's video and audio values (OSN enums EScaleType, EVideoFormat, EColorSpace, ERangeType, ESpeakerLayout). */
const SCALE_TYPES = { bilinear: 3, bicubic: 2, lanczos: 4, area: 5 } as const;
const VIDEO_FORMATS = { NV12: 2, I420: 1, I444: 10 } as const;
const COLOR_SPACES = { '601': 1, '709': 2, sRGB: 3 } as const;
const COLOR_RANGES = { partial: 1, full: 2 } as const;
const SPEAKERS = { mono: 1, stereo: 2, '2.1': 3, '4.0': 4, '4.1': 5, '5.1': 6, '7.1': 8 } as const;
const RECORD_QUALITY = { stream: 0, high: 1, higher: 2, lossless: 3 } as const;
/** Settings that need no stream or recording running (they rebuild the video or audio pipeline). */
const PIPELINE_KEYS = ['output', 'fps', 'encoder', 'bitrate', 'scaleFilter', 'colorFormat', 'colorSpace', 'colorRange', 'sampleRate', 'channels', 'audioBitrate', 'encoderSettings', 'recordQuality', 'recordTracks', 'reconnect', 'reconnectDelay', 'reconnectRetries', 'delay', 'delaySec', 'delayPreserve', 'bindIP', 'dynamicBitrate', 'lowLatency', 'networkOptimizations'] as const;

/** Encoders in order of preference: NVIDIA (texture path, no copy back to RAM), AMD, Intel, then software. */
const ENCODERS = ['obs_nvenc_h264_tex', 'jim_nvenc', 'h264_texture_amf', 'amd_amf_h264', 'obs_qsv11_v2', 'obs_qsv11', 'obs_x264'];

/** HEVC and AV1, offered where the PC has them but never picked by 'auto': not every platform takes them. */
const MODERN_ENCODERS = ['obs_nvenc_hevc_tex', 'jim_hevc_nvenc', 'h265_texture_amf', 'obs_qsv11_hevc', 'obs_nvenc_av1_tex', 'jim_av1_nvenc', 'av1_texture_amf', 'obs_qsv11_av1', 'obs_x265', 'ffmpeg_svt_av1', 'ffmpeg_aom_av1'];

export function pickEncoder(available: string[]): string {
  return ENCODERS.find((id) => available.includes(id)) ?? 'obs_x264';
}

/** OBS's own locale names (libobs ships its strings as e.g. es-ES.ini); Valencian uses the Catalan ones. */
const OBS_LOCALES: Record<string, string> = {
  en: 'en-US', es: 'es-ES', 'pt-BR': 'pt-BR', zh: 'zh-CN', fr: 'fr-FR', it: 'it-IT', de: 'de-DE', ru: 'ru-RU', ko: 'ko-KR',
  ja: 'ja-JP', hi: 'hi-IN', ca: 'ca-ES', 'ca-valencia': 'ca-ES', eu: 'eu-ES', gl: 'gl-ES', uk: 'uk-UA',
};
export const obsLocale = (appLocale: string) => OBS_LOCALES[appLocale] ?? 'en-US';

/**
 * PIDs of `obs64.exe` processes running from `dir` whose app is gone, from `Win32_Process` rows of
 * "<pid>|<path>|<parent pid>". One whose parent still runs (another app or test using its own engine) stays.
 */
export function strayEnginePids(rows: string, dir: string, parentAlive: (pid: number) => boolean = () => false): number[] {
  const exe = path.join(dir, 'obs64.exe').toLowerCase();
  return rows
    .split(/\r?\n/)
    .map((line) => line.split('|'))
    .filter(([pid, p, parent]) => /^\d+$/.test(pid ?? '') && (p ?? '').trim().toLowerCase() === exe && !(/^\d+$/.test((parent ?? '').trim()) && parentAlive(Number(parent))))
    .map(([pid]) => Number(pid));
}

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Engines left behind by a crash or a killed app (they keep running without us). Only our own copy in vendor/: the
 * streamer's OBS is also obs64.exe and must never be touched. [] when they can't be listed.
 */
function enginePids(): number[] {
  try {
    const rows = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='obs64.exe'\" | ForEach-Object { \"$($_.ProcessId)|$($_.ExecutablePath)|$($_.ParentProcessId)\" }"],
      { encoding: 'utf8', timeout: 8000, windowsHide: true },
    );
    return strayEnginePids(rows, OSN_DIR, processAlive);
  } catch (err) {
    console.warn('[studio] could not list engine processes', err);
    return [];
  }
}

function killStrayEngine() {
  for (const pid of enginePids()) {
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
  }
}


// The slice of OSN's API this file uses (vendor/obs-studio-node/module.d.ts has the rest).
type Settings = Record<string, unknown>;
interface Property {
  readonly name: string;
  readonly description: string;
  readonly longDescription?: string;
  readonly type: number;
  readonly value: unknown;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly details?: { items?: { name: string; value: string | number }[]; min?: number; max?: number; step?: number; type?: number; filter?: string; defaultPath?: string };
  next(): Property | null;
  is_last(): boolean;
  buttonClicked?(source: object): void;
}
interface Configurable {
  readonly settings: Settings;
  readonly properties: { first(): Property | null } | null;
  update(settings: Settings): void;
}
interface Filter extends Configurable {
  readonly name: string;
  readonly id: string;
  enabled: boolean;
  release(): void;
}
interface Input extends Configurable {
  name: string;
  readonly id: string;
  readonly width: number;
  readonly height: number;
  muted: boolean;
  flags: number;
  monitoringType: number;
  /** Audio tracks 1–6 as bits. */
  audioMixers: number;
  syncOffset: { sec: number; nsec: number };
  readonly filters: Filter[];
  addFilter(filter: Filter): void;
  removeFilter(filter: Filter): void;
  /** 0 up, 1 down, 2 top, 3 bottom. */
  setFilterOrder(filter: Filter, movement: number): void;
  remove(): void;
  release(): void;
}
/** OSN's ESourceFlags.ForceMono. */
const FORCE_MONO = 2;
/** Volume goes through a fader: OSN's `input.volume` reads back 0 (seen 2026-11-01), so Streamlabs uses faders too. */
interface Fader {
  mul: number;
  deflection: number;
  db: number;
  attach(source: Input): void;
  detach(): void;
  destroy(): void;
}
interface Volmeter {
  attach(source: Input): void;
  detach(): void;
  destroy(): void;
}
interface SceneItem {
  readonly id: number;
  readonly source: Input;
  selected: boolean;
  visible: boolean;
  position: { x: number; y: number };
  scale: { x: number; y: number };
  bounds: { x: number; y: number };
  boundsType: number;
  rotation: number;
  crop: Crop;
  /** These reorder in the engine, but OSN's own list (getItems) keeps the old order: use reorder() instead. */
  moveTop(): void;
  remove(): void;
}
interface Scene {
  /** The engine name (an id, see newId). */
  readonly name: string;
  /** The scene as a source, to show it inside another scene. */
  readonly source: Input;
  add(source: Input): SceneItem;
  getItems(): SceneItem[];
  /** Positions counted from the top of the list (0 = drawn over the rest); OSN's list follows it. */
  moveItem(oldIndex: number, newIndex: number): void;
  remove(): void;
  release(): void;
}
interface Video {
  video: Record<string, number>;
  readonly skippedFrames: number;
  readonly encodedFrames: number;
  destroy(): void;
}
type OutputSignal = { type: string; signal: string; code: number; error: string };
interface Network {
  bindIP: string;
  readonly networkInterfaces: Record<string, string>;
  enableDynamicBitrate: boolean;
  enableOptimizations: boolean;
  enableLowLatency: boolean;
}
interface Delay {
  enabled: boolean;
  delaySec: number;
  preserveDelay: boolean;
}
interface VideoEncoder extends Configurable {
  release(): void;
}
interface Streaming {
  delay: Delay;
  network: Network;
  video: Video;
  service: unknown;
  videoEncoder: unknown;
  audioEncoder: { bitrate: number };
  reconnect: { enabled: boolean; retryDelay: number; maxRetries: number };
  signalHandler: (s: OutputSignal) => void;
  start(): void;
  stop(force?: boolean): void;
  readonly droppedFrames: number;
  readonly totalFrames: number;
  readonly kbitsPerSec: number;
  readonly dataOutput: number;
}
interface ReplayBuffer {
  streaming: Streaming;
  recording: Recording;
  video: Video;
  path: string;
  format: string;
  prefix: string;
  duration: number;
  usesStream: boolean;
  overwrite: boolean;
  noSpace: boolean;
  signalHandler: (s: OutputSignal) => void;
  lastFile(): string;
  start(): void;
  stop(force?: boolean): void;
  save(): void;
}
interface AdvancedRecording extends Omit<Recording, 'streaming' | 'quality' | 'audioEncoder'> {
  mixer: number;
  useStreamEncoders: boolean;
  rescaling: boolean;
}
interface Recording {
  streaming: Streaming;
  video: Video;
  videoEncoder: VideoEncoder;
  enableFileSplit: boolean;
  splitType: number;
  splitTime: number;
  splitSize: number;
  path: string;
  format: string;
  quality: number;
  audioEncoder: { bitrate: number };
  overwrite: boolean;
  noSpace: boolean;
  signalHandler: (s: OutputSignal) => void;
  lastFile(): string;
  start(): void;
  stop(force?: boolean): void;
}
interface Transition {
  set(source: Scene | Input): void;
  /** What it shows now (null when nothing). */
  getActiveSource(): Input | null;
  start(ms: number, source: Scene): void;
  release(): void;
}
interface Osn {
  IPC: { host(uri: string): number; disconnect(): void };
  NodeObs: Record<string, (...args: unknown[]) => unknown>;
  Global: {
    setOutputSource(channel: number, source: unknown): void;
    readonly cpuPercentage: number;
    readonly memoryUsage: number;
    readonly currentFrameRate: number;
    readonly averageFrameRenderTime: number;
    readonly laggedFrames: number;
    readonly totalFrames: number;
  };
  VideoFactory: { create(): Video };
  InputFactory: { create(id: string, name: string, settings?: Settings): Input; createPrivate(id: string, name: string, settings?: Settings): Input; types(): string[] };
  SceneFactory: { create(name: string): Scene; fromName(name: string): Scene };
  FilterFactory: { create(id: string, name: string, settings?: Settings): Filter; types(): string[] };
  TransitionFactory: { create(id: string, name: string, settings?: Settings): Transition };
  ReconnectFactory: { create(): Streaming['reconnect'] };
  DelayFactory: { create(): Delay };
  NetworkFactory: { create(): Network };
  Audio: {
    audioContext: { sampleRate: number; speakers: number };
    monitoringDevice: { name: string; id: string };
    readonly monitoringDevices: { name: string; id: string }[];
    disableAudioDucking: boolean;
  };
  SimpleRecordingFactory: { create(): Recording; destroy(r: Recording): void };
  AdvancedRecordingFactory: { create(): AdvancedRecording; destroy(r: AdvancedRecording): void };
  AudioTrackFactory: { create(bitrate: number, name: string): unknown; setAtIndex(track: unknown, index: number): void };
  SimpleReplayBufferFactory: { create(): ReplayBuffer; destroy(r: ReplayBuffer): void };
  FaderFactory: { create(type: number): Fader };
  VolmeterFactory: { create(type: number): Volmeter };
  VideoEncoderFactory: { types(): string[]; create(id: string, name: string, settings?: Settings): VideoEncoder };
  AudioEncoderFactory: { create(id: string, name: string): { bitrate: number } };
  ServiceFactory: { create(id: string, name: string, settings?: Settings): unknown };
  SimpleStreamingFactory: { create(): Streaming; destroy(s: Streaming): void };
}

export interface StudioStats {
  fps: number;
  renderMs: number;
  laggedFrames: number;
  skippedFrames: number;
  engineCpu: number;
  engineMemMB: number;
  streaming: boolean;
  recording: boolean;
  droppedFrames: number;
  kbps: number;
  delay: DelayView;
}

/**
 * OBS's Stats window: frames missed by rendering (lagged), by encoding (skipped) and by the network (dropped), each
 * out of its total, plus CPU, memory, free disk and what the stream and the recording are writing (MB).
 */
export interface StudioPerf {
  fps: number;
  renderMs: number;
  cpu: number;
  memoryMB: number;
  diskFree: string;
  lagged: number;
  rendered: number;
  skipped: number;
  encoded: number;
  dropped: number;
  sent: number;
  streaming: boolean;
  recording: boolean;
  streamKbps: number;
  streamMB: number;
  recordKbps: number;
  recordMB: number;
}

/** Trigglow Dynamic Delay, for the Studio bar: off, filling (until `endsAt`, epoch ms) or on, `effective` seconds behind. */
export interface DelayView {
  available: boolean;
  state: 'off' | 'filling' | 'on';
  /** Asked, and really applied (fewer when they don't fit in memory, like the plugin's "FillingTrimmed"). */
  seconds: number;
  effective: number;
  endsAt: number | null;
  /** The buffer stepped down to keep up (the plugin dock's "buffer quality reduced"); null = full quality. */
  health: DelayHealth | null;
  /** Why it turned itself off (`collection_changed`), until the next start. */
  message: string | null;
}

/** The plugin's pipeline health (get_pipeline_state), as the core publishes it. `cause`: 1 graphics, 2 encode, 3 decode. */
export interface DelayHealth {
  level: number;
  width: number;
  height: number;
  fullWidth: number;
  fullHeight: number;
  captureFps: number;
  outputFps: number;
  cause: number;
  droppedPerMinute: number;
  repeatedPerMinute: number;
}

/** A stream or recording event, for the Studio page (`file`: the recording just finished). */
export type StreamSignal = { output: 'stream' | 'record' | 'replay' | 'delay'; signal: string; code: number; error: string; file?: string };

/** What the Studio page draws: scenes, the current scene's items (top first, like OBS's list) and the mixer. */
export interface StudioView {
  scenes: string[];
  current: string;
  /**
   * `box`: where the item sits on the canvas (its bounding box), for picking and dragging it on the preview. `type`
   * 'scene' = another scene shown inside this one. `rotated` items can be moved but not resized by dragging.
   */
  items: { id: number; source: string; type: string; visible: boolean; selected: boolean; locked: boolean; rotated: boolean; box: { x: number; y: number; width: number; height: number }; trigglow?: TrigglowOverlay; folder?: string }[];
  /** The current scene's folders in the source list, and its own transition (null = the one in Settings). */
  folders: SavedFolder[];
  transition: SceneTransition | null;
  /** Studio mode on, and the scene program shows (the current one when it's off). */
  studioMode: boolean;
  program: string;
  /** `volume` is the fader position, 0..1 (IEC curve, like OBS's mixer). `monitoring`: 0 off, 1 monitor only, 2 monitor and output. */
  audio: { name: string; volume: number; muted: boolean; monitoring: number }[];
  /** The canvas size every `box` is in. */
  canvas: { width: number; height: number };
}

/** A filter on a source, for the properties panel; `available` lists what can be added to that source. */
export interface StudioFilters {
  filters: { name: string; type: string; enabled: boolean }[];
  available: { type: string; label: string }[];
}

/** The Dynamic Delay plugin's filters (its core build, `pnpm studio:delay`). */
const DELAY_VIDEO = 'trigglow_video_delay_filter';
const DELAY_AUDIO = 'trigglow_audio_delay_filter';
/** Its controller, which Studio drives (the plugin's core-host.hpp). */
const DELAY_CONTROLLER = 'trigglow_delay_controller';

const AUDIO_TYPES = new Set(['wasapi_input_capture', 'wasapi_output_capture', 'wasapi_process_output_capture', 'ffmpeg_source', 'browser_source', 'dshow_input', 'game_capture']);

/** Settings a newly added source starts with (libobs fills in the rest). */
const NEW_SOURCE_SETTINGS: Partial<Record<SourceType, Settings>> = {
  game_capture: { capture_mode: 'any_fullscreen' },
  monitor_capture: { monitor: 0 },
  wasapi_input_capture: { device_id: 'default' },
  wasapi_output_capture: { device_id: 'default' },
  browser_source: { url: 'https://trigglow.com', width: 800, height: 600 },
  text_gdiplus_v3: { text: 'Trigglow' },
};
const FILLS_CANVAS = new Set(['game_capture', 'monitor_capture', 'window_capture']);

export class StudioEngine {
  private osn: Osn | null = null;
  private video: Video | null = null;
  private settings!: StudioSettings;
  /** The canvas (base resolution): follows the screen, see canvasFor(). Outputs are this size or smaller. */
  private canvas = { width: 1920, height: 1080 };
  private transition: Transition | null = null;
  private output: Streaming | null = null;
  private outputEncoder = '';
  private recorder: Recording | null = null;
  /** The multitrack recording (Advanced output), when the recording keeps more than audio track 1. */
  private multitrack: Recording | null = null;
  /** The one recording now (simple or multitrack). */
  private activeRecorder: Recording | null = null;
  private streaming = false;
  private recording = false;
  private replay: ReplayBuffer | null = null;
  /** The replay buffer is running (clips save its last `replaySeconds`). */
  replayActive = false;
  replaySeconds = 30;
  /** Saves waiting for the buffer's "wrote" signal (the file path; null = it failed). */
  private replayWaiters: ((file: string | null) => void)[] = [];
  /** Stream and recording events go here (main.ts forwards them to the Studio page). */
  onSignal: ((s: StreamSignal) => void) | null = null;
  private display: string | null = null;
  private file = '';
  private dataDir = '';
  /** The starter collection's names (the app's language), for new collections. */
  private names: DefaultNames | null = null;
  private collection: Collection | null = null;
  private readonly inputs = new Map<string, Input>();
  private readonly scenes = new Map<string, Scene>();
  private readonly faders = new Map<string, Fader>();
  private readonly volmeters = new Map<string, Volmeter>();
  /** Engine name (id) → the streamer's name, for sources and scenes. */
  private readonly displayOf = new Map<string, string>();
  /** Locked items, as `<scene id>#<item id>`. */
  private readonly locked = new Set<string>();
  /** The folder each item is listed in, by `<scene id>#<item id>`. */
  private readonly folderOf = new Map<string, string>();
  /** What the program transition is now ('default' or a scene's override), so it's only rebuilt when that changes. */
  private transitionKey = 'default';
  /** Studio mode: what program shows while the editor works on another scene (null = off: program is the current scene). */
  private programScene: Scene | null = null;
  private studioMode = false;
  /**
   * What the editor's preview shows: an engine-only scene holding the current scene. Always the scene being edited,
   * live, even when program is something else (studio mode) or seconds behind (Dynamic Delay).
   */
  private editWrap: Scene | null = null;
  /** Studio mode's program view, and the projectors (by key), as engine display names. */
  private programDisplay: string | null = null;
  /** The preview's displays made so far (program view, editor view), the window and the place they go. */
  private readonly displays = new Set<string>();
  private previewHandle: Buffer | null = null;
  private previewRect: { x: number; y: number; width: number; height: number } | null = null;
  private readonly projectors = new Map<string, string>();
  /** Audio levels for the mixer's meters, by source name (dB, −100 = silence). main.ts forwards them to the page. */
  onLevels: ((levels: Record<string, number>) => void) | null = null;
  /** The program scene changed, or a source was (un)muted: for automations (studio-link.ts). */
  onScene: ((name: string) => void) | null = null;
  onMute: ((name: string, muted: boolean) => void) | null = null;
  private overlayBase: string | null = null;
  private locale = 'en';
  private enginePid: number | null = null;
  private crashed = false;
  private filterNames: Map<string, string> | null = null;
  private callbacksOn = false;
  /** The sample rate and channels the engine runs with (they change on restart only). */
  startedAudio: { sampleRate: number; channels: string } | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  /** True when this build has the engine's binaries (dev runs after `pnpm studio:fetch`). */
  static available(): boolean {
    return process.platform === 'win32' && fs.existsSync(path.join(OSN_DIR, 'obs_studio_client.node'));
  }

  get running() {
    return this.osn !== null;
  }

  /**
   * False once the engine process has died (a crash in libobs or a plugin). Checked by PID, never through OSN: a call
   * to a dead engine can block. After a crash nothing talks to OSN again; the app has to be relaunched.
   */
  alive(): boolean {
    if (!this.osn || this.crashed) return false;
    if (this.enginePid === null) return true;
    try {
      process.kill(this.enginePid, 0);
      return true;
    } catch {
      this.crashed = true;
      this.streaming = this.recording = false;
      return false;
    }
  }

  get hasCrashed() {
    return this.crashed;
  }

  /**
   * Starts the engine and rebuilds the saved scene collection (the starter one, named in `names`, on first run).
   * `locale` is the app's language: libobs then names its source properties in it.
   */
  start(dataDir: string, version: string, names: DefaultNames, settings: StudioSettings, locale = 'en', canvas = { width: 1920, height: 1080 }): void {
    if (this.osn) return;
    this.canvas = { ...canvas };
    this.locale = locale;
    killStrayEngine();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const osn = require(OSN_DIR) as Osn;
    const ipc = osn.IPC.host(`trigglow-studio-${process.pid}`);
    if (ipc !== 0) throw new Error(`studio: engine process failed to start (${ipc})`);
    osn.NodeObs.SetWorkingDirectory(OSN_DIR);
    this.enginePid = enginePids()[0] ?? null; // the one IPC.host just started (killStrayEngine cleared the rest)
    this.crashed = false;
    fs.mkdirSync(dataDir, { recursive: true });
    const init = osn.NodeObs.OBS_API_initAPI({ language: obsLocale(locale), appDataPath: dataDir, version, crashServerUrl: '' });
    if (init !== 0) {
      osn.IPC.disconnect();
      throw new Error(`studio: engine init failed (${String(init)})`);
    }
    this.osn = osn;

    this.settings = settings;
    this.video = osn.VideoFactory.create();
    this.applyVideo();
    try {
      this.applyAudioSettings(true);
    } catch (err) {
      console.warn('[studio] audio settings', err);
    }

    this.dataDir = dataDir;
    this.names = names;
    this.file = this.collectionFile(this.collectionIndex().current);
    const fallback = defaultCollection(names, this.canvas);
    let raw: unknown = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      /* first run, or a broken file: the starter collection */
    }
    // A collection made on another screen is redrawn for this canvas (same layout, same proportions).
    this.build(rescaleCollection(normalizeCollection(raw, fallback), this.canvas));
    this.applyTransition();
    this.applyPriority();
    this.delayCreate();
  }

  /** OBS's Advanced → Process priority, on the engine process. */
  private applyPriority() {
    try {
      this.osn!.NodeObs.SetProcessPriority(this.settings.processPriority);
    } catch (err) {
      console.warn('[studio] process priority', err);
    }
  }

  /* ---------------------------- scene collections ---------------------------- */

  /**
   * Several scene collections, like OBS's: each one in its own file, the first one where there always was one
   * (scenes.json), the others in collections/<id>.json, and the list with the current one in collections.json.
   */
  private collectionIndex(): { current: string; list: { id: string; name: string }[] } {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'collections.json'), 'utf8')) as { current?: unknown; list?: unknown };
      const list = (Array.isArray(raw.list) ? raw.list : [])
        .filter((c): c is { id: string; name: string } => typeof c?.id === 'string' && /^(main|col-[0-9a-f]{12})$/.test(c.id) && typeof c.name === 'string')
        .map((c) => ({ id: c.id, name: cleanName(c.name) ?? c.id }));
      if (list.length) return { current: list.some((c) => c.id === raw.current) ? (raw.current as string) : list[0].id, list };
    } catch {
      /* none yet: the one collection there always was */
    }
    return { current: 'main', list: [{ id: 'main', name: this.names?.collection ?? 'Scenes' }] };
  }

  private writeCollectionIndex(index: { current: string; list: { id: string; name: string }[] }) {
    fs.writeFileSync(path.join(this.dataDir, 'collections.json'), JSON.stringify(index, null, 2));
  }

  private collectionFile(id: string) {
    return id === 'main' ? path.join(this.dataDir, 'scenes.json') : path.join(this.dataDir, 'collections', `${id}.json`);
  }

  collections(): { current: string; list: { id: string; name: string }[] } {
    return this.collectionIndex();
  }

  /** Saves the current collection and opens another one (never while streaming or recording, like OBS). */
  switchCollection(id: string): void {
    this.live();
    if (this.streaming || this.recording) throw new Error('studio_busy');
    const index = this.collectionIndex();
    if (!index.list.some((c) => c.id === id) || id === index.current) return;
    this.flushSave();
    let raw: unknown = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.collectionFile(id), 'utf8'));
    } catch {
      /* new or broken: the starter one */
    }
    this.file = this.collectionFile(id);
    this.writeCollectionIndex({ ...index, current: id });
    this.rebuild(rescaleCollection(normalizeCollection(raw, defaultCollection(this.names!, this.canvas)), this.canvas));
  }

  /** A new collection (empty starter, or a copy of the current one), and it becomes the current one. */
  addCollection(wanted: unknown, copy: boolean): string {
    this.live();
    if (this.streaming || this.recording) throw new Error('studio_busy');
    const index = this.collectionIndex();
    if (index.list.length >= 50) throw new Error('too_many_collections');
    const id = `col-${randomBytes(6).toString('hex')}`;
    const name = uniqueName(cleanName(wanted) ?? 'Scenes', index.list.map((c) => c.name));
    this.save();
    fs.mkdirSync(path.join(this.dataDir, 'collections'), { recursive: true });
    if (copy) fs.writeFileSync(this.collectionFile(id), JSON.stringify(this.collection, null, 2));
    this.writeCollectionIndex({ ...index, list: [...index.list, { id, name }] });
    this.switchCollection(id);
    return id;
  }

  renameCollection(id: string, wanted: unknown): void {
    const index = this.collectionIndex();
    const c = index.list.find((x) => x.id === id);
    const name = cleanName(wanted);
    if (!c || !name) return;
    c.name = uniqueName(name, index.list.filter((x) => x !== c).map((x) => x.name));
    this.writeCollectionIndex(index);
  }

  /** Deletes a collection that isn't the current one (its file goes too). */
  removeCollection(id: string): void {
    const index = this.collectionIndex();
    if (id === index.current || !index.list.some((c) => c.id === id)) return;
    this.writeCollectionIndex({ ...index, list: index.list.filter((c) => c.id !== id) });
    if (id !== 'main') fs.rmSync(this.collectionFile(id), { force: true });
  }

  /** Writes a pending save right now (before switching files). */
  private flushSave() {
    this.save();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    fs.writeFileSync(this.file, JSON.stringify(this.collection, null, 2));
  }

  private get backupFile() {
    return path.join(path.dirname(this.file), 'scenes.backup.json');
  }

  /** libobs input ids this engine can create (an import keeps the others as placeholders). */
  inputTypes(): string[] {
    return this.alive() ? this.osn!.InputFactory.types() : [];
  }

  /** There is a collection to go back to (the one the last import replaced). */
  hasBackup(): boolean {
    return fs.existsSync(this.backupFile);
  }

  /**
   * Swaps the whole collection: an import, or going back to the one before it (`fromBackup`). The current one is kept
   * in scenes.backup.json first, so either way the swap can be undone. Never while streaming or recording.
   */
  replaceCollection(raw: unknown, names: DefaultNames, fromBackup = false): void {
    this.live();
    if (this.streaming || this.recording) throw new Error('studio_busy');
    if (fromBackup) raw = JSON.parse(fs.readFileSync(this.backupFile, 'utf8'));
    const next = rescaleCollection(normalizeCollection(raw, defaultCollection(names, this.canvas)), this.canvas);
    this.save(); // the engine's latest state into this.collection
    fs.writeFileSync(this.backupFile, JSON.stringify(this.collection, null, 2));
    this.rebuild(next);
  }

  /** Tears the engine's scenes and sources down and builds `next` (an import, a backup or another collection). */
  private rebuild(next: Collection) {
    // Like the plugin on a collection switch: the delay belonged to the old one. Its filters go with its sources.
    this.delayCollectionChanging();
    const channels = new Set((this.collection?.sources ?? []).map((s) => s.channel).filter(Boolean) as number[]);
    for (const scene of this.scenes.values()) {
      scene.remove();
      scene.release();
    }
    for (const name of new Set([...this.faders.keys(), ...this.volmeters.keys()])) this.dropAudio(name);
    for (const input of this.inputs.values()) {
      input.remove();
      input.release();
    }
    this.scenes.clear();
    this.inputs.clear();
    this.displayOf.clear();
    this.locked.clear();
    this.folderOf.clear();
    this.programScene = null;
    this.build(next);
    // Global audio channels the new collection doesn't use must not keep the old (released) source.
    for (const ch of channels) if (!next.sources.some((s) => s.channel === ch)) this.osn!.Global.setOutputSource(ch, null);
    this.applyTransition();
    this.save();
  }

  private overlayUrl(kind: TrigglowOverlay) {
    // Until the account is known the overlay shows nothing rather than someone else's page.
    return this.overlayBase ? this.overlayBase + TRIGGLOW_OVERLAYS[kind].suffix : 'about:blank';
  }

  /** The streamer's name for an engine source or scene (engine names are ids, see newId). */
  private nameOf(source: { name: string }) {
    return this.displayOf.get(source.name) ?? source.name;
  }

  private applyAudio(input: Input, s: SavedSource) {
    input.monitoringType = s.monitoring ?? 0;
    const ms = s.syncMs ?? 0;
    input.syncOffset = { sec: Math.trunc(ms / 1000), nsec: (ms % 1000) * 1_000_000 };
    input.flags = s.mono ? input.flags | FORCE_MONO : input.flags & ~FORCE_MONO;
    input.audioMixers = s.tracks ?? 63;
  }

  private createInput(s: SavedSource): Input {
    const settings = s.trigglow ? { ...s.settings, url: this.overlayUrl(s.trigglow) } : s.settings;
    const input = this.osn!.InputFactory.create(s.type, s.id, settings);
    this.displayOf.set(s.id, s.name);
    input.muted = s.muted;
    for (const f of s.filters ?? []) {
      const filter = this.osn!.FilterFactory.create(f.type, f.name, f.settings);
      filter.enabled = f.enabled;
      input.addFilter(filter);
    }
    if (s.channel || AUDIO_TYPES.has(s.type)) {
      const fader = this.osn!.FaderFactory.create(1); // IEC, the curve OBS's own mixer uses
      fader.attach(input);
      fader.mul = s.volume;
      this.faders.set(s.name, fader);
      const meter = this.osn!.VolmeterFactory.create(1);
      meter.attach(input);
      this.volmeters.set(s.name, meter);
      this.applyAudio(input, s);
    }
    if (s.channel) this.osn!.Global.setOutputSource(s.channel, input);
    this.inputs.set(s.name, input);
    return input;
  }

  /** What an item shows: a source, or another scene (nested). */
  private sourceFor(name: string): Input | null {
    return this.inputs.get(name) ?? this.scenes.get(name)?.source ?? null;
  }

  private itemKey(scene: Scene, item: SceneItem) {
    return `${scene.name}#${item.id}`;
  }

  private placeItem(scene: Scene, input: Input, it: SavedItem): SceneItem {
    const item = scene.add(input);
    item.visible = it.visible;
    item.position = { x: it.x, y: it.y };
    item.scale = { x: it.scaleX, y: it.scaleY };
    if (it.rotation) item.rotation = it.rotation;
    if (it.crop) item.crop = it.crop;
    if (it.bounds) {
      item.bounds = { x: it.bounds.width, y: it.bounds.height };
      item.boundsType = it.bounds.type;
    }
    if (it.locked) this.locked.add(this.itemKey(scene, item));
    if (it.folder) this.folderOf.set(this.itemKey(scene, item), it.folder);
    return item;
  }

  private build(c: Collection) {
    this.collection = c;
    for (const s of c.sources) this.createInput(s);
    // Every scene exists before any item, so one scene can show another.
    for (const sc of c.scenes) {
      this.scenes.set(sc.name, this.osn!.SceneFactory.create(sc.id));
      this.displayOf.set(sc.id, sc.name);
    }
    for (const sc of c.scenes) {
      const scene = this.scenes.get(sc.name)!;
      for (const it of sc.items) {
        const input = this.sourceFor(it.source);
        if (input) this.placeItem(scene, input, it);
      }
    }
    this.editWrap ??= this.osn!.SceneFactory.create('trigglow-edit');
    this.showInEditor(this.scenes.get(c.current)!);
    if (this.callbacksOn) return;
    this.callbacksOn = true;
    this.osn!.NodeObs.RegisterVolmeterCallback((rows: unknown) => this.onVolmeter(rows));
    // OSN only starts delivering callbacks (meters included) once a source callback is registered too (seen 2026-11-02).
    this.osn!.NodeObs.RegisterSourceCallback(() => {});
  }

  private showInEditor(scene: Scene) {
    const wrap = this.editWrap;
    if (!wrap) return;
    for (const item of wrap.getItems()) item.remove();
    wrap.add(scene.source);
  }

  /** Audio levels from the engine (~16 times a second): the loudest channel's peak per source, in dB. */
  private onVolmeter(rows: unknown) {
    if (!this.onLevels || !Array.isArray(rows)) return;
    const levels: Record<string, number> = {};
    for (const r of rows as { sourceName?: string; peak?: number[] }[]) {
      if (typeof r?.sourceName !== 'string') continue;
      const peak = Array.isArray(r.peak) && r.peak.length ? Math.max(...r.peak.filter(Number.isFinite)) : -Infinity;
      levels[this.displayOf.get(r.sourceName) ?? r.sourceName] = Number.isFinite(peak) ? Math.round(peak * 10) / 10 : -100;
    }
    this.onLevels(levels);
  }

  /** The signed-in streamer's overlay base URL (null when signed out): repoints every Trigglow source. */
  setOverlayBase(base: string | null): void {
    this.overlayBase = base;
    if (!this.collection || !this.alive()) return;
    for (const s of this.collection.sources) if (s.trigglow) this.inputs.get(s.name)?.update({ url: this.overlayUrl(s.trigglow) });
  }

  /* ----------------------------- the editor ----------------------------- */

  private sourceMeta(name: string) {
    return this.collection?.sources.find((s) => s.name === name);
  }

  private itemData(scene: Scene, item: SceneItem): SavedItem {
    const crop = cropOf(item.crop);
    return {
      source: this.nameOf(item.source),
      visible: item.visible,
      x: item.position.x,
      y: item.position.y,
      scaleX: item.scale.x,
      scaleY: item.scale.y,
      ...(item.boundsType ? { bounds: { width: item.bounds.x, height: item.bounds.y, type: item.boundsType } } : {}),
      ...(item.rotation ? { rotation: item.rotation } : {}),
      ...(crop ? { crop } : {}),
      ...(this.locked.has(this.itemKey(scene, item)) ? { locked: true } : {}),
      ...(this.folderOf.has(this.itemKey(scene, item)) ? { folder: this.folderOf.get(this.itemKey(scene, item)) } : {}),
    };
  }

  /** Reads the engine back into the collection and writes it to disk a moment later (edits come in bursts). */
  private save() {
    const c = this.collection;
    if (!c) return;
    for (const s of c.sources) {
      const input = this.inputs.get(s.name);
      if (!input) continue;
      const settings = { ...input.settings };
      if (s.trigglow) delete settings.url;
      s.settings = settings;
      s.volume = this.faders.get(s.name)?.mul ?? s.volume;
      s.muted = input.muted;
      const filters: SavedFilter[] = input.filters
        .filter((f) => f.id in VIDEO_FILTERS || f.id in AUDIO_FILTERS)
        .map((f) => ({ type: f.id, name: f.name, enabled: f.enabled, settings: { ...f.settings } }));
      if (filters.length) s.filters = filters;
      else delete s.filters;
    }
    c.scenes = c.scenes.map((sc) => {
      const scene = this.scenes.get(sc.name);
      const items = scene ? scene.getItems().map((item) => this.itemData(scene, item)) : [];
      // Folders nothing is in any more go.
      const folders = sc.folders?.filter((f) => items.some((it) => it.folder === f.id));
      const { folders: _old, ...rest } = sc;
      return { ...rest, items, ...(folders?.length ? { folders } : {}) };
    });
    if (this.saveTimer) clearTimeout(this.saveTimer);
    const snapshot = JSON.stringify(c, null, 2);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        fs.writeFileSync(`${this.file}.tmp`, snapshot);
        fs.renameSync(`${this.file}.tmp`, this.file);
      } catch (err) {
        console.error('[studio] could not save scenes', err);
      }
    }, 400);
  }

  view(): StudioView | null {
    const c = this.collection;
    if (!c || !this.alive()) return null;
    const scene = this.scenes.get(c.current);
    const items = (scene?.getItems() ?? [])
      .map((item) => {
        const name = this.nameOf(item.source);
        const meta = this.sourceMeta(name);
        return {
          id: item.id,
          source: name,
          type: meta?.type ?? (this.scenes.has(name) ? 'scene' : item.source.id),
          visible: item.visible,
          selected: item.selected,
          locked: this.locked.has(this.itemKey(scene!, item)),
          ...(this.folderOf.has(this.itemKey(scene!, item)) ? { folder: this.folderOf.get(this.itemKey(scene!, item)) } : {}),
          rotated: (item.rotation ?? 0) % 360 !== 0,
          box: this.box(item),
          ...(meta?.trigglow ? { trigglow: meta.trigglow } : {}),
        };
      })
      .reverse();
    const audio = c.sources
      .filter((s) => s.channel || AUDIO_TYPES.has(s.type))
      .map((s) => ({ name: s.name, volume: this.faders.get(s.name)?.deflection ?? 1, muted: this.inputs.get(s.name)?.muted ?? s.muted, monitoring: s.monitoring ?? 0 }));
    const meta = c.scenes.find((s) => s.name === c.current);
    return {
      scenes: c.scenes.map((s) => s.name),
      current: c.current,
      items,
      folders: meta?.folders ?? [],
      transition: meta?.transition ?? null,
      studioMode: this.studioMode,
      program: this.programName(),
      audio,
      canvas: { ...this.canvas },
    };
  }

  /** Every source and scene by name, for "add an existing one" (scenes that would loop are left out). */
  existing(): { name: string; type: string; trigglow?: TrigglowOverlay }[] {
    const c = this.collection;
    if (!c || !this.alive()) return [];
    const sources = c.sources.filter((s) => !s.channel).map((s) => ({ name: s.name, type: s.type, ...(s.trigglow ? { trigglow: s.trigglow } : {}) }));
    const scenes = c.scenes.filter((s) => !sceneContains(c.scenes, s.name, c.current)).map((s) => ({ name: s.name, type: 'scene' }));
    return [...sources, ...scenes];
  }

  /** The item's unrotated size on the canvas (signed: negative = flipped), after crop. */
  private size(item: SceneItem) {
    if (item.boundsType) return { w: item.bounds.x, h: item.bounds.y };
    const crop = item.crop ?? { left: 0, right: 0, top: 0, bottom: 0 };
    const w = Math.max(0, (item.source.width || 0) - crop.left - crop.right);
    const h = Math.max(0, (item.source.height || 0) - crop.top - crop.bottom);
    return { w: w * item.scale.x, h: h * item.scale.y };
  }

  /** The item's rectangle on the canvas (its rotated, flipped outline's bounding box), for picking and dragging it. */
  private box(item: SceneItem) {
    return boxOf(item.position, this.size(item), item.rotation ?? 0);
  }

  /** Selects one item of the current scene (the engine draws its outline on the preview), or none. */
  /** Selects one item (null = none), or with `add` adds/removes it from the selection (Ctrl+click, like OBS). */
  select(id: number | null, add = false) {
    this.live();
    for (const item of this.scenes.get(this.collection!.current)?.getItems() ?? []) {
      if (!add) item.selected = item.id === id;
      else if (item.id === id) item.selected = !item.selected;
    }
  }

  private isAlerts(item: SceneItem) {
    return this.sourceMeta(this.nameOf(item.source))?.trigglow === 'alerts';
  }

  /** Moves the item so its box's top-left lands on `at` (or its centre on the canvas centre, for the alerts). */
  private placeBox(item: SceneItem, at: { x: number; y: number }) {
    const b = this.box(item);
    const target = this.isAlerts(item) ? centred(b, this.canvas) : at;
    item.position = { x: item.position.x + target.x - b.x, y: item.position.y + target.y - b.y };
  }

  /**
   * Moves and/or resizes an item by its box, in canvas pixels (what dragging on the preview does). The alerts overlay
   * can be resized but never moved: it is re-centred after every change. Items with a bounds box resize the box; the
   * rest change their scale. Locked items don't move.
   */
  transform(id: number, to: { x?: unknown; y?: unknown; width?: unknown; height?: unknown }) {
    const item = this.item(id);
    if (this.isLocked(item)) return;
    const n = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : null);
    const before = this.box(item);
    const width = n(to.width, 8, 16384);
    const height = n(to.height, 8, 16384);
    if (width !== null && height !== null && before.width > 0 && before.height > 0) {
      const kx = width / before.width;
      const ky = height / before.height;
      if (item.boundsType) item.bounds = { x: item.bounds.x * kx, y: item.bounds.y * ky };
      else item.scale = { x: item.scale.x * kx, y: item.scale.y * ky };
    }
    const x = n(to.x, -16384, 16384);
    const y = n(to.y, -16384, 16384);
    this.placeBox(item, x !== null && y !== null ? { x, y } : before);
    this.save();
  }

  /** Everything the Edit transform window shows (OBS's): position, rotation, size, bounds, crop. */
  itemTransform(id: number) {
    const item = this.item(id);
    const s = this.size(item);
    return {
      x: item.position.x,
      y: item.position.y,
      rotation: item.rotation ?? 0,
      width: Math.abs(s.w),
      height: Math.abs(s.h),
      boundsType: item.boundsType,
      boundsWidth: item.boundsType ? item.bounds.x : Math.abs(s.w),
      boundsHeight: item.boundsType ? item.bounds.y : Math.abs(s.h),
      crop: { left: 0, top: 0, right: 0, bottom: 0, ...cropOf(item.crop) },
      sourceWidth: item.source.width || 0,
      sourceHeight: item.source.height || 0,
      alerts: this.isAlerts(item),
    };
  }

  /** Applies the Edit transform window. Numbers are checked; the alerts only take a size and stay centred. */
  setItemTransform(id: number, v: Record<string, unknown>) {
    const item = this.item(id);
    const n = (x: unknown, min: number, max: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : null);
    const alerts = this.isAlerts(item);
    const crop = cropOf(v.crop);
    const was = this.size(item); // the size field only counts when it was changed, like OBS's (a crop alone keeps the scale)
    if (!alerts) {
      item.crop = crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
      const rotation = n(v.rotation, -360, 360);
      if (rotation !== null) item.rotation = rotation;
    }
    const bt = n(v.boundsType, 0, 6);
    if (bt !== null) {
      const bw = n(v.boundsWidth, 1, 16384);
      const bh = n(v.boundsHeight, 1, 16384);
      if (bt && bw !== null && bh !== null) item.bounds = { x: bw, y: bh };
      item.boundsType = bt;
    }
    if (!item.boundsType) {
      const w = n(v.width, 1, 16384);
      const h = n(v.height, 1, 16384);
      const cw = Math.max(1, (item.source.width || 0) - (item.crop?.left ?? 0) - (item.crop?.right ?? 0));
      const ch = Math.max(1, (item.source.height || 0) - (item.crop?.top ?? 0) - (item.crop?.bottom ?? 0));
      const changed = w !== null && h !== null && (Math.abs(w - Math.abs(was.w)) > 0.5 || Math.abs(h - Math.abs(was.h)) > 0.5);
      if (changed && w !== null && h !== null && item.source.width && item.source.height) item.scale ={ x: Math.sign(item.scale.x || 1) * (w / cw), y: Math.sign(item.scale.y || 1) * (h / ch) };
    }
    const x = n(v.x, -16384, 16384);
    const y = n(v.y, -16384, 16384);
    if (alerts) this.placeBox(item, this.box(item));
    else if (x !== null && y !== null) item.position = { x, y };
    this.save();
  }

  /**
   * The Transform menu (OBS's): reset, rotate, flip, fit/stretch to the screen, centre. Rotating keeps the item's
   * centre; flipping keeps its box. The alerts only fit (re-centred) or reset: they never move, turn or flip.
   */
  transformAction(id: number, action: string) {
    const item = this.item(id);
    const alerts = this.isAlerts(item);
    const b = this.box(item);
    const centre = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const keepCentre = () => {
      const nb = this.box(item);
      this.placeBox(item, { x: centre.x - nb.width / 2, y: centre.y - nb.height / 2 });
    };
    const fit = (type: number) => {
      item.rotation = 0;
      item.bounds = { x: this.canvas.width, y: this.canvas.height };
      item.boundsType = type;
      item.position = { x: 0, y: 0 };
    };
    switch (action) {
      case 'reset':
        item.rotation = 0;
        item.crop = { left: 0, top: 0, right: 0, bottom: 0 };
        item.boundsType = 0;
        item.scale = { x: 1, y: 1 };
        this.placeBox(item, alerts ? b : { x: 0, y: 0 });
        break;
      case 'rotate-cw':
      case 'rotate-ccw':
      case 'rotate-180':
        if (alerts) return;
        item.rotation = (((item.rotation ?? 0) + (action === 'rotate-cw' ? 90 : action === 'rotate-ccw' ? -90 : 180)) % 360 + 360) % 360;
        keepCentre();
        break;
      case 'flip-h':
      case 'flip-v':
        if (alerts) return;
        item.scale = action === 'flip-h' ? { x: -item.scale.x, y: item.scale.y } : { x: item.scale.x, y: -item.scale.y };
        this.placeBox(item, b);
        break;
      case 'fit':
        fit(2); // scale inner: all of it, letterboxed
        if (alerts) this.placeBox(item, b);
        break;
      case 'stretch':
        if (alerts) return;
        fit(1);
        break;
      case 'center':
        this.placeBox(item, { x: (this.canvas.width - b.width) / 2, y: (this.canvas.height - b.height) / 2 });
        break;
      case 'center-h':
        this.placeBox(item, { x: (this.canvas.width - b.width) / 2, y: b.y });
        break;
      case 'center-v':
        this.placeBox(item, { x: b.x, y: (this.canvas.height - b.height) / 2 });
        break;
      default:
        return;
    }
    this.save();
  }

  private isLocked(item: SceneItem) {
    return this.locked.has(this.itemKey(this.scenes.get(this.collection!.current)!, item));
  }

  setLocked(id: number, locked: boolean) {
    const item = this.item(id);
    const key = this.itemKey(this.scenes.get(this.collection!.current)!, item);
    if (locked) this.locked.add(key);
    else this.locked.delete(key);
    this.save();
  }

  /** Where the engine draws the canvas inside the preview, in device pixels (it letterboxes to keep 16:9). */
  previewRegion(): { x: number; y: number; width: number; height: number } | null {
    if (!this.display || !this.alive()) return null;
    const n = this.osn!.NodeObs;
    const off = n.OBS_content_getDisplayPreviewOffset(this.display) as { x: number; y: number };
    const size = n.OBS_content_getDisplayPreviewSize(this.display) as { width: number; height: number };
    return { x: off.x, y: off.y, width: size.width, height: size.height };
  }

  /** Every editor change goes through here: a dead engine must never be called (the call would block the app). */
  private live() {
    if (!this.alive()) throw new Error('engine_stopped');
  }

  private item(id: number) {
    this.live();
    const item = this.scenes.get(this.collection!.current)?.getItems().find((i) => i.id === id);
    if (!item) throw new Error('studio: no such item');
    return item;
  }

  /** A name nothing else has (sources and scenes share one namespace, like in OBS). */
  private freeName(wanted: unknown, fallback: string) {
    return uniqueName(cleanName(wanted) ?? fallback, [...this.inputs.keys(), ...this.scenes.keys()]);
  }

  selectScene(name: string) {
    this.live();
    const scene = this.scenes.get(name);
    if (!scene || !this.collection) return;
    const c = this.collection;
    const changed = c.current !== name;
    this.collection.current = name;
    this.showInEditor(scene);
    // Studio mode: the editor moves, program stays until "Transition".
    if (!this.studioMode) this.toProgram(scene);
    this.save();
    if (changed && !this.studioMode) this.onScene?.(name);
  }

  /**
   * Program shows `scene` with the scene's own transition or the one in Settings. While the delay is on, the live scene
   * goes out through the plugin's wrapper scene; any other scene goes out undelayed, like in OBS.
   */
  private toProgram(scene: Scene) {
    const c = this.collection!;
    if (this.studioMode) this.programScene = scene;
    const delayed = this.delayProgramFor(scene);
    if (delayed) return this.transition?.set(delayed);
    // A scene can have its own transition (OBS's "Transition override"); the others use the one in Settings.
    const own = c.scenes.find((s) => this.scenes.get(s.name) === scene)?.transition;
    const spec = own ? { ...this.settings, transition: own.type, transitionMs: own.ms } : this.settings;
    this.useTransition(own ? `${own.type}` : 'default', spec);
    if (spec.transition === 'cut') this.transition?.set(scene);
    else this.transition?.start(spec.transitionMs, scene);
  }

  /** OBS's studio mode: the editor works on one scene while program shows another; "Transition" swaps them in. */
  setStudioMode(on: boolean) {
    this.live();
    if (on === this.studioMode) return;
    const current = this.scenes.get(this.collection!.current)!;
    this.studioMode = on;
    if (on) this.programScene = current;
    else {
      this.programScene = null;
      this.toProgram(current);
    }
    this.placePreview();
  }

  /** Studio mode's "Transition": program takes the scene being edited. */
  transitionToProgram() {
    this.live();
    if (!this.studioMode) return;
    const c = this.collection!;
    const scene = this.scenes.get(c.current)!;
    if (scene === this.programScene) return;
    this.toProgram(scene);
    this.onScene?.(c.current);
  }

  /** The scene program shows (its name), for the view and automations. */
  private programName() {
    const c = this.collection!;
    if (!this.programScene) return c.current;
    return [...this.scenes.entries()].find(([, s]) => s === this.programScene)?.[0] ?? c.current;
  }

  /** Streaming / recording right now. */
  get outputs() {
    return { streaming: this.streaming, recording: this.recording };
  }

  /** Writes a text source's text (server actions, Trigglow text sources). 'missing' when there is no such text source. */
  setText(name: string, text: string): 'ok' | 'missing' {
    this.live();
    const meta = this.sourceMeta(name);
    const input = this.inputs.get(name);
    if (!meta || !input || !meta.type.startsWith('text_')) return 'missing';
    input.update({ text: text.slice(0, 10_000) });
    this.save();
    return 'ok';
  }

  /** Creates a text source in `scene` (or the current one); false when the name is taken by something else. */
  addText(scene: string | null, wanted: string, text: string): boolean {
    this.live();
    const c = this.collection!;
    const existing = this.sourceMeta(wanted);
    if (existing) return existing.type.startsWith('text_');
    const target = this.scenes.get(scene ?? c.current) ?? this.scenes.get(c.current)!;
    const name = this.freeName(wanted, 'Text');
    const meta: SavedSource = { id: newId('src'), name, type: 'text_gdiplus_v3', settings: { text: text.slice(0, 10_000) }, volume: 1, muted: false };
    c.sources.push(meta);
    this.placeItem(target, this.createInput(meta), { source: name, visible: true, x: 0, y: 0, scaleX: 1, scaleY: 1 });
    this.save();
    return true;
  }

  /** Shows or hides a source in a scene, by names (server actions). */
  setVisibleIn(scene: string, source: string, visible: boolean) {
    this.live();
    const sc = this.scenes.get(scene);
    const item = sc?.getItems().find((i) => this.nameOf(i.source) === source);
    if (!item) throw new Error('studio: no such source in that scene');
    item.visible = visible;
    this.save();
  }

  addScene(wanted: unknown): string {
    this.live();
    const c = this.collection!;
    const name = this.freeName(wanted, 'Scene');
    const id = newId('scn');
    this.scenes.set(name, this.osn!.SceneFactory.create(id));
    this.displayOf.set(id, name);
    c.scenes.push({ id, name, items: [] });
    this.selectScene(name);
    return name;
  }

  /**
   * A scene with Trigglow's stream overlays already placed (TRIGGLOW_SCENE_OVERLAYS, the alerts centred on top). A
   * scene of that name gets the ones it lacks instead of a second scene.
   */
  addTrigglowScene(wanted: unknown): string {
    this.live();
    const name = cleanName(wanted) ?? 'Trigglow';
    const target = this.scenes.has(name) ? name : this.addScene(name);
    this.selectScene(target);
    for (const kind of TRIGGLOW_SCENE_OVERLAYS) this.addSource({ trigglow: kind }, null);
    return target;
  }

  /** A copy of a scene that shows the same sources (OBS's Duplicate: sources are shared, positions copied). */
  duplicateScene(from: string, wanted: unknown): string {
    this.live();
    const c = this.collection!;
    const src = this.scenes.get(from);
    if (!src) throw new Error('studio: no such scene');
    const name = this.freeName(wanted, from);
    const id = newId('scn');
    const scene = this.osn!.SceneFactory.create(id);
    this.scenes.set(name, scene);
    this.displayOf.set(id, name);
    for (const item of src.getItems()) this.placeItem(scene, item.source, this.itemData(src, item));
    const fromMeta = c.scenes.find((s) => s.name === from);
    c.scenes.splice(c.scenes.findIndex((s) => s.name === from) + 1, 0, { id, name, items: [], ...(fromMeta?.folders ? { folders: structuredClone(fromMeta.folders) } : {}), ...(fromMeta?.transition ? { transition: { ...fromMeta.transition } } : {}) });
    this.selectScene(name);
    return name;
  }

  /** `up` = earlier in the list. */
  moveScene(name: string, dir: 'up' | 'down') {
    this.live();
    const list = this.collection!.scenes;
    const i = list.findIndex((s) => s.name === name);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    this.save();
  }

  /** Renames a source or a scene. Only the label changes: the engine keeps its id, so nothing reloads. */
  rename(from: string, wanted: unknown): string {
    this.live();
    const c = this.collection!;
    const clean = cleanName(wanted);
    if (!clean || clean === from) return from;
    const name = uniqueName(clean, [...this.inputs.keys(), ...this.scenes.keys()].filter((n) => n !== from));
    const meta = this.sourceMeta(from);
    if (meta) {
      const input = this.inputs.get(from)!;
      this.inputs.delete(from);
      this.inputs.set(name, input);
      for (const m of [this.faders, this.volmeters] as Map<string, unknown>[]) {
        if (!m.has(from)) continue;
        m.set(name, m.get(from));
        m.delete(from);
      }
      meta.name = name;
      this.displayOf.set(meta.id, name);
    } else {
      const sc = c.scenes.find((s) => s.name === from);
      const scene = this.scenes.get(from);
      if (!sc || !scene) throw new Error('studio: nothing to rename');
      this.scenes.delete(from);
      this.scenes.set(name, scene);
      sc.name = name;
      this.displayOf.set(sc.id, name);
      if (c.current === from) c.current = name;
    }
    this.save(); // item references are read back from the engine, through the new label
    return name;
  }

  removeScene(name: string) {
    this.live();
    const c = this.collection!;
    const scene = this.scenes.get(name);
    if (!scene || c.scenes.length <= 1) return;
    // Out of every scene that shows it first.
    for (const other of this.scenes.values()) for (const i of other.getItems()) if (i.source.name === scene.name) i.remove();
    c.scenes = c.scenes.filter((s) => s.name !== name);
    if (c.current === name) this.selectScene(c.scenes[0].name);
    if (this.programScene === scene) this.toProgram(this.scenes.get(c.current)!);
    this.scenes.delete(name);
    scene.remove();
    scene.release();
    this.dropUnused();
    this.save();
  }

  /** Adds a new source to the current scene: a capture, a camera, media… or one of the streamer's Trigglow overlays. */
  addSource(kind: { type?: unknown; trigglow?: unknown }, wantedName: unknown): string {
    this.live();
    const c = this.collection!;
    const scene = this.scenes.get(c.current)!;
    const trigglow = typeof kind.trigglow === 'string' && kind.trigglow in TRIGGLOW_OVERLAYS ? (kind.trigglow as TrigglowOverlay) : null;
    if (trigglow) {
      // One source per overlay, shared by every scene that shows it (like OBS's "add existing").
      let meta = c.sources.find((s) => s.trigglow === trigglow);
      const alerts = alertsSize(this.canvas);
      const table = overlayPlacement(`/overlay/x${TRIGGLOW_OVERLAYS[trigglow].suffix}`);
      const place = trigglow === 'alerts' ? { ...alerts, ...centred(alerts, this.canvas) } : table && scalePlacement(table, this.canvas);
      if (!meta) {
        const name = this.freeName(TRIGGLOW_OVERLAYS[trigglow].name, TRIGGLOW_OVERLAYS[trigglow].name);
        meta = { id: newId('src'), name, type: 'browser_source', settings: { width: place?.width ?? 800, height: place?.height ?? 600, shutdown: false }, volume: 1, muted: false, trigglow };
        c.sources.push(meta);
        this.createInput(meta);
      }
      const input = this.inputs.get(meta.name)!;
      if (!scene.getItems().some((i) => i.source.name === meta.id)) {
        this.placeItem(scene, input, { source: meta.name, visible: true, x: place?.x ?? 0, y: place?.y ?? 0, scaleX: 1, scaleY: 1 });
      }
      this.save();
      return meta.name;
    }
    if (!SOURCE_TYPES.includes(kind.type as SourceType)) throw new Error('studio: unknown source type');
    const type = kind.type as SourceType;
    const name = this.freeName(wantedName, type);
    const meta: SavedSource = { id: newId('src'), name, type, settings: { ...(NEW_SOURCE_SETTINGS[type] ?? {}) }, volume: 1, muted: false };
    c.sources.push(meta);
    const input = this.createInput(meta);
    const fit = FILLS_CANVAS.has(type) ? { bounds: { width: this.canvas.width, height: this.canvas.height, type: 2 } } : {};
    this.placeItem(scene, input, { source: name, visible: true, x: 0, y: 0, scaleX: 1, scaleY: 1, ...fit });
    this.save();
    return name;
  }

  /** Adds a source that already exists (shared, like OBS's "Add existing"), or another scene (nested), to the current scene. */
  addExisting(name: string) {
    this.live();
    const c = this.collection!;
    const meta = this.sourceMeta(name);
    if (meta?.channel) throw new Error('studio: global audio is in every scene already');
    if (!meta && (!this.scenes.has(name) || sceneContains(c.scenes, name, c.current))) throw new Error('studio: cannot add that scene here');
    const input = this.sourceFor(name);
    if (!input) throw new Error('studio: no such source');
    const fit = this.scenes.has(name) || FILLS_CANVAS.has(meta?.type ?? '') ? { bounds: { width: this.canvas.width, height: this.canvas.height, type: 2 } } : {};
    this.placeItem(this.scenes.get(c.current)!, input, { source: name, visible: true, x: 0, y: 0, scaleX: 1, scaleY: 1, ...fit });
    this.save();
  }

  /** A new source with the same settings and filters, placed where the original is (OBS's Paste (Duplicate)). */
  duplicateItem(id: number, wanted?: unknown): string {
    const item = this.item(id);
    const c = this.collection!;
    const from = this.sourceMeta(this.nameOf(item.source));
    if (!from || from.trigglow) throw new Error('studio: this source cannot be duplicated');
    this.save(); // the latest settings into `from`
    const name = this.freeName(wanted, from.name);
    const meta: SavedSource = { ...structuredClone(from), id: newId('src'), name };
    c.sources.push(meta);
    const input = this.createInput(meta);
    const scene = this.scenes.get(c.current)!;
    this.placeItem(scene, input, { ...this.itemData(scene, item), source: name, locked: false });
    this.save();
    return name;
  }

  removeItem(id: number) {
    this.item(id).remove();
    this.dropUnused();
    this.save();
  }

  setVisible(id: number, visible: boolean) {
    this.item(id).visible = visible;
    this.save();
  }

  /** `up` = towards the top of the list (drawn over the others); `top`/`bottom` = all the way. */
  moveItem(id: number, dir: 'up' | 'down' | 'top' | 'bottom') {
    this.item(id);
    const scene = this.scenes.get(this.collection!.current)!;
    const items = scene.getItems();
    const at = items.findIndex((i) => i.id === id);
    const to = dir === 'up' ? at + 1 : dir === 'down' ? at - 1 : dir === 'top' ? items.length - 1 : 0;
    this.reorder(scene, at, to);
    this.save();
  }

  /**
   * Moves the item at `from` to `to`, both counted like getItems() (bottom → top). Through scene.moveItem: the item's
   * own moveUp/moveDown/moveTop reorder the engine but leave OSN's list in the old order (seen 2026-11-02).
   */
  private reorder(scene: Scene, from: number, to: number) {
    const n = scene.getItems().length;
    if (from < 0 || from >= n || to < 0 || to >= n || from === to) return;
    scene.moveItem(n - 1 - from, n - 1 - to);
  }

  /** `position` is the mixer slider, 0..1 (the fader's deflection). */
  setVolume(name: string, position: number) {
    this.live();
    const fader = this.faders.get(name);
    if (!fader || !Number.isFinite(position)) return;
    fader.deflection = Math.min(1, Math.max(0, position));
    this.save();
  }

  setMuted(name: string, muted: boolean) {
    this.live();
    const input = this.inputs.get(name);
    if (!input) return;
    const changed = input.muted !== muted;
    input.muted = muted;
    this.save();
    if (changed) this.onMute?.(name, muted);
  }

  /** OBS's Advanced Audio Properties: every source with sound, its volume in dB, mono, sync offset and monitoring. */
  audioProps(): { name: string; db: number; mono: boolean; syncMs: number; monitoring: number; tracks: number }[] {
    if (!this.collection || !this.alive()) return [];
    return this.collection.sources
      .filter((s) => this.faders.has(s.name))
      .map((s) => ({ name: s.name, db: Math.round((this.faders.get(s.name)!.db ?? 0) * 10) / 10, mono: s.mono === true, syncMs: s.syncMs ?? 0, monitoring: s.monitoring ?? 0, tracks: s.tracks ?? 63 }));
  }

  setAudioProps(name: string, v: { db?: unknown; mono?: unknown; syncMs?: unknown; monitoring?: unknown; tracks?: unknown }) {
    this.live();
    const meta = this.sourceMeta(name);
    const input = this.inputs.get(name);
    if (!meta || !input || !this.faders.has(name)) return this.audioProps();
    if (typeof v.mono === 'boolean') {
      if (v.mono) meta.mono = true;
      else delete meta.mono;
    }
    if (typeof v.syncMs === 'number' && Number.isFinite(v.syncMs)) {
      const ms = Math.round(Math.min(20000, Math.max(-950, v.syncMs)));
      if (ms) meta.syncMs = ms;
      else delete meta.syncMs;
    }
    if (v.monitoring === 0 || v.monitoring === 1 || v.monitoring === 2) {
      if (v.monitoring) meta.monitoring = v.monitoring;
      else delete meta.monitoring;
    }
    if (Number.isInteger(v.tracks) && (v.tracks as number) >= 0 && (v.tracks as number) <= 63) {
      if (v.tracks === 63) delete meta.tracks;
      else meta.tracks = v.tracks as number;
    }
    if (typeof v.db === 'number' && Number.isFinite(v.db)) this.faders.get(name)!.db = Math.min(26, Math.max(-100, v.db));
    this.applyAudio(input, meta);
    this.save();
    return this.audioProps();
  }

  /** Sources no scene shows any more (and that aren't global audio) are removed from the engine and the collection. */
  private dropUnused() {
    const c = this.collection!;
    const used = new Set<string>();
    for (const scene of this.scenes.values()) for (const i of scene.getItems()) used.add(this.nameOf(i.source));
    for (const s of [...c.sources]) {
      if (s.channel || used.has(s.name)) continue;
      const input = this.inputs.get(s.name);
      this.inputs.delete(s.name);
      this.dropAudio(s.name);
      this.displayOf.delete(s.id);
      c.sources = c.sources.filter((x) => x.name !== s.name);
      input?.remove();
      input?.release();
    }
  }

  private dropAudio(name: string) {
    const fader = this.faders.get(name);
    if (fader) {
      this.faders.delete(name);
      fader.detach();
      fader.destroy();
    }
    const meter = this.volmeters.get(name);
    if (meter) {
      this.volmeters.delete(name);
      meter.detach();
      meter.destroy();
    }
  }

  /** Filter names in the app's language, from libobs' own obs-filters locale (English where a string is missing). */
  private filterLabel(type: string) {
    if (!this.filterNames) {
      const read = (loc: string) => {
        try {
          return parseLocaleIni(fs.readFileSync(path.join(OSN_DIR, 'data', 'obs-plugins', 'obs-filters', 'locale', `${loc}.ini`), 'utf8'));
        } catch {
          return new Map<string, string>();
        }
      };
      this.filterNames = new Map([...read('en-US'), ...read(obsLocale(this.locale))]);
    }
    const key = VIDEO_FILTERS[type] ?? AUDIO_FILTERS[type];
    return ownBrand((key && this.filterNames.get(key)) || type);
  }

  /** The filters a source has, and the ones it can get (audio filters for sources with sound, video ones for the rest). */
  filters(name: string): StudioFilters {
    if (!this.alive()) return { filters: [], available: [] };
    const input = this.inputs.get(name);
    const meta = this.sourceMeta(name);
    if (!input || !meta) return { filters: [], available: [] };
    const audio = Boolean(meta.channel) || AUDIO_TYPES.has(meta.type);
    const video = !meta.channel && !meta.type.startsWith('wasapi_');
    const types = [...(video ? Object.keys(VIDEO_FILTERS) : []), ...(audio ? Object.keys(AUDIO_FILTERS) : [])];
    return {
      filters: input.filters.filter((f) => f.id !== DELAY_AUDIO && f.id !== DELAY_VIDEO).map((f) => ({ name: f.name, type: f.id, enabled: f.enabled })),
      available: types.map((type) => ({ type, label: this.filterLabel(type) })),
    };
  }

  addFilter(name: string, type: unknown): StudioFilters {
    this.live();
    const input = this.inputs.get(name);
    if (!input || typeof type !== 'string' || !(type in VIDEO_FILTERS || type in AUDIO_FILTERS)) return this.filters(name);
    if (input.filters.length >= 30) return this.filters(name);
    const filterName = uniqueName(this.filterLabel(type), input.filters.map((f) => f.name));
    input.addFilter(this.osn!.FilterFactory.create(type, filterName, {}));
    this.save();
    return this.filters(name);
  }

  removeFilter(name: string, filterName: string): StudioFilters {
    this.live();
    const input = this.inputs.get(name);
    const filter = input?.filters.find((f) => f.name === filterName);
    if (input && filter) {
      input.removeFilter(filter);
      filter.release();
      this.save();
    }
    return this.filters(name);
  }

  setFilterEnabled(name: string, filterName: string, enabled: boolean): StudioFilters {
    this.live();
    const filter = this.inputs.get(name)?.filters.find((f) => f.name === filterName);
    if (filter) {
      filter.enabled = enabled;
      this.save();
    }
    return this.filters(name);
  }

  /** Filters run top to bottom: `up` runs this one earlier. */
  moveFilter(name: string, filterName: string, dir: 'up' | 'down'): StudioFilters {
    this.live();
    const input = this.inputs.get(name);
    const filter = input?.filters.find((f) => f.name === filterName);
    if (input && filter) {
      input.setFilterOrder(filter, dir === 'up' ? 0 : 1);
      this.save();
    }
    return this.filters(name);
  }

  /** Copies every filter of one source onto another (OBS's Copy/Paste filters), keeping the target's own. */
  pasteFilters(from: string, to: string): StudioFilters {
    this.live();
    const src = this.sourceMeta(from);
    const input = this.inputs.get(to);
    if (!src || !input || from === to) return this.filters(to);
    this.save();
    const toMeta = this.sourceMeta(to)!;
    const audioOk = Boolean(toMeta.channel) || AUDIO_TYPES.has(toMeta.type);
    const videoOk = !toMeta.channel && !toMeta.type.startsWith('wasapi_');
    for (const f of src.filters ?? []) {
      if (input.filters.length >= 30) break;
      if (!((f.type in VIDEO_FILTERS && videoOk) || (f.type in AUDIO_FILTERS && audioOk))) continue;
      const filter = this.osn!.FilterFactory.create(f.type, uniqueName(f.name, input.filters.map((x) => x.name)), f.settings);
      filter.enabled = f.enabled;
      input.addFilter(filter);
    }
    this.save();
    return this.filters(to);
  }

  /** What the properties panel edits: the source itself, or one of its filters. */
  private configurable(name: string, filter?: string): Configurable | null {
    const input = this.inputs.get(name);
    if (!input) return null;
    return filter ? (input.filters.find((f) => f.name === filter) ?? null) : input;
  }

  /** Walks a source's (or filter's) libobs properties, flattening groups. */
  private eachProperty(target: Configurable, fn: (p: Property) => void) {
    let p = target.properties?.first() ?? null;
    for (let guard = 0; p && guard < 300; guard++) {
      fn(p);
      if (p.is_last()) break;
      p = p.next();
    }
  }

  /** A source's (or one of its filters') editable properties: device lists, window lists, paths, numbers… as libobs describes them. */
  properties(name: string, filter?: string): StudioProperty[] {
    if (!this.alive()) return [];
    const target = this.configurable(name, filter);
    const meta = this.sourceMeta(name);
    if (!target || !meta) return [];
    const out: StudioProperty[] = [];
    this.eachProperty(target, (p) => {
      const kind = propertyKind(p);
      // A Trigglow overlay's address is the account's, never edited by hand.
      if (!kind || !p.visible || (meta.trigglow && !filter && p.name === 'url')) return;
      const d = p.details ?? {};
      out.push({
        name: p.name,
        label: ownBrand(p.description || p.name),
        kind,
        value: p.value,
        enabled: p.enabled,
        ...(p.longDescription ? { hint: ownBrand(p.longDescription) } : {}),
        // Lists of other sources show their names, not their engine ids.
        ...(kind === 'list' ? { items: (d.items ?? []).slice(0, 500).map((o) => ({ value: o.value, name: ownBrand(this.displayOf.get(String(o.value)) ?? String(o.name ?? '')) })) } : {}),
        ...(kind === 'int' || kind === 'float' || kind === 'slider' ? { min: d.min, max: d.max, step: d.step } : {}),
        ...(kind === 'path' || kind === 'files' ? { pathType: d.type ?? 0, filter: d.filter ?? '', defaultPath: d.defaultPath ?? '' } : {}),
      });
    });
    return out;
  }

  /** Changes some properties; only names the source really has, with values of the right shape, are passed to libobs. */
  updateProperties(name: string, changes: Record<string, unknown>, filter?: string): StudioProperty[] {
    this.live();
    const target = this.configurable(name, filter);
    if (!target) return [];
    const allowed = new Map(this.properties(name, filter).map((p) => [p.name, p.kind]));
    const clean: Settings = {};
    for (const [k, v] of Object.entries(changes ?? {})) {
      const kind = allowed.get(k);
      const value = kind ? cleanPropertyValue(kind, v) : undefined;
      if (value !== undefined) clean[k] = value;
    }
    if (Object.keys(clean).length) {
      target.update(clean);
      this.save();
    }
    return this.properties(name, filter); // lists can change with the new values (e.g. a window list after picking a mode)
  }

  /** Presses a button property (a browser source's "Refresh cache", a media source's "Restart"…). */
  pressButton(name: string, prop: string, filter?: string): StudioProperty[] {
    this.live();
    const target = this.configurable(name, filter);
    if (!target) return [];
    this.eachProperty(target, (p) => {
      if (p.name === prop && p.type === 8 && p.buttonClicked) p.buttonClicked(target);
    });
    this.save();
    return this.properties(name, filter);
  }

  /* ---------------------------- preview, live ---------------------------- */

  /** Draws the preview into `nativeHandle` (a BaseWindow's) at `rect`, in device pixels. */
  /**
   * The editor's preview. Usually the program view (the frame libobs already rendered: no extra cost, like OBS);
   * the editor's own view of the scene being edited (editWrap: a second render of it) only when that differs from
   * program, in studio mode or while the delay runs. The other one stays at 0×0, which libobs doesn't draw.
   */
  attachPreview(nativeHandle: Buffer, rect: { x: number; y: number; width: number; height: number }): void {
    if (!this.video || !this.alive()) return;
    this.previewHandle = nativeHandle;
    this.previewRect = rect;
    this.placePreview();
  }

  private placePreview() {
    const rect = this.previewRect;
    if (!rect || !this.previewHandle || !this.video || !this.alive()) return;
    const n = this.osn!.NodeObs;
    const edit = this.studioMode || this.delayBusy;
    const name = edit ? 'trigglow-studio-edit' : 'trigglow-studio-preview';
    if (!this.displays.has(name)) {
      if (edit) n.OBS_content_createSourcePreviewDisplay(this.previewHandle, this.editWrap!.name, name, false, this.video);
      else n.OBS_content_createDisplay(this.previewHandle, name, 0, false, this.video);
      n.OBS_content_setPaddingColor(name, 17, 15, 19); // #110f13, the app background
      n.OBS_content_setShouldDrawUI(name, false); // the selection is drawn by our layer over the preview (studio-overlay.html)
      this.displays.add(name);
    }
    for (const other of this.displays) if (other !== name) n.OBS_content_resizeDisplay(other, 0, 0);
    n.OBS_content_moveDisplay(name, rect.x, rect.y);
    n.OBS_content_resizeDisplay(name, rect.width, rect.height);
    this.display = name;
  }

  /** Studio mode's program view, next to the preview (same rules: never destroyed, hidden at 0×0). */
  attachProgram(nativeHandle: Buffer, rect: { x: number; y: number; width: number; height: number } | null): void {
    if (!this.video || !this.alive()) return;
    const n = this.osn!.NodeObs;
    if (!rect) {
      if (this.programDisplay) n.OBS_content_resizeDisplay(this.programDisplay, 0, 0);
      return;
    }
    if (!this.programDisplay) {
      this.programDisplay = 'trigglow-studio-program';
      n.OBS_content_createDisplay(nativeHandle, this.programDisplay, 0, false, this.video);
      n.OBS_content_setPaddingColor(this.programDisplay, 17, 15, 19);
      n.OBS_content_setShouldDrawUI(this.programDisplay, false);
    }
    n.OBS_content_moveDisplay(this.programDisplay, rect.x, rect.y);
    n.OBS_content_resizeDisplay(this.programDisplay, rect.width, rect.height);
  }

  /**
   * A projector (OBS's): program, a scene or a source, drawn in a window of its own. Created once per key and then
   * only moved, resized or hidden (0×0), like the preview: destroying a display from here can deadlock the engine.
   * false when the target is gone.
   */
  attachProjector(key: string, nativeHandle: Buffer, target: { kind: 'program' } | { kind: 'scene' | 'source'; name: string }, size: { width: number; height: number }): boolean {
    if (!this.video || !this.alive()) return false;
    const n = this.osn!.NodeObs;
    let display = this.projectors.get(key);
    if (!display) {
      display = `trigglow-projector-${this.projectors.size + 1}`;
      if (target.kind === 'program') n.OBS_content_createDisplay(nativeHandle, display, 0, false, this.video);
      else {
        const engineName = target.kind === 'scene' ? this.scenes.get(target.name)?.name : this.inputs.get(target.name)?.name;
        if (!engineName) return false;
        n.OBS_content_createSourcePreviewDisplay(nativeHandle, engineName, display, false, this.video);
      }
      n.OBS_content_setPaddingColor(display, 0, 0, 0);
      n.OBS_content_setShouldDrawUI(display, false);
      this.projectors.set(key, display);
    }
    n.OBS_content_moveDisplay(display, 0, 0);
    n.OBS_content_resizeDisplay(display, size.width, size.height);
    return true;
  }

  hideProjector(key: string): void {
    const display = this.projectors.get(key);
    if (display && this.alive()) this.osn!.NodeObs.OBS_content_resizeDisplay(display, 0, 0);
  }

  /**
   * Hides the preview by shrinking it to nothing (the engine skips drawing a 0×0 display). Never destroys it while the
   * app runs: OBS_content_destroyDisplay called from the main process deadlocks, because the engine waits on our
   * window thread while that thread waits on the engine (reproduced 2026-11-01).
   */
  hidePreview(): void {
    this.previewRect = null;
    if (!this.alive()) return;
    for (const name of this.displays) this.osn!.NodeObs.OBS_content_resizeDisplay(name, 0, 0);
  }

  /* ------------------------------ settings ------------------------------ */

  /** The output size: the chosen one, never above the canvas (a 1440p output on a 1080p canvas would only upscale). */
  private outputFits() {
    const out = outputSize(this.settings);
    return out.height <= this.canvas.height ? out : { ...this.canvas };
  }

  private applyVideo() {
    if (!this.video) return;
    const { width, height } = this.outputFits();
    const fps = fpsOf(this.settings.fps);
    this.video.video = {
      fpsNum: fps.num,
      fpsDen: fps.den,
      baseWidth: this.canvas.width,
      baseHeight: this.canvas.height,
      outputWidth: width,
      outputHeight: height,
      outputFormat: VIDEO_FORMATS[this.settings.colorFormat],
      colorspace: COLOR_SPACES[this.settings.colorSpace],
      range: COLOR_RANGES[this.settings.colorRange],
      scaleType: SCALE_TYPES[this.settings.scaleFilter],
      fpsType: fps.den === 1 ? 1 : 2, // integer or fractional
    };
  }

  /**
   * Monitoring device and ducking; sample rate and channels only when the engine starts (`atStart`): resetting
   * libobs' audio with sources alive crashed the engine (seen 2026-11-02), and OBS too asks for a restart for them.
   */
  private applyAudioSettings(atStart = false) {
    const a = this.osn!.Audio;
    if (atStart) {
      const ctx = { sampleRate: this.settings.sampleRate, speakers: SPEAKERS[this.settings.channels] };
      const now = a.audioContext;
      if (now.sampleRate !== ctx.sampleRate || now.speakers !== ctx.speakers) a.audioContext = ctx;
      this.startedAudio = { sampleRate: this.settings.sampleRate, channels: this.settings.channels };
    }
    const dev = this.settings.monitoringDevice === 'default' ? null : a.monitoringDevices.find((d) => d.id === this.settings.monitoringDevice);
    const want = dev ?? a.monitoringDevices.find((d) => d.id === 'default') ?? { name: 'Default', id: 'default' };
    if (a.monitoringDevice.id !== want.id) a.monitoringDevice = want;
    if (a.disableAudioDucking !== this.settings.disableDucking) a.disableAudioDucking = this.settings.disableDucking;
  }

  /** Audio devices of this PC (OBS's device lists), from a scratch capture's own `device_id` list. */
  audioDevices(kind: 'input' | 'output'): { id: string; name: string }[] {
    if (!this.alive()) return [];
    // A normal (named) scratch source: OSN's createPrivate blocked here (seen 2026-11-02). Removed right after.
    const probe = this.osn!.InputFactory.create(kind === 'input' ? 'wasapi_input_capture' : 'wasapi_output_capture', `studio-device-probe-${kind}`, { device_id: 'default' });
    try {
      let p = probe.properties?.first() ?? null;
      for (let guard = 0; p && guard < 50; guard++) {
        if (p.name === 'device_id') return (p.details?.items ?? []).map((o) => ({ id: String(o.value), name: String(o.name ?? o.value) }));
        if (p.is_last()) break;
        p = p.next();
      }
      return [];
    } finally {
      probe.remove();
      probe.release();
    }
  }

  /** The global audio channels (1–2 desktop, 3–6 mic/aux, like OBS's Settings → Audio) and the device each uses. */
  globalAudio(): { channel: number; name: string; device: string | null }[] {
    const c = this.collection;
    return [1, 2, 3, 4, 5, 6].map((channel) => {
      const s = c?.sources.find((x) => x.channel === channel);
      return { channel, name: s?.name ?? '', device: s ? String(s.settings.device_id ?? 'default') : null };
    });
  }

  /** Points a global channel at a device, adds it (`name` for a new one) or turns it off (`device` null). */
  setGlobalAudio(channel: number, device: string | null, name: string) {
    this.live();
    const c = this.collection!;
    if (!Number.isInteger(channel) || channel < 1 || channel > 6) return;
    const meta = c.sources.find((x) => x.channel === channel);
    if (device === null) {
      if (!meta) return;
      const input = this.inputs.get(meta.name);
      this.osn!.Global.setOutputSource(channel, null);
      this.dropAudio(meta.name);
      this.inputs.delete(meta.name);
      this.displayOf.delete(meta.id);
      c.sources = c.sources.filter((x) => x !== meta);
      input?.remove();
      input?.release();
    } else if (meta) {
      this.inputs.get(meta.name)?.update({ device_id: device.slice(0, 300) });
    } else {
      const s: SavedSource = { id: newId('src'), name: this.freeName(name, name || 'Audio'), type: channel <= 2 ? 'wasapi_output_capture' : 'wasapi_input_capture', settings: { device_id: device.slice(0, 300) }, volume: 1, muted: false, channel };
      c.sources.push(s);
      this.createInput(s);
    }
    this.save();
  }

  /** Devices monitored audio can play on (OBS's Settings → Audio → Monitoring device). */
  monitoringDevices(): { id: string; name: string }[] {
    return this.alive() ? this.osn!.Audio.monitoringDevices.map((d) => ({ id: d.id, name: d.name })) : [];
  }

  /** This PC's network interfaces (name → IP), for "Bind to IP". */
  networkInterfaces(): Record<string, string> {
    if (!this.alive()) return {};
    try {
      return { ...this.osn!.NetworkFactory.create().networkInterfaces };
    } catch {
      return {};
    }
  }

  private applyTransition() {
    this.transitionKey = '';
    this.useTransition('default', this.settings);
  }

  /** Makes `spec` the program's transition, showing what program shows now; rebuilt only when `key` changes. */
  private useTransition(key: string, spec: Pick<StudioSettings, 'transition' | 'stingerFile' | 'stingerPointMs'>) {
    if (key === this.transitionKey && this.transition) return;
    const osn = this.osn!;
    const scene = this.scenes.get(this.collection!.current)!;
    const old = this.transition;
    this.transition = osn.TransitionFactory.create(...transitionOf(spec));
    // While the delay runs, program is the plugin's (its wrapper or loading scene): the new transition keeps it.
    const shown = this.delayBusy && old ? old.getActiveSource() : null;
    this.transition.set(shown ?? this.programScene ?? scene);
    osn.Global.setOutputSource(0, this.transition);
    old?.release();
    this.transitionKey = key;
  }

  /** A scene's own transition (null = the one in Settings). */
  setSceneTransition(name: string, value: { type?: unknown; ms?: unknown } | null) {
    this.live();
    const meta = this.collection!.scenes.find((s) => s.name === name);
    if (!meta) throw new Error('studio: no such scene');
    if (!value) delete meta.transition;
    else if (typeof value.type === 'string' && (TRANSITIONS as readonly string[]).includes(value.type)) {
      const ms = Number(value.ms);
      meta.transition = { type: value.type as SceneTransition['type'], ms: Number.isFinite(ms) ? Math.round(Math.min(5000, Math.max(50, ms))) : this.settings.transitionMs };
    }
    this.save();
  }

  /* ------------------------------- shortcuts ------------------------------- */

  /**
   * What can have a shortcut, for Settings → Hotkeys: each scene (switch to it), each item of each scene (show, hide)
   * and each source with sound (mute, unmute, push to talk, push to mute). Keys as in CollectionHotkeys.
   */
  hotkeyTargets(): { scenes: { name: string; key: string; items: { label: string; show: string; hide: string }[] }[]; audio: { name: string; mute: string; unmute: string; ptt: string; ptm: string }[]; values: Record<string, string> } {
    const c = this.collection;
    if (!c) return { scenes: [], audio: [], values: {} };
    const idOf = (name: string) => c.sources.find((s) => s.name === name)?.id ?? c.scenes.find((s) => s.name === name)?.id;
    return {
      scenes: c.scenes.map((sc) => ({
        name: sc.name,
        key: `scene:${sc.id}`,
        items: [...new Set(sc.items.map((it) => it.source))].flatMap((src) => {
          const id = idOf(src);
          return id ? [{ label: src, show: `show:${sc.id}:${id}`, hide: `hide:${sc.id}:${id}` }] : [];
        }),
      })),
      audio: c.sources.filter((s) => s.channel || AUDIO_TYPES.has(s.type)).map((s) => ({ name: s.name, mute: `mute:${s.id}`, unmute: `unmute:${s.id}`, ptt: `ptt:${s.id}`, ptm: `ptm:${s.id}` })),
      values: { ...(c.hotkeys ?? {}) },
    };
  }

  /** Sets one shortcut ('' clears it). False when it isn't a valid combination for that kind. */
  setHotkey(key: string, accelerator: string): boolean {
    const c = this.collection!;
    const hotkeys = { ...(c.hotkeys ?? {}) };
    if (accelerator === '') delete hotkeys[key];
    else {
      const clean = cleanHotkeys({ [key]: accelerator });
      if (!clean[key]) return false;
      hotkeys[key] = clean[key];
    }
    c.hotkeys = hotkeys;
    this.save();
    return true;
  }

  /** The collection's shortcuts whose target still exists: pressed ones (global shortcuts) and held ones (polled). */
  collectionHotkeys(): { pressed: { key: string; accelerator: string }[]; held: { key: string; accelerator: string }[] } {
    const out = { pressed: [] as { key: string; accelerator: string }[], held: [] as { key: string; accelerator: string }[] };
    for (const [key, accelerator] of Object.entries(this.collection?.hotkeys ?? {})) {
      if (!this.hotkeyTarget(key)) continue;
      (isHeldHotkey(key) ? out.held : out.pressed).push({ key, accelerator });
    }
    return out;
  }

  private hotkeyTarget(key: string): { scene?: string; source?: string } | null {
    const c = this.collection;
    if (!c) return null;
    const [kind, a, b] = key.split(':');
    const scene = (id: string) => c.scenes.find((s) => s.id === id)?.name;
    const source = (id: string) => c.sources.find((s) => s.id === id)?.name ?? scene(id);
    if (kind === 'scene') return scene(a) ? { scene: scene(a) } : null;
    if (kind === 'show' || kind === 'hide') return scene(a) && source(b) ? { scene: scene(a), source: source(b) } : null;
    return c.sources.some((s) => s.id === a) ? { source: source(a) } : null;
  }

  /** A pressed shortcut: switch scene, show or hide an item, mute or unmute. */
  runHotkey(key: string) {
    if (!this.alive()) return;
    const t = this.hotkeyTarget(key);
    if (!t) return;
    const kind = key.split(':')[0];
    if (kind === 'scene') this.selectScene(t.scene!);
    else if (kind === 'show' || kind === 'hide') this.setVisibleIn(t.scene!, t.source!, kind === 'show');
    else if (kind === 'mute' || kind === 'unmute') this.setMuted(t.source!, kind === 'mute');
  }

  /** A held shortcut went down or up: push to talk speaks while held, push to mute is silent while held. */
  holdHotkey(key: string, down: boolean) {
    if (!this.alive()) return;
    const t = this.hotkeyTarget(key);
    if (!t?.source) return;
    this.setMuted(t.source, key.startsWith('ptt:') ? !down : down);
  }

  /* -------------------------------- folders -------------------------------- */

  /** Puts these items (of the current scene) in a new folder, together in the list where the top one is. */
  addFolder(itemIds: number[], wanted: unknown): string {
    this.live();
    const c = this.collection!;
    const scene = this.scenes.get(c.current)!;
    const meta = c.scenes.find((s) => s.name === c.current)!;
    const items = scene.getItems().filter((i) => itemIds.includes(i.id));
    if (!items.length) throw new Error('studio: no such item');
    const id = `fld-${randomBytes(6).toString('hex')}`;
    const name = cleanName(wanted) ?? 'Folder';
    meta.folders = [...(meta.folders ?? []), { id, name }];
    for (const item of items) this.folderOf.set(this.itemKey(scene, item), id);
    this.keepFolderTogether(scene, id);
    this.save();
    return id;
  }

  /** Folder actions: rename, fold/unfold, show/hide or lock/unlock everything in it, or ungroup (the items stay). */
  folderAction(folder: string, action: 'rename' | 'toggle' | 'show' | 'hide' | 'lock' | 'unlock' | 'ungroup', value?: unknown) {
    this.live();
    const c = this.collection!;
    const scene = this.scenes.get(c.current)!;
    const meta = c.scenes.find((s) => s.name === c.current)!;
    const f = meta.folders?.find((x) => x.id === folder);
    if (!f) throw new Error('studio: no such folder');
    const members = scene.getItems().filter((i) => this.folderOf.get(this.itemKey(scene, i)) === folder);
    if (action === 'rename') f.name = cleanName(value) ?? f.name;
    if (action === 'toggle') f.closed = !f.closed || undefined;
    for (const item of members) {
      const key = this.itemKey(scene, item);
      if (action === 'show' || action === 'hide') item.visible = action === 'show';
      if (action === 'lock') this.locked.add(key);
      if (action === 'unlock') this.locked.delete(key);
      if (action === 'ungroup') this.folderOf.delete(key);
    }
    if (action === 'ungroup') meta.folders = meta.folders!.filter((x) => x !== f);
    this.save();
  }

  /** Into a folder (null = out of it). It moves next to the folder's other items. */
  setItemFolder(id: number, folder: string | null) {
    const item = this.item(id);
    const c = this.collection!;
    const scene = this.scenes.get(c.current)!;
    const key = this.itemKey(scene, item);
    if (folder === null) this.folderOf.delete(key);
    else {
      if (!c.scenes.find((s) => s.name === c.current)?.folders?.some((f) => f.id === folder)) throw new Error('studio: no such folder');
      this.folderOf.set(key, folder);
      this.keepFolderTogether(scene, folder);
    }
    this.save();
  }

  /** A folder's items sit together in the list: the rest of them move right under the topmost one. */
  private keepFolderTogether(scene: Scene, folder: string) {
    const inFolder = (i: SceneItem) => this.folderOf.get(this.itemKey(scene, i)) === folder;
    // getItems() is bottom → top; the list shows top first. Read once: right after a move OSN can hand back the old
    // order, so the moves are worked out here, each member stepping up until it sits right under the block.
    const items = scene.getItems();
    const members = items.map((i, n) => (inFolder(i) ? n : -1)).filter((n) => n >= 0);
    if (members.length < 2) return;
    let below = members[members.length - 1]; // the block's lowest position so far
    for (const at of members.slice(0, -1).reverse()) {
      // Moving `at` up to just under the block shifts the items between down by one, never the members below it.
      this.reorder(scene, at, below - 1);
      below -= 1;
    }
  }

  /** Encoders this PC can use for the stream (libobs ids), for the settings panel. */
  encoders(): string[] {
    if (!this.alive()) return [];
    const have = this.osn!.VideoEncoderFactory.types();
    return [...ENCODERS, ...MODERN_ENCODERS].filter((id) => have.includes(id));
  }

  /**
   * New output settings. Video size, encoder and bitrate can't change mid-stream or mid-recording: they're kept
   * for the next one (returns false); the transition applies right away.
   */
  setSettings(next: StudioSettings): boolean {
    const prev = this.settings;
    this.settings = next;
    if (!this.alive()) return true;
    if (next.transition !== prev.transition || next.stingerFile !== prev.stingerFile || next.stingerPointMs !== prev.stingerPointMs) this.applyTransition();
    if (this.delayCtl) this.delayCall(); // the plugin's settings (a new delay or quality while it runs refills)
    if (next.processPriority !== prev.processPriority) this.applyPriority();
    if (this.streaming || this.recording) return !PIPELINE_KEYS.some((k) => JSON.stringify(next[k]) !== JSON.stringify(prev[k]));
    // Only the replay buffer running: it restarts with the new settings (what it held so far is lost, like in OBS).
    const replay = this.replayActive;
    if (replay) this.stopReplayNow();
    this.applyVideo();
    try {
      this.applyAudioSettings();
    } catch (err) {
      console.warn('[studio] audio settings', err);
    }
    this.dropOutputs(); // rebuilt with the new encoder settings next time
    if (replay) this.startReplay();
    return true;
  }

  /* ---------------------------- stream, record ---------------------------- */

  private encoderId() {
    const have = this.osn!.VideoEncoderFactory.types();
    return this.settings.encoder !== 'auto' && have.includes(this.settings.encoder) ? this.settings.encoder : pickEncoder(have);
  }

  /** The output both the stream and recordings hang off (OSN records through a streaming instance, like Streamlabs). */
  private ensureOutput(): Streaming {
    if (this.output) return this.output;
    const osn = this.osn!;
    const encoder = this.encoderId();
    const out = osn.SimpleStreamingFactory.create();
    out.video = this.video!;
    // CBR with 2 s keyframes: what platforms ask for, and what the multistream relay copies as-is.
    out.videoEncoder = osn.VideoEncoderFactory.create(encoder, 'studio-video', this.encoderSettingsFor(encoder));
    out.audioEncoder = osn.AudioEncoderFactory.create('ffmpeg_aac', 'studio-audio');
    out.audioEncoder.bitrate = this.settings.audioBitrate;
    const reconnect = osn.ReconnectFactory.create();
    reconnect.enabled = this.settings.reconnect;
    reconnect.retryDelay = this.settings.reconnectDelay;
    reconnect.maxRetries = this.settings.reconnectRetries;
    out.reconnect = reconnect;
    const delay = osn.DelayFactory.create();
    delay.enabled = this.settings.delay;
    delay.delaySec = this.settings.delaySec;
    delay.preserveDelay = this.settings.delayPreserve;
    out.delay = delay;
    const net = osn.NetworkFactory.create();
    net.bindIP = this.settings.bindIP;
    net.enableDynamicBitrate = this.settings.dynamicBitrate;
    net.enableLowLatency = this.settings.lowLatency;
    net.enableOptimizations = this.settings.networkOptimizations;
    out.network = net;
    out.signalHandler = (s) => {
      if (s.signal === 'start' || s.signal === 'activate') this.streaming = true;
      if (s.signal === 'stop' || s.signal === 'deactivate') this.streaming = false;
      this.onSignal?.({ output: 'stream', signal: s.signal, code: s.code, error: s.error });
    };
    this.output = out;
    this.outputEncoder = encoder;
    return out;
  }

  /**
   * What the stream's encoder starts with: CBR with 2 s keyframes (what platforms ask for, and what the multistream
   * relay copies as-is), then whatever its properties window changed, then the bitrate Trigglow keeps itself.
   */
  private encoderSettingsFor(id: string): Settings {
    // Each encoder names its presets its own way: x264 "veryfast", NVENC "p5" (the new one calls it preset2).
    const preset = id === 'obs_x264' ? { preset: 'veryfast' } : id.startsWith('jim_') ? { preset2: 'p5' } : id.includes('nvenc') ? { preset: 'p5' } : {};
    return { rate_control: 'CBR', keyint_sec: 2, ...preset, ...(this.settings.encoderSettings[id] ?? {}), bitrate: this.settings.bitrate };
  }

  /** The encoder's own properties window (OBS's advanced output): read from a scratch encoder with these settings. */
  encoderProperties(id: string, settings: EncoderSettings): StudioProperty[] {
    this.live();
    if (!this.osn!.VideoEncoderFactory.types().includes(id)) return [];
    const enc = this.osn!.VideoEncoderFactory.create(id, 'studio-encoder-props', { ...this.encoderSettingsFor(id), ...settings });
    try {
      const out: StudioProperty[] = [];
      let p = enc.properties?.first() ?? null;
      for (let guard = 0; p && guard < 200; guard++) {
        const kind = propertyKind(p);
        // The bitrate is Trigglow's own field (Settings → Stream); everything else is the encoder's.
        if (kind && p.visible && p.name !== 'bitrate') {
          const d = p.details ?? {};
          out.push({
            name: p.name,
            label: ownBrand(p.description || p.name),
            kind,
            value: p.value,
            enabled: p.enabled,
            ...(kind === 'list' ? { items: (d.items ?? []).slice(0, 200).map((o) => ({ value: o.value, name: ownBrand(String(o.name ?? '')) })) } : {}),
            ...(kind === 'int' || kind === 'float' || kind === 'slider' ? { min: d.min, max: d.max, step: d.step } : {}),
          });
        }
        if (p.is_last()) break;
        p = p.next();
      }
      return out;
    } finally {
      enc.release();
    }
  }

  /** Throws away idle outputs so the next stream or recording uses the current settings. */
  private dropOutputs() {
    if (this.streaming || this.recording || this.replayActive) return;
    if (this.replay) {
      this.osn!.SimpleReplayBufferFactory.destroy(this.replay);
      this.replay = null;
    }
    if (this.recorder) {
      this.osn!.SimpleRecordingFactory.destroy(this.recorder);
      this.recorder = null;
    }
    if (this.multitrack) {
      this.osn!.AdvancedRecordingFactory.destroy(this.multitrack as unknown as AdvancedRecording);
      this.multitrack = null;
    }
    if (this.output) {
      this.osn!.SimpleStreamingFactory.destroy(this.output);
      this.output = null;
    }
  }

  /** Goes live to `target` (main.ts reads it from the API right before). Returns the encoder used. */
  startStream(target: { server: string; key: string }): { encoder: string } {
    if (!this.video) throw new Error('studio: engine not running');
    this.live();
    if (this.streaming) throw new Error('studio: already live');
    const out = this.ensureOutput();
    out.service = this.osn!.ServiceFactory.create('rtmp_custom', 'studio-service', { server: target.server, key: target.key });
    this.delayOutputStarting();
    out.start();
    return { encoder: this.outputEncoder };
  }

  stopStream(): void {
    if (this.streaming && this.alive()) this.output?.stop();
  }

  /** The recording output (shares the stream's encoder); the replay buffer hangs off it too. */
  /** The recording output: multitrack when the recording keeps more than track 1, else the simple one. */
  private ensureRecorder(): Recording {
    const rec = this.settings.recordTracks !== 1 ? (this.multitrack ?? this.multitrackRecorder()) : this.ensureSimpleRecorder();
    rec.path = this.settings.recordFolder;
    rec.format = this.settings.recordFormat;
    rec.enableFileSplit = this.settings.splitMode !== 'off';
    rec.splitType = this.settings.splitMode === 'size' ? 1 : 0; // ERecSplitType: Time, Size
    rec.splitTime = this.settings.splitMinutes;
    rec.splitSize = this.settings.splitMB;
    return rec;
  }

  /** The simple recording output (the replay buffer always hangs off this one). */
  private ensureSimpleRecorder(): Recording {
    const out = this.ensureOutput();
    if (!this.recorder) {
      const rec = this.osn!.SimpleRecordingFactory.create();
      rec.streaming = out;
      rec.video = this.video!;
      const quality = RECORD_QUALITY[this.settings.recordQuality];
      rec.quality = quality; // 0 = "same as stream": shares the stream's encoder (no second encode)
      // Its own encoder, set up by the engine for that quality level (as Streamlabs does: no settings of ours).
      if (quality !== 0) rec.videoEncoder = this.osn!.VideoEncoderFactory.create(this.encoderId(), 'studio-record-video');
      rec.audioEncoder = this.osn!.AudioEncoderFactory.create('ffmpeg_aac', 'studio-record-audio');
      rec.audioEncoder.bitrate = 192;
      rec.overwrite = false;
      rec.noSpace = false;
      rec.signalHandler = (s) => {
        if (s.signal === 'start') this.recording = true;
        if (s.signal === 'stop') this.recording = false;
        const file = s.signal === 'stop' ? rec.lastFile() : undefined;
        this.onSignal?.({ output: 'record', signal: s.signal, code: s.code, error: s.error, ...(file ? { file } : {}) });
        if (file && s.code === 0 && this.settings.remux) this.remux(file);
      };
      this.recorder = rec;
    }
    return this.recorder;
  }

  /**
   * OBS's multitrack recording (Advanced output): every chosen audio track in the file, with its own video encoder
   * at the stream's settings. The stream itself stays on track 1.
   */
  private multitrackRecorder(): Recording {
    const osn = this.osn!;
    const rec = osn.AdvancedRecordingFactory.create();
    rec.video = this.video!;
    rec.useStreamEncoders = false;
    rec.rescaling = false;
    rec.videoEncoder = osn.VideoEncoderFactory.create(this.encoderId(), 'studio-record-video', this.encoderSettingsFor(this.encoderId()));
    for (let i = 0; i < 6; i++) osn.AudioTrackFactory.setAtIndex(osn.AudioTrackFactory.create(this.settings.audioBitrate, `Track ${i + 1}`), i + 1);
    rec.mixer = this.settings.recordTracks;
    rec.overwrite = false;
    rec.noSpace = false;
    rec.signalHandler = (s) => {
      if (s.signal === 'start') this.recording = true;
      if (s.signal === 'stop') this.recording = false;
      const file = s.signal === 'stop' ? rec.lastFile() : undefined;
      this.onSignal?.({ output: 'record', signal: s.signal, code: s.code, error: s.error, ...(file ? { file } : {}) });
      if (file && s.code === 0 && this.settings.remux) this.remux(file);
    };
    this.multitrack = rec as unknown as Recording;
    return this.multitrack;
  }

  /**
   * OBS's "Automatically remux to mp4": an mkv / flv / ts recording also gets an mp4 copy (the original stays), with
   * the engine's own ffmpeg, without re-encoding. Signals `remuxed` (with the mp4) or `remux_failed`.
   */
  private remux(file: string) {
    if (!/\.(mkv|flv|ts)$/i.test(file)) return;
    const out = file.replace(/\.(mkv|flv|ts)$/i, '.mp4');
    if (fs.existsSync(out)) return;
    execFile(path.join(OSN_DIR, 'ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0', '-c', 'copy', '-movflags', '+faststart', out], { windowsHide: true, timeout: 30 * 60_000 }, (err) => {
      if (err) fs.rm(out, { force: true }, () => undefined);
      this.onSignal?.({ output: 'record', signal: err ? 'remux_failed' : 'remuxed', code: err ? 1 : 0, error: err ? String(err.message).slice(0, 200) : '', file: err ? file : out });
    });
  }

  /** Records the program to the saved folder (mkv or mp4), with the stream's encoder (one encode for both). */
  startRecording(): void {
    if (!this.video) throw new Error('studio: engine not running');
    this.live();
    if (this.recording) return;
    fs.mkdirSync(this.settings.recordFolder, { recursive: true });
    this.activeRecorder = this.ensureRecorder();
    this.delayOutputStarting();
    this.activeRecorder.start();
  }

  /**
   * Starts the replay buffer: the last `replaySeconds` of the program kept in memory, saved to the recordings folder
   * on demand (clips). Shares the stream's encoder, like Streamlabs, so it costs no second encode.
   */
  startReplay(): void {
    if (!this.video) throw new Error('studio: engine not running');
    this.live();
    if (this.replayActive) return;
    fs.mkdirSync(this.settings.recordFolder, { recursive: true });
    const rec = this.ensureSimpleRecorder();
    if (!this.replay) {
      const rb = this.osn!.SimpleReplayBufferFactory.create();
      rb.streaming = this.output!;
      rb.recording = rec;
      rb.video = this.video;
      rb.prefix = 'Replay';
      rb.usesStream = true;
      rb.overwrite = false;
      rb.noSpace = false;
      rb.signalHandler = (sig) => {
        if (sig.signal === 'start') this.replayActive = true;
        if (sig.signal === 'stop') this.replayActive = false;
        if (sig.signal === 'wrote' || sig.signal === 'writing_error' || sig.signal === 'stop') {
          const file = sig.signal === 'wrote' ? rb.lastFile() : null;
          for (const w of this.replayWaiters.splice(0)) w(file);
        }
        this.onSignal?.({ output: 'replay', signal: sig.signal, code: sig.code, error: sig.error, ...(sig.signal === 'wrote' ? { file: rb.lastFile() } : {}) });
      };
      this.replay = rb;
    }
    this.replay.path = this.settings.recordFolder;
    this.replay.format = this.settings.recordFormat;
    this.replay.duration = this.replaySeconds;
    this.delayOutputStarting();
    this.replay.start();
    this.replayActive = true; // the start signal confirms it; meanwhile a second start must not stack
  }

  private stopReplayNow() {
    this.replay?.stop(true);
    this.replayActive = false;
  }

  stopReplay(): void {
    if (this.replayActive && this.alive()) this.stopReplayNow();
  }

  /** A new length: a running buffer restarts with it (what it held is lost, like in OBS). */
  setReplaySeconds(seconds: number): void {
    this.replaySeconds = Math.round(Math.min(600, Math.max(5, seconds)));
    if (!this.replayActive || !this.alive()) return;
    this.stopReplayNow();
    this.startReplay();
  }

  /** Saves what the replay buffer holds; resolves with the file written. */
  saveReplay(timeoutMs = 15_000): Promise<string> {
    this.live();
    if (!this.replayActive || !this.replay) return Promise.reject(new Error('replay_inactive'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.replayWaiters = this.replayWaiters.filter((w) => w !== done);
        reject(new Error('timeout'));
      }, timeoutMs);
      const done = (file: string | null) => {
        clearTimeout(timer);
        if (file) resolve(file);
        else reject(new Error('save_failed'));
      };
      this.replayWaiters.push(done);
      this.replay!.save();
    });
  }

  stopRecording(): void {
    if (this.recording && this.alive()) (this.activeRecorder ?? this.recorder)?.stop();
  }

  /** Writes a PNG of the program (canvas size) into `dir`; resolves with its path. */
  async screenshot(dir: string): Promise<string> {
    this.live();
    fs.mkdirSync(dir, { recursive: true });
    const take = this.osn!.NodeObs.OBS_content_takeScreenshot as (video: Video, dir: string, format: string, noSpace?: boolean) => Promise<{ path: string }>;
    const r = await take(this.video!, dir, 'frame-%CCYY%MM%DD-%hh%mm%ss', false);
    return r.path;
  }

  stats(): StudioStats | null {
    if (!this.video || !this.alive()) return null;
    const g = this.osn!.Global;
    return {
      fps: g.currentFrameRate,
      renderMs: g.averageFrameRenderTime,
      laggedFrames: g.laggedFrames,
      skippedFrames: this.video.skippedFrames,
      engineCpu: g.cpuPercentage,
      engineMemMB: g.memoryUsage,
      streaming: this.streaming,
      recording: this.recording,
      droppedFrames: this.streaming ? (this.output?.droppedFrames ?? 0) : 0,
      kbps: this.streaming ? Math.round(this.output?.kbitsPerSec ?? 0) : 0,
      delay: this.delayView(),
    };
  }

  /**
   * OBS's auto-configuration wizard, through the engine's own optimizer: it tests this PC's encoders and, on Twitch
   * (with the key), the real bandwidth with a bandwidth test that never goes live; elsewhere it estimates. Returns
   * settings to apply (output size, fps, bitrate, encoder) and whether the bandwidth was measured.
   */
  async autoConfigure(target: { platform: 'twitch' | 'youtube' | 'multistream' | 'custom'; server?: string; key?: string }): Promise<{ output: string; fps: number; bitrate: number; encoder: string; measured: boolean; confidence: string }> {
    this.live();
    if (this.streaming || this.recording) throw new Error('studio_busy');
    const s = this.settings;
    const encoder = this.encoderId();
    const twitchProbe = target.platform === 'twitch' && target.server && target.key;
    const setup = target.platform === 'multistream' ? 'cloud-multistream' : target.platform === 'custom' ? 'custom-rtmp' : 'direct-single';
    const request = {
      streamSetup: setup,
      outputs: [
        {
          outputId: 'main',
          display: 'horizontal',
          outputKind: 'standard',
          destinations: [target.platform === 'multistream' ? 'custom' : target.platform],
          // What to aim for: each platform's usual best (1080p60 or the canvas if smaller), then the PC and the
          // connection bring it down. Starting from the current settings would never suggest going up.
          current: { width: Math.min(1920, this.canvas.width), height: Math.min(1080, this.canvas.height), fpsNum: 60, fpsDen: 1, bitrateKbps: target.platform === 'youtube' ? 9000 : 6000, encoderId: encoder },
          limits: { maxWidth: this.canvas.width, maxHeight: this.canvas.height },
          ...(twitchProbe
            ? { probes: [{ id: 'twitch', kind: 'twitch-standard', server: target.server, streamKey: target.key }] }
            : { estimateReason: setup === 'cloud-multistream' ? 'cloud_multistream' : setup === 'custom-rtmp' ? 'custom_rtmp' : 'non_twitch' }),
        },
      ],
    };
    const optimizer = this.osn!.NodeObs.AutoOptimizer as unknown as { run(r: unknown, cb: (e: unknown) => void): { result: Promise<{ status: string; error?: { code: string }; outputs: { videos: { width: number; height: number; fpsNum: number; fpsDen: number }[]; encoding?: { bitrateKbps: number; encoderId: string }; measurement: { mode: string; confidence: string } }[] }> } };
    const result = await optimizer.run(request, () => {}).result;
    const o = result.outputs?.[0];
    if (!o || result.status === 'failed' || result.status === 'cancelled') throw new Error(result.error?.code ?? 'auto_config_failed');
    const v = o.videos[0];
    const size = `${v.width}x${v.height}`;
    const rate = v.fpsNum / v.fpsDen;
    const nearestFps = [...FPS].sort((a, b) => Math.abs(a - rate) - Math.abs(b - rate))[0];
    return {
      output: (OUTPUT_SIZES as readonly string[]).includes(size) ? size : s.output,
      fps: nearestFps,
      bitrate: Math.round(o.encoding?.bitrateKbps ?? s.bitrate),
      encoder: o.encoding && this.encoders().includes(o.encoding.encoderId) ? o.encoding.encoderId : s.encoder,
      measured: o.measurement?.mode === 'active',
      confidence: o.measurement?.confidence ?? 'low',
    };
  }

  /** The Stats window's numbers (once a second while it's open). */
  perf(): StudioPerf | null {
    if (!this.video || !this.alive()) return null;
    const g = this.osn!.Global;
    let p: Record<string, unknown> = {};
    try {
      p = (this.osn!.NodeObs.OBS_API_getPerformanceStatistics() as Record<string, unknown>) ?? {};
    } catch {
      /* the rest still says something */
    }
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const out = this.streaming ? this.output : null;
    return {
      fps: g.currentFrameRate,
      renderMs: g.averageFrameRenderTime,
      cpu: num(p.CPU) || num(g.cpuPercentage),
      memoryMB: g.memoryUsage,
      diskFree: typeof p.diskSpaceAvailable === 'string' ? p.diskSpaceAvailable : '',
      lagged: g.laggedFrames,
      rendered: g.totalFrames,
      skipped: this.video.skippedFrames,
      encoded: this.video.encodedFrames,
      dropped: out?.droppedFrames ?? 0,
      sent: out?.totalFrames ?? 0,
      streaming: this.streaming,
      recording: this.recording,
      streamKbps: Math.round(out?.kbitsPerSec ?? 0),
      streamMB: Math.round((out?.dataOutput ?? 0) * 10) / 10,
      recordKbps: Math.round(num(p.recordingBandwidth)),
      recordMB: Math.round(num(p.recordingDataOutput) * 10) / 10,
    };
  }

  /* ----------------------------- Dynamic Delay ----------------------------- */

  /*
   * The plugin's own controller runs it (obs-trigglow-dynamic-delay's core build: BufferModeController, the same code
   * its OBS dock drives, src/core-host.hpp). Studio only keeps the UI: it creates the plugin's controller source,
   * writes the settings and commands into it and reads the status back (the engine can't call the plugin directly).
   * The plugin's behaviour: a fixed live scene goes out delayed through its "(auto)" wrapper scene with the badge,
   * the loading scene (if any) shows while the buffer fills; another scene picked while the delay runs goes out
   * undelayed, like in OBS. The plugin's scenes and filters are never saved (save() and the editor skip them).
   */

  /** Scenes by id (the Dynamic Delay settings keep scene ids, which survive a rename). */
  sceneIds(): { id: string; name: string }[] {
    return this.collection?.scenes.map((sc) => ({ id: sc.id, name: sc.name })) ?? [];
  }

  /** The plugin's core is installed in the engine (`pnpm studio:delay`). */
  delayAvailable(): boolean {
    if (!this.alive()) return false;
    // Asked once per engine: the bar reads it every second, and the installed plugins don't change while it runs.
    this.delayInstalled ??= this.osn!.InputFactory.types().includes(DELAY_CONTROLLER);
    return this.delayInstalled;
  }
  private delayInstalled: boolean | null = null;

  /** The badge images main.ts draws like the plugin: `<prefix><seconds>.png` (null until known). */
  delayBadgePrefix: string | null = null;

  delayView(): DelayView {
    const off: DelayView = { available: this.delayAvailable(), state: 'off', seconds: this.settings?.dynDelaySeconds ?? 0, effective: 0, endsAt: null, health: null, message: null };
    if (!off.available || !this.delayCtl) return off;
    return this.delayRead(this.delayCall());
  }

  /** Turns the delay on (the plugin's Enable). Throws `delay_live_scene` without a live scene. */
  startDelay(): void {
    this.live();
    if (!this.delayAvailable() || !this.delayCtl) throw new Error('delay_unavailable');
    const st = this.delayCall({ command: 'enable', command_token: ++this.delayToken });
    if (st.status_state === 'error') throw new Error(st.status_message_key === 'Status.ChooseLiveScene' ? 'delay_live_scene' : 'delay_failed');
  }

  /** Back to live (the plugin's Disable): program goes back to the scene shown before it started. */
  stopDelay(): void {
    if (this.delayCtl && this.alive()) this.delayCall({ command: 'disable', command_token: ++this.delayToken });
  }

  toggleDelay(): void {
    if (this.delayView().state === 'off') this.startDelay();
    else this.stopDelay();
  }

  /** The badge images just became available: the plugin redraws the badge. */
  refreshDelayBadge() {
    if (this.delayCtl && this.alive()) this.delayCall({ badge_token: ++this.delayBadgeToken });
  }

  /** An output is about to open its encoder (OBS's STREAMING/RECORDING_STARTING: the buffer's NVENC session steps aside). */
  private delayOutputStarting() {
    if (this.delayBusy && this.delayCtl && this.alive()) this.delayCall({ command: 'output_starting', command_token: ++this.delayToken });
  }

  private delayCtl: Input | null = null;
  private delayToken = 0;
  private delayPoll = 0;
  private delayBadgeToken = 0;
  /** Filling or on, as last read: program belongs to the plugin then. */
  private delayBusy = false;
  private delayWrapper: Scene | null = null;
  private delaySwitchingCollection = false;

  /** The plugin's controller source, once the collection is built (nothing without the core). */
  private delayCreate() {
    this.delayCtl = null;
    this.delayBusy = false;
    this.delayWrapper = null;
    if (this.delayAvailable()) this.delayCtl = this.osn!.InputFactory.createPrivate(DELAY_CONTROLLER, 'trigglow-delay-controller', this.delayConfig());
  }

  /** The engine name of the scene with this id (the engine names scenes by id), or '' when this collection has none. */
  private engineScene(id: string) {
    const sc = id ? this.collection?.scenes.find((x) => x.id === id) : undefined;
    return (sc && this.scenes.get(sc.name)?.name) ?? '';
  }

  /**
   * What the plugin's dock would hold: the settings, the badge images, and the engine's video info (host_*: the plugin
   * can't ask this engine itself, Streamlabs' libobs has another obs_video_info and reading it from a plugin crashes).
   */
  private delayConfig(): Settings {
    const s = this.settings;
    const fps = fpsOf(s.fps);
    const out = this.outputFits();
    return {
      live_scene: this.engineScene(s.dynDelayLive),
      loading_scene: this.engineScene(s.dynDelayLoading),
      delay_seconds: s.dynDelaySeconds,
      min_resolution_height: s.dynDelayQuality,
      show_overlay: s.dynDelayBadge,
      overlay_corner: s.dynDelayCorner,
      badge_prefix: this.delayBadgePrefix ?? '',
      host_fps_num: fps.num,
      host_fps_den: fps.den,
      host_base_width: this.canvas.width,
      host_base_height: this.canvas.height,
      host_output_width: out.width,
      host_output_height: out.height,
      host_adapter: 0,
    };
  }

  /** Writes the settings (and a command) into the controller, which answers in the same settings once it's done. */
  private delayCall(extra: Settings = {}): Settings {
    const ctl = this.delayCtl!;
    ctl.update({ ...this.delayConfig(), poll: ++this.delayPoll, ...extra });
    const st = ctl.settings;
    const busy = st.status_state === 'filling' || st.status_state === 'active';
    if (busy !== this.delayBusy) {
      this.delayBusy = busy;
      this.delayWrapper = null;
      this.placePreview(); // program isn't the edited scene while it runs: the preview shows the scene itself
      if (!busy) this.delayFollowProgram();
    }
    return st;
  }

  private delayRead(st: Settings): DelayView {
    const state = st.status_state === 'filling' ? 'filling' : st.status_state === 'active' ? 'on' : 'off';
    const key = String(st.status_message_key ?? '');
    const message = state !== 'off' ? null : key === 'Status.CollectionChanged' ? 'collection_changed' : key === 'Status.ChooseLiveScene' ? 'live_scene_required' : key === 'Status.WrapperSceneFailed' ? 'delay_failed' : null;
    const n = (k: string) => Number(st[k]) || 0;
    return {
      available: true,
      state,
      seconds: n('status_delay_seconds') || this.settings.dynDelaySeconds,
      effective: state === 'off' ? 0 : n('status_applied_seconds'),
      endsAt: state === 'filling' ? Date.now() + n('status_fill_remaining_ms') : null,
      health:
        state !== 'off' && st.health_running
          ? { level: n('health_level'), width: n('health_width'), height: n('health_height'), fullWidth: n('health_full_width'), fullHeight: n('health_full_height'), captureFps: n('health_capture_fps'), outputFps: n('health_output_fps'), cause: n('health_cause'), droppedPerMinute: n('health_dropped_per_minute'), repeatedPerMinute: n('health_repeated_per_minute') }
          : null,
      message,
    };
  }

  /**
   * The delay stopped and the plugin put back the scene shown before it started: Studio's current scene (or studio
   * mode's program) follows what program shows instead of overwriting it, like OBS's scene list follows the plugin.
   */
  private delayFollowProgram() {
    if (this.delaySwitchingCollection || !this.collection || !this.transition) return;
    let shown: string | undefined;
    try {
      shown = this.transition.getActiveSource()?.name;
    } catch {
      return;
    }
    const entry = [...this.scenes.entries()].find(([, sc]) => sc.name === shown);
    if (!entry) return;
    if (this.studioMode) this.programScene = entry[1];
    else if (entry[0] !== this.collection.current) {
      this.collection.current = entry[0];
      this.showInEditor(entry[1]);
      this.save();
      this.onScene?.(entry[0]);
    }
  }

  /** While the delay is on, the live scene goes out through the plugin's wrapper scene (delayed, with the badge). */
  private delayProgramFor(scene: Scene): Scene | null {
    if (!this.delayBusy || !this.delayCtl) return null;
    const st = this.delayCtl.settings;
    if (st.status_state !== 'active' || scene.name !== st.status_live_scene) return null;
    this.delayWrapper ??= this.osn!.SceneFactory.fromName(String(st.status_wrapper_scene));
    return this.delayWrapper;
  }

  /** A scene collection switch: the delay belonged to the old one (the plugin's StopForSceneCollectionChange). */
  private delayCollectionChanging() {
    if (!this.delayCtl || !this.alive()) return;
    this.delaySwitchingCollection = true;
    try {
      this.delayCall({ command: 'collection_changing', command_token: ++this.delayToken });
    } finally {
      this.delaySwitchingCollection = false;
    }
  }

  shutdown(): void {
    const osn = this.osn;
    if (!osn) return;
    if (this.crashed) {
      // Nothing to release in a dead engine, and calls into it could block.
      this.osn = null;
      return;
    }
    try {
      if (this.saveTimer) {
        // Write the pending save now: the app is going away.
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
        try {
          fs.writeFileSync(this.file, JSON.stringify(this.collection, null, 2));
        } catch {
          /* best effort */
        }
      }
      if (this.replayActive) this.replay?.stop(true);
      this.replayActive = false;
      if (this.recording) (this.activeRecorder ?? this.recorder)?.stop(true);
      if (this.streaming) this.output?.stop(true);
      this.streaming = this.recording = false;
      this.dropOutputs();
      // The displays go with the engine process; destroying them here would deadlock (see hidePreview).
      this.display = null;
      this.displays.clear();
      this.delayInstalled = null;
      this.previewHandle = null;
      this.previewRect = null;
      this.programDisplay = null;
      this.projectors.clear();
      this.editWrap = null;
      this.programScene = null;
      this.studioMode = false;
      try {
        osn.NodeObs.RemoveVolmeterCallback();
        osn.NodeObs.RemoveSourceCallback();
      } catch {
        /* never registered */
      }
      for (const name of new Set([...this.faders.keys(), ...this.volmeters.keys()])) this.dropAudio(name);
      for (const input of this.inputs.values()) input.release();
      this.delayCtl?.release(); // the plugin's controller stops its delay when the engine unloads it
      this.delayCtl = null;
      this.delayBusy = false;
      this.transition?.release();
      for (const scene of this.scenes.values()) scene.release();
      this.video?.destroy();
      osn.NodeObs.InitShutdownSequence();
      osn.NodeObs.OBS_service_removeCallback();
    } finally {
      osn.IPC.disconnect();
      this.osn = null;
      this.video = null;
      this.transition = null;
      this.output = null;
      this.recorder = null;
      this.multitrack = null;
      this.activeRecorder = null;
      this.collection = null;
      this.inputs.clear();
      this.scenes.clear();
      this.displayOf.clear();
      this.locked.clear();
      this.callbacksOn = false;
    }
  }
}
