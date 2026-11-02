import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameHighlightWatcher } from './game-highlights';

test('one clip per new highlight video, with a cooldown for bursts', () => {
  let fired = 0;
  const w = new GameHighlightWatcher(() => null, () => fired++);
  assert.equal(w.onFile('Fortnite/kill_1.mp4', 0), true);
  assert.equal(w.onFile('Fortnite/kill_1.mp4', 30_000), false); // same file reported again (rename + change)
  assert.equal(w.onFile('Fortnite/kill_2.mp4', 5_000), false); // same moment
  assert.equal(w.onFile('Fortnite/thumb.jpg', 40_000), false); // not a video
  assert.equal(w.onFile('Fortnite/win.mp4', 40_000), true);
  assert.equal(fired, 2);
});
