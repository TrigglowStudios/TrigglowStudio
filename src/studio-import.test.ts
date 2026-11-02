import test from 'node:test';
import assert from 'node:assert/strict';
import { importObsCollection, importSlobsCollection, obsService, parseIni, profileSettings, obsBrowserDocks, relocateFiles, trigglowOverlayOf } from './studio-import';
import { defaultCollection, normalizeCollection } from './studio-scenes';

const ctx = {
  inputTypes: new Set(['game_capture', 'monitor_capture', 'window_capture', 'browser_source', 'image_source', 'ffmpeg_source', 'text_gdiplus_v3', 'color_source_v3', 'wasapi_input_capture', 'wasapi_output_capture', 'dshow_input', 'slideshow']),
  fileExists: (p: string) => p === 'C:/pics/logo.png',
  fallbackCanvas: { width: 1920, height: 1080 },
};
const names = { scene: 'Main', display: 'Display', game: 'Game', desktop: 'Desktop audio', mic: 'Mic' };

/** Shaped like OBS 31's `basic/scenes/<name>.json` (fields trimmed to what matters). */
const OBS = {
  name: 'Stream',
  resolution: { x: 2560, y: 1440 },
  current_scene: 'Juego',
  current_transition: 'Barrido',
  transition_duration: 500,
  transitions: [{ name: 'Barrido', id: 'swipe_transition', settings: {} }],
  scene_order: [{ name: 'Juego' }, { name: 'Pausa' }],
  DesktopAudioDevice1: { name: 'Audio del escritorio', id: 'wasapi_output_capture', settings: { device_id: 'default' }, volume: 0.5, muted: false, sync: 0, flags: 0 },
  AuxAudioDevice1: { name: 'Mic/Aux', id: 'wasapi_input_capture', settings: { device_id: 'default' }, volume: 1, muted: true, sync: 150_000_000, flags: 2, monitoring_type: 1, hotkeys: { 'libobs.push-to-talk': [{ key: 'OBS_KEY_MOUSE4' }], 'libobs.mute': [] }, filters: [{ id: 'noise_suppress_filter', versioned_id: 'noise_suppress_filter_v2', name: 'Ruido', enabled: true, settings: {} }, { id: 'vst_filter', name: 'VST', settings: {} }] },
  hotkeys: { 'OBSBasic.StartStreaming': [{ key: 'OBS_KEY_F1' }], 'OBSBasic.StopStreaming': [] },
  groups: [
    {
      name: 'Cámara',
      id: 'group',
      settings: {
        items: [
          { name: 'Webcam', pos: { x: 10, y: 10 }, scale: { x: 1, y: 1 }, visible: true, align: 5 },
          { name: 'Marco', pos: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, visible: true, align: 5 },
        ],
      },
    },
  ],
  sources: [
    { name: 'Captura de juego', id: 'game_capture', settings: { capture_mode: 'any_fullscreen' }, volume: 1, flags: 0, sync: 0 },
    { name: 'Trigglow Alerts', id: 'browser_source', settings: { url: 'https://www.trigglow.com/overlay/abc123', width: 700, height: 440 } },
    { name: 'Trigglow Chat', id: 'browser_source', settings: { url: 'https://www.trigglow.com/overlay/abc123/chat', width: 400, height: 600 }, filters: [{ id: 'color_filter', name: 'Color', settings: { opacity: 0.8 } }] },
    { name: 'Otra web', id: 'browser_source', settings: { url: 'https://example.com/widget', width: 300, height: 100 } },
    { name: 'Logo', id: 'image_source', settings: { file: 'C:/pics/logo.png' } },
    { name: 'Fondo', id: 'image_source', settings: { file: 'C:/pics/missing.png' } },
    { name: 'Shader', id: 'shader_filter_source', settings: { width: 500, height: 200 } },
    { name: 'Webcam', id: 'dshow_input', settings: {} },
    { name: 'Marco', id: 'color_source', versioned_id: 'color_source_v3', settings: { color: 4278190335 } },
    {
      name: 'Juego',
      id: 'scene',
      hotkeys: { 'OBSBasic.SelectScene': [{ key: 'OBS_KEY_1', control: true, alt: true }], 'libobs.hide_scene_item.7': [{ key: 'OBS_KEY_H', control: true }], 'libobs.show_scene_item.7': [{ key: 'OBS_KEY_NUMASTERISK' }] },
      settings: {
        items: [
          { name: 'Captura de juego', pos: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, bounds_type: 2, bounds: { x: 2560, y: 1440 }, visible: true, locked: true, align: 5 },
          { name: 'Shader', pos: { x: 100, y: 100 }, scale: { x: 1, y: 1 }, visible: true, align: 5 },
          { name: 'Cámara', pos: { x: 2000, y: 1000 }, scale: { x: 2, y: 2 }, visible: true, align: 5 },
          { name: 'Trigglow Chat', pos: { x: 50, y: 600 }, scale: { x: 1, y: 1 }, visible: true, align: 5, crop_left: 10 },
          { name: 'Trigglow Alerts', pos: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, visible: true, align: 5 },
          { name: 'Logo', id: 7, pos: { x: 10, y: 10 }, scale: { x: -1, y: 1 }, rot: 90, visible: false, align: 5 },
          { name: 'Pausa', pos: { x: 0, y: 0 }, scale: { x: 0.25, y: 0.25 }, visible: true, align: 5 },
        ],
      },
    },
    {
      name: 'Pausa',
      id: 'scene',
      settings: { items: [{ name: 'Fondo', pos: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, visible: true, align: 5 }, { name: 'Otra web', pos: { x: 5, y: 5 }, scale: { x: 1, y: 1 }, visible: true, align: 4 }, { name: 'Trigglow Alerts', pos: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, visible: true, align: 5 }] },
    },
  ],
};

