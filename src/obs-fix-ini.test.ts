import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replaySecondsFromIni, withBrowserDock, withReplayBufferEnabled, withReplaySeconds } from './obs-fix';

test('creates the section for a profile that never had the replay buffer', () => {
  const out = withReplayBufferEnabled('[General]\nName=Untitled\n\n[Video]\nBaseCX=1920\n');
  assert.match(out, /\[SimpleOutput\]\nRecRB=true\nRecRBTime=30\n$/);
  assert.match(out, /\[Video\]\nBaseCX=1920\n/); // untouched
});

test('flips RecRB to true and keeps the length the user chose', () => {
  const out = withReplayBufferEnabled('[SimpleOutput]\nRecRB=false\nRecRBTime=12\nFilePath=C:\\Videos\n\n[Video]\nFPS=60\n');
  assert.match(out, /\[SimpleOutput\]\nRecRB=true\nRecRBTime=12\nFilePath=C:\\Videos\n\n\[Video\]/);
});

test('uses the Advanced section when OBS is in Advanced output mode', () => {
  const out = withReplayBufferEnabled('[Output]\nMode=Advanced\n\n[AdvOut]\nTrackIndex=1\n');
  assert.match(out, /\[AdvOut\]\nTrackIndex=1\nRecRB=true\nRecRBTime=30\n$/);
  assert.doesNotMatch(out, /SimpleOutput/);
});

test('preserves Windows line endings and handles a missing file', () => {
  const out = withReplayBufferEnabled('[Output]\r\nMode=Simple\r\n');
  assert.ok(out.includes('\r\n') && !/[^\r]\n/.test(out));
  assert.match(withReplayBufferEnabled(null), /^\[SimpleOutput\]\nRecRB=true\nRecRBTime=30\n$/);
});

test('setting the length overwrites it and keeps the rest', () => {
  const out = withReplaySeconds('[SimpleOutput]\nRecRB=true\nRecRBTime=20\nFilePath=C:\\V\n', 90);
  assert.match(out, /RecRBTime=90\n/);
  assert.match(out, /FilePath=C:\\V\n/);
  assert.equal(replaySecondsFromIni(out), 90);
});

test('raises the memory cap for long clips but never lowers it', () => {
  // 300 s needs ~900 MB at 3 MB/s; default cap is 512
  assert.match(withReplaySeconds('[SimpleOutput]\nRecRBTime=20\n', 300), /RecRBSize=900\n/);
  // already generous -> untouched
  assert.match(withReplaySeconds('[SimpleOutput]\nRecRBTime=20\nRecRBSize=4096\n', 300), /RecRBSize=4096\n/);
  // short clip under the default cap -> no size key added
  assert.doesNotMatch(withReplaySeconds('[SimpleOutput]\nRecRBTime=20\n', 60), /RecRBSize/);
});

test('reads the length from the active output mode', () => {
  assert.equal(replaySecondsFromIni('[Output]\nMode=Advanced\n[AdvOut]\nRecRBTime=45\n[SimpleOutput]\nRecRBTime=10\n'), 45);
  assert.equal(replaySecondsFromIni('[SimpleOutput]\nRecRBTime=10\n'), 10);
  assert.equal(replaySecondsFromIni('[General]\nName=x\n'), null);
  assert.equal(replaySecondsFromIni(null), null);
});

test('enabling with an explicit length forces it; without one keeps the user\'s own', () => {
  assert.match(withReplayBufferEnabled('[SimpleOutput]\nRecRBTime=15\n', 120, true), /RecRBTime=120\n/);
  assert.match(withReplayBufferEnabled('[SimpleOutput]\nRecRBTime=15\n', 30, false), /RecRBTime=15\n/);
});

test('adds a browser dock to user.ini ExtraBrowserDocks', () => {
  const initial = '[BasicWindow]\nExtraBrowserDocks=[]\n';
  const out = withBrowserDock(initial, 'Trigglow Chat', 'https://trigglow.com/app/chat?dock=1');
  assert.match(out, /ExtraBrowserDocks=\[{"title":"Trigglow Chat","url":"https:\/\/trigglow\.com\/app\/chat\?dock=1"}\]/);
});

test('updates an existing browser dock with new URL without duplicating', () => {
  const initial = '[BasicWindow]\nExtraBrowserDocks=[{"title":"Trigglow Chat","url":"https://old.url"}]\n';
  const out = withBrowserDock(initial, 'Trigglow Chat', 'https://new.url');
  assert.match(out, /ExtraBrowserDocks=\[{"title":"Trigglow Chat","url":"https:\/\/new\.url"}\]/);
  assert.equal(out.includes('old.url'), false);
});

