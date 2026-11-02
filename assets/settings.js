const $ = (id) => document.getElementById(id);
const shell = window.trigglowShell;
let filled = false;
let manualUi = false; // showing the manual fields (committed only on Save)

function render(s) {
  const o = s.obs;
  // Never the raw socket error (ECONNREFUSED…): the callout below explains it in plain words; the detail stays in the tooltip.
  $('obsStatus').textContent = tr(`settings.obs.${o.state === 'error' ? 'disconnected' : o.state}`);
  $('obsStatus').title = o.state === 'error' ? o.error ?? '' : '';
  $('obsDot').className = 'dot ' + (o.state === 'connected' ? 'ok' : o.state === 'error' ? 'bad' : '');
  $('obsTabDot').classList.toggle('hidden', o.state === 'connected');
  $('serverStatus').textContent = tr(s.server ? 'settings.server.on' : 'settings.server.off');
  $('serverDot').className = 'dot ' + (s.server ? 'ok' : 'bad');

  const box = $('obsHintBox');
  box.textContent = tr(`obs.hint.${o.hint}`);
  box.className = 'callout ' + (o.hint === 'connected' ? 'ok' : o.hint === 'checking' ? '' : 'warn');
  $('retry').classList.toggle('hidden', o.state === 'connected');
  ObsFix.render(s);

  const manual = manualUi || o.mode === 'manual';
  $('mode-auto').checked = !manual;
  $('mode-manual').checked = manual;
  $('manual').classList.toggle('hidden', !manual);
  if (!filled) {
    filled = true;
    $('host').value = o.host;
    $('port').value = String(o.port);
  }
  $('password').placeholder = o.hasPassword ? '••••••••' : '';

  ClipCard.render(s);
  window.UpdateCard?.render(s);
  // One engine at a time: with Trigglow Studio nothing about OBS shows (its tab, status chip), with OBS nothing about
  // Studio. Clips work with both. The choice itself lives in General, reachable from both.
  const e = s.engine;
  const studioMode = e.available && e.mode === 'studio';
  $('engineCard').classList.toggle('hidden', !e.available);
  $('studioTab').classList.toggle('hidden', !studioMode);
  $('obsTab').classList.toggle('hidden', studioMode);
  $('obsChip').classList.toggle('hidden', studioMode);
  $('closeToTrayHint').textContent = tr(studioMode ? 'settings.closeToTrayHintStudio' : 'settings.closeToTrayHint');
  $('studioCards').classList.toggle('hidden', !e.running);
  if (e.running && !studioLoaded) void loadStudio();
  syncTabs();
  for (const r of document.querySelectorAll('input[name="engine"]')) r.checked = r.value === e.mode;
  $('engineRestart').classList.toggle('hidden', !e.restart);
  $('engineRestartText').textContent = tr(e.live ? 'settings.engine.restartLive' : 'settings.engine.restart');
  $('engineRestartBtn').disabled = e.live;
  $('closeToTray').checked = s.prefs.closeToTray;
  $('openObsOnLaunch').checked = s.prefs.openObsOnLaunch;
  $('lolDetect').checked = s.prefs.lolDetect;
  $('openAtLogin').checked = s.prefs.openAtLogin;
  $('openAtLogin').disabled = !s.prefs.autoStartSupported;
  $('openAtLoginHint').textContent = tr('settings.openAtLoginHint');
  $('openAtLoginHint').classList.toggle('hidden', s.prefs.autoStartSupported);
  $('version').textContent = tr('settings.version', { version: s.version });
}

// Section tabs; the last one picked is remembered (best effort — storage can be unavailable).
function showTab(id) {
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === id));
  for (const p of document.querySelectorAll('[data-pane]')) p.classList.toggle('hidden', p.dataset.pane !== id);
  try {
    localStorage.setItem('trigglow.settingsTab', id);
  } catch {}
}
for (const b of document.querySelectorAll('[data-tab]')) b.onclick = () => showTab(b.dataset.tab);
/** A hidden tab (the other engine's) can't stay open: fall back to the first visible one. */
function syncTabs() {
  const current = document.querySelector('[data-tab][aria-selected="true"]');
  if (current && !current.classList.contains('hidden')) return;
  const first = [...document.querySelectorAll('[data-tab]')].find((b) => !b.classList.contains('hidden'));
  if (first) showTab(first.dataset.tab);
}
let savedTab = null;
try {
  savedTab = localStorage.getItem('trigglow.settingsTab');
} catch {}
showTab(document.querySelector(`[data-tab="${savedTab}"]`) ? savedTab : 'obs');

