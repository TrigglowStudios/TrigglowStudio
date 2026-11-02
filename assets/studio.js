// Trigglow Studio page, framed by the dashboard's /app/studio: go live and record, the engine's live numbers, the
// scene editor (scenes, sources, mixer, source properties and filters) and where the preview goes. The dashboard tells
// us where this frame sits in the window; we add our #preview box to it and hand the result to the shell, which places
// the engine's native preview there. Output settings live in the app's Settings → Trigglow Studio; properties,
// filters, names and confirmations open as pop-up windows (studio-popup.html), like in OBS.
const shell = window.trigglowShell;
const $ = (id) => document.getElementById(id);

$('openSettings').innerHTML = svg('gear');
$('projectors').innerHTML = svg('monitor');
$('toggleDocks').innerHTML = svg('sidebar');
$('openPicker').innerHTML = svg('plus');
$('addScene').innerHTML = svg('plus');
$('collectionMenu').innerHTML = svg('more');

/* ------------------------------ preview placement ------------------------------ */

let frameOrigin = null; // this frame's top-left in the dashboard's viewport (CSS px), from the parent page
function reportPreview() {
  if (!frameOrigin) return;
  // A panel in the preview's place: the native preview would sit on top of it, so it goes away meanwhile.
  if ($('preview').hidden) return shell.studioPreview(null);
  const r = $('preview').getBoundingClientRect();
  const p = $('program').hidden ? null : $('program').getBoundingClientRect();
  shell.studioPreview({
    x: frameOrigin.x + r.left,
    y: frameOrigin.y + r.top,
    width: r.width,
    height: r.height,
    ...(p ? { program: { x: frameOrigin.x + p.left, y: frameOrigin.y + p.top, width: p.width, height: p.height } } : {}),
  });
}
window.addEventListener('message', (e) => {
  if (e.source !== window.parent || !e.data || e.data.type !== 'trigglow-studio:frame') return;
  const { x, y } = e.data;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  frameOrigin = { x, y };
  reportPreview();
  reportDocks();
});
new ResizeObserver(reportPreview).observe($('preview'));

/* Studio mode (OBS's): edit one scene while program shows another, then "Transition". Projectors: program, a scene or
   a source in a window of its own, or full screen on a monitor. */
function renderStudioMode() {
  const on = Boolean(view && view.studioMode);
  $('studioMode').setAttribute('aria-pressed', String(on));
  $('studioMode').classList.toggle('on', on);
  $('smBar').hidden = !on;
  $('program').hidden = !on;
  document.querySelector('.stage').classList.toggle('sm', on);
  $('transitionNow').disabled = !on || view.program === view.current;
  reportPreview();
}
$('studioMode').onclick = () => op({ op: 'studio-mode', value: !(view && view.studioMode) });
$('transitionNow').onclick = () => op({ op: 'transition-now' });
async function projectorMenu(target) {
  const r = await shell.studio({ op: 'screens' });
  const screens = (r && r.screens) || [];
  return [
    { id: 'proj:window', label: tr('studio.proj.window') },
    ...(screens.length ? [{ label: tr('studio.proj.fullscreen'), submenu: screens.map((s) => ({ id: `proj:${s.id}`, label: s.label })) }] : []),
  ].map((it) => ({ ...it, target }));
}
async function openProjectorFrom(picked, target) {
  if (!picked || !picked.startsWith('proj:')) return false;
  const where = picked.slice(5);
  await shell.studio({ op: 'projector', value: { ...target, screen: where === 'window' ? null : Number(where) } });
  return true;
}
$('projectors').onclick = async () => {
  const program = await projectorMenu({ kind: 'program' });
  const scene = await projectorMenu({ kind: 'scene', name: view.current });
  const tag = (items, p) => items.map((it) => (it.submenu ? { ...it, submenu: it.submenu.map((s) => ({ ...s, id: `${p}${s.id}` })) } : { ...it, id: `${p}${it.id}` }));
  const picked = await shell.studioMenu([
    { label: tr('studio.proj.program'), submenu: tag(program, 'p|') },
    { label: tr('studio.proj.scene', { name: view.current }), submenu: tag(scene, 's|') },
  ]);
  if (!picked) return;
  const [which, rest] = picked.split('|');
  await openProjectorFrom(rest, which === 'p' ? { kind: 'program' } : { kind: 'scene', name: view.current });
};
// Leaving the Studio page hides the preview and the docks (the engine keeps running, and streaming if live).
window.addEventListener('pagehide', () => {
  shell.studioPreview(null);
  shell.studioDocks(null);
});

/* ------------------------------------ docks ------------------------------------ */
// Trigglow's activity and chat docks, like OBS's but inside Studio: the app shows the web's /dock pages (on the
// streamer's session) exactly over these bodies. Hidden or folded ones are just not reported. Remembered per PC.

const DOCKS_KEY = 'trigglow.studioDocks';
let docksPref = { hidden: false, closed: [] };
try {
  docksPref = { ...docksPref, ...JSON.parse(localStorage.getItem(DOCKS_KEY) || '{}') };
} catch {}
const saveDocksPref = () => {
  try {
    localStorage.setItem(DOCKS_KEY, JSON.stringify(docksPref));
  } catch {}
};

