import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Counter-Strike 2 Game State Integration: CS2 POSTs its state to the local server (POST /cs2-gsi, see
 * local-server.ts) through the gamestate_integration_trigglow.cfg this module installs. We reduce it to one line
 * for the game-rank overlay and forward it to the API while live, like LoL's live line.
 */

export type Cs2Team = 'CT' | 'T';

export interface Cs2Line {
  steamid: string;
  map: { mode: string; name: string; phase: string; round: number; ct: number; t: number };
  team: Cs2Team | null;
  round: { phase: string; winTeam: Cs2Team | null };
  stats: { kills: number; assists: number; deaths: number; mvps: number; score: number };
  state: { health: number; armor: number; money: number; roundKills: number; roundKillHs: number };
  /** Active weapon, GSI name ("weapon_ak47"); '' when none. */
  weapon: string;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 64) : '');
const team = (v: unknown): Cs2Team | null => (v === 'CT' || v === 'T' ? v : null);

/** The weapon GSI marks `state: active` (player_weapons block). */
function activeWeapon(v: unknown): string {
  for (const w of Object.values(obj(v))) if (obj(w).state === 'active') return str(obj(w).name);
  return '';
}

/** The streamer's own state from a GSI payload; undefined when spectating, in the menu or the payload is junk. */
export function cs2Line(payload: unknown): Cs2Line | undefined {
  const p = obj(payload);
  const provider = obj(p.provider);
  const player = obj(p.player);
  const steamid = str(provider.steamid);
  if (!steamid || str(player.steamid) !== steamid) return undefined;
  const map = obj(p.map);
  const round = obj(p.round);
  const ms = obj(player.match_stats);
  const st = obj(player.state);
  return {
    steamid,
    map: { mode: str(map.mode), name: str(map.name), phase: str(map.phase), round: num(map.round), ct: num(obj(map.team_ct).score), t: num(obj(map.team_t).score) },
    team: team(player.team),
    round: { phase: str(round.phase), winTeam: team(round.win_team) },
    stats: { kills: num(ms.kills), assists: num(ms.assists), deaths: num(ms.deaths), mvps: num(ms.mvps), score: num(ms.score) },
    state: { health: num(st.health), armor: num(st.armor), money: num(st.money), roundKills: num(st.round_kills), roundKillHs: num(st.round_killhs) },
    weapon: activeWeapon(player.weapons),
  };
}

/** What makes a line worth sending right away (otherwise it waits for the 5 s refresh). */
const changeKey = (l: Cs2Line) =>
  [l.map.phase, l.map.round, l.map.ct, l.map.t, l.stats.kills, l.stats.deaths, l.stats.assists, l.stats.mvps, l.state.roundKills, l.state.health > 0].join('|');

const LIVE_LINE_MS = 5000;

/** Forwards GSI pushes as live lines while `active()`: on a meaningful change at once, otherwise at most every 5 s. */
export class Cs2Forwarder {
  private lastKey = '';
  private lastAt = 0;

  constructor(
    private active: () => boolean,
    private send: (line: Cs2Line) => void,
    private now = () => Date.now(),
  ) {}

  push(payload: unknown): void {
    if (!this.active()) return;
    const line = cs2Line(payload);
    if (!line) return;
    const key = changeKey(line);
    if (key === this.lastKey && this.now() - this.lastAt < LIVE_LINE_MS) return;
    this.lastKey = key;
    this.lastAt = this.now();
    this.send(line);
  }
}

export const GSI_CFG_NAME = 'gamestate_integration_trigglow.cfg';

export function gsiCfg(port: number, token: string): string {
  return `"Trigglow"
{
  "uri" "http://127.0.0.1:${port}/cs2-gsi"
  "timeout" "5.0"
  "buffer" "0.1"
  "throttle" "0.5"
  "heartbeat" "10.0"
  "auth"
  {
    "token" "${token}"
  }
  "data"
  {
    "provider" "1"
    "map" "1"
    "round" "1"
    "player_id" "1"
    "player_state" "1"
    "player_match_stats" "1"
    "player_weapons" "1"
  }
}
`;
}

/** Library paths from Steam's libraryfolders.vdf, the one holding app 730 (CS2) first. */
export function steamLibraries(vdf: string): string[] {
  const matches = [...vdf.matchAll(/"path"\s+"((?:[^"\\]|\\.)*)"/g)];
  const libs = matches.map((m, i) => {
    const block = vdf.slice(m.index, matches[i + 1]?.index ?? vdf.length);
    return { path: m[1]!.replace(/\\\\/g, '\\'), cs2: /"apps"\s*\{[^}]*"730"/.test(block) };
  });
  return [...libs.filter((l) => l.cs2), ...libs.filter((l) => !l.cs2)].map((l) => l.path);
}

const CFG_SUBDIR = path.join('steamapps', 'common', 'Counter-Strike Global Offensive', 'game', 'csgo', 'cfg');

function steamPath(): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null); // ponytail: Windows only; add ~/.steam/steam for Linux if asked
  return new Promise((resolve) =>
    execFile('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { timeout: 3000, windowsHide: true }, (err, out) => {
      const m = err ? null : /SteamPath\s+REG_SZ\s+(.+)/.exec(String(out));
      resolve(m ? path.normalize(m[1]!.trim()) : null);
    }),
  );
}

/** Writes the GSI cfg into CS2's cfg folder when missing or different. CS2 reads it on start, so a running game needs a restart. */
export async function installCs2Gsi(port: number, token: string): Promise<void> {
  try {
    const steam = await steamPath();
    if (!steam) return console.log('[cs2] Steam not found; GSI cfg not installed');
    let libs = [steam];
    try {
      libs = [...steamLibraries(fs.readFileSync(path.join(steam, 'steamapps', 'libraryfolders.vdf'), 'utf8')), steam];
    } catch {
      /* no libraryfolders.vdf: only the main library */
    }
    const dir = libs.map((l) => path.join(l, CFG_SUBDIR)).find((d) => fs.existsSync(d));
    if (!dir) return console.log('[cs2] CS2 not installed; GSI cfg not installed');
    const file = path.join(dir, GSI_CFG_NAME);
    const want = gsiCfg(port, token);
    let have = '';
    try {
      have = fs.readFileSync(file, 'utf8');
    } catch {
      /* missing */
    }
    if (have === want) return;
    fs.writeFileSync(file, want, 'utf8');
    console.log(`[cs2] GSI cfg written to ${file} (restart CS2 to pick it up)`);
  } catch (err) {
    console.warn('[cs2] could not install the GSI cfg:', (err as Error).message);
  }
}