if (shell) {
  ClipCard.init(document.getElementById('clipCard'));
  $('mode-auto').onchange = async () => {
    manualUi = false;
    render(await shell.saveObs({ mode: 'auto' }));
  };
  $('mode-manual').onchange = () => {
    manualUi = true;
    refresh();
  };
  // Manual OBS connection saves itself once the fields have been still for a moment.
  let saveTimer;
  const commit = async () => {
    const port = Number($('port').value);
    if (!(port >= 1 && port <= 65535)) return; // still typing
    const password = $('password').value;
    render(await shell.saveObs({ mode: 'manual', host: $('host').value.trim() || '127.0.0.1', port, password }));
    if ($('password').value === password) $('password').value = '';
  };
  for (const id of ['host', 'port', 'password']) {
    $(id).addEventListener('input', () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(commit, 800);
    });
  }
  $('retry').onclick = () => shell.obsRetry();
  $('rerun').onclick = () => shell.restartOnboarding();
  $('openObsOnLaunch').onchange = (e) => shell.setPrefs({ openObsOnLaunch: e.target.checked });
  $('lolDetect').onchange = (e) => shell.setPrefs({ lolDetect: e.target.checked });
  $('closeToTray').onchange = (e) => shell.setPrefs({ closeToTray: e.target.checked });
  for (const r of document.querySelectorAll('input[name="engine"]')) r.onchange = () => shell.setPrefs({ engine: r.value }).then(render);
  $('engineRestartBtn').onclick = () => shell.relaunch();
  $('openAtLogin').onchange = (e) => shell.setPrefs({ openAtLogin: e.target.checked });
  // Framed inside the web page, so main's push events don't reach us — refresh the status while visible.
  const refresh = () => shell.getState().then(render, () => undefined);
  refresh();
  setInterval(() => !document.hidden && refresh(), 2000);
}

/* ------------------------- Settings → Trigglow Studio ------------------------- */

const ENCODER_NAMES = { obs_nvenc_h264_tex: 'NVIDIA NVENC H.264', jim_nvenc: 'NVIDIA NVENC H.264 (legacy)', h264_texture_amf: 'AMD AMF H.264', amd_amf_h264: 'AMD AMF H.264 (legacy)', obs_qsv11_v2: 'Intel Quick Sync H.264', obs_qsv11: 'Intel Quick Sync H.264 (legacy)', obs_x264: 'x264 (CPU)', obs_nvenc_hevc_tex: 'NVIDIA NVENC HEVC', jim_hevc_nvenc: 'NVIDIA NVENC HEVC (legacy)', h265_texture_amf: 'AMD AMF HEVC', obs_qsv11_hevc: 'Intel Quick Sync HEVC', obs_nvenc_av1_tex: 'NVIDIA NVENC AV1', jim_av1_nvenc: 'NVIDIA NVENC AV1 (legacy)', av1_texture_amf: 'AMD AMF AV1', obs_qsv11_av1: 'Intel Quick Sync AV1', obs_x265: 'x265 (CPU)', ffmpeg_svt_av1: 'SVT-AV1 (CPU)', ffmpeg_aom_av1: 'AOM AV1 (CPU)' };
const PLATFORM_NAMES = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick', tiktok: 'TikTok' };
let studioLoaded = false;
let keyServers = {};

/** Twitch and YouTube have one ingest server: shown, not asked. The rest come with their own (pasted). */
function syncKeyServer() {
  const fixed = keyServers[$('stKeyPlatform').value];
  $('stKeyServerRow').classList.toggle('hidden', Boolean(fixed));
  $('stKeyServerFixed').classList.toggle('hidden', !fixed);
  $('stKeyServerFixed').textContent = fixed ? tr('studio.keyServerFixed', { server: fixed }) : '';
}

async function saveStudioOp(req) {
  const r = await shell.studio(req);
  if (r && r.settings) renderStudio(r);
  return r;
}

function fill(id, entries, value) {
  $(id).replaceChildren(...entries.map(([v, text]) => Object.assign(document.createElement('option'), { value: String(v), textContent: text, selected: String(v) === String(value) })));
}

/* Studio's two global shortcuts, captured like the overlay ones (Hotkeys tab): click the key, press the combination. */
const STUDIO_HOTKEYS = [['hotkeyStream', 'studio.hkStream'], ['hotkeyRecord', 'studio.hkRecord'], ['hotkeyDelay', 'studio.hkDelay']];
let studioHotkeys = { hotkeyStream: '', hotkeyRecord: '', hotkeyDelay: '' };
let studioCapturing = null;
const studioKeys = {};
for (const [field, label] of STUDIO_HOTKEYS) {
  const key = Object.assign(document.createElement('button'), { className: 'keycap', type: 'button' });
  const clear = Object.assign(document.createElement('button'), { className: 'link', type: 'button', textContent: tr('ctl.remove') });
  key.onclick = () => {
    studioCapturing = field;
    shell.hotkeyCapture(true); // the OS would swallow the keys while the current shortcuts are registered
    renderStudioHotkeys();
  };
  key.onblur = () => stopStudioCapture();
  clear.onclick = () => saveStudio({ [field]: '' });
  const li = document.createElement('li');
  li.className = 'hk-row';
  li.append(Object.assign(document.createElement('span'), { className: 'hk-name', textContent: tr(label) }), key, clear);
  $('stHotkeys').append(li);
  studioKeys[field] = { key, clear };
}
function renderStudioHotkeys() {
  for (const [field] of STUDIO_HOTKEYS) {
    const acc = studioHotkeys[field];
    const r = studioKeys[field];
    r.key.textContent = studioCapturing === field ? tr('clip.press') : acc ? HK.pretty(acc) : tr('ctl.unset');
    r.key.classList.toggle('capturing', studioCapturing === field);
    r.clear.classList.toggle('hidden', !acc);
  }
}
function stopStudioCapture() {
  if (studioCapturing === null) return;
  studioCapturing = null;
  shell.hotkeyCapture(false);
  renderStudioHotkeys();
}
/* The collection's shortcuts (OBS's Settings → Hotkeys for scenes and sources): switch to a scene, show or hide an
   item, mute or unmute, and keys to hold (push to talk / push to mute; those take a single key or a mouse side button). */
