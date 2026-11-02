/**
 * Multistream from the dashboard (TrigglowDocs Funcionalidades/Multistream): the pure parts of "Set up OBS" (Trigglow's
 * ingest as OBS's custom stream server) and "Fit OBS to my plan" (lower the output resolution / frame rate). ObsLink
 * (obs.ts) does the obs-websocket calls.
 */

/** What the dashboard may write into OBS → Settings → Stream: an rtmp(s)/srt server and a Trigglow ingest key. */
export function validStreamSetup(server: unknown, key: unknown): { server: string; key: string } | null {
  if (typeof server !== 'string' || typeof key !== 'string') return null;
  let url: URL;
  try {
    url = new URL(server.trim());
  } catch {
    return null;
  }
  if (!['rtmp:', 'rtmps:', 'srt:'].includes(url.protocol) || url.username || url.password) return null;
  if (!/^tgms_[A-Za-z0-9_-]{32}$/.test(key.trim())) return null;
  return { server: server.trim(), key: key.trim() };
}

export interface VideoSettings {
  outputWidth: number;
  outputHeight: number;
  fpsNumerator: number;
  fpsDenominator: number;
}

/**
 * The output size and frame rate that fit a plan: the short side down to `maxLines` (keeping the aspect ratio, even
 * numbers as encoders want) and the frame rate down to `maxFps`. Only ever lowers; null when OBS already fits.
 */
export function fitVideo(v: VideoSettings, maxLines: number, maxFps: number): VideoSettings | null {
  const short = Math.min(v.outputWidth, v.outputHeight);
  const fps = v.fpsNumerator / Math.max(1, v.fpsDenominator);
  const scale = short > maxLines ? maxLines / short : 1;
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
  const next: VideoSettings = {
    outputWidth: scale < 1 ? even(v.outputWidth) : v.outputWidth,
    outputHeight: scale < 1 ? even(v.outputHeight) : v.outputHeight,
    fpsNumerator: fps > maxFps + 0.5 ? maxFps : v.fpsNumerator,
    fpsDenominator: fps > maxFps + 0.5 ? 1 : v.fpsDenominator,
  };
  const same = next.outputWidth === v.outputWidth && next.outputHeight === v.outputHeight && next.fpsNumerator === v.fpsNumerator && next.fpsDenominator === v.fpsDenominator;
  return same ? null : next;
}
