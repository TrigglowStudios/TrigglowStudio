import { session } from 'electron';
import type { ControlAction } from './hotkey';

/** Same endpoint and session auth as the dashboard's control bar: POST /api/overlay/:slug/control {action}. */
export async function sendControl(apiOrigin: string, overlayId: string, action: ControlAction): Promise<boolean> {
  try {
    const res = await session.defaultSession.fetch(`${apiOrigin}/api/overlay/${encodeURIComponent(overlayId)}/control`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
