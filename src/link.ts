import { session } from 'electron';
import { io, type Socket } from 'socket.io-client';
import { parseNotification, type DesktopNotification } from './notify';
import type { EngineLink } from './obs';
import type { NowPlaying } from './now-playing';

const SESSION_COOKIE = 'trigglow_session';

type DesktopAction =
  | { type: 'obs_switch_scene'; scene: string }
  | { type: 'obs_set_source_visible'; scene: string; source: string; visible: boolean }
  | { type: 'obs_recording'; op: 'start' | 'stop' }
  | { type: 'obs_save_replay' }
  | { type: 'clip_replay' }
  | { type: 'obs_set_input_muted'; input: string; muted: boolean }
  | { type: 'obs_set_filter_enabled'; source: string; filter: string; enabled: boolean }
  | { type: 'obs_streaming'; op: 'start' | 'stop' }
  | { type: 'obs_set_text'; source: string; text: string }
  | { type: 'obs_trigger_hotkey'; name: string }
  | { type: 'obs_set_volume'; input: string; db: number };

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;

/** Re-validate what the server sends — the bridge never executes anything it doesn't recognise. */
function parseAction(raw: unknown): DesktopAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (a.type === 'obs_switch_scene' && str(a.scene)) return { type: a.type, scene: a.scene };
  if (a.type === 'obs_set_source_visible' && str(a.scene) && str(a.source) && typeof a.visible === 'boolean') {
    return { type: a.type, scene: a.scene, source: a.source, visible: a.visible };
  }
  if (a.type === 'obs_recording' && (a.op === 'start' || a.op === 'stop')) return { type: a.type, op: a.op };
  if (a.type === 'obs_save_replay' || a.type === 'clip_replay') return { type: a.type };
  if (a.type === 'obs_set_input_muted' && str(a.input) && typeof a.muted === 'boolean') return { type: a.type, input: a.input, muted: a.muted };
  if (a.type === 'obs_set_filter_enabled' && str(a.source) && str(a.filter) && typeof a.enabled === 'boolean') {
    return { type: a.type, source: a.source, filter: a.filter, enabled: a.enabled };
  }
  if (a.type === 'obs_streaming' && (a.op === 'start' || a.op === 'stop')) return { type: a.type, op: a.op };
  if (a.type === 'obs_set_text' && str(a.source) && typeof a.text === 'string' && a.text.length <= 500) return { type: a.type, source: a.source, text: a.text };
  if (a.type === 'obs_trigger_hotkey' && str(a.name)) return { type: a.type, name: a.name };
  if (a.type === 'obs_set_volume' && str(a.input) && typeof a.db === 'number' && a.db >= -100 && a.db <= 0) return { type: a.type, input: a.input, db: a.db };
  return null;
}

function execute(obs: EngineLink, a: DesktopAction): Promise<void> {
  switch (a.type) {
    case 'obs_switch_scene':
      return obs.switchScene(a.scene);
    case 'obs_set_source_visible':
      return obs.setSourceVisible(a.scene, a.source, a.visible);
    case 'obs_recording':
      return obs.setRecording(a.op);
    case 'obs_save_replay':
      return obs.saveReplayBuffer();
    case 'clip_replay':
      return Promise.resolve(); // handled by ApiLink (needs the clip pipeline, not just OBS)
    case 'obs_set_input_muted':
      return obs.setInputMuted(a.input, a.muted);
    case 'obs_set_filter_enabled':
      return obs.setFilterEnabled(a.source, a.filter, a.enabled);
    case 'obs_streaming':
      return obs.setStreaming(a.op);
    case 'obs_set_text':
      return obs.setText(a.source, a.text).then((r) => {
        if (r !== 'ok') throw new Error(`set_text_${r}`);
      });
    case 'obs_trigger_hotkey':
      return obs.triggerHotkey(a.name);
    case 'obs_set_volume':
      return obs.setInputVolume(a.input, a.db);
  }
}