/** Docks open in a window of their own (keys): out of the column meanwhile. */
const poppedOut = new Set();
function renderDocks() {
  $('sideDocks').hidden = docksPref.hidden;
  $('toggleDocks').setAttribute('aria-pressed', String(!docksPref.hidden));
  for (const sec of document.querySelectorAll('.side')) sec.classList.toggle('closed', docksPref.closed.includes(sec.dataset.dock) || poppedOut.has(sec.dataset.dock));
  reportDocks();
}

function reportDocks() {
  if (!frameOrigin) return;
  const rects = {};
  for (const body of document.querySelectorAll('.dock-body')) {
    const r = body.getBoundingClientRect();
    rects[body.dataset.body] = !docksPref.hidden && r.width > 40 && r.height > 40 ? { x: frameOrigin.x + r.left, y: frameOrigin.y + r.top, width: r.width, height: r.height } : null;
  }
  shell.studioDocks(rects);
}

/* Custom browser docks (OBS's Docks → Custom browser docks): any https page next to the editor, with its name on
   top (an outside page has no title bar of ours). The app shows them in a separate, sandboxed view. */
let customDocks = [];
const docksObserver = new ResizeObserver(reportDocks);
function renderCustomDocks() {
  for (const old of document.querySelectorAll('.dock.side.custom')) old.remove();
  for (const d of customDocks) {
    const key = `custom:${d.id}`;
    const body = el('div', { className: 'dock-body' });
    body.dataset.body = key;
    const section = el(
      'section',
      { className: 'dock side custom', ariaLabel: d.name },
      el('header', { className: 'dock-head' }, el('h2', { textContent: d.name, title: d.url }), iconBtn('more', tr('studio.more'), () => customDockMenu(d), 'quiet')),
      body,
    );
    section.dataset.dock = key;
    $('sideDocks').append(section);
    docksObserver.observe(body);
  }
}
async function customDockMenu(d) {
  const picked = await shell.studioMenu([
    { id: 'window', label: tr('studio.docks.window') },
    { id: 'hide', label: tr('studio.docks.hide') },
    { id: 'remove', label: tr('studio.docks.remove') },
  ]);
  if (picked === 'window') return popOutDock(`custom:${d.id}`);
  if (picked === 'hide') toggleDock(`custom:${d.id}`);
  if (picked === 'remove' && (await confirmed(tr('studio.docks.remove'), tr('studio.docks.removeAsk', { name: d.name })))) {
    const r = await shell.studio({ op: 'custom-dock-remove', name: d.id });
    customDocks = (r && r.docks) || customDocks;
    renderCustomDocks();
    renderDocks();
  }
}
async function loadCustomDocks() {
  const r = await shell.studio({ op: 'custom-docks' });
  customDocks = (r && r.docks) || [];
  renderCustomDocks();
  renderDocks();
}
/** A dock in a window of its own: hidden in the column while that window is open (main.ts openDockWindow). */
async function popOutDock(key) {
  const r = await shell.studio({ op: 'dock-window', name: key });
  if (!r || !r.ok) return;
  poppedOut.add(key);
  renderDocks();
}
const dockKeys = () => ['activity', 'chat', ...customDocks.map((d) => `custom:${d.id}`)];
function toggleDock(picked) {
  const shown = (k) => !docksPref.hidden && !docksPref.closed.includes(k);
  const on = !shown(picked);
  if (docksPref.hidden) {
    // Coming back from "all hidden": just the picked one.
    docksPref = { hidden: false, closed: dockKeys().filter((k) => k !== picked) };
  } else {
    docksPref.closed = on ? docksPref.closed.filter((k) => k !== picked) : [...new Set([...docksPref.closed, picked])];
  }
  docksPref.hidden = dockKeys().every((k) => docksPref.closed.includes(k));
  saveDocksPref();
  renderDocks();
}

// The Docks menu (like OBS's): which docks Studio shows, and the custom ones to add or remove.
$('toggleDocks').onclick = async () => {
  const shown = (k) => !docksPref.hidden && !docksPref.closed.includes(k);
  const picked = await shell.studioMenu([
    ...['activity', 'chat'].map((k) => ({ id: k, label: tr(`studio.dock.${k}`), type: 'checkbox', checked: shown(k) })),
    ...(customDocks.length ? [{ type: 'separator' }] : []),
    ...customDocks.map((d) => ({ id: `custom:${d.id}`, label: d.name, type: 'checkbox', checked: shown(`custom:${d.id}`) })),
    { type: 'separator' },
    { label: tr('studio.docks.window'), submenu: [...['activity', 'chat'].map((k) => ({ id: `win:${k}`, label: tr(`studio.dock.${k}`) })), ...customDocks.map((d) => ({ id: `win:custom:${d.id}`, label: d.name }))] },
    { id: 'add', label: tr('studio.docks.add') },
  ]);
  if (!picked) return;
  if (picked.startsWith('win:')) return popOutDock(picked.slice(4));
  if (picked !== 'add') return toggleDock(picked);
  const name = await askName(tr('studio.docks.add'), tr('studio.docks.name'), '');
  if (!name) return;
  const url = await askName(tr('studio.docks.add'), tr('studio.docks.url'), 'https://');
  if (!url) return;
  const r = await shell.studio({ op: 'custom-dock-add', value: { name, url } });
  if (r && r.error) return setStatus(tr(r.error === 'bad_dock' ? 'studio.docks.bad' : 'studio.err.generic', { error: r.error }), true);
  customDocks = (r && r.docks) || customDocks;
  renderCustomDocks();
  renderDocks();
};
for (const body of document.querySelectorAll('.dock-body')) docksObserver.observe(body);
renderDocks();
void loadCustomDocks();
window.parent.postMessage({ type: 'trigglow-studio:ready' }, '*');

