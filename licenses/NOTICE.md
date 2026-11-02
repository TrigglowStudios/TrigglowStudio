# Third-party software in Trigglow Studio

Trigglow Studio is free software under the GNU General Public License v3.0 or later (`LICENSE`).
Its source code is at https://github.com/TrigglowStudios/TrigglowStudio.

The Windows build ships the broadcasting engine below, unmodified, in `vendor/obs-studio-node`:

| Component | Version | Licence | Source |
|---|---|---|---|
| obs-studio-node (Streamlabs) | 0.27.28 | GPL-2.0 (`GPL-2.0.txt`) | https://github.com/streamlabs/obs-studio-node/tree/0.27.28 |
| OBS Studio / libobs and its plugins | 32.1.1 (Streamlabs build) | GPL-2.0-or-later (`GPL-2.0.txt`) | https://github.com/streamlabs/obs-studio |
| FFmpeg and x264 (inside the engine) | as built by the engine | GPL-2.0-or-later | https://ffmpeg.org · https://www.videolan.org/developers/x264.html |
| Trigglow Dynamic Delay (Studio core) | pinned in `scripts/fetch-osn.mjs` | GPL-2.0-or-later | https://github.com/VirosMs/obs-trigglow-dynamic-delay |

The app itself is built with Electron (MIT) and the npm packages listed in `package.json`, each under its own licence.

Trigglow Studio is based on the OBS Studio engine and is not affiliated with or endorsed by the OBS Project or Streamlabs.
