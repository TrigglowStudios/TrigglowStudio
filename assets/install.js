const $ = (id) => document.getElementById(id);
const shell = window.trigglowShell;
const params = new URLSearchParams(location.search);
const name = params.get('name') || '';
const url = params.get('url') || '';
let connected = false;
let scenesLoaded = false;

function say(text, cls = '') {
  $('msg').textContent = text;
  $('msg').className = 'status ' + cls;
}

async function loadScenes() {
  try {
    const { scenes, current } = await shell.obsScenes();
    const select = $('scene');
    const prev = select.value;
    select.replaceChildren(...scenes.map((s) => Object.assign(document.createElement('option'), { value: s, textContent: s })));
    select.value = scenes.includes(prev) ? prev : current;
    scenesLoaded = true;
  } catch {
    scenesLoaded = false;
  }
}

/** Which Trigglow overlay a /overlay/<id>/<suffix> URL is (Studio adds it by kind, with the account's own URL). */
const STUDIO_KINDS = { '': 'alerts', chat: 'chat', activity: 'activity', goals: 'goals', quests: 'quests', giveaway: 'giveaway', loyalty: 'loyalty', 'music-requests': 'music', credits: 'credits', emotes: 'emotes' };
function studioKind() {
  try {
    const m = /^\/overlay\/[^/]+(?:\/([^/]+))?\/?$/.exec(new URL(url).pathname);
    return m ? STUDIO_KINDS[m[1] || ''] || null : null;
  } catch {
    return null;
  }
}
let studioMode = false;

async function refresh() {
  const s = await shell.getState();
  studioMode = Boolean(s.engine && s.engine.available && s.engine.mode === 'studio' && s.engine.running && studioKind());
  if (studioMode) {
    // Trigglow Studio is the engine: one button, into the scene being edited. No OBS, no scene list.
    $('scene').classList.add('hidden');
    document.querySelector('label[for="scene"]').classList.add('hidden');
    $('go').textContent = tr('install.ctaStudio');
    $('go').disabled = false;
    return;
  }
  const now = s.obs.state === 'connected';
  if (now && (!connected || !scenesLoaded)) await loadScenes();
  connected = now;
  $('go').disabled = !connected || !scenesLoaded;
  $('scene').disabled = !connected;
  // Not connected: say the ONE thing to do next (open OBS / enable its WebSocket server / …), not "go to settings".
  if (!$('msg').dataset.result) say(connected ? '' : tr(`obs.hint.${s.obs.hint}`), connected ? '' : 'bad');
}

if (shell) {
  $('go').onclick = async () => {
    $('go').disabled = true;
    if (studioMode) {
      const r = await shell.studio({ op: 'add-source', trigglow: studioKind() });
      $('msg').dataset.result = '1';
      say(tr('install.studioAdded', { scene: (r && r.view && r.view.current) || '' }), 'ok');
      parent.postMessage({ type: 'trigglow:overlay-installed', name }, '*');
      $('go').disabled = false;
      return;
    }
    try {
      const scene = $('scene').value;
      const result = await shell.obsInstall({ scene, name, url });
      $('msg').dataset.result = '1';
      say(tr(`install.${result}`, { scene }), 'ok');
      // Lets the hosting page react (e.g. tick an onboarding step). No data beyond the source name.
      parent.postMessage({ type: 'trigglow:overlay-installed', name }, '*');
    } catch (e) {
      $('msg').dataset.result = '1';
      const code = ['name_taken', 'no_browser_source'].find((c) => String(e.message).includes(c));
      say(tr(code ? `install.err.${code}` : 'install.err.generic'), 'bad');
    } finally {
      $('go').disabled = !connected;
    }
  };
  $('scene').onchange = () => {
    delete $('msg').dataset.result;
    say('');
  };
  refresh();
  setInterval(() => !document.hidden && refresh().catch(() => undefined), 2000);
}