/* --------------------------------- top bar --------------------------------- */

let live = false;
let recording = false;

function setStatus(text, bad = false) {
  $('status').textContent = text;
  $('status').className = bad ? 'status bad' : 'status';
  $('status').title = '';
}
$('status').onclick = () => $('status').classList.contains('link') && shell.nav('multistream');

function renderOutputs() {
  $('go').hidden = live;
  $('stop').hidden = !live;
  $('rec').hidden = recording;
  $('recStop').hidden = !recording;
  $('liveBadge').hidden = !live;
  $('recBadge').hidden = !recording;
}

const START_ERRORS = {
  multistream_unavailable: 'studio.err.multistream_unavailable',
  target_unavailable: 'studio.err.target_unavailable',
  no_ingest: 'studio.err.no_ingest',
  offline: 'studio.err.offline',
  needs_scope: 'studio.err.needs_scope',
  account_unavailable: 'studio.err.account_unavailable',
  key_missing: 'studio.err.key_missing',
};

$('go').onclick = async () => {
  $('go').disabled = true;
  const r = await shell.studioStreamStart();
  $('go').disabled = false;
  if (r.ok) return setStatus('');
  setStatus(START_ERRORS[r.error] ? tr(START_ERRORS[r.error]) : tr('studio.err.generic', { error: r.error }), true);
};
$('stop').onclick = () => shell.studioStreamStop();
$('rec').onclick = async () => {
  const r = await shell.studio({ op: 'record-start' });
  if (r && r.error) setStatus(tr('studio.err.generic', { error: r.error }), true);
};
$('recStop').onclick = () => shell.studio({ op: 'record-stop' });

/* Trigglow Dynamic Delay: on/off here (or the shortcut); its settings live in Settings → Trigglow Studio. */
let delay = null;
function renderDelay() {
  const b = $('delay');
  b.hidden = !delay || !delay.available;
  if (b.hidden) return;
  const left = delay.endsAt ? Math.max(0, Math.ceil((delay.endsAt - Date.now()) / 1000)) : 0;
  b.textContent = delay.state === 'filling' ? tr('studio.delayFilling', { n: left }) : delay.state === 'on' ? tr('studio.delayOn', { n: delay.effective }) : tr('studio.delayOff');
  b.setAttribute('aria-pressed', String(delay.state !== 'off'));
  b.classList.toggle('on', delay.state !== 'off');
  // The plugin dock's notes, here in the status line: fewer seconds than asked (RAM), a lighter buffer, or why it
  // turned itself off. Only when they change, so they don't overwrite other messages every second.
  const h = delay.health;
  let note = '';
  if (delay.state === 'off') note = DELAY_NOTES[delay.message] ? tr(DELAY_NOTES[delay.message]) : '';
  else if (h && h.level > 0) {
    const parts = [];
    if (h.width && h.fullWidth && h.width !== h.fullWidth) parts.push(`${h.width}×${h.height} / ${h.fullWidth}×${h.fullHeight}`);
    if (h.captureFps && h.outputFps && h.captureFps < h.outputFps) parts.push(`${Math.round(h.captureFps)} / ${Math.round(h.outputFps)} fps`);
    note = tr('studio.delayHealth', { detail: parts.join(' · '), cause: tr(`studio.delayCause${[1, 2, 3].includes(h.cause) ? h.cause : 0}`) });
  } else if (delay.effective && delay.effective < delay.seconds) note = tr('studio.delayTrimmed', { n: delay.effective, asked: delay.seconds });
  if (note !== lastDelayNote) {
    lastDelayNote = note;
    if (note) setStatus(note, delay.state === 'off');
    else if ($('status').dataset.delay) setStatus('');
    $('status').dataset.delay = note ? '1' : '';
  }
}
let lastDelayNote = '';
$('delay').onclick = async () => {
  $('delay').disabled = true;
  const r = await shell.studio({ op: 'delay-toggle' });
  $('delay').disabled = false;
  if (r && r.delay) {
    delay = r.delay;
    renderDelay();
  }
  if (r && r.error) setStatus(DELAY_ERRORS[r.error] ? tr(DELAY_ERRORS[r.error]) : tr('studio.err.generic', { error: r.error }), true);
};
const DELAY_ERRORS = { signin_required: 'studio.err.delay_signin', delay_unavailable: 'studio.err.delay_unavailable', delay_live_scene: 'studio.err.delay_live_scene', delay_failed: 'studio.err.delay_failed' };
/** Why it's off, from the plugin's controller (its message). */
const DELAY_NOTES = { collection_changed: 'studio.delayCollection', live_scene_required: 'studio.err.delay_live_scene', delay_failed: 'studio.err.delay_failed' };
$('restartApp').onclick = () => shell.relaunch();
$('openLogs').onclick = () => shell.openStudioLogs();
// The numbers in the bar open OBS's full Stats window.
$('stats').onclick = () => shell.studioPopup({ kind: 'stats' });
// Output settings live in the app's Settings: open them on the Studio tab.
$('openSettings').onclick = () => {
  try {
    localStorage.setItem('trigglow.settingsTab', 'studio');
  } catch {}
  shell.nav('settings');
};