test('an OBS collection: scenes, shared sources, nested scene, global audio, Trigglow overlays, groups', () => {
  const r = importObsCollection(OBS, ctx);
  const c = normalizeCollection(JSON.parse(JSON.stringify(r.collection)), defaultCollection(names));
  assert.deepEqual(c.scenes.map((s) => s.name), ['Juego', 'Pausa']);
  assert.equal(c.current, 'Juego');
  assert.deepEqual(c.canvas, { width: 2560, height: 1440 });
  const src = (n: string) => c.sources.find((s) => s.name === n)!;
  // global audio on OBS's channels, with its settings
  assert.equal(src('Audio del escritorio').channel, 1);
  const mic = src('Mic/Aux');
  assert.deepEqual([mic.channel, mic.muted, mic.syncMs, mic.mono, mic.monitoring], [3, true, 150, true, 1]);
  assert.deepEqual(mic.filters?.map((f) => f.type), ['noise_suppress_filter_v2']); // the VST one can't come
  // our overlays become native Trigglow sources, one each, with no stored URL
  assert.equal(src('Trigglow Alerts').trigglow, 'alerts');
  assert.equal(src('Trigglow Alerts').settings.url, undefined);
  assert.equal(src('Trigglow Chat').trigglow, 'chat');
  assert.equal(src('Trigglow Chat').filters?.[0].type, 'color_filter_v2');
  assert.equal(src('Otra web').trigglow, undefined);
  // a plugin source keeps its name and place as a transparent block
  assert.deepEqual([src('Shader').type, src('Shader').settings.color], ['color_source_v3', 0]);
  const juego = c.scenes[0].items;
  // the group's items, carried by the group (pos 2000,1000, scale 2)
  const webcam = juego.find((i) => i.source === 'Webcam')!;
  assert.deepEqual([webcam.x, webcam.y, webcam.scaleX], [2020, 1020, 2]);
  assert.ok(juego.some((i) => i.source === 'Marco'));
  // …listed in a folder with the group's name
  const folder = c.scenes[0].folders?.[0];
  assert.equal(folder?.name, 'Cámara');
  assert.deepEqual(juego.filter((i) => i.folder === folder?.id).map((i) => i.source).sort(), ['Marco', 'Webcam']);
  // shortcuts: switch to Juego, hide the logo, push to talk on the mic; the keypad one and OBS's own Start can't come
  const hk = c.hotkeys ?? {};
  const id = (n: string) => c.sources.find((x) => x.name === n)?.id ?? c.scenes.find((x) => x.name === n)?.id;
  assert.equal(hk[`scene:${id('Juego')}`], 'CommandOrControl+Alt+1');
  assert.equal(hk[`hide:${id('Juego')}:${id('Logo')}`], 'CommandOrControl+H');
  assert.equal(hk[`ptt:${id('Mic/Aux')}`], 'Mouse4');
  assert.equal(Object.keys(hk).length, 3);
  assert.equal(r.notes.find((n) => n.code === 'hotkeys')?.detail, '2');
  assert.equal(juego.find((i) => i.source === 'Captura de juego')!.locked, true);
  assert.deepEqual(juego.find((i) => i.source === 'Captura de juego')!.bounds, { width: 2560, height: 1440, type: 2 });
  const logo = juego.find((i) => i.source === 'Logo')!;
  assert.deepEqual([logo.scaleX, logo.rotation, logo.visible], [-1, 90, false]);
  assert.equal(juego.find((i) => i.source === 'Trigglow Chat')!.crop?.left, 10);
  assert.ok(juego.some((i) => i.source === 'Pausa')); // nested scene
  // the alerts are centred on the imported canvas, whatever OBS had
  const alerts = juego.find((i) => i.source === 'Trigglow Alerts')!;
  assert.ok(Math.abs(alerts.x + 350 - 1280) < 1 && Math.abs(alerts.y + 220 - 720) < 1);
  assert.deepEqual(r.transition, { kind: 'swipe', ms: 500 });
  const codes = r.notes.map((n) => `${n.level}:${n.code}:${n.name ?? ''}`);
  for (const want of [
    'converted:trigglow_overlay:Trigglow Alerts',
    'converted:trigglow_overlay:Trigglow Chat',
    'lost:plugin_source:Shader',
    'lost:plugin_filter:Mic/Aux',
    'converted:group_folder:Cámara',
    'converted:hotkeys_imported:',
    'lost:file_missing:Fondo',
    'converted:alignment:Otra web',
    'lost:hotkeys:',
    'converted:alerts_centred:Trigglow Alerts',
  ]) {
    assert.ok(codes.includes(want), `missing ${want} in ${codes.join(', ')}`);
  }
  assert.ok(!codes.some((x) => x.includes('file_missing:Logo')));
  assert.deepEqual(r.stats, { scenes: 2, sources: 9 });
});

