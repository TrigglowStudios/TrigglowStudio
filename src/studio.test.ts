import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ALERTS_SIZE, centred, pickEncoder, strayEnginePids, transitionOf } from './studio';

test('alerts sit dead centre on the canvas', () => {
  const p = centred(ALERTS_SIZE);
  assert.equal(p.x + ALERTS_SIZE.width / 2, 960);
  assert.equal(p.y + ALERTS_SIZE.height / 2, 540);
  assert.deepEqual(centred({ width: 600, height: 300 }, { width: 2560, height: 1440 }), { x: 980, y: 570 });
});

test('hardware encoders win over x264, NVENC texture path first', () => {
  assert.equal(pickEncoder(['obs_x264', 'jim_nvenc', 'obs_nvenc_h264_tex']), 'obs_nvenc_h264_tex');
  assert.equal(pickEncoder(['obs_x264', 'h264_texture_amf']), 'h264_texture_amf');
  assert.equal(pickEncoder(['obs_x264']), 'obs_x264');
  assert.equal(pickEncoder([]), 'obs_x264');
});

test("only our own engine copy counts as a leftover, never the streamer's OBS", () => {
  const dir = path.join('C:', 'app', 'vendor', 'obs-studio-node');
  const other = ['C:', 'Program Files', 'obs-studio', 'bin', '64bit', 'obs64.exe'].join(path.sep);
  const rows = [`12|${path.join(dir, 'obs64.exe')}`, `34|${other}`, '56|', 'junk', `78|${path.join(dir, 'OBS64.EXE')} `].join(String.fromCharCode(13, 10));
  assert.deepEqual(strayEnginePids(rows, dir), [12, 78]);
  // An engine whose app (parent) still runs belongs to another instance or a test: left alone.
  const withParents = [`12|${path.join(dir, 'obs64.exe')}|500`, `78|${path.join(dir, 'obs64.exe')}|600`].join(String.fromCharCode(10));
  assert.deepEqual(strayEnginePids(withParents, dir, (pid) => pid === 500), [78]);
  // The engine under its own name (Discord streamer mode off) counts too.
  assert.deepEqual(strayEnginePids(`90|${path.join(dir, 'trigglow-engine.exe')}`, dir), [90]);
});

test('transitions map to libobs; a stinger without a file is a fade', () => {
  assert.deepEqual(transitionOf({ transition: 'slide', stingerFile: '', stingerPointMs: 0 })[0], 'slide_transition');
  assert.deepEqual(transitionOf({ transition: 'stinger', stingerFile: 'C:/s.webm', stingerPointMs: 700 }), ['obs_stinger_transition', 'Trigglow transition', { path: 'C:/s.webm', transition_point_type: 0, transition_point: 700 }]);
  assert.equal(transitionOf({ transition: 'stinger', stingerFile: '', stingerPointMs: 700 })[0], 'fade_transition');
});