let hkTargets = null;
let hkCapturing = null; // { key, held }
async function loadHkTargets() {
  const r = await shell.studio({ op: 'hotkey-targets' });
  hkTargets = (r && r.hotkeys) || null;
  renderHkTargets();
}
function hkRow(label, key, held) {
  const acc = hkTargets.values[key];
  const cap = Object.assign(document.createElement('button'), { className: 'keycap' + (hkCapturing?.key === key ? ' capturing' : ''), type: 'button' });
  cap.textContent = hkCapturing?.key === key ? tr(held ? 'studio.hk.pressHold' : 'clip.press') : acc ? HK.pretty(acc) : tr('ctl.unset');
  cap.onclick = () => {
    hkCapturing = { key, held };
    shell.hotkeyCapture(true);
    renderHkTargets();
  };
  cap.onblur = () => setTimeout(() => hkCapturing?.key === key && stopHkCapture(), 150);
  const clear = Object.assign(document.createElement('button'), { className: 'link' + (acc ? '' : ' hidden'), type: 'button', textContent: tr('ctl.remove') });
  clear.onclick = () => setHk(key, '');
  const li = Object.assign(document.createElement('li'), { className: 'hk-row' });
  li.append(Object.assign(document.createElement('span'), { className: 'hk-name', textContent: label }), cap, clear);
  return li;
}
function renderHkTargets() {
  const box = $('stHkTargets');
  if (!hkTargets) return box.replaceChildren();
  const ul = (rows) => {
    const u = Object.assign(document.createElement('ul'), { className: 'plain' });
    u.append(...rows);
    return u;
  };
  const h3 = (text) => Object.assign(document.createElement('h3'), { className: 'sub', textContent: text });
  const fold = (title, rows) => {
    const d = document.createElement('details');
    d.append(Object.assign(document.createElement('summary'), { textContent: title }), ul(rows));
    return d;
  };
  box.replaceChildren(
    h3(tr('studio.hk.scenes')),
    ul(hkTargets.scenes.map((sc) => hkRow(tr('studio.hk.switch', { name: sc.name }), sc.key, false))),
    h3(tr('studio.hk.items')),
    ...hkTargets.scenes.filter((sc) => sc.items.length).map((sc) => fold(sc.name, sc.items.flatMap((it) => [hkRow(tr('studio.hk.show', { name: it.label }), it.show, false), hkRow(tr('studio.hk.hide', { name: it.label }), it.hide, false)]))),
    h3(tr('studio.hk.audio')),
    ...hkTargets.audio.map((a) => fold(a.name, [hkRow(tr('studio.hk.mute'), a.mute, false), hkRow(tr('studio.hk.unmute'), a.unmute, false), hkRow(tr('studio.hk.ptt'), a.ptt, true), hkRow(tr('studio.hk.ptm'), a.ptm, true)])),
  );
}
async function setHk(key, accelerator) {
  hkCapturing = null;
  const r = await shell.studio({ op: 'set-hotkey', name: key, value: accelerator });
  shell.hotkeyCapture(false);
  if (r && r.hotkeys) hkTargets = r.hotkeys;
  renderHkTargets();
}
function stopHkCapture() {
  if (!hkCapturing) return;
  hkCapturing = null;
  shell.hotkeyCapture(false);
  renderHkTargets();
}
window.addEventListener('keydown', (e) => {
  if (!hkCapturing) return;
  e.preventDefault();
  if (e.key === 'Escape') return stopHkCapture();
  const acc = hkCapturing.held ? HK.toHoldKey(e) : HK.toAccelerator(e);
  if (acc) setHk(hkCapturing.key, acc);
});
// Mouse side buttons, for keys to hold only (push to talk on a mouse button is common).
window.addEventListener('mousedown', (e) => {
  if (!hkCapturing?.held || (e.button !== 3 && e.button !== 4)) return;
  e.preventDefault();
  setHk(hkCapturing.key, e.button === 3 ? 'Mouse4' : 'Mouse5');
});

window.addEventListener('keydown', (e) => {
  if (studioCapturing === null) return;
  e.preventDefault();
  if (e.key === 'Escape') return stopStudioCapture();
  const accelerator = HK.toAccelerator(e);
  if (!accelerator) return; // keep waiting for a full combination
  const field = studioCapturing;
  studioCapturing = null;
  saveStudio({ [field]: accelerator }).then(() => shell.hotkeyCapture(false));
});

