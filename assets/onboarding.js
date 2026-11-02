const $ = (id) => document.getElementById(id);
const shell = window.trigglowShell;
// The engine step only exists when this build can run Trigglow Studio; with Studio picked, the OBS steps go away.
const ALL_STEPS = ['welcome', 'account', 'engine', 'import', 'obs', 'overlays', 'done'];
let STEPS = ALL_STEPS.filter((s) => s !== 'engine');
function syncSteps() {
  const current = STEPS[i];
  const e = st && st.engine;
  STEPS = ALL_STEPS.filter((s) => {
    if (s === 'engine') return Boolean(e && e.available);
    // Bring OBS / Streamlabs scenes: only with Studio running and something on this PC to bring.
    if (s === 'import') return Boolean(e && e.available && e.mode === 'studio' && e.running && importList && importList.collections.length);
    if (s === 'obs' || s === 'overlays') return !(e && e.available && e.mode === 'studio');
    return true;
  });
  const at = STEPS.indexOf(current);
  if (at >= 0) i = at;
}

let i = 0;
let st = null;
let overlays = null; // [{id,name,url}] loaded when the overlays step opens
let scenesLoaded = false;
let installing = false;
let installedCount = 0;
let manualOpen = false;
let manualFilled = false;
let wasSignedIn = false;
let importList = null; // OBS / Streamlabs collections on this PC (Studio only)
let imported = false;

async function loadImportList() {
  if (!(st && st.engine && st.engine.running) || importList) return;
  importList = await shell.studio({ op: 'import-list' });
  const list = (importList && importList.collections) || [];
  $('imp-pick').replaceChildren(...list.map((c) => Object.assign(document.createElement('option'), { value: c.id, textContent: `${tr(`studio.imp.app.${c.app}`)} · ${c.name}` })));
  render();
}

/** The same report as Settings → Trigglow Studio: headline, then what was converted and what couldn't come. */
function renderImportReport(r) {
  const section = (level, title) => {
    const notes = r.notes.filter((n) => n.level === level);
    if (!notes.length) return [];
    const h = Object.assign(document.createElement('h3'), { textContent: tr(title) });
    const ul = document.createElement('ul');
    ul.append(...notes.map((n) => Object.assign(document.createElement('li'), { textContent: (n.name ? `${n.name}: ` : '') + tr(`studio.imp.n.${n.code}`, { detail: n.detail || '' }) })));
    return [h, ul];
  };
  const head = Object.assign(document.createElement('p'), { className: 'imp-head', textContent: tr('studio.imp.done', { scenes: r.stats.scenes, sources: r.stats.sources }) });
  $('imp-report').replaceChildren(head, ...section('converted', 'studio.imp.converted'), ...section('lost', 'studio.imp.lost'));
  $('imp-report').classList.remove('hidden');
}

function renderImport() {
  const obs = $('imp-pick').value.startsWith('obs:');
  show('imp-profile-row', obs && Boolean(importList && importList.profile));
  $('imp-go').disabled = imported;
}

const show = (id, on) => $(id).classList.toggle('hidden', !on);
const setCheck = (li, kind) => { li.className = kind; };

function renderProgress() {
  const ol = $('steps');
  ol.replaceChildren(...STEPS.map((_, n) => Object.assign(document.createElement('li'), { className: n < i ? 'done' : n === i ? 'current' : '' })));
  ol.setAttribute('aria-label', tr('onb.step', { n: i + 1, total: STEPS.length }));
}

function renderAccount() {
  const { signIn, user, reachable } = st;
  const waiting = signIn.status === 'waiting';
  show('account-done', Boolean(user));
  $('account-done').textContent = user ? tr('onb.account.done', { user }) : '';
  show('account-start', !user && !waiting);
  show('account-again', !user && waiting && Boolean(signIn.url));
  show('account-cancel', !user && waiting);
  show('account-waiting', !user && waiting);
  const err = signIn.status === 'error'
    ? tr(signIn.error === 'expired' ? 'signin.err.expired' : signIn.error === 'rate_limited' ? 'signin.err.rate_limited' : 'signin.err.generic')
    : !reachable && !user ? tr('signin.offline') : '';
  $('account-error').textContent = err;
  show('account-error', Boolean(err));
}