/** Shaped like a Streamlabs Desktop `SceneCollections/<id>.json`. */
const SLOBS = {
  sources: {
    items: [
      { id: 'desk', name: 'Desktop Audio', type: 'wasapi_output_capture', settings: {}, volume: 0.8, channel: 1 },
      { id: 'mic', name: 'Mic', type: 'wasapi_input_capture', settings: {}, forceMono: true, syncOffset: { sec: 0, nsec: 200_000_000 }, channel: 3, filters: { items: [{ name: 'Gate', type: 'noise_gate_filter', settings: {}, visible: false }] } },
      { id: 'ab', name: 'Alert Box', type: 'browser_source', settings: { url: 'https://streamlabs.com/alert-box/v3/TOKEN', width: 800, height: 600 }, propertiesManager: 'widget', propertiesManagerSettings: { widgetType: 0 } },
      { id: 'cb', name: 'Chat Box', type: 'browser_source', settings: { url: 'https://streamlabs.com/widgets/chat-box/v1/TOKEN' } },
      { id: 'sw', name: 'Spin Wheel', type: 'browser_source', settings: { url: 'https://streamlabs.com/widgets/wheel/TOKEN', width: 600, height: 600 }, propertiesManager: 'widget', propertiesManagerSettings: { widgetType: 12 } },
      { id: 'cam', name: 'Webcam', type: 'dshow_input', settings: {} },
      { id: 'game', name: 'Game', type: 'game_capture', settings: {} },
    ],
  },
  scenes: {
    activeId: 's1',
    items: [
      {
        id: 's1',
        name: 'Live',
        sceneItems: {
          items: [
            { id: 'i1', sourceId: 'ab', x: 0, y: 0, scaleX: 1, scaleY: 1, visible: true, sceneNodeType: 'item' },
            { id: 'i2', sourceId: 'cb', x: 1500, y: 300, scaleX: 1, scaleY: 1, visible: true, sceneNodeType: 'item' },
            { id: 'f1', name: 'Cam stuff', sceneNodeType: 'folder', childrenIds: ['i3'] },
            { id: 'i3', sourceId: 'cam', x: 1400, y: 700, scaleX: 0.5, scaleY: 0.5, visible: true, sceneNodeType: 'item', parentId: 'f1', crop: { left: 5, right: 0, top: 0, bottom: 0 } },
            { id: 'i4', sourceId: 'sw', x: 10, y: 10, scaleX: 1, scaleY: 1, visible: true, sceneNodeType: 'item' },
            { id: 'i5', sourceId: 'game', x: 0, y: 0, scaleX: 1, scaleY: 1, visible: true, sceneNodeType: 'item', locked: true },
          ],
        },
      },
      { id: 's2', name: 'BRB', sceneItems: { items: [{ id: 'j1', sourceId: 's1', x: 0, y: 0, scaleX: 0.5, scaleY: 0.5, visible: true, sceneNodeType: 'item' }] } },
    ],
  },
  transitions: { defaultTransitionId: 't1', transitions: [{ id: 't1', name: 'Global Transition', type: 'cut_transition', duration: 0 }] },
};