function renderStudio(d) {
  const s = d.settings;
  // Where to stream: one select, grouped like Streamlabs' destinations.
  const name = (p) => PLATFORM_NAMES[p] || tr('studio.dest.custom');
  const opt = (value, text, disabled = false) => Object.assign(document.createElement('option'), { value, textContent: text, disabled, selected: value === s.target });
  const group = (label, opts) => (opts.length ? [Object.assign(document.createElement('optgroup'), { label })].map((g) => (g.append(...opts), g)) : []);
  $('stTarget').replaceChildren(
    ...group(tr('studio.grp.multistream'), d.multistream ? [opt('multistream', tr('studio.target.multistream'))] : []),
    ...group(tr('studio.grp.accounts'), d.accounts.map((a) => opt(`account:${a.platform}`, tr(a.ready ? 'studio.account.auto' : 'studio.account.noScope', { platform: name(a.platform), name: a.label }), !a.ready))),
    ...group(tr('studio.grp.channels'), d.channels.map((t) => {
      const label = `${name(t.platform)}${t.label ? ` · ${t.label}` : ''}`;
      return opt(t.id, t.enabled ? label : tr('studio.target.off', { name: label }));
    })),
    ...group(tr('studio.grp.keys'), d.keys.map((k) => opt(`key:${k.id}`, `${name(k.platform)}${k.label ? ` · ${k.label}` : ''}`))),
  );
  const msg = d.offline ? tr('studio.err.offline') : '';
  $('stTargetMsg').textContent = msg;
  $('stTargetMsg').classList.toggle('hidden', !msg);
  $('stManage').classList.toggle('hidden', !d.multistream);
  // Twitch linked before Trigglow asked to read the stream key: one re-link grants it.
  const twitchNeedsRelink = d.accounts.some((a) => a.platform === 'twitch' && !a.ready);
  $('stRelink').classList.toggle('hidden', !twitchNeedsRelink);
  $('stRelinkHint').classList.toggle('hidden', !twitchNeedsRelink);
  // Pasted keys: listed without the key itself (the app never shows it again).
  $('stKeys').replaceChildren(
    ...d.keys.map((k) => {
      const li = document.createElement('li');
      const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'link', textContent: tr('ctl.remove') });
      remove.onclick = () => saveStudioOp({ op: 'remove-key', value: k.id });
      li.append(
        Object.assign(document.createElement('span'), { className: 'key-name', textContent: `${name(k.platform)}${k.label ? ` · ${k.label}` : ''}` }),
        remove,
      );
      return li;
    }),
  );
  $('stNoKeys').classList.toggle('hidden', d.keys.length > 0);
  keyServers = d.keyServers || {};
  if (!$('stKeyPlatform').options.length) {
    fill('stKeyPlatform', ['twitch', 'youtube', 'kick', 'tiktok', 'custom'].map((p) => [p, p === 'custom' ? tr('studio.keyOther') : PLATFORM_NAMES[p]]), 'twitch');
    syncKeyServer();
  }
  const sizes = ['3840x2160', '2560x1440', '1920x1080', '1600x900', '1280x720', '960x540'].filter((o) => Number(o.split('x')[1]) <= d.canvas.height);
  fill('stOutput', sizes.map((o) => [o, o.replace('x', '×')]), sizes.includes(s.output) ? s.output : sizes[0]);
  fill('stFps', [24, 25, 29.97, 30, 48, 50, 59.94, 60, 120].map((f) => [f, String(f).replace('.', DECIMAL)]), s.fps);
  fill('stScale', ['bilinear', 'bicubic', 'lanczos', 'area'].map((v) => [v, tr(`studio.scale.${v}`)]), s.scaleFilter);
  fill('stColorFormat', ['NV12', 'I420', 'I444'].map((v) => [v, v]), s.colorFormat);
  fill('stColorSpace', [['601', 'Rec. 601'], ['709', 'Rec. 709'], ['sRGB', 'sRGB']], s.colorSpace);
  fill('stColorRange', ['partial', 'full'].map((v) => [v, tr(`studio.range.${v}`)]), s.colorRange);
  fill('stAudioBitrate', [64, 96, 128, 160, 192, 224, 256, 320].map((v) => [v, `${v} kbps`]), s.audioBitrate);
  fill('stSampleRate', [[44100, '44,1 kHz'], [48000, '48 kHz']], s.sampleRate);
  fill('stChannels', ['mono', 'stereo', '2.1', '4.0', '4.1', '5.1', '7.1'].map((v) => [v, v === 'mono' || v === 'stereo' ? tr(`studio.ch.${v}`) : v]), s.channels);
  fill('stMonitorDev', [['default', tr('studio.deviceDefault')], ...(d.monitoringDevices || []).filter((m) => m.id !== 'default').map((m) => [m.id, m.name])], s.monitoringDevice);
  $('stDucking').checked = s.disableDucking;
  renderGlobalAudio(d);
  fill('stRecQuality', ['stream', 'high', 'higher', 'lossless'].map((v) => [v, tr(`studio.recq.${v}`)]), s.recordQuality);
  // Multitrack: which of the audio tracks 1–6 the recording keeps (at least one). More than track 1: its own encoder.
  $('stRecTracks').replaceChildren(
    ...[0, 1, 2, 3, 4, 5].map((i) => {
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: Boolean(s.recordTracks & (1 << i)) });
      box.onchange = () => {
        const next = box.checked ? s.recordTracks | (1 << i) : s.recordTracks & ~(1 << i);
        if (next) saveStudio({ recordTracks: next });
        else box.checked = true;
      };
      const label = document.createElement('label');
      label.className = 'check';
      label.append(box, Object.assign(document.createElement('span'), { textContent: String(i + 1) }));
      return label;
    }),
  );
  $('stRecQuality').disabled = s.recordTracks !== 1;
  fill('stSplit', ['off', 'time', 'size'].map((v) => [v, tr(`studio.split.${v}`)]), s.splitMode);
  $('stSplitMin').value = String(s.splitMinutes);
  $('stSplitMB').value = String(s.splitMB);
  $('stSplitMinRow').classList.toggle('hidden', s.splitMode !== 'time');
  $('stSplitMBRow').classList.toggle('hidden', s.splitMode !== 'size');
  $('stRemux').checked = s.remux;
  $('stRemuxRow').classList.toggle('hidden', !['mkv', 'flv', 'ts'].includes(s.recordFormat));
  $('stReconnect').checked = s.reconnect;
  $('stReconnectRow').classList.toggle('hidden', !s.reconnect);
  $('stReconnectDelay').value = String(s.reconnectDelay);
  $('stReconnectRetries').value = String(s.reconnectRetries);
  $('stDelay').checked = s.delay;
  $('stDelayRow').classList.toggle('hidden', !s.delay);
  $('stDelaySec').value = String(s.delaySec);
  $('stDelayPreserve').checked = s.delayPreserve;
  fill('stBindIP', [['default', tr('studio.bindIP.default')], ...Object.entries(d.networkInterfaces || {}).map(([name, ip]) => [ip, `${name} (${ip})`])], s.bindIP);
  $('stDynBitrate').checked = s.dynamicBitrate;
  $('stLowLatency').checked = s.lowLatency;
  $('stNetOpt').checked = s.networkOptimizations;
  fill('stPriority', ['High', 'AboveNormal', 'Normal', 'BelowNormal', 'Idle'].map((p) => [p, tr(`studio.priority.${p}`)]), s.processPriority);
  fill('stEncoder', [['auto', tr('studio.encoder.auto')], ...d.encoders.map((id) => [id, ENCODER_NAMES[id] || id])], s.encoder);
  lastEncoders = d.encoders;
  $('stBitrate').value = String(s.bitrate);
  $('stFolder').textContent = s.recordFolder;
  $('stFolder').title = s.recordFolder;
  fill('stFormat', ['mkv', 'mp4', 'mov', 'flv', 'ts'].map((v) => [v, v.toUpperCase()]), s.recordFormat);
  fill('stTransition', ['cut', 'fade', 'swipe', 'slide', 'fade_to_color', 'wipe', 'stinger'].map((t) => [t, tr(`studio.tr.${t}`)]), s.transition);
  $('stTrMs').value = String(s.transitionMs);
  $('stStinger').classList.toggle('hidden', s.transition !== 'stinger');
  $('stStingerFile').textContent = s.stingerFile || tr('studio.stinger.none');
  $('stStingerFile').title = s.stingerFile;
  $('stStingerPoint').value = String(s.stingerPointMs);
  // The canvas: automatic (the screen's) or a fixed size, like OBS's base resolution. The engine takes it on restart.
  const auto = `${d.screenCanvas.width}×${d.screenCanvas.height}`;
  fill('stCanvas', [['auto', tr('studio.canvas.auto', { size: auto })], ...['3840x2160', '2560x1440', '1920x1080', '1280x720'].map((c) => [c, c.replace('x', '×')])], s.canvas);
  const canvasPending = Boolean(d.engineCanvas && (d.engineCanvas.width !== d.canvas.width || d.engineCanvas.height !== d.canvas.height));
  $('stCanvasRestart').classList.toggle('hidden', !canvasPending);
  $('stAudioRestart').classList.toggle('hidden', !d.restartNeeded);
  // Trigglow Dynamic Delay: the plugin's filters inside the engine, turned on from Studio's bar or the shortcut.
  $('stDdMissing').classList.toggle('hidden', d.delayAvailable !== false);
  $('stDdSec').value = String(s.dynDelaySeconds);
  fill('stDdQuality', [480, 720, 1080].map((h) => [h, `${h}p`]), s.dynDelayQuality);
  // The live scene is required to turn the delay on (the plugin's "choose your live scene first").
  fill('stDdLive', [['', tr('studio.dd.liveNone')], ...(d.scenes || []).map((sc) => [sc.id, sc.name])], s.dynDelayLive);
  fill('stDdLoading', [['', tr('studio.dd.loadingNone')], ...(d.scenes || []).map((sc) => [sc.id, sc.name])], s.dynDelayLoading);
  $('stDdBadge').checked = s.dynDelayBadge;
  fill('stDdCorner', [0, 1, 2, 3].map((c) => [c, tr(`studio.dd.corner${c}`)]), s.dynDelayCorner);
  $('stDdCorner').disabled = !s.dynDelayBadge;
  // Profiles: the first one has no name of its own until it's renamed.
  if (d.profiles) {
    fill('stProfile', d.profiles.list.map((p) => [p.id, p.name || tr('studio.prof.default')]), d.profiles.current);
    $('stProfRemove').disabled = d.profiles.list.length <= 1;
    lastProfiles = d.profiles;
  }
  studioHotkeys = { hotkeyStream: s.hotkeyStream, hotkeyRecord: s.hotkeyRecord, hotkeyDelay: s.hotkeyDelay };
  loadHkTargets();
  renderStudioHotkeys();
  $('stApplied').classList.toggle('hidden', d.applied !== false);
}

