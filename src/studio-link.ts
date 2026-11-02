/**
 * Trigglow Studio behind the same face as the OBS bridge (`EngineLink`), so everything built on OBS works the same with
 * Studio as the engine: clips from the replay buffer, automatic highlights, server actions (Stream Deck, automations),
 * Trigglow text sources and the events automations listen to.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nativeImage } from 'electron';
import type { EngineLink } from './obs';
import type { ObsEventMessage } from './obs-events';
import type { StreamSignal, StudioEngine } from './studio';

/** The highlight detector's frame: 64×36 BGRA, like the one OBS hands the bridge. */
const FRAME = { width: 64, height: 36 };
/**
 * A program screenshot costs the engine ~90 ms at 1440p (measured 2026-11-02), so at most one this often; in between
 * the detector gets nothing and waits (it compares consecutive frames, whatever their spacing).
 */
const FRAME_EVERY_MS = 1500;
const FRAMES_DIR = path.join(os.tmpdir(), 'trigglow-studio-frames');

export class StudioLink implements EngineLink {
  private lastFrameAt = 0;
  readonly error = undefined;
  onObsEvent: ((ev: ObsEventMessage) => void) | null = null;
  wantMeters: (() => boolean) | null = null;
  onAudioLevel: ((level: number) => void) | null = null;

  constructor(
    private engine: StudioEngine,
    /** Going live needs the target's server and key from the API (main.ts resolveStudioTarget). */
    private goLive: () => Promise<void>,
    private onChange: () => void,
  ) {
    engine.onScene = (scene) => this.onObsEvent?.({ metric: 'obs_scene_changed', scene });
    engine.onMute = (input, muted) => this.onObsEvent?.({ metric: muted ? 'obs_input_muted' : 'obs_input_unmuted', input });
  }

  get state() {
    return this.engine.alive() ? ('connected' as const) : ('disconnected' as const);
  }

  get replayActive() {
    return this.engine.alive() ? this.engine.replayActive : null;
  }

  get replaySeconds() {
    return this.engine.replaySeconds;
  }

  get live() {
    const o = this.engine.outputs;
    return o.streaming || o.recording;
  }

  /** Stream, recording and replay events from the engine (main.ts forwards every one here). */
  signal(s: StreamSignal) {
    const ev: Record<string, ObsEventMessage['metric'] | undefined> =
      s.output === 'stream'
        ? { start: 'obs_stream_started', stop: 'obs_stream_stopped', reconnect: 'obs_stream_reconnecting' }
        : s.output === 'record'
          ? { start: 'obs_recording_started', stop: 'obs_recording_stopped' }
          : { wrote: 'obs_replay_saved' };
    const metric = ev[s.signal];
    if (metric) this.onObsEvent?.({ metric });
    if (['start', 'stop', 'activate', 'deactivate'].includes(s.signal)) this.onChange();
  }

  /** The mixer's meters (dB per source): the loudest one, linear, for the highlight detector while live. */
  levels(levels: Record<string, number>) {
    if (!this.onAudioLevel || !this.wantMeters?.() || !this.live) return;
    const db = Math.max(-100, ...Object.values(levels));
    this.onAudioLevel(10 ** (db / 20));
  }

  syncMeters(): void {
    /* the engine's meters always run (the mixer shows them) */
  }

  /** A tiny frame of the program for the motion part of the highlight detector (only asked while live). */
  async sampleFrame(): Promise<Buffer | null> {
    const now = Date.now();
    if (now - this.lastFrameAt < FRAME_EVERY_MS || !this.engine.alive()) return null;
    this.lastFrameAt = now;
    let file: string | null = null;
    try {
      file = await this.engine.screenshot(FRAMES_DIR);
      const img = nativeImage.createFromPath(file);
      return img.isEmpty() ? null : img.resize({ ...FRAME, quality: 'good' }).toBitmap();
    } catch {
      return null;
    } finally {
      if (file) fs.rm(file, { force: true }, () => undefined);
    }
  }

  async startReplayBuffer(): Promise<void> {
    this.engine.startReplay();
    this.onChange();
  }

  saveReplay(timeoutMs?: number): Promise<string> {
    return this.engine.saveReplay(timeoutMs);
  }

  async saveReplayBuffer(): Promise<void> {
    await this.engine.saveReplay();
  }

  async setReplaySeconds(seconds: number): Promise<void> {
    this.engine.setReplaySeconds(seconds);
    this.onChange();
  }

  async setRecording(op: 'start' | 'stop'): Promise<void> {
    if (op === 'start') this.engine.startRecording();
    else this.engine.stopRecording();
  }

  async setStreaming(op: 'start' | 'stop'): Promise<void> {
    if (op === 'start') await this.goLive();
    else this.engine.stopStream();
  }

  async triggerHotkey(): Promise<void> {
    throw new Error('unsupported'); // OBS hotkey names mean nothing to Studio
  }

  async setInputVolume(input: string, db: number): Promise<void> {
    if (!this.engine.audioProps().some((a) => a.name === input)) throw new Error('studio: no such audio source');
    this.engine.setAudioProps(input, { db });
  }

  async setInputMuted(input: string, muted: boolean): Promise<void> {
    this.engine.setMuted(input, muted);
  }

  async setFilterEnabled(source: string, filter: string, enabled: boolean): Promise<void> {
    this.engine.setFilterEnabled(source, filter, enabled);
  }

  async setText(source: string, text: string): Promise<'ok' | 'missing' | 'error'> {
    try {
      return this.engine.setText(source, text);
    } catch {
      return 'error';
    }
  }

  async createTextSource(scene: string | null, name: string, text: string): Promise<boolean> {
    try {
      return this.engine.addText(scene, name, text);
    } catch {
      return false;
    }
  }

  async switchScene(scene: string): Promise<void> {
    this.engine.selectScene(scene);
  }

  async setSourceVisible(scene: string, source: string, visible: boolean): Promise<void> {
    this.engine.setVisibleIn(scene, source, visible);
  }

  async listScenes(): Promise<{ scenes: string[]; current: string }> {
    const v = this.engine.view();
    if (!v) throw new Error('engine_stopped');
    return { scenes: v.scenes, current: v.current };
  }
}
