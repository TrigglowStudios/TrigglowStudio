import { overlayPlacement } from './overlay-layout';
import {
  app,
  BaseWindow,
  BrowserWindow,
  dialog,
  globalShortcut,
  screen,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  protocol,
  session,
  shell,
  Tray,
  WebContentsView,
  type IpcMainInvokeEvent,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLIP_QUALITIES, CLIP_VISIBILITIES, loadConfig, saveConfig, type ClipQuality, type ClipVisibility, type Config, type ObsConfig, type Prefs } from './config';
import { AutoHighlights } from './auto-highlights';
import { DEFAULT_HIGHLIGHTS_DIR, GameHighlightWatcher } from './game-highlights';
import { LolWatcher } from './lol';
import { clipNow, getClipProgress, getDeferredClipCount, isClipBusy, onClipProgress, retryQueuedClips } from './clip';
import { sendControl } from './control';
import { watchHeldKeys } from './key-hold';
import { CONTROL_ACTIONS, isValidAccelerator, normalizeControlHotkeys, type ControlAction } from './hotkey';
import { appLocale, nt, setLocaleSources, type MsgKey } from './messages';
import { reconcileAccountLocale, toAppLocale, type AppLocale, type LocalePrefs } from './locale';
import { Updater } from './updater';
import { Burst, type DesktopNotification } from './notify';
import { fetchTextData } from './text-data';
import { TextSources, cleanSourceName, cleanTemplate, defaultSourceName, defaultTemplate, isBindingId } from './text-sources';
import { ApiLink } from './link';
import { NowPlayingWatcher } from './now-playing';
import { classifyNav } from './nav';
import { ObsLink, type EngineLink } from './obs';
import { validStreamSetup } from './obs-stream';
import { StudioEngine, canvasFor } from './studio';
import { StudioLink } from './studio-link';
import { cleanPropertyValue, dialogFilters } from './studio-props';
import { importObsCollection, importSlobsCollection, obsBrowserDocks, obsService, profileSettings, relocateFiles } from './studio-import';
import { findCollections, obsDocksSetting, obsProfile, readCollection } from './studio-import-files';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { CANVAS_SIZES, KEY_SERVERS, MAX_KEYS, MULTISTREAM_TARGET, defaultStudioSettings, MAX_CUSTOM_DOCKS, newStudioKey, normalizeStudioSettings, validDockUrl, validServer } from './studio-settings';
import { detectObs, isObsRunning, obsHint, type ObsDetect, type ObsHint } from './obs-detect';
import { closeObs, enableReplayBufferInProfile, enableServerInConfig, findObsExecutable, installBrowserDock, installTrigglowDocks, launchObs, readTrigglowDocks, replaceLegacyBrowserDock, setReplaySecondsInProfile, type DockToWrite, type FixResult, type ReplayFixResult } from './obs-fix';
import { SignIn } from './signin';
import { allowDevStack, allowLocalhost, dockKindOf, isTrigglowDockUrl, isTrustedUrl } from './trust';
import { CLIP_MAX_BYTES_FALLBACK } from './compress';
import { PACK_MAX_BYTES, packFilesFromArgv, packStageOutcome } from './pack-open';

const VERSION = app.getVersion();
const SESSION_COOKIE = 'trigglow_session';
const SESSION_TTL_S = 60 * 60 * 24 * 7; // mirrors the API's SESSION_TTL_SECONDS

allowLocalhost(!app.isPackaged);

// package.json's name is "@trigglow/desktop", which Windows shows as the app's name in the taskbar and window previews.
// Rename the app, but pin userData to where it already lives so existing installs keep their session and settings.
const LEGACY_USER_DATA = app.getPath('userData');
// The display name is "Trigglow Studio" (window, title bar, tray); the app's internal name stays "Trigglow" because it
// names the userData folder: changing it would sign every streamer out and lose their settings on update.
app.setName('Trigglow');
app.setPath('userData', LEGACY_USER_DATA);
// Wayland: global shortcuts only fire through the desktop's GlobalShortcuts portal (KDE, GNOME 48+). X11 ignores it.
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');