shell.onStudio((kind, p) => {
  if (!p) return;
  if (kind === 'levels') return renderLevels(p);
  if (kind === 'view') {
    view = p;
    return renderEditor();
  }
  if (kind === 'overlay') return void onOverlay(p);
  if (kind === 'dock') {
    // A dock's window closed: back in the column.
    poppedOut.delete(p.key);
    return renderDocks();
  }
  if (kind === 'notice') {
    // Multistream trouble (turned away, a channel down): next to Go live, and a click opens Multistream.
    setStatus(`${p.title}${p.body ? ` · ${p.body}` : ''}`, true);
    $('status').classList.add('link');
    $('status').title = p.body || p.title;
    return;
  }
  if (kind === 'signal') {
    if (p.output === 'engine') {
      // The engine died: no preview, no controls, just the way back.
      $('crashed').hidden = false;
      $('preview').hidden = true;
      reportPreview();
      for (const b of document.querySelectorAll('.top button, .docks button')) b.disabled = true;
      return;
    }
    if (p.output === 'delay') {
      if (p.error) setStatus(DELAY_ERRORS[p.error] ? tr(DELAY_ERRORS[p.error]) : tr('studio.err.generic', { error: p.error }), true);
      return;
    }
    if (p.output === 'record') {
      if (p.signal === 'start') recording = true;
      if (p.signal === 'stop') {
        recording = false;
        if (p.code === 0 && p.file) setStatus(tr('studio.recSaved', { file: p.file.split(/[\\/]/).pop() }));
      }
      // "Automatically remux to mp4" (Settings → Recording): the mp4 copy is ready, or it failed.
      if (p.signal === 'remuxed' && p.file) setStatus(tr('studio.remuxed', { file: p.file.split(/[\\/]/).pop() }));
      if (p.signal === 'remux_failed') setStatus(tr('studio.remuxFailed'), true);
    } else if (p.output === 'replay') {
      // the replay buffer's own events (clips) don't belong in this bar
    } else {
      if (p.signal === 'activate' || p.signal === 'start') live = true;
      if (p.signal === 'reconnect') setStatus(tr('studio.reconnecting'), true);
      if (p.signal === 'reconnect_success') setStatus('');
      if (p.signal === 'deactivate' || p.signal === 'stop') live = false;
    }
    if (p.error) setStatus(tr('studio.err.generic', { error: p.error }), true);
    renderOutputs();
    return;
  }
  // Stats, once a second while the page shows: language-neutral numbers.
  let line = `${Math.round(p.fps)} fps · CPU ${p.engineCpu.toFixed(1)}% · ${Math.round(p.engineMemMB)} MB`;
  if (p.streaming) line += ` · ${p.kbps} kbps · ${tr('studio.dropped', { n: p.droppedFrames })}`;
  $('stats').textContent = line;
  if (p.delay) {
    delay = p.delay;
    renderDelay();
  }
  if (p.streaming !== live || p.recording !== recording) {
    live = p.streaming;
    recording = p.recording;
    renderOutputs();
  }
});

/* ---------------------------- scene collections ---------------------------- */

let collections = null;
function renderCollections() {
  if (!collections) return;
  $('collection').replaceChildren(...collections.list.map((c) => el('option', { value: c.id, textContent: c.name, selected: c.id === collections.current })));
}
async function loadCollections() {
  const r = await shell.studio({ op: 'collections' });
  if (r && r.collections) collections = r.collections;
  renderCollections();
}
async function collectionOp(name, value) {
  const r = await op({ op: 'collection', name, value });
  if (r && r.collections) collections = r.collections;
  renderCollections();
}
$('collection').onchange = () => collectionOp($('collection').value, { action: 'switch' });
$('collectionMenu').onclick = async () => {
  const cur = collections && collections.list.find((c) => c.id === collections.current);
  const picked = await shell.studioMenu([
    { id: 'new', label: tr('studio.col.new') },
    { id: 'copy', label: tr('studio.col.duplicate') },
    { id: 'rename', label: tr('studio.rename') },
    { type: 'separator' },
    ...((collections?.list || []).filter((c) => c.id !== collections.current).length
      ? [{ label: tr('studio.col.remove'), submenu: collections.list.filter((c) => c.id !== collections.current).map((c) => ({ id: `rm:${c.id}`, label: c.name })) }]
      : []),
  ]);
  if (picked === 'new' || picked === 'copy') {
    const name = await askName(tr(picked === 'new' ? 'studio.col.new' : 'studio.col.duplicate'), tr('studio.col.name'), picked === 'copy' && cur ? cur.name : '');
    if (name) await collectionOp('', { action: 'add', name, copy: picked === 'copy' });
  }
  if (picked === 'rename' && cur) {
    const name = await askName(tr('studio.rename'), tr('studio.col.name'), cur.name);
    if (name) await collectionOp(cur.id, { action: 'rename', name });
  }
  if (picked && picked.startsWith('rm:')) {
    const c = collections.list.find((x) => x.id === picked.slice(3));
    if (c && (await confirmed(tr('studio.col.remove'), tr('studio.col.removeAsk', { name: c.name })))) await collectionOp(c.id, { action: 'remove' });
  }
};
loadCollections();

