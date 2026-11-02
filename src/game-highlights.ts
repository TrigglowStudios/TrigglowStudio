import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Games with NVIDIA Highlights (Fortnite and others) write a short video into this folder the moment something
 * happens (a kill, a win). We never use that file: its appearance is the signal, and the OBS Replay Buffer is saved
 * right then, so the clip has the whole stream scene (camera, overlays) and not just the game.
 * ponytail: only the folder signal; a game without NVIDIA Highlights needs its own detector (see lol.ts).
 */
export const DEFAULT_HIGHLIGHTS_DIR = path.join(os.tmpdir(), 'Highlights');

const VIDEO = /\.(mp4|mkv|mov)$/i;
/** A game can write a burst of highlights for one moment (multi-kill): one clip covers them. */
const COOLDOWN_MS = 20_000;
/** The folder may not exist until the first highlight: look again now and then. */
const RESYNC_MS = 30_000;

export class GameHighlightWatcher {
  private watcher: fs.FSWatcher | null = null;
  private dir: string | null = null;
  private seen = new Set<string>();
  private lastAt = -Infinity;

  constructor(
    /** The folder to watch, or null while the feature is off. */
    private folder: () => string | null,
    private fire: () => void,
  ) {
    this.sync();
    setInterval(() => this.sync(), RESYNC_MS).unref();
  }

  /** Call when the preference changes. */
  sync(): void {
    const dir = this.folder();
    if (dir === this.dir && (this.watcher || !dir)) return;
    this.watcher?.close();
    this.watcher = null;
    this.dir = dir;
    if (!dir) return;
    try {
      const w = fs.watch(dir, { recursive: true }, (_ev, name) => this.onFile(String(name ?? ''), Date.now()));
      w.on('error', () => {
        w.close();
        if (this.watcher === w) this.watcher = null; // retried by the next resync
      });
      this.watcher = w;
    } catch {
      /* folder missing (no highlight yet) or unreadable: retried by the next resync */
    }
  }

  /** A file was created/renamed in the folder. Returns whether it fired. */
  onFile(name: string, now: number): boolean {
    if (!VIDEO.test(name) || this.seen.has(name)) return false;
    this.seen.add(name);
    if (now - this.lastAt < COOLDOWN_MS) return false;
    this.lastAt = now;
    this.fire();
    return true;
  }
}
