// "Instant clip" settings card — ONE implementation shared by the settings panel and the Clips page panel.
// Host page needs `<section class="card" id="clipCard"></section>`, i18n.js loaded first, then ClipCard.init(el)
// and ClipCard.render(state) on every state update.
(() => {
  const shell = window.trigglowShell;

  const TEMPLATE = `
    <h2 data-i18n="clip.title"></h2>
    <p class="hint intro" id="clipHint" data-i18n="clip.hint"></p>
    <label class="switch">
      <span><span data-i18n="clip.enable"></span></span>
      <input id="clipEnabled" type="checkbox">
    </label>
    <div id="clipBody">
      <div class="cc-col">
        <div class="label"><span data-i18n="clip.auto"></span></div>
        <select id="autoHighlights">
          <option value="off" data-i18n="clip.auto.off"></option>
          <option value="low" data-i18n="clip.auto.low"></option>
          <option value="medium" data-i18n="clip.auto.medium"></option>
          <option value="high" data-i18n="clip.auto.high"></option>
        </select>
        <p class="hint" data-i18n="clip.auto.hint"></p>
      </div>
      <label class="switch">
        <span><span data-i18n="clip.game"></span></span>
        <input id="gameHighlights" type="checkbox">
      </label>
      <div class="cc-col" id="gameDirRow">
        <input id="gameHighlightsDir" type="text" maxlength="500">
        <p class="hint" data-i18n="clip.game.hint"></p>
      </div>
      <div class="cc-col">
        <div class="label"><span data-i18n="clip.uploadMode"></span></div>
        <select id="clipUploadMode">
          <option value="now" data-i18n="clip.uploadMode.now"></option>
          <option value="after_stream" data-i18n="clip.uploadMode.afterStream"></option>
        </select>
        <p class="hint" data-i18n="clip.uploadMode.hint"></p>
        <p id="deferredCount" class="hint hidden"></p>
      </div>
      <div class="cc-grid">
        <div class="cc-col">
          <div class="label"><span data-i18n="clip.quality"></span></div>
          <select id="clipQuality">
            <option value="source" data-i18n="clip.quality.source"></option>
            <option value="1080p">1080p</option>
            <option value="720p">720p</option>
          </select>
          <p class="hint" data-i18n="clip.quality.hint"></p>
        </div>
        <div class="cc-col">
          <div class="label"><span data-i18n="clip.visibility"></span></div>
          <select id="clipVisibility">
            <option value="private" data-i18n="clip.visibility.private"></option>
            <option value="unlisted" data-i18n="clip.visibility.unlisted"></option>
            <option value="public" data-i18n="clip.visibility.public"></option>
          </select>
        </div>
      </div>
      <div class="cc-col">
        <div class="label"><span data-i18n="clip.titleTpl"></span></div>
        <input id="clipTitle" type="text" maxlength="100">
        <p class="hint" data-i18n="clip.titleTpl.hint"></p>
      </div>
      <label class="switch">
        <span><span data-i18n="clip.announce"></span></span>
        <input id="clipAnnounce" type="checkbox">
      </label>
      <div class="cc-col" id="announceTextRow">
        <input id="clipAnnounceText" type="text" maxlength="200">
        <p class="hint" data-i18n="clip.announce.hint"></p>
      </div>
      <div class="cc-grid">
        <div class="cc-col">
          <div class="label len-label"><span data-i18n="clip.length"></span><span id="lenValue" class="len-value"></span></div>
          <input id="lenRange" type="range" min="10" max="60" step="5">
          <p id="lenHint" class="hint"></p>
          <button id="seePlus" class="link hidden" data-i18n="clip.len.seePlus"></button>
          <p id="lenMsg" class="status" role="status"></p>
        </div>
        <div class="cc-col">
          <div class="label"><span data-i18n="clip.hotkey"></span></div>
          <button id="hotkey" class="keycap" type="button"></button>
          <p id="hotkeyMsg" class="status bad"></p>
        </div>
      </div>
      <div id="replayConfirm" class="callout warn hidden">
        <span data-i18n="fix.confirm"></span>
        <div class="actions left">
          <button id="replayYes" class="primary" data-i18n="fix.yes"></button>
          <button id="replayNo" data-i18n="fix.no"></button>
        </div>
      </div>
      <div class="cc-foot">
        <p class="status"><span class="dot" id="replayDot"></span><span id="replayText"></span></p>
        <div class="actions">
          <button id="replayStart" class="hidden" data-i18n="clip.replay.fix"></button>
          <button id="clipNow" class="primary" data-i18n="clip.now"></button>
        </div>
      </div>
      <p id="clipMsg" class="status" role="status"></p>
    </div>`;

  const $ = (id) => document.getElementById(id);
  let last = null;
  let capturing = false;
  let replayConfirming = false;
  let replayBusy = false;
  let dragging = false;

  const fmt = (n) => (n >= 60 ? `${Math.floor(n / 60)} min${n % 60 ? ` ${n % 60} s` : ''}` : `${n} s`);
  const pretty = (acc) => acc.replace('CommandOrControl', navigator.platform.includes('Mac') ? '⌘' : 'Ctrl').replaceAll('+', ' + ');

  // KeyboardEvent → Electron accelerator ("CommandOrControl+Alt+C"); null until a real combination is pressed.
  function keyName(code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^F\d{1,2}$/.test(code)) return code;
    return { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Space: 'Space', Enter: 'Enter', Tab: 'Tab', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Delete: 'Delete', Minus: 'Minus', Equal: 'Equal' }[code] ?? null;
  }
  function toAccelerator(e) {
    const key = keyName(e.code);
    if (!key) return null;
    const mods = [];
    if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (!mods.length || (mods.length === 1 && mods[0] === 'Shift' && !/^F\d/.test(key))) return null;
    return [...mods, key].join('+');
  }

  function render(s) {
    if (!$('clipEnabled')) return; // not initialised on this page
    last = s;
    const c = s.clip;
    $('clipEnabled').checked = c.enabled;
    $('clipBody').classList.toggle('hidden', !c.enabled);
    $('autoHighlights').value = c.autoHighlights;
    $('clipUploadMode').value = c.uploadMode;
    $('clipQuality').value = c.quality;
    $('clipVisibility').value = c.visibility;
    // don't overwrite what the user is typing
    if (document.activeElement !== $('clipTitle')) $('clipTitle').value = c.title;
    $('gameHighlights').checked = c.gameHighlights;
    $('gameDirRow').classList.toggle('hidden', !c.gameHighlights);
    $('gameHighlightsDir').placeholder = c.gameHighlightsDefaultDir;
    if (document.activeElement !== $('gameHighlightsDir')) $('gameHighlightsDir').value = c.gameHighlightsDir;
    $('clipAnnounce').checked = c.announce;
    $('announceTextRow').classList.toggle('hidden', !c.announce);
    if (document.activeElement !== $('clipAnnounceText')) $('clipAnnounceText').value = c.announceText;
    $('deferredCount').classList.toggle('hidden', !c.deferredCount);
    $('deferredCount').textContent = c.deferredCount ? tr('clip.uploadMode.pending', { count: c.deferredCount }) : '';
    // clip length: capped by the plan (the server enforces the same limit on every upload path)
    const len = $('lenRange');
    len.min = String(c.minSeconds);
    len.max = String(c.maxSeconds);
    if (!dragging) len.value = String(Math.min(c.maxSeconds, c.seconds ?? 30));
    $('lenValue').textContent = fmt(Number(len.value));
    $('lenHint').textContent = tr(c.isPlus ? 'clip.len.plusHint' : 'clip.len.freeHint', { max: fmt(c.maxSeconds), plusMax: fmt(c.plusMaxSeconds) });
    $('seePlus').classList.toggle('hidden', c.isPlus);
    // With Trigglow Studio the replay buffer is the app's own: no OBS in the texts.
    const studio = s.engine && s.engine.running;
    $('lenMsg').textContent = c.lengthStatus ? tr('clip.len.' + c.lengthStatus + (studio && c.lengthStatus === 'applied' ? 'Studio' : '')) : '';
    $('lenMsg').className = 'status ' + (c.lengthStatus === 'failed' ? 'bad' : c.lengthStatus ? 'ok' : '');
    if (c.seconds && c.seconds > c.maxSeconds) $('lenHint').textContent = tr('clip.len.over', { max: fmt(c.maxSeconds) });
    $('hotkey').textContent = capturing ? tr('clip.press') : pretty(c.hotkey);
    $('hotkey').classList.toggle('capturing', capturing);
    $('hotkeyMsg').textContent = !capturing && (c.hotkeyStatus === 'in_use' || c.hotkeyStatus === 'invalid') ? tr('clip.hk.' + c.hotkeyStatus) : '';
    $('clipHint').textContent = tr(studio ? 'clip.hintStudio' : 'clip.hint');
    const connected = studio || s.obs.state === 'connected';
    const replay = !connected || c.replayActive === null ? 'unknown' : c.replayActive ? 'on' : 'off';
    $('replayText').textContent = tr('clip.replay.' + replay);
    $('replayDot').className = 'dot ' + (replay === 'on' ? 'ok' : replay === 'off' ? 'bad' : '');
    $('replayStart').classList.toggle('hidden', replay !== 'off' || replayConfirming);
    $('replayStart').disabled = replayBusy;
    $('replayYes').disabled = replayBusy;
    $('replayConfirm').classList.toggle('hidden', !(replay === 'off' && replayConfirming));
    $('clipNow').disabled = c.busy || !connected;
  }

  const refresh = () => shell.getState().then(render, () => undefined);

  // Turn the Replay Buffer on for the user: live if it only idles, otherwise via OBS's profile (restart, confirmed).
  async function replayFix(confirmRestart) {
    replayBusy = true;
    render(last);
    const say = (text, cls) => {
      $('clipMsg').textContent = text;
      $('clipMsg').className = 'status ' + cls;
    };
    try {
      const r = await shell.replayFix(confirmRestart);
      if (r === 'needs_restart') {
        replayConfirming = true; // OBS has to restart to apply it: ask first
        say('', '');
      } else {
        replayConfirming = false;
        say(tr('clip.fix.' + r), r === 'started' || r === 'restarted' || r === 'enabled_and_launched' ? 'ok' : 'bad');
      }
    } catch {
      replayConfirming = false;
      say(tr('clip.fix.error'), 'bad');
    } finally {
      replayBusy = false;
      refresh();
    }
  }

  function init(root) {
    root.innerHTML = TEMPLATE;
    for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = tr(el.dataset.i18n);
    if (!shell) return;

    $('lenRange').oninput = (e) => {
      dragging = true;
      $('lenValue').textContent = fmt(Number(e.target.value));
    };
    $('lenRange').onchange = async (e) => {
      const st = await shell.setPrefs({ clipSeconds: Number(e.target.value) });
      dragging = false;
      render(st);
    };
    $('seePlus').onclick = () => shell.nav('billing');
    $('autoHighlights').onchange = (e) => shell.setPrefs({ autoHighlights: e.target.value }).then(render);
    $('clipUploadMode').onchange = (e) => shell.setPrefs({ clipUploadMode: e.target.value }).then(render);
    $('clipQuality').onchange = (e) => shell.setPrefs({ clipQuality: e.target.value }).then(render);
    $('clipVisibility').onchange = (e) => shell.setPrefs({ clipVisibility: e.target.value }).then(render);
    $('clipTitle').onchange = (e) => shell.setPrefs({ clipTitle: e.target.value }).then(render);
    $('clipAnnounce').onchange = (e) => shell.setPrefs({ clipAnnounce: e.target.checked }).then(render);
    $('clipAnnounceText').onchange = (e) => shell.setPrefs({ clipAnnounceText: e.target.value }).then(render);
    $('clipAnnounceText').placeholder = tr('clip.announce.placeholder');
    $('gameHighlights').onchange = (e) => shell.setPrefs({ gameHighlights: e.target.checked }).then(render);
    $('gameHighlightsDir').onchange = (e) => shell.setPrefs({ gameHighlightsDir: e.target.value }).then(render);
    $('clipEnabled').onchange = (e) => shell.setPrefs({ clipEnabled: e.target.checked }).then(render);
    $('replayStart').onclick = () => replayFix(false);
    $('replayYes').onclick = () => replayFix(true);
    $('replayNo').onclick = () => {
      replayConfirming = false;
      render(last);
    };
    $('clipNow').onclick = () => {
      $('clipMsg').textContent = tr('clip.now.started');
      $('clipMsg').className = 'status ok';
      shell.clipNow().then(refresh);
    };

    const stopCapture = () => {
      if (!capturing) return;
      capturing = false;
      shell.hotkeyCapture(false);
      render(last);
    };
    $('hotkey').onclick = () => {
      capturing = true;
      shell.hotkeyCapture(true); // unregister the current global shortcut while recording
      render(last);
    };
    $('hotkey').onblur = stopCapture;
    window.addEventListener('keydown', (e) => {
      if (!capturing) return;
      e.preventDefault();
      if (e.key === 'Escape') return stopCapture();
      const acc = toAccelerator(e);
      if (!acc) return; // keep waiting for a full combination
      capturing = false;
      shell.setPrefs({ clipHotkey: acc }).then((st) => {
        shell.hotkeyCapture(false); // re-registers whatever is now configured
        render(st);
      });
    });
  }

  window.ClipCard = { init, render, refresh };
})();
