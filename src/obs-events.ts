/** Mirrors `ObsEventMetric` / `ObsEventMessage` in @trigglow/shared (the desktop app doesn't depend on that package). */
export type ObsEventMetric =
  | 'obs_scene_changed'
  | 'obs_stream_started'
  | 'obs_stream_stopped'
  | 'obs_recording_started'
  | 'obs_recording_stopped'
  | 'obs_replay_saved'
  | 'obs_stream_reconnecting'
  | 'obs_input_muted'
  | 'obs_input_unmuted';

export interface ObsEventMessage {
  metric: ObsEventMetric;
  scene?: string;
  input?: string;
}

const STARTED = 'OBS_WEBSOCKET_OUTPUT_STARTED';
const STOPPED = 'OBS_WEBSOCKET_OUTPUT_STOPPED';
const RECONNECTING = 'OBS_WEBSOCKET_OUTPUT_RECONNECTING';

/** Pure: turns a raw obs-websocket event into what automations understand (null = not interesting). */
export function mapObsEvent(name: string, data: unknown): ObsEventMessage | null {
  const d = (data ?? {}) as { sceneName?: unknown; outputState?: unknown; inputName?: unknown; inputMuted?: unknown };
  switch (name) {
    case 'CurrentProgramSceneChanged':
      return typeof d.sceneName === 'string' && d.sceneName ? { metric: 'obs_scene_changed', scene: d.sceneName } : null;
    case 'StreamStateChanged':
      return d.outputState === STARTED
        ? { metric: 'obs_stream_started' }
        : d.outputState === STOPPED
          ? { metric: 'obs_stream_stopped' }
          : d.outputState === RECONNECTING
            ? { metric: 'obs_stream_reconnecting' }
            : null;
    case 'RecordStateChanged':
      return d.outputState === STARTED ? { metric: 'obs_recording_started' } : d.outputState === STOPPED ? { metric: 'obs_recording_stopped' } : null;
    case 'InputMuteStateChanged':
      return typeof d.inputName === 'string' && d.inputName && typeof d.inputMuted === 'boolean'
        ? { metric: d.inputMuted ? 'obs_input_muted' : 'obs_input_unmuted', input: d.inputName }
        : null;
    case 'ReplayBufferSaved':
      return { metric: 'obs_replay_saved' };
    default:
      return null;
  }
}
