import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// "Now playing" from Windows' media session (SMTC: the same feed as the volume
// flyout), for the music overlay when Spotify's API isn't available. Read by a
// long-lived PowerShell that prints one JSON line every 2s — no native module.
// Prefers Spotify's session, else whatever Windows considers current.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*' } | Select-Object -First 1
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); [void]$task.Wait(5000); $task.Result }
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asStream = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@([Windows.Storage.Streams.IInputStream]))
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$lastKey = ''; $img = $null; $tries = 0
while ($true) {
  $out = 'null'
  try {
    $s = @($mgr.GetSessions()) | Where-Object { $_.SourceAppUserModelId -like '*Spotify*' } | Select-Object -First 1
    if (-not $s) { $s = $mgr.GetCurrentSession() }
    if ($s) {
      $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      if ($p -and $p.Title) {
        $tl = $s.GetTimelineProperties()
        $playing = $s.GetPlaybackInfo().PlaybackStatus -eq 'Playing'
        $pos = $tl.Position.TotalMilliseconds
        if ($playing -and $tl.LastUpdatedTime.Year -gt 2000) { $pos += ([DateTimeOffset]::Now - $tl.LastUpdatedTime).TotalMilliseconds }
        $key = "$($p.Artist)|$($p.Title)"
        if ($key -ne $lastKey) { $lastKey = $key; $img = $null; $imgSent = $false; $tries = 0 }
        # Players can publish the art a moment after the title: retry a few polls.
        if (-not $img -and $tries -lt 3) {
          $tries++
          if ($p.Thumbnail) {
            try {
              $st = Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
              # PowerShell can't bind the WinRT stream to IInputStream directly; reflection's Invoke does the COM cast (same as AsTask).
              $ns = $asStream.Invoke($null, @($st))
              $ms = New-Object System.IO.MemoryStream
              $ns.CopyTo($ms)
              if ($ms.Length -gt 0 -and $ms.Length -lt 280000) {
                $type = if ($st.ContentType) { $st.ContentType } else { 'image/jpeg' }
                $img = "data:$type;base64," + [Convert]::ToBase64String($ms.ToArray())
              }
            } catch { $img = $null }
          }
        }
        # The art goes out once per track (it can be ~370 KB of base64); Node keeps it from there.
        $outImg = $null
        if ($img -and -not $imgSent) { $outImg = $img; $imgSent = $true }
        $out = ConvertTo-Json -Compress @{ title = $p.Title; artist = $p.Artist; durationMs = [long]$tl.EndTime.TotalMilliseconds; positionMs = [long]$pos; isPlaying = $playing; imageUrl = $outImg }
      }
    }
  } catch { $out = 'null' }
  [Console]::Out.WriteLine($out)
  [Console]::Out.Flush()
  Start-Sleep -Seconds 2
}
`;

export interface NowPlaying {
  title: string;
  artist: string;
  durationMs: number;
  positionMs: number;
  isPlaying: boolean;
  imageUrl: string | null;
  /** Heartbeat without the artwork: the server keeps the one it got for this track. */
  imageKept?: boolean;
}

/** One line of script output → NowPlaying, or null for "nothing playing" / junk. */
export function parseNowPlayingLine(line: string): NowPlaying | null {
  try {
    const o = JSON.parse(line) as Partial<NowPlaying> | null;
    if (!o || typeof o.title !== 'string' || !o.title) return null;
    return {
      title: o.title,
      artist: typeof o.artist === 'string' ? o.artist : '',
      durationMs: Number(o.durationMs) || 0,
      positionMs: Number(o.positionMs) || 0,
      isPlaying: o.isPlaying === true,
      imageUrl: typeof o.imageUrl === 'string' ? o.imageUrl : null,
    };
  } catch {
    return null;
  }
}

/** Fingerprint without the ever-moving position — a change here is reported right away. */
export function nowPlayingKey(np: NowPlaying | null): string {
  return np ? `${np.artist}|${np.title}|${np.isPlaying}|${np.imageUrl?.length ?? 0}` : '';
}

/** `playerctl metadata --format`: status, position and length (µs), art URL, artist, title — tab-separated (title last, it may hold anything). */
export const PLAYERCTL_FORMAT = '{{status}}\t{{position}}\t{{mpris:length}}\t{{mpris:artUrl}}\t{{artist}}\t{{title}}';

/** One `playerctl` line → NowPlaying without the art (artUrl is fetched separately), or null when nothing is playing. */
export function parsePlayerctlLine(line: string): (Omit<NowPlaying, 'imageUrl'> & { artUrl: string }) | null {
  const [status, pos, len, artUrl = '', artist = '', ...rest] = line.split('\t');
  const title = rest.join('\t').trim();
  if (!title || (status !== 'Playing' && status !== 'Paused')) return null;
  return {
    title,
    artist: artist.trim(),
    durationMs: Math.round(Number(len) / 1000) || 0,
    positionMs: Math.round(Number(pos) / 1000) || 0,
    isPlaying: status === 'Playing',
    artUrl: artUrl.trim(),
  };
}

const ART_MAX_BYTES = 280_000;

/** The image type from the file's own bytes (never its name), or null for anything that isn't a picture. */
export function imageTypeFromBytes(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return null;
}

/**
 * `mpris:artUrl` can be copied straight from a playlist's metadata, and the art ends up on the public music overlay,
 * so a local file is only read from where players cache their art (temp and cache dirs), after resolving symlinks.
 */
export function isAllowedArtFile(realFile: string, roots: readonly string[] = artRoots()): boolean {
  return roots.some((root) => {
    const rel = path.relative(root, realFile);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}

function artRoots(): string[] {
  const home = process.env.HOME ?? '';
  const cache = process.env.XDG_CACHE_HOME || (home && path.join(home, '.cache'));
  return [...new Set(['/tmp', '/var/tmp', process.env.TMPDIR ?? '', process.env.XDG_RUNTIME_DIR ?? '', cache].filter(Boolean))].map((d) => {
    try {
      return fs.realpathSync(d);
    } catch {
      return d;
    }
  });
}

/** Art CDNs players hand out over https; anything else (LAN hosts, arbitrary sites) is never fetched from the streamer's PC. */
const ART_HOSTS = ['scdn.co', 'spotifycdn.com', 'ytimg.com', 'googleusercontent.com', 'sndcdn.com', 'dzcdn.net', 'mzstatic.com', 'tidal.com'];

export function isAllowedArtHost(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return u.protocol === 'https:' && !u.username && !u.password && ART_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/** MPRIS art (https:// from Spotify & co, file:// from local players' caches) → the same data: URL the Windows script sends. */
async function artToDataUrl(url: string): Promise<string | null> {
  try {
    let buf: Buffer;
    if (url.startsWith('file://')) {
      const file = await fs.promises.realpath(fileURLToPath(url));
      if (!isAllowedArtFile(file)) return null;
      const st = await fs.promises.stat(file);
      if (!st.isFile() || st.size === 0 || st.size >= ART_MAX_BYTES) return null;
      buf = await fs.promises.readFile(file);
    } else if (isAllowedArtHost(url)) {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (!r.ok) return null;
      buf = Buffer.from(await r.arrayBuffer());
    } else return null;
    const type = imageTypeFromBytes(buf);
    return type && buf.length < ART_MAX_BYTES ? `data:${type};base64,${buf.toString('base64')}` : null;
  } catch {
    return null;
  }
}

const HEARTBEAT_MS = 10_000;

export class NowPlayingWatcher {
  private proc: ChildProcess | null = null;
  private wanted = false;
  private lastKey: string | null = null;
  private lastSentAt = 0;
  private art: { track: string; url: string } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private linuxArt: { url: string; data: Promise<string | null> } | null = null;

  constructor(private report: (np: NowPlaying | null) => void) {}

  start(): void {
    this.wanted = true;
    if (process.platform === 'linux') return this.startLinux();
    if (this.proc || process.platform !== 'win32') return;
    let proc: ChildProcess;
    try {
      proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch (err) {
      // EPERM/EACCES is thrown synchronously when antivirus or policy blocks powershell.exe: no now-playing, no crash, no retry.
      return console.warn('[now-playing] spawn failed:', (err as Error).message);
    }
    this.proc = proc;
    let buf = '';
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        this.onLine(buf.slice(0, nl).trim());
        buf = buf.slice(nl + 1);
      }
    });
    proc.on('error', (err) => console.warn('[now-playing] spawn failed:', err.message));
    proc.on('exit', () => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (this.wanted) setTimeout(() => this.wanted && this.start(), 15_000);
    });
  }

  /** Linux: polls MPRIS through `playerctl` (Spotify first, else any player). Without playerctl it says so once and stops. */
  private startLinux(): void {
    if (this.timer) return;
    const poll = () =>
      execFile('playerctl', ['-p', 'spotify,%any', 'metadata', '--format', PLAYERCTL_FORMAT], { timeout: 3000 }, async (err, stdout) => {
        if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
          console.warn('[now-playing] playerctl is not installed: install it (e.g. `sudo apt install playerctl`) to show what is playing');
          return this.stopTimer();
        }
        const np = err ? null : parsePlayerctlLine(String(stdout).trim());
        let imageUrl: string | null = null;
        if (np?.artUrl) {
          if (this.linuxArt?.url !== np.artUrl) this.linuxArt = { url: np.artUrl, data: artToDataUrl(np.artUrl) };
          imageUrl = await this.linuxArt.data;
        }
        if (!this.timer) return; // stopped while fetching the art
        this.onLine(np ? JSON.stringify({ ...np, artUrl: undefined, imageUrl }) : 'null');
      });
    this.timer = setInterval(poll, 2000);
    poll();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  stop(): void {
    this.wanted = false;
    this.lastKey = null;
    this.stopTimer();
    const proc = this.proc;
    this.proc = null;
    proc?.kill();
  }

  private onLine(line: string): void {
    if (!line) return;
    const np = parseNowPlayingLine(line);
    // The script sends the art only once per track: remember it so the key (and a track change) still sees it.
    const track = np ? `${np.artist}|${np.title}` : '';
    if (np?.imageUrl) this.art = { track, url: np.imageUrl };
    else if (np && this.art?.track === track) np.imageUrl = this.art.url;
    const key = nowPlayingKey(np);
    // Unchanged + nothing playing: stay quiet. Unchanged + playing: heartbeat keeps the server copy alive and resyncs position.
    if (key === this.lastKey && (!np || Date.now() - this.lastSentAt < HEARTBEAT_MS)) return;
    const heartbeat = key === this.lastKey;
    this.lastKey = key;
    this.lastSentAt = Date.now();
    this.report(heartbeat && np?.imageUrl ? { ...np, imageUrl: null, imageKept: true } : np);
  }
}