/* ------------------------------- scene editor ------------------------------- */

/** 'type:game_capture' / 'trigglow:chat' → its icon (the Add source window's list, studio-ui.js). */
const SOURCE_ICON = Object.fromEntries(STUDIO_SOURCES.flatMap((g) => g.items));
let view = null;
/** OBS's Copy transform / Copy filters: what was copied, until something else is. */
let copiedTransform = null;
let copiedFilters = null;

async function op(req) {
  const r = await shell.studio(req);
  if (r && r.view !== undefined) {
    view = r.view;
    renderEditor();
  }
  if (r && r.error && r.error !== 'unknown_op') setStatus(tr('studio.err.generic', { error: r.error }), true);
  return r;
}

const iconOf = (it) => SOURCE_ICON[it.trigglow ? `trigglow:${it.trigglow}` : it.type === 'scene' ? 'scene:' : `type:${it.type}`] || 'scene';

function renderEditor() {
  if (!view) return;
  renderStudioMode();
  $('sceneTitle').textContent = view.current;
  $('scenes').replaceChildren(
    ...view.scenes.map((name) =>
      el(
        'li',
        { className: name === view.current ? 'on' : '', role: 'option', ariaSelected: String(name === view.current), oncontextmenu: (e) => (e.preventDefault(), sceneMenu(name)) },
        el('button', { type: 'button', className: 'name', textContent: name, onclick: () => op({ op: 'select-scene', name }), ondblclick: () => renameThing(name) }),
        iconBtn('more', tr('studio.more'), () => sceneMenu(name), 'quiet'),
      ),
    ),
  );
  // Folders (like Streamlabs'): a header before their first item; a folded one hides its items.
  const folders = new Map((view.folders || []).map((f) => [f.id, f]));
  let lastFolder = null;
  $('items').replaceChildren(
    ...view.items.flatMap((it) => {
      const f = it.folder ? folders.get(it.folder) : null;
      const rows = [];
      if (f && lastFolder !== f.id) rows.push(folderRow(f));
      lastFolder = f ? f.id : null;
      if (f && f.closed) return rows;
      const lead = el('span', { className: 'lead' });
      lead.innerHTML = svg(iconOf(it));
      return [...rows, el(
        'li',
        {
          className: [it.visible ? '' : 'off', it.selected ? 'sel' : '', f ? 'in-folder' : ''].join(' ').trim(),
          ondblclick: () => openProps(it),
          oncontextmenu: (e) => (e.preventDefault(), itemMenu(it)),
          onclick: (e) => selectItem(it.id, e.ctrlKey || e.metaKey),
        },
        lead,
        el('button', { type: 'button', className: 'name', textContent: it.source, title: it.source }),
        iconBtn('more', tr('studio.more'), (e) => (e.stopPropagation(), itemMenu(it)), 'quiet'),
        iconBtn(it.locked ? 'lock' : 'unlock', tr(it.locked ? 'studio.unlock' : 'studio.lock'), (e) => (e.stopPropagation(), op({ op: 'lock', id: it.id, value: !it.locked })), it.locked ? 'on' : 'quiet'),
        iconBtn(it.visible ? 'eye' : 'eyeOff', tr(it.visible ? 'studio.hide' : 'studio.show'), (e) => (e.stopPropagation(), op({ op: 'visible', id: it.id, value: !it.visible }))),
      )];
    }),
  );
  $('emptyScene').hidden = view.items.length > 0;
  $('mixer').replaceChildren(
    ...view.audio.map((a) => {
      // The slider is the fader position (the engine maps it to volume on OBS's own curve).
      const slider = el('input', { type: 'range', min: '0', max: '100', value: String(Math.round(a.volume * 100)), ariaLabel: a.name });
      slider.oninput = () => shell.studio({ op: 'volume', name: a.name, value: Number(slider.value) / 100 });
      const meter = el('div', { className: 'meter', ariaHidden: 'true' }, el('i'));
      meter.dataset.source = a.name;
      const mon = a.monitoring ? el('span', { className: 'mon', title: tr('studio.audio.monitoring') }) : null;
      if (mon) mon.innerHTML = svg('headphones');
      return el(
        'li',
        { className: a.muted ? 'off' : '', oncontextmenu: (e) => (e.preventDefault(), mixerMenu(a)) },
        el('div', { className: 'mix-top' }, el('span', { className: 'name', textContent: a.name, title: a.name }), mon),
        el('div', { className: 'mix-ctl' }, el('div', { className: 'mix-bars' }, meter, slider), iconBtn(a.muted ? 'mute' : 'volume', tr(a.muted ? 'studio.unmute' : 'studio.mute'), () => op({ op: 'mute', name: a.name, value: !a.muted }), a.muted ? 'muted' : ''), iconBtn('more', tr('studio.more'), () => mixerMenu(a), 'quiet')),
      );
    }),
  );
  renderLevels(lastLevels); // a redraw keeps the meters where they were
}