/** Socket.IO link to the Trigglow API, authenticated with the streamer's own session cookie. */
export class ApiLink {
  private socket: Socket | null = null;
  private apiUrl = '';
  online = false;
  /** The server pushes a ready-to-show notification (only when the streamer enabled it for the desktop app). */
  onNotify: ((n: DesktopNotification) => void) | null = null;
  /** "Something the app mirrors may have changed" (latest follower, goal progress…). */
  onData: (() => void) | null = null;
  /** A Stream Deck key (via the API) asked for a replay clip. */
  onClipRequest: ((opts: { announce: boolean }) => void) | null = null;
  /** Fired every time the socket is (re)authenticated — the place to re-announce capabilities. */
  onAuthed: (() => void) | null = null;
  /** The streamer turned the music overlay's desktop "now playing" source on/off (re-sent on every auth). */
  onNowPlayingConfig: ((enabled: boolean) => void) | null = null;

  constructor(
    /** OBS or Trigglow Studio, whichever the app drives right now. */
    private engine: () => EngineLink,
    private onChange: () => void,
  ) {}


  /** Report something that happened in OBS (scene switch, stream start…) so automations can react. */
  /** Tell the API what this desktop app can do right now (used to route Stream Deck clip keys). */
  sendCaps(caps: { replayClip: boolean }): void {
    if (this.online) this.socket?.emit('desktop:caps', caps);
  }

  sendNowPlaying(np: NowPlaying | null): void {
    if (this.online) this.socket?.emit('desktop:now-playing', np);
  }

  /** A stream moment seen on this PC (game event, big reaction) for the post-stream highlights. */
  sendMoment(m: {
    kind: 'game' | 'reaction';
    game?: string;
    detail?: string;
    ageMs: number;
    stats?: { champion: string; kills: number; deaths: number; assists: number };
  }): void {
    if (this.online) this.socket?.emit('desktop:moment', m);
  }

  emit(ev: { metric: string; scene?: string; input?: string }): void {
    if (this.online) this.socket?.emit('desktop:event', ev);
  }

  disconnect(): void {
    this.socket?.close();
    this.socket = null;
    this.apiUrl = '';
    this.online = false;
    this.onChange();
  }

  connect(apiUrl: string): void {
    if (this.socket && apiUrl === this.apiUrl) return;
    this.socket?.close();
    this.apiUrl = apiUrl;
    const socket = io(apiUrl, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 30_000,
      // Read fresh on every (re)connect so a rotated/renewed session keeps working.
      auth: (cb) => {
        void session.defaultSession.cookies
          .get({ url: apiUrl, name: SESSION_COOKIE })
          .then((c) => cb({ token: c[0]?.value ?? '' }));
      },
    });
    socket.on('connect', () => {
      socket.emit('desktop:auth', {}, (ok: boolean) => {
        this.online = ok;
        this.onChange();
        if (ok) this.onAuthed?.();
      });
    });
    socket.on('disconnect', () => {
      this.online = false;
      this.onNowPlayingConfig?.(false);
      this.onChange();
    });
    socket.on('desktop:clip', (raw: unknown) => {
      this.onClipRequest?.({ announce: (raw as { announce?: unknown } | null)?.announce === true });
    });
    socket.on('desktop:notify', (raw: unknown) => {
      const n = parseNotification(raw);
      if (n) this.onNotify?.(n);
    });
    socket.on('desktop:data', () => this.onData?.());
    socket.on('desktop:now-playing-config', (raw: unknown) => {
      this.onNowPlayingConfig?.((raw as { enabled?: unknown } | null)?.enabled === true);
    });
    socket.on('desktop:action', (raw: unknown) => {
      const action = parseAction(raw);
      if (!action) return;
      if (action.type === 'clip_replay') return this.onClipRequest?.({ announce: false });
      execute(this.engine(), action).catch((err) => console.warn('[desktop] action failed:', action.type, err instanceof Error ? err.message : err));
    });
    this.socket = socket;
  }
}