// Electron's login items are macOS/Windows only: Linux gets an XDG autostart entry. It points at $APPIMAGE (the updater
// renames that file on every update, so the entry is rewritten on each launch) or, for the .deb, the installed binary.
const linuxAutostartFile = () => path.join(process.env.XDG_CONFIG_HOME ?? path.join(app.getPath('home'), '.config'), 'autostart', 'trigglow.desktop');
function openAtLogin(): boolean {
  return process.platform === 'linux' ? fs.existsSync(linuxAutostartFile()) : app.getLoginItemSettings().openAtLogin;
}
function setOpenAtLogin(on: boolean): void {
  if (process.platform !== 'linux') return app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
  const file = linuxAutostartFile();
  try {
    if (!on) return fs.rmSync(file, { force: true });
    const exe = (process.env.APPIMAGE || process.execPath).replace(/["`$\\]/g, '\\$&'); // Exec quoting rules
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Trigglow\nExec="${exe}" --hidden\nIcon=trigglow\nX-GNOME-Autostart-enabled=true\n`);
  } catch (err) {
    console.warn('[autostart] failed:', err);
  }
}

// A file named `dev` next to the executable (or `--dev`) points the installed app at the develop stack (dev.trigglow.com)
// instead of production. It gets its own userData dir, so two installs can run side by side (separate single-instance
// lock, session, config) without mixing accounts.
const DEV_STACK = process.argv.includes('--dev') || fs.existsSync(path.join(path.dirname(process.execPath), 'dev'));
if (DEV_STACK) app.setPath('userData', `${app.getPath('userData')}-dev`);
allowDevStack(DEV_STACK || !app.isPackaged);

// Both stacks split web and API: Vercel SPA at trigglow.com / dev.trigglow.com, API at api.trigglow.com / apidev.trigglow.com.
const WEB_URL =
  process.env.TRIGGLOW_WEB_URL ??
  (DEV_STACK ? 'https://dev.trigglow.com/app' : app.isPackaged ? 'https://trigglow.com/app' : 'http://localhost:5173/app');
// `pnpm dev` goes through Vite's proxy, so the API shares the web origin there.
const API_ORIGIN =
  process.env.TRIGGLOW_API_URL ??
  (DEV_STACK ? 'https://apidev.trigglow.com' : app.isPackaged ? 'https://api.trigglow.com' : new URL(WEB_URL).origin);
/** Where the installed app looks for updates — the API's feed of the GitHub `desktop-v*` releases. */
const UPDATE_URL = process.env.TRIGGLOW_UPDATE_URL ?? `${API_ORIGIN}/api/desktop/update`;

import { LocalChatServer, loadOrCreateToken } from './local-server';

const ASSETS = path.resolve(__dirname, '../assets');
// The app's own screens (sign-in, and the settings panel embedded in the web's /app/settings) are served from
// the bundled assets through a private scheme, so an http(s) page can frame them — it could not frame file://.
const LOCAL_PAGES = 'trigglow-app://app/';
const isLocalPage = (url: string | undefined) => Boolean(url?.startsWith(LOCAL_PAGES));
protocol.registerSchemesAsPrivileged([{ scheme: 'trigglow-app', privileges: { standard: true, secure: true } }]);

let win: BaseWindow | null = null;
let content: WebContentsView | null = null; // the web app / sign-in screen
let titlebar: WebContentsView | null = null; // the app's own title bar (bundled page)
let tray: Tray | null = null;

let quitting = false;
let view: 'app' | 'signin' | 'onboarding' = 'signin';
/** When an account link was last handed to the system browser (0 = none pending); see openLinkInBrowser. */
let browserLinkAt = 0;
let reachable = true;
let user: string | null = null;
let config: Config;
let overlayId: string | null = null;
let textSources: TextSources | null = null;
let prevObsState: string = 'disconnected';
let lastDetect: ObsDetect | null = null;
let lastHint: ObsHint = 'checking';
/** Longest clip by plan, from the API (the server enforces it; this only shapes the UI). Free until we learn otherwise. */
const DEFAULT_CLIP_LIMITS = { max: 60, freeMax: 60, plusMax: 300, maxBytes: CLIP_MAX_BYTES_FALLBACK, planId: null as string | null };
let clipLimits = { ...DEFAULT_CLIP_LIMITS };
let lengthStatus: 'applied' | 'pending' | 'failed' | null = null;
const CLIP_MIN_SECONDS = 10;

const updater = new Updater(
  () => broadcast(),
  (version) => {
    const n = new Notification({ title: nt('update.ready'), body: nt('update.ready.body', { version }) });
    n.on('click', installUpdate);
    n.show();
  },
  // Never pulls a ~130 MB installer while the streamer is live; the next check after the stream does.
  () => config.prefs.autoUpdate && !engine().live,
);

/** Restart into the downloaded version. `quitting` first: closing to the tray would otherwise swallow the quit. */
function installUpdate() {
  quitting = true;
  updater.install();
}

// The moment OBS stops streaming/recording (or closes), clips saved "for after the stream" start uploading.
let engineWasLive = false;
let onStreamOver: () => void = () => {};
function engineChanged() {
  const live = engine().live;
  if (engineWasLive && !live) onStreamOver();
  engineWasLive = live;
  broadcast();
}
const obs = new ObsLink(engineChanged);
/** OBS or Trigglow Studio: what clips, highlights, server actions and text sources drive (Studio once its engine runs). */
const engine = (): EngineLink => (studio.running ? studioLink : obs);
const api = new ApiLink(engine, () => broadcast());
const nowPlaying = new NowPlayingWatcher((np) => api.sendNowPlaying(np));
api.onNowPlayingConfig = (on) => (on ? nowPlaying.start() : nowPlaying.stop());
const localChatServer = new LocalChatServer({
  assetsDir: ASSETS,
  // Persisted so the clip toast URL pasted into OBS survives restarts; delete the file to rotate it.
  token: loadOrCreateToken(path.join(app.getPath('userData'), 'local-dock-token')),
  getLocale: appLocale,
});
const signIn = new SignIn(
  API_ORIGIN,
  () => broadcast(),
  async (token) => {
    await session.defaultSession.cookies.set({
      url: API_ORIGIN,
      name: SESSION_COOKIE,
      value: encodeURIComponent(token),
      path: '/',
      httpOnly: true,
      secure: API_ORIGIN.startsWith('https:'),
      sameSite: 'lax',
      expirationDate: Math.floor(Date.now() / 1000) + SESSION_TTL_S,
    });
    // During first-run setup signing in must not whisk the user into the dashboard.
    if (view === 'onboarding') {
      await fetchMe();
      api.connect(API_ORIGIN);
      broadcast();
    } else await enterApp();
  },
);

/** Where OBS listens. Auto mode reads OBS's own WebSocket settings on every attempt — nothing for the user to type. */
/**
 * "Fix it for me". OBS reads its WebSocket settings only at startup and rewrites them on exit, so the server can be
 * turned on automatically only while OBS is closed. If it is open, that means restarting it — which could interrupt a
 * live stream or recording — so it only happens after the user confirms (`confirmRestart`).
 */
async function fixObs(confirmRestart: boolean): Promise<FixResult> {
  const d = await detectObs();
  lastDetect = d;
  if (d.running === false) {
    const exe = await findObsExecutable();
    if (process.platform !== 'darwin' && !exe) return 'no_obs_found';
    const needEnable = d.serverEnabled !== true;
    if (needEnable) enableServerInConfig();
    const clips = config.prefs.clipEnabled && enableReplayBufferInProfile(config.prefs.clipSeconds);
    launchObs(exe, clips ? ['--startreplaybuffer'] : []);
    obs.retryNow(); // keeps retrying every few seconds while OBS boots
    return needEnable ? 'enabled_and_launched' : 'launched';
  }
  if (d.running && d.serverEnabled !== true) {
    if (!confirmRestart) return 'needs_restart';
    const exe = await findObsExecutable(); // capture the path before it closes
    if (process.platform !== 'darwin' && !exe) return 'no_obs_found'; // never close an OBS we couldn't start again
    if (!(await closeObs())) return 'close_failed';
    enableServerInConfig();
    const clips = config.prefs.clipEnabled && enableReplayBufferInProfile(config.prefs.clipSeconds);
    launchObs(exe, clips ? ['--startreplaybuffer'] : []);
    obs.retryNow();
    return 'restarted';
  }
  return 'nothing';
}

/**
 * "Turn the Replay Buffer on for me". Live first (it may just be idle); if OBS says it isn't enabled, that is a
 * profile setting OBS reads only at startup — so, like the WebSocket fix, it needs OBS closed: done directly when OBS
 * isn't running, or via a confirmed restart when it is (relaunched with --startreplaybuffer so it is already running).
 */
async function fixReplay(confirmRestart: boolean): Promise<ReplayFixResult> {
  if (studio.running) {
    // Trigglow Studio's own replay buffer: nothing to enable anywhere, just start it.
    try {
      studio.startReplay();
      publishCaps();
      return 'started';
    } catch {
      return 'error';
    }
  }
  if (obs.state === 'connected') {
    if (obs.replayActive === true) return 'started';
    try {
      await obs.startReplayBuffer();
      return 'started';
    } catch {
      /* not enabled in the active profile */
    }
    if (!confirmRestart) return 'needs_restart';
    const exe = await findObsExecutable(); // capture the path before it closes
    if (process.platform !== 'darwin' && !exe) return 'no_obs_found'; // never close an OBS we couldn't start again
    if (!(await closeObs())) return 'close_failed';
    const ok = enableReplayBufferInProfile(config.prefs.clipSeconds);
    launchObs(exe, ['--startreplaybuffer']); // never leave the user without OBS, even if the profile couldn't be edited
    obs.retryNow();
    return ok ? 'restarted' : 'no_profile';
  }
  const d = await detectObs();
  lastDetect = d;
  if (d.running === false) {
    const exe = await findObsExecutable();
    if (process.platform !== 'darwin' && !exe) return 'no_obs_found';
    if (!enableReplayBufferInProfile(config.prefs.clipSeconds)) return 'no_profile';
    if (d.serverEnabled !== true) enableServerInConfig(); // make OBS connectable in the same launch
    launchObs(exe, ['--startreplaybuffer']);
    obs.retryNow();
    return 'enabled_and_launched';
  }
  return 'error'; // OBS is open but we are not connected — fix that first
}

async function resolveObs(): Promise<ObsConfig> {
  lastDetect = await detectObs();
  if (config.obs.mode === 'manual') return config.obs;
  return { host: '127.0.0.1', port: lastDetect.port ?? 4455, password: lastDetect.password };
}

function state() {
  return {
    version: VERSION,
    webUrl: WEB_URL,
    reachable,
    user,
    locale: appLocale(),
    signIn: signIn.state,
    obs: {
      state: obs.state,
      error: obs.error,
      hint: currentHint(),
      mode: config.obs.mode,
      host: config.obs.host,
      port: config.obs.port,
      hasPassword: Boolean(config.obs.password),
      // never includes the password read from OBS
      detect: lastDetect && { installed: lastDetect.installed, running: lastDetect.running, serverEnabled: lastDetect.serverEnabled },
    },
    onboarded: config.onboarded,
    // Which engine: the streamer's OBS (bridge) or Trigglow Studio. `restart`: the choice changed while the other
    // engine was running, so it applies after a relaunch (the engine can't be stopped and started again in-process).
    engine: { available: studioOffered(), mode: config.prefs.engine, running: studio.running, restart: studioRestartNeeded(), live: studio.stats()?.streaming ?? false },
    update: { ...updater.state, auto: config.prefs.autoUpdate },
    server: api.online,
    clip: {
      enabled: config.prefs.clipEnabled,
      autoHighlights: config.prefs.autoHighlights,
      uploadMode: config.prefs.clipUploadMode,
      quality: config.prefs.clipQuality,
      visibility: config.prefs.clipVisibility,
      title: config.prefs.clipTitle,
      announce: config.prefs.clipAnnounce,
      announceText: config.prefs.clipAnnounceText,
      gameHighlights: config.prefs.gameHighlights,
      gameHighlightsDir: config.prefs.gameHighlightsDir,
      gameHighlightsDefaultDir: DEFAULT_HIGHLIGHTS_DIR,
      deferredCount: getDeferredClipCount(),
      hotkey: config.prefs.clipHotkey,
      hotkeyStatus,
      replayActive: engine().replayActive,
      busy: isClipBusy(),
      progress: getClipProgress(),
      seconds: (engine().state === 'connected' ? engine().replaySeconds : null) ?? config.prefs.clipSeconds,
      minSeconds: CLIP_MIN_SECONDS,
      maxSeconds: clipLimits.max,
      freeMaxSeconds: clipLimits.freeMax,
      plusMaxSeconds: clipLimits.plusMax,
      // Pro's plan id is `plus`; comparing lengths would also call Starter Pro when both caps match.
      isPlus: clipLimits.planId === 'plus',
      lengthStatus,
    },
    controls: { hotkeys: config.prefs.controlHotkeys, status: controlStatus },
    text: textState(),
    notifications: { supported: Notification.isSupported() },
    prefs: {
      closeToTray: config.prefs.closeToTray,
      openObsOnLaunch: config.prefs.openObsOnLaunch,
      lolDetect: config.prefs.lolDetect,
      openAtLogin: openAtLogin(),
      autoStartSupported: app.isPackaged,
    },
  };
}

/** OBS text sources: what is bound, how each one is doing, and what else could be added. */
function textState() {
  const ts = textSources;
  if (!ts) return { bindings: [], available: [] };
  const available = ts.available();
  const bound = new Set(ts.bindings.map((b) => b.id));
  return {
    bindings: ts.bindings.map((b) => ({ ...b, status: ts.status.get(b.id) ?? 'nodata', value: ts.values.get(b.id) ?? '', label: available.find((a) => a.id === b.id)?.label ?? null })),
    available: available.filter((a) => !bound.has(a.id)),
  };
}

/** While a retry is in flight keep showing the previous diagnosis instead of flashing "checking". */
function currentHint(): ObsHint {
  if (obs.state === 'connecting' && lastHint !== 'connected') return lastHint;
  lastHint = obsHint(obs.state, lastDetect, obs.error);
  return lastHint;
}

function broadcast() {
  refreshTrayMenu();
  publishCaps();
  if (obs.state === 'connected' && prevObsState !== 'connected') void textSources?.sync(true);
  prevObsState = obs.state;
  const s = state();
  if (view !== 'app') content?.webContents.send('shell:state-changed', s);
  titlebar?.webContents.send('shell:state-changed', s); // the update pill lives in the title bar
}

/* ------------------------------ session ------------------------------ */

async function refreshClipLimits() {
  try {
    const res = await session.defaultSession.fetch(`${API_ORIGIN}/api/kick/clips/limits`, { credentials: 'include' });
    if (!res.ok) return; // clips beta flag off / not signed in: keep the free defaults
    const l = (await res.json()) as { planId?: string; maxUploadSeconds?: number; freeMaxUploadSeconds?: number; plusMaxUploadSeconds?: number; maxUploadBytes?: number };
    clipLimits = {
      max: l.maxUploadSeconds ?? clipLimits.max,
      freeMax: l.freeMaxUploadSeconds ?? clipLimits.freeMax,
      plusMax: l.plusMaxUploadSeconds ?? clipLimits.plusMax,
      maxBytes: l.maxUploadBytes ?? clipLimits.maxBytes,
      planId: l.planId ?? null,
    };
    broadcast();
  } catch {
    /* offline — keep what we had */
  }
}

/* ------------------------------ language ------------------------------ */

/** The signed-in account's language (users.locale); null while signed out, unknown or never set. */
let accountLocale: AppLocale | null = null;
let accountLocaleKnown = false;
let accountRun = 0; // bumped on sign-out so a late answer for the old account is dropped
let shownLocale: AppLocale | null = null;

function setLocalePrefs(p: LocalePrefs) {
  if (p.locale === config.prefs.locale && p.localePending === config.prefs.localePending) return;
  config = { ...config, prefs: { ...config.prefs, locale: p.locale, localePending: p.localePending } };
  saveConfig(config);
}

/** Everything outside the bundled screens follows the app's language as soon as it changes: tray, chat docks, screens. */
function applyLocale() {
  setLocaleSources({ prefs: config.prefs, account: accountLocale });
  const locale = appLocale();
  if (locale === shownLocale) return;
  shownLocale = locale;
  setTrayMenu();
  createMenu();
  localChatServer.broadcastLocale(locale);
  for (const [kind, v] of studioDockViews) if (!kind.startsWith('custom:')) void v.webContents.loadURL(studioDockUrl(kind as StudioDockKind)); // Studio's docks too
  broadcast(); // state().locale → the sign-in screen and the title bar
}

/** Same save the web dashboard makes on a language pick (also what the server renders stream-event toasts in). */
async function saveLocaleToAccount(locale: AppLocale) {
  const run = accountRun;
  try {
    const res = await session.defaultSession.fetch(`${API_ORIGIN}/api/profile`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale }),
    });
    if (!res.ok || run !== accountRun) return; // stays pending: tried again at the next sign-in or launch
    accountLocale = locale;
    accountLocaleKnown = true;
    if (config.prefs.locale === locale) setLocalePrefs({ locale, localePending: false });
    applyLocale();
  } catch {
    /* offline — tried again later */
  }
}

/** Reads the account's language; `fromWeb`: right after the web dashboard saved the profile inside this app. */
async function refreshAccountLocale(fromWeb = false) {
  const run = accountRun;
  let next: AppLocale | null;
  try {
    const res = await session.defaultSession.fetch(`${API_ORIGIN}/api/profile`, { credentials: 'include' });
    if (!res.ok) return;
    next = toAppLocale(((await res.json()) as { locale?: unknown }).locale);
  } catch {
    return; // offline — keep the language we had
  }
  if (run !== accountRun) return;
  const changed = fromWeb && accountLocaleKnown && next !== accountLocale;
  accountLocale = next;
  accountLocaleKnown = true;
  const { prefs, push } = reconcileAccountLocale(config.prefs, next, changed);
  setLocalePrefs(prefs);
  applyLocale();
  if (push) await saveLocaleToAccount(push);
}

async function fetchMe(): Promise<'ok' | 'anon' | 'offline'> {
  try {
    const res = await session.defaultSession.fetch(`${API_ORIGIN}/auth/me`, { credentials: 'include' });
    if (!res.ok) return 'anon';
    const me = (await res.json()) as { displayName?: string; overlayId?: string; studioAllowed?: boolean };
    user = me.displayName ?? null;
    // Studio's staged launch: remembered for the next start (the engine starts before sign-in). Losing access
    // doesn't stop a running engine; the next start is OBS again.
    const access = me.studioAllowed === true;
    if (access !== config.prefs.studioAccess) {
      config = { ...config, prefs: { ...config.prefs, studioAccess: access } };
      saveConfig(config);
    }
    overlayId = me.overlayId ?? null;
    void refreshClipLimits();
    void refreshAccountLocale();
    return 'ok';
  } catch {
    return 'offline';
  }
}

function showSignIn() {
  view = 'signin';
  browserLinkAt = 0;
  user = null;
  // Nothing of the previous account may carry over to the next one (its overlay, its plan's clip limits).
  overlayId = null;
  studio.setOverlayBase(null);
  // The docks ran on that session: they go with it and load afresh for the next account.
  for (const v of studioDockViews.values()) {
    win?.contentView.removeChildView(v);
    v.webContents.close();
  }
  studioDockViews.clear();
  clipLimits = { ...DEFAULT_CLIP_LIMITS };
  accountRun += 1;
  accountLocale = null;
  accountLocaleKnown = false;
  applyLocale();
  api.disconnect();
  textSources?.stop();
  void content?.webContents.loadURL(`${LOCAL_PAGES}signin.html`);
  broadcast();
}

function showOnboarding() {
  view = 'onboarding';
  void content?.webContents.loadURL(`${LOCAL_PAGES}onboarding.html`);
  broadcast();
}

async function enterApp() {
  if ((await fetchMe()) !== 'ok') return showSignIn();
  view = 'app';
  reachable = true;
  api.connect(API_ORIGIN);
  textSources?.start();
  void content?.webContents.loadURL(WEB_URL);
  broadcast();
  void openPendingPacks(); // a pack double-clicked before signing in
  studio.setOverlayBase(overlayBase()); // the signed-in streamer's own overlays, once their overlay id is known
}

async function signOut() {
  try {
    await session.defaultSession.fetch(`${API_ORIGIN}/auth/logout`, { method: 'POST', credentials: 'include' });
  } catch {
    /* offline — still drop the local cookie below */
  }
  await session.defaultSession.cookies.remove(API_ORIGIN, SESSION_COOKIE);
  showSignIn();
}

/* ------------------------------ windows ------------------------------ */

function policeNavigation(wc: Electron.WebContents) {
  // The window must never wander off /app: everything else goes to the system browser (or our sign-in screen).
  const check = (url: string, block: () => void, inPage = false) => {
    if (isLocalPage(url)) return;
    const verdict = classifyNav(url);
    if (verdict === 'allow') return;
    if (!(inPage && verdict === 'signin')) block();
    if (verdict === 'signin') {
      if (content && wc === content.webContents) showSignIn();
    } else if (verdict === 'link') void openLinkInBrowser(url);
    else if (verdict === 'external') void shell.openExternal(url);
  };
  // Only the WINDOW's own navigation is policed. Electron also reports navigations of child frames (these events
  // fire for any frame), and pages legitimately frame themselves — e.g. Trigglow Link's live preview is an iframe
  // of the public page whose client-side routing would otherwise get "undone" and opened in the browser.
  wc.on('will-navigate', (e, url) => {
    if (e.isMainFrame) check(url, () => e.preventDefault());
  });
  wc.on('will-redirect', (e, url) => {
    if (e.isMainFrame) check(url, () => e.preventDefault());
  });
  // Client-side (pushState) routing can't be prevented, only undone.
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (isMainFrame) check(url, () => wc.navigationHistory.goBack(), true);
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (classifyNav(url) === 'link') void openLinkInBrowser(url);
    else if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

/**
 * Account links (Twitch, Kick, YouTube, Discord, Spotify…) finish in the system browser, never in the app. That
 * browser has no Trigglow session, so the API swaps ours for a one-use ticket bound to this start URL
 * (apps/api/src/lib/desktop-link.ts); the browser redeems it on a confirmation page. The window picks up the
 * result when it regains focus (checkBrowserLink).
 */
async function openLinkInBrowser(startUrl: string) {
  const u = new URL(startUrl);
  try {
    const res = await session.defaultSession.fetch(`${API_ORIGIN}/auth/desktop-link`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start: `${u.pathname}${u.search}` }),
    });
    if (res.status === 401) return showSignIn();
    const { ticket } = res.ok ? ((await res.json()) as { ticket?: unknown }) : { ticket: null };
    if (typeof ticket !== 'string' || !/^tgdl_[\w-]{43}$/.test(ticket)) throw new Error(`desktop-link ${res.status}`);
    browserLinkAt = Date.now();
    await shell.openExternal(`${API_ORIGIN}/auth/desktop-link?t=${ticket}`);
  } catch (err) {
    console.error('[desktop] account link failed', err);
    new Notification({ title: nt('link.failed'), body: nt('link.failed.body') }).show();
  }
}

/** Ticket (3 min) + provider OAuth state (10 min), with slack: after that the link can no longer finish. */
const BROWSER_LINK_WINDOW_MS = 15 * 60_000;

/** On focus, after a browser link: open the page the in-app flow would have landed on (with its linked/error toast). */
async function checkBrowserLink() {
  if (!browserLinkAt || view !== 'app') return;
  if (Date.now() - browserLinkAt > BROWSER_LINK_WINDOW_MS) {
    browserLinkAt = 0;
    return;
  }
  try {
    const res = await session.defaultSession.fetch(`${API_ORIGIN}/auth/desktop-link/result`, { credentials: 'include' });
    const { url } = res.ok ? ((await res.json()) as { url?: unknown }) : { url: null };
    if (typeof url !== 'string') return; // not finished yet: ask again on the next focus
    browserLinkAt = 0;
    if (classifyNav(url) === 'allow') void content?.webContents.loadURL(url);
    else reloadView();
  } catch {
    /* offline: ask again on the next focus */
  }
}

const TITLEBAR_H = 36;

function layout() {
  if (!win || !content || !titlebar) return;
  const [width, height] = win.getContentSize();
  titlebar.setBounds({ x: 0, y: 0, width, height: TITLEBAR_H });
  content.setBounds({ x: 0, y: TITLEBAR_H, width, height: Math.max(0, height - TITLEBAR_H) });
  layoutStudio();
}

/**
 * Frameless window: the OS only draws the min/max/close buttons (titleBarOverlay; traffic lights on macOS),
 * everything else is ours — a bundled title bar view on top, the web app view below.
 */
function createWindow() {
  const saved = config.window;
  // Only restore the position when that spot is still on a connected screen.
  const onScreen = saved && screen.getAllDisplays().some((d) => saved.x < d.workArea.x + d.workArea.width - 100 && saved.x + saved.width > d.workArea.x + 100 && saved.y >= d.workArea.y - 10 && saved.y < d.workArea.y + d.workArea.height - 100);
  win = new BaseWindow({
    width: saved?.width ?? 1280,
    height: saved?.height ?? 820,
    ...(saved && onScreen ? { x: saved.x, y: saved.y } : {}),
    minWidth: 900,
    minHeight: 600,
    show: !process.argv.includes('--hidden'),
    backgroundColor: '#110f13',
    title: 'Trigglow Studio',
    icon: path.join(ASSETS, process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: 11 } }
      : { titleBarOverlay: { color: '#110f13', symbolColor: '#a8a29c', height: TITLEBAR_H - 1 } }),
  });
  // The constructor option alone doesn't always reach the Windows taskbar on a frameless BaseWindow; set it explicitly.
  win.setIcon(nativeImage.createFromPath(path.join(ASSETS, process.platform === 'win32' ? 'icon.ico' : 'icon.png')));
  const webPreferences = {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    // The web's Settings tab frames our settings panel; the preload only exposes the shell on our own pages.
    nodeIntegrationInSubFrames: true,
  };
  content = new WebContentsView({ webPreferences });
  titlebar = new WebContentsView({ webPreferences });
  content.setBackgroundColor('#110f13');
  titlebar.setBackgroundColor('#110f13');
  win.contentView.addChildView(content);
  win.contentView.addChildView(titlebar);
  layout();
  // Listeners first: maximize() can fire its events synchronously, and a missed one leaves the views at the default size.
  win.on('resize', layout);
  win.on('focus', () => void checkBrowserLink());
  win.on('maximize', layout);
  win.on('unmaximize', layout);
  win.on('restore', layout);
  win.on('move', layoutStudio); // the layer over the preview is its own window: it follows
  win.on('minimize', layoutStudio);
  win.on('hide', layoutStudio);
  win.on('show', layout);
  win.on('enter-full-screen', layout);
  win.on('leave-full-screen', layout);
  if (saved?.maximized) win.maximize();
  layout();

  // Lets the web app recognise the shell (e.g. to offer OBS actions) without any bridge.
  // `TrigglowEngine/1` tells the dashboard this app can run Trigglow Studio (its sidebar shows the Studio page).
  baseUserAgent = `${content.webContents.getUserAgent()} TrigglowDesktop/${VERSION}`;
  applyUserAgent();
  policeNavigation(content.webContents);
  // A full page load drops the Studio page with it (its pagehide may not reach us in time).
  content.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument && studioRect) {
      studioRect = null;
      layoutStudio();
    }
  });
  void titlebar.webContents.loadURL(`${LOCAL_PAGES}titlebar.html?platform=${process.platform}`);
  win.on('close', (e) => {
    if (win) {
      config = { ...config, window: { ...win.getNormalBounds(), maximized: win.isMaximized() } };
      saveConfig(config);
    }
    if (quitting) return;
    if (!config.prefs.closeToTray) return app.quit();
    e.preventDefault();
    win?.hide();
  });
}

/* ------------------------- Trigglow Studio (F0) ------------------------- */

// Studio is a page of the dashboard (/app/studio, in the web's sidebar). That page frames our studio.html, and
// studio.html reports where its preview area sits in the window; the engine's preview, a native child window, is
// drawn exactly there. Leaving the page hides the preview (0×0, no GPU); the engine keeps running and streaming.
const studio = new StudioEngine();
const studioLink = new StudioLink(
  studio,
  async () => {
    studio.startStream(await resolveStudioTarget());
  },
  engineChanged,
);
/** The starter collection's names, in the app's language. */
const studioNames = () => ({
  scene: nt('studio.default.scene'),
  display: nt('studio.default.display'),
  game: nt('studio.default.game'),
  desktop: nt('studio.default.desktop'),
  mic: nt('studio.default.mic'),
  collection: nt('studio.default.collection'),
});

/**
 * Brings an OBS or Streamlabs collection into Studio (docs/design/trigglow-studio.md §5): it replaces the current one,
 * which is kept as a backup to go back to. Optionally OBS's profile (video, recording) and its stream key (encrypted
 * on this PC, like a pasted one; our own multistream key just becomes "stream with Multistream").
 */
function importIntoStudio(req: { id?: unknown; profile?: unknown; key?: unknown; copyFiles?: unknown }) {
  const stats = studio.stats();
  if (stats?.streaming || stats?.recording) return { error: 'studio_busy' };
  const found = typeof req.id === 'string' ? readCollection(req.id) : null;
  if (!found) return { error: 'import_unreadable' };
  const ctx = { inputTypes: new Set(studio.inputTypes()), fileExists: (p: string) => fs.existsSync(p), fallbackCanvas: studioCanvas() };
  const r = found.app === 'obs' ? importObsCollection(found.raw, ctx) : importSlobsCollection(found.raw, ctx);
  let next = config.studio;
  if (r.transition) next = { ...next, transition: r.transition.kind, transitionMs: r.transition.ms, ...(r.transition.stingerFile ? { stingerFile: r.transition.stingerFile, stingerPointMs: r.transition.stingerPointMs ?? 500 } : {}) };
  const profile = found.app === 'obs' ? obsProfile() : null;
  if (req.profile === true && profile) {
    const p = profileSettings(profile.ini);
    if (p.canvas) {
      r.collection.canvas = p.canvas;
      // OBS's canvas, if it's one Studio offers; it takes effect when the app restarts (the engine's canvas is fixed).
      const size = `${p.canvas.width}x${p.canvas.height}`;
      if ((CANVAS_SIZES as readonly string[]).includes(size)) next = { ...next, canvas: size as (typeof CANVAS_SIZES)[number] };
    }
    next = normalizeStudioSettings(
      { ...next, ...(p.output ? { output: p.output } : {}), ...(p.fps ? { fps: p.fps } : {}), ...(p.recordFolder && fs.existsSync(p.recordFolder) ? { recordFolder: p.recordFolder } : {}), ...(p.recordFormat ? { recordFormat: p.recordFormat } : {}) },
      next,
    );
  }
  // Optionally a copy of every file the sources use, in Studio's own folder (the originals stay where they are).
  let copied = 0;
  if (req.copyFiles === true) {
    const media = path.join(app.getPath('userData'), 'studio', 'media');
    fs.mkdirSync(media, { recursive: true });
    r.collection = relocateFiles(r.collection, (file) => {
      try {
        if (!fs.statSync(file).isFile()) return null;
        const dest = path.join(media, `${createHash('sha256').update(file).digest('hex').slice(0, 10)}-${path.basename(file)}`);
        if (!fs.existsSync(dest)) fs.copyFileSync(file, dest);
        copied++;
        return dest;
      } catch {
        return null; // missing or unreadable: the report already says so; the path stays
      }
    });
  }
  studio.replaceCollection(r.collection, studioNames());
  let keyImported = false;
  const service = req.key === true && profile ? obsService(profile.service) : null;
  if (service) {
    if (service.key.startsWith('tgms_')) next = { ...next, target: MULTISTREAM_TARGET };
    else if (config.studioKeys.length < MAX_KEYS) {
      const k = newStudioKey({ platform: service.platform, label: 'OBS', server: service.server ?? undefined, key: service.key }, randomBytes(4).toString('hex'));
      if (k) {
        config = { ...config, studioKeys: [...config.studioKeys, k] };
        next = { ...next, target: `key:${k.id}` };
        keyImported = true;
      }
    }
  }
  // OBS's custom browser docks come too (not Trigglow's own: Studio has them built in), without repeating one.
  let docks = 0;
  if (found.app === 'obs') {
    for (const d of obsBrowserDocks(obsDocksSetting())) {
      if (next.customDocks.length >= MAX_CUSTOM_DOCKS || next.customDocks.some((x) => x.url === d.url)) continue;
      next = { ...next, customDocks: [...next.customDocks, { id: `dock-${randomBytes(4).toString('hex')}`, ...d }] };
      docks++;
    }
  }
  config = { ...config, studio: next };
  saveConfig(config);
  studio.setSettings(next);
  return { report: { app: found.app, stats: r.stats, notes: r.notes, keyImported, copied, docks }, view: studio.view() };
}

/** Studio keeps a replay buffer running while clips are on, like OBS's that the app starts for them. */
function syncStudioReplay() {
  if (!studio.alive()) return;
  try {
    if (config.prefs.clipEnabled) studio.startReplay();
    else studio.stopReplay();
  } catch (err) {
    console.warn('[studio] replay buffer', err);
  }
  publishCaps();
  broadcast();
}
/** The preview area in the web view's CSS pixels, from studio.html; null = the Studio page is not showing. */
let studioRect: { x: number; y: number; width: number; height: number } | null = null;
/** Studio mode's program view on the Studio page (web CSS px), null when studio mode is off. */
let studioProgramRect: { x: number; y: number; width: number; height: number } | null = null;
let studioFrame: Electron.WebFrameMain | null = null; // studio.html, to push stats and stream signals to
let studioStatsTimer: ReturnType<typeof setInterval> | null = null;

/** This build has the engine and the account may use Studio (its staged launch, Admin → Ajustes → studioAudience). */
function studioOffered() {
  return StudioEngine.available() && config.prefs.studioAccess;
}

function studioEnabled() {
  return config.prefs.engine === 'studio' && studioOffered();
}

function overlayBase() {
  return overlayId ? `${new URL(WEB_URL).origin}/overlay/${encodeURIComponent(overlayId)}` : null;
}

function studioSend(channel: string, payload: unknown) {
  try {
    if (studioFrame && !studioFrame.isDestroyed()) studioFrame.send(channel, payload);
  } catch {
    studioFrame = null; // the page went away
  }
}

/** A JSON call to the API with the signed-in streamer's session; `status` 0 = offline. */
async function apiJson<T>(pathname: string, init: { method?: string } = {}): Promise<{ status: number; body: T | null }> {
  try {
    const res = await session.defaultSession.fetch(`${API_ORIGIN}${pathname}`, { method: init.method ?? 'GET', credentials: 'include' });
    return { status: res.status, body: res.ok ? ((await res.json()) as T) : null };
  } catch {
    return { status: 0, body: null };
  }
}

interface MultistreamOverview {
  ingestUrl: string;
  streamKey: string | null;
  destinations: { id: string; platform: string; label: string; enabled: boolean; connected: boolean }[];
}

/**
 * Where Studio can stream, like Streamlabs: Trigglow's multistream (when the account has it), the linked YouTube /
 * Twitch accounts (key read by the API), each Multistream channel on its own, and keys pasted here.
 */
async function studioTargets() {
  const [ms, acc] = await Promise.all([
    apiJson<MultistreamOverview>('/api/multistream'),
    apiJson<{ accounts: { platform: 'youtube' | 'twitch'; label: string; ready: boolean }[] }>('/api/studio/accounts'),
  ]);
  return {
    multistream: Boolean(ms.body),
    offline: ms.status === 0 && acc.status === 0,
    accounts: acc.body?.accounts ?? [],
    channels: (ms.body?.destinations ?? []).map((d) => ({ id: d.id, platform: d.platform, label: d.label, enabled: d.enabled })),
    keys: config.studioKeys.map(({ id, platform, label }) => ({ id, platform, label })), // never the key itself
    keyServers: KEY_SERVERS,
  };
}

/** The server and key for the saved target, read right before going live (from the API, or this PC's own keys). */
async function resolveStudioTarget(): Promise<{ server: string; key: string }> {
  const target = config.studio.target;
  if (target.startsWith('key:')) {
    const k = config.studioKeys.find((x) => `key:${x.id}` === target);
    if (!k || !k.key) throw new Error('key_missing');
    return { server: k.server, key: k.key };
  }
  if (target.startsWith('account:')) {
    const r = await apiJson<{ serverUrl: string; streamKey: string }>(`/api/studio/accounts/${target.slice(8)}/credentials`);
    const server = validServer(r.body?.serverUrl);
    if (r.status === 409) throw new Error('needs_scope');
    if (!r.body || !server) throw new Error(r.status === 0 ? 'offline' : 'account_unavailable');
    return { server, key: r.body.streamKey };
  }
  if (target === MULTISTREAM_TARGET) {
    const r = await apiJson<MultistreamOverview>('/api/multistream');
    if (!r.body) throw new Error(r.status === 0 ? 'offline' : 'multistream_unavailable');
    let key = r.body.streamKey;
    if (!key) key = (await apiJson<{ streamKey: string }>('/api/multistream/key', { method: 'POST' })).body?.streamKey ?? null; // first use creates it
    const server = validServer(r.body.ingestUrl);
    if (!server || !key) throw new Error('no_ingest');
    return { server, key };
  }
  const r = await apiJson<{ serverUrl: string; streamKey: string }>(`/api/multistream/destinations/${encodeURIComponent(target)}/credentials`);
  const server = validServer(r.body?.serverUrl);
  if (!r.body || !server) throw new Error(r.status === 0 ? 'offline' : 'target_unavailable');
  return { server, key: r.body.streamKey };
}

/** Studio's canvas: as big as the main screen shows (1080p, 1440p or 4K), in device pixels. */
function studioCanvas() {
  // Chosen in Settings (or brought from OBS's profile): that size. Otherwise as big as the main screen shows.
  if (config.studio.canvas !== 'auto') {
    const [width, height] = config.studio.canvas.split('x').map(Number);
    return { width, height };
  }
  const d = screen.getPrimaryDisplay();
  return canvasFor(Math.round(d.size.height * d.scaleFactor));
}

/** Studio's settings for the app's Settings → Trigglow Studio tab (output sizes up to the canvas). */
async function studioSettingsView() {
  const d = screen.getPrimaryDisplay();
  return {
    settings: config.studio,
    encoders: studio.encoders(),
    canvas: studioCanvas(),
    // For the canvas picker: what "automatic" means here, and the canvas the engine runs now (a change needs a restart).
    screenCanvas: canvasFor(Math.round(d.size.height * d.scaleFactor)),
    engineCanvas: studio.view()?.canvas ?? null,
    // Sample rate and channels, like the canvas, take effect when the app restarts.
    restartNeeded: Boolean(studio.startedAudio && (studio.startedAudio.sampleRate !== config.studio.sampleRate || studio.startedAudio.channels !== config.studio.channels)),
    // OBS's Settings → Audio and → Advanced lists, read from the engine.
    monitoringDevices: studio.monitoringDevices(),
    networkInterfaces: studio.networkInterfaces(),
    globalAudio: studio.globalAudio(),
    audioInputs: studio.audioDevices('input'),
    audioOutputs: studio.audioDevices('output'),
    profiles: { current: config.studioProfiles.current, list: config.studioProfiles.list.map((p) => ({ id: p.id, name: p.name })) },
    // Dynamic Delay: whether the engine has the plugin's core, and the scenes it can show while it fills.
    delayAvailable: studio.delayAvailable(),
    scenes: studio.sceneIds(),
    ...(await studioTargets()),
  };
}

/* Studio's pop-up windows, where OBS has them: source properties, filters, a name to type, "are you sure?". Real
   windows over the app (the engine's native preview would cover anything drawn inside the page), modal to it. */

/** Each Trigglow overlay's own settings page in the dashboard (apps/web/src/lib/overlays-catalog.ts configPath). */
const TRIGGLOW_SETTINGS_PAGES: Record<string, string> = {
  alerts: '/app/triggers',
  chat: '/app/chat-overlay',
  activity: '/app/activity-overlay',
  goals: '/app/goals-overlay',
  quests: '/app/quests',
  giveaway: '/app/giveaways',
  loyalty: '/app/loyalty',
  music: '/app/music-requests',
  credits: '/app/credits-overlay',
  emotes: '/app/emotes-overlay',
};

const POPUP_SIZES: Record<string, { width: number; height: number; resizable: boolean }> = {
  web: { width: 1100, height: 800, resizable: true },
  picker: { width: 900, height: 600, resizable: true },
  props: { width: 640, height: 600, resizable: true },
  encoder: { width: 640, height: 620, resizable: true },
  stats: { width: 560, height: 520, resizable: true },
  transform: { width: 560, height: 520, resizable: false },
  audio: { width: 980, height: 460, resizable: true },
  filters: { width: 900, height: 600, resizable: true },
  name: { width: 440, height: 210, resizable: false },
  confirm: { width: 440, height: 200, resizable: false },
};
let studioPopup: BrowserWindow | null = null;
let studioPopupDone: ((value: unknown) => void) | null = null;

/** Opens one popup (only one at a time) and resolves with what it answered, or null when closed without answering. */
function openStudioPopup(params: Record<string, string>): Promise<unknown> {
  const size = POPUP_SIZES[params.kind];
  if (!size || !win) return Promise.resolve(null);
  if (studioPopup) {
    studioPopup.focus();
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let result: unknown = null;
    // A Trigglow overlay's settings are its dashboard page (?panel=1: just the page), not libobs' browser-source fields.
    const web = params.kind === 'web' ? TRIGGLOW_SETTINGS_PAGES[params.source] : null;
    if (params.kind === 'web' && !web) return resolve(null);
    const popup = new BrowserWindow({
      parent: win as unknown as BrowserWindow,
      modal: params.kind !== 'stats', // Stats stays open beside the editor, like OBS's
      show: false,
      ...size,
      minWidth: Math.min(size.width, 420),
      minHeight: Math.min(size.height, 200),
      minimizable: false,
      maximizable: false,
      backgroundColor: '#1d1a21',
      title: 'Trigglow Studio',
      autoHideMenuBar: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#1d1a21', symbolColor: '#a8a29c', height: 39 },
      ...(web ? { titleBarStyle: 'default', titleBarOverlay: false, backgroundColor: '#161318' } : {}),
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    if (web) {
      // The dashboard page, same session as the main window; it may not wander off the dashboard.
      popup.webContents.setUserAgent(content?.webContents.getUserAgent() ?? popup.webContents.getUserAgent());
      policeNavigation(popup.webContents);
      void popup.loadURL(`${new URL(WEB_URL).origin}${web}?panel=1`);
    } else {
      popup.webContents.on('will-navigate', (e) => e.preventDefault());
      void popup.loadURL(`${LOCAL_PAGES}studio-popup.html?${new URLSearchParams(params).toString()}`);
    }
    popup.once('ready-to-show', () => popup.show());
    studioPopupDone = (value) => {
      result = value;
      popup.close();
    };
    popup.on('closed', () => {
      studioPopup = null;
      studioPopupDone = null;
      resolve(result);
    });
    studioPopup = popup;
  });
}

/** Called from layout(): puts the preview over the Studio page's preview area, or hides it. */
function layoutStudio() {
  if (!win || !content || !studio.running) return;
  if (!studioRect || view !== 'app' || win.isMinimized() || !win.isVisible()) {
    placeStudioOverlay(null);
    layoutStudioDocks();
    studio.attachProgram(win.getNativeWindowHandle(), null);
    return studio.hidePreview();
  }
  // Web CSS px → DIP (the web view's zoom) → device px (the screen's scale); the web view starts below our title bar.
  const zoom = content.webContents.getZoomFactor();
  const scale = (screen.getDisplayMatching(win.getBounds()).scaleFactor || 1) * zoom;
  const [width, height] = win.getContentSize();
  const r = studioRect;
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  const w = Math.max(0, Math.min(r.width, width - x));
  const h = Math.max(0, Math.min(r.height, height - TITLEBAR_H - y));
  studio.attachPreview(win.getNativeWindowHandle(), {
    x: Math.round(x * scale),
    y: Math.round((TITLEBAR_H + y) * scale),
    width: Math.round(w * scale),
    height: Math.round(h * scale),
  });
  const p = studioProgramRect;
  studio.attachProgram(
    win.getNativeWindowHandle(),
    p ? { x: Math.round(Math.max(0, p.x) * scale), y: Math.round((TITLEBAR_H + Math.max(0, p.y)) * scale), width: Math.round(Math.max(0, Math.min(p.width, width - p.x)) * scale), height: Math.round(Math.max(0, Math.min(p.height, height - TITLEBAR_H - p.y)) * scale) } : null,
  );
  layoutStudioDocks();
  const cb = win.getContentBounds();
  placeStudioOverlay({ x: Math.round(cb.x + x * zoom), y: Math.round(cb.y + TITLEBAR_H + y * zoom), width: Math.round(w * zoom), height: Math.round(h * zoom) });
}

/** The PC's font families (for text sources' font picker), listed once per run. */
let fontsCache: Promise<string[]> | null = null;
function installedFonts(): Promise<string[]> {
  fontsCache ??= new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }'],
      { encoding: 'utf8', timeout: 15_000, windowsHide: true },
      (err, out) => resolve(err ? [] : [...new Set(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))].slice(0, 2000)),
    );
  });
  return fontsCache;
}

/*
 * Dynamic Delay's badge ("DELAY 30 s"), drawn once per app version like the plugin draws it (assets/delay-badge:
 * its design, fonts and mark), one PNG per second 1–60, for the engine's image source.
 */
const BADGE_VERSION = 1;
// The plugin's controller (in the engine) shows `<prefix><seconds>.png`.
const delayBadgePrefix = () => path.join(app.getPath('userData'), 'studio', 'badges', `delay-badge-v${BADGE_VERSION}-`);
const delayBadgeFile = (seconds: number) => `${delayBadgePrefix()}${Math.min(60, Math.max(1, Math.round(seconds)))}.png`;
async function renderDelayBadges() {
  if (fs.existsSync(delayBadgeFile(60))) return;
  const w = new BrowserWindow({ show: false, width: 520, height: 200, webPreferences: { offscreen: true, contextIsolation: true, sandbox: true } });
  try {
    await w.loadURL(`${LOCAL_PAGES}delay-badge/badge.html`);
    fs.mkdirSync(path.dirname(delayBadgeFile(1)), { recursive: true });
    // The plugin's texts: "Delay", "%1 s", "By Trigglow" (the same in every language it has).
    for (let s = 1; s <= 60; s++) {
      const url = (await w.webContents.executeJavaScript(`drawBadge('Delay', '${s} s', 'By Trigglow')`)) as string;
      fs.writeFileSync(delayBadgeFile(s), Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64'));
    }
    studio.refreshDelayBadge();
  } catch (err) {
    console.warn('[studio] delay badge', err);
  } finally {
    w.destroy();
  }
}

/*
 * Projectors, like OBS's: program, a scene or a source in a window of its own, or full screen on a monitor. The
 * engine's display can't be destroyed from here (it deadlocks, see StudioEngine.hidePreview), so a closed projector's
 * window is hidden and kept, and opening the same projector again reuses it.
 */
const projectorWindows = new Map<string, BrowserWindow>();
function openProjector(target: { kind: 'program' } | { kind: 'scene' | 'source'; name: string }, screenId: number | null) {
  if (!studio.alive()) return false;
  const key = target.kind === 'program' ? 'program' : `${target.kind}:${target.name}`;
  let w = projectorWindows.get(key);
  const display = screenId === null ? null : screen.getAllDisplays().find((d) => d.id === screenId) ?? null;
  if (!w || w.isDestroyed()) {
    w = new BrowserWindow({
      show: false,
      width: 960,
      height: 540,
      backgroundColor: '#000000',
      title: target.kind === 'program' ? 'Trigglow Studio' : `Trigglow Studio · ${target.name}`,
      autoHideMenuBar: true,
      icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    void w.loadURL('about:blank');
    const place = () => {
      if (!w || w.isDestroyed() || !w.isVisible()) return;
      const [cw, ch] = w.getContentSize();
      const s = screen.getDisplayMatching(w.getBounds()).scaleFactor || 1;
      if (!studio.attachProjector(key, w.getNativeWindowHandle(), target, { width: Math.round(cw * s), height: Math.round(ch * s) })) w.hide();
    };
    w.on('resize', place);
    w.on('show', place);
    w.on('move', place);
    w.on('close', (e) => {
      if (quitting) return;
      e.preventDefault();
      studio.hideProjector(key);
      w?.setFullScreen(false);
      w?.hide();
    });
    // Esc leaves full screen, like OBS's projectors.
    w.webContents.on('before-input-event', (_e, input) => {
      if (input.key === 'Escape' && w?.isFullScreen()) w.setFullScreen(false);
    });
    projectorWindows.set(key, w);
  }
  if (display) {
    w.setBounds(display.bounds);
    w.show();
    w.setFullScreen(true);
  } else {
    w.setFullScreen(false);
    w.show();
  }
  w.focus();
  return true;
}

/*
 * The layer over the preview (studio-overlay.html): a transparent window of ours, exactly over the engine's native
 * preview, that draws the selection (border and handles, like OBS's) and takes the mouse to move and resize. The engine
 * draws no editing UI of its own, and the mouse never has to go through its native window. Not focusable: clicking it
 * leaves the keyboard on the Studio page (arrows, Delete).
 */
let studioOverlay: BrowserWindow | null = null;
function placeStudioOverlay(bounds: Electron.Rectangle | null) {
  if (!bounds || bounds.width < 2 || bounds.height < 2 || !win) {
    if (studioOverlay && !studioOverlay.isDestroyed()) studioOverlay.hide();
    return;
  }
  if (!studioOverlay || studioOverlay.isDestroyed()) {
    const o = new BrowserWindow({
      parent: win as unknown as BrowserWindow,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    o.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    o.webContents.on('will-navigate', (e) => e.preventDefault());
    o.on('closed', () => {
      if (studioOverlay === o) studioOverlay = null;
    });
    void o.loadURL(`${LOCAL_PAGES}studio-overlay.html`);
    studioOverlay = o;
  }
  studioOverlay.setBounds(bounds);
  if (!studioOverlay.isVisible()) studioOverlay.showInactive();
}

/*
 * Trigglow's docks inside Studio (activity, chat): the web's own /dock pages in `?studio=1` mode, which run on the
 * streamer's session instead of a linked dock credential. They are views of this window placed exactly over the
 * areas studio.html reserves (like the preview); a top-level page, so the docks' "never framed" rule stays as it is.
 */
const STUDIO_DOCKS = ['activity', 'chat'] as const;
type StudioDockKind = (typeof STUDIO_DOCKS)[number];
/** Trigglow's docks by kind, and the streamer's custom browser docks as `custom:<id>`. */
const studioDockViews = new Map<string, WebContentsView>();
const studioDockUrl = (kind: StudioDockKind) => `${new URL(WEB_URL).origin}/dock/${kind}?studio=1&lang=${encodeURIComponent(appLocale())}`;
let studioDockRects: Record<string, Electron.Rectangle | null> = {};
const studioDockKeys = () => [...STUDIO_DOCKS, ...config.studio.customDocks.map((d) => `custom:${d.id}`)];

function layoutStudioDocks() {
  if (!win || !content) return;
  const zoom = content.webContents.getZoomFactor();
  const [width, height] = win.getContentSize();
  const showing = Boolean(studioRect) && view === 'app' && studio.running;
  // Custom docks that were removed go away.
  for (const [key, v] of studioDockViews) {
    if (studioDockKeys().includes(key)) continue;
    win.contentView.removeChildView(v);
    v.webContents.close();
    studioDockViews.delete(key);
  }
  for (const kind of studioDockKeys()) {
    const r = showing ? studioDockRects[kind] : null;
    let v = studioDockViews.get(kind);
    if (!r) {
      v?.setVisible(false);
      continue;
    }
    if (!v) {
      const custom = kind.startsWith('custom:') ? config.studio.customDocks.find((d) => `custom:${d.id}` === kind) : null;
      // A custom dock is any web page: its own session, no preload (no app API), sandboxed; new windows open outside.
      v = new WebContentsView({
        webPreferences: custom
          ? { partition: 'persist:studio-custom-docks', contextIsolation: true, nodeIntegration: false, sandbox: true }
          : { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      v.setBackgroundColor('#110f13');
      if (!custom) v.webContents.setUserAgent(content.webContents.getUserAgent());
      v.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/.test(url)) void shell.openExternal(url);
        return { action: 'deny' };
      });
      if (custom) void v.webContents.loadURL(custom.url);
      else {
        policeDock(v.webContents);
        void v.webContents.loadURL(studioDockUrl(kind as StudioDockKind));
      }
      win.contentView.addChildView(v);
      studioDockViews.set(kind, v);
    }
    const x = Math.max(0, r.x);
    const y = Math.max(0, r.y);
    v.setBounds({
      x: Math.round(x * zoom),
      y: Math.round(TITLEBAR_H + y * zoom),
      width: Math.round(Math.max(0, Math.min(r.width, width / zoom - x)) * zoom),
      height: Math.round(Math.max(0, Math.min(r.height, (height - TITLEBAR_H) / zoom - y)) * zoom),
    });
    v.setVisible(true);
  }
}

/**
 * A dock in a window of its own (OBS's floating docks): same page and session as in the editor's column, one window
 * per dock; the page hides it in the column meanwhile and shows it again when the window closes.
 */
const dockWindows = new Map<string, BrowserWindow>();
function openDockWindow(key: string): boolean {
  if (!studioDockKeys().includes(key)) return false;
  const open = dockWindows.get(key);
  if (open && !open.isDestroyed()) {
    open.focus();
    return true;
  }
  const custom = key.startsWith('custom:') ? config.studio.customDocks.find((d) => `custom:${d.id}` === key) : null;
  const w = new BrowserWindow({
    width: 420,
    height: 640,
    backgroundColor: '#110f13',
    title: custom ? custom.name : 'Trigglow',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: custom
      ? { partition: 'persist:studio-custom-docks', contextIsolation: true, nodeIntegration: false, sandbox: true }
      : { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  if (custom) void w.loadURL(custom.url);
  else {
    w.webContents.setUserAgent(content?.webContents.getUserAgent() ?? w.webContents.getUserAgent());
    policeDock(w.webContents);
    void w.loadURL(studioDockUrl(key as StudioDockKind));
  }
  w.on('closed', () => {
    dockWindows.delete(key);
    studioSend('shell:studio-dock-window', { key, open: false });
  });
  dockWindows.set(key, w);
  return true;
}

/**
 * A Studio dock may only be its own /dock page: it rewrites its own address (history.replaceState) and may reload
 * itself to drop the dashboard's service worker. policeNavigation would send those to the system browser, where the
 * dock (without Studio's session) shows its link screen. Anything else it navigates to opens in the browser.
 */
function policeDock(wc: Electron.WebContents) {
  const origin = new URL(WEB_URL).origin;
  const ownDock = (url: string) => {
    try {
      const u = new URL(url);
      return u.origin === origin && /^\/dock\/(activity|chat)\/?$/.test(u.pathname);
    } catch {
      return false;
    }
  };
  const guard = (e: { preventDefault(): void; isMainFrame: boolean }, url: string) => {
    if (!e.isMainFrame || ownDock(url)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
}

/** A new editor view to the page and the preview layer, except to `from` (who made the change and has it already). */
function broadcastStudioView(v: unknown, from?: Electron.WebContents) {
  if (studioOverlay && !studioOverlay.isDestroyed() && studioOverlay.webContents !== from) studioOverlay.webContents.send('shell:studio-view', v);
  if (studioFrame && !studioFrame.isDestroyed() && from !== content?.webContents) studioSend('shell:studio-view', v);
}

let baseUserAgent = '';
function applyUserAgent() {
  content?.webContents.setUserAgent(`${baseUserAgent}${studio.running ? ' TrigglowEngine/1' : ''}`);
}

/** Studio is running but the streamer picked their OBS: a relaunch applies the choice. */
function studioRestartNeeded() {
  return studio.running && !studioEnabled();
}

/** The streamer picked an engine (onboarding or Settings). Studio starts right away; turning it off needs a relaunch. */
function applyEngine() {
  if (studioEnabled() && !studio.running) {
    startStudio();
    applyUserAgent();
    if (view === 'app') reloadView(); // the dashboard picks up the Studio page in its sidebar
  }
  broadcast();
}

function startStudio() {
  if (studio.running) return;
  try {
    studio.delayBadgePrefix = delayBadgePrefix();
    studio.start(path.join(app.getPath('userData'), 'studio'), VERSION, studioNames(), config.studio, appLocale(), studioCanvas());
    void renderDelayBadges();
  } catch (err) {
    console.error('[studio]', err);
    return;
  }
  studio.onSignal = (s) => {
    studioSend('shell:studio-signal', s);
    studioLink.signal(s);
  };
  // The mixer's meters (only while the Studio page shows), and the highlight detector's audio.
  studio.onLevels = (levels) => {
    studioLink.levels(levels);
    if (studioRect) studioSend('shell:studio-levels', levels);
  };
  studio.replaySeconds = config.prefs.clipSeconds ?? 30;
  syncStudioReplay();
  studio.setOverlayBase(overlayBase());
  let crashReported = false;
  studioStatsTimer = setInterval(() => {
    if (!studio.alive()) {
      if (!crashReported) {
        crashReported = true;
        // The dead engine's preview window went with its process; nothing to hide (and no call may reach it).
        studioSend('shell:studio-signal', { output: 'engine', signal: 'crashed', code: 0, error: '' });
        new Notification({ title: 'Trigglow Studio', body: nt('studio.crashed') }).show();
      }
      return;
    }
    if (studioRect) studioSend('shell:studio-stats', studio.stats());
  }, 1000);
  applyHotkeys(); // Studio's shortcuts need the engine running
}

/* ------------------------------- clip that ------------------------------- */

let hotkeyStatus: 'off' | 'ok' | 'in_use' | 'invalid' = 'off';
let registeredHotkey: string | null = null;

let controlStatus: Partial<Record<ControlAction, 'ok' | 'in_use'>> = {};

/**
 * (Re)registers every global shortcut from the current prefs — the "save clip" one and the overlay controls — and
 * records how each went. Starts from a clean slate so a changed or removed shortcut never lingers.
 */
function applyHotkeys() {
  globalShortcut.unregisterAll();
  registeredHotkey = null;
  const reg = (accelerator: string, handler: () => void): boolean => {
    try {
      return globalShortcut.register(accelerator, handler); // false when another app owns the combination
    } catch {
      return false;
    }
  };

  const { clipEnabled, clipHotkey } = config.prefs;
  if (!clipEnabled) hotkeyStatus = 'off';
  else if (!isValidAccelerator(clipHotkey)) hotkeyStatus = 'invalid';
  else {
    const ok = reg(clipHotkey, () => void runClip());
    registeredHotkey = ok ? clipHotkey : null;
    hotkeyStatus = ok ? 'ok' : 'in_use';
  }

  controlStatus = {};
  for (const action of CONTROL_ACTIONS) {
    const accelerator = config.prefs.controlHotkeys[action];
    if (accelerator) controlStatus[action] = reg(accelerator, () => void runControl(action)) ? 'ok' : 'in_use';
  }

  // Trigglow Studio: start/stop the stream and the recording from anywhere (only while its engine runs).
  if (studio.running) {
    const { hotkeyStream, hotkeyRecord } = config.studio;
    if (hotkeyStream) reg(hotkeyStream, () => void toggleStudioStream());
    if (hotkeyRecord && hotkeyRecord !== hotkeyStream) reg(hotkeyRecord, toggleStudioRecording);
    const { hotkeyDelay } = config.studio;
    if (hotkeyDelay && hotkeyDelay !== hotkeyStream && hotkeyDelay !== hotkeyRecord) reg(hotkeyDelay, toggleStudioDelay);
    // The collection's own (Settings → Hotkeys): scenes, items, mute/unmute; held ones (push to talk/mute) are polled.
    const taken = new Set([hotkeyStream, hotkeyRecord, hotkeyDelay].filter(Boolean));
    const { pressed, held } = studio.collectionHotkeys();
    for (const h of pressed) {
      if (taken.has(h.accelerator)) continue;
      taken.add(h.accelerator);
      reg(h.accelerator, () => {
        studio.runHotkey(h.key);
        broadcastStudioView(studio.view());
      });
    }
    watchHeldKeys(
      held.map((h) => h.accelerator),
      (i, down) => {
        studio.holdHotkey(held[i].key, down);
        broadcastStudioView(studio.view());
      },
    );
    // Push to talk starts silent, like OBS.
    for (const h of held) if (h.key.startsWith('ptt:')) studio.holdHotkey(h.key, false);
  } else watchHeldKeys([], () => {});
}

async function toggleStudioStream() {
  if (!studio.alive()) return;
  try {
    if (studio.stats()?.streaming) studio.stopStream();
    else studio.startStream(await resolveStudioTarget());
  } catch (err) {
    studioSend('shell:studio-signal', { output: 'stream', signal: 'stop', code: 0, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Dynamic Delay on or off. Like the plugin in OBS, it needs a Trigglow account (signed in). */
function toggleStudioDelay() {
  if (!studio.alive()) return;
  try {
    if (!user && studio.delayView().state === 'off') throw new Error('signin_required');
    studio.toggleDelay();
  } catch (err) {
    studioSend('shell:studio-signal', { output: 'delay', signal: 'error', code: 0, error: err instanceof Error ? err.message : String(err) });
  }
  studioSend('shell:studio-stats', studio.stats());
}

function toggleStudioRecording() {
  if (!studio.alive()) return;
  try {
    if (studio.stats()?.recording) studio.stopRecording();
    else studio.startRecording();
  } catch (err) {
    studioSend('shell:studio-signal', { output: 'record', signal: 'stop', code: 0, error: err instanceof Error ? err.message : String(err) });
  }
}

let lastControlFailure = 0;

/** A control shortcut fired: same effect as the dashboard's control bar. Silent on success (the overlay reacts). */
async function runControl(action: ControlAction) {
  if (!overlayId) return;
  if (await sendControl(API_ORIGIN, overlayId, action)) return;
  if (Date.now() - lastControlFailure > 30_000) {
    lastControlFailure = Date.now();
    showNotification({ kind: 'control', title: nt('control.err.title'), body: nt('control.err.body') }, true);
  }
}

/* ------------------------------ notifications ------------------------------ */

const burst = new Burst();
let burstTimer: NodeJS.Timeout | null = null;

/** Opens a path inside the app (notification clicks). Paths are validated as /app/... when they arrive. */
function openAppPath(url: string) {
  showWindow();
  if (view === 'app') void content?.webContents.loadURL(`${new URL(WEB_URL).origin}${url}`);
}

/** Native notification for something the server says the streamer wants to know about (kinds are chosen in Settings → Notifications). */
function showNotification(n: DesktopNotification, bypass = false) {
  if (!Notification.isSupported()) return;
  if (!bypass && !burst.take(Date.now())) {
    // A raid or a run of subs would bury the desktop: the first few show, the rest become one summary.
    burstTimer ??= setTimeout(() => {
      burstTimer = null;
      const more = burst.flush();
      if (more > 0) showNotification({ kind: 'summary', title: nt('notify.more', { n: String(more) }), body: nt('notify.more.body'), url: '/app/activity' }, true);
    }, 10_000);
    return;
  }
  const note = new Notification({ title: n.title, body: n.body });
  note.on('click', () => openAppPath(n.url ?? '/app/activity'));
  note.show();
}

/** The length lives in OBS's profile: live through the WebSocket when connected, else written to its config while OBS is closed. */
async function applyReplayLength(seconds: number) {
  try {
    if (studio.running) {
      await studioLink.setReplaySeconds(seconds);
      lengthStatus = 'applied';
    } else if (obs.state === 'connected') {
      await obs.setReplaySeconds(seconds);
      lengthStatus = 'applied';
    } else if ((await isObsRunning()) === false) {
      lengthStatus = setReplaySecondsInProfile(seconds) ? 'pending' : 'failed'; // OBS reads it the next time it starts
    } else {
      lengthStatus = 'failed'; // open but not connected: nothing we can safely change
    }
  } catch {
    lengthStatus = 'failed';
  }
}

/** Tells the API whether a Stream Deck "Create clip" key can be served here (Replay Buffer ready and the shortcut feature on). */
let autoHighlights: AutoHighlights | null = null;
let gameHighlights: GameHighlightWatcher | null = null;
let lastCaps: boolean | null = null;
function publishCaps(force = false) {
  const ready = config.prefs.clipEnabled && engine().state === 'connected' && engine().replayActive === true;
  if (!force && ready === lastCaps) return;
  lastCaps = ready;
  api.sendCaps({ replayClip: ready });
}

const clipMaxHeight = () => ({ source: null, '1080p': 1080, '720p': 720 })[config.prefs.clipQuality];

async function runClip(opts: { announce?: boolean } = {}) {
  const outcome = await clipNow(engine(), API_ORIGIN, openClips, {
    announce: opts.announce && config.prefs.clipAnnounce,
    maxBytes: clipLimits.maxBytes,
    maxHeight: clipMaxHeight(),
    visibility: config.prefs.clipVisibility,
    title: config.prefs.clipTitle,
    announceText: config.prefs.clipAnnounceText,
    deferUpload: config.prefs.clipUploadMode === 'after_stream',
    account: overlayId,
  });
  broadcast();
  return outcome;
}

function openClips() {
  showWindow();
  if (view === 'app') void content?.webContents.loadURL(`${new URL(WEB_URL).origin}/app/clips`);
}

function reloadView() {
  // Reload the page the user is on; only fall back to the dashboard home when there's no web page to reload (e.g. a failed load).
  const url = content?.webContents.getURL();
  if (view === 'app' && url && classifyNav(url) === 'allow') content?.webContents.reload();
  else if (view === 'app') void enterApp();
  else if (view === 'onboarding') showOnboarding();
  else showSignIn();
}

function showWindow() {
  if (!win) createWindow();
  win?.show();
  win?.focus();
}

/* ------------------------------ overlay packs ------------------------------ */

// Double-clicked .overlaytrigglow files (pack-open.ts): uploaded with the user's session and opened in the normal
// import wizard (Colecciones ?pack=<id>). Waits for sign-in; one at a time.
const pendingPacks: string[] = packFilesFromArgv(process.argv);
let packBusy = false;

function queuePacks(files: string[]) {
  if (!files.length) return;
  pendingPacks.push(...files);
  void openPendingPacks();
}

const PACK_ERRORS = ['not_a_pack', 'too_large', 'too_many_files', 'too_many_alerts', 'newer_format', 'packs_disabled', 'rate_limited'];

function packNotice(code: string) {
  const key = (PACK_ERRORS.includes(code) ? `pack.err.${code}` : 'pack.err.generic') as MsgKey;
  new Notification({ title: nt('pack.title'), body: nt(key) }).show();
}

async function openPendingPacks() {
  if (packBusy || view !== 'app' || !pendingPacks.length) return;
  packBusy = true;
  try {
    while (pendingPacks.length) {
      const file = pendingPacks[0]!;
      let outcome: ReturnType<typeof packStageOutcome>;
      try {
        if ((await fs.promises.stat(file)).size > PACK_MAX_BYTES) outcome = { kind: 'error', code: 'too_large' };
        else {
          const res = await session.defaultSession.fetch(`${API_ORIGIN}/api/overlay-packs/staged`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/octet-stream' },
            body: await fs.promises.readFile(file),
          });
          outcome = packStageOutcome(res.status, (await res.json().catch(() => ({}))) as { id?: string; error?: string });
        }
      } catch {
        outcome = { kind: 'error', code: 'generic' };
      }
      if (outcome.kind === 'signed_out') return; // kept; enterApp() retries after sign-in
      pendingPacks.shift();
      const origin = new URL(WEB_URL).origin;
      if (outcome.kind === 'wizard') {
        showWindow();
        await content?.webContents.loadURL(`${origin}/app/collections?pack=${encodeURIComponent(outcome.id)}`);
      } else if (outcome.kind === 'redeem') {
        showWindow();
        await content?.webContents.loadURL(`${origin}/app/redeem`);
      } else packNotice(outcome.code);
    }
  } finally {
    packBusy = false;
  }
}

/** App settings live in the web's own Settings page (a "Desktop app" tab, shown only in this shell). */
function openSettings() {
  showWindow();
  if (view === 'app') void content?.webContents.loadURL(`${new URL(WEB_URL).origin}/app/settings?tab=desktop`);
}

/** The dashboard's "Stream title & category" card (updates every connected platform at once). */
function openStreamInfo() {
  showWindow();
  if (view === 'app') void content?.webContents.loadURL(`${new URL(WEB_URL).origin}/app#stream-info`);
}

function createTray() {
  tray?.destroy(); // never leave a second icon behind
  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'icon.png')).resize({ width: 18, height: 18 }));
  tray.on('click', showWindow);
  setTrayMenu();
}

