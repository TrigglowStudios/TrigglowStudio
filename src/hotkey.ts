const MODIFIERS = new Set(['CommandOrControl', 'Command', 'Control', 'Ctrl', 'Alt', 'Option', 'Shift', 'Super', 'Meta']);
const KEY = /^([A-Z0-9]|F([1-9]|1\d|2[0-4])|Up|Down|Left|Right|Space|Tab|Enter|Home|End|PageUp|PageDown|Insert|Delete|Plus|Minus|Equal)$/;

/**
 * Pure check of an Electron accelerator chosen in the UI: modifiers + exactly one real key, at least one "strong"
 * modifier (Shift alone would swallow normal typing system-wide).
 */
export function isValidAccelerator(acc: string): boolean {
  if (acc.length > 50) return false;
  const parts = acc.split('+');
  const key = parts[parts.length - 1] ?? '';
  const mods = parts.slice(0, -1);
  if (!KEY.test(key) || mods.length === 0 || new Set(mods).size !== mods.length) return false;
  if (!mods.every((m) => MODIFIERS.has(m))) return false;
  return mods.some((m) => m !== 'Shift') || /^F\d/.test(key);
}

/**
 * A key held down (push to talk / push to mute): read by polling the keyboard, so it never blocks the key for other
 * apps and may be a single key (F13, CapsLock…) or a mouse side button (Mouse4, Mouse5), with or without modifiers.
 */
export function isValidHoldKey(acc: string): boolean {
  if (acc.length > 50) return false;
  const parts = acc.split('+');
  const key = parts[parts.length - 1] ?? '';
  const mods = parts.slice(0, -1);
  if (!(KEY.test(key) || HOLD_ONLY.test(key)) || new Set(mods).size !== mods.length) return false;
  return mods.every((m) => MODIFIERS.has(m));
}
const HOLD_ONLY = /^(Mouse4|Mouse5|CapsLock|Backquote|F(1[3-9]|2[0-4]))$/;

/** Overlay controls a global shortcut can trigger (the same actions as the dashboard bar and the Stream Deck). */
export const CONTROL_ACTIONS = [
  'skip',
  'toggle-mute',
  'toggle-pause',
  'clear',
  'repeat',
  // Song requests (YouTube player or Spotify) — same endpoint, `music-` family.
  'music-skip',
  'music-toggle-pause',
  'music-volume-up',
  'music-volume-down',
  'music-clear',
  'music-toggle-requests',
] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];
export type ControlHotkeys = Partial<Record<ControlAction, string>>;

/** Defensive parse of saved shortcuts: known actions only, valid accelerators only, and no two actions sharing one. */
export function normalizeControlHotkeys(raw: unknown): ControlHotkeys {
  const out: ControlHotkeys = {};
  if (!raw || typeof raw !== 'object') return out;
  const seen = new Set<string>();
  for (const action of CONTROL_ACTIONS) {
    const acc = (raw as Record<string, unknown>)[action];
    if (typeof acc !== 'string' || !isValidAccelerator(acc)) continue;
    const key = acc.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out[action] = acc;
  }
  return out;
}