/* OBS's auto-configuration wizard: test this PC (and Twitch's bandwidth), show the recommendation, apply it on a click. */
let autoRec = null;
if (shell) {
  $('stAutoConfig').onclick = async () => {
    autoRec = null;
    $('stAutoConfig').disabled = true;
    $('stAutoBox').classList.remove('hidden');
    $('stAutoApply').classList.add('hidden');
    $('stAutoText').textContent = tr('studio.ac.running');
    const r = await shell.studio({ op: 'auto-config' });
    $('stAutoConfig').disabled = false;
    if (!r || !r.recommendation) {
      $('stAutoText').textContent = r && r.error === 'studio_busy' ? tr('studio.prof.busy') : tr('studio.ac.failed');
      return;
    }
    autoRec = r.recommendation;
    const fps = String(autoRec.fps).replace('.', DECIMAL);
    $('stAutoText').textContent = tr(autoRec.measured ? 'studio.ac.measured' : 'studio.ac.estimated', {
      size: autoRec.output.replace('x', '×'),
      fps,
      kbps: autoRec.bitrate,
      encoder: ENCODER_NAMES[autoRec.encoder] || autoRec.encoder,
    });
    $('stAutoApply').classList.remove('hidden');
  };
  $('stAutoApply').onclick = async () => {
    if (!autoRec) return;
    await saveStudio({ output: autoRec.output, fps: autoRec.fps, bitrate: autoRec.bitrate, encoder: autoRec.encoder });
    $('stAutoText').textContent = tr('studio.ac.applied');
    $('stAutoApply').classList.add('hidden');
  };
}

