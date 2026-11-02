import { execFile, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isObsRunning, obsConfigDir } from './obs-detect';

/** The part of `fs` the atomic write uses (a fake in tests). */
export type AtomicFs = Pick<typeof fs, 'writeFileSync' | 'renameSync' | 'copyFileSync' | 'existsSync' | 'unlinkSync'>;

/**
 * Replaces an OBS config file in one step: the new content goes to `<file>.trigglow-tmp` in the same folder and
 * is renamed over the file, so OBS (or a crash) never sees half a file. The previous file is kept as
 * `<file>.trigglow-bak`. On Windows renameSync replaces an existing file unless it is locked (OBS holding it
 * open): then it throws, the temporary file is removed and the original is left untouched.
 */
export function writeFileAtomic(file: string, data: string, fsx: AtomicFs = fs): void {
  const tmp = `${file}.trigglow-tmp`;
  try {
    fsx.writeFileSync(tmp, data);
    if (fsx.existsSync(file)) {
      try {
        fsx.copyFileSync(file, `${file}.trigglow-bak`);
      } catch {
        /* the backup is a convenience */
      }
    }
    fsx.renameSync(tmp, file);
  } catch (err) {
    try {
      fsx.unlinkSync(tmp);
    } catch {
      /* nothing to remove */
    }
    throw err;
  }
}

const wsConfigPath = () => path.join(obsConfigDir(), 'plugin_config', 'obs-websocket', 'config.json');

/**
 * Pure: obs-websocket's config with its server turned on. Other settings are preserved; a missing file becomes a
 * secure default (authentication on, random password — we read it back ourselves, the user never sees it).
 */
export function withServerEnabled(raw: string | null, genPassword: () => string = () => crypto.randomBytes(12).toString('base64url')): string {
  let cfg: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') cfg = parsed as Record<string, unknown>;
    } catch {
      /* corrupt file: start over */
    }
  }
  cfg.server_enabled = true;
  if (typeof cfg.server_port !== 'number') cfg.server_port = 4455;
  if (cfg.auth_required === undefined) cfg.auth_required = true;
  if (cfg.auth_required === true && !(typeof cfg.server_password === 'string' && cfg.server_password)) cfg.server_password = genPassword();
  if (cfg.first_load === undefined) cfg.first_load = false;
  return JSON.stringify(cfg, null, 4);
}

/** OBS only reads this at startup and rewrites it on exit, so call it ONLY while OBS is not running. */
export function enableServerInConfig(): void {
  const file = wsConfigPath();
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    /* first run */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, withServerEnabled(raw));
}