/** Rebuilt when an update becomes ready and when the app's language changes (the icon itself stays put). */
function setTrayMenu() {
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: nt('tray.open'), click: showWindow },
      { label: nt('tray.clip'), click: () => void runClip() },
      { label: nt('tray.stream'), click: openStreamInfo },
      { label: nt('tray.settings'), click: openSettings },
      { label: nt('tray.signout'), click: () => void signOut() },
      { type: 'separator' },
      ...(updater.state.status === 'ready' ? [{ label: nt('tray.update', { version: String(updater.state.version) }), click: installUpdate }] : []),
      { label: nt('tray.quit'), click: () => app.quit() },
    ]),
  );
  refreshTrayTip();
}

function refreshTrayTip() {
  tray?.setToolTip(studioEnabled() ? 'Trigglow Studio' : `Trigglow Studio — ${nt(obs.state === 'connected' ? 'tray.obs.connected' : 'tray.obs.off')}`);
}

let trayUpdateShown = false;
function refreshTrayMenu() {
  refreshTrayTip();
  const ready = updater.state.status === 'ready';
  if (ready !== trayUpdateShown && tray) {
    trayUpdateShown = ready;
    setTrayMenu();
  }
}

function createMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Trigglow Studio',
        submenu: [
          { label: nt('tray.settings'), accelerator: 'CmdOrCtrl+,', click: openSettings },
          { label: nt('menu.reload'), accelerator: 'CmdOrCtrl+R', click: () => reloadView() },
          { label: nt('tray.signout'), click: () => void signOut() },
          ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
          { type: 'separator' },
          { label: nt('tray.quit'), accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
        ],
      },
    ]),
  );
}