function renderObs() {
  const o = st.obs;
  const d = o.detect;
  const tri = (v) => (v === true ? 'ok' : v === false ? 'bad' : 'unknown');
  const rows = Object.fromEntries([...$('obs-checks').children].map((li) => [li.dataset.k, li]));
  setCheck(rows.installed, d ? (d.installed ? 'ok' : 'unknown') : 'wait');
  setCheck(rows.running, d ? tri(d.running) : 'wait');
  setCheck(rows.server, d ? tri(d.serverEnabled) : 'wait');
  setCheck(rows.connected, o.state === 'connected' ? 'ok' : o.state === 'connecting' ? 'wait' : 'bad');
  const hint = $('obs-hint');
  hint.textContent = tr(`obs.hint.${o.hint}`);
  hint.className = 'callout ' + (o.hint === 'connected' ? 'ok' : o.hint === 'checking' ? '' : 'warn');
  show('obs-steps', o.hint === 'server_disabled');
  show('obs-retry', o.state !== 'connected');
  ObsFix.render(st);
  const manual = manualOpen || o.mode === 'manual';
  show('obs-manual', manual);
  $('obs-toggle-manual').textContent = tr(manual ? 'onb.obs.hideManual' : 'onb.obs.manual');
  show('m-auto', o.mode === 'manual');
  if (!manualFilled) {
    manualFilled = true;
    $('m-host').value = o.host;
    $('m-port').value = String(o.port);
  }
  $('m-password').placeholder = o.hasPassword ? '••••••••' : '';
}

async function loadOverlays() {
  overlays = await shell.overlays().catch(() => []);
  const ul = $('ov-list');
  ul.replaceChildren(
    ...overlays.map((o) => {
      const li = document.createElement('li');
      const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: true, id: `ov-${o.id}` });
      const name = Object.assign(document.createElement('label'), { className: 'name', textContent: tr(`onb.overlay.${o.id}`) });
      name.htmlFor = cb.id;
      name.style.cssText = 'margin:0;text-transform:none;letter-spacing:normal;font-size:inherit;font-weight:inherit;color:inherit';
      const status = Object.assign(document.createElement('span'), { className: 'st', id: `ov-st-${o.id}` });
      li.append(cb, name, status);
      return li;
    }),
  );
}

async function loadScenes() {
  try {
    const { scenes, current } = await shell.obsScenes();
    const sel = $('ov-scene');
    const prev = sel.value;
    sel.replaceChildren(...scenes.map((s) => Object.assign(document.createElement('option'), { value: s, textContent: s })));
    sel.value = scenes.includes(prev) ? prev : current;
    scenesLoaded = true;
  } catch {
    scenesLoaded = false;
  }
}

function renderOverlays() {
  const connected = st.obs.state === 'connected';
  const hasList = overlays && overlays.length > 0;
  show('ov-need', !connected || !hasList);
  $('ov-need').textContent = tr(!connected ? 'onb.overlays.needObs' : 'onb.overlays.needAccount');
  $('ov-scene').disabled = !connected;
  $('ov-install').disabled = !connected || !scenesLoaded || !hasList || installing;
  if (connected && !scenesLoaded) void loadScenes().then(render);
  if (!connected) scenesLoaded = false;
}

function renderDone() {
  const account = [st.user ? 'ok' : 'unknown', st.user ? tr('onb.account.done', { user: st.user }) : tr('onb.done.noAccount')];
  const rows =
    st.engine && st.engine.available && st.engine.mode === 'studio'
      ? [account, [st.engine.running ? 'ok' : 'unknown', tr('onb.done.studio')]]
      : [
          account,
          [st.obs.state === 'connected' ? 'ok' : 'unknown', tr(st.obs.state === 'connected' ? 'onb.obs.check.connected' : 'onb.done.noObs')],
          [installedCount > 0 ? 'ok' : 'unknown', installedCount > 0 ? tr('onb.done.overlays', { n: installedCount }) : tr('onb.done.noOverlays')],
        ];
  $('done-list').replaceChildren(
    ...rows.map(([kind, text]) => {
      const li = document.createElement('li');
      li.className = kind;
      li.append(Object.assign(document.createElement('span'), { className: 'mark' }), Object.assign(document.createElement('span'), { textContent: text }));
      return li;
    }),
  );
}

function renderEngine() {
  for (const r of document.querySelectorAll('input[name="engine"]')) r.checked = r.value === st.engine.mode;
}