/** Sets `key=value` inside `[section]` of an INI file held as lines (adds the section/key if missing). Pure. */
function setIniKey(lines: string[], section: string, key: string, value: string, onlyIfMissing = false): string[] {
  const header = `[${section}]`;
  const start = lines.findIndex((l) => l.trim() === header);
  if (start < 0) {
    const out = [...lines];
    if (out.length && (out[out.length - 1] ?? '').trim() !== '') out.push('');
    out.push(header, `${key}=${value}`);
    return out;
  }
  let end = lines.findIndex((l, i) => i > start && /^\s*\[.+\]\s*$/.test(l));
  if (end < 0) end = lines.length;
  for (let i = start + 1; i < end; i++) {
    const m = /^\s*([^=;#\s][^=]*)=(.*)$/.exec(lines[i] ?? '');
    if (m && (m[1] ?? '').trim() === key) {
      if (onlyIfMissing) return lines;
      const out = [...lines];
      out[i] = `${m[1]}=${value}`;
      return out;
    }
  }
  const out = [...lines];
  let at = end;
  while (at > start + 1 && (lines[at - 1] ?? '').trim() === '') at--; // keep the blank line that separates sections
  out.splice(at, 0, `${key}=${value}`);
  return out;
}

/**
 * Pure: a profile's basic.ini with the Replay Buffer switched on for the output mode OBS is using (Simple or
 * Advanced). Everything else — including line endings — is preserved; the buffer length is only set when the user
 * never chose one.
 */
function getIniKey(lines: string[], section: string, key: string): string | null {
  const start = lines.findIndex((l) => l.trim() === `[${section}]`);
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length && !/^\s*\[.+\]\s*$/.test(lines[i] ?? ''); i++) {
    const m = /^\s*([^=;#\s][^=]*)=(.*)$/.exec(lines[i] ?? '');
    if (m && (m[1] ?? '').trim() === key) return (m[2] ?? '').trim();
  }
  return null;
}

/** Bytes of replay buffer we allow per second of clip (~24 Mbps) — OBS caps the buffer by memory too, which would silently shorten long clips. */
const RB_MB_PER_SECOND = 3;

/**
 * Pure: a profile's basic.ini with the Replay Buffer length set. Also raises OBS's memory cap for the buffer when the
 * chosen length wouldn't fit under it (never lowers it).
 */
export function withReplaySeconds(ini: string | null, seconds: number): string {
  const eol = ini?.includes('\r\n') ? '\r\n' : '\n';
  let lines = ini ? ini.split(/\r?\n/) : [];
  const mode = /^\s*Mode\s*=\s*(\w+)/im.exec(ini ?? '')?.[1];
  const section = mode && mode.toLowerCase() === 'advanced' ? 'AdvOut' : 'SimpleOutput';
  lines = setIniKey(lines, section, 'RecRBTime', String(Math.round(seconds)));
  const cap = Number(getIniKey(lines, section, 'RecRBSize') ?? 512);
  const need = Math.ceil(seconds * RB_MB_PER_SECOND);
  if (!(cap >= need)) lines = setIniKey(lines, section, 'RecRBSize', String(need));
  return lines.join(eol).replace(/\s*$/, '') + eol;
}

/** The replay buffer length (seconds) stored in a basic.ini; null when unset. Pure. */
export function replaySecondsFromIni(ini: string | null): number | null {
  if (!ini) return null;
  const lines = ini.split(/\r?\n/);
  const mode = /^\s*Mode\s*=\s*(\w+)/im.exec(ini)?.[1];
  const section = mode && mode.toLowerCase() === 'advanced' ? 'AdvOut' : 'SimpleOutput';
  const v = Number(getIniKey(lines, section, 'RecRBTime'));
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Pure: OBS Studio's user.ini with a custom browser dock added or updated in [BasicWindow] ExtraBrowserDocks. */
export function withBrowserDock(rawUserIni: string | null, title: string, url: string): string {
  const eol = rawUserIni?.includes('\r\n') ? '\r\n' : '\n';
  let lines = rawUserIni ? rawUserIni.split(/\r?\n/) : [];
  const currentJson = getIniKey(lines, 'BasicWindow', 'ExtraBrowserDocks');
  let docks: Array<{ title: string; url: string }> = [];
  if (currentJson) {
    try {
      const parsed = JSON.parse(currentJson) as unknown;
      if (Array.isArray(parsed)) docks = parsed as Array<{ title: string; url: string }>;
    } catch {
      docks = [];
    }
  }
  const idx = docks.findIndex((d) => d && typeof d.title === 'string' && d.title.toLowerCase() === title.toLowerCase());
  if (idx >= 0) {
    docks[idx] = { title, url };
  } else {
    docks.push({ title, url });
  }
  lines = setIniKey(lines, 'BasicWindow', 'ExtraBrowserDocks', JSON.stringify(docks));
  return lines.join(eol).replace(/\s*$/, '') + eol;
}

/**
 * The credential of an old secret-URL dock of this kind, or null: `https://dock.trigglow.com/<kind>#k=tgdr_…`
 * as 0.7.x installed it (and `dock.localhost:5173` in development). That host is gone (the dock moved to
 * `<web origin>/dock/<kind>`); it is only recognised here so "Change the URL in OBS" can find and replace
 * those docks, always with the new URL.
 */
function legacyDockCredential(url: unknown, kind: 'activity' | 'chat'): string | null {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    const host = (u.protocol === 'https:' && u.hostname === 'dock.trigglow.com') || (u.protocol === 'http:' && u.host === 'dock.localhost:5173');
    const m = /^#k=(tgdr_[A-Za-z0-9_-]{43})$/.exec(u.hash);
    return host && u.pathname === `/${kind}` && m ? m[1]! : null;
  } catch {
    return null;
  }
}

/** sha256 hex of a dock credential: what the server keeps as the dock's token_hash. */
export function dockCredentialHash(credential: string): string {
  return crypto.createHash('sha256').update(credential, 'utf8').digest('hex');
}

/**
 * Pure: "Change the URL in OBS" (OBS_ACTIVITY_FEED.md 14.3). Puts `url` in place of the old secret-URL dock
 * whose `#k=` credential hashes to `credentialHash` (the replaced dock's token_hash, from the enroll
 * response) and keeps that dock's own title. Nothing is guessed (review L2): no hash, or no OBS dock
 * with that credential (another channel's, another account's), and the new dock is added instead.
 */
export function withLegacyDockReplaced(
  rawUserIni: string | null,
  title: string,
  url: string,
  kind: 'activity' | 'chat',
  credentialHash?: string | null,
): { ini: string; replaced: boolean } {
  const lines = rawUserIni ? rawUserIni.split(/\r?\n/) : [];
  const currentJson = getIniKey(lines, 'BasicWindow', 'ExtraBrowserDocks');
  let docks: Array<{ title: string; url: string }> = [];
  try {
    const parsed = currentJson ? (JSON.parse(currentJson) as unknown) : [];
    if (Array.isArray(parsed)) docks = parsed as Array<{ title: string; url: string }>;
  } catch {
    docks = [];
  }
  const wanted = typeof credentialHash === 'string' && /^[0-9a-f]{64}$/.test(credentialHash) ? credentialHash : null;
  const target = wanted
    ? docks.find((d) => {
        if (!d || typeof d.title !== 'string') return false;
        const cred = legacyDockCredential(d.url, kind);
        return cred !== null && dockCredentialHash(cred) === wanted;
      })
    : undefined;
  if (!target) return { ini: withBrowserDock(rawUserIni, title, url), replaced: false };
  return { ini: withBrowserDock(rawUserIni, target.title, url), replaced: true };
}

/** OBS 31+ keeps window settings (docks) in user.ini; before that they lived in global.ini. */
function obsWindowIni(): string {
  const user = path.join(obsConfigDir(), 'user.ini');
  const legacy = path.join(obsConfigDir(), 'global.ini');
  return !fs.existsSync(user) && fs.existsSync(legacy) ? legacy : user;
}

/** "Change the URL in OBS" on disk (see withLegacyDockReplaced). Null when OBS has no config folder. */
export function replaceLegacyBrowserDock(
  title: string,
  url: string,
  kind: 'activity' | 'chat',
  credentialHash: string | null,
): { replaced: boolean } | null {
  const file = obsWindowIni();
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    if (!fs.existsSync(path.dirname(file))) return null;
  }
  const out = withLegacyDockReplaced(raw, title, url, kind, credentialHash);
  writeFileAtomic(file, out.ini);
  return { replaced: out.replaced };
}

/** Adds or updates an OBS Custom Browser Dock in OBS's user.ini. */
export function installBrowserDock(title: string, url: string): boolean {
  const file = obsWindowIni();
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    if (!fs.existsSync(path.dirname(file))) return false;
  }
  writeFileAtomic(file, withBrowserDock(raw, title, url));
  return true;
}


/* ------------------------------------------------------------------ */
/* Both Trigglow docks in one go (desktop "Set up both docks in OBS")  */
/* ------------------------------------------------------------------ */

export type TrigglowDockKind = 'activity' | 'chat';

/** Web hosts a code-linked Trigglow dock may live on (any fragment: OBS keeps the `#e=` it was installed with). */
const DOCK_PAGE_HOSTS = new Set(['www.trigglow.com', 'trigglow.com', 'dev.trigglow.com', 'localhost', '127.0.0.1']);

/** The kind of a Trigglow dock already in OBS: `<web>/dock/<kind>` (code-linked) or the old `dock.trigglow.com/<kind>` (legacy). */
export function trigglowDockIn(url: unknown): { kind: TrigglowDockKind; legacy: boolean } | null {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    const p = u.pathname.toLowerCase().replace(/\/+$/, '');
    if (DOCK_PAGE_HOSTS.has(u.hostname) && (p === '/dock/activity' || p === '/dock/chat')) return { kind: p === '/dock/chat' ? 'chat' : 'activity', legacy: false };
    const oldHost = u.hostname === 'dock.trigglow.com' || u.host === 'dock.localhost:5173';
    if (oldHost && (p === '/activity' || p === '/chat')) return { kind: p === '/chat' ? 'chat' : 'activity', legacy: true };
  } catch {
    /* not a URL */
  }
  return null;
}

