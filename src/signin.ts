import { shell } from 'electron';
import { isTrustedUrl } from './trust';

const POLL_MS = 2000;
const TIMEOUT_MS = 10 * 60 * 1000;

interface SignInState {
  status: 'idle' | 'waiting' | 'error';
  error?: string;
  /** Browser URL the user must open if it didn't open by itself. */
  url?: string;
}

/**
 * Device-code sign-in, reusing the API's existing plugin link flow (`/auth/plugin/*`):
 * the user signs in with whatever method they like (Kick, Twitch, password + 2FA) in the
 * SYSTEM browser and confirms the code; we poll and receive a fresh session token.
 * Credentials and OAuth never touch the app window.
 */
export class SignIn {
  state: SignInState = { status: 'idle' };
  private run = 0;

  constructor(
    private apiOrigin: string,
    private onChange: () => void,
    private onToken: (token: string) => Promise<void>,
  ) {}

  private set(state: SignInState) {
    this.state = state;
    this.onChange();
  }

  cancel(): void {
    this.run += 1;
    this.set({ status: 'idle' });
  }

  async start(): Promise<void> {
    const run = ++this.run;
    this.set({ status: 'waiting' });
    try {
      const res = await fetch(`${this.apiOrigin}/auth/plugin/start?app=desktop`, { method: 'POST' });
      if (!res.ok) throw new Error(res.status === 429 ? 'rate_limited' : `start_failed_${res.status}`);
      const { deviceCode, verificationUrl } = (await res.json()) as { deviceCode: string; verificationUrl: string };
      if (run !== this.run) return;
      if (!isTrustedUrl(verificationUrl)) throw new Error('untrusted_verification_url');
      this.set({ status: 'waiting', url: verificationUrl });
      void shell.openExternal(verificationUrl);

      const deadline = Date.now() + TIMEOUT_MS;
      while (run === this.run && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (run !== this.run) return;
        // A network blip mid-poll (Wi-Fi drop, server restart) just means "ask again": the code stays valid until the deadline.
        const poll = await fetch(`${this.apiOrigin}/auth/plugin/poll?code=${encodeURIComponent(deviceCode)}`).catch(() => null);
        if (poll?.status === 404) throw new Error('expired');
        if (!poll?.ok) continue;
        const body = (await poll.json().catch(() => ({ status: 'pending' }))) as { status: string; token?: string };
        if (body.status === 'approved' && body.token) {
          this.run += 1;
          this.state = { status: 'idle' };
          await this.onToken(body.token);
          return;
        }
      }
      if (run === this.run) throw new Error('expired');
    } catch (err) {
      if (run === this.run) this.set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }
}
