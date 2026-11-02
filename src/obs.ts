import { isLegacySource, overlayPlacement, scalePlacement, type OverlayPlacement } from './overlay-layout';
import { nativeImage } from 'electron';
import OBSWebSocket, { EventSubscription } from 'obs-websocket-js/json';
import type { ObsConfig } from './config';
import { mapObsEvent, type ObsEventMessage } from './obs-events';
import { fitVideo, type VideoSettings } from './obs-stream';

type ObsState = 'connected' | 'connecting' | 'disconnected' | 'error';

const RETRY_MS = 4000;
/** While OBS stays closed the wait grows to this (each attempt may probe the process list); retryNow() resets it. */
const MAX_RETRY_MS = 30_000;

/** Where to connect, resolved fresh before EVERY attempt (auto mode re-reads OBS's own settings each time). */
type ObsResolver = () => Promise<ObsConfig>;

/**
 * What the bridge features (clips, automatic highlights, server actions, text sources) drive: the streamer's OBS
 * (`ObsLink`) or Trigglow Studio's own engine (`StudioLink`, studio-link.ts).
 */
export type EngineLink = Pick<
  ObsLink,
  | 'state' | 'error' | 'replayActive' | 'replaySeconds' | 'live' | 'onObsEvent' | 'wantMeters' | 'onAudioLevel'
  | 'syncMeters' | 'sampleFrame' | 'startReplayBuffer' | 'saveReplay' | 'saveReplayBuffer' | 'setReplaySeconds'
  | 'setRecording' | 'setStreaming' | 'triggerHotkey' | 'setInputVolume' | 'setInputMuted' | 'setFilterEnabled'
  | 'setText' | 'createTextSource' | 'switchScene' | 'setSourceVisible' | 'listScenes'
>;

/** Keeps one obs-websocket v5 connection alive (reconnects while OBS is closed) and runs scene/source actions. */
export class ObsLink {
  private obs: OBSWebSocket | null = null;
  private resolve: ObsResolver | null = null;
  private timer: NodeJS.Timeout | null = null;
  private attempt = 0;
  /** Failed attempts in a row — drives the backoff. */
  private failures = 0;
  /** Whether the current connection asked OBS for the 50 Hz audio meters. */
  private metersOn = false;
  state: ObsState = 'disconnected';
  error?: string;
  /** Replay Buffer running in OBS; null while unknown (not connected). */
  replayActive: boolean | null = null;
  /** Replay Buffer length configured in OBS (seconds); null while unknown. */
  replaySeconds: number | null = null;
  /** OBS activity worth telling automations about (scene changes, stream/recording start/stop, replay saved). */
  onObsEvent: ((ev: ObsEventMessage) => void) | null = null;
  /** Asked after connecting: should we start the Replay Buffer ourselves if it is enabled but idle? */
  autoStartReplay: (() => boolean) | null = null;

  /** Streaming or recording right now (the live highlight detector only runs then). */
  live = false;
  private streamOn = false;
  private recordOn = false;
  private scene: string | null = null;
  /** Want OBS's high-volume audio meters? They are only subscribed while live (see `syncMeters()`). */
  wantMeters: (() => boolean) | null = null;
  /** Linear level (0-1) of the loudest OBS input, ~50 times a second while `wantMeters` is on. */
  onAudioLevel: ((level: number) => void) | null = null;

  constructor(private onChange: () => void) {}

  /** Subscribe to the audio meters only while they are wanted AND OBS is live — they flood ~50 events/s otherwise. */
  syncMeters(): void {
    const want = Boolean(this.wantMeters?.()) && this.live;
    if (want === this.metersOn || this.state !== 'connected' || !this.obs) return;
    this.metersOn = want;
    this.obs
      .reidentify({ eventSubscriptions: want ? EventSubscription.All | EventSubscription.InputVolumeMeters : EventSubscription.All })
      .catch(() => (this.metersOn = !want));
  }

  private setOutput(kind: 'stream' | 'record', on: boolean) {
    if (kind === 'stream') this.streamOn = on;
    else this.recordOn = on;
    this.live = this.streamOn || this.recordOn;
    this.syncMeters();
  }

