import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasFor, centred, cleanName, defaultCollection, normalizeCollection, ownBrand, parseLocaleIni, rescaleCollection, sceneContains, uniqueName, type Collection } from './studio-scenes';

const names = { scene: 'Main', display: 'Display', game: 'Game', desktop: 'Desktop audio', mic: 'Mic' };

test('the starter collection survives a save/load round trip unchanged', () => {
  const c = defaultCollection(names);
  assert.deepEqual(normalizeCollection(JSON.parse(JSON.stringify(c)), c), c);
  assert.equal(c.scenes[0].items.find((i) => i.source === 'Trigglow Alerts')?.x, centred({ width: 700, height: 440 }).x);
});

test('junk, duplicates, dangling items and stored overlay URLs are dropped', () => {
  const fallback = defaultCollection(names);
  const raw = {
    version: 1,
    current: 'Nope',
    sources: [
      { name: 'Cam', type: 'dshow_input', settings: {}, volume: 99, muted: 'yes' },
      { name: 'Cam', type: 'dshow_input', settings: {} },
      { name: 'Bad type', type: 'Rm -rf', settings: {} },
      { name: 'Trigglow Alerts', type: 'browser_source', settings: { url: 'https://evil.example', width: 800, height: 400 }, trigglow: 'alerts' },
      { name: 'Fake overlay', type: 'image_source', settings: {}, trigglow: 'alerts' },
      { name: 'Mic', type: 'wasapi_input_capture', settings: {}, channel: 3 },
      { name: 'Mic 2', type: 'wasapi_input_capture', settings: {}, channel: 3 },
    ],
    scenes: [
      { name: 'S', items: [{ source: 'Cam', x: 5 }, { source: 'Ghost' }, { source: 'Mic' }, { source: 'Trigglow Alerts', x: 0, y: 0, scaleX: 1, scaleY: 1 }] },
      { name: 'S', items: [] },
      { name: 'Cam', items: [] },
    ],
  };
  const c = normalizeCollection(raw, fallback);
  assert.deepEqual(c.sources.map((s) => s.name), ['Cam', 'Trigglow Alerts', 'Mic']);
  assert.equal(c.sources[0].volume, 20);
  assert.equal(c.sources[0].muted, false);
  assert.equal(c.sources[1].settings.url, undefined);
  assert.deepEqual(c.scenes.map((s) => s.name), ['S']);
  assert.deepEqual(c.scenes[0].items.map((i) => i.source), ['Cam', 'Trigglow Alerts']);
  assert.deepEqual({ x: c.scenes[0].items[1].x, y: c.scenes[0].items[1].y }, centred({ width: 800, height: 400 }));
  assert.equal(c.current, 'S');
});

test('nothing usable falls back to the starter collection', () => {
  const fallback: Collection = defaultCollection(names);
  assert.equal(normalizeCollection(null, fallback), fallback);
  assert.equal(normalizeCollection({ version: 2, sources: [], scenes: [] }, fallback), fallback);
  assert.equal(normalizeCollection({ version: 1, sources: [], scenes: [] }, fallback), fallback);
});

test('names are trimmed and made unique', () => {
  assert.equal(cleanName('  Hi\u0007 '), 'Hi');
  assert.equal(cleanName('   '), null);
  assert.equal(uniqueName('Scene', ['Scene', 'Scene 2']), 'Scene 3');
  assert.equal(uniqueName('New', []), 'New');
});

test('filters keep known types with unique names, nothing else', () => {
  const fallback = defaultCollection(names);
  const c = normalizeCollection(
    {
      version: 1,
      current: 'S',
      sources: [{ name: 'Mic', type: 'wasapi_input_capture', settings: {}, filters: [
        { type: 'noise_suppress_filter_v2', name: 'NS', settings: { method: 'rnnoise' } },
        { type: 'noise_suppress_filter_v2', name: 'NS' },
        { type: 'vst_filter', name: 'VST' },
        { type: 'gain_filter', name: 'Gain', enabled: false, settings: [] },
      ] }],
      scenes: [{ name: 'S', items: [] }],
    },
    fallback,
  );
  assert.deepEqual(c.sources[0].filters, [
    { type: 'noise_suppress_filter_v2', name: 'NS', enabled: true, settings: { method: 'rnnoise' } },
    { type: 'gain_filter', name: 'Gain', enabled: false, settings: {} },
  ]);
});