function docksOfIni(rawUserIni: string | null): Array<{ title: string; url: string }> {
  const lines = rawUserIni ? rawUserIni.split(/\r?\n/) : [];
  const json = getIniKey(lines, 'BasicWindow', 'ExtraBrowserDocks');
  try {
    const parsed = json ? (JSON.parse(json) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as Array<{ title: string; url: string }>).filter((d) => d && typeof d.title === 'string') : [];
  } catch {
    return [];
  }
}

export type DockPresence = { linked: boolean; legacy: boolean };

/** What OBS already has, per kind: a code-linked Trigglow dock (`linked`) and/or an old secret-URL one (`legacy`). */
export function trigglowDocksIn(rawUserIni: string | null): Record<TrigglowDockKind, DockPresence> {
  const out: Record<TrigglowDockKind, DockPresence> = { activity: { linked: false, legacy: false }, chat: { linked: false, legacy: false } };
  for (const d of docksOfIni(rawUserIni)) {
    const t = trigglowDockIn(d.url);
    if (t) out[t.kind][t.legacy ? 'legacy' : 'linked'] = true;
  }
  return out;
}

export interface DockToWrite {
  kind: TrigglowDockKind;
  title: string;
  url: string;
  /** sha256 of the `#k=` credential of the legacy dock this one replaces (review L2), or null. */
  replaceCredentialHash?: string | null;
}
export type DockWriteAction = 'added' | 'replaced' | 'kept';

