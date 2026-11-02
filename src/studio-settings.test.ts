import test from 'node:test';
import assert from 'node:assert/strict';
import { MULTISTREAM_TARGET, cleanEncoderSettings, fpsOf, defaultStudioSettings, newStudioKey, normalizeStudioKeys, normalizeStudioSettings, outputSize, validDockUrl, validServer } from './studio-settings';

const base = defaultStudioSettings('C:\\Videos');

test('junk settings fall back field by field', () => {
  const s = normalizeStudioSettings({ target: 'twitch; drop', output: '8000x8000', fps: 144, encoder: 'rm -rf', bitrate: 999_999, recordFolder: '  ', recordFormat: 'avi', transition: 'spin', transitionMs: -5 }, base);
  assert.deepEqual(s, { ...base, bitrate: 50_000, transitionMs: 50 });
  assert.deepEqual(normalizeStudioSettings(null, base), base);
});

test('valid settings are kept; the target is Multistream or a channel id', () => {
  const id = '3f2b8c1e-9d4a-4c7e-8b1f-0a2d3e4f5a6b';
  const s = normalizeStudioSettings({ target: id, output: '1280x720', fps: 30, encoder: 'obs_x264', bitrate: 4500, recordFormat: 'mp4', transition: 'cut', transitionMs: 800 }, base);
  assert.equal(s.target, id);
  assert.deepEqual(outputSize(s), { width: 1280, height: 720 });
  assert.equal(normalizeStudioSettings({ target: MULTISTREAM_TARGET }, s).target, MULTISTREAM_TARGET);
});

test('servers from the API are checked again', () => {
  assert.equal(validServer('rtmp://user:pass@host/app'), null);
  assert.equal(validServer('https://host/app'), null);
  assert.equal(validServer(' rtmps://live.example.com/app '), 'rtmps://live.example.com/app');
});

test('shortcuts: valid accelerators kept, empty clears, junk keeps the old one', () => {
  const withKeys = normalizeStudioSettings({ hotkeyStream: 'CommandOrControl+Alt+S', hotkeyRecord: 'F9' }, base);
  assert.equal(withKeys.hotkeyStream, 'CommandOrControl+Alt+S');
  assert.equal(withKeys.hotkeyRecord, '');
  assert.equal(normalizeStudioSettings({ hotkeyStream: '' }, withKeys).hotkeyStream, '');
  assert.equal(normalizeStudioSettings({ hotkeyStream: 'Banana+Q' }, withKeys).hotkeyStream, 'CommandOrControl+Alt+S');
});

test('targets: Multistream, a linked account, a Multistream channel or a pasted key', () => {
  for (const target of ['account:youtube', 'account:twitch', 'key:ab12cd34', '3f2b8c1e-9d4a-4c7e-8b1f-0a2d3e4f5a6b']) {
    assert.equal(normalizeStudioSettings({ target }, base).target, target);
  }
  for (const target of ['account:kick', 'key:../etc', 'key:ABCDEFGH', 'twitch']) assert.equal(normalizeStudioSettings({ target }, base).target, MULTISTREAM_TARGET);
});

test('pasted keys: platforms with a fixed server ignore the typed one; others need a valid server', () => {
  assert.deepEqual(newStudioKey({ platform: 'twitch', label: ' Main ', server: 'rtmp://evil.example/x', key: ' live_123 ' }, 'ab12cd34'), {
    id: 'ab12cd34', platform: 'twitch', label: 'Main', server: 'rtmp://live.twitch.tv/app', key: 'live_123',
  });
  assert.equal(newStudioKey({ platform: 'kick', server: '', key: 'sk_1' }, 'ab12cd34'), null);
  assert.equal(newStudioKey({ platform: 'kick', server: 'rtmps://fa723fc1b171.global-contribute.live-video.net:443/app', key: 'sk 1' }, 'ab12cd34'), null);
  assert.equal(newStudioKey({ platform: 'kick', server: 'rtmps://ingest.kick.example:443/app', key: 'sk_1' }, 'ab12cd34')?.server, 'rtmps://ingest.kick.example:443/app');
  assert.equal(newStudioKey({ platform: 'facebook', key: 'x' }, 'ab12cd34'), null);
});

test('saved keys: junk and duplicates are dropped', () => {
  const ok = { id: 'ab12cd34', platform: 'custom', label: 'x', server: 'srt://host:9000', key: 'k' };
  assert.deepEqual(normalizeStudioKeys([ok, ok, { ...ok, id: 'nope' }, null, { ...ok, id: 'zz99zz99', key: '' }]).map((k) => k.id), ['ab12cd34']);
  assert.deepEqual(normalizeStudioKeys('x'), []);
});

