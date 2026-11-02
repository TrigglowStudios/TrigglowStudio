# Changelog — Trigglow Studio (Windows, Linux)

All notable changes to the Trigglow Studio desktop app are documented in this file.

## [Unreleased]

## [0.10.0] - 2026-11-02

### Changed
- Clips keep the resolution OBS records at (1440p, 4K…) instead of always shrinking to 1080p, and the frame rate is kept. You can still pick 1080p or 720p in the Clips card if uploads are slow.
- Choose whether new clips go up private, unlisted or public, and set the title with {game} and {date}: by default it is the category you were streaming and the date.
- The chat message TrigglowBot posts for a Stream Deck clip can be switched off or rewritten ({link} is the clip link). Private clips posted to chat go up as unlisted, so the link works.
- Games with NVIDIA Highlights (Fortnite and others): when the game saves a kill or a win, the app saves your Replay Buffer right then, with your camera and overlays. On by default while you are live; you can turn it off or pick the folder in the Clips card.
- Clips that already play in every browser and fit your plan go up exactly as OBS saved them, with no re-encoding on your PC. When a clip does need it, the app uses your graphics card (NVIDIA, AMD or Intel) instead of the processor, so the game and OBS keep their CPU.
- New look to match the web: warm dark colours, rounded cards and buttons, and violet only on the main action, on the sign-in, setup, settings and title bar screens.
- The whole app is now translated into all 16 languages: setup, settings, clips, shortcuts, text sources and updates no longer show in English when you use another language.
- The app is now called Trigglow Studio: the new name is on the window, the title bar, the tray and the sign-in screen. Your account, settings and clips stay as they were.
- Connecting Twitch, Kick, YouTube, Discord or Spotify now opens in your usual browser instead of inside the app. Confirm the Trigglow account there, sign in to the platform and come back: the app shows the result as soon as you return.
- The floating chat window and the Live chat page are gone: chat lives in the OBS chat dock and in Trigglow Studio's chat dock.

### Fixed
- A link to Trigglow's home page in your language (for example /es) shows the app's sign-in screen, like the English one, instead of opening your browser.
- The alerts source the app adds to OBS is created centred on the canvas, not low and to the right. Sources you already placed stay where they are.

## [0.9.0] - 2026-11-01

### Added
- 9 more languages (ru, uk, ko, ja, hi, ca, Valencian, eu, gl) and a language picker with flags
- Write both Trigglow docks into OBS in one go
- Install docks from <web origin>/dock/activity|chat
- 0.8.0 installs code-linked docks and changes old dock URLs in OBS
- Integrate Anthropic AI SDK for Claude model support in AI chat functionality

### Fixed
- OBS config files are replaced atomically
- "Change the URL in OBS" swaps only the matching #k= dock (L2)

## [0.8.0] - 2026-10-27

### Changed
- **OBS docks without a secret in the URL:** the dock installer accepts the public `www.trigglow.com/dock/activity` and `/dock/chat` URLs and one-use desktop tickets (`#e=tgde_…`), and refuses the old secret URLs (`#k=tgdr_…`). The dock links itself the first time OBS opens it; after 48 hours it asks for a code instead.

### Added
- **Both OBS docks in one click:** `/app/docks` sets up the activity and the chat dock together (one form, one 2FA code) and the app writes both into OBS. A kind OBS already has is kept, never added twice; an old secret-URL dock is only swapped when its credential matches; another dock's name is never overwritten. OBS running: the same "restart OBS" prompt as for one dock.
- **Change the URL in OBS:** for an old secret-URL dock, `/app/docks` replaces its URL in OBS with a new one-use link and keeps the dock's own name. The old dock is revoked once the new one is opened. Old `dock.trigglow.com/…#k=` docks are recognised only to be replaced, always with the new URL.