/* Profiles: switch, new / duplicate (named inline, no native prompt), rename, remove a non-current one. */
let lastProfiles = null;
let profAsk = null; // 'new' | 'copy' | 'rename'
function profileMsg(text) {
  $('stProfMsg').textContent = text || '';
  $('stProfMsg').classList.toggle('hidden', !text);
}
async function profileOp(name, value) {
  const r = await shell.studio({ op: 'profile', name, value });
  if (r && r.error) return profileMsg(r.error === 'studio_busy' ? tr('studio.prof.busy') : tr('studio.err.generic', { error: r.error }));
  profileMsg('');
  if (r && r.settings) renderStudio(r);
}
function askProfile(kind) {
  profAsk = kind;
  const cur = lastProfiles && lastProfiles.list.find((p) => p.id === lastProfiles.current);
  $('stProfName').value = kind === 'rename' && cur ? cur.name || tr('studio.prof.default') : '';
  $('stProfAsk').classList.remove('hidden');
  $('stProfName').focus();
}
if (shell) {
  $('stProfile').onchange = () => profileOp($('stProfile').value, { action: 'switch' });
  $('stProfNew').onclick = () => askProfile('new');
  $('stProfCopy').onclick = () => askProfile('copy');
  $('stProfRename').onclick = () => askProfile('rename');
  $('stProfCancel').onclick = () => $('stProfAsk').classList.add('hidden');
  $('stProfOk').onclick = async () => {
    const name = $('stProfName').value.trim();
    if (!name) return;
    $('stProfAsk').classList.add('hidden');
    if (profAsk === 'rename') await profileOp(lastProfiles.current, { action: 'rename', name });
    else await profileOp('', { action: 'add', name, copy: profAsk === 'copy' });
  };
  // Removing asks inside the card (no native dialogs): a second click within a few seconds confirms.
  let removeArmed = 0;
  $('stProfRemove').onclick = async () => {
    const pick = lastProfiles && lastProfiles.list.find((p) => p.id !== lastProfiles.current && p.id === $('stProfile').value);
    const target = pick || (lastProfiles && lastProfiles.list.find((p) => p.id !== lastProfiles.current));
    if (!target) return;
    if (Date.now() - removeArmed > 4000) {
      removeArmed = Date.now();
      return profileMsg(tr('studio.prof.removeAsk', { name: target.name || tr('studio.prof.default') }));
    }
    removeArmed = 0;
    await profileOp(target.id, { action: 'remove' });
  };
}

/** The decimal mark of the app's language (29.97 → 29,97 in Spanish). */
let lastEncoders = [];
const DECIMAL = (1.5).toLocaleString(document.documentElement.lang || undefined).charAt(1) || '.';

/** OBS's Settings → Audio devices: Desktop Audio 1–2 and Mic/Aux 1–4, each a device or "off". */
function renderGlobalAudio(d) {
  const rows = (d.globalAudio || []).map((g) => {
    const list = g.channel <= 2 ? d.audioOutputs || [] : d.audioInputs || [];
    const sel = document.createElement('select');
    const opts = [['', tr('studio.deviceOff')], ['default', tr('studio.deviceDefault')], ...list.filter((x) => x.id !== 'default').map((x) => [x.id, x.name])];
    sel.replaceChildren(...opts.map(([v, t]) => Object.assign(document.createElement('option'), { value: v, textContent: t, selected: v === (g.device ?? '') })));
    sel.onchange = async () => renderStudio(await shell.studio({ op: 'set-global-audio', value: { channel: g.channel, device: sel.value || null } }));
    const label = document.createElement('label');
    label.className = 'field';
    label.append(Object.assign(document.createElement('span'), { textContent: tr(g.channel <= 2 ? 'studio.desktopAudioN' : 'studio.micAudioN', { n: g.channel <= 2 ? g.channel : g.channel - 2 }) }), sel);
    return label;
  });
  $('stGlobalAudio').replaceChildren(...rows);
}

