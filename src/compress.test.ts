import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSkipEncode, parseProbe } from './compress';

const banner = (video: string, audio = '  Stream #0:1: Audio: aac (LC), 48000 Hz, stereo, fltp (default)') =>
  `Input #0, matroska,webm, from 'replay.mkv':\n  Duration: 00:01:02.50, start: 0.000000, bitrate: 40000 kb/s\n  Stream #0:0: Video: ${video}\n${audio}\n`;

test('reads length, codecs and the short side', () => {
  const i = parseProbe(banner('h264 (High), yuv420p(tv, bt709, progressive), 2560x1440 [SAR 1:1 DAR 16:9], 60 fps'));
  assert.deepEqual(i, { seconds: 62.5, videoCodec: 'h264', audioCodec: 'aac', height: 1440 });
  assert.equal(parseProbe(banner('hevc (Main), yuv420p, 1080x1920, 60 fps', '')).height, 1080);
  assert.throws(() => parseProbe('garbage'));
});

test('OBS file goes up untouched only when web-ready, small enough and not downscaled', () => {
  const h264 = { seconds: 60, videoCodec: 'h264', audioCodec: 'aac', height: 1440 };
  assert.equal(canSkipEncode(h264, 100, 200, null), true);
  assert.equal(canSkipEncode({ ...h264, audioCodec: null }, 100, 200, null), true);
  assert.equal(canSkipEncode(h264, 300, 200, null), false); // over the plan's cap
  assert.equal(canSkipEncode(h264, 100, 200, 1080), false); // smaller size asked for
  assert.equal(canSkipEncode({ ...h264, videoCodec: 'hevc' }, 100, 200, null), false); // not every browser plays it
  assert.equal(canSkipEncode({ ...h264, audioCodec: 'opus' }, 100, 200, null), false);
});