test('nested scenes are kept, loops are cut; ids, crop, rotation, flip and audio settings survive', () => {
  const c = normalizeCollection(
    {
      version: 1,
      current: 'A',
      sources: [{ id: 'src-0123456789ab', name: 'Cam', type: 'dshow_input', settings: {}, syncMs: 99999, monitoring: 2, mono: true }],
      scenes: [
        { id: 'bad', name: 'A', items: [{ source: 'B' }, { source: 'Cam', scaleX: -1, rotation: 90, crop: { left: 10, top: -4 }, locked: true }] },
        { name: 'B', items: [{ source: 'A' }, { source: 'B' }] },
      ],
    },
    defaultCollection(names),
  );
  assert.equal(c.sources[0].id, 'src-0123456789ab');
  assert.deepEqual([c.sources[0].syncMs, c.sources[0].monitoring, c.sources[0].mono], [20000, 2, true]);
  assert.match(c.scenes[0].id, /^scn-[0-9a-f]{12}$/);
  assert.deepEqual(c.scenes[0].items.map((i) => i.source), ['B', 'Cam']);
  assert.deepEqual(c.scenes[1].items, []); // B showing A (which shows B) or itself would loop
  const cam = c.scenes[0].items[1];
  assert.deepEqual([cam.scaleX, cam.rotation, cam.crop, cam.locked], [-1, 90, { left: 10, top: 0, right: 0, bottom: 0 }, true]);
  assert.ok(sceneContains(c.scenes, 'A', 'B'));
  assert.ok(!sceneContains(c.scenes, 'B', 'A'));
});

test('libobs locale files are read as key → text', () => {
  const m = parseLocaleIni(['ColorFilter="Corrección de color"', '# comment', 'Gain="Ganancia"', 'Bad line'].join('\r\n'));
  assert.equal(m.get('ColorFilter'), 'Corrección de color');
  assert.equal(m.get('Gain'), 'Ganancia');
  assert.equal(m.size, 2);
});

test("libobs texts never name OBS or Streamlabs", () => {
  assert.equal(ownBrand('Controlar audio vía Streamlabs Desktop'), 'Controlar audio vía Trigglow Studio');
  assert.equal(ownBrand('Control audio via OBS'), 'Control audio via Trigglow Studio');
  assert.equal(ownBrand('Use Input (OBS) Sample Rate'), 'Use Input (Trigglow Studio) Sample Rate');
  assert.equal(ownBrand('Network Audio/Video in OBS-Studio'), 'Network Audio/Video in Trigglow Studio');
  assert.equal(ownBrand('Corrección de color'), 'Corrección de color');
});

test('the canvas follows the screen: the tallest standard 16:9 it can show, never below 1080p', () => {
  assert.deepEqual(canvasFor(1440), { width: 2560, height: 1440 });
  assert.deepEqual(canvasFor(1600), { width: 2560, height: 1440 });
  assert.deepEqual(canvasFor(2160), { width: 3840, height: 2160 });
  assert.deepEqual(canvasFor(900), { width: 1920, height: 1080 });
});

test('a 1080p collection opened on 1440p keeps its layout, alerts centred', () => {
  const c = defaultCollection(names); // 1080p
  const r = rescaleCollection(c, { width: 2560, height: 1440 });
  assert.deepEqual(r.canvas, { width: 2560, height: 1440 });
  const items = r.scenes[0].items;
  assert.deepEqual(items[0].bounds, { width: 2560, height: 1440, type: 2 }); // the display capture still fills it
  const alerts = items.find((i) => i.source === 'Trigglow Alerts')!;
  // centred to the pixel: rounding may leave half a pixel
  assert.ok(Math.abs(alerts.x + (700 * alerts.scaleX) / 2 - 1280) < 1);
  assert.ok(Math.abs(alerts.y + (440 * alerts.scaleY) / 2 - 720) < 1);
  assert.equal(rescaleCollection(r, r.canvas), r);
});

test('old files without a canvas are read as 1080p; a starter collection on 1440p is drawn for it', () => {
  const old = JSON.parse(JSON.stringify(defaultCollection(names)));
  delete old.canvas;
  assert.deepEqual(normalizeCollection(old, defaultCollection(names)).canvas, { width: 1920, height: 1080 });
  const big = defaultCollection(names, { width: 2560, height: 1440 });
  const a = big.scenes[0].items.find((i) => i.source === 'Trigglow Alerts')!;
  const s = big.sources.find((x) => x.name === 'Trigglow Alerts')!;
  assert.ok(Math.abs(a.x + (s.settings.width as number) / 2 - 1280) < 1);
  assert.ok(Math.abs(a.y + (s.settings.height as number) / 2 - 720) < 1);
});
