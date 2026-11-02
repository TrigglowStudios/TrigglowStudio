// The "OBS texts" tool: Trigglow data written into OBS text sources. Framed inside the dashboard's own page
// (/app/obs-texts); only touches the DOM that changed, so inputs being typed in are never overwritten.
(() => {
  const $ = (id) => document.getElementById(id);
  const shell = window.trigglowShell;
  if (!shell) return;
  const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids);
    return node;
  };

  const rows = new Map(); // binding id → row parts
  let optionsSig = '';
  let state = null;
  // tr() blanks unknown {placeholders}; mapping each to itself shows them literally.
  const literal = { name: '{name}', amount: '{amount}', title: '{title}', current: '{current}', target: '{target}', percent: '{percent}', bar: '{bar}', remaining: '{remaining}' };
  const labelOf = (b) => (b.id.startsWith('widget:') ? (b.label ?? b.source) : tr(`text.kind.${b.id}`));
  const helpOf = (id) => tr(id === 'latest_donation' ? 'text.help.donation' : id.startsWith('widget:') ? 'text.help.widget' : 'text.help.latest', literal);

  function makeRow(b) {
    const title = el('strong', { className: 'ts-title' });
    const pill = el('span', { className: 'ts-pill' });
    const remove = el('button', { className: 'link', type: 'button', textContent: tr('text.remove') });
    const create = el('button', { type: 'button', textContent: trs('text.create') });
    const src = el('input', { type: 'text', maxLength: 100 });
    const tpl = el('input', { type: 'text', maxLength: 200 });
    const preview = el('div', { className: 'ts-preview' });
    const commit = (field, input) => () => (input.value.trim() ? shell.textUpdate({ id: b.id, [field]: input.value }).then(setState) : undefined);
    src.onchange = commit('source', src);
    tpl.onchange = commit('template', tpl);
    remove.onclick = () => shell.textRemove(b.id).then(setState);
    create.onclick = () => shell.textCreate(b.id).then(setState);
    const li = el(
      'li',
      { className: 'ts-row' },
      el('div', { className: 'ts-head' }, title, pill, remove),
      el('div', { className: 'row' }, el('label', {}, el('span', { textContent: trs('text.source') }), src), el('label', {}, el('span', { textContent: tr('text.template') }), tpl)),
      el('div', { className: 'hint', textContent: helpOf(b.id) }),
      preview,
      create,
    );
    $('tsList').append(li);
    return { li, title, pill, src, tpl, preview, create };
  }

  function render() {
    if (!state) return;
    const { bindings, available } = state.text;
    document.querySelector('[data-i18n="text.title"]').textContent = trs('text.title');
    // Without the WebSocket link nothing can be written; say why (same one-line diagnosis as everywhere else).
    // With Trigglow Studio the texts go to its own engine: no OBS to diagnose.
    const o = state.obs;
    const ok = studio() || o.state === 'connected';
    $('obsNote').textContent = ok ? '' : tr(`obs.hint.${o.hint}`);
    $('obsNote').classList.toggle('hidden', ok);

    const ids = new Set(bindings.map((b) => b.id));
    for (const [id, r] of rows) {
      if (ids.has(id)) continue;
      r.li.remove();
      rows.delete(id);
    }
    for (const b of bindings) {
      if (!rows.has(b.id)) rows.set(b.id, makeRow(b));
      const r = rows.get(b.id);
      r.title.textContent = labelOf(b);
      r.pill.textContent = trs(`text.status.${b.status}`);
      r.pill.className = 'ts-pill ' + (b.status === 'ok' ? 'ok' : b.status === 'missing' || b.status === 'error' ? 'bad' : '');
      if (document.activeElement !== r.src) r.src.value = b.source;
      if (document.activeElement !== r.tpl) r.tpl.value = b.template;
      r.preview.textContent = b.value ? `${tr('text.preview')}: ${b.value}` : '';
      r.create.classList.toggle('hidden', b.status !== 'missing');
    }
    $('tsEmpty').classList.toggle('hidden', bindings.length > 0);
    const sig = available.map((a) => a.id).join('|');
    if (sig !== optionsSig && document.activeElement !== $('tsSelect')) {
      optionsSig = sig;
      $('tsSelect').replaceChildren(...available.map((a) => el('option', { value: a.id, textContent: a.id.startsWith('widget:') ? a.label : tr(`text.kind.${a.id}`) })));
    }
    $('tsAdd').disabled = available.length === 0;
  }

  /** Trigglow Studio is the engine: the texts that say "OBS" have a Studio version. */
  function studio() {
    return Boolean(state && state.engine && state.engine.running);
  }
  const STUDIO_TEXTS = new Set(['text.title', 'text.source', 'text.create', 'text.status.missing', 'text.status.offline']);
  function trs(key) {
    return tr(studio() && STUDIO_TEXTS.has(key) ? `${key}Studio` : key);
  }

  function setState(s) {
    state = s;
    render();
  }
  $('tsAdd').onclick = () => $('tsSelect').value && shell.textAdd($('tsSelect').value).then(setState);
  const refresh = () => shell.getState().then(setState, () => undefined);
  refresh();
  setInterval(() => !document.hidden && refresh(), 2000);
})();
