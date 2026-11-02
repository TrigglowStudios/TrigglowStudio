// "Updates" card for the settings panel (host: <section class="card" id="updateCard">). Same pattern as clipcard.js.
(() => {
  const shell = window.trigglowShell;
  const root = document.getElementById('updateCard');
  if (!root || !shell) return;

  root.innerHTML = `
    <h2 data-i18n="upd.title"></h2>
    <p id="updStatus" class="hint"></p>
    <label class="switch">
      <span><span data-i18n="upd.auto"></span><small data-i18n="upd.autoHint"></small></span>
      <input id="updAuto" type="checkbox">
    </label>
    <div class="actions left">
      <button id="updCheck" data-i18n="upd.check"></button>
      <button id="updInstall" class="primary hidden" data-i18n="upd.install"></button>
    </div>`;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = tr(el.dataset.i18n);

  const $ = (id) => document.getElementById(id);
  function render(s) {
    const u = s.update;
    $('updAuto').checked = u.auto;
    $('updStatus').textContent = tr('upd.status.' + u.status, { v: s.version, version: u.version ?? '', percent: u.percent ?? 0 });
    $('updCheck').disabled = ['unsupported', 'checking', 'downloading', 'ready'].includes(u.status);
    $('updInstall').classList.toggle('hidden', u.status !== 'ready');
  }
  $('updAuto').onchange = (e) => shell.setPrefs({ autoUpdate: e.target.checked });
  $('updCheck').onclick = () => shell.updateCheck().then(render);
  $('updInstall').onclick = () => shell.updateInstall();
  window.UpdateCard = { render };
})();