  /** A tiny (64×36) BGRA frame of the program scene, or null if OBS can't give one. Used to measure how much the picture moves. */
  async sampleFrame(): Promise<Buffer | null> {
    if (this.state !== 'connected' || !this.scene) return null;
    try {
      const r = await this.client().call('GetSourceScreenshot', { sourceName: this.scene, imageFormat: 'jpg', imageWidth: 64, imageHeight: 36, imageCompressionQuality: 40 });
      const img = nativeImage.createFromDataURL(r.imageData);
      return img.isEmpty() ? null : img.toBitmap();
    } catch {
      return null;
    }
  }

  /** (Re)start connecting. A fresh client per attempt keeps stale attempts from interfering. */
  configure(resolve: ObsResolver): void {
    this.resolve = resolve;
    this.restart();
  }

  /** Try again right now (e.g. the user just opened OBS or enabled its WebSocket server). */
  retryNow(): void {
    this.failures = 0;
    if (this.state !== 'connected') this.restart();
  }

  private restart(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const old = this.obs;
    this.obs = null;
    void old?.disconnect().catch(() => undefined);
    void this.connect();
  }

  private set(state: ObsState, error?: string) {
    this.state = state;
    this.error = error;
    this.onChange();
  }

  private scheduleRetry(attempt: number) {
    if (attempt !== this.attempt || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, Math.min(MAX_RETRY_MS, RETRY_MS * 2 ** Math.min(this.failures++, 4)));
  }

  private async connect(): Promise<void> {
    if (!this.resolve) return;
    const attempt = ++this.attempt;
    this.set('connecting');
    let cfg: ObsConfig;
    try {
      cfg = await this.resolve();
    } catch {
      cfg = { host: '127.0.0.1', port: 4455 };
    }
    if (attempt !== this.attempt) return;
    const client = new OBSWebSocket();
    this.obs = client;
    const forward = (name: string) => (data: unknown) => {
      if (attempt !== this.attempt) return;
      const ev = mapObsEvent(name, data);
      if (ev) this.onObsEvent?.(ev);
    };
    client.on('CurrentProgramSceneChanged', (d) => {
      if (attempt === this.attempt) this.scene = d.sceneName;
    });
    client.on('StreamStateChanged', (d) => {
      if (attempt === this.attempt) this.setOutput('stream', d.outputActive);
    });
    client.on('RecordStateChanged', (d) => {
      if (attempt === this.attempt) this.setOutput('record', d.outputActive);
    });
    client.on('InputVolumeMeters', (d) => {
      if (attempt !== this.attempt || !this.onAudioLevel) return;
      let peak = 0;
      for (const input of d.inputs as { inputLevelsMul: number[][] }[]) for (const ch of input.inputLevelsMul) peak = Math.max(peak, ch[1] ?? 0);
      this.onAudioLevel(peak);
    });
    client.on('CurrentProgramSceneChanged', forward('CurrentProgramSceneChanged'));
    client.on('StreamStateChanged', forward('StreamStateChanged'));
    client.on('RecordStateChanged', forward('RecordStateChanged'));
    client.on('ReplayBufferSaved', forward('ReplayBufferSaved'));
    client.on('InputMuteStateChanged', forward('InputMuteStateChanged'));
    client.on('ReplayBufferStateChanged', (d) => {
      if (attempt !== this.attempt) return;
      this.replayActive = Boolean(d.outputActive);
      this.onChange();
    });
    client.on('ConnectionClosed', () => {
      if (attempt !== this.attempt) return;
      this.replayActive = null;
      this.replaySeconds = null;
      this.streamOn = this.recordOn = this.live = false;
      this.metersOn = false;
      if (this.state === 'connected') this.set('disconnected');
      this.scheduleRetry(attempt);
    });
    client
      .connect(`ws://${cfg.host}:${cfg.port}`, cfg.password, { eventSubscriptions: EventSubscription.All })
      .then(() => {
        if (attempt !== this.attempt) return;
        this.failures = 0;
        this.metersOn = false;
        this.set('connected');
        void this.refreshReplayStatus();
        void this.refreshLiveState(client, attempt);
      })
      .catch((err: unknown) => {
        if (attempt !== this.attempt) return;
        this.set('error', err instanceof Error ? err.message : String(err));
        this.scheduleRetry(attempt);
      });
  }

