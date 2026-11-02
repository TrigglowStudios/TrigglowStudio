import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitVideo, validStreamSetup } from './obs-stream';

const KEY = `tgms_${'a'.repeat(32)}`;

test('only a Trigglow ingest key and an rtmp(s)/srt server can be written into OBS', () => {
  assert.deepEqual(validStreamSetup(' rtmp://ingest.trigglow.com:1935/live ', KEY), { server: 'rtmp://ingest.trigglow.com:1935/live', key: KEY });
  assert.equal(validStreamSetup('https://evil.example/live', KEY), null);
  assert.equal(validStreamSetup('rtmp://user:pass@host/live', KEY), null);
  assert.equal(validStreamSetup('rtmp://host/live', 'live_123'), null);
  assert.equal(validStreamSetup(undefined, KEY), null);
});

test('fitVideo lowers 4K60 to 1440p and 120 fps to 60, keeps what already fits', () => {
  assert.deepEqual(fitVideo({ outputWidth: 3840, outputHeight: 2160, fpsNumerator: 60, fpsDenominator: 1 }, 1440, 60), {
    outputWidth: 2560,
    outputHeight: 1440,
    fpsNumerator: 60,
    fpsDenominator: 1,
  });
  assert.deepEqual(fitVideo({ outputWidth: 1920, outputHeight: 1080, fpsNumerator: 120, fpsDenominator: 1 }, 1080, 60), {
    outputWidth: 1920,
    outputHeight: 1080,
    fpsNumerator: 60,
    fpsDenominator: 1,
  });
  // Vertical: the short side is the width.
  assert.deepEqual(fitVideo({ outputWidth: 1440, outputHeight: 2560, fpsNumerator: 60000, fpsDenominator: 1001 }, 1080, 60), {
    outputWidth: 1080,
    outputHeight: 1920,
    fpsNumerator: 60000,
    fpsDenominator: 1001,
  });
  assert.equal(fitVideo({ outputWidth: 1920, outputHeight: 1080, fpsNumerator: 60, fpsDenominator: 1 }, 1080, 60), null);
});
