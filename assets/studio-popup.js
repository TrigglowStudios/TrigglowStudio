// Trigglow Studio pop-up windows (main.ts openStudioPopup), the ones OBS has as windows: Add source, a source's
// properties, its filters, Edit transform, Advanced audio properties, a name to type, and "are you sure?". The answer
// goes back through studioPopupDone; closing the window without answering counts as "no".
const shell = window.trigglowShell;
const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const kind = q.get('kind');
let source = q.get('source') || '';
const itemId = Number(q.get('item'));

const done = (value) => shell.studioPopupDone(value);
$(kind).hidden = false;

/* -------------------------------- add source -------------------------------- */

let pickedSource = null;
/** Sources and scenes that already exist, for "Add existing" (and the scene to show, for a nested scene). */
let existing = [];
shell.studio({ op: 'existing' }).then((r) => (existing = (r && r.existing) || []));

/** Existing sources matching a picker entry: same type ('scene:' = scenes). Trigglow overlays are one source each. */
function existingFor(id) {
  const [k, key] = id.split(':');
  if (k === 'trigglow') return [];
  return existing.filter((x) => (k === 'scene' ? x.type === 'scene' : x.type === key && !x.trigglow));
}
const pickMode = () => (document.querySelector('input[name="pickMode"]:checked') || {}).value || 'new';
function showPickMode() {
  const scene = pickedSource && pickedSource.startsWith('scene:');
  const overlay = pickedSource && pickedSource.startsWith('trigglow:');
  const have = pickedSource ? existingFor(pickedSource) : [];
  // A nested scene is always an existing scene; an overlay needs nothing; the rest: new, or one that exists.
  $('pickMode').hidden = scene || overlay || !have.length;
  const useExisting = scene || (!overlay && have.length && pickMode() === 'existing');
  $('pickNameRow').hidden = overlay || useExisting;
  $('pickExistingRow').hidden = !useExisting;
  $('pickExistingLabel').textContent = tr(scene ? 'studio.pick.whichScene' : 'studio.audio.name');
  $('pickExisting').replaceChildren(...have.map((x) => el('option', { value: x.name, textContent: x.name })));
  $('ok').disabled = !pickedSource || (scene && !have.length);
}
for (const r of document.querySelectorAll('input[name="pickMode"]')) r.onchange = showPickMode;

function renderPicker() {
  const query = $('pickSearch').value.trim().toLowerCase();
  let shown = 0;
  $('pickGroups').replaceChildren(
    ...STUDIO_SOURCES.map((g) => {
      const items = g.items.filter(([id]) => {
        const info = sourceInfo(id);
        return !query || `${info.name} ${info.desc}`.toLowerCase().includes(query);
      });
      shown += items.length;
      if (!items.length) return '';
      return el(
        'section',
        {},
        el('h3', { textContent: tr(g.title) }),
        el(
          'div',
          { className: 'tiles' },
          ...items.map(([id, icon]) => {
            const b = el('button', { type: 'button', className: 'tile', ariaPressed: String(id === pickedSource) });
            b.innerHTML = svg(icon);
            b.append(el('span', { textContent: sourceInfo(id).name }));
            b.onclick = () => pickSource(id, icon);
            b.ondblclick = () => addPicked(id); // like Streamlabs: double click adds it right away
            return b;
          }),
        ),
      );
    }),
  );
  $('pickNone').hidden = shown > 0;
}

function pickSource(id, icon) {
  const changed = id !== pickedSource;
  pickedSource = id;
  const info = sourceInfo(id);
  $('pickIcon').innerHTML = svg(icon);
  $('pickName').textContent = info.name;
  $('pickDesc').textContent = info.desc;
  // A Trigglow overlay is one fixed source: nothing to name. Everything else gets its name here, prefilled.
  if (changed && !id.startsWith('trigglow:')) $('pickNameInput').value = info.name;
  if (changed) document.querySelector('input[name="pickMode"][value="new"]').checked = true;
  showPickMode();
  renderPicker();
}