function render() {
  if (!st) return;
  syncSteps();
  const step = STEPS[i];
  renderProgress();
  for (const s of STEPS) $(`s-${s}`).classList.toggle('active', s === step);
  if (step === 'account') renderAccount();
  if (step === 'engine') renderEngine();
  if (step === 'import') renderImport();
  if (step === 'obs') renderObs();
  if (step === 'overlays') renderOverlays();
  if (step === 'done') renderDone();

  const last = step === 'done';
  const satisfied = step === 'account' ? Boolean(st.user) : step === 'obs' ? st.obs.state === 'connected' : true;
  $('back').style.visibility = i === 0 || last ? 'hidden' : 'visible';
  show('skip', !satisfied && (step === 'account' || step === 'obs'));
  $('next').textContent = tr(i === 0 ? 'onb.welcome.cta' : last ? 'onb.done.cta' : 'onb.next');
  $('next').disabled = (step === 'account' || step === 'obs') && !satisfied;
  if (step === 'overlays') $('next').disabled = installing;
}

function go(to) {
  i = Math.max(0, Math.min(STEPS.length - 1, to));
  if (STEPS[i] === 'overlays') void loadOverlays().then(render);
  render();
}

if (shell) {
  $('next').onclick = () => (STEPS[i] === 'done' ? shell.finishOnboarding() : go(i + 1));
  $('skip').onclick = () => go(i + 1);
  $('back').onclick = () => go(i - 1);
  for (const r of document.querySelectorAll('input[name="engine"]')) {
    r.onchange = async () => {
      st = await shell.setPrefs({ engine: r.value });
      render();
      void loadImportList();
    };
  }
  $('imp-pick').onchange = renderImport;
  $('imp-go').onclick = async () => {
    $('imp-go').disabled = true;
    // A new install has nothing to lose yet: no confirmation, the starter scenes are kept as the backup anyway.
    const r = await shell.studio({ op: 'import', value: { id: $('imp-pick').value, profile: $('imp-profile').checked && !$('imp-profile-row').classList.contains('hidden'), key: false } });
    if (!r || r.error || !r.report) {
      $('imp-msg').textContent = tr(r && r.error === 'studio_busy' ? 'studio.imp.err.busy' : 'studio.imp.err.read');
      $('imp-msg').className = 'status bad';
      $('imp-go').disabled = false;
      return;
    }
    imported = true;
    $('imp-msg').className = 'status hidden';
    renderImportReport(r.report);
    render();
  };

  $('account-start').onclick = () => shell.signIn();
  $('account-cancel').onclick = () => shell.cancelSignIn();
  $('account-again').onclick = () => st?.signIn.url && shell.openExternal(st.signIn.url);

  $('obs-retry').onclick = () => shell.obsRetry();
  $('obs-toggle-manual').onclick = () => { manualOpen = !(manualOpen || st.obs.mode === 'manual'); render(); };
  $('m-save').onclick = async () => {
    st = await shell.saveObs({ mode: 'manual', host: $('m-host').value.trim() || '127.0.0.1', port: Number($('m-port').value) || 4455, password: $('m-password').value });
    $('m-password').value = '';
    render();
  };
  $('m-auto').onclick = async () => {
    manualOpen = false;
    st = await shell.saveObs({ mode: 'auto' });
    render();
  };

  $('ov-install').onclick = async () => {
    installing = true;
    $('ov-msg').textContent = '';
    render();
    const scene = $('ov-scene').value;
    let ok = 0;
    for (const o of overlays) {
      if (!$(`ov-${o.id}`).checked) continue;
      const cell = $(`ov-st-${o.id}`);
      cell.className = 'st';
      cell.textContent = '…';
      try {
        const r = await shell.obsInstall({ scene, name: o.name, url: o.url });
        cell.textContent = tr(`onb.status.${r}`);
        cell.className = 'st ok';
        ok += 1;
      } catch {
        cell.textContent = tr('onb.status.error');
        cell.className = 'st bad';
      }
    }
    installedCount += ok;
    installing = false;
    $('ov-msg').textContent = ok ? tr('onb.overlays.done', { n: ok, scene }) : '';
    $('ov-msg').className = 'status ok';
    render();
  };

  shell.onState((s) => {
    st = s;
    // Signing in on the account step moves on by itself once the browser round-trip completes.
    if (STEPS[i] === 'account' && s.user && !wasSignedIn) setTimeout(() => STEPS[i] === 'account' && go(i + 1), 900);
    wasSignedIn = Boolean(s.user);
    render();
  });
  shell.getState().then((s) => {
    setTimeout(() => void loadImportList(), 0);
    st = s;
    wasSignedIn = Boolean(s.user);
    render();
  });
}