/* -------------------------------- IPC -------------------------------- */

/** Only the app's own bundled screens may call these — never a web page. */
function local(e: IpcMainInvokeEvent) {
  if (!isLocalPage(e.senderFrame?.url)) throw new Error('untrusted sender');
  // When framed (the settings panel inside the web app) the parent must be a trusted Trigglow page.
  const parent = e.senderFrame?.parent;
  if (parent && !isTrustedUrl(parent.url) && !isLocalPage(parent.url)) throw new Error('untrusted parent');
}

function registerIpc() {
  // Decides whether the preload exposes `trigglowShell` (senderFrame.url can lag at preload time);
  // every handler below re-checks the real sender.
  ipcMain.on('shell:is-local', (e, href: unknown) => {
    e.returnValue = typeof href === 'string' && isLocalPage(href);
  });
  ipcMain.handle('shell:state', (e) => {
    local(e);
    return state();
  });
  // i18n.js asks while the page loads; `chosen`: config.json has a language (picked here, or the account's).
  ipcMain.on('shell:locale', (e) => {
    e.returnValue = isLocalPage(e.senderFrame?.url) ? { locale: appLocale(), chosen: config.prefs.locale !== null } : null;
  });
  ipcMain.handle('shell:set-locale', async (e, raw: unknown, fresh: unknown) => {
    local(e);
    const locale = toAppLocale(raw);
    if (!locale) return;
    if (fresh === false) {
      // A pick a screen kept from before the main process stored one: remembered here, never pushed over the account's.
      if (config.prefs.locale === null) setLocalePrefs({ locale, localePending: false });
    } else {
      // Picked just now: wins everywhere, and goes to the account (now if signed in, else at the next sign-in).
      setLocalePrefs({ locale, localePending: true });
    }
    applyLocale();
    if (fresh !== false && user) await saveLocaleToAccount(locale);
  });
  ipcMain.handle('shell:signin', (e) => {
    local(e);
    void signIn.start();
  });
  ipcMain.handle('shell:signin-cancel', (e) => {
    local(e);
    signIn.cancel();
  });
  ipcMain.handle('shell:signout', async (e) => {
    local(e);
    await signOut();
  });
  ipcMain.handle('shell:open-external', (e, url: unknown) => {
    local(e);
    // Only ever the verification URL we were handed by our own sign-in flow.
    if (typeof url === 'string' && url === signIn.state.url && isTrustedUrl(url)) void shell.openExternal(url);
  });
  ipcMain.handle('shell:obs-scenes', (e) => {
    local(e);
    return obs.listScenes();
  });
  ipcMain.handle('shell:obs-install', async (e, req: { scene?: unknown; name?: unknown; url?: unknown }) => {
    local(e);
    const { scene, name, url } = req;
    // Only our own overlay pages, under a recognisable source name — never an arbitrary URL or OBS input.
    const overlay = typeof url === 'string' && isTrustedUrl(url) ? new URL(url) : null;
    if (
      typeof scene !== 'string' || !scene || scene.length > 200 ||
      typeof name !== 'string' || !/^Trigglow [\w .-]{1,60}$/.test(name) ||
      !overlay || !overlay.pathname.startsWith('/overlay/') || overlay.username || overlay.password
    ) {
      throw new Error('invalid overlay install request');
    }
    return obs.installBrowserSource({ scene, name, url: overlay.href, placement: overlayPlacement(overlay.pathname) });
  });
  ipcMain.handle('shell:nav', (e, action: unknown) => {
    local(e);
    const h = content?.webContents.navigationHistory;
    if (action === 'back' && view === 'app' && h?.canGoBack()) h.goBack();
    else if (action === 'forward' && view === 'app' && h?.canGoForward()) h.goForward();
    else if (action === 'reload') reloadView();
    else if (action === 'settings') openSettings();
    else if (action === 'multistream') void content?.webContents.loadURL(`${new URL(WEB_URL).origin}/app/multistream`);
    else if (action === 'link-twitch' && view === 'app') {
      // Re-link Twitch (in the system browser) to grant a permission added later (intent=link forces the consent screen).
      void openLinkInBrowser(`${API_ORIGIN}/auth/twitch/start?intent=link&next=${encodeURIComponent('/app/settings?tab=desktop')}`);
    }
    else if (action === 'billing') void content?.webContents.loadURL(`${new URL(WEB_URL).origin}/app/settings?tab=billing`);
  });
  ipcMain.handle('shell:save-obs', (e, cfg: { mode?: unknown; host?: unknown; port?: unknown; password?: unknown }) => {
    local(e);
    if (cfg.mode !== 'manual') {
      config = { ...config, obs: { ...config.obs, mode: 'auto' } };
    } else {
      const host = typeof cfg.host === 'string' ? cfg.host.trim() : '';
      const port = Number(cfg.port);
      if (!host || host.length > 255 || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('invalid OBS config');
      }
      // Empty/missing password keeps the stored one.
      const password = typeof cfg.password === 'string' && cfg.password ? cfg.password : config.obs.password;
      config = { ...config, obs: { mode: 'manual', host, port, password } };
    }
    saveConfig(config);
    obs.configure(resolveObs);
    return state();
  });
  ipcMain.handle('shell:obs-fix', (e, confirmRestart: unknown) => {
    local(e);
    if (config.obs.mode !== 'auto') return 'nothing' satisfies FixResult; // manual setups are the user's own
    return fixObs(confirmRestart === true);
  });
  ipcMain.handle('shell:obs-retry', (e) => {
    local(e);
    obs.retryNow();
  });
  // The streamer's own overlay URLs, built here from their session — so setup never asks them to copy anything.
  ipcMain.handle('shell:overlays', (e) => {
    local(e);
    if (!overlayId) return [];
    const base = `${new URL(WEB_URL).origin}/overlay/${encodeURIComponent(overlayId)}`;
    return [
      { id: 'alerts', name: 'Trigglow Alerts', url: base },
      { id: 'chat', name: 'Trigglow Chat', url: `${base}/chat` },
      { id: 'quests', name: 'Trigglow Quests', url: `${base}/quests` },
      // Same source names as the web's "Add to OBS" guide, so installing from either place never creates a duplicate.
      { id: 'giveaway', name: 'Trigglow Giveaways', url: `${base}/giveaway` },
      { id: 'loyalty', name: 'Trigglow Loyalty', url: `${base}/loyalty` },
      { id: 'music', name: 'Trigglow Music', url: `${base}/music-requests` },
      { id: 'activity', name: 'Trigglow Activity', url: `${base}/activity` },
      { id: 'goals', name: 'Trigglow Goals', url: `${base}/goals` },
      { id: 'credits', name: 'Trigglow Credits', url: `${base}/credits` },
      { id: 'emotes', name: 'Trigglow Emotes', url: `${base}/emotes` },
    ];
  });
  ipcMain.handle('shell:onboarding-done', async (e) => {
    local(e);
    config = { ...config, onboarded: true };
    saveConfig(config);
    await enterApp();
  });
  ipcMain.handle('shell:onboarding-restart', (e) => {
    local(e);
    showOnboarding();
  });
  // While the settings panel records a new shortcut the current one must not fire (the OS would swallow the keys).
  ipcMain.handle('shell:hotkey-capture', (e, on: unknown) => {
    local(e);
    if (on === true) {
      globalShortcut.unregisterAll();
      registeredHotkey = null;
    } else applyHotkeys();
  });
  ipcMain.handle('shell:text-add', (e, id: unknown) => {
    local(e);
    const ts = textSources;
    const item = ts && isBindingId(id) ? ts.available().find((a) => a.id === id) : undefined;
    if (!ts || !item || !isBindingId(id)) throw new Error('unknown data source');
    ts.add(id, defaultSourceName(id, item.label), defaultTemplate(id));
    void ts.create(id, null); // best effort: make the OBS source for them (current scene) and fill it
    broadcast();
    return state();
  });
  ipcMain.handle('shell:text-update', (e, req: { id?: unknown; source?: unknown; template?: unknown }) => {
    local(e);
    if (!textSources || !isBindingId(req.id)) throw new Error('unknown binding');
    const patch: { source?: string; template?: string } = {};
    if (req.source !== undefined) {
      const source = cleanSourceName(req.source);
      if (!source) throw new Error('invalid source name');
      patch.source = source;
    }
    if (req.template !== undefined) {
      const template = cleanTemplate(req.template);
      if (!template) throw new Error('invalid template');
      patch.template = template;
    }
    textSources.update(req.id, patch);
    void textSources.sync(true);
    broadcast();
    return state();
  });
  ipcMain.handle('shell:text-remove', (e, id: unknown) => {
    local(e);
    if (!textSources || !isBindingId(id)) throw new Error('unknown binding');
    textSources.remove(id);
    broadcast();
    return state();
  });
  ipcMain.handle('shell:text-create', (e, id: unknown) => {
    local(e);
    if (!textSources || !isBindingId(id)) throw new Error('unknown binding');
    void textSources.create(id, null);
    return state();
  });
  ipcMain.handle('shell:notify-test', (e) => {
    local(e);
    showNotification({ kind: 'test', title: nt('notify.test.title'), body: nt('notify.test.body'), url: '/app/settings?tab=notifications' }, true);
  });
  ipcMain.handle('shell:clip-now', (e) => {
    local(e);
    return runClip();
  });
  ipcMain.handle('shell:replay-fix', (e, confirmRestart: unknown) => {
    local(e);
    return fixReplay(confirmRestart === true);
  });
  ipcMain.handle('shell:replay-start', async (e) => {
    local(e);
    try {
      await engine().startReplayBuffer();
      return true;
    } catch {
      return false; // not enabled in OBS's output settings
    }
  });
  ipcMain.handle('shell:update-check', (e) => {
    local(e);
    updater.check();
    return state();
  });
  // Applies an engine switch that needs a fresh process (Settings → Engine). Never mid-stream: that would cut it.
  // Studio pop-ups: opened by the Studio page, answered by the pop-up page itself (and only by it).
  ipcMain.handle('shell:studio-popup', (e, req: { kind?: unknown; source?: unknown; filter?: unknown; title?: unknown; value?: unknown; message?: unknown; item?: unknown }) => {
    local(e);
    if (!studio.running) return null;
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
    const kind = str(req?.kind, 20);
    if (!(kind in POPUP_SIZES)) return null;
    return openStudioPopup({ kind, source: str(req.source, 100), filter: str(req.filter, 100), title: str(req.title, 200), value: str(req.value, 100), message: str(req.message, 300), item: Number.isInteger(req.item) ? String(req.item) : '' });
  });
  // Right-click menus of the Studio page (sources, scenes, mixer), native like OBS's: an HTML menu would fall behind
  // the engine's preview window. Resolves with the id of the picked entry, or null.
  ipcMain.handle('shell:studio-menu', (e, items: unknown) => {
    local(e);
    if (!win || !Array.isArray(items)) return null;
    return new Promise((resolve) => {
      let picked: string | null = null;
      const build = (list: unknown[], depth: number): Electron.MenuItemConstructorOptions[] =>
        list.slice(0, 40).map((raw) => {
          const it = (raw ?? {}) as { id?: unknown; label?: unknown; type?: unknown; checked?: unknown; enabled?: unknown; submenu?: unknown };
          if (it.type === 'separator') return { type: 'separator' };
          const label = typeof it.label === 'string' ? it.label.slice(0, 80) : '';
          if (Array.isArray(it.submenu) && depth < 3) return { label, submenu: build(it.submenu, depth + 1) };
          const id = typeof it.id === 'string' ? it.id.slice(0, 60) : '';
          return {
            label,
            enabled: it.enabled !== false,
            ...(it.type === 'checkbox' ? { type: 'checkbox' as const, checked: it.checked === true } : {}),
            click: () => (picked = id),
          };
        });
      Menu.buildFromTemplate(build(items, 0)).popup({ window: win as unknown as BrowserWindow, callback: () => resolve(picked) });
    });
  });
  ipcMain.handle('shell:studio-popup-done', (e, value: unknown) => {
    local(e);
    if (!studioPopup || e.sender !== studioPopup.webContents) return;
    studioPopupDone?.(typeof value === 'string' || typeof value === 'boolean' ? value : null);
  });
  // The engine's own logs (libobs writes them under its data folder), to attach to a bug report after a crash.
  ipcMain.handle('shell:studio-logs', (e) => {
    local(e);
    return shell.openPath(path.join(app.getPath('userData'), 'studio', 'node-obs', 'logs'));
  });
  ipcMain.handle('shell:relaunch', (e) => {
    local(e);
    if (studio.alive() && studio.stats()?.streaming) return false;
    app.relaunch();
    quitting = true;
    app.quit();
    return true;
  });
  ipcMain.handle('shell:update-install', (e) => {
    local(e);
    installUpdate();
  });
  // Goes live to the target saved in Settings → Trigglow Studio; its server and key come from the API right now.
  ipcMain.handle('shell:studio-stream-start', async (e) => {
    local(e);
    if (!studio.running || !studio.alive()) return { ok: false, error: 'not_running' };
    try {
      return { ok: true, ...studio.startStream(await resolveStudioTarget()) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  // studio.html (framed by the dashboard's /app/studio) says where its preview area is, or null when it goes away.
  ipcMain.handle('shell:studio-preview', (e, rect: unknown) => {
    local(e);
    const r = rect as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
    const ok = r && [r.x, r.y, r.width, r.height].every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 100_000);
    studioRect = ok ? { x: r.x as number, y: r.y as number, width: Math.max(0, r.width as number), height: Math.max(0, r.height as number) } : null;
    const pr = (r as { program?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown } } | null)?.program;
    const pok = studioRect && pr && [pr.x, pr.y, pr.width, pr.height].every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 100_000);
    studioProgramRect = pok ? { x: pr.x as number, y: pr.y as number, width: Math.max(0, pr.width as number), height: Math.max(0, pr.height as number) } : null;
    studioFrame = studioRect ? e.senderFrame : null;
    layoutStudio();
    return { running: studio.running };
  });
  // studio.html says where each dock's body is (web CSS px, null = hidden or folded), or null when the page goes away.
  ipcMain.handle('shell:studio-docks', (e, rects: unknown) => {
    local(e);
    const next: typeof studioDockRects = {};
    const raw = (rects && typeof rects === 'object' ? rects : {}) as Record<string, unknown>;
    for (const kind of studioDockKeys()) {
      const r = raw[kind] as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null | undefined;
      const ok = r && [r.x, r.y, r.width, r.height].every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 100_000);
      next[kind] = ok ? { x: r.x as number, y: r.y as number, width: Math.max(0, r.width as number), height: Math.max(0, r.height as number) } : null;
    }
    studioDockRects = next;
    layoutStudioDocks();
  });
  // The Studio page's editor: scenes, sources, mixer and source properties. Every op returns the new view.
  ipcMain.handle('shell:studio', async (e, req: { op?: unknown; name?: unknown; id?: unknown; value?: unknown; type?: unknown; trigglow?: unknown; dir?: unknown; changes?: unknown; filter?: unknown }) => {
    const dir = req?.dir === 'up' || req?.dir === 'down' || req?.dir === 'top' || req?.dir === 'bottom' ? req.dir : 'down';
    const value = (req?.value && typeof req.value === 'object' ? req.value : {}) as Record<string, unknown>;
    local(e);
    if (!studio.running || !studio.alive()) return { view: null, crashed: studio.hasCrashed };
    const name = typeof req?.name === 'string' ? req.name : '';
    const filter = typeof req?.filter === 'string' && req.filter ? req.filter : undefined;
    const id = Number(req?.id);
    try {
      switch (req?.op) {
        case 'view':
          break;
        case 'select-scene':
          studio.selectScene(name);
          break;
        case 'add-scene':
          studio.addScene(req.name);
          break;
        case 'remove-scene':
          studio.removeScene(name);
          break;
        case 'add-source':
          studio.addSource({ type: req.type, trigglow: req.trigglow }, req.name);
          break;
        case 'remove-item':
          studio.removeItem(id);
          break;
        case 'visible':
          studio.setVisible(id, req.value === true);
          break;
        case 'move':
          studio.moveItem(id, dir);
          break;
        case 'rename':
          return { name: studio.rename(name, req.value), view: studio.view() };
        // Migration from OBS / Streamlabs (Settings → Trigglow Studio): what's on this PC, the import, and going back.
        case 'import-list': {
          const profile = obsProfile();
          return { collections: findCollections(), profile: Boolean(profile), hasKey: Boolean(profile && obsService(profile.service)), backup: studio.hasBackup() };
        }
        case 'import':
          return importIntoStudio(value);
        case 'import-undo': {
          const stats = studio.stats();
          if (stats?.streaming || stats?.recording) return { error: 'studio_busy' };
          if (!studio.hasBackup()) return { error: 'import_unreadable' };
          studio.replaceCollection(null, studioNames(), true);
          break;
        }
        case 'folder-add':
          studio.addFolder(Array.isArray(value.items) ? value.items.map(Number).filter(Number.isFinite) : [], value.name);
          break;
        case 'folder': {
          const action = String(value.action);
          if (!['rename', 'toggle', 'show', 'hide', 'lock', 'unlock', 'ungroup'].includes(action)) return { error: 'bad_action' };
          studio.folderAction(name, action as Parameters<typeof studio.folderAction>[1], value.name);
          break;
        }
        case 'item-folder':
          studio.setItemFolder(id, typeof req.value === 'string' ? req.value : null);
          break;
        // OBS's auto-configuration: the recommendation comes back to Settings, which applies it on a click.
        case 'auto-config': {
          const target = config.studio.target;
          const platform = target === MULTISTREAM_TARGET ? 'multistream' : target === 'account:twitch' ? 'twitch' : target === 'account:youtube' ? 'youtube' : target.startsWith('key:') ? (config.studioKeys.find((k) => `key:${k.id}` === target)?.platform ?? 'custom') : 'custom';
          const p = platform === 'twitch' || platform === 'youtube' || platform === 'multistream' ? platform : 'custom';
          // Twitch: its bandwidth test needs the key (it never goes live); the rest only estimate.
          const creds = p === 'twitch' ? await resolveStudioTarget().catch(() => null) : null;
          return { recommendation: await studio.autoConfigure({ platform: p, ...(creds ?? {}) }) };
        }
        // Custom browser docks (OBS's Docks → Custom browser docks).
        case 'custom-docks':
          return { docks: config.studio.customDocks };
        case 'custom-dock-add': {
          const url = validDockUrl(value.url);
          const label = typeof value.name === 'string' ? value.name.trim().slice(0, 60) : '';
          if (!url || !label) return { error: 'bad_dock' };
          if (config.studio.customDocks.length >= MAX_CUSTOM_DOCKS) return { error: 'too_many_docks' };
          config = { ...config, studio: { ...config.studio, customDocks: [...config.studio.customDocks, { id: `dock-${randomBytes(4).toString('hex')}`, name: label, url }] } };
          saveConfig(config);
          return { docks: config.studio.customDocks };
        }
        case 'dock-window':
          return { ok: openDockWindow(name) };
        case 'custom-dock-remove':
          config = { ...config, studio: { ...config.studio, customDocks: config.studio.customDocks.filter((d) => d.id !== name) } };
          saveConfig(config);
          layoutStudioDocks();
          return { docks: config.studio.customDocks };
        case 'fonts':
          return { fonts: await installedFonts() };
        case 'studio-mode':
          studio.setStudioMode(req.value === true);
          break;
        case 'transition-now':
          studio.transitionToProgram();
          break;
        case 'screens':
          return { screens: screen.getAllDisplays().map((d, i) => ({ id: d.id, label: `${i + 1}: ${d.size.width}×${d.size.height}${d.id === screen.getPrimaryDisplay().id ? ' ★' : ''}` })) };
        case 'projector': {
          const kind = value.kind === 'scene' || value.kind === 'source' ? value.kind : 'program';
          const target = kind === 'program' ? { kind } : { kind, name: typeof value.name === 'string' ? value.name : '' };
          return { ok: openProjector(target as Parameters<typeof openProjector>[0], typeof value.screen === 'number' ? value.screen : null) };
        }
        case 'hotkey-targets':
          return { hotkeys: studio.hotkeyTargets() };
        case 'set-hotkey': {
          const ok = studio.setHotkey(name, typeof req.value === 'string' ? req.value.trim().slice(0, 50) : '');
          applyHotkeys();
          return { ok, hotkeys: studio.hotkeyTargets() };
        }
        case 'scene-transition':
          studio.setSceneTransition(name, req.value === null ? null : value);
          break;
        case 'add-trigglow-scene':
          studio.addTrigglowScene(req.value);
          break;
        case 'duplicate-scene':
          studio.duplicateScene(name, req.value);
          break;
        case 'move-scene':
          studio.moveScene(name, dir === 'up' ? 'up' : 'down');
          break;
        case 'existing':
          return { existing: studio.existing() };
        case 'add-existing':
          studio.addExisting(name);
          break;
        case 'duplicate-item':
          studio.duplicateItem(id);
          break;
        case 'lock':
          studio.setLocked(id, req.value === true);
          break;
        case 'item-transform':
          return { transform: studio.itemTransform(id) };
        case 'set-transform':
          studio.setItemTransform(id, value);
          return { transform: studio.itemTransform(id), view: studio.view() };
        case 'transform-action':
          studio.transformAction(id, typeof req.value === 'string' ? req.value : '');
          break;
        case 'perf':
          return { perf: studio.perf() };
        case 'audio-props':
          return { audio: studio.audioProps() };
        case 'set-audio':
          return { audio: studio.setAudioProps(name, value) };
        case 'move-filter':
          return studio.moveFilter(name, filter ?? '', dir === 'up' ? 'up' : 'down');
        case 'paste-filters':
          return studio.pasteFilters(typeof req.value === 'string' ? req.value : '', name);
        case 'press-button':
          return { properties: studio.pressButton(name, typeof req.value === 'string' ? req.value : '', filter) };
        // A file or folder for a path / file-list property (OBS's Browse…), from a real dialog.
        case 'pick-path': {
          if (!win) return { paths: [] };
          const type = Number(value.pathType);
          const filters = dialogFilters(typeof value.filter === 'string' ? value.filter : '');
          const defaultPath = typeof value.defaultPath === 'string' && value.defaultPath ? value.defaultPath : undefined;
          const owner = (studioPopup ?? win) as BrowserWindow;
          if (type === 1) {
            const r = await dialog.showSaveDialog(owner, { defaultPath, filters });
            return { paths: r.canceled || !r.filePath ? [] : [r.filePath] };
          }
          const r = await dialog.showOpenDialog(owner, {
            defaultPath,
            filters,
            properties: type === 2 ? ['openDirectory'] : value.multi === true ? ['openFile', 'multiSelections'] : ['openFile'],
          });
          return { paths: r.canceled ? [] : r.filePaths.slice(0, 500) };
        }
        case 'volume':
          studio.setVolume(name, Number(req.value));
          break;
        case 'mute':
          studio.setMuted(name, req.value === true);
          break;
        case 'select':
          studio.select(Number.isFinite(id) && req.id !== null ? id : null, req.value === 'add');
          break;
        case 'transform': {
          const v = (req.value ?? {}) as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
          studio.transform(id, v);
          break;
        }
        case 'region':
          return { region: studio.previewRegion() };
        case 'record-start':
          studio.startRecording();
          break;
        case 'record-stop':
          studio.stopRecording();
          break;
        case 'delay-toggle':
          if (!user && studio.delayView().state === 'off') throw new Error('signin_required');
          studio.toggleDelay();
          return { delay: studio.delayView() };
        case 'settings':
          return studioSettingsView();
        // Scene collections (the engine keeps them) and profiles (sets of these settings, kept in config.json).
        case 'collections':
          return { collections: studio.collections() };
        case 'collection': {
          const action = String(value.action);
          if (action === 'switch') studio.switchCollection(name);
          else if (action === 'add') studio.addCollection(value.name, value.copy === true);
          else if (action === 'rename') studio.renameCollection(name, value.name);
          else if (action === 'remove') studio.removeCollection(name);
          else return { error: 'bad_action' };
          applyHotkeys(); // the shortcuts belong to the collection
          return { collections: studio.collections(), view: studio.view() };
        }
        case 'profile': {
          const action = String(value.action);
          const profiles = structuredClone(config.studioProfiles);
          const busy = () => {
            const st = studio.stats();
            if (st?.streaming || st?.recording) throw new Error('studio_busy');
          };
          const toProfile = (id: string) => {
            const target = profiles.list.find((p) => p.id === id);
            if (!target || id === profiles.current) return;
            busy();
            const cur = profiles.list.find((p) => p.id === profiles.current)!;
            cur.settings = config.studio;
            const next = target.settings ?? config.studio;
            delete target.settings;
            profiles.current = id;
            config = { ...config, studio: next, studioProfiles: profiles };
            studio.setSettings(next);
          };
          if (action === 'switch') toProfile(name);
          else if (action === 'add') {
            if (profiles.list.length >= 50) return { error: 'too_many_profiles' };
            const id = `prf-${randomBytes(6).toString('hex')}`;
            const label = typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 80) : 'Profile';
            // A copy of the current settings, or the defaults (same recording folder).
            profiles.list.push({ id, name: label, settings: value.copy === true ? structuredClone(config.studio) : defaultStudioSettings(config.studio.recordFolder) });
            config = { ...config, studioProfiles: profiles };
            toProfile(id);
          } else if (action === 'rename') {
            const p = profiles.list.find((x) => x.id === name);
            if (p && typeof value.name === 'string' && value.name.trim()) p.name = value.name.trim().slice(0, 80);
            config = { ...config, studioProfiles: profiles };
          } else if (action === 'remove') {
            if (name === profiles.current || profiles.list.length <= 1) return { error: 'profile_in_use' };
            profiles.list = profiles.list.filter((p) => p.id !== name);
            config = { ...config, studioProfiles: profiles };
          } else return { error: 'bad_action' };
          saveConfig(config);
          applyHotkeys();
          return studioSettingsView();
        }
        case 'save-settings': {
          const next = normalizeStudioSettings(req.value, config.studio);
          config = { ...config, studio: next };
          saveConfig(config);
          const applied = studio.setSettings(next);
          applyHotkeys();
          return { ...(await studioSettingsView()), applied };
        }
        // A stream key pasted in Settings → Trigglow Studio (kept encrypted on this PC; the page never gets it back).
        case 'add-key': {
          if (config.studioKeys.length >= MAX_KEYS) return { error: 'too_many_keys', ...(await studioSettingsView()) };
          const k = newStudioKey((req.value ?? {}) as Record<string, unknown>, randomBytes(4).toString('hex'));
          if (!k) return { error: 'invalid_key', ...(await studioSettingsView()) };
          config = { ...config, studioKeys: [...config.studioKeys, k], studio: { ...config.studio, target: `key:${k.id}` } };
          saveConfig(config);
          return studioSettingsView();
        }
        case 'remove-key': {
          const id = typeof req.value === 'string' ? req.value : '';
          const target = config.studio.target === `key:${id}` ? MULTISTREAM_TARGET : config.studio.target;
          config = { ...config, studioKeys: config.studioKeys.filter((k) => k.id !== id), studio: { ...config.studio, target } };
          saveConfig(config);
          return studioSettingsView();
        }
        case 'pick-folder': {
          if (!win) return studioSettingsView();
          const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: config.studio.recordFolder });
          if (!r.canceled && r.filePaths[0]) {
            config = { ...config, studio: { ...config.studio, recordFolder: r.filePaths[0] } };
            saveConfig(config);
            studio.setSettings(config.studio);
          }
          return studioSettingsView();
        }
        // A global audio channel (1–2 desktop, 3–6 mic/aux): a device, or null to turn it off.
        case 'set-global-audio': {
          const ch = Number(value.channel);
          const device = typeof value.device === 'string' && value.device ? value.device : null;
          const base = nt(ch <= 2 ? 'studio.default.desktop' : 'studio.default.mic');
          studio.setGlobalAudio(ch, device, ch === 1 || ch === 3 ? base : `${base} ${ch <= 2 ? ch : ch - 2}`);
          return studioSettingsView();
        }
        // The encoder's own settings window: its libobs properties, saved per encoder id.
        case 'encoder-properties': {
          const id = typeof value.id === 'string' ? value.id : '';
          return { properties: studio.encoderProperties(id, config.studio.encoderSettings[id] ?? {}) };
        }
        case 'update-encoder-properties': {
          const id = typeof value.id === 'string' ? value.id : '';
          const kinds = new Map(studio.encoderProperties(id, config.studio.encoderSettings[id] ?? {}).map((p) => [p.name, p.kind]));
          const changes = (value.changes && typeof value.changes === 'object' ? value.changes : {}) as Record<string, unknown>;
          const merged: Record<string, string | number | boolean> = { ...(config.studio.encoderSettings[id] ?? {}) };
          for (const [k, v] of Object.entries(changes)) {
            const kind = kinds.get(k);
            const clean = kind ? cleanPropertyValue(kind, v) : undefined;
            if (typeof clean === 'string' || typeof clean === 'number' || typeof clean === 'boolean') merged[k] = clean;
          }
          const next = normalizeStudioSettings({ ...config.studio, encoderSettings: { ...config.studio.encoderSettings, [id]: merged } }, config.studio);
          config = { ...config, studio: next };
          saveConfig(config);
          studio.setSettings(next);
          return { properties: studio.encoderProperties(id, next.encoderSettings[id] ?? {}) };
        }
        case 'encoder-reset': {
          const id = typeof value.id === 'string' ? value.id : '';
          const rest = { ...config.studio.encoderSettings };
          delete rest[id];
          config = { ...config, studio: { ...config.studio, encoderSettings: rest } };
          saveConfig(config);
          studio.setSettings(config.studio);
          return { properties: studio.encoderProperties(id, {}) };
        }
        case 'pick-stinger': {
          if (!win) return studioSettingsView();
          const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Video', extensions: ['webm', 'mov', 'mp4', 'mkv', 'gif'] }] });
          if (!r.canceled && r.filePaths[0]) {
            config = { ...config, studio: { ...config.studio, stingerFile: r.filePaths[0], transition: 'stinger' } };
            saveConfig(config);
            studio.setSettings(config.studio);
          }
          return studioSettingsView();
        }
        case 'open-folder':
          void shell.openPath(config.studio.recordFolder);
          break;
        case 'properties':
          return { properties: studio.properties(name, filter) };
        case 'update-properties':
          return { properties: studio.updateProperties(name, req.changes && typeof req.changes === 'object' ? (req.changes as Record<string, unknown>) : {}, filter) };
        case 'filters':
          return studio.filters(name);
        case 'add-filter':
          return studio.addFilter(name, req.type);
        case 'remove-filter':
          return studio.removeFilter(name, filter ?? '');
        case 'filter-enabled':
          return studio.setFilterEnabled(name, filter ?? '', req.value === true);
        default:
          return { error: 'unknown_op' };
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err), view: studio.view() };
    }
    const next = studio.view();
    if (req?.op !== 'view') broadcastStudioView(next, e.sender);
    return { view: next };
  });
  // Right-click and double-click on the layer over the preview: the Studio page has the menus and pop-ups.
  ipcMain.on('shell:studio-overlay', (e, ev: unknown) => {
    if (!studioOverlay || e.sender !== studioOverlay.webContents) return;
    const v = (ev ?? {}) as { type?: unknown; id?: unknown };
    if ((v.type === 'contextmenu' || v.type === 'dblclick') && (v.id === null || Number.isInteger(v.id))) studioSend('shell:studio-overlay-event', { type: v.type, id: v.id });
  });
  ipcMain.handle('shell:studio-stream-stop', (e) => {
    local(e);
    studio.stopStream();
  });
  // Built here from the server itself (port + token), never assembled by the web page.
  ipcMain.handle('shell:clip-toast-url', (e) => {
    local(e);
    return localChatServer.getClipToastUrl();
  });
  ipcMain.handle('shell:obs-dock-install', async (e, req: { title?: unknown; url?: unknown; confirmRestart?: unknown; replaceLegacy?: unknown; replaceCredentialHash?: unknown }) => {
    local(e);
    // Shown as the dock's name in OBS: printable, short.
    const title = (typeof req.title === 'string' ? req.title.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 60) : '') || 'Trigglow Chat';
    // Only our dock URLs (public or #e= ticket, exact shape); never a URL the page made up, never a #k= secret.
    if (typeof req.url !== 'string' || !isTrigglowDockUrl(req.url)) return { status: 'invalid_url' };
    // Written as parsed, never the raw string the page sent (review L2).
    const dockUrl = new URL(req.url).href;
    // "Change the URL in OBS" (0.8.0): swap the old #k= dock of the same kind instead of adding one.
    const replaceKind = req.replaceLegacy === 'activity' || req.replaceLegacy === 'chat' ? req.replaceLegacy : null;
    if (replaceKind && dockKindOf(dockUrl) !== replaceKind) return { status: 'invalid_url' };
    // Only the OBS dock whose #k= credential hashes to the replaced dock's token_hash (review L2).
    const replaceHash = typeof req.replaceCredentialHash === 'string' && /^[0-9a-f]{64}$/.test(req.replaceCredentialHash) ? req.replaceCredentialHash : null;
    const write = (): boolean =>
      replaceKind ? (replaceLegacyBrowserDock(title, dockUrl, replaceKind, replaceHash)?.replaced ?? false) : (installBrowserDock(title, dockUrl), false);
    // OBS's config could not be replaced (locked, read-only): it is left exactly as it was.
    try {
      const running = await isObsRunning();
      if (running === true) {
        if (req.confirmRestart === true) {
          const exe = await findObsExecutable(); // capture the path before it closes
          if (process.platform !== 'darwin' && !exe) return { status: 'no_obs_found' };
          // OBS rewrites user.ini on exit: writing while it still runs would be lost.
          if (!(await closeObs())) return { status: 'close_failed' };
          let replaced: ReturnType<typeof write>;
          try {
            replaced = write();
          } finally {
            launchObs(exe); // OBS comes back even if its config could not be written
          }
          return { status: 'restarted', replaced };
        }
        // Written now, but OBS overwrites user.ini when it closes: the page offers the restart.
        const replaced = write();
        return { status: 'needs_restart', replaced };
      }
      return { status: 'installed', replaced: write() };
    } catch {
      return { status: 'write_failed' };
    }
  });

  // Multistream (dashboard /app/multistream through chat-tools.js): Trigglow's ingest server + key into OBS → Settings
  // → Stream. Only a Trigglow ingest key (tgms_…) and an rtmp(s)/srt server are accepted, so a page can't point OBS
  // anywhere else.
  ipcMain.handle('shell:obs-stream-setup', async (e, req: { server?: unknown; key?: unknown }) => {
    local(e);
    const ok = validStreamSetup(req?.server, req?.key);
    if (!ok) return { status: 'invalid' };
    if (obs.state !== 'connected') return { status: 'obs_not_connected' };
    try {
      return { status: await obs.setCustomStreamService(ok.server, ok.key) };
    } catch {
      return { status: 'failed' };
    }
  });

  // Multistream "Fit OBS to my plan" after a stream above the plan was turned away.
  ipcMain.handle('shell:obs-video-fit', async (e, req: { maxLines?: unknown; maxFps?: unknown }) => {
    local(e);
    const maxLines = Number(req?.maxLines);
    const maxFps = Number(req?.maxFps);
    if (!Number.isInteger(maxLines) || maxLines < 240 || maxLines > 4320 || !Number.isInteger(maxFps) || maxFps < 10 || maxFps > 240) {
      return { status: 'invalid' };
    }
    if (obs.state !== 'connected') return { status: 'obs_not_connected' };
    try {
      return await obs.fitVideoToPlan(maxLines, maxFps);
    } catch {
      return { status: 'failed' };
    }
  });

  // "Set up both docks in OBS" (0.8.0): what OBS already has, per kind, so the page offers "keep" instead of a
  // duplicate. Only presence flags: never a URL or a credential.
  ipcMain.handle('shell:obs-docks-status', async (e) => {
    local(e);
    const docks = readTrigglowDocks();
    return docks ? { status: 'ok', docks, running: (await isObsRunning()) === true } : { status: 'no_obs_found' };
  });

  // Both docks in one write (activity + chat), with the same OBS running / restart handling as one dock.
  ipcMain.handle('shell:obs-docks-install', async (e, req: { docks?: unknown; confirmRestart?: unknown }) => {
    local(e);
    if (!Array.isArray(req.docks) || req.docks.length < 1 || req.docks.length > 2) return { status: 'invalid_url' };
    const docks: DockToWrite[] = [];
    for (const raw of req.docks as Array<Record<string, unknown>>) {
      if (!raw || typeof raw !== 'object') return { status: 'invalid_url' };
      // Only our dock URLs (public or #e= ticket, exact shape), of the kind the page says, once per kind.
      if (typeof raw.url !== 'string' || !isTrigglowDockUrl(raw.url)) return { status: 'invalid_url' };
      const url = new URL(raw.url).href;
      const kind = dockKindOf(url);
      if (!kind || raw.kind !== kind || docks.some((d) => d.kind === kind)) return { status: 'invalid_url' };
      const title = (typeof raw.title === 'string' ? raw.title.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 60) : '') || (kind === 'chat' ? 'Trigglow Chat' : 'Trigglow Activity');
      const hash = typeof raw.replaceCredentialHash === 'string' && /^[0-9a-f]{64}$/.test(raw.replaceCredentialHash) ? raw.replaceCredentialHash : null;
      docks.push({ kind, title, url, replaceCredentialHash: hash });
    }
    const write = () => installTrigglowDocks(docks);
    // OBS's config could not be replaced (locked, read-only): it is left exactly as it was.
    try {
      const running = await isObsRunning();
      if (running === true) {
        if (req.confirmRestart === true) {
          const exe = await findObsExecutable(); // capture the path before it closes
          if (process.platform !== 'darwin' && !exe) return { status: 'no_obs_found' };
          // OBS rewrites user.ini on exit: writing while it still runs would be lost.
          if (!(await closeObs())) return { status: 'close_failed' };
          let results: ReturnType<typeof write>;
          try {
            results = write();
          } finally {
            launchObs(exe); // OBS comes back even if its config could not be written
          }
          return results ? { status: 'restarted', results } : { status: 'no_obs_found' };
        }
        // Written now, but OBS overwrites user.ini when it closes: the page offers the restart.
        const results = write();
        return results ? { status: 'needs_restart', results } : { status: 'no_obs_found' };
      }
      const results = write();
      return results ? { status: 'installed', results } : { status: 'no_obs_found' };
    } catch {
      return { status: 'write_failed' };
    }
  });

  ipcMain.handle('shell:set-prefs', async (e, p: { engine?: unknown; closeToTray?: unknown; openObsOnLaunch?: unknown; lolDetect?: unknown; openAtLogin?: unknown; clipEnabled?: unknown; clipHotkey?: unknown; clipSeconds?: unknown; controlHotkeys?: unknown; autoUpdate?: unknown; autoHighlights?: unknown; clipUploadMode?: unknown; clipQuality?: unknown; clipVisibility?: unknown; clipTitle?: unknown; clipAnnounce?: unknown; clipAnnounceText?: unknown; gameHighlights?: unknown; gameHighlightsDir?: unknown }) => {
    local(e);
    const clipPrefs: Partial<Prefs> = {};
    if (CLIP_QUALITIES.includes(p.clipQuality as ClipQuality)) clipPrefs.clipQuality = p.clipQuality as ClipQuality;
    if (CLIP_VISIBILITIES.includes(p.clipVisibility as ClipVisibility)) clipPrefs.clipVisibility = p.clipVisibility as ClipVisibility;
    if (typeof p.clipTitle === 'string') clipPrefs.clipTitle = p.clipTitle.slice(0, 100);
    if (typeof p.clipAnnounce === 'boolean') clipPrefs.clipAnnounce = p.clipAnnounce;
    if (typeof p.clipAnnounceText === 'string') clipPrefs.clipAnnounceText = p.clipAnnounceText.slice(0, 200);
    if (typeof p.gameHighlights === 'boolean') clipPrefs.gameHighlights = p.gameHighlights;
    if (typeof p.gameHighlightsDir === 'string') clipPrefs.gameHighlightsDir = p.gameHighlightsDir.trim().slice(0, 500);
    if (Object.keys(clipPrefs).length) {
      config = { ...config, prefs: { ...config.prefs, ...clipPrefs } };
      saveConfig(config);
      gameHighlights?.sync();
    }
    if (p.clipUploadMode === 'now' || p.clipUploadMode === 'after_stream') {
      config = { ...config, prefs: { ...config.prefs, clipUploadMode: p.clipUploadMode } };
      saveConfig(config);
    }
    if (p.autoHighlights === 'off' || p.autoHighlights === 'low' || p.autoHighlights === 'medium' || p.autoHighlights === 'high') {
      config = { ...config, prefs: { ...config.prefs, autoHighlights: p.autoHighlights } };
      saveConfig(config);
      autoHighlights?.apply();
    }
    if ((p.engine === 'obs' || (p.engine === 'studio' && studioOffered())) && p.engine !== config.prefs.engine) {
      config = { ...config, prefs: { ...config.prefs, engine: p.engine } };
      saveConfig(config);
      applyEngine();
    }
    if (typeof p.autoUpdate === 'boolean') {
      config = { ...config, prefs: { ...config.prefs, autoUpdate: p.autoUpdate } };
      saveConfig(config);
    }
    if (p.controlHotkeys !== undefined) {
      config = { ...config, prefs: { ...config.prefs, controlHotkeys: normalizeControlHotkeys(p.controlHotkeys) } };
      saveConfig(config);
      applyHotkeys();
    }
    if (typeof p.clipSeconds === 'number' && Number.isFinite(p.clipSeconds)) {
      // Above the plan's limit is refused here too (the server would reject the upload anyway).
      const seconds = Math.min(clipLimits.max, Math.max(CLIP_MIN_SECONDS, Math.round(p.clipSeconds)));
      config = { ...config, prefs: { ...config.prefs, clipSeconds: seconds } };
      saveConfig(config);
      await applyReplayLength(seconds);
    }
    if (typeof p.clipEnabled === 'boolean') {
      config = { ...config, prefs: { ...config.prefs, clipEnabled: p.clipEnabled } };
      saveConfig(config);
      applyHotkeys();
      syncStudioReplay();
    }
    if (typeof p.clipHotkey === 'string' && isValidAccelerator(p.clipHotkey)) {
      config = { ...config, prefs: { ...config.prefs, clipHotkey: p.clipHotkey } };
      saveConfig(config);
      applyHotkeys();
    }
    if (typeof p.closeToTray === 'boolean') {
      config = { ...config, prefs: { ...config.prefs, closeToTray: p.closeToTray } };
      saveConfig(config);
    }
    if (typeof p.openObsOnLaunch === 'boolean') {
      config = { ...config, prefs: { ...config.prefs, openObsOnLaunch: p.openObsOnLaunch } };
      saveConfig(config);
    }
    if (typeof p.lolDetect === 'boolean') {
      config = { ...config, prefs: { ...config.prefs, lolDetect: p.lolDetect } };
      saveConfig(config);
    }
    if (typeof p.openAtLogin === 'boolean' && app.isPackaged) {
      setOpenAtLogin(p.openAtLogin);
    }
    broadcast();
    return state();
  });
}