/**
 * Pure: writes the Trigglow docks into OBS's user.ini, never twice.
 * - With `replaceCredentialHash`, only the old `#k=` dock with that credential is swapped (its title kept);
 * - a kind that already has a code-linked Trigglow dock in OBS is `kept`: every dock of a kind in one OBS
 *   shares the same credential store, so a second one would only show the first (and its ticket would go
 *   unused);
 * - otherwise the dock is `added`, under a title no other dock uses (an existing dock is never overwritten
 *   because of its name).
 */
export function withTrigglowDocks(rawUserIni: string | null, docks: readonly DockToWrite[]): { ini: string; results: { kind: TrigglowDockKind; action: DockWriteAction }[] } {
  let ini = rawUserIni ?? '';
  const results: { kind: TrigglowDockKind; action: DockWriteAction }[] = [];
  for (const d of docks) {
    if (d.replaceCredentialHash) {
      const r = withLegacyDockReplaced(ini, d.title, d.url, d.kind, d.replaceCredentialHash);
      if (r.replaced) {
        ini = r.ini;
        results.push({ kind: d.kind, action: 'replaced' });
        continue;
      }
    }
    const current = docksOfIni(ini);
    if (current.some((x) => trigglowDockIn(x.url)?.kind === d.kind && !trigglowDockIn(x.url)?.legacy)) {
      results.push({ kind: d.kind, action: 'kept' });
      continue;
    }
    const taken = new Set(current.map((x) => x.title.toLowerCase()));
    let title = d.title;
    for (let n = 2; taken.has(title.toLowerCase()); n++) title = `${d.title} ${n}`.slice(0, 60);
    ini = withBrowserDock(ini, title, d.url);
    results.push({ kind: d.kind, action: 'added' });
  }
  return { ini: ini || (rawUserIni ?? ''), results };
}