### Fixed
- **OBS config written atomically:** `user.ini`, the obs-websocket config and the profile `basic.ini` are written to a temporary file and renamed over the original (previous copy kept as `.trigglow-bak`). A file OBS holds locked is left untouched and the dock install answers `write_failed` instead of leaving half a file.

## [0.7.0] - 2026-10-26

### Added
- **One-click OBS docks:** the dock dialog on `/app/docks` adds a new activity or chat dock to OBS. The shell only accepts `dock.trigglow.com/activity|chat#k=tgdr_…` URLs.

### Changed
- **Local chat dock removed** (`chat-dock.html`, API proxy, overlay chat relay, overlay room join): chat in OBS uses the chat docks from `/app/docks`. The local server only serves the clip toast, and the old dock URL shows where docks moved.
- The chat pop-out loads `/app/chat?popout=1`.

### Fixed
- **Linux:** the dock and taskbar show the Trigglow icon (`desktopName` sets the window's app_id / WM_CLASS to match the `.desktop` entry).

### Security
- **Electron 44.9.3.**
- **Now playing on Linux:** track art from MPRIS is only read from players' cache and temp folders (after resolving symlinks), its type is taken from the file's bytes instead of its name, and https art is only fetched from known art CDNs with redirects refused. A playlist can no longer make Trigglow publish another image from your disk, or fetch from your local network, on the music overlay.

## [0.6.1] - 2026-10-20

### Added
- **Linux (alpha, x64):** AppImage, .deb, .rpm, .pacman and .tar.gz builds. All but the .tar.gz update themselves; the packages register the `.overlaytrigglow` file association.
- **Now playing on Linux:** read from MPRIS through `playerctl` (Spotify first, else any player), art included. Without `playerctl` it logs once and stays off.
- **Global shortcuts on Wayland** through the GlobalShortcuts portal (KDE, GNOME 48+).
- **OBS as Flatpak or Snap:** its config folder (WebSocket password, Replay Buffer, dock) is found, and it is launched with `flatpak run` / the Snap.
- **Start with your computer on Linux** through an XDG autostart entry (kept pointing at the AppImage after updates).

### Changed
- On Linux, closing the window quits by default (stock GNOME has no tray).
- On Linux without a keyring the manual OBS password is stored like when encryption is unavailable, so a later keyring can't lock it out.

### Fixed
- Installing an overlay in an OBS without the browser source (some distro packages) says so instead of a generic error.

## [0.6.0] - 2026-10-18

### Added
- **Open overlay packs with a double-click:** the installer registers `.overlaytrigglow` (Windows, macOS); opening one hands it to the running app, which uploads it with your session and shows the import wizard in Collections. Signed out, it waits for sign-in; a licensed pack opens Redeem a code.
- **League of Legends moments:** while you're live, the app reads Riot's official Live Client Data API (only during a match) and reports your kills and multikills, first blood, aces, objectives and steals, close escapes, match start, champion, KDA and result, so your stream highlights know what happened in the game.
- **League of Legends switch:** a "Games" card in Settings → General with **Detect League of Legends matches** (on by default); when off, the app stops reading the Live Client Data API and sends no LoL moments.
- Replay clips send when they were captured, so they land at the right time in the stream highlights.

### Changed
- **The app follows your account language:** the app, the chat dock and the pop-out chat use the language set on your Trigglow account.
- **Chat event lines in your language:** follows, subs, gifted subs, raids and tips in the chat dock and pop-out chat (and the pinned-message label) are shown in the streamer's language.
- **One-click OBS import:** emote rain is added full screen (1920×1080) and the Activity overlay at 500 px wide; emote rain sources added before are upgraded when you add them again.

### Fixed
- The pop-out chat and the OBS chat dock showed no messages or events after the first one.
- The app could hang at startup, with no window or tray icon, when Windows had reserved the local chat dock's port (Hyper-V, WSL, Docker). It now picks a free port.
- "Turn it on for me" (Replay Buffer, clip length) changed the wrong OBS profile on OBS 31 and newer when you have more than one profile.
- Importing the chat dock with "restart OBS" wrote the dock while OBS was still open (so OBS dropped it) and could start a second OBS. If OBS doesn't close it now says so; OBS is never closed when the app can't find it to open it again.
- On OBS 30 and older, the chat dock is added where that version keeps it.
- One damaged file in the clip upload queue stopped every queued clip from uploading.
- Opening Trigglow (or a pack) twice while it was starting could crash the first window.
- A clip shortcut pressed while queued clips were uploading did nothing; it now saves the clip (and says so when another clip is still being saved).
- Queued clips only upload to the account they were made on, and a dropped clip (too old, too many failed tries) shows a notification. Being signed out no longer uses up a clip's tries.
- A short network drop no longer cancels signing in.
- If the system keychain can't decrypt the saved OBS password, only that password has to be entered again; your other settings are kept. Settings are saved safely, so a crash or full disk can't reset them.
- The app menu follows the app's language, and the Dock icon reopens the window on macOS.

### Performance
- Clips upload straight from disk instead of being loaded into memory (up to ~1 GB less RAM on long clips).
- Clip encoding runs at below-normal priority on half of your CPU cores, so the game and OBS come first. Clips saved "for after the stream" are encoded after the stream, not while you're live.
- OBS audio meters are only requested while you're live (they're ~50 messages a second), and frame samples for automatic highlights never pile up.
- While OBS is closed, the app checks for it less and less often (up to every 30 s) instead of every 4 s.
- Now-playing sends the album art once per song instead of every few seconds.
- Updates aren't downloaded while you're live.
- Smaller install: only the app's languages of Chromium's UI strings are included.

