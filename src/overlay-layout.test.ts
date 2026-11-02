import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLegacySource, overlayPlacement, scalePlacement } from './overlay-layout';

test('every known overlay has a placement and none but the emote rain is full screen', () => {
  for (const p of ['/overlay/abc', '/overlay/abc/chat', '/overlay/abc/quests', '/overlay/abc/giveaway', '/overlay/abc/loyalty',
    '/overlay/abc/music-requests', '/overlay/abc/activity', '/overlay/abc/goals', '/overlay/abc/credits']) {
    const l = overlayPlacement(p);
    assert.ok(l, p);
    assert.ok(l.width < 1920 && l.height < 1080, p);
    assert.ok(l.x >= 0 && l.y >= 0 && l.x + l.width <= 1920 && l.y + l.height <= 1080, p);
  }
  assert.deepEqual(overlayPlacement('/overlay/abc/emotes'), { width: 1920, height: 1080, x: 0, y: 0 });
});

test('unknown paths have no placement', () => {
  assert.equal(overlayPlacement('/overlay/abc/nope'), null);
  assert.equal(overlayPlacement('/app/chat'), null);
});

test('scales to another canvas', () => {
  assert.deepEqual(scalePlacement({ width: 480, height: 300, x: 24, y: 24 }, { width: 3840, height: 2160 }), { width: 960, height: 600, x: 48, y: 48 });
});

test('only an old default size counts as legacy', () => {
  const hd = { width: 1920, height: 1080 };
  assert.equal(isLegacySource({ width: 1920, height: 1080 }, '/overlay/abc/giveaway', hd), true);
  assert.equal(isLegacySource({ width: 520, height: 460 }, '/overlay/abc/giveaway', hd), false);
  assert.equal(isLegacySource({ width: 600, height: 300 }, '/overlay/abc/giveaway', hd), false);
  assert.equal(isLegacySource({}, '/overlay/abc/giveaway', hd), false);
  assert.equal(isLegacySource({ width: 1920, height: 1080 }, '/overlay/abc/nope', hd), false);
  // The emote rain is full canvas now: its old 480×960 strip is upgraded, a full-canvas source is already right.
  assert.equal(isLegacySource({ width: 480, height: 960 }, '/overlay/abc/emotes', hd), true);
  assert.equal(isLegacySource({ width: 640, height: 1280 }, '/overlay/abc/emotes', { width: 2560, height: 1440 }), true);
  assert.equal(isLegacySource({ width: 1920, height: 1080 }, '/overlay/abc/emotes', hd), false);
  assert.equal(isLegacySource({ width: 480, height: 960 }, '/overlay/abc/chat', hd), false);
  // The activity overlay grew to 500 px: its old 420×320 default is upgraded, the new size is left alone.
  assert.equal(isLegacySource({ width: 420, height: 320 }, '/overlay/abc/activity', hd), true);
  assert.equal(isLegacySource({ width: 500, height: 320 }, '/overlay/abc/activity', hd), false);
});
