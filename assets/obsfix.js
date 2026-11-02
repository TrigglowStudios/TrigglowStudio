// "Fix it for me" for the OBS hint, shared by the onboarding and the settings panel.
// Needs #fix, #fix-btn, #fix-confirm, #fix-yes, #fix-no, #fix-msg in the page; the page calls ObsFix.render(state) on every update.
(() => {
  const $ = (id) => document.getElementById(id);
  const shell = window.trigglowShell;
  let busy = false;
  let confirming = false;
  let last = null;

  const say = (text, cls = '') => {
    $('fix-msg').textContent = text;
    $('fix-msg').className = 'status ' + cls;
  };

  function render(s) {
    last = s;
    const o = s.obs;
    // Only automatic setups: a manual one is the user's own business. Offer the action that matches the diagnosis.
    const kind = o.mode !== 'auto' || o.state === 'connected' ? null : o.hint === 'not_running' ? 'open' : o.hint === 'server_disabled' ? 'enable' : null;
    if (o.state === 'connected' && !busy) say('');
    $('fix').classList.toggle('hidden', !kind);
    if (kind === 'open') $('fix-btn').textContent = tr(o.detect && o.detect.serverEnabled === false ? 'fix.enableOpen' : 'fix.open');
    if (kind === 'enable') $('fix-btn').textContent = tr('fix.enable');
    $('fix-btn').classList.toggle('hidden', confirming);
    $('fix-btn').disabled = busy;
    $('fix-yes').disabled = busy;
    $('fix-confirm').classList.toggle('hidden', !(kind === 'enable' && confirming));
  }

  async function run(confirmRestart) {
    busy = true;
    render(last);
    try {
      const r = await shell.obsFix(confirmRestart);
      if (r === 'needs_restart') {
        confirming = true; // ask before touching a running OBS
        say('');
      } else {
        confirming = false;
        say(tr('fix.result.' + r), r === 'close_failed' || r === 'no_obs_found' ? 'bad' : 'ok');
      }
    } catch {
      confirming = false;
      say(tr('fix.result.error'), 'bad');
    } finally {
      busy = false;
      render(last);
    }
  }

  if (shell) {
    $('fix-btn').onclick = () => run(false);
    $('fix-yes').onclick = () => run(true);
    $('fix-no').onclick = () => {
      confirming = false;
      render(last);
    };
  }
  window.ObsFix = { render };
})();
