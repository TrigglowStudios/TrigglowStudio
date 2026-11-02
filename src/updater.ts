import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import fs from 'node:fs';
import path from 'node:path';

// Linux updates itself only as an AppImage ($APPIMAGE) or a deb/rpm/pacman install (electron-builder leaves a
// `package-type` file in resources). The tar.gz build has neither: it reports 'unsupported' and is updated by hand.
const updatable = () =>
  app.isPackaged && (process.platform !== 'linux' || Boolean(process.env.APPIMAGE) || fs.existsSync(path.join(process.resourcesPath, 'package-type')));

type UpdateStatus = 'unsupported' | 'idle' | 'checking' | 'downloading' | 'ready' | 'uptodate' | 'error';

interface UpdateState {
  status: UpdateStatus;
  /** Version being downloaded / waiting to be installed. */
  version?: string;
  percent?: number;
}

const FIRST_CHECK_MS = 30_000;
const EVERY_MS = 4 * 60 * 60 * 1000;

/**
 * Self-update through the API's feed (electron-updater "generic" provider — see apps/api/src/routes/desktop-updates.ts).
 * It checks shortly after start and then every few hours, downloads in the background (differential when it can) and
 * tells the UI when a version is ready. That version installs when the user chooses "Restart and update", or by
 * itself the next time the app quits. Only the installed app updates: a dev run (`pnpm dev`) reports 'unsupported'.
 */
export class Updater {
  state: UpdateState = { status: updatable() ? 'idle' : 'unsupported' };
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private onChange: () => void,
    /** A version finished downloading — the place for a "restart to update" notification. */
    private onReady: (version: string) => void,
    /** Automatic checks respect the user's preference; a manual "Check for updates" always runs. */
    private autoEnabled: () => boolean,
  ) {}

  private set(state: UpdateState) {
    this.state = state;
    this.onChange();
  }

  start(feedUrl: string): void {
    if (!updatable()) return;
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true; // quitting normally applies a downloaded update
    autoUpdater.allowDowngrade = false;
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking' }));
    autoUpdater.on('update-available', (info) => this.set({ status: 'downloading', version: info.version, percent: 0 }));
    autoUpdater.on('update-not-available', () => this.set({ status: 'uptodate' }));
    autoUpdater.on('download-progress', (p) => this.set({ status: 'downloading', version: this.state.version, percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => {
      this.set({ status: 'ready', version: info.version });
      this.onReady(info.version);
    });
    // 404/503 just mean "no release published yet / feed not configured": not worth alarming anyone.
    autoUpdater.on('error', () => this.set({ status: 'error' }));

    setTimeout(() => this.autoCheck(), FIRST_CHECK_MS);
    this.timer = setInterval(() => this.autoCheck(), EVERY_MS);
  }

  private autoCheck() {
    if (this.autoEnabled()) this.check();
  }

  check(): void {
    if (!updatable() || ['checking', 'downloading', 'ready'].includes(this.state.status)) return;
    autoUpdater.checkForUpdates().catch(() => this.set({ status: 'error' }));
  }

  /** Quit and run the installer for the downloaded version (then relaunch). */
  install(): void {
    if (this.state.status === 'ready') autoUpdater.quitAndInstall(false, true);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
