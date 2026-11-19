# Trigglow Studio

The Trigglow desktop app for Windows and Linux. It works two ways:

- **Next to OBS:** it connects to OBS by itself, adds the Trigglow overlays, saves instant clips and runs automations.
- **Trigglow Studio:** its own broadcasting editor (scenes, sources, mixer, streaming and recording), built on the OBS Studio engine (libobs) through [obs-studio-node](https://github.com/streamlabs/obs-studio-node). It imports OBS and Streamlabs Desktop scene collections, and it can run [Trigglow Dynamic Delay](https://github.com/TrigglowStudios/trigglow-dynamic-delay).

Licensed under the [GNU General Public License v3.0 or later](LICENSE). Trigglow Studio is based on the OBS Studio engine; OBS Studio and obs-studio-node are © their contributors and licensed under the GPL (their licences and source links are in [licenses/](licenses/NOTICE.md), which the installer includes). Trigglow Studio is not affiliated with or endorsed by the OBS Project.

This repository is only the desktop app. The web dashboard and the API it talks to (trigglow.com) are not part of it.

## How it works

Electron shell around the Trigglow dashboard, **independent of the regular web app**: the web only reacts to its User-Agent (no bridge, no special routes). The shell loads `/app`, owns sign-in and its own settings, and keeps a local link to OBS so automations can drive it.

## What lives where

| | Web (trigglow.com) | Desktop (this repository) |
|---|---|---|
| Dashboard pages | ✅ served at `/app/**` | just loads them |
| Sign-in | `/login` (browser only) | own screen (`assets/signin.html`) |
| Settings | `/app/settings` (account stuff) | a **Desktop app** tab in that same page (shell only) showing the app's own panel (`assets/settings.html`): OBS, tray, autostart |
| Link to the API (Socket.IO `desktop:*`) | — | main process, using the session cookie |

The only web-side traces are driven by the `TrigglowDesktop/x.y` User-Agent suffix: the OBS actions in the automation form, the "Desktop app" tab in Settings, and hiding "Back to website". Normal browsers never see any of it.

## Settings

No extra window. The web's Settings page gets a **Desktop app** tab whose content is an `<iframe>` of `trigglow-app://app/settings.html` — a private scheme the shell serves from its bundled `assets/` (an http page can't frame `file://`). The panel, its logic and its strings ship with the app, so the web needs no knowledge of OBS or tray options and stays deploy-independent. The shell's preload exposes `trigglowShell` only to pages on that scheme, and IPC calls from a framed panel also require a trusted parent page. Tray → *Settings* (and Ctrl+,) just navigate the window to `/app/settings?tab=desktop`.

## Sign-in & platform linking

No credentials or OAuth ever touch the app window. It reuses the API's device-link flow (`/auth/plugin/start`, `/auth/plugin/approve`, `/auth/plugin/token`, plus `/auth/plugin/poll` fallback):

1. **Sign in** → app opens the system browser at `/plugin/link?code=…`.
2. User signs in however they like (Kick, Twitch, password + 2FA) and confirms the link.
3. The app receives the session token and stores it as the `trigglow_session` cookie in its own Electron session, then loads `/app`.

Platform account links (Twitch, Kick, YouTube, Discord, Spotify) also open in the user's regular system browser using a one-time desktop ticket (`/auth/desktop-link`) and show the result in the app as soon as you return.

Sign-out (tray / menu / settings) calls `/auth/logout`, drops the cookie and returns to the sign-in screen. If the web itself routes to `/login` (logout button, expired session) the shell shows its sign-in screen instead.

## The window never leaves `/app`

`src/nav.ts` classifies every navigation (`will-navigate`, `will-redirect`, in-page routing, `window.open`):

- `/app/**` on a trusted origin → stays in the window
- `/login`, `/` → the app's own sign-in screen
- `/auth/**` (account linking: Discord, Kick…) → allowed, and while that flow runs its provider redirects may pass
- anything else (`/docs`, `/admin`, Stripe checkout, external sites…) → system browser

Web pages get **no** privileged bridge: the preload exposes `trigglowShell` only on the app's own bundled screens, and every IPC handler re-checks the sender URL.

## Automations → OBS

