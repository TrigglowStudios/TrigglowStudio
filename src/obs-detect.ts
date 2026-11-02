import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ObsDetect {
  /** OBS Studio has a config folder on this machine (it has been installed/run at least once). */
  installed: boolean;
  /** OBS process is running; null when we couldn't tell. */
  running: boolean | null;
  /** obs-websocket's own setting; null when its config file doesn't exist yet. */
  serverEnabled: boolean | null;
  port?: number;
  /** Only present when OBS requires authentication. Never persisted or logged. */
  password?: string;
}

export function obsConfigDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'obs-studio');
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'obs-studio');
  return linuxObsConfigDirs().find((d) => fs.existsSync(d)) ?? linuxObsConfigDirs()[0];
}

/** Native install first, then the Flatpak (the official distro-agnostic OBS) and the Snap, each with its own config. */
function linuxObsConfigDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'obs-studio'),
    path.join(home, '.var', 'app', 'com.obsproject.Studio', 'config', 'obs-studio'),
    path.join(home, 'snap', 'obs-studio', 'current', '.config', 'obs-studio'),
  ];
}

/** Parses obs-websocket's `plugin_config/obs-websocket/config.json`. Pure. */
export function parseWebsocketConfig(raw: string): Pick<ObsDetect, 'serverEnabled' | 'port' | 'password'> {
  try {
    const j = JSON.parse(raw) as { server_enabled?: unknown; server_port?: unknown; auth_required?: unknown; server_password?: unknown };
    const port = typeof j.server_port === 'number' && Number.isInteger(j.server_port) && j.server_port > 0 && j.server_port < 65536 ? j.server_port : undefined;
    const password = j.auth_required === true && typeof j.server_password === 'string' && j.server_password ? j.server_password : undefined;
    return { serverEnabled: typeof j.server_enabled === 'boolean' ? j.server_enabled : null, port, password };
  } catch {
    return { serverEnabled: null };
  }
}

function run(cmd: string, args: string[]): Promise<{ code: number; out: string } | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3000, windowsHide: true }, (err, stdout) => {
      if (err && typeof (err as NodeJS.ErrnoException).code !== 'number') return resolve(null); // couldn't execute at all
      resolve({ code: err ? ((err as NodeJS.ErrnoException).code as unknown as number) : 0, out: String(stdout) });
    });
  });
}

export async function isObsRunning(platform: NodeJS.Platform = process.platform): Promise<boolean | null> {
  if (platform === 'win32') {
    const r = await run('tasklist', ['/FI', 'IMAGENAME eq obs64.exe', '/NH']);
    return r ? /obs64\.exe/i.test(r.out) : null;
  }
  const r = await run('pgrep', ['-x', platform === 'darwin' ? 'OBS' : 'obs']);
  return r ? r.code === 0 : null;
}

export async function detectObs(): Promise<ObsDetect> {
  const dir = obsConfigDir();
  const installed = fs.existsSync(dir);
  let ws: ReturnType<typeof parseWebsocketConfig> = { serverEnabled: null };
  try {
    ws = parseWebsocketConfig(fs.readFileSync(path.join(dir, 'plugin_config', 'obs-websocket', 'config.json'), 'utf8'));
  } catch {
    /* no config yet: the WebSocket server was never opened in this OBS */
  }
  return { installed, running: await isObsRunning(), ...ws };
}

/** Why we are (not) connected, in terms the UI can turn into one concrete next step. */
export type ObsHint = 'connected' | 'checking' | 'not_running' | 'server_disabled' | 'auth_failed' | 'unreachable';

export function obsHint(
  state: 'connected' | 'connecting' | 'disconnected' | 'error',
  d: Pick<ObsDetect, 'running' | 'serverEnabled'> | null,
  error?: string,
): ObsHint {
  if (state === 'connected') return 'connected';
  if (error && /authentication/i.test(error)) return 'auth_failed';
  if (d?.running === false) return 'not_running';
  if (d?.serverEnabled === false) return 'server_disabled';
  return state === 'connecting' && !error ? 'checking' : 'unreachable';
}
