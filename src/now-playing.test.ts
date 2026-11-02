import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageTypeFromBytes, isAllowedArtFile, isAllowedArtHost, NowPlayingWatcher, nowPlayingKey, parseNowPlayingLine, parsePlayerctlLine, type NowPlaying } from './now-playing';

test('parses a playing line and rejects empty / junk ones', () => {
  const np = parseNowPlayingLine('{"title":"Song","artist":"Band","durationMs":180000,"positionMs":5000,"isPlaying":true,"imageUrl":null}');
  assert.deepEqual(np, { title: 'Song', artist: 'Band', durationMs: 180000, positionMs: 5000, isPlaying: true, imageUrl: null });
  for (const l of ['null', '', '{', '{"artist":"x"}', '{"title":""}']) assert.equal(parseNowPlayingLine(l), null, l);
});

test('key ignores position but not play state', () => {
  const a = parseNowPlayingLine('{"title":"S","artist":"B","positionMs":1,"isPlaying":true}');
  const b = parseNowPlayingLine('{"title":"S","artist":"B","positionMs":9999,"isPlaying":true}');
  const c = parseNowPlayingLine('{"title":"S","artist":"B","positionMs":9999,"isPlaying":false}');
  assert.equal(nowPlayingKey(a), nowPlayingKey(b));
  assert.notEqual(nowPlayingKey(a), nowPlayingKey(c));
  assert.equal(nowPlayingKey(null), '');
});

test('the art goes out on a track change only; heartbeats say the server keeps it', () => {
  const sent: (NowPlaying | null)[] = [];
  const w = new NowPlayingWatcher((np) => sent.push(np));
  const line = (o: object) => (w as unknown as { onLine(l: string): void }).onLine(JSON.stringify({ title: 'S', artist: 'B', isPlaying: true, ...o }));
  line({ imageUrl: 'data:image/png;base64,AA==' });
  line({ imageUrl: null }); // same track, within the heartbeat window: quiet
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.imageUrl, 'data:image/png;base64,AA==');
  (w as unknown as { lastSentAt: number }).lastSentAt = 0; // heartbeat due
  line({ imageUrl: null });
  assert.deepEqual([sent[1]?.imageUrl, sent[1]?.imageKept], [null, true]);
  line({ title: 'Next', imageUrl: null }); // new track without art yet: no stale art
  assert.equal(sent[2]?.imageUrl, null);
  assert.equal(sent[2]?.imageKept, undefined);
});

test('playerctl lines: µs → ms, paused counts, stopped / empty do not', () => {
  assert.deepEqual(parsePlayerctlLine('Playing\t5000000\t180000000\thttps://i.scdn.co/x\tBand\tSong\twith tab'), {
    title: 'Song\twith tab', artist: 'Band', durationMs: 180000, positionMs: 5000, isPlaying: true, artUrl: 'https://i.scdn.co/x',
  });
  assert.equal(parsePlayerctlLine('Paused\t0\t\t\t\tS')?.isPlaying, false);
  for (const l of ['', 'Stopped\t0\t0\t\tB\tS', 'Playing\t0\t0\t\tB\t']) assert.equal(parsePlayerctlLine(l), null, l);
});

test('art: image type comes from the bytes, never the file name', () => {
  assert.equal(imageTypeFromBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'image/png');
  assert.equal(imageTypeFromBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(imageTypeFromBytes(Buffer.from('GIF89a....')), 'image/gif');
  assert.equal(imageTypeFromBytes(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(imageTypeFromBytes(Buffer.from('ssh-rsa AAAA...')), null);
  assert.equal(imageTypeFromBytes(Buffer.alloc(0)), null);
});

test('art: local files only from player caches / temp, never the rest of the disk', () => {
  const roots = ['/tmp', '/home/u/.cache'];
  assert.equal(isAllowedArtFile('/tmp/firefox-mpris/cover.png', roots), true);
  assert.equal(isAllowedArtFile('/home/u/.cache/vlc/art/x.jpg', roots), true);
  for (const f of ['/home/u/Pictures/me.png', '/home/u/.cache', '/tmp/../etc/x.png', '/tmpx/a.png']) {
    assert.equal(isAllowedArtFile(f, roots), false, f);
  }
});

test('art: https only from known art CDNs (no LAN hosts, no credentials)', () => {
  assert.equal(isAllowedArtHost('https://i.scdn.co/image/abc'), true);
  assert.equal(isAllowedArtHost('https://i.ytimg.com/vi/x/hq.jpg'), true);
  for (const u of ['http://i.scdn.co/a', 'https://192.168.1.1/a.png', 'https://evilscdn.co/a', 'https://u:p@i.scdn.co/a', 'https://router.local/a', 'not a url']) {
    assert.equal(isAllowedArtHost(u), false, u);
  }
});