  private async refreshLiveState(client: OBSWebSocket, attempt: number): Promise<void> {
    try {
      const [stream, record, scene] = await Promise.all([client.call('GetStreamStatus'), client.call('GetRecordStatus'), client.call('GetCurrentProgramScene')]);
      if (attempt !== this.attempt) return;
      this.setOutput('stream', stream.outputActive);
      this.setOutput('record', record.outputActive);
      this.scene = scene.sceneName;
    } catch {
      /* the events keep it current from here on */
    }
  }

  private client(): OBSWebSocket {
    if (!this.obs || this.state !== 'connected') throw new Error('OBS not connected');
    return this.obs;
  }

  /**
   * Multistream "Set up OBS": Settings → Stream becomes a custom server (Trigglow's ingest) with the streamer's key.
   * Not while OBS is live: the new settings would only apply after a restart of the stream and confuse the streamer.
   */
  async setCustomStreamService(server: string, key: string): Promise<'ok' | 'streaming'> {
    const obs = this.client();
    if ((await obs.call('GetStreamStatus')).outputActive) return 'streaming';
    await obs.call('SetStreamServiceSettings', {
      streamServiceType: 'rtmp_custom',
      streamServiceSettings: { server, key, use_auth: false, bwtest: false },
    });
    return 'ok';
  }

  /** Multistream "Fit OBS to my plan": lowers the output (scaled) resolution and frame rate; the canvas stays. */
  async fitVideoToPlan(maxLines: number, maxFps: number): Promise<{ status: 'ok' | 'unchanged' | 'busy'; video?: VideoSettings }> {
    const obs = this.client();
    const [stream, record] = await Promise.all([obs.call('GetStreamStatus'), obs.call('GetRecordStatus')]);
    // OBS refuses video changes while any output runs.
    if (stream.outputActive || record.outputActive) return { status: 'busy' };
    const v = await obs.call('GetVideoSettings');
    const next = fitVideo(
      { outputWidth: v.outputWidth, outputHeight: v.outputHeight, fpsNumerator: v.fpsNumerator, fpsDenominator: v.fpsDenominator },
      maxLines,
      maxFps,
    );
    if (!next) return { status: 'unchanged' };
    await obs.call('SetVideoSettings', next);
    return { status: 'ok', video: next };
  }

  async listScenes(): Promise<{ scenes: string[]; current: string }> {
    const r = await this.client().call('GetSceneList');
    return {
      // OBS lists scenes bottom-to-top; show them in the order of its Scenes dock.
      scenes: r.scenes.map((x) => String(x.sceneName)).reverse(),
      current: String(r.currentProgramSceneName),
    };
  }

  /**
   * One-click "install" of an overlay as an OBS browser source. Idempotent: the source is looked up by name,
   * so installing again updates the URL (or adds the existing source to another scene) instead of duplicating it.
   */
  async installBrowserSource(opts: {
    scene: string;
    name: string;
    url: string;
    /** Suggested size and position (1920×1080 space). Applied only when the source is created or added to a scene. */
    placement?: OverlayPlacement | null;
  }): Promise<'created' | 'updated' | 'added' | 'unchanged'> {
    const obs = this.client();
    const notFound = (e: unknown) => (e as { code?: number }).code === 600;
    let existing: { inputKind: string; inputSettings: Record<string, unknown> } | null = null;
    try {
      existing = await obs.call('GetInputSettings', { inputName: opts.name });
    } catch (e) {
      if (!notFound(e)) throw e;
    }

    const canvas = opts.placement ? await this.canvasSize() : null;
    const place = opts.placement && canvas ? scalePlacement(opts.placement, canvas) : null;

    if (!existing) {
      // 605 = InvalidInputKind: an OBS build without obs-browser (e.g. some distro packages).
      const created = await obs.call('CreateInput', {
        sceneName: opts.scene,
        inputName: opts.name,
        inputKind: 'browser_source',
        inputSettings: {
          url: opts.url,
          width: place?.width ?? 1920,
          height: place?.height ?? 1080,
          fps: 30,
          css: 'body { background-color: rgba(0,0,0,0); margin: 0; overflow: hidden; }',
          shutdown: false,
          restart_when_active: false,
        },
        sceneItemEnabled: true,
      }).catch((e: unknown) => {
        throw (e as { code?: number }).code === 605 ? new Error('no_browser_source') : e;
      });
      if (place) await this.placeItem(opts.scene, created.sceneItemId, place);
      return 'created';
    }
    if (existing.inputKind !== 'browser_source') throw new Error('name_taken');

    let result: 'updated' | 'added' | 'unchanged' = 'unchanged';
    if (existing.inputSettings.url !== opts.url) {
      await obs.call('SetInputSettings', { inputName: opts.name, inputSettings: { url: opts.url }, overlay: true });
      result = 'updated';
    }
    // A source made by an older version (full canvas, or an overlay's old default size, e.g. the emote rain's
    // 480×960 strip) gets the recommended size and position. One the streamer sized themselves is left as it is.
    const legacy = place !== null && canvas !== null && isLegacySource(existing.inputSettings, new URL(opts.url).pathname, canvas);
    if (legacy && place) {
      await obs.call('SetInputSettings', {
        inputName: opts.name,
        inputSettings: { width: place.width, height: place.height },
        overlay: true,
      });
      result = 'updated';
    }
    let itemId: number | null = null;
    try {
      itemId = (await obs.call('GetSceneItemId', { sceneName: opts.scene, sourceName: opts.name })).sceneItemId;
    } catch (e) {
      if (!notFound(e)) throw e;
      const item = await obs.call('CreateSceneItem', { sceneName: opts.scene, sourceName: opts.name, sceneItemEnabled: true });
      if (place) await this.placeItem(opts.scene, item.sceneItemId, place);
      result = 'added';
    }
    if (legacy && place && itemId !== null) await this.placeItem(opts.scene, itemId, place);
    return result;
  }

