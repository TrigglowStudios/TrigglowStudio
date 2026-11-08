/**
 * League of Legends events as stream moments (docs/product/POST_STREAM_SUMMARY_PLAN.md, "Game signals"): while the
 * streamer is live, read Riot's official Live Client Data API (only answers during a match, on this PC) and report the
 * player's kills, multikills, objectives, escapes, when each match starts and how it ends (champion + KDA). The server
 * stores them next to chat and alerts, so the post-stream highlights know what happened in the game, not just around
 * it, and can recap each match on its own.
 */
import https from 'node:https';

export type LolMomentCode =
  | 'game_start'
  | 'kill'
  | 'double'
  | 'triple'
  | 'quadra'
  | 'penta'
  | 'first_blood'
  | 'ace'
  | 'dragon'
  | 'dragon_stolen'
  | 'herald'
  | 'baron'
  | 'baron_stolen'
  | 'inhib'
  | 'turret'
  | 'escape'
  | 'victory'
  | 'defeat';

/** The player's line at the end of a match. */
export interface LolMatchStats {
  champion: string;
  kills: number;
  deaths: number;
  assists: number;
}

export interface LolMoment {
  code: LolMomentCode;
  ageSec: number;
  stats?: LolMatchStats;
}

interface LolEvent {
  EventID: number;
  EventName: string;
  EventTime: number;
  KillerName?: string;
  VictimName?: string;
  KillStreak?: number;
  Recipient?: string;
  AcingTeam?: string;
  Stolen?: string;
  Result?: string;
}

interface LolPlayer {
  riotIdGameName?: string;
  summonerName?: string;
  riotId?: string;
  team?: string;
  championName?: string;
  /** "game_character_displayname_MissFortune": the Data Dragon id after the prefix. */
  rawChampionName?: string;
  isDead?: boolean;
  scores?: { kills?: number; deaths?: number; assists?: number; creepScore?: number };
  level?: number;
}

/** The parts of /liveclientdata/allgamedata this reads. */
export interface LolGameData {
  activePlayer?: {
    riotIdGameName?: string;
    riotId?: string;
    summonerName?: string;
    championStats?: { currentHealth?: number; maxHealth?: number };
    currentGold?: number;
    level?: number;
  };
  allPlayers?: LolPlayer[];
  events?: { Events?: LolEvent[] };
  gameData?: { gameTime?: number; gameMode?: string };
}

/** An event older than this (seconds of game time) is history, not something to report now. */
const MAX_AGE_SEC = 60;
const MULTI: Record<number, LolMomentCode> = { 2: 'double', 3: 'triple', 4: 'quadra', 5: 'penta' };

const norm = (name: string | undefined) => (name ?? '').split('#')[0]!.trim().toLowerCase();
const myName = (data: LolGameData) => norm(data.activePlayer?.riotIdGameName ?? data.activePlayer?.riotId ?? data.activePlayer?.summonerName);

function me(data: LolGameData): LolPlayer | undefined {
  const name = myName(data);
  return (data.allPlayers ?? []).find((p) => [p.riotIdGameName, p.summonerName, p.riotId].some((n) => n && norm(n) === name));
}

/** The player's champion and KDA right now. Pure. */
export function myStats(data: LolGameData): LolMatchStats | undefined {
  const p = me(data);
  if (!p?.championName) return undefined;
  return { champion: p.championName, kills: p.scores?.kills ?? 0, deaths: p.scores?.deaths ?? 0, assists: p.scores?.assists ?? 0 };
}

/** The player's live line for the Trigglow game-rank overlay (KDA, CS, gold, level, game clock). Pure. */
export interface LolLiveLine {
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  gold: number | null;
  level: number | null;
  gameTime: number;
  /** Data Dragon ids: the server builds the in-game view from these when Riot's spectator has no game (Practice Tool). */
  champion?: string;
  mode?: string;
  allies?: string[];
  enemies?: string[];
}

const champId = (p: LolPlayer | undefined) => {
  const id = (p?.rawChampionName ?? '').replace(/^game_character_displayname_/, '');
  return /^[A-Za-z0-9]{1,30}$/.test(id) ? id : undefined;
};

export function liveLine(data: LolGameData): LolLiveLine | undefined {
  const p = me(data);
  if (!p) return undefined;
  return {
    kills: p.scores?.kills ?? 0,
    deaths: p.scores?.deaths ?? 0,
    assists: p.scores?.assists ?? 0,
    cs: p.scores?.creepScore ?? 0,
    gold: typeof data.activePlayer?.currentGold === 'number' ? Math.round(data.activePlayer.currentGold) : null,
    level: data.activePlayer?.level ?? p.level ?? null,
    gameTime: Math.round(data.gameData?.gameTime ?? 0),
    champion: champId(p),
    mode: data.gameData?.gameMode?.slice(0, 20),
    allies: (data.allPlayers ?? []).filter((x) => x.team === p.team).map(champId).filter((c): c is string => Boolean(c)).slice(0, 5),
    enemies: (data.allPlayers ?? []).filter((x) => x.team && x.team !== p.team).map(champId).filter((c): c is string => Boolean(c)).slice(0, 5),
  };
}

/** How often the live line goes to Trigglow (the overlay doesn't need every 2 s poll). */
const LIVE_LINE_MS = 5000;

/**
 * New moments in a snapshot, each with how many seconds ago it happened. Marks every event it looks at as seen, so a
 * snapshot taken mid-game (app started late) reports nothing old. The result carries the player's stats. Pure apart
 * from `seen`.
 */