/** What OBS has on disk now (see trigglowDocksIn); null when OBS has no config folder. */
export function readTrigglowDocks(): Record<TrigglowDockKind, DockPresence> | null {
  const file = obsWindowIni();
  try {
    return trigglowDocksIn(fs.readFileSync(file, 'utf8'));
  } catch {
    return fs.existsSync(path.dirname(file)) ? trigglowDocksIn(null) : null;
  }
}

/** withTrigglowDocks on disk; null when OBS has no config folder. */
export function installTrigglowDocks(docks: readonly DockToWrite[]): { kind: TrigglowDockKind; action: DockWriteAction }[] | null {
  const file = obsWindowIni();
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    if (!fs.existsSync(path.dirname(file))) return null;
  }
  const out = withTrigglowDocks(raw, docks);
  writeFileAtomic(file, out.ini);
  return out.results;
}

export function withReplayBufferEnabled(ini: string | null, seconds = 30, forceSeconds = false): string {
  const eol = ini?.includes('\r\n') ? '\r\n' : '\n';
  let lines = ini ? ini.split(/\r?\n/) : [];
  const mode = /^\s*Mode\s*=\s*(\w+)/im.exec(ini ?? '')?.[1];
  const section = mode && mode.toLowerCase() === 'advanced' ? 'AdvOut' : 'SimpleOutput';
  lines = setIniKey(lines, section, 'RecRB', 'true');
  lines = setIniKey(lines, section, 'RecRBTime', String(seconds), !forceSeconds);
  const out = lines.join(eol).replace(/\s*$/, '') + eol;
  return forceSeconds ? withReplaySeconds(out, seconds) : out; // also keeps the memory cap above the length
}

/** Applies a transform to the ACTIVE OBS profile's basic.ini. OBS reads it at startup and rewrites it on exit, so call it only while OBS is closed. */
function editActiveProfile(transform: (raw: string | null) => string): boolean {
  const base = obsConfigDir();
  // OBS 31+ keeps the active profile in user.ini; older versions in global.ini.
  let profileDir: string | null = null;
  for (const ini of ['user.ini', 'global.ini']) {
    try {
      profileDir = /^ProfileDir=(.+)$/m.exec(fs.readFileSync(path.join(base, ini), 'utf8'))?.[1]?.trim() ?? null;
    } catch {
      /* not there */
    }
    if (profileDir) break;
  }
  if (!profileDir) {
    try {
      profileDir = fs.readdirSync(path.join(base, 'basic', 'profiles'))[0] ?? null;
    } catch {
      return false;
    }
  }
  if (!profileDir) return false;
  const file = path.join(base, 'basic', 'profiles', profileDir, 'basic.ini');
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    if (!fs.existsSync(path.dirname(file))) return false;
  }
  try {
    writeFileAtomic(file, transform(raw));
  } catch {
    return false; // locked or unwritable: the profile is left as it was
  }
  return true;
}

/** Turns the Replay Buffer on in the active profile. `seconds` = the length the user chose in Trigglow (null: keep OBS's own). */
export function enableReplayBufferInProfile(seconds: number | null = null): boolean {
  return editActiveProfile((raw) => withReplayBufferEnabled(raw, seconds ?? 30, seconds != null));
}

/** Sets the Replay Buffer length in the active profile (OBS closed). */
export function setReplaySecondsInProfile(seconds: number): boolean {
  return editActiveProfile((raw) => withReplaySeconds(raw, seconds));
}

