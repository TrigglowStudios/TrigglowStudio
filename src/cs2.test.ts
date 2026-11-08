import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Cs2Forwarder, cs2Line, gsiCfg, steamLibraries } from './cs2';

const payload = (over: { player?: Record<string, unknown> } = {}) => ({
  provider: { name: 'Counter-Strike: Global Offensive', appid: 730, steamid: '765611' },
  map: { mode: 'competitive', name: 'de_mirage', phase: 'live', round: 7, team_ct: { score: 4 }, team_t: { score: 3 } },
  round: { phase: 'over', win_team: 'CT' },
  player: {
    steamid: '765611',
    team: 'CT',
    match_stats: { kills: 9, assists: 2, deaths: 5, mvps: 1, score: 22 },
    state: { health: 100, armor: 50, money: 3400, round_kills: 2, round_killhs: 1 },
    weapons: { weapon_0: { name: 'weapon_knife', state: 'holstered' }, weapon_1: { name: 'weapon_ak47', state: 'active' } },
    ...over.player,
  },
  auth: { token: 'x' },
});

test('reduces a GSI payload to the live line', () => {
  assert.deepEqual(cs2Line(payload()), {
    steamid: '765611',
    map: { mode: 'competitive', name: 'de_mirage', phase: 'live', round: 7, ct: 4, t: 3 },
    team: 'CT',
    round: { phase: 'over', winTeam: 'CT' },
    stats: { kills: 9, assists: 2, deaths: 5, mvps: 1, score: 22 },
    state: { health: 100, armor: 50, money: 3400, roundKills: 2, roundKillHs: 1 },
    weapon: 'weapon_ak47',
  });
});

test('nothing while spectating, in the menu or for junk', () => {
  assert.equal(cs2Line(payload({ player: { steamid: '999' } })), undefined);
  assert.equal(cs2Line({ provider: { steamid: '765611' } }), undefined);
  assert.equal(cs2Line(null), undefined);
  assert.equal(cs2Line('nope'), undefined);
});

test('missing fields become 0/null', () => {
  const l = cs2Line({ provider: { steamid: '1' }, player: { steamid: '1', team: 'X', state: { health: 'a' } } })!;
  assert.equal(l.team, null);
  assert.equal(l.round.winTeam, null);
  assert.deepEqual(l.map, { mode: '', name: '', phase: '', round: 0, ct: 0, t: 0 });
  assert.equal(l.state.health, 0);
  assert.equal(l.stats.kills, 0);
});

test('forwards changes at once, repeats at most every 5 s, nothing when inactive', () => {
  let now = 0;
  let active = true;
  const sent: number[] = [];
  const f = new Cs2Forwarder(() => active, (l) => sent.push(l.stats.kills), () => now);
  f.push(payload());
  now = 1000;
  f.push(payload()); // same: throttled
  f.push(payload({ player: { match_stats: { kills: 10 } } })); // kill: at once
  now = 2000;
  f.push(payload({ player: { match_stats: { kills: 10 }, state: { health: 100, armor: 50, money: 100, round_kills: 2, round_killhs: 1 } } })); // money only: throttled
  now = 6500;
  f.push(payload({ player: { match_stats: { kills: 10 } } })); // 5 s refresh
  active = false;
  now = 20000;
  f.push(payload());
  assert.deepEqual(sent, [9, 10, 10]);
});

test('the cfg points at the local endpoint with the token', () => {
  const cfg = gsiCfg(45455, 'abc');
  assert.match(cfg, /"uri" "http:\/\/127\.0\.0\.1:45455\/cs2-gsi"/);
  assert.match(cfg, /"token" "abc"/);
  assert.match(cfg, /"player_match_stats" "1"/);
});

test('finds the Steam library holding CS2', () => {
  // Steam escapes backslashes in the vdf: "C:\\Program Files (x86)\\Steam".
  const vdf = String.raw`"libraryfolders"
{
  "0" { "path" "C:\\Program Files (x86)\\Steam" "apps" { "228980" "1" } }
  "1" { "path" "D:\\SteamLibrary" "apps" { "730" "123" "440" "1" } }
}`;
  assert.deepEqual(steamLibraries(vdf), [String.raw`D:\SteamLibrary`, String.raw`C:\Program Files (x86)\Steam`]);
});