test('a Streamlabs Desktop collection: widgets become Trigglow overlays, folders flatten, order bottom first', () => {
  const r = importSlobsCollection(SLOBS, ctx);
  const c = normalizeCollection(JSON.parse(JSON.stringify(r.collection)), defaultCollection(names));
  assert.deepEqual(c.scenes.map((s) => s.name), ['Live', 'BRB']);
  assert.equal(c.current, 'Live');
  const src = (n: string) => c.sources.find((s) => s.name === n)!;
  assert.equal(src('Alert Box').trigglow, 'alerts');
  assert.equal(src('Chat Box').trigglow, 'chat');
  assert.equal(src('Chat Box').settings.url, undefined); // never the Streamlabs token
  assert.equal(src('Spin Wheel').type, 'color_source_v3');
  const mic = src('Mic');
  assert.deepEqual([mic.channel, mic.mono, mic.syncMs, mic.filters?.[0].enabled], [3, true, 200, false]);
  // Streamlabs lists top first; Studio keeps bottom first: the game capture (last in Streamlabs) is at the bottom
  assert.deepEqual(c.scenes[0].items.map((i) => i.source), ['Game', 'Spin Wheel', 'Webcam', 'Chat Box', 'Alert Box']);
  assert.equal(c.scenes[0].items.find((i) => i.source === 'Webcam')!.crop?.left, 5);
  assert.deepEqual(c.scenes[1].items.map((i) => i.source), ['Live']);
  assert.deepEqual(r.transition, { kind: 'cut', ms: 50 });
  const codes = r.notes.map((n) => `${n.level}:${n.code}:${n.name ?? ''}`);
  for (const want of ['converted:streamlabs_widget:Alert Box', 'converted:streamlabs_widget:Chat Box', 'lost:streamlabs_widget_unsupported:Spin Wheel', 'converted:group_folder:Cam stuff']) {
    assert.ok(codes.includes(want), `missing ${want} in ${codes.join(', ')}`);
  }
});

test('transitions: libobs ones come across, a stinger brings its file, a plugin one falls back to fade', () => {
  const t = (transitions: unknown[], current: string) => importObsCollection({ ...OBS, transitions, current_transition: current }, ctx);
  assert.deepEqual(t([{ name: 'S', id: 'obs_stinger_transition', settings: { path: 'C:/pics/logo.png', transition_point: 800 } }], 'S').transition, { kind: 'stinger', ms: 500, stingerFile: 'C:/pics/logo.png', stingerPointMs: 800 });
  const missing = t([{ name: 'S', id: 'obs_stinger_transition', settings: { path: 'C:/nope.webm' } }], 'S');
  assert.equal(missing.transition?.kind, 'fade');
  assert.ok(missing.notes.some((n) => n.code === 'file_missing' && n.detail === 'C:/nope.webm'));
  const move = t([{ name: 'Move', id: 'move_transition', settings: {} }], 'Move');
  assert.equal(move.transition?.kind, 'fade');
  assert.ok(move.notes.some((n) => n.code === 'transition' && n.name === 'Move'));
  assert.equal(t([], 'Corte').transition?.kind, 'cut');
});

test('names that collide are made unique; junk input still gives a usable collection', () => {
  const r = importObsCollection({ sources: [{ name: 'X', id: 'scene', settings: { items: [{ name: 'X2' }] } }, { name: 'X2', id: 'color_source_v3', settings: {} }] }, ctx);
  assert.equal(r.collection.scenes.length, 1);
  assert.equal(importObsCollection(null, ctx).collection.scenes.length, 1);
  assert.equal(importSlobsCollection('nope', ctx).collection.scenes.length, 1);
});