/**
 * Adds the picked source. An overlay is added and the window closes; any other source is created with the typed name
 * and this same window turns into its settings (the window, camera, file… to use), like every streaming app does.
 */
async function addPicked(id) {
  $('ok').disabled = true;
  const [k, key] = id.split(':');
  if (k === 'trigglowscene') {
    // A whole scene, named in the name field (prefilled "Trigglow Overlays"…): it becomes the current scene.
    await shell.studio({ op: 'add-trigglow-scene', value: $('pickNameInput').value.trim() || sourceInfo(id).name });
    return done('added');
  }
  if (k === 'scene' || (pickMode() === 'existing' && !$('pickExistingRow').hidden)) {
    const name = $('pickExisting').value;
    if (!name) return showPickMode();
    await shell.studio({ op: 'add-existing', name });
    return done('added');
  }
  if (k === 'trigglow') {
    await shell.studio({ op: 'add-source', trigglow: key });
    return done('added');
  }
  const before = new Set((((await shell.studio({ op: 'view' })) || {}).view?.items || []).map((i) => i.source));
  const r = await shell.studio({ op: 'add-source', type: key, name: $('pickNameInput').value.trim() || sourceInfo(id).name });
  const added = r && r.view && r.view.items.find((i) => !before.has(i.source));
  if (!added) return done('added');
  openSourceSettings(added.source);
}

function openSourceSettings(name) {
  source = name;
  $('picker').hidden = true;
  $('props').hidden = false;
  $('cancel').hidden = true;
  $('title').textContent = tr('studio.propsFor', { name });
  $('ok').textContent = tr('studio.ok');
  $('ok').disabled = false;
  $('ok').onclick = () => done('added');
  shell.studio({ op: 'properties', name }).then((r) => renderProps($('propsBody'), (r && r.properties) || []));
}

if (kind === 'picker') {
  $('title').textContent = tr('studio.addSource');
  $('pickSearchIcon').innerHTML = svg('search');
  $('pickSearch').placeholder = tr('studio.pick.search');
  $('cancel').hidden = false;
  $('ok').textContent = tr('studio.addSource');
  $('ok').disabled = true;
  $('ok').onclick = () => pickedSource && addPicked(pickedSource);
  $('pickSearch').oninput = renderPicker;
  $('pickSearch').onkeydown = (e) => {
    if (e.key === 'Enter' && pickedSource) addPicked(pickedSource);
  };
  $('pickNameInput').onkeydown = (e) => {
    if (e.key === 'Enter' && pickedSource) addPicked(pickedSource);
  };
  renderPicker();
  $('pickSearch').focus();
}

/* ---------------------------- source properties ---------------------------- */

function renderProps(target, props, filter) {
  const redraw = (r) => r && r.properties && renderProps(target, r.properties, filter);
  const change = (name) => (value) => shell.studio({ op: 'update-properties', name: source, filter: filter || undefined, changes: { [name]: value } }).then(redraw);
  const ctx = {
    press: (name) => shell.studio({ op: 'press-button', name: source, filter: filter || undefined, value: name }).then(redraw),
    pick: async (opts) => ((await shell.studio({ op: 'pick-path', value: opts })) || {}).paths || [],
  };
  // Keep the scroll position: a redraw after every change would jump to the top.
  const scroll = target.parentElement ? target.parentElement.scrollTop : 0;
  target.replaceChildren(...(props.length ? props.map((p) => propField(p, change(p.name), ctx)) : [el('p', { className: 'empty', textContent: tr('studio.noProps') })]));
  if (target.parentElement) target.parentElement.scrollTop = scroll;
}

if (kind === 'props') {
  $('title').textContent = tr('studio.propsFor', { name: source });
  $('ok').onclick = () => done(true);
  shell.studio({ op: 'properties', name: source }).then((r) => renderProps($('propsBody'), (r && r.properties) || []));
}

/* --------------------------------- filters --------------------------------- */

