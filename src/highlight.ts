/**
 * Live highlight detector: decides "something just happened" from what the stream itself is doing, not from a timer.
 * Two signals, each compared with its own recent normal (so a loud game or a busy scene doesn't trigger forever):
 *  - audio: loudest OBS input (mic or game) in dB — screams, laughter, explosions;
 *  - video: how much the picture changed since the last sample (0-1) — fast action, big flashes, cuts.
 * Score = positive z-scores weighted and summed once per second; crossing the sensitivity threshold fires.
 * ponytail: no game-specific recognition (kill feeds, etc.) — add per-game detectors as extra signals if needed.
 */
export type Sensitivity = 'low' | 'medium' | 'high';

/** Score needed per sensitivity. Roughly: audio alone at +4σ (a shout over a quiet stream) or both signals at ~+2.5σ. */
const THRESHOLD: Record<Sensitivity, number> = { low: 6, medium: 4.5, high: 3.5 };

const TICK_MS = 1000;
const WARMUP_TICKS = 90; // learn what "normal" looks like before the first possible highlight
const COOLDOWN_MS = 60_000;
const ALPHA = 0.02; // baseline time constant ≈ 50 s
const W_AUDIO = 1;
const W_VIDEO = 0.7;
const Z_MAX = 6; // one signal alone is capped: video alone tops out at 4.2 (high sensitivity only), audio alone at 6
const FLOOR = { audio: 3, video: 0.02 }; // smallest "deviation" that counts (dB / fraction of pixels changed), so silence/still scenes don't blow up z

class Baseline {
  mean = 0;
  vari = 0;
  n = 0;
  constructor(private floor: number) {}
  /** z-score of x against the baseline, then fold x in (outliers clipped so a long loud stretch can't drag the baseline up in one go). */
  push(x: number): number {
    if (this.n === 0) {
      this.mean = x;
      this.n = 1;
      return 0;
    }
    const sd = Math.max(Math.sqrt(this.vari), this.floor);
    const z = (x - this.mean) / sd;
    const clipped = Math.min(x, this.mean + 3 * sd);
    const d = clipped - this.mean;
    this.mean += ALPHA * d;
    this.vari = (1 - ALPHA) * (this.vari + ALPHA * d * d);
    this.n++;
    return z;
  }
}

export class HighlightDetector {
  private audioBase = new Baseline(FLOOR.audio);
  private videoBase = new Baseline(FLOOR.video);
  private audioMax = -100;
  private videoSum = 0;
  private videoN = 0;
  private tickAt = 0;
  private ticks = 0;
  private firedAt = -Infinity;

  constructor(
    public sensitivity: Sensitivity,
    private onHighlight: (score: number) => void,
  ) {}

  /** Linear OBS meter level (0-1) of the loudest input; call as often as OBS reports. */
  audio(level: number, now: number): void {
    this.audioMax = Math.max(this.audioMax, 20 * Math.log10(Math.max(level, 1e-5)));
    this.tick(now);
  }

  /** Fraction of pixels that changed since the previous sample (0-1). */
  video(motion: number, now: number): void {
    this.videoSum += motion;
    this.videoN++;
    this.tick(now);
  }

  /** Forget everything learned (stream restarted, OBS reconnected…). */
  reset(): void {
    this.audioBase = new Baseline(FLOOR.audio);
    this.videoBase = new Baseline(FLOOR.video);
    this.audioMax = -100;
    this.videoSum = this.videoN = this.ticks = 0;
    this.tickAt = 0;
  }

  private tick(now: number): void {
    if (!this.tickAt) this.tickAt = now;
    if (now - this.tickAt < TICK_MS) return;
    this.tickAt = now;
    const za = this.audioBase.push(this.audioMax);
    const zv = this.videoN ? this.videoBase.push(this.videoSum / this.videoN) : 0;
    this.audioMax = -100;
    this.videoSum = this.videoN = 0;
    if (++this.ticks < WARMUP_TICKS || now - this.firedAt < COOLDOWN_MS) return;
    const score = Math.min(Z_MAX, Math.max(0, za)) * W_AUDIO + Math.min(Z_MAX, Math.max(0, zv)) * W_VIDEO;
    if (score >= THRESHOLD[this.sensitivity]) {
      this.firedAt = now;
      this.onHighlight(score);
    }
  }
}