test('our overlay URLs are recognised by their path', () => {
  assert.equal(trigglowOverlayOf('https://trigglow.com/overlay/x'), 'alerts');
  assert.equal(trigglowOverlayOf('https://www.trigglow.com/overlay/x/music-requests'), 'music');
  assert.equal(trigglowOverlayOf('https://evil.com/overlay/x/chat'), null);
  assert.equal(trigglowOverlayOf('https://trigglow.com/overlay/x/unknown'), null);
});

test('an OBS profile: canvas, output, fps and recording; service.json: platform and key', () => {
  const ini = parseIni('\uFEFF[Video]\r\nBaseCX=2560\r\nBaseCY=1440\r\nOutputCX=1920\r\nOutputCY=1080\r\nFPSType=0\r\nFPSCommon=60\r\n[Output]\r\nMode=Simple\r\n[SimpleOutput]\r\nFilePath=C:\\\\Users\\\\me\\\\Videos\r\nRecFormat2=mp4\r\n');
  assert.deepEqual(profileSettings(ini), { canvas: { width: 2560, height: 1440 }, output: '1920x1080', fps: 60, recordFolder: 'C:\\Users\\me\\Videos', recordFormat: 'mp4' });
  assert.deepEqual(obsService({ settings: { service: 'Twitch', server: 'auto', key: ' live_123 ' } }), { platform: 'twitch', server: null, key: 'live_123' });
  assert.deepEqual(obsService({ type: 'rtmp_custom', settings: { server: 'rtmp://ingest.example/live', key: 'k' } }), { platform: 'custom', server: 'rtmp://ingest.example/live', key: 'k' });
  assert.equal(obsService({ settings: { server: 'rtmp://x', key: '' } }), null);
});

test('relocating files: images, media, slideshows and text-from-file move; URLs and other settings stay', () => {
  const c = {
    version: 1 as const,
    canvas: { width: 1920, height: 1080 },
    current: 'S',
    sources: [
      { id: 'src-000000000001', name: 'Img', type: 'image_source', settings: { file: 'C:/a.png' }, volume: 1, muted: false },
      { id: 'src-000000000002', name: 'Vid', type: 'ffmpeg_source', settings: { local_file: 'C:/v.mp4', is_local_file: true }, volume: 1, muted: false },
      { id: 'src-000000000003', name: 'Web', type: 'ffmpeg_source', settings: { input: 'https://x', is_local_file: false, local_file: 'C:/keep.mp4' }, volume: 1, muted: false },
      { id: 'src-000000000004', name: 'Show', type: 'slideshow', settings: { files: [{ value: 'C:/1.png' }, { value: 'https://y/2.png' }] }, volume: 1, muted: false },
    ],
    scenes: [{ id: 'scn-000000000001', name: 'S', items: [] }],
  };
  const out = relocateFiles(c, (f) => `D:/studio/${f.slice(3)}`);
  const s = (n: string) => out.sources.find((x) => x.name === n)!.settings;
  assert.equal(s('Img').file, 'D:/studio/a.png');
  assert.equal(s('Vid').local_file, 'D:/studio/v.mp4');
  assert.equal(s('Web').local_file, 'C:/keep.mp4');
  assert.deepEqual(s('Show').files, [{ value: 'D:/studio/1.png' }, { value: 'https://y/2.png' }]);
  assert.equal(c.sources[0].settings.file, 'C:/a.png'); // the original is untouched
});

test("OBS's custom browser docks: https ones come, Trigglow's own docks and broken entries don't", () => {
  const raw = JSON.stringify([
    { title: 'Trigglow Chat', url: 'https://www.trigglow.com/dock/chat' },
    { title: 'Música', url: 'https://example.com/player?x=1' },
    { title: 'Local', url: 'http://localhost:3000' },
    { title: '', url: 'https://nameless.example' },
    { title: 'Bad', url: 'not a url' },
  ]);
  assert.deepEqual(obsBrowserDocks(raw), [{ name: 'Música', url: 'https://example.com/player?x=1' }]);
  assert.deepEqual(obsBrowserDocks('{oops'), []);
  assert.deepEqual(obsBrowserDocks(undefined), []);
});
