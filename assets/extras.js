// Settings panel extras: overlay hotkeys and the notifications test. Runs beside settings.js with its own refresh.
// (OBS text sources live in their own tool page: text-sources.html.)
(() => {
  const $ = (id) => document.getElementById(id);
  const shell = window.trigglowShell;
  if (!shell) return;
  const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids);
    return node;
  };
  // Two families, shown as two groups with the same colour cue as their Stream Deck keys:
  // alerts (cyan → magenta) and song requests (coral → amber, music note).
  const GROUPS = [
    { id: 'alerts', actions: ['skip', 'toggle-mute', 'toggle-pause', 'clear', 'repeat'] },
    {
      id: 'music',
      actions: ['music-skip', 'music-toggle-pause', 'music-volume-up', 'music-volume-down', 'music-clear', 'music-toggle-requests'],
    },
  ];
  const ACTIONS = GROUPS.flatMap((g) => g.actions);
  let state = null;
  let capturing = null;

  /* ---------------- overlay hotkeys ---------------- */
  const hk = {};
  const groupOf = (action) => GROUPS.find((g) => g.actions.includes(action)).id;
  for (const action of ACTIONS) {
    const group = groupOf(action);
    if (GROUPS.find((g) => g.id === group).actions[0] === action) {
      $('ctlList').append(
        el('li', { className: `hk-group hk-group-${group}` }, el('span', { className: 'hk-swatch', ariaHidden: 'true' }), tr(`ctl.group.${group}`)),
      );
    }
    const name = el('span', { className: 'hk-name', textContent: tr(`ctl.${action}`) });
    const key = el('button', { className: 'keycap', type: 'button' });
    const clear = el('button', { className: 'link', type: 'button', textContent: tr('ctl.remove') });
    const msg = el('span', { className: 'status bad hk-msg' });
    key.onclick = () => {
      capturing = action;
      shell.hotkeyCapture(true); // the OS would swallow the keys while the current shortcuts are registered
      render();
    };
    key.onblur = () => stopCapture();
    clear.onclick = () => saveHotkey(action, null);
    $('ctlList').append(el('li', { className: `hk-row hk-row-${group}` }, name, key, clear, msg));
    hk[action] = { key, clear, msg };
  }

  const hotkeys = () => state?.controls.hotkeys ?? {};
  async function saveHotkey(action, accelerator) {
    const next = { ...hotkeys() };
    if (accelerator) next[action] = accelerator;
    else delete next[action];
    setState(await shell.setPrefs({ controlHotkeys: next }));
  }
  function stopCapture() {
    if (capturing === null) return;
    capturing = null;
    shell.hotkeyCapture(false); // re-registers whatever is configured
    render();
  }
  window.addEventListener('keydown', (e) => {
    if (capturing === null) return;
    e.preventDefault();
    if (e.key === 'Escape') return stopCapture();
    const accelerator = HK.toAccelerator(e);
    if (!accelerator) return; // keep waiting for a full combination
    const action = capturing;
    capturing = null;
    saveHotkey(action, accelerator).then(() => shell.hotkeyCapture(false));
  });

  /* ---------------- notifications ---------------- */
  $('notifTest').onclick = async () => {
    await shell.notifyTest();
    $('notifMsg').textContent = tr('notif.sent');
    $('notifMsg').className = 'status ok';
  };

  /* ---------------- render loop ---------------- */
  function render() {
    if (!state) return;
    for (const action of ACTIONS) {
      const accelerator = hotkeys()[action];
      const r = hk[action];
      r.key.textContent = capturing === action ? tr('clip.press') : accelerator ? HK.pretty(accelerator) : tr('ctl.unset');
      r.key.classList.toggle('capturing', capturing === action);
      r.clear.classList.toggle('hidden', !accelerator);
      r.msg.textContent = state.controls.status[action] === 'in_use' && capturing !== action ? tr('clip.hk.in_use') : '';
    }
    try {
      $('notifLink').href = new URL('/app/settings?tab=notifications', state.webUrl).href;
    } catch {
      /* dev URL without a valid origin */
    }
  }
  function setState(s) {
    state = s;
    render();
  }
  const refresh = () => shell.getState().then(setState, () => undefined);
  refresh();
  setInterval(() => !document.hidden && refresh(), 2000);
})();