let picked = null;

function renderFilters(f) {
  if (!f) return;
  if (picked && !f.filters.some((x) => x.name === picked)) picked = null;
  if (!picked && f.filters.length) picked = f.filters[0].name;
  $('noFilters').hidden = f.filters.length > 0;
  $('filterList').replaceChildren(
    ...f.filters.map((x) =>
      el(
        'li',
        { className: [x.name === picked ? 'on' : '', x.enabled ? '' : 'off'].join(' ').trim() },
        el('button', { type: 'button', className: 'name', textContent: x.name, onclick: () => pick(x.name, f) }),
        iconBtn('up', tr('studio.up'), () => shell.studio({ op: 'move-filter', name: source, filter: x.name, dir: 'up' }).then(renderFilters), 'quiet'),
        iconBtn('down', tr('studio.down'), () => shell.studio({ op: 'move-filter', name: source, filter: x.name, dir: 'down' }).then(renderFilters), 'quiet'),
        iconBtn('trash', tr('studio.remove'), () => shell.studio({ op: 'remove-filter', name: source, filter: x.name }).then(renderFilters), 'quiet'),
        iconBtn(x.enabled ? 'eye' : 'eyeOff', tr(x.enabled ? 'studio.hide' : 'studio.show'), () => shell.studio({ op: 'filter-enabled', name: source, filter: x.name, value: !x.enabled }).then(renderFilters)),
      ),
    ),
  );
  $('addFilter').replaceChildren(el('option', { value: '', textContent: `+ ${tr('studio.addFilter')}` }), ...f.available.map((a) => el('option', { value: a.type, textContent: a.label })));
  void showFilter();
}

function pick(name, f) {
  picked = name;
  renderFilters(f);
}

async function showFilter() {
  $('pickFilter').hidden = Boolean(picked);
  if (!picked) return $('filterProps').replaceChildren();
  const r = await shell.studio({ op: 'properties', name: source, filter: picked });
  renderProps($('filterProps'), (r && r.properties) || [], picked);
}

if (kind === 'filters') {
  $('title').textContent = tr('studio.filtersFor', { name: source });
  $('ok').onclick = () => done(true);
  $('addFilter').onchange = async (e) => {
    const type = e.target.value;
    e.target.value = '';
    if (!type) return;
    const before = new Set(((await shell.studio({ op: 'filters', name: source })) || { filters: [] }).filters.map((x) => x.name));
    const f = await shell.studio({ op: 'add-filter', name: source, type });
    picked = (f.filters.find((x) => !before.has(x.name)) || {}).name || picked; // show the one just added
    renderFilters(f);
  };
  shell.studio({ op: 'filters', name: source }).then(renderFilters);
}

/* ------------------------------ edit transform ------------------------------ */

const BOUNDS = ['studio.tf.b0', 'studio.tf.b1', 'studio.tf.b2', 'studio.tf.b3', 'studio.tf.b4', 'studio.tf.b5', 'studio.tf.b6'];

function fillTransform(t) {
  if (!t) return;
  const set = (id, v) => ($(id).value = String(Math.round(v * 100) / 100));
  set('tfX', t.x);
  set('tfY', t.y);
  set('tfRot', t.rotation);
  set('tfW', t.width);
  set('tfH', t.height);
  $('tfBT').value = String(t.boundsType);
  set('tfBW', t.boundsWidth);
  set('tfBH', t.boundsHeight);
  set('tfCL', t.crop.left);
  set('tfCT', t.crop.top);
  set('tfCR', t.crop.right);
  set('tfCB', t.crop.bottom);
  const bounded = t.boundsType > 0;
  $('tfW').disabled = $('tfH').disabled = bounded;
  $('tfBW').disabled = $('tfBH').disabled = !bounded;
  // The alerts are always centred and upright: only their size.
  $('tfAlerts').hidden = !t.alerts;
  for (const id of ['tfX', 'tfY', 'tfRot', 'tfCL', 'tfCT', 'tfCR', 'tfCB']) $(id).disabled = t.alerts;
}