  /** The OBS base (canvas) resolution; 1920×1080 when it cannot be read. */
  private async canvasSize(): Promise<{ width: number; height: number }> {
    try {
      const v = await this.client().call('GetVideoSettings');
      return { width: v.baseWidth || 1920, height: v.baseHeight || 1080 };
    } catch {
      return { width: 1920, height: 1080 };
    }
  }

  /** Puts a scene item at a position. Best effort: a failure leaves it where OBS put it (top-left). */
  private async placeItem(scene: string, sceneItemId: number, p: OverlayPlacement): Promise<void> {
    try {
      await this.client().call('SetSceneItemTransform', {
        sceneName: scene,
        sceneItemId,
        sceneItemTransform: {
          positionX: p.x,
          positionY: p.y,
          scaleX: 1,
          scaleY: 1,
          // The old guide asked for "Fit to screen" (a 1920x1080 bounding box); the new size must not be stretched by it.
          boundsType: 'OBS_BOUNDS_NONE',
        },
      });
    } catch {
      /* the source exists and works; only its position is left to the streamer */
    }
  }

  private async refreshReplayStatus(): Promise<void> {
    try {
      this.replayActive = (await this.client().call('GetReplayBufferStatus')).outputActive;
    } catch {
      this.replayActive = false; // replay buffer not enabled in OBS's output settings
    }
    this.replaySeconds = await this.readReplaySeconds();
    this.onChange();
    // Enabled in OBS but idle (the user never pressed "Start Replay Buffer"): start it so clips just work.
    if (this.replayActive === false && this.autoStartReplay?.()) await this.startReplayBuffer().catch(() => undefined);
  }

  private async outputCategory(): Promise<'SimpleOutput' | 'AdvOut'> {
    const r = await this.client().call('GetProfileParameter', { parameterCategory: 'Output', parameterName: 'Mode' });
    return r.parameterValue === 'Advanced' ? 'AdvOut' : 'SimpleOutput';
  }

  private async readReplaySeconds(): Promise<number | null> {
    try {
      const r = await this.client().call('GetProfileParameter', { parameterCategory: await this.outputCategory(), parameterName: 'RecRBTime' });
      const v = Number(r.parameterValue ?? r.defaultParameterValue);
      return Number.isFinite(v) && v > 0 ? v : null;
    } catch {
      return null;
    }
  }

