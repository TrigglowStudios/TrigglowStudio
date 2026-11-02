import { HighlightDetector, type Sensitivity } from './highlight';
import type { EngineLink } from './obs';

/** Frames are 64×36 BGRA; a pixel "changed" when its channels moved this much on average (0-255). */
const PIXEL_DELTA = 24;
const POLL_MS = 500;

/** Fraction of pixels that changed between two same-size BGRA frames. Pure. */
export function frameMotion(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length) >> 2;
  if (!n) return 0;
  let changed = 0;
  for (let i = 0; i < n * 4; i += 4) {
    if (Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!) > PIXEL_DELTA * 3) changed++;
  }
  return changed / n;
}

/** Feeds the engine's audio meters and screenshots to the detector while the streamer is live, and clips when it fires. */
export class AutoHighlights {
  private detector: HighlightDetector;
  private prev: Buffer | null = null;
  private wasActive = false;
  /** A screenshot request still out — OBS renders it on its graphics thread, so never stack them. */
  private sampling = false;

  constructor(
    /** OBS or Trigglow Studio, whichever the app drives right now. */
    private engine: () => EngineLink,
    private mode: () => Sensitivity | 'off',
    private fire: () => void,
  ) {
    this.detector = new HighlightDetector(mode() === 'off' ? 'medium' : (mode() as Sensitivity), () => this.fire());
    this.bind();
    setInterval(() => void this.poll(), POLL_MS);
  }

  /** The meters' callbacks on the engine in use (it can switch from OBS to Studio while the app runs). */
  private get obs(): EngineLink {
    return this.bind();
  }

  private bind(): EngineLink {
    const e = this.engine();
    e.wantMeters ??= () => this.mode() !== 'off';
    e.onAudioLevel ??= (level) => this.active() && this.detector.audio(level, Date.now());
    return e;
  }

  /** The preference changed. */
  apply(): void {
    const m = this.mode();
    if (m !== 'off') this.detector.sensitivity = m;
    this.detector.reset();
    this.prev = null;
    this.obs.syncMeters();
  }

  private active(): boolean {
    return this.mode() !== 'off' && this.obs.state === 'connected' && this.obs.live;
  }

  private async poll(): Promise<void> {
    const active = this.active();
    if (!active) {
      if (this.wasActive) this.detector.reset(); // next stream starts from a clean baseline
      this.wasActive = false;
      this.prev = null;
      return;
    }
    this.wasActive = true;
    if (this.sampling) return;
    this.sampling = true;
    const frame = await this.obs.sampleFrame().finally(() => (this.sampling = false));
    if (!frame) return;
    if (this.prev) this.detector.video(frameMotion(this.prev, frame), Date.now());
    this.prev = frame;
  }
}