async function saveTransform() {
  const n = (id) => Number($(id).value);
  const r = await shell.studio({
    op: 'set-transform',
    id: itemId,
    value: { x: n('tfX'), y: n('tfY'), rotation: n('tfRot'), width: n('tfW'), height: n('tfH'), boundsType: n('tfBT'), boundsWidth: n('tfBW'), boundsHeight: n('tfBH'), crop: { left: n('tfCL'), top: n('tfCT'), right: n('tfCR'), bottom: n('tfCB') } },
  });
  fillTransform(r && r.transform);
}

if (kind === 'transform') {
  $('title').textContent = tr('studio.tf.title', { name: source });
  $('tfBT').replaceChildren(...BOUNDS.map((key, i) => el('option', { value: String(i), textContent: tr(key) })));
  for (const input of document.querySelectorAll('#transform input, #transform select')) input.onchange = saveTransform;
  $('reset').hidden = false;
  $('reset').onclick = async () => {
    await shell.studio({ op: 'transform-action', id: itemId, value: 'reset' });
    fillTransform(((await shell.studio({ op: 'item-transform', id: itemId })) || {}).transform);
  };
  $('ok').onclick = () => done(true);
  shell.studio({ op: 'item-transform', id: itemId }).then((r) => fillTransform(r && r.transform));
}

/* ------------------------------- encoder settings ------------------------------- */

function renderEncoder(props) {
  const change = (name) => (value) => shell.studio({ op: 'update-encoder-properties', value: { id: source, changes: { [name]: value } } }).then((r) => r && r.properties && renderEncoder(r.properties));
  $('encoderBody').replaceChildren(...(props.length ? props.map((p) => propField(p, change(p.name))) : [el('p', { className: 'empty', textContent: tr('studio.noProps') })]));
}

if (kind === 'encoder') {
  $('title').textContent = tr('studio.encoderSettings');
  $('reset').hidden = false;
  $('reset').textContent = tr('studio.encoderReset');
  $('reset').onclick = () => shell.studio({ op: 'encoder-reset', value: { id: source } }).then((r) => r && renderEncoder(r.properties || []));
  $('ok').onclick = () => done(true);
  shell.studio({ op: 'encoder-properties', value: { id: source } }).then((r) => renderEncoder((r && r.properties) || []));
}

/* -------------------------- advanced audio properties -------------------------- */

function renderAudio(rows) {
  const set = (name, value) => shell.studio({ op: 'set-audio', name, value }).then((r) => r && r.audio && renderAudio(r.audio));
  $('audioRows').replaceChildren(
    ...rows.map((a) => {
      const db = el('input', { type: 'number', step: '0.1', min: '-100', max: '26', value: String(a.db), ariaLabel: tr('studio.audio.volume') });
      db.onchange = () => set(a.name, { db: Number(db.value) });
      const mono = el('input', { type: 'checkbox', checked: a.mono, ariaLabel: tr('studio.audio.mono') });
      mono.onchange = () => set(a.name, { mono: mono.checked });
      const sync = el('input', { type: 'number', step: '1', min: '-950', max: '20000', value: String(a.syncMs), ariaLabel: tr('studio.audio.sync') });
      sync.onchange = () => set(a.name, { syncMs: Number(sync.value) });
      const mon = el('select', { ariaLabel: tr('studio.audio.monitoring') }, ...[0, 1, 2].map((v) => el('option', { value: String(v), textContent: tr(`studio.audio.mon${v}`), selected: v === a.monitoring })));
      mon.onchange = () => set(a.name, { monitoring: Number(mon.value) });
      // Audio tracks 1–6 (OBS's): the stream takes track 1, a multitrack recording the ones chosen in Settings.
      const tracks = el(
        'div',
        { className: 'tracks' },
        ...[0, 1, 2, 3, 4, 5].map((i) => {
          const box = el('input', { type: 'checkbox', checked: Boolean(a.tracks & (1 << i)), ariaLabel: `${tr('studio.audio.tracks')} ${i + 1}`, title: String(i + 1) });
          box.onchange = () => set(a.name, { tracks: box.checked ? a.tracks | (1 << i) : a.tracks & ~(1 << i) });
          return box;
        }),
      );
      return el('tr', {}, el('td', { className: 'audio-name', textContent: a.name, title: a.name }), el('td', {}, db), el('td', { className: 'center' }, mono), el('td', {}, sync), el('td', {}, mon), el('td', {}, tracks));
    }),
  );
}