/** The length currently stored in the active profile (OBS closed), or null. */
function readReplaySecondsFromProfile(): number | null {
  let out: number | null = null;
  editActiveProfile((raw) => {
    out = replaySecondsFromIni(raw);
    return raw ?? ''; // read-only use: writes back what it found
  });
  return out;
}

function run(cmd: string, args: string[], timeout = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FLATPAK_OBS = 'com.obsproject.Studio';

/**
 * Windows needs the exe (and its folder as cwd) to launch OBS. Linux: `obs` on PATH, else the Flatpak (returned as
 * `flatpak`, launched with `run com.obsproject.Studio`), else the Snap; null = no OBS to start. macOS launches by name.
 */
export async function findObsExecutable(): Promise<string | null> {
  if (process.platform === 'linux') {
    if ((await run('which', ['obs']))?.trim()) return 'obs';
    if ((await run('flatpak', ['info', FLATPAK_OBS])) !== null) return 'flatpak';
    return fs.existsSync('/snap/bin/obs-studio') ? '/snap/bin/obs-studio' : null;
  }
  if (process.platform !== 'win32') return null;
  // 1. the running instance (covers custom install locations)
  const live = (await run('powershell', ['-NoProfile', '-Command', '(Get-Process obs64 -ErrorAction SilentlyContinue | Select-Object -First 1).Path']))?.trim();
  if (live && fs.existsSync(live)) return live;
  // 2. the installer's registry entry
  const reg = await run('reg', ['query', 'HKLM\\SOFTWARE\\OBS Studio', '/ve']);
  const dir = reg?.match(/REG_SZ\s+(.+)/)?.[1]?.trim();
  const candidates = [
    dir && path.join(dir, 'bin', '64bit', 'obs64.exe'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'obs-studio', 'bin', '64bit', 'obs64.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'obs-studio', 'bin', '64bit', 'obs64.exe'),
  ].filter((c): c is string => Boolean(c));
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

export function launchObs(exe: string | null, args: string[] = []): void {
  if (process.platform !== 'darwin' && !exe) return; // spawn(null) would throw: nothing to start (callers check first)
  const detached = { detached: true, stdio: 'ignore' as const };
  let child: ChildProcess;
  try {
    child =
      process.platform === 'win32'
        ? spawn(exe as string, args, { ...detached, cwd: path.dirname(exe as string) }) // OBS must start from its own bin dir
        : process.platform === 'darwin'
          ? spawn('open', ['-a', 'OBS', ...(args.length ? ['--args', ...args] : [])], detached)
          : exe === 'flatpak'
            ? spawn('flatpak', ['run', FLATPAK_OBS, ...args], detached)
            : spawn(exe as string, args, detached);
  } catch {
    return; // EPERM/EACCES thrown synchronously (antivirus, policy): same as not finding OBS
  }
  child.on('error', () => undefined); // e.g. `obs` not on PATH — the connection loop will simply keep waiting
  child.unref();
}

/** Asks OBS to quit like the user would (it may still prompt if it is streaming/recording) and waits for it to go. */
export async function closeObs(timeoutMs = 30_000): Promise<boolean> {
  if (process.platform === 'win32') await run('taskkill', ['/IM', 'obs64.exe']);
  else if (process.platform === 'darwin') await run('osascript', ['-e', 'tell application "OBS" to quit']);
  else await run('pkill', ['-TERM', '-x', 'obs']);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await isObsRunning()) === false) {
      await sleep(800); // let it finish writing its config on exit
      return true;
    }
    await sleep(500);
  }
  return false;
}

export type ReplayFixResult = 'started' | 'needs_restart' | 'restarted' | 'enabled_and_launched' | 'close_failed' | 'no_obs_found' | 'no_profile' | 'error';

export type FixResult = 'launched' | 'enabled_and_launched' | 'needs_restart' | 'restarted' | 'close_failed' | 'no_obs_found' | 'nothing';