/** A folder's header in the source list: fold, its name, and hide/lock all of it at once. */
function folderRow(f) {
  const members = view.items.filter((it) => it.folder === f.id);
  const allHidden = members.every((it) => !it.visible);
  const allLocked = members.every((it) => it.locked);
  const lead = el('span', { className: 'lead' });
  lead.innerHTML = svg(f.closed ? 'chevronRight' : 'chevronDown');
  const act = (action, value) => op({ op: 'folder', name: f.id, value: { action, name: value } });
  return el(
    'li',
    { className: 'folder', oncontextmenu: (e) => (e.preventDefault(), folderMenu(f)), onclick: () => act('toggle') },
    lead,
    el('button', { type: 'button', className: 'name', textContent: f.name, title: f.name, ariaExpanded: String(!f.closed), ondblclick: (e) => (e.stopPropagation(), renameFolder(f)) }),
    iconBtn('more', tr('studio.more'), (e) => (e.stopPropagation(), folderMenu(f)), 'quiet'),
    iconBtn(allLocked ? 'lock' : 'unlock', tr(allLocked ? 'studio.unlock' : 'studio.lock'), (e) => (e.stopPropagation(), act(allLocked ? 'unlock' : 'lock')), allLocked ? 'on' : 'quiet'),
    iconBtn(allHidden ? 'eyeOff' : 'eye', tr(allHidden ? 'studio.show' : 'studio.hide'), (e) => (e.stopPropagation(), act(allHidden ? 'show' : 'hide'))),
  );
}
async function renameFolder(f) {
  const next = await askName(tr('studio.rename'), tr('studio.folder.name'), f.name);
  if (next) await op({ op: 'folder', name: f.id, value: { action: 'rename', name: next } });
}
async function folderMenu(f) {
  const picked = await shell.studioMenu([
    { id: 'rename', label: tr('studio.rename') },
    { id: 'ungroup', label: tr('studio.folder.ungroup') },
  ]);
  if (picked === 'rename') await renameFolder(f);
  if (picked === 'ungroup') await op({ op: 'folder', name: f.id, value: { action: 'ungroup' } });
}

/** The mixer's meters: the loudest channel's peak, −60…0 dB across the bar, green → amber → red like OBS's. */
let lastLevels = {};
function renderLevels(levels) {
  lastLevels = levels;
  for (const meter of document.querySelectorAll('.meter')) {
    const db = levels[meter.dataset.source];
    if (db === undefined) continue;
    const k = Math.max(0, Math.min(1, (db + 60) / 60));
    const bar = meter.firstElementChild;
    bar.style.width = `${(k * 100).toFixed(1)}%`;
    bar.className = db > -9 ? 'hot' : db > -20 ? 'warm' : '';
  }
}

/** Selects an item; Ctrl+click adds it to (or takes it out of) the selection, like OBS. */
function selectItem(id, add = false) {
  if (!view) return;
  for (const i of view.items) {
    if (!add) i.selected = i.id === id;
    else if (i.id === id) i.selected = !i.selected;
  }
  renderEditor();
  void shell.studio({ op: 'select', id, ...(add ? { value: 'add' } : {}) });
}

/* ------------------------------ pop-ups and menus ------------------------------ */
// Real windows and native menus over the app, like OBS's: the engine's native preview would cover anything drawn
// inside this page.

async function openProps(it) {
  if (it.type === 'scene') return op({ op: 'select-scene', name: it.source }); // a nested scene: go edit it
  // A Trigglow overlay's settings are its own Trigglow page (alerts, chat look…), not the browser source's fields.
  await shell.studioPopup(it.trigglow ? { kind: 'web', source: it.trigglow } : { kind: 'props', source: it.source });
  await op({ op: 'view' }); // a size or a device may have changed
}

async function openFilters(name) {
  await shell.studioPopup({ kind: 'filters', source: name });
  await op({ op: 'view' });
}

async function askName(title, label, value) {
  const r = await shell.studioPopup({ kind: 'name', title, message: label, value });
  return typeof r === 'string' && r.trim() ? r.trim() : null;
}

const confirmed = async (title, message) => (await shell.studioPopup({ kind: 'confirm', title, message })) === true;

async function renameThing(name) {
  const next = await askName(tr('studio.rename'), tr('studio.sourceName'), name);
  if (next && next !== name) await op({ op: 'rename', name, value: next });
}

$('addScene').onclick = async () => {
  const name = await askName(tr('studio.newScene'), tr('studio.sceneName'), tr('studio.newScene'));
  if (name) await op({ op: 'add-scene', name });
};

async function removeScene(name) {
  if (await confirmed(tr('studio.removeScene'), tr('studio.confirmRemoveScene', { name }))) await op({ op: 'remove-scene', name });
}

async function removeItem(it) {
  if (await confirmed(tr('studio.remove'), tr('studio.confirmRemove', { name: it.source }))) await op({ op: 'remove-item', id: it.id });
}

/** The Add source window (Streamlabs-like): pick, name it there, and the same window shows its settings. */
$('openPicker').onclick = async () => {
  await shell.studioPopup({ kind: 'picker' });
  await op({ op: 'view' });
};