```
automation rule (DO: obs_switch_scene / obs_set_source_visible)
  → API `emitDesktopAction(userId, action)` → Socket.IO room `desktop:<userId>` (`desktop:auth`, session cookie)
  → desktop `ApiLink` (re-validates the action) → `ObsLink` → OBS WebSocket v5
```

If no desktop app is connected the action is skipped (logged) and the rest of the rule still runs. OBS host/port/password live in the app's Settings (password encrypted with the OS keychain via `safeStorage`). The app keeps running in the tray when the window is closed (toggle in Settings).

## OBS → automations (WHEN) and more OBS actions

The desktop app also listens to OBS and reports what happens (`src/obs-events.ts` → socket event `desktop:event`): scene changed, stream started/stopped, recording started/stopped, replay saved. In Automations they appear as WHEN options (desktop app only; scene changes can be limited to one scene). They are **not** ProgressMetrics — quests, goals and loyalty never see them; `evaluateObsEvent` in the API runs only the rules that match, with the usual cooldown (plus a 60 events/min server-side cap per streamer, so a flapping scene switcher can't hammer chat or OBS). Actions that need a viewer (fire trigger, XP, per-viewer quests) simply don't run for OBS events.

New DO actions, executed locally through the OBS link: start/stop recording or streaming, save replay, mute/unmute an input, set an input volume, set a text source, trigger an OBS hotkey by name, enable/disable a source filter (besides the existing scene switch and show/hide source). Extra WHEN events: stream reconnecting, input muted / unmuted (optional input-name filter).

## Instant clip, GPU compression & highlights

A global shortcut (default `Ctrl+Alt+C`, configurable and recorded in Settings → Desktop app → Instant clip; also in the tray menu) saves OBS's **Replay Buffer** (or Trigglow Studio's engine replay) and uploads it as a Trigglow clip:

1. `SaveReplayBuffer` and wait for OBS's `ReplayBufferSaved` event (the file path);
2. If the recording is already browser-playable (H.264 + AAC or silent) and within the plan's byte cap and optional max height (keeping 1440p/4K at full frame rate, or capped to 1080p/720p in Settings), it uploads untouched (`src/compress.ts`). Otherwise it re-encodes with your GPU's hardware encoder (`h264_nvenc`, `h264_amf`, `h264_qsv`) or `libx264` on half your CPU cores at below-normal priority;
3. Multipart upload to `POST /api/kick/clips/upload` (Node `fetch` with the session cookie). The server converts mkv/flv/ts to MP4 (`-c copy`) and measures the length with ffmpeg, so no duration is needed from the client;
4. Native notifications for each step (click the final one to open your clips) plus SSE updates for the **OBS Clip Toast** browser source served on `http://127.0.0.1:45455` (protected by a persisted `local-dock-token`, `src/local-server.ts`). The original replay file stays where OBS wrote it.

Additional clip capabilities:
- **Upload timing & retry queue:** upload immediately or queue clips on disk (`clipUploadMode: 'after_stream'`) to upload once the stream ends or OBS closes, with automatic retry if offline.
- **Visibility, title & chat post:** choose `private`, `unlisted` or `public`, format titles with `{game}` and `{date}`, and customize or disable TrigglowBot's `{link}` chat announcement (announced clips are promoted to at least `unlisted`).
- **Automatic highlights (`src/auto-highlights.ts`, `src/highlight.ts`):** while live, watches OBS audio meters and 64×36 frame motion (`Off` / `Only big moments` / `Balanced` / `Catch more`) and triggers instant clips automatically (at most once per minute).
- **NVIDIA Highlights (`src/game-highlights.ts`):** watches your Highlights folder (Fortnite and other supported games) while live and triggers OBS's Replay Buffer the moment a game saves a kill or win so the clip includes your camera and overlays.

The Replay Buffer is set up automatically, same philosophy as the WebSocket: once OBS connects the app **starts it by itself** if it is enabled but idle; if it isn't enabled, "Turn it on for me" enables it in the active OBS profile (`basic.ini`, Simple or Advanced mode, keeping the user's buffer length) — directly when OBS is closed (and launches it with `--startreplaybuffer`), or with a confirmed restart when it is open. When the WebSocket fix has to restart OBS anyway, the Replay Buffer is enabled in the same pass.

