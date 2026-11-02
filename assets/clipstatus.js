// Live status of "save a clip" for the web's Clips page: saving → uploading → done / failed. Empty (0 px tall) when idle.
const $ = (id) => document.getElementById(id);
const shell = window.trigglowShell;
let lastSeq = -1;
const BUSY = ['saving', 'compressing', 'uploading'];

function render(s) {
  const p = s.clip.progress;
  const show = p.phase !== 'idle';
  $('banner').classList.toggle('hidden', !show);
  if (!show) return;
  const bad = p.phase === 'failed';
  $('banner').className = 'clipbanner ' + (bad ? 'bad' : p.phase === 'done' || p.phase === 'deferred' ? 'ok' : 'busy');
  $('spin').classList.toggle('hidden', !(BUSY.includes(p.phase)));
  $('icon').classList.toggle('hidden', BUSY.includes(p.phase));
  $('icon').textContent = bad ? '!' : '✓';
  $('cbTitle').textContent = tr(bad ? 'cs.failed' : 'cs.' + p.phase);
  $('cbBody').textContent = bad ? tr('clip.err.' + p.reason) + (p.detail ? ` (${p.detail})` : '') : p.phase === 'done' ? p.title : tr('cs.' + p.phase + 'Body');
  // a finished clip: tell the Clips page so it refreshes its list on its own
  if (p.phase === 'done' && p.seq !== lastSeq) parent.postMessage({ type: 'trigglow:clip-created' }, '*');
  lastSeq = p.seq;
}

if (shell) {
  const refresh = () => shell.getState().then(render, () => undefined);
  refresh();
  setInterval(() => !document.hidden && refresh(), 1000);
}
