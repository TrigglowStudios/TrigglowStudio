const shell = window.trigglowShell;
document.body.classList.add(new URLSearchParams(location.search).get('platform') || 'win32');

const TIPS = { back: 'titlebar.back', forward: 'titlebar.forward', reload: 'titlebar.reload', settings: 'titlebar.settings' };
for (const [id, key] of Object.entries(TIPS)) {
  const el = document.getElementById(id);
  el.title = tr(key);
  el.setAttribute('aria-label', tr(key));
  if (shell) el.onclick = () => shell.nav(id);
}

// Update pill: only while a new version is downloading / waiting to be installed.
const pill = document.getElementById('update');
function renderUpdate(s) {
  const o = s.obs;
  const obsEl = document.getElementById('obs');
  // Trigglow Studio replaces OBS: nothing about OBS shows while it is the chosen engine.
  obsEl.classList.toggle('hidden', Boolean(s.engine && s.engine.available && s.engine.mode === 'studio'));
  obsEl.className = 'obs ' + (o.state === 'connected' ? 'ok' : o.state === 'error' ? 'bad' : '');
  obsEl.title = tr(o.state === 'error' ? 'settings.obs.error' : `settings.obs.${o.state}`, { error: o.error ?? '' }) + ` · ${o.host}:${o.port}`;
  const u = s.update;
  const show = u.status === 'downloading' || u.status === 'ready';
  pill.classList.toggle('hidden', !show);
  pill.classList.toggle('ready', u.status === 'ready');
  pill.disabled = u.status !== 'ready';
  pill.textContent = u.status === 'ready' ? tr('titlebar.update.ready') : tr('titlebar.update.downloading', { percent: u.percent ?? 0 });
  pill.title = u.version ? `v${u.version}` : '';
}
if (shell) {
  pill.onclick = () => shell.updateInstall();
  shell.onState(renderUpdate);
  shell.getState().then(renderUpdate, () => undefined);
}