async function loadStudio() {
  studioLoaded = true;
  renderStudio(await shell.studio({ op: 'settings' }));
  void loadImport();
}

/* ------------------------- Import from OBS / Streamlabs ------------------------- */

let importList = null;

async function loadImport() {
  importList = await shell.studio({ op: 'import-list' });
  const list = (importList && importList.collections) || [];
  $('stImpNone').classList.toggle('hidden', list.length > 0);
  $('stImpForm').classList.toggle('hidden', list.length === 0 && !(importList && importList.backup));
  $('stImpPick').closest('label').classList.toggle('hidden', list.length === 0);
  $('stImpGo').classList.toggle('hidden', list.length === 0);
  fill('stImpPick', list.map((c) => [c.id, `${tr(`studio.imp.app.${c.app}`)} · ${c.name}`]), $('stImpPick').value);
  syncImportOptions();
  $('stImpUndo').classList.toggle('hidden', !(importList && importList.backup));
}

/** OBS's profile and stream key only exist for OBS collections. */
function syncImportOptions() {
  const obs = $('stImpPick').value.startsWith('obs:');
  $('stImpProfile').closest('label').classList.toggle('hidden', !(obs && importList && importList.profile));
  $('stImpKey').closest('label').classList.toggle('hidden', !(obs && importList && importList.hasKey));
}

function importSay(text, bad) {
  $('stImpMsg').textContent = text;
  $('stImpMsg').className = `status ${bad ? 'bad' : 'ok'}`;
}

/** The report: what came as is (the headline), what was converted and what couldn't come, each with why. */
function renderReport(r) {
  const box = $('stImpReport');
  const line = (n) => {
    const li = document.createElement('li');
    const text = tr(`studio.imp.n.${n.code}`, { detail: n.detail || '' });
    li.textContent = n.name ? `${n.name}: ${text}` : text;
    return li;
  };
  const section = (level, title) => {
    const notes = r.notes.filter((n) => n.level === level);
    if (!notes.length) return [];
    const h = document.createElement('h3');
    h.textContent = tr(title);
    const ul = document.createElement('ul');
    ul.append(...notes.map(line));
    return [h, ul];
  };
  const head = document.createElement('p');
  head.className = 'imp-head';
  head.textContent = tr('studio.imp.done', { scenes: r.stats.scenes, sources: r.stats.sources }) + (r.keyImported ? ` ${tr('studio.imp.keyDone')}` : '');
  box.replaceChildren(head, ...section('converted', 'studio.imp.converted'), ...section('lost', 'studio.imp.lost'));
  box.classList.remove('hidden');
}

function setupImport() {
  $('stImpPick').onchange = syncImportOptions;
  $('stImpGo').onclick = () => {
    $('stImpConfirm').classList.remove('hidden');
    $('stImpGo').disabled = true;
  };
  $('stImpNo').onclick = () => {
    $('stImpConfirm').classList.add('hidden');
    $('stImpGo').disabled = false;
  };
  $('stImpYes').onclick = async () => {
    $('stImpYes').disabled = true;
    const r = await shell.studio({ op: 'import', value: { id: $('stImpPick').value, profile: $('stImpProfile').checked, key: $('stImpKey').checked, copyFiles: $('stImpCopy').checked } });
    $('stImpYes').disabled = false;
    $('stImpGo').disabled = false;
    $('stImpConfirm').classList.add('hidden');
    if (!r || r.error || !r.report) {
      importSay(tr(r && r.error === 'studio_busy' ? 'studio.imp.err.busy' : 'studio.imp.err.read'), true);
      return;
    }
    importSay([r.report.copied ? tr('studio.imp.copied', { n: r.report.copied }) : '', r.report.docks ? tr('studio.imp.docks', { n: r.report.docks }) : ''].filter(Boolean).join(' '), false);
    renderReport(r.report);
    renderStudio(await shell.studio({ op: 'settings' }));
    void loadImport();
  };
  $('stImpUndo').onclick = async () => {
    const r = await shell.studio({ op: 'import-undo' });
    if (r && r.error) return importSay(tr(r.error === 'studio_busy' ? 'studio.imp.err.busy' : 'studio.imp.err.read'), true);
    $('stImpReport').classList.add('hidden');
    importSay(tr('studio.imp.undone'), false);
    void loadImport();
  };
}

/** Every field saves on change, like the rest of these settings. */
async function saveStudio(patch) {
  renderStudio(await shell.studio({ op: 'save-settings', value: patch }));
}