if (kind === 'audio') {
  $('title').textContent = tr('studio.audioAdvanced');
  $('ok').onclick = () => done(true);
  shell.studio({ op: 'audio-props' }).then((r) => renderAudio((r && r.audio) || []));
}

/* ------------------------------------ stats ------------------------------------ */

const pct = (part, total) => (total > 0 ? `${((part / total) * 100).toFixed(1)}%` : '0.0%');
async function renderStats() {
  const r = await shell.studio({ op: 'perf' });
  const p = r && r.perf;
  if (!p) return;
  const fmt = (n, d = 0) => Number(n).toLocaleString(document.documentElement.lang || undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
  const rows = [
    ['studio.st.cpu', `${fmt(p.cpu, 1)}%`],
    ['studio.st.memory', `${fmt(p.memoryMB, 1)} MB`],
    ['studio.st.disk', p.diskFree || '—'],
    ['studio.st.fps', fmt(p.fps, 2)],
    ['studio.st.render', `${fmt(p.renderMs, 1)} ms`],
    ['studio.st.lagged', `${fmt(p.lagged)} / ${fmt(p.rendered)} (${pct(p.lagged, p.rendered)})`, p.lagged > 0],
    ['studio.st.skipped', `${fmt(p.skipped)} / ${fmt(p.encoded)} (${pct(p.skipped, p.encoded)})`, p.skipped > 0],
    ['studio.st.dropped', p.streaming ? `${fmt(p.dropped)} / ${fmt(p.sent)} (${pct(p.dropped, p.sent)})` : '—', p.dropped > 0],
    ['studio.st.stream', p.streaming ? `${fmt(p.streamKbps)} kb/s · ${fmt(p.streamMB, 1)} MB` : tr('studio.st.inactive')],
    ['studio.st.record', p.recording ? `${fmt(p.recordKbps)} kb/s · ${fmt(p.recordMB, 1)} MB` : tr('studio.st.inactive')],
  ];
  $('statsRows').replaceChildren(...rows.map(([k, v, bad]) => el('tr', {}, el('th', { scope: 'row', textContent: tr(k) }), el('td', { className: bad ? 'bad' : '', textContent: v }))));
}

if (kind === 'stats') {
  $('title').textContent = tr('studio.stats');
  $('ok').onclick = () => done(true);
  renderStats();
  setInterval(renderStats, 1000);
}

/* ------------------------------ name, confirm ------------------------------ */

if (kind === 'name') {
  $('title').textContent = q.get('title') || '';
  $('nameLabel').textContent = q.get('message') || '';
  $('nameInput').value = q.get('value') || '';
  $('cancel').hidden = false;
  const submit = () => {
    const v = $('nameInput').value.trim();
    if (v) done(v);
  };
  $('ok').onclick = submit;
  $('name').onsubmit = (e) => {
    e.preventDefault();
    submit();
  };
  $('nameInput').select();
  $('nameInput').focus();
}

if (kind === 'confirm') {
  $('title').textContent = q.get('title') || '';
  $('confirmText').textContent = q.get('message') || '';
  $('cancel').hidden = false;
  $('ok').textContent = tr('studio.remove');
  $('ok').className = 'btn danger';
  $('ok').onclick = () => done(true);
  $('ok').focus();
}

$('cancel').onclick = () => done(null);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') done(null);
});
