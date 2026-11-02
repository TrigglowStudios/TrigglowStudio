/**
 * Where each overlay goes when the app adds it to OBS: a size that fits its content and a position on a
 * 1920×1080 canvas, chosen so overlays do not cover each other. Only the emote rain is full screen (it falls
 * over the whole stream). The same table (as a suggestion) is shown in the web app's "Add to OBS" guide
 * (apps/web/src/lib/overlays-catalog.ts); the streamer can move or resize anything afterwards, because the
 * layout is only applied when a source is first created or added to a scene.
 */
export interface OverlayPlacement {
  width: number;
  height: number;
  x: number;
  y: number;
}

/** Keyed by the part of the URL after `/overlay/<id>` ('' for the alerts overlay itself). */
const LAYOUT: Record<string, OverlayPlacement> = {
  '': { width: 700, height: 440, x: 610, y: 320 }, // centred on 1920×1080: alerts are always centred
  '/chat': { width: 480, height: 420, x: 24, y: 636 },
  '/quests': { width: 480, height: 300, x: 24, y: 24 },
  '/giveaway': { width: 520, height: 460, x: 700, y: 24 },
  '/loyalty': { width: 420, height: 480, x: 1470, y: 24 },
  '/music-requests': { width: 440, height: 170, x: 1450, y: 880 },
  '/activity': { width: 500, height: 320, x: 1396, y: 520 },
  '/goals': { width: 640, height: 90, x: 640, y: 960 },
  '/credits': { width: 640, height: 720, x: 640, y: 180 },
  '/emotes': { width: 1920, height: 1080, x: 0, y: 0 },
};

/** Default sizes earlier versions of the app gave an overlay (1920×1080 space) before its layout changed. */
const PREVIOUS_SIZES: Record<string, { width: number; height: number }[]> = {
  '/emotes': [{ width: 480, height: 960 }], // the emote rain used to be a strip on the right edge
  '/activity': [{ width: 420, height: 320 }], // the activity overlay is 500 px wide now
};

function layoutKey(pathname: string): string | null {
  const m = /^\/overlay\/[^/]+(\/[^/]+)?\/?$/.exec(pathname);
  return m ? (m[1] ?? '') : null;
}

/** The placement for an overlay URL path (`/overlay/<id>/chat`), or null for an unknown overlay. */
export function overlayPlacement(pathname: string): OverlayPlacement | null {
  const key = layoutKey(pathname);
  return key === null ? null : (LAYOUT[key] ?? null);
}

/** Scales a 1920×1080 placement to the OBS canvas (other resolutions or aspect ratios keep the same relative layout). */
export function scalePlacement(p: OverlayPlacement, canvas: { width: number; height: number }): OverlayPlacement {
  const fx = canvas.width / 1920;
  const fy = canvas.height / 1080;
  return {
    width: Math.max(16, Math.round(p.width * fx)),
    height: Math.max(16, Math.round(p.height * fy)),
    x: Math.round(p.x * fx),
    y: Math.round(p.y * fy),
  };
}

/**
 * Was this existing browser source created by an older version of the app: a full-canvas source, or the old default
 * size of this overlay (scaled to the canvas like it was when created)? Those get the recommended size and position
 * the next time they are imported; a source the streamer sized themselves, or one already at the recommended size,
 * is left alone.
 */
export function isLegacySource(
  settings: Record<string, unknown>,
  pathname: string,
  canvas: { width: number; height: number },
): boolean {
  const key = layoutKey(pathname);
  const current = key === null ? undefined : LAYOUT[key];
  if (!current) return false;
  const is = (s: { width: number; height: number }) => settings.width === s.width && settings.height === s.height;
  if (is(scalePlacement(current, canvas))) return false;
  if (is({ width: 1920, height: 1080 })) return true;
  return (PREVIOUS_SIZES[key!] ?? []).some((s) => is(scalePlacement({ ...s, x: 0, y: 0 }, canvas)));
}