if (shell) {
  const num = (id) => Number($(id).value);
  $('stTarget').onchange = () => saveStudio({ target: $('stTarget').value });
  $('stOutput').onchange = () => saveStudio({ output: $('stOutput').value });
  $('stFps').onchange = () => saveStudio({ fps: num('stFps') });
  $('stEncoder').onchange = () => saveStudio({ encoder: $('stEncoder').value });
  $('stBitrate').onchange = () => saveStudio({ bitrate: num('stBitrate') });
  $('stFormat').onchange = () => saveStudio({ recordFormat: $('stFormat').value });
  $('stTransition').onchange = () => saveStudio({ transition: $('stTransition').value });
  $('stTrMs').onchange = () => saveStudio({ transitionMs: num('stTrMs') });
  $('stStingerPoint').onchange = () => saveStudio({ stingerPointMs: num('stStingerPoint') });
  $('stStingerPick').onclick = async () => renderStudio(await shell.studio({ op: 'pick-stinger' }));
  $('stCanvas').onchange = () => saveStudio({ canvas: $('stCanvas').value });
  $('stScale').onchange = () => saveStudio({ scaleFilter: $('stScale').value });
  $('stColorFormat').onchange = () => saveStudio({ colorFormat: $('stColorFormat').value });
  $('stColorSpace').onchange = () => saveStudio({ colorSpace: $('stColorSpace').value });
  $('stColorRange').onchange = () => saveStudio({ colorRange: $('stColorRange').value });
  $('stAudioBitrate').onchange = () => saveStudio({ audioBitrate: num('stAudioBitrate') });
  $('stSampleRate').onchange = () => saveStudio({ sampleRate: num('stSampleRate') });
  $('stChannels').onchange = () => saveStudio({ channels: $('stChannels').value });
  $('stMonitorDev').onchange = () => saveStudio({ monitoringDevice: $('stMonitorDev').value });
  $('stDucking').onchange = () => saveStudio({ disableDucking: $('stDucking').checked });
  $('stRecQuality').onchange = () => saveStudio({ recordQuality: $('stRecQuality').value });
  $('stSplit').onchange = () => saveStudio({ splitMode: $('stSplit').value });
  $('stSplitMin').onchange = () => saveStudio({ splitMinutes: num('stSplitMin') });
  $('stSplitMB').onchange = () => saveStudio({ splitMB: num('stSplitMB') });
  $('stRemux').onchange = () => saveStudio({ remux: $('stRemux').checked });
  $('stReconnect').onchange = () => saveStudio({ reconnect: $('stReconnect').checked });
  $('stReconnectDelay').onchange = () => saveStudio({ reconnectDelay: num('stReconnectDelay') });
  $('stReconnectRetries').onchange = () => saveStudio({ reconnectRetries: num('stReconnectRetries') });
  $('stDelay').onchange = () => saveStudio({ delay: $('stDelay').checked });
  $('stDdSec').onchange = () => saveStudio({ dynDelaySeconds: num('stDdSec') });
  $('stDdQuality').onchange = () => saveStudio({ dynDelayQuality: num('stDdQuality') });
  $('stDdLive').onchange = () => saveStudio({ dynDelayLive: $('stDdLive').value });
  $('stDdLoading').onchange = () => saveStudio({ dynDelayLoading: $('stDdLoading').value });
  $('stDdBadge').onchange = () => saveStudio({ dynDelayBadge: $('stDdBadge').checked });
  $('stDdCorner').onchange = () => saveStudio({ dynDelayCorner: num('stDdCorner') });
  $('stDelaySec').onchange = () => saveStudio({ delaySec: num('stDelaySec') });
  $('stDelayPreserve').onchange = () => saveStudio({ delayPreserve: $('stDelayPreserve').checked });
  $('stBindIP').onchange = () => saveStudio({ bindIP: $('stBindIP').value });
  $('stDynBitrate').onchange = () => saveStudio({ dynamicBitrate: $('stDynBitrate').checked });
  $('stLowLatency').onchange = () => saveStudio({ lowLatency: $('stLowLatency').checked });
  $('stNetOpt').onchange = () => saveStudio({ networkOptimizations: $('stNetOpt').checked });
  $('stPriority').onchange = () => saveStudio({ processPriority: $('stPriority').value });
  // The encoder's own window (preset, profile, rate control, keyframes…), for the encoder in use.
  $('stEncoderProps').onclick = () => shell.studioPopup({ kind: 'encoder', source: $('stEncoder').value === 'auto' ? (lastEncoders[0] || '') : $('stEncoder').value });
  $('stCanvasRelaunch').onclick = () => shell.relaunch();
  $('stAudioRelaunch').onclick = () => shell.relaunch();
  setupImport();
  $('stFolderPick').onclick = async () => renderStudio(await shell.studio({ op: 'pick-folder' }));
  $('stFolderOpen').onclick = () => shell.studio({ op: 'open-folder' });
  $('stManage').onclick = () => shell.nav('multistream');
  $('stRelink').onclick = () => shell.nav('link-twitch');
  $('stKeyPlatform').onchange = syncKeyServer;
  $('stKeyForm').onsubmit = async (e) => {
    e.preventDefault();
    const r = await saveStudioOp({ op: 'add-key', value: { platform: $('stKeyPlatform').value, label: $('stKeyLabel').value, server: $('stKeyServer').value, key: $('stKeyValue').value } });
    const bad = !r || r.error;
    $('stKeyMsg').textContent = bad ? tr(r && r.error === 'too_many_keys' ? 'studio.err.generic' : 'studio.err.invalid_key', { error: r && r.error }) : '';
    $('stKeyMsg').className = bad ? 'status bad' : 'status hidden';
    if (!bad) {
      // Saved (and picked as the destination): the fields empty out, the key is never shown again.
      $('stKeyLabel').value = '';
      $('stKeyServer').value = '';
      $('stKeyValue').value = '';
    }
  };
}