async function sceneMenu(name) {
  const i = view.scenes.indexOf(name);
  // The scene's own transition is only in the view for the current scene; others are read when they're current.
  const own = name === view.current ? view.transition : undefined;
  const TRS = ['cut', 'fade', 'swipe', 'slide', 'fade_to_color', 'wipe', 'stinger'];
  const picked = await shell.studioMenu([
    { id: 'rename', label: tr('studio.rename') },
    { id: 'duplicate', label: tr('studio.duplicate') },
    { type: 'separator' },
    {
      label: tr('studio.sceneTransition'),
      submenu: [
        { id: 'tr:default', label: tr('studio.sceneTransition.default'), type: 'checkbox', checked: own === null, enabled: own !== undefined },
        { type: 'separator' },
        ...TRS.map((t) => ({ id: `tr:${t}`, label: tr(`studio.tr.${t}`), type: 'checkbox', checked: Boolean(own && own.type === t), enabled: own !== undefined })),
        { type: 'separator' },
        { id: 'tr-ms', label: tr('studio.sceneTransition.ms'), enabled: Boolean(own) },
      ],
    },
    { type: 'separator' },
    { label: tr('studio.proj.open'), submenu: await projectorMenu() },
    { type: 'separator' },
    { id: 'up', label: tr('studio.up'), enabled: i > 0 },
    { id: 'down', label: tr('studio.down'), enabled: i < view.scenes.length - 1 },
    { type: 'separator' },
    { id: 'remove', label: tr('studio.removeScene'), enabled: view.scenes.length > 1 },
  ]);
  if (await openProjectorFrom(picked, { kind: 'scene', name })) return;
  if (picked === 'tr:default') await op({ op: 'scene-transition', name, value: null });
  else if (picked && picked.startsWith('tr:')) await op({ op: 'scene-transition', name, value: { type: picked.slice(3), ms: own ? own.ms : 300 } });
  if (picked === 'tr-ms' && own) {
    const ms = await askName(tr('studio.sceneTransition.ms'), tr('studio.trMs'), String(own.ms));
    if (ms && Number.isFinite(Number(ms))) await op({ op: 'scene-transition', name, value: { type: own.type, ms: Number(ms) } });
  }
  if (picked === 'rename') await renameThing(name);
  if (picked === 'duplicate') {
    const next = await askName(tr('studio.duplicate'), tr('studio.sceneName'), name);
    if (next) await op({ op: 'duplicate-scene', name, value: next });
  }
  if (picked === 'up' || picked === 'down') await op({ op: 'move-scene', name, dir: picked });
  if (picked === 'remove') await removeScene(name);
}

async function itemMenu(it) {
  if (!it.selected) selectItem(it.id);
  const alerts = it.trigglow === 'alerts';
  const scene = it.type === 'scene';
  const tf = (id, key, ok = true) => ({ id: `tf-${id}`, label: tr(key), enabled: ok });
  const picked = await shell.studioMenu([
    { id: 'props', label: tr(scene ? 'studio.openScene' : 'studio.props') },
    { id: 'filters', label: tr('studio.filters'), enabled: !scene },
    { type: 'separator' },
    { id: 'rename', label: tr('studio.rename') },
    { id: 'duplicate', label: tr('studio.duplicate'), enabled: !scene && !it.trigglow },
    { type: 'separator' },
    {
      label: tr('studio.transform'),
      submenu: [
        tf('edit', 'studio.tf.edit'),
        tf('reset', 'studio.tf.reset'),
        { type: 'separator' },
        tf('rotate-cw', 'studio.tf.rotateCw', !alerts),
        tf('rotate-ccw', 'studio.tf.rotateCcw', !alerts),
        tf('rotate-180', 'studio.tf.rotate180', !alerts),
        { type: 'separator' },
        tf('flip-h', 'studio.tf.flipH', !alerts),
        tf('flip-v', 'studio.tf.flipV', !alerts),
        { type: 'separator' },
        tf('fit', 'studio.tf.fit'),
        tf('stretch', 'studio.tf.stretch', !alerts),
        tf('center', 'studio.tf.center', !alerts),
        tf('center-v', 'studio.tf.centerV', !alerts),
        tf('center-h', 'studio.tf.centerH', !alerts),
        { type: 'separator' },
        tf('copy', 'studio.tf.copy'),
        tf('paste', 'studio.tf.paste', Boolean(copiedTransform)),
      ],
    },
    {
      label: tr('studio.order'),
      submenu: [
        { id: 'order-up', label: tr('studio.up') },
        { id: 'order-down', label: tr('studio.down') },
        { id: 'order-top', label: tr('studio.toTop') },
        { id: 'order-bottom', label: tr('studio.toBottom') },
      ],
    },
    {
      label: tr('studio.folder'),
      submenu: [
        { id: 'folder-new', label: tr('studio.folder.new') },
        ...((view.folders || []).length ? [{ type: 'separator' }] : []),
        ...(view.folders || []).map((f) => ({ id: `folder-in:${f.id}`, label: f.name, type: 'checkbox', checked: it.folder === f.id })),
        ...(it.folder ? [{ type: 'separator' }, { id: 'folder-out', label: tr('studio.folder.out') }] : []),
      ],
    },
    { id: 'lock', label: tr('studio.lock'), type: 'checkbox', checked: it.locked },
    { id: 'visible', label: tr('studio.visible'), type: 'checkbox', checked: it.visible },
    { type: 'separator' },
    { label: tr('studio.proj.open'), submenu: await projectorMenu() },
    { type: 'separator' },
    { id: 'copy-filters', label: tr('studio.copyFilters'), enabled: !scene },
    { id: 'paste-filters', label: tr('studio.pasteFilters'), enabled: !scene && Boolean(copiedFilters) && copiedFilters !== it.source },
    { type: 'separator' },
    { id: 'remove', label: tr('studio.remove') },
  ]);
  if (!picked) return;
  if (await openProjectorFrom(picked, scene ? { kind: 'scene', name: it.source } : { kind: 'source', name: it.source })) return;
  if (picked === 'props') return openProps(it);
  if (picked === 'filters') return openFilters(it.source);
  if (picked === 'rename') return renameThing(it.source);
  if (picked === 'duplicate') return op({ op: 'duplicate-item', id: it.id });
  if (picked === 'tf-edit') {
    await shell.studioPopup({ kind: 'transform', source: it.source, item: it.id });
    return op({ op: 'view' });
  }
  if (picked === 'tf-copy') {
    const r = await shell.studio({ op: 'item-transform', id: it.id });
    copiedTransform = r && r.transform;
    return;
  }
  if (picked === 'tf-paste') return op({ op: 'set-transform', id: it.id, value: copiedTransform });
  if (picked.startsWith('tf-')) return op({ op: 'transform-action', id: it.id, value: picked.slice(3) });
  if (picked.startsWith('order-')) return op({ op: 'move', id: it.id, dir: picked.slice(6) });
  if (picked === 'folder-new') {
    const name = await askName(tr('studio.folder.new'), tr('studio.folder.name'), tr('studio.folder.defaultName'));
    const ids = view.items.filter((x) => x.selected).map((x) => x.id);
    if (name) return op({ op: 'folder-add', value: { items: ids.includes(it.id) ? ids : [it.id], name } });
    return;
  }
  if (picked.startsWith('folder-in:')) return op({ op: 'item-folder', id: it.id, value: picked.slice(10) });
  if (picked === 'folder-out') return op({ op: 'item-folder', id: it.id, value: null });
  if (picked === 'lock') return op({ op: 'lock', id: it.id, value: !it.locked });
  if (picked === 'visible') return op({ op: 'visible', id: it.id, value: !it.visible });
  if (picked === 'copy-filters') copiedFilters = it.source;
  if (picked === 'paste-filters') return op({ op: 'paste-filters', name: it.source, value: copiedFilters });
  if (picked === 'remove') return removeItem(it);
}