/* ------------------------------- startup ------------------------------- */

if (!isTrustedUrl(WEB_URL) || !isTrustedUrl(API_ORIGIN) || !isTrustedUrl(UPDATE_URL)) {
  console.error(`[desktop] refusing to start: untrusted TRIGGLOW_WEB_URL/TRIGGLOW_API_URL/TRIGGLOW_UPDATE_URL (${WEB_URL}, ${API_ORIGIN}, ${UPDATE_URL})`);
  app.exit(1);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (config) showWindow(); // before startup finishes the window doesn't exist yet: startup creates (and shows) it
    queuePacks(packFilesFromArgv(argv));
  });
  // macOS hands double-clicked files over with this event (also before the app is ready).
  app.on('open-file', (event, file) => {
    event.preventDefault();
    queuePacks(packFilesFromArgv([file]));
  });
  app.on('before-quit', () => {
    quitting = true;
    localChatServer.stop();
    nowPlaying.stop();
  });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    watchHeldKeys([], () => {}); // the push-to-talk poller goes with the app
    studio.shutdown(); // stops obs64.exe with the app
  });
  // macOS: the Dock icon brings back a window that was closed to the tray.
  app.on('activate', () => {
    if (config) showWindow();
  });
  void app.whenReady().then(async () => {
    // Camera, microphone, notifications… only for Trigglow's own pages. Anything else that ends up in the window (a
    // provider page during an account link, an embedded frame) gets nothing but fullscreen and clipboard writes.
    const permitted = (permission: string, origin: string) =>
      permission === 'fullscreen' || permission === 'clipboard-sanitized-write' || isTrustedUrl(origin) || origin.startsWith('trigglow-app://');
    session.defaultSession.setPermissionRequestHandler((_wc, permission, done, details) => done(permitted(permission, details.requestingUrl)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => permitted(permission, origin));
    await localChatServer.start();
    protocol.handle('trigglow-app', (req) => {
      const file = path.normalize(path.join(ASSETS, decodeURIComponent(new URL(req.url).pathname)));
      if (!file.startsWith(ASSETS + path.sep)) return new Response('forbidden', { status: 403 });
      // Bundled files change with every app update: never let Chromium reuse a stale copy of a screen or its CSS.
      return net.fetch(pathToFileURL(file).href).then((r) => {
        const headers = new Headers(r.headers);
        headers.set('cache-control', 'no-store');
        return new Response(r.body, { status: r.status, headers });
      });
    });
    config = loadConfig();
    setLocaleSources({ prefs: config.prefs });
    shownLocale = appLocale();
    // The web dashboard saves a language pick to the account (PATCH /api/profile): inside this app that is the user
    // choosing the app's language, so follow it right away. Only pages' requests (webContentsId), not our own.
    session.defaultSession.webRequest.onCompleted({ urls: ['*://*/api/profile*'] }, (d) => {
      const ok = d.statusCode >= 200 && d.statusCode < 300;
      if (d.method === 'PATCH' && ok && d.webContentsId !== undefined && d.url.split('?')[0] === `${API_ORIGIN}/api/profile`) {
        void refreshAccountLocale(true);
      }
    });
    // Windows toasts need an app id. Dev runs (electron.exe) get their own: Windows files a Start-menu shortcut per id, and a
    // dev shortcut sharing the installed app's id made the taskbar show Electron's logo for the real app.
    app.setAppUserModelId(app.isPackaged ? 'com.trigglow.desktop' : 'com.trigglow.desktop.dev');
    if (process.platform === 'linux' && app.isPackaged && openAtLogin()) setOpenAtLogin(true); // follow the AppImage's new name
    textSources = new TextSources(config.textSources, {
      connected: () => engine().state === 'connected',
      setText: (source, text) => engine().setText(source, text),
      createSource: (scene, name, text) => engine().createTextSource(scene, name, text),
      fetchData: () => {
        const has = (id: string) => textSources?.bindings.some((b) => b.id === id) ?? false;
        return fetchTextData(API_ORIGIN, overlayId, { follower: has('latest_follower'), sub: has('latest_sub'), donation: has('latest_donation') }, appLocale());
      },
      get locale() {
        return appLocale();
      },
      save: (textBindings) => {
        config = { ...config, textSources: textBindings };
        saveConfig(config);
      },
      onChange: () => broadcast(),
    });
    api.onNotify = (n) => {
      showNotification(n);
      // A stream turned away or a channel down: Studio also says it next to its Go live button.
      if (n.kind === 'multistream') studioSend('shell:studio-notice', n);
    };
    api.onData = () => textSources?.nudge();
    obs.onObsEvent = studioLink.onObsEvent = (ev) => api.emit(ev);
    obs.autoStartReplay = () => config.prefs.clipEnabled;
    api.onClipRequest = (o) => void runClip(o);
    // Highlight detected: wait a few seconds so the Replay Buffer also holds the aftermath, then clip.
    autoHighlights = new AutoHighlights(engine, () => (config.prefs.clipEnabled ? config.prefs.autoHighlights : 'off'), () => {
      // The spike is a stream moment on its own, clipped or not (post-stream highlights).
      api.sendMoment({ kind: 'reaction', ageMs: 0 });
      setTimeout(() => !isClipBusy() && void runClip(), 4000);
    });
    // NVIDIA Highlights wrote a video (a kill, a win in Fortnite…): save the replay now, while it holds the moment.
    gameHighlights = new GameHighlightWatcher(
      () => (config.prefs.clipEnabled && config.prefs.gameHighlights ? config.prefs.gameHighlightsDir || DEFAULT_HIGHLIGHTS_DIR : null),
      () => engine().live && !isClipBusy() && void runClip(),
    );
    // League of Legends events (kills, objectives, result) as stream moments while live.
    new LolWatcher(
      () => config.prefs.lolDetect && engine().live && api.online,
      (m) => api.sendMoment({ kind: 'game', game: 'lol', detail: m.code, ageMs: m.ageMs, ...(m.stats ? { stats: m.stats } : {}) }),
    );
    onClipProgress(() => {
      broadcast();
      const { phase, title } = getClipProgress();
      localChatServer.broadcastClip({ phase, title });
    });
    const retryClips = () =>
      void retryQueuedClips(API_ORIGIN, openClips, { uploadDeferred: !engine().live, maxBytes: clipLimits.maxBytes, maxHeight: clipMaxHeight(), account: overlayId }).then(broadcast);
    setInterval(() => api.online && retryClips(), 2 * 60_000);
    onStreamOver = retryClips;
    api.onAuthed = () => {
      publishCaps(true);
      retryClips();
    };
    // With Trigglow Studio as the engine the app never talks to OBS (no connection attempts, no OBS notices).
    if (!studioEnabled()) obs.configure(resolveObs);
    // Same as the "Open OBS" button: only when it's closed, never restarts a running one.
    if (config.prefs.openObsOnLaunch && !studioEnabled()) void isObsRunning().then((running) => (running === false ? fixObs(false) : null));
    applyHotkeys();
    registerIpc();
    if (studioEnabled()) startStudio(); // before the window, so the dashboard's User-Agent already says Studio
    createWindow();
    createTray();
    createMenu();
    updater.start(UPDATE_URL);
    const me = await fetchMe();
    reachable = me !== 'offline';
    if (!config.onboarded) showOnboarding();
    else if (me === 'ok') await enterApp();
    else showSignIn();
  });
}
