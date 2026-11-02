const $ = (id) => document.getElementById(id);
const shell = window.trigglowShell;
let url;
let lastState = null;

function render(s) {
  if (s) lastState = s;
  s = s || lastState;
  if (!s) return;
  const signIn = s.signIn || { status: 'idle' };
  const reachable = s.reachable !== false;
  url = signIn.url;

  const waiting = signIn.status === 'waiting';

  const idleEl = $('idle');
  if (idleEl) idleEl.classList.toggle('hidden', waiting);

  const waitingEl = $('waiting');
  if (waitingEl) waitingEl.classList.toggle('hidden', !waiting);

  const againBtn = $('again');
  if (againBtn) againBtn.classList.toggle('hidden', !signIn.url);

  const startBtn = $('start');
  if (startBtn) {
    const ctaSpan = startBtn.querySelector('.cta-text') || startBtn.querySelector('span');
    if (ctaSpan) ctaSpan.textContent = tr('signin.cta');
  }

  const err = signIn.status === 'error'
    ? tr(signIn.error === 'expired' ? 'signin.err.expired' : signIn.error === 'rate_limited' ? 'signin.err.rate_limited' : 'signin.err.generic')
    : !reachable ? tr('signin.offline') : '';

  const errEl = $('error');
  if (errEl) errEl.textContent = err;

  const errContainer = $('error-container') || errEl;
  if (errContainer) errContainer.classList.toggle('hidden', !err);

  const verEl = $('version');
  if (verEl && s.version) {
    verEl.textContent = `Trigglow Studio v${s.version}`;
  }
}

const langSelect = $('lang-select');
if (langSelect && window.getLocale) {
  langSelect.value = window.getLocale();
  langSelect.addEventListener('change', (e) => {
    if (window.setLocale) {
      window.setLocale(e.target.value);
    }
  });
}

window.addEventListener('localechange', (e) => {
  if (langSelect && e.detail?.locale) {
    langSelect.value = e.detail.locale;
  }
  render(lastState);
});

if (shell) {
  const startBtn = $('start');
  if (startBtn) startBtn.onclick = () => shell.signIn();

  const cancelBtn = $('cancel');
  if (cancelBtn) cancelBtn.onclick = () => shell.cancelSignIn();

  const againBtn = $('again');
  if (againBtn) againBtn.onclick = () => url && shell.openExternal(url);

  shell.onState(render);
  shell.getState().then(render);
}