async function mixerMenu(a) {
  const picked = await shell.studioMenu([
    { id: 'advanced', label: tr('studio.audioAdvanced') },
    { id: 'filters', label: tr('studio.filters') },
    { id: 'rename', label: tr('studio.rename') },
  ]);
  if (picked === 'advanced') {
    await shell.studioPopup({ kind: 'audio' });
    await op({ op: 'view' });
  }
  if (picked === 'filters') await openFilters(a.name);
  if (picked === 'rename') await renameThing(a.name);
}

/* ----------------------- move and resize on the preview ----------------------- */
// The mouse on the preview belongs to the layer over it (studio-overlay.js): it draws the selection and drags. Its
// right-click and double-click come back here (onStudio 'overlay'); the keyboard stays here.

let pending = null;
const selected = () => (view ? view.items.find((i) => i.selected) : null);

function sendTransform(id, value) {
  // At most one in flight: the latest position wins, the engine never queues up a backlog of moves.
  if (pending) {
    pending.value = value;
    return;
  }
  pending = { id, value };
  const flush = async () => {
    const next = pending;
    const r = await shell.studio({ op: 'transform', id: next.id, value: next.value });
    if (pending !== next) return flush();
    pending = null;
    if (r && r.view) {
      view = r.view;
      renderEditor();
    }
  };
  void flush();
}

async function onOverlay(ev) {
  if (!view) return;
  const it = view.items.find((i) => i.id === ev.id);
  if (ev.type === 'dblclick' && it) return openProps(it);
  if (ev.type !== 'contextmenu') return;
  if (it) {
    for (const i of view.items) i.selected = i.id === it.id;
    renderEditor();
    return itemMenu(it);
  }
  const picked = await shell.studioMenu([{ id: 'add', label: tr('studio.addSource') }]);
  if (picked === 'add') $('openPicker').click();
}

// Arrow keys nudge the selected item (Shift: 10 px); Delete removes it. Never while typing in a field.
window.addEventListener('keydown', (e) => {
  const sel = selected();
  if (!sel || /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '')) return;
  if (e.key === 'Delete') {
    e.preventDefault();
    void removeItem(sel);
    return;
  }
  if (sel.trigglow === 'alerts' || sel.locked || !e.key.startsWith('Arrow')) return;
  const step = e.shiftKey ? 10 : 1;
  const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
  const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
  sendTransform(sel.id, { x: sel.box.x + dx, y: sel.box.y + dy });
  e.preventDefault();
});

/* ---------------------------------- start ---------------------------------- */

renderOutputs();
window.addEventListener('localechange', renderEditor);
void op({ op: 'view' });
