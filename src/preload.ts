import { contextBridge, ipcRenderer } from 'electron';

// Sandboxed preload: only 'electron' can be required. Main decides, from the page URL, whether this is
// one of the app's OWN bundled screens (sign-in / settings). Web pages never get any bridge.
if (ipcRenderer.sendSync('shell:is-local', location.href) === true) {
  contextBridge.exposeInMainWorld('trigglowShell', {
    getState: () => ipcRenderer.invoke('shell:state'),
    signIn: () => ipcRenderer.invoke('shell:signin'),
    cancelSignIn: () => ipcRenderer.invoke('shell:signin-cancel'),
    signOut: () => ipcRenderer.invoke('shell:signout'),
    obsScenes: () => ipcRenderer.invoke('shell:obs-scenes'),
    obsInstall: (req: { scene: string; name: string; url: string }) => ipcRenderer.invoke('shell:obs-install', req),
    nav: (action: 'back' | 'forward' | 'reload' | 'settings' | 'billing' | 'multistream' | 'link-twitch') => ipcRenderer.invoke('shell:nav', action),
    saveObs: (cfg: { mode: 'auto' | 'manual'; host?: string; port?: number; password?: string }) => ipcRenderer.invoke('shell:save-obs', cfg),
    obsRetry: () => ipcRenderer.invoke('shell:obs-retry'),
    hotkeyCapture: (on: boolean) => ipcRenderer.invoke('shell:hotkey-capture', on),
    clipNow: () => ipcRenderer.invoke('shell:clip-now'),
    textAdd: (id: string) => ipcRenderer.invoke('shell:text-add', id),
    textUpdate: (req: { id: string; source?: string; template?: string }) => ipcRenderer.invoke('shell:text-update', req),
    textRemove: (id: string) => ipcRenderer.invoke('shell:text-remove', id),
    textCreate: (id: string) => ipcRenderer.invoke('shell:text-create', id),
    notifyTest: () => ipcRenderer.invoke('shell:notify-test'),
    replayFix: (confirmRestart: boolean) => ipcRenderer.invoke('shell:replay-fix', confirmRestart),
    obsFix: (confirmRestart: boolean) => ipcRenderer.invoke('shell:obs-fix', confirmRestart),
    overlays: () => ipcRenderer.invoke('shell:overlays'),
    finishOnboarding: () => ipcRenderer.invoke('shell:onboarding-done'),
    restartOnboarding: () => ipcRenderer.invoke('shell:onboarding-restart'),
    updateCheck: () => ipcRenderer.invoke('shell:update-check'),
    updateInstall: () => ipcRenderer.invoke('shell:update-install'),
    relaunch: () => ipcRenderer.invoke('shell:relaunch'),
    openStudioLogs: () => ipcRenderer.invoke('shell:studio-logs'),
    obsDockInstall: (req: { title?: string; url?: string; confirmRestart?: boolean; replaceLegacy?: 'activity' | 'chat'; replaceCredentialHash?: string }) => ipcRenderer.invoke('shell:obs-dock-install', req),
    obsDocksStatus: () => ipcRenderer.invoke('shell:obs-docks-status'),
    obsDocksInstall: (req: { docks: { kind: 'activity' | 'chat'; title: string; url: string; replaceCredentialHash?: string }[]; confirmRestart?: boolean }) =>
      ipcRenderer.invoke('shell:obs-docks-install', req),
    clipToastUrl: () => ipcRenderer.invoke('shell:clip-toast-url'),
    obsStreamSetup: (req: { server: string; key: string }) => ipcRenderer.invoke('shell:obs-stream-setup', req),
    obsVideoFit: (req: { maxLines: number; maxFps: number }) => ipcRenderer.invoke('shell:obs-video-fit', req),
    setPrefs: (prefs: { engine?: 'obs' | 'studio'; closeToTray?: boolean; openObsOnLaunch?: boolean; lolDetect?: boolean; openAtLogin?: boolean; clipEnabled?: boolean; clipHotkey?: string; clipSeconds?: number; autoHighlights?: 'off' | 'low' | 'medium' | 'high'; controlHotkeys?: Record<string, string>; autoUpdate?: boolean; clipUploadMode?: 'now' | 'after_stream'; clipQuality?: 'source' | '1080p' | '720p'; clipVisibility?: 'private' | 'unlisted' | 'public'; clipTitle?: string; clipAnnounce?: boolean; clipAnnounceText?: string; gameHighlights?: boolean; gameHighlightsDir?: string }) => ipcRenderer.invoke('shell:set-prefs', prefs),
    openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
    // Synchronous so i18n.js can paint the first frame in the app's language (no flash of the OS one).
    locale: () => ipcRenderer.sendSync('shell:locale') as { locale: string; chosen: boolean } | null,
    // `fresh`: picked just now (also saved to the account); false = an older pick being handed over (kept on this PC only).
    setLocale: (locale: string, fresh = true) => ipcRenderer.invoke('shell:set-locale', locale, fresh),
    studioStreamStart: () => ipcRenderer.invoke('shell:studio-stream-start'),
    studioStreamStop: () => ipcRenderer.invoke('shell:studio-stream-stop'),
    studioPopup: (req: { kind: 'props' | 'filters' | 'name' | 'confirm' | 'web' | 'picker' | 'transform' | 'audio' | 'encoder' | 'stats'; source?: string; filter?: string; title?: string; value?: string; message?: string; item?: number }) => ipcRenderer.invoke('shell:studio-popup', req),
    studioMenu: (items: unknown[]) => ipcRenderer.invoke('shell:studio-menu', items),
    studioOverlayEvent: (ev: { type: 'contextmenu' | 'dblclick'; id: number | null }) => ipcRenderer.send('shell:studio-overlay', ev),
    studioPopupDone: (value: string | boolean | null) => ipcRenderer.invoke('shell:studio-popup-done', value),
    studio: (req: { op: string; name?: string; id?: number; value?: unknown; type?: string; trigglow?: string; dir?: 'up' | 'down' | 'top' | 'bottom'; changes?: Record<string, unknown>; filter?: string }) => ipcRenderer.invoke('shell:studio', req),
    studioPreview: (rect: { x: number; y: number; width: number; height: number } | null) => ipcRenderer.invoke('shell:studio-preview', rect),
    studioDocks: (rects: Record<string, { x: number; y: number; width: number; height: number } | null> | null) => ipcRenderer.invoke('shell:studio-docks', rects),
    onStudio: (cb: (kind: 'stats' | 'signal' | 'levels' | 'view' | 'overlay' | 'notice' | 'dock', payload: unknown) => void) => {
      const channels = { stats: 'shell:studio-stats', signal: 'shell:studio-signal', levels: 'shell:studio-levels', view: 'shell:studio-view', overlay: 'shell:studio-overlay-event', notice: 'shell:studio-notice', dock: 'shell:studio-dock-window' } as const;
      const handlers = Object.entries(channels).map(([kind, channel]) => {
        const h = (_e: unknown, p: unknown) => cb(kind as keyof typeof channels, p);
        ipcRenderer.on(channel, h);
        return () => ipcRenderer.removeListener(channel, h);
      });
      return () => handlers.forEach((off) => off());
    },
    onState: (cb: (s: unknown) => void) => {
      const handler = (_e: unknown, s: unknown) => cb(s);
      ipcRenderer.on('shell:state-changed', handler);
      return () => ipcRenderer.removeListener('shell:state-changed', handler);
    },
  });
}