### Security
- Only the dashboard page itself can ask the app to install the OBS chat dock or open the pop-out chat (other frames on the page, such as ads, can't), and the dock link always comes from the app.
- Camera, microphone, notifications and other browser permissions are only granted to Trigglow's own pages.
- Production builds no longer trust the develop site, and a custom update address must be a Trigglow one.
- Electron hardening: it can't be run as a plain Node.js runtime, Node options and the inspector are disabled, and the session cookie is encrypted with the system keychain.
- Emote images in the chat dock are escaped.

## [0.5.1] - 2026-10-14

### Added
- Settings in tabs, open OBS on launch, reload keeps the current page
- Clip library uploads, reports, pre-roll ads, bulk grant changes and the 61 API bug fixes
- Song-request controls for Stream Deck (beta), desktop shortcuts and OBS

### Fixed
- Harden trigger flow, paid alerts and desktop local server

## [0.5.0] - 2026-10-14

### Added
- **Upload clips after the stream:** Clips → settings → "Upload clips" → "When the stream ends or OBS closes". Clips made while live stay on this PC (with a "Clip saved" notification and a count of clips waiting) and upload when OBS stops streaming / recording or closes. Clips posted to chat always upload right away.
- **Settings in tabs:** OBS, Clips, Hotkeys and General (the last tab is remembered), with OBS / local server status chips and the app version always at the top, and a red dot on the OBS tab while OBS is disconnected.
- **Open OBS when Trigglow starts** (OBS tab, off by default): launches OBS only if it isn't running; a running OBS is never restarted.
- **Song-request shortcuts:** global keys for skip, pause / play, volume up / down, clear the queue and open / close requests. Shortcuts are grouped into "Alerts" and "Song requests".

### Changed
- OBS connection errors are explained in plain words; the raw socket error (e.g. `ECONNREFUSED`) is only in the tooltip.
- **Clips land in the library as private;** publish them from the web. Clips announced in chat stay watchable.
- **The local chat dock and clip toast now need an access key.** Their links (`http://127.0.0.1:45455/…`) carry a `?token=` that the app creates once and keeps in its data folder (`local-dock-token`), so the links survive restarts. Keep them private.
- **Action needed after updating:** chat docks and clip toast sources you already added to OBS stop working. Add them again: Chat → **Add to OBS** (or copy the new dock link into OBS → Docks → Custom Browser Docks), and Clips → settings → copy the clip toast link into its Browser Source.
- To change the key (for example if a link leaked), close the app, delete the `local-dock-token` file and add the dock and clip toast to OBS again.

### Fixed
- Reload went back to the dashboard home instead of reloading the current page.
- A window restored maximized could lay out the dashboard at the default size.
- App settings embedded in the dashboard were cut off past 2000 px.

### Security
- The local server only answers to `127.0.0.1` / `localhost` (Host and Origin checked, no more open CORS), only accepts JSON posts up to 64 KB and no longer sends your overlay link to the dock or the clip toast.

## [0.4.0] - 2026-10-12

- Internal improvements.

## [0.3.2] - 2026-10-11

### Added
- **Now playing for the music overlay:** Trigglow Desktop reads what's playing in Windows (Spotify, YouTube Music, browser, any player) and sends it to your music overlay, no Spotify connection needed. Turn it on from the Music page inside the app.

## [0.3.1] - 2026-10-11

### Fixed
- **Taskbar and window previews showed "@trigglow/desktop":** the app is now called "Trigglow" (and "Trigglow Chat" for the chat window). Your session and settings are kept.

## [0.3.0] - 2026-10-11

### Added
- **Automatic highlights:** while you stream, Trigglow watches your OBS audio (shouts, laughs, explosions) and how much the picture moves, and saves a clip when something stands out from your usual. Choose Off / Only big moments / Balanced / Catch more in the clip settings (off by default). It learns your normal in the first minute or two and clips at most once a minute.
- **"Clip replay" automation action:** save the Replay Buffer and upload it as a clip from any OBS automation.
- **Clip toast in OBS:** a small card confirms when a clip is saved and uploaded.
- **Upload retry queue:** clips that fail to upload (offline, server hiccup) are retried automatically instead of being lost.
- Free accounts see the clip length limit in the settings, with the longer Plus limit as a hint.

## [0.2.0] - 2026-10-07

### Added
- **Stream title & category for all platforms at once:** a dashboard card (also in the tray) updates Kick and Twitch together. Kick/Twitch must be reconnected once to grant the new write scope.
- **More OBS automations:** actions to start/stop the stream, set a text source, trigger an OBS hotkey and set an input volume; events for "stream reconnecting" and input muted/unmuted (optionally for one input).
- The window remembers its size, position and maximized state; the tray menu is translated and its tooltip shows the OBS status; the title bar shows an OBS connection badge.

### Changed
- **New look for every bundled screen** (title bar, sign-in, first-run setup, settings, chat dock): flat dark surfaces, hairline borders, square controls and mono uppercase buttons, matching the redesigned web.
- Settings panel cards and checkboxes now match the redesigned web (surface tokens, branded checkbox, reduced-motion support).

## [0.1.0] - 2026-09-30

### Added
- **Automatic OBS Studio connection:** smart detection of OBS WebSocket server on your local machine with zero manual passwords, ports, or complex configuration.
- **One-click overlay installation:** deploy your alerts, widgets, and dynamic overlays directly into any active OBS Studio scene from the desktop app without copying or pasting URLs.
- **Instant Clips from Replay Buffer:** capture recent stream highlights with the global configurable hotkey (`Ctrl+Alt+C`) or Stream Deck, uploading them automatically to your clips library.
- **Native GDI+ text sources:** project your latest follower, tip, sub, or event onto OBS via lightweight local text files without browser resource overhead.
- **Integrated auto-updater:** background update checks and downloads with Electron Updater.
- **Native desktop notifications:** stay informed about stream events, follows, and donations while gaming in full screen.
- **First-run onboarding wizard:** guided setup on initial launch with automatic OBS verification.
