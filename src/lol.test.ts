import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EscapeTracker, liveLine, lolMoments, type LolGameData } from './lol';

const players = [
  { riotIdGameName: 'Streamer', riotId: 'Streamer#EUW', team: 'ORDER' },
  { riotIdGameName: 'Mate', riotId: 'Mate#EUW', team: 'ORDER' },
  { riotIdGameName: 'Enemy', riotId: 'Enemy#EUW', team: 'CHAOS' },
];
type Events = NonNullable<NonNullable<LolGameData['events']>['Events']>;
const game = (events: Events, gameTime: number): LolGameData => ({
  activePlayer: { riotId: 'Streamer#EUW' },
  allPlayers: players,
  events: { Events: events },
  gameData: { gameTime },
});

test('reports the player and their team, not the enemy', () => {
  const seen = new Set<number>();
  const got = lolMoments(
    game(
      [
        { EventID: 0, EventName: 'GameStart', EventTime: 0 },
        { EventID: 1, EventName: 'ChampionKill', EventTime: 600, KillerName: 'Streamer' },
        { EventID: 2, EventName: 'Multikill', EventTime: 601, KillerName: 'Streamer', KillStreak: 5 },
        { EventID: 3, EventName: 'ChampionKill', EventTime: 602, KillerName: 'Enemy' },
        { EventID: 4, EventName: 'BaronKill', EventTime: 605, KillerName: 'Mate', Stolen: 'True' },
        { EventID: 5, EventName: 'DragonKill', EventTime: 606, KillerName: 'Enemy', Stolen: 'False' },
        { EventID: 6, EventName: 'Ace', EventTime: 607, AcingTeam: 'ORDER' },
        { EventID: 7, EventName: 'GameEnd', EventTime: 610, Result: 'Win' },
      ],
      610,
    ),
    seen,
  );
  assert.deepEqual(
    got.map((m) => m.code),
    ['kill', 'penta', 'baron_stolen', 'ace', 'victory'],
  );
  assert.equal(got[0]!.ageSec, 10);
});

test('each event once; a snapshot taken late skips old history', () => {
  const seen = new Set<number>();
  const data = game(
    [
      { EventID: 1, EventName: 'ChampionKill', EventTime: 100, KillerName: 'Streamer' }, // 900 s ago
      { EventID: 2, EventName: 'ChampionKill', EventTime: 990, KillerName: 'Streamer' },
    ],
    1000,
  );
  assert.deepEqual(lolMoments(data, seen).map((m) => m.code), ['kill']);
  assert.deepEqual(lolMoments(data, seen), []);
});

test('the result carries the player champion and KDA', () => {
  const data = game([{ EventID: 9, EventName: 'GameEnd', EventTime: 1500, Result: 'Lose' }], 1500);
  data.allPlayers![0] = { ...data.allPlayers![0]!, championName: 'Ahri', scores: { kills: 8, deaths: 2, assists: 10 } };
  assert.deepEqual(lolMoments(data, new Set()), [{ code: 'defeat', ageSec: 0, stats: { champion: 'Ahri', kills: 8, deaths: 2, assists: 10 } }]);
});

test('an escape: nearly dead, then alive and recovering; dying is not one', () => {
  const snap = (t: number, hp: number, dead = false): LolGameData => ({
    ...game([], t),
    activePlayer: { riotId: 'Streamer#EUW', championStats: { currentHealth: hp, maxHealth: 1000 } },
    allPlayers: [{ riotIdGameName: 'Streamer', team: 'ORDER', isDead: dead }],
  });
  const tr = new EscapeTracker();
  assert.equal(tr.step(snap(100, 900)), null);
  assert.equal(tr.step(snap(102, 100)), null); // 10 %: in trouble
  assert.equal(tr.step(snap(104, 120)), null); // still low
  assert.equal(tr.step(snap(110, 400)), 8); // out of it 8 s after dropping low
  assert.equal(tr.step(snap(120, 80)), null);
  assert.equal(tr.step(snap(122, 0, true)), null); // died: no escape
  assert.equal(tr.step(snap(140, 500)), null);
});

test("liveLine reads the player's KDA, CS, gold and level", () => {
  const data: LolGameData = {
    activePlayer: { riotIdGameName: 'Me', currentGold: 812.6, level: 11 },
    allPlayers: [
      { riotIdGameName: 'Other', championName: 'Lux', scores: { kills: 1, deaths: 1, assists: 1, creepScore: 10 } },
      { riotIdGameName: 'Me', championName: 'Ahri', scores: { kills: 7, deaths: 2, assists: 5, creepScore: 148 } },
    ],
    gameData: { gameTime: 754.4 },
  };
  assert.deepEqual(liveLine(data), { kills: 7, deaths: 2, assists: 5, cs: 148, gold: 813, level: 11, gameTime: 754 });
  assert.equal(liveLine({ allPlayers: [] }), undefined);
});
