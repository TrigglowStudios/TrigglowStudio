const shell = window.trigglowShell;

if (shell) {
  // Replies (some carry the dock URL and its token) go only to the page that asked: our parent, by its origin.
  const reply = (e, msg) => {
    if (e.source === parent && e.origin && e.origin !== 'null') parent.postMessage(msg, e.origin);
  };

  window.addEventListener('message', async (e) => {
    // Only our parent (the dashboard page main.ts already trusts) may drive this — never a sibling frame such as an ad.
    if (e.source !== parent) return;
    const data = e.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'trigglow:obs-dock-install') {
      try {
        const result = await shell.obsDockInstall({
          title: data.title || 'Trigglow Chat',
          url: typeof data.url === 'string' ? data.url : undefined,
          confirmRestart: Boolean(data.confirmRestart),
          // "Change the URL in OBS" (0.8.0): swap the old secret-URL dock of this kind.
          replaceLegacy: data.replaceLegacy === 'activity' || data.replaceLegacy === 'chat' ? data.replaceLegacy : undefined,
          // Which old dock: the sha256 of its #k= credential (the shell only swaps that one).
          replaceCredentialHash: typeof data.replaceCredentialHash === 'string' ? data.replaceCredentialHash : undefined,
        });
        reply(e, { type: 'trigglow:obs-dock-result', result });
      } catch (err) {
        reply(e, { type: 'trigglow:obs-dock-result', error: String(err.message || err) });
      }
    } else if (data.type === 'trigglow:obs-docks-status') {
      // "Set up both docks in OBS": which Trigglow docks OBS already has (presence flags only).
      try {
        const result = await shell.obsDocksStatus();
        reply(e, { type: 'trigglow:obs-docks-status-result', result });
      } catch (err) {
        reply(e, { type: 'trigglow:obs-docks-status-result', error: String(err.message || err) });
      }
    } else if (data.type === 'trigglow:obs-docks-install') {
      try {
        const docks = Array.isArray(data.docks)
          ? data.docks.slice(0, 2).map((d) => ({
              kind: d && (d.kind === 'activity' || d.kind === 'chat') ? d.kind : undefined,
              title: d && typeof d.title === 'string' ? d.title : undefined,
              url: d && typeof d.url === 'string' ? d.url : undefined,
              replaceCredentialHash: d && typeof d.replaceCredentialHash === 'string' ? d.replaceCredentialHash : undefined,
            }))
          : [];
        const result = await shell.obsDocksInstall({ docks, confirmRestart: Boolean(data.confirmRestart) });
        reply(e, { type: 'trigglow:obs-docks-result', result });
      } catch (err) {
        reply(e, { type: 'trigglow:obs-docks-result', error: String(err.message || err) });
      }
    } else if (data.type === 'trigglow:obs-stream-setup') {
      // Multistream: Trigglow's ingest server + key into OBS → Settings → Stream (main.ts validates both).
      try {
        const result = await shell.obsStreamSetup({ server: data.server, key: data.key });
        reply(e, { type: 'trigglow:obs-stream-setup-result', result });
      } catch (err) {
        reply(e, { type: 'trigglow:obs-stream-setup-result', error: String(err.message || err) });
      }
    } else if (data.type === 'trigglow:obs-video-fit') {
      // Multistream: lower OBS's output resolution / fps to the plan's limits.
      try {
        const result = await shell.obsVideoFit({ maxLines: data.maxLines, maxFps: data.maxFps });
        reply(e, { type: 'trigglow:obs-video-fit-result', result });
      } catch (err) {
        reply(e, { type: 'trigglow:obs-video-fit-result', error: String(err.message || err) });
      }
    } else if (data.type === 'trigglow:chat-get-clip-toast-url') {
      try {
        const url = await shell.clipToastUrl();
        reply(e, { type: 'trigglow:clip-toast-url-result', url });
      } catch (err) {
        console.warn('[chat-tools] get clip toast url failed:', err);
      }
    }
  });

  // `features`: what this shell can do beyond the original messages, so the page only offers what works here.
  parent.postMessage({ type: 'trigglow:chat-tools-ready', features: ['obs-stream-setup', 'obs-video-fit'] }, '*');
}