test('video, audio, recording and advanced settings: only known values, bounded', () => {
  const base = defaultStudioSettings('C:/v');
  const n = normalizeStudioSettings(
    { fps: 59.94, scaleFilter: 'lanczos', colorFormat: 'I444', colorSpace: 'sRGB', colorRange: 'full', sampleRate: 44100, channels: '5.1', audioBitrate: 320, recordQuality: 'lossless', recordFormat: 'mov', remux: false, splitMode: 'time', splitMinutes: 99999, reconnectDelay: 0, delay: true, delaySec: 5000, bindIP: '192.168.1.20', lowLatency: true },
    base,
  );
  assert.deepEqual(
    [n.fps, n.scaleFilter, n.colorFormat, n.colorSpace, n.colorRange, n.sampleRate, n.channels, n.audioBitrate, n.recordQuality, n.recordFormat, n.remux, n.splitMode, n.splitMinutes, n.reconnectDelay, n.delay, n.delaySec, n.bindIP, n.lowLatency],
    [59.94, 'lanczos', 'I444', 'sRGB', 'full', 44100, '5.1', 320, 'lossless', 'mov', false, 'time', 1440, 1, true, 1800, '192.168.1.20', true],
  );
  const junk = normalizeStudioSettings({ fps: 33, scaleFilter: 'x', sampleRate: 22050, bindIP: 'rm -rf /', remux: 'yes' }, n);
  assert.deepEqual([junk.fps, junk.scaleFilter, junk.sampleRate, junk.bindIP, junk.remux], [59.94, 'lanczos', 44100, '192.168.1.20', false]);
  assert.deepEqual(fpsOf(59.94), { num: 60000, den: 1001 });
  assert.deepEqual(fpsOf(29.97), { num: 30000, den: 1001 });
  assert.deepEqual(fpsOf(60), { num: 60, den: 1 });
});

test('encoder settings keep plain values for known-shaped ids only', () => {
  assert.deepEqual(cleanEncoderSettings({ jim_nvenc: { preset2: 'p7', bf: 2, lookahead: true, nested: { x: 1 }, 'bad key!': 1 }, 'Bad Id': { a: 1 }, obs_x264: 'nope' }), { jim_nvenc: { preset2: 'p7', bf: 2, lookahead: true } });
  assert.deepEqual(cleanEncoderSettings(null), {});
});

test('transitions, the stinger and the canvas: only known values', () => {
  const base = defaultStudioSettings('C:/v');
  const n = normalizeStudioSettings({ transition: 'stinger', stingerFile: ' C:/s.webm ', stingerPointMs: 99_999, canvas: '2560x1440' }, base);
  assert.deepEqual([n.transition, n.stingerFile, n.stingerPointMs, n.canvas], ['stinger', 'C:/s.webm', 30_000, '2560x1440']);
  const junk = normalizeStudioSettings({ transition: 'spin', canvas: '1000x1000', stingerFile: 5 }, n);
  assert.deepEqual([junk.transition, junk.canvas, junk.stingerFile], ['stinger', '2560x1440', 'C:/s.webm']);
  assert.equal(normalizeStudioSettings({ stingerFile: '' }, n).stingerFile, '');
});

test('Dynamic Delay: 1–60 s, a known quality, a scene id or none, a corner 0–3', () => {
  const ok = normalizeStudioSettings({ dynDelaySeconds: 30, dynDelayQuality: 1080, dynDelayLive: 'scn-ba9876543210', dynDelayLoading: 'scn-0123456789ab', dynDelayBadge: false, dynDelayCorner: 3 }, base);
  assert.deepEqual([ok.dynDelaySeconds, ok.dynDelayQuality, ok.dynDelayLive, ok.dynDelayLoading, ok.dynDelayBadge, ok.dynDelayCorner], [30, 1080, 'scn-ba9876543210', 'scn-0123456789ab', false, 3]);
  const junk = normalizeStudioSettings({ dynDelaySeconds: 600, dynDelayQuality: 4320, dynDelayLive: 'Gameplay', dynDelayLoading: 'Starting soon', dynDelayCorner: 9 }, ok);
  assert.deepEqual([junk.dynDelaySeconds, junk.dynDelayQuality, junk.dynDelayLive, junk.dynDelayLoading, junk.dynDelayCorner], [60, 1080, 'scn-ba9876543210', 'scn-0123456789ab', 3]);
  assert.equal(normalizeStudioSettings({ dynDelayLoading: '' }, ok).dynDelayLoading, '');
  assert.equal(normalizeStudioSettings({ dynDelayLive: '' }, ok).dynDelayLive, '');
  assert.equal(base.dynDelayLive, '');
});

test('custom docks: https only, a name, a dock id; at most 20', () => {
  const ok = { id: 'dock-0123abcd', name: 'Música', url: 'https://example.com/a' };
  const s = normalizeStudioSettings({ customDocks: [ok, { id: 'dock-0123abce', name: 'x', url: 'http://plain.example' }, { id: 'nope', name: 'y', url: 'https://e.com' }, { ...ok }] }, base);
  assert.deepEqual(s.customDocks, [ok]);
  assert.equal(validDockUrl('https://user:pw@e.com'), null);
  assert.equal(normalizeStudioSettings({ customDocks: Array.from({ length: 30 }, (_, i) => ({ ...ok, id: `dock-${String(i).padStart(8, '0')}` })) }, base).customDocks.length, 20);
});