### Clip length and plans

The length is OBS's own Replay Buffer length, set from Settings → Desktop app → Instant clip (slider, 10 s up to the plan's limit). While OBS is connected it is applied **live** through the WebSocket (`SetProfileParameter` on the active output mode; the buffer is stopped and started again because OBS reads the length when it starts, so what it had recorded is discarded) — with OBS closed it is written to the profile's `basic.ini`; with OBS open but not connected nothing is touched. The memory cap OBS keeps for the buffer (`RecRBSize`) is raised when a long length wouldn't fit under it, never lowered. Until the user picks a length the app shows and keeps OBS's own.

One rule for every way a clip enters the library — **up to 60 s on Free, up to 5 min (300 s) on Starter, and up to 15 min (900 s) on Pro (`plus`)** (`CLIP_FREE_MAX_SECONDS` / `CLIP_STARTER_MAX_SECONDS` / `CLIP_PLUS_MAX_SECONDS` in `@trigglow/shared`, enforced by `lib/clip-limits.ts` on the upload endpoint and on native-clip imports, and surfaced by `GET /api/kick/clips/limits`). Kick live capture (30 s, bounded by Kick's HLS window) and Twitch clips (60 s) already sit under the free limit. A replay file runs a few seconds over the configured length (it ends on a keyframe), so the server allows `CLIP_DURATION_GRACE_SECONDS` (8 s) of slack. The web's upload dialog checks the video's length *before* sending it; the desktop slider stops at the plan's limit.

### Stream Deck "Create clip"

The key calls `GET /api/overlay/:slug/control?action=create-clip`. The API serves it like this:

1. `platform=obs` forces the desktop app's replay clip (409 `desktop_not_connected` if it isn't running);
2. with no platform, the replay clip is used when a connected desktop app has reported OBS's Replay Buffer as ready (`desktop:caps`) — the key answers 202 straight away and the app uploads in the background, posts native notifications and TrigglowBot announces the link in chat once the clip is up (`announce` field on the upload);
3. otherwise — and for `platform=kick|twitch` — the previous behaviour (live capture / Twitch clip).

## OBS connection: automatic

Nothing to type. Before **every** connection attempt the app reads OBS's own settings (`src/obs-detect.ts`):

- `<OBS config dir>/plugin_config/obs-websocket/config.json` → port, whether the WebSocket server is enabled, and the password if OBS requires one (read on demand, never stored or logged). On Linux it detects native (`~/.config/obs-studio`), **Flatpak** (`~/.var/app/com.obsproject.Studio/config/obs-studio`), and **Snap** (`~/snap/obs-studio/current/.config/obs-studio`) OBS installations;
- whether the OBS process is running (`tasklist` / `pgrep`).

Re-reading each attempt means it just works when the user opens OBS, enables the server or changes the password later. The diagnosis is reduced to one actionable hint (`connected`, `not_running`, `server_disabled`, `auth_failed`, `unreachable`) that the onboarding, the settings panel and the "Install in OBS" panels all show. **Manual** host/port/password remains an opt-in fallback (Settings → Desktop app).

On Linux, global shortcuts work on Wayland through the `GlobalShortcutsPortal` (KDE, GNOME 48+), and "Start at login" creates/updates an XDG autostart entry (`~/.config/autostart/trigglow.desktop`).

### "Fix it for me"

When the hint is actionable the app offers the fix (automatic mode only):

