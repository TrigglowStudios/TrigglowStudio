import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HighlightDetector } from './highlight';

/** Feeds `seconds` of a steady stream (mic ~-30 dB with a little wobble, calm picture), 10 audio + 2 video samples a second. */
function run(d: HighlightDetector, from: number, seconds: number, audio = 0.03, motion = 0.05) {
  for (let s = 0; s < seconds; s++) {
    for (let i = 0; i < 10; i++) d.audio(audio * (1 + 0.15 * Math.sin(s + i)), from + s * 1000 + i * 100);
    for (let i = 0; i < 2; i++) d.video(motion, from + s * 1000 + i * 500);
  }
  return from + seconds * 1000;
}

test('stays quiet on a steady stream, even a loud one', () => {
  const fired: number[] = [];
  const d = new HighlightDetector('medium', (s) => fired.push(s));
  run(d, 1_000, 300, 0.5, 0.3);
  assert.equal(fired.length, 0);
});

test('fires on a shout, once, and not during warm-up', () => {
  const fired: number[] = [];
  const d = new HighlightDetector('medium', (s) => fired.push(s));
  let t = run(d, 1_000, 10);
  run(d, t, 1, 0.9, 0.05); // loud, but still warming up
  assert.equal(fired.length, 0);
  t = run(d, t + 1000, 120);
  t = run(d, t, 3, 0.9, 0.05); // +30 dB over normal
  assert.equal(fired.length, 1);
  run(d, t, 5, 0.9, 0.05); // still shouting: cooldown holds
  assert.equal(fired.length, 1);
});

test('video-only burst needs the audio to join in at low sensitivity', () => {
  const low: number[] = [];
  const high: number[] = [];
  const dl = new HighlightDetector('low', (s) => low.push(s));
  const dh = new HighlightDetector('high', (s) => high.push(s));
  for (const d of [dl, dh]) run(d, run(d, 1_000, 130), 3, 0.03, 0.6);
  assert.equal(low.length, 0);
  assert.equal(high.length, 1);
});

import { frameMotion } from './auto-highlights';
test('frameMotion counts changed pixels', () => {
  const a = Buffer.alloc(16, 10);
  const b = Buffer.from(a);
  b.fill(200, 0, 8); // 2 of 4 pixels changed a lot
  assert.equal(frameMotion(a, a), 0);
  assert.equal(frameMotion(a, b), 0.5);
});