  /**
   * Sets the Replay Buffer length in the running OBS (profile parameter, no restart). OBS reads it when the buffer
   * starts, so a running buffer is stopped and started again — what it had recorded so far is discarded.
   */
  async setReplaySeconds(seconds: number): Promise<void> {
    const obs = this.client();
    const cat = await this.outputCategory();
    await obs.call('SetProfileParameter', { parameterCategory: cat, parameterName: 'RecRBTime', parameterValue: String(seconds) });
    // OBS also caps the buffer by memory; make sure a long clip isn't silently truncated by it (never lowered).
    const size = await obs.call('GetProfileParameter', { parameterCategory: cat, parameterName: 'RecRBSize' });
    const need = Math.ceil(seconds * 3); // ~24 Mbps of headroom
    if (!(Number(size.parameterValue ?? size.defaultParameterValue ?? 512) >= need)) {
      await obs.call('SetProfileParameter', { parameterCategory: cat, parameterName: 'RecRBSize', parameterValue: String(need) });
    }
    this.replaySeconds = seconds;
    if (this.replayActive) {
      await obs.call('StopReplayBuffer');
      for (let i = 0; i < 16; i++) {
        if (!(await obs.call('GetReplayBufferStatus')).outputActive) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      await obs.call('StartReplayBuffer');
    }
    this.onChange();
  }

  async startReplayBuffer(): Promise<void> {
    await this.client().call('StartReplayBuffer');
    this.replayActive = true;
    this.onChange();
  }

  /** Saves the replay buffer and resolves with the file OBS wrote (waits for its ReplayBufferSaved event). */
  async saveReplay(timeoutMs = 15_000): Promise<string> {
    const obs = this.client();
    let off = () => {};
    const saved = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('timeout'));
      }, timeoutMs);
      const handler = (d: { savedReplayPath: string }) => {
        clearTimeout(timer);
        off();
        resolve(d.savedReplayPath);
      };
      off = () => obs.off('ReplayBufferSaved', handler);
      obs.on('ReplayBufferSaved', handler);
    });
    saved.catch(() => undefined); // surfaced below, or by the caller awaiting it
    try {
      await obs.call('SaveReplayBuffer');
    } catch (e) {
      off();
      throw e;
    }
    return saved;
  }

  async saveReplayBuffer(): Promise<void> {
    await this.client().call('SaveReplayBuffer');
  }

  async setRecording(op: 'start' | 'stop'): Promise<void> {
    await this.client().call(op === 'start' ? 'StartRecord' : 'StopRecord');
  }

  async setStreaming(op: 'start' | 'stop'): Promise<void> {
    await this.client().call(op === 'start' ? 'StartStream' : 'StopStream');
  }

  async triggerHotkey(name: string): Promise<void> {
    await this.client().call('TriggerHotkeyByName', { hotkeyName: name });
  }

  async setInputVolume(input: string, db: number): Promise<void> {
    await this.client().call('SetInputVolume', { inputName: input, inputVolumeDb: db });
  }

  async setInputMuted(input: string, muted: boolean): Promise<void> {
    await this.client().call('SetInputMute', { inputName: input, inputMuted: muted });
  }

  async setFilterEnabled(source: string, filter: string, enabled: boolean): Promise<void> {
    await this.client().call('SetSourceFilterEnabled', { sourceName: source, filterName: filter, filterEnabled: enabled });
  }

  /** Writes text into an OBS text source. 'missing' when no input has that name (obs-websocket code 600). */
  async setText(source: string, text: string): Promise<'ok' | 'missing' | 'error'> {
    try {
      await this.client().call('SetInputSettings', { inputName: source, inputSettings: { text }, overlay: true });
      return 'ok';
    } catch (e) {
      return (e as { code?: number }).code === 600 ? 'missing' : 'error';
    }
  }

  /** Creates a text input (GDI+ on Windows, FreeType elsewhere) in `scene`, or in OBS's current scene. */
  async createTextSource(scene: string | null, name: string, text: string): Promise<boolean> {
    const obs = this.client();
    try {
      const sceneName = scene ?? String((await obs.call('GetSceneList')).currentProgramSceneName);
      await obs.call('CreateInput', {
        sceneName,
        inputName: name,
        inputKind: process.platform === 'win32' ? 'text_gdiplus_v3' : 'text_ft2_source_v2',
        inputSettings: { text },
        sceneItemEnabled: true,
      });
      return true;
    } catch (e) {
      return (e as { code?: number }).code === 601; // ResourceAlreadyExists: it is there already, we just fill it
    }
  }

  async switchScene(scene: string): Promise<void> {
    await this.client().call('SetCurrentProgramScene', { sceneName: scene });
  }

  async setSourceVisible(scene: string, source: string, visible: boolean): Promise<void> {
    const obs = this.client();
    const { sceneItemId } = await obs.call('GetSceneItemId', { sceneName: scene, sourceName: source });
    await obs.call('SetSceneItemEnabled', { sceneName: scene, sceneItemId, sceneItemEnabled: visible });
  }
}