- **OBS closed** → turns the WebSocket server on (`server_enabled: true` in obs-websocket's `config.json`; a missing file becomes a secure default with a random password we read back ourselves) and **launches OBS** (Windows exe lookup via process/registry/default paths; Flatpak/Snap on Linux).
- **OBS open, server off** → OBS only reads that file at startup and rewrites it on exit, so this needs a **restart**. It only happens after an explicit confirmation ("don't do it while streaming or recording"): graceful close (`taskkill` without `/F`, `osascript quit`, `pkill -TERM`), wait up to 30 s — if OBS doesn't exit (e.g. it is streaming and asks) nothing is touched — edit the file atomically (`.trigglow-tmp` + `.trigglow-bak`), relaunch.
- There is no way to flip the setting inside a running OBS (the `--websocket_port/--websocket_password` flags only override port and password), hence the confirmation. The manual steps stay available under "Prefer to do it yourself?".

Not covered yet: OBS run as administrator on Windows.

## One-click OBS docks

From `/app/docks`, Trigglow Studio writes both the **Activity** (`/dock/activity`) and **Chat** (`/dock/chat`) docks directly into OBS's `user.ini` using one-use desktop tickets (`#e=tgde_…`) and atomic config replacement (`src/obs-fix.ts`). Existing docks of the same kind are preserved without duplicating, and legacy secret-URL (`#k=`) docks are migrated cleanly when matched.

## First-run setup

`assets/onboarding.html` is shown once (and again from Settings → *Run setup again*): welcome → sign in (same device flow) → connect OBS (live checklist: OBS found / open / WebSocket on / connected, with the exact steps when the server is off) → install overlays (the ten overlays are built from the signed-in account and added to a chosen scene as browser sources, idempotently) → done. Every step except sign-in/OBS is skippable and nothing forces the user through it twice.

## Notifications (web **and** desktop)

One system, four channels, one settings page (Settings → Notifications): the **bell** inside the app, **email**, **web push** (the browser / installed PWA, even with the tab closed) and **desktop toasts**. Kinds: follows, subs, gift subs, gifts, raids, **donations**, **channel-point redeems**, **VIP requests** and **support replies** (email exists only for the first five — the rest have no email template).

```
event (ingest worker · advanceProgress for donations · createVipRequest · staff reply on a ticket)
  → maybeEnqueueNotification(userId, kind, context)      // lib/notification-prefs.ts
       ├─ bell:    row in `in_app_notifications` (30 days)          → the bell in the top bar, web and desktop app
       ├─ desktop: socket `desktop:notify` {title, body, url}  → native notification (only while the app runs)
       ├─ push:    dispatch queue → web-push (push-sw.js opens the right page on click)
       └─ email:   dispatch queue (stream events only)
```

**The bell** is a passive inbox (`GET /api/inbox`, `POST /api/inbox/read`, `POST /api/inbox/clear`; `components/NotificationBell.tsx`, polled every 45 s while the tab is visible): unread badge, mark as read on click, "mark all as read", "clear", click opens the related page. It is a web component, so it works the same in a browser and inside the desktop app. Rows are pruned after 30 days on write (no cron); the table needs the `20260930133138_in_app_notifications` migration (`pnpm db:migrate`).

**Settings are two questions, not a matrix:** *where* (four switches: the bell, this browser, the desktop app, email) and *what about* (three levels: only the essentials · my stream · everything). Behind them the server still stores per-event × per-channel prefs; `simplifyNotificationPrefs` / `expandNotificationSettings` (shared) translate both ways, and the old matrix stays available under "Customize by event" for whoever wants it. Reading never rewrites a custom setup — only saving a simple choice does.

Text is rendered once on the server in the user's language (`lib/notification-copy.ts`; the five stream events reuse the branded email copy, the new kinds have es/en), so the bell, web push and the desktop app say the same thing. Defaults: email and push are opt-in; the bell is on for everything except follows and redeems (the chattiest); the desktop app starts on for subs, gift subs, donations, VIP requests and support replies. The desktop app re-validates every payload (`notify.ts`: bounded text, click target must be `/app/…`) and shows at most 4 toasts per 10 s — a raid becomes one "N more notifications" summary. Donations funnel through `advanceProgress` and are de-duplicated by the payment's idempotency key (the Stripe webhook and the success page can both report it).

## Overlay & song-request hotkeys

Global shortcuts (Settings → Desktop app → Overlay hotkeys, recorded in the panel) for **Alerts** (`skip`, `toggle-mute`, `toggle-pause`, `clear`, `repeat`) and **Song requests** (`music-skip`, `music-toggle-pause`, `music-volume-up`, `music-volume-down`, `music-clear`, `music-toggle-requests`). They call the same endpoint the dashboard uses — `POST /api/overlay/:slug/control {action}` with the session cookie — so they work over any game and need no Stream Deck. None is set by default (a wrong default would steal a key from the user's other apps); a shortcut another app already owns is reported instead of silently failing. A failed call shows one notification per 30 s.

## OBS text sources

Trigglow data written straight into OBS **text sources** — no browser source, no overlay: latest follower, latest subscriber, latest donation, and the progress of any quest or community goal (`{title} {current} {target} {remaining} {percent} {bar}`, money formatted for donation goals). It is a **tool** of the dashboard (sidebar → Tools → *OBS texts*, route `/app/obs-texts`, only present inside the desktop app; a browser gets an explanation) — not an app setting. The page frames the app's own panel (`assets/text-sources.html`), like the other desktop panels. Add one there: the app creates the text input in OBS's current scene (GDI+ text on Windows, FreeType elsewhere) and keeps it updated. It is idempotent by source name, so pointing a binding at a text source you already made just works; if the source is deleted the row says so and offers to recreate it.

Data comes from endpoints the dashboard already uses — `/api/activity` (latest follower/sub/donation) and the public `/api/overlay/:slug/widgets` snapshot (quests & goals). It refreshes on a server nudge (`desktop:data`, sent for every event that can change it, whatever the notification settings), when OBS connects, and every 60 s; bursts collapse into one fetch (min 3 s apart, well under the widgets endpoint's rate limit).

## Live game integrations (LoL & CS2)

When signed in, the app feeds live match data to Trigglow's **game-rank overlay** and post-stream highlights:

- **League of Legends (`src/lol.ts`):** polls Riot's official local Live Client Data API (`https://127.0.0.1:2999/liveclientdata/allgamedata`, toggleable in Settings → General → *Games*). Reports match events (`game_start`, kills, multikills, first blood, aces, dragon/herald/baron kills and steals, inhibitors, turrets, close escapes, victory/defeat) via `desktop:moment`, and sends live KDA, CS, gold, level, champion, mode, runes and summoner spells to the game-rank overlay.
- **Counter-Strike 2 (`src/cs2.ts`):** automatically installs `gamestate_integration_trigglow.cfg` in CS2's Steam library and receives GSI POSTs at `POST /cs2-gsi` on the local server, forwarding live map, round, team scores, weapon, KDA, MVPs, health, money and ACEs to the game-rank overlay.

## Music: Now playing & Spotify song requests

- **Now playing (`src/now-playing.ts`):** reads the currently playing track on **Windows** (SMTC via PowerShell) and **Linux** (MPRIS via `playerctl`, preferring Spotify; artwork read only from safe player cache/temp paths or known art CDNs with redirects refused) and pushes it to the music overlay without needing a Spotify app connection.
- **Spotify song requests without a Spotify app (beta, `src/link.ts`):** when *"With Trigglow Studio"* is selected in Song requests, the API emits `desktop:spotify-play` for each viewer request and the app opens `spotify:track:<id>#0:01` directly in your local Spotify client.

## Trigglow Studio broadcasting editor

Trigglow Studio includes an embedded broadcasting editor (`src/studio.ts`, `src/studio-scenes.ts`, `src/studio-settings.ts`, `src/studio-props.ts`) running `libobs` via `obs-studio-node` (Windows only; see `licenses/NOTICE.md`). It supports scenes, folders, sources, audio mixer, streaming/recording, non-destructive scene collection imports from **OBS Studio** and **Streamlabs Desktop** (`src/studio-import.ts`), a Discord streamer mode binary toggle (`obs64.exe` vs `trigglow-engine.exe`), and the **Trigglow Dynamic Delay** core (`pnpm studio:fetch` / `pnpm studio:delay`).

## Languages

Every bundled screen (`assets/i18n.js`), tray menu, application menu, clip toast and native notification (`src/messages.ts`, `src/locale.ts`) is translated into all **16 Trigglow languages** (`en`, `es`, `pt-BR`, `zh`, `fr`, `it`, `de`, `ru`, `uk`, `ko`, `ja`, `hi`, `ca`, `ca-valencia`, `eu`, `gl`) and stays synced with your Trigglow account language.

## Develop

```bash
pnpm install            # set ELECTRON_SKIP_BINARY_DOWNLOAD=1 to skip the ~100 MB Electron binary
pnpm studio:fetch       # Windows: obs-studio-node + Dynamic Delay 0.7.2 core into vendor/ (pinned, SHA-256 checked)
pnpm studio:delay       # optional (Windows): install a local build of the Dynamic Delay core into vendor/obs-studio-node
TRIGGLOW_WEB_URL=https://trigglow.com/app TRIGGLOW_API_URL=https://api.trigglow.com pnpm dev
pnpm test
```

Running with `--dev` (or placing an empty `dev` file next to the executable) switches to the develop stack (`https://dev.trigglow.com/app`, `https://apidev.trigglow.com`) using an isolated `<userData>-dev` directory. Signed-in Trigglow admins also see a **Server** menu in the app bar to switch between production and development (`server.json`).

Env: `TRIGGLOW_WEB_URL` (default `http://localhost:5173/app` unpackaged, `https://trigglow.com/app` packaged; `https://dev.trigglow.com/app` for the dev environment), `TRIGGLOW_API_URL` (unpackaged: the web origin, through Vite's proxy; **packaged: `https://api.trigglow.com`** — in production the SPA is on Vercel and the API on its own host; for the dev environment set it to `https://apidev.trigglow.com`) and `TRIGGLOW_UPDATE_URL` (update feed, default `<API>/api/desktop/update`). All must be trusted hosts (`src/trust.ts`); localhost only in unpackaged builds.

## Build the installer

```bash
pnpm dist        # installer for THIS OS -> release/   (Windows: Trigglow-<v>-win-x64.exe)
pnpm dist:dir    # unpacked app only, quick check of the packaging
```

Config is `electron-builder.yml`. The Windows installer is one-click and per-user (no wizard, no admin rights), so updates install silently too. Files are packaged unpacked (no asar): the screens are served from disk over `trigglow-app://`.

## Release + auto-update

```bash
pnpm release patch --push     # or minor | major | 1.4.0 ; without --push it only prints the git push
```

That bumps `package.json`, writes the CHANGELOG entry, commits both, tags `desktop-vX.Y.Z` and pushes the tag. The **Release** workflow (`.github/workflows/release.yml`) then tests, builds Windows + Linux installers and publishes them — with `latest.yml`/`latest-linux.yml` and the `.blockmap` files the updater needs — as a GitHub release.

**How installed apps pick it up.** The app never talks to GitHub directly. `electron-updater` ("generic" provider) reads the API: `GET /api/desktop/update/latest.yml` (and the installer it names → a 302 to GitHub's short-lived signed URL, so the download comes from GitHub's CDN, not our server). The API finds the newest non-draft, non-prerelease `desktop-v*` release and caches it for 5 minutes. `GET /api/desktop/download/windows|mac|linux` redirects to the latest installer for a first install.

- The app checks 30 s after start and then every 4 h (Settings → Desktop app → *Updates* can turn the automatic check off or check now), downloads in the background (differential), and shows **Restart to update** in the title bar, the tray menu and a notification. A downloaded update also installs by itself the next time the app quits.
- **Server side:** the Trigglow API reads this repository's releases (the repository is set in its admin settings).
- **Code signing.** Windows updates work unsigned, but SmartScreen warns on first install — sign with a certificate (`CSC_LINK` / `CSC_KEY_PASSWORD` secrets, electron-builder picks them up). **macOS auto-update only works with a signed and notarized app**, which is why the workflow builds Windows and Linux only for now.

## Not done yet

- Code signing (see above) and the macOS build.
- The browser confirmation page still says "plugin link" (shared with the Stream Deck flow).
- More local actions (hotkeys, VTube Studio, …): a new action type on the API side and a case in `src/link.ts`.

## Opening overlay packs

The installer registers `.overlaytrigglow` (`fileAssociations` in `electron-builder.yml`; Windows and macOS — an AppImage doesn't register file types). Double-clicking one launches the app (or hands the path to the running one: `second-instance` argv, macOS `open-file`). `src/pack-open.ts` picks the file out; `main.ts` uploads it with the session cookie to `POST /api/overlay-packs/staged` and loads `/app/collections?pack=<id>`, where the web shows its usual import wizard. Nothing is read by the web page itself — the bridge-less rule above still holds. Signed out: the file waits until sign-in. A licensed pack opens "Redeem a code" instead; other errors show as a notification.