export function lolMoments(data: LolGameData, seen: Set<number>): LolMoment[] {
  const mine = myName(data);
  const teamOf = new Map<string, string>();
  for (const p of data.allPlayers ?? []) {
    for (const n of [p.riotIdGameName, p.summonerName, p.riotId]) if (n && p.team) teamOf.set(norm(n), p.team);
  }
  const myTeam = teamOf.get(mine);
  const ours = (name: string | undefined) => myTeam != null && teamOf.get(norm(name)) === myTeam;
  const now = data.gameData?.gameTime ?? 0;

  const out: LolMoment[] = [];
  for (const e of data.events?.Events ?? []) {
    if (seen.has(e.EventID)) continue;
    seen.add(e.EventID);
    const ageSec = Math.max(0, now - e.EventTime);
    if (ageSec > MAX_AGE_SEC || !mine) continue;
    const stolen = e.Stolen === 'True';
    const code: LolMomentCode | null =
      e.EventName === 'ChampionKill' && norm(e.KillerName) === mine
        ? 'kill'
        : e.EventName === 'Multikill' && norm(e.KillerName) === mine
          ? (MULTI[e.KillStreak ?? 0] ?? null)
          : e.EventName === 'FirstBlood' && norm(e.Recipient) === mine
            ? 'first_blood'
            : e.EventName === 'Ace' && myTeam != null && e.AcingTeam === myTeam
              ? 'ace'
              : e.EventName === 'DragonKill' && ours(e.KillerName)
                ? stolen ? 'dragon_stolen' : 'dragon'
                : e.EventName === 'BaronKill' && ours(e.KillerName)
                  ? stolen ? 'baron_stolen' : 'baron'
                  : e.EventName === 'HeraldKill' && ours(e.KillerName)
                    ? 'herald'
                    : e.EventName === 'InhibKilled' && ours(e.KillerName)
                      ? 'inhib'
                      : e.EventName === 'TurretKilled' && ours(e.KillerName)
                        ? 'turret'
                        : e.EventName === 'GameEnd'
                          ? e.Result === 'Win' ? 'victory' : 'defeat'
                          : null;
    if (!code) continue;
    const stats = code === 'victory' || code === 'defeat' ? myStats(data) : undefined;
    out.push({ code, ageSec, ...(stats ? { stats } : {}) });
  }
  return out;
}

/** Health share under which a fight counts as nearly lost, and back above which the player is out of it. */
const LOW_HP = 0.15;
const SAFE_HP = 0.3;
/** Still alive this long after dropping low = an escape (not a death a poll later). */
const ESCAPE_SEC = 6;

/** Follows the player's health across snapshots and spots escapes: nearly dead, then alive and recovering. */
export class EscapeTracker {
  private lowAt: number | null = null;

  /** One snapshot; returns how long ago the escape began (game seconds) when one completes, else null. Pure state. */
  step(data: LolGameData): number | null {
    const t = data.gameData?.gameTime ?? 0;
    const hp = data.activePlayer?.championStats?.currentHealth ?? 0;
    const max = data.activePlayer?.championStats?.maxHealth ?? 0;
    if (max <= 0 || hp <= 0 || me(data)?.isDead) {
      this.lowAt = null; // died (or no data): not an escape
      return null;
    }
    const ratio = hp / max;
    if (this.lowAt == null) {
      if (ratio < LOW_HP) this.lowAt = t;
      return null;
    }
    if (t - this.lowAt >= ESCAPE_SEC && ratio >= SAFE_HP) {
      const age = t - this.lowAt;
      this.lowAt = null;
      return age;
    }
    return null;
  }

  reset(): void {
    this.lowAt = null;
  }
}

/** GET on the local Live Client Data API. Its certificate is Riot's own self-signed one, on this machine only. */
function fetchGameData(): Promise<LolGameData | null> {
  return new Promise((resolve) => {
    const req = https.get(
      { host: '127.0.0.1', port: 2999, path: '/liveclientdata/allgamedata', rejectUnauthorized: false, timeout: 1500 },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(null);
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as LolGameData);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

const IN_GAME_POLL_MS = 2000;
const IDLE_POLL_MS = 10_000;

/** Polls while `active()` (streaming), reports each new moment once. */
export class LolWatcher {
  private seen = new Set<number>();
  private lastGameTime = Infinity;
  private escapes = new EscapeTracker();
  private lastLiveAt = 0;

  constructor(
    private active: () => boolean,
    private report: (m: { code: LolMomentCode; ageMs: number; stats?: LolMatchStats }) => void,
    /** The live line (KDA, CS, gold) every few seconds in game, for the game-rank overlay. */
    private live?: (line: LolLiveLine) => void,
  ) {
    void this.loop();
  }

  private async loop(): Promise<void> {
    let wait = IDLE_POLL_MS;
    if (this.active()) {
      const data = await fetchGameData();
      if (data) {
        const t = data.gameData?.gameTime ?? 0;
        if (t < this.lastGameTime) {
          // A new match (event ids restart at 0) — or the app opened mid-match: it started `t` seconds ago either way.
          this.seen.clear();
          this.escapes.reset();
          this.report({ code: 'game_start', ageMs: Math.round(t * 1000) });
        }
        this.lastGameTime = t;
        for (const m of lolMoments(data, this.seen)) this.report({ code: m.code, ageMs: Math.round(m.ageSec * 1000), ...(m.stats ? { stats: m.stats } : {}) });
        const escape = this.escapes.step(data);
        if (escape != null) this.report({ code: 'escape', ageMs: Math.round(escape * 1000) });
        const line = this.live && Date.now() - this.lastLiveAt >= LIVE_LINE_MS ? liveLine(data) : undefined;
        if (line) {
          this.lastLiveAt = Date.now();
          this.live!(line);
        }
        wait = IN_GAME_POLL_MS;
      } else {
        this.lastGameTime = Infinity;
      }
    }
    setTimeout(() => void this.loop(), wait);
  }
}
