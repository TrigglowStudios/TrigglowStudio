import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

interface LocalServerOptions {
  assetsDir: string;
  /**
   * Shared secret every /api/* request must carry. Defaults to a fresh random token per start; main.ts passes a
   * persisted one so the URL the streamer pasted into OBS keeps working across restarts.
   */
  token?: string;
  /** First port to try (default 45455; 0 = any free port, used by tests). */
  port?: number;
  /** The app's language, for the clip toast's strings and the moved-dock notice (GET /api/locale). Default 'en'. */
  getLocale?: () => string;
}

/** Shown where the old local chat dock lived (OBS docks pasted before /app/docks): where to get the new one. */
const DOCK_MOVED: Record<string, string> = {
  en: 'This chat dock has moved. Create a new one at trigglow.com/app/docks and add it to OBS from there.',
  es: 'Este panel de chat se ha movido. Crea uno nuevo en trigglow.com/app/docks y añádelo a OBS desde ahí.',
  'pt-BR': 'Este dock de chat mudou. Crie um novo em trigglow.com/app/docks e adicione ao OBS por lá.',
  fr: 'Ce dock de chat a déménagé. Crée-en un nouveau sur trigglow.com/app/docks et ajoute-le à OBS depuis là.',
  it: 'Questo dock della chat si è spostato. Creane uno nuovo su trigglow.com/app/docks e aggiungilo a OBS da lì.',
  de: 'Dieses Chat-Dock ist umgezogen. Erstelle ein neues unter trigglow.com/app/docks und füge es dort zu OBS hinzu.',
  ru: 'Этот чат-док переехал. Создайте новый на trigglow.com/app/docks и добавьте его в OBS оттуда.',
  ko: '이 채팅 독은 이동했어요. trigglow.com/app/docks에서 새로 만들고 거기서 OBS에 추가해 주세요.',
  ja: 'このチャットドックは移動しました。trigglow.com/app/docks で新しく作成し、そこから OBS に追加してください。',
  hi: 'यह चैट डॉक अब यहाँ से हट गया है। trigglow.com/app/docks पर नया बनाएँ और वहीं से उसे OBS में जोड़ें।',
  ca: 'Aquest dock de xat s’ha mogut. Crea’n un de nou a trigglow.com/app/docks i afegeix-lo a l’OBS des d’allà.',
  'ca-valencia': 'Este dock de xat s’ha mogut. Crea’n un de nou a trigglow.com/app/docks i afig-lo a l’OBS des d’allà.',
  eu: 'Txat dock hau lekuz aldatu da. Sortu berri bat trigglow.com/app/docks helbidean eta gehitu OBS-ra handik.',
  gl: 'Este dock de chat moveuse. Crea un novo en trigglow.com/app/docks e engádeo a OBS desde alí.',
  uk: 'Цей чат-док переїхав. Створіть новий на trigglow.com/app/docks і додайте його в OBS звідти.',
  zh: '此聊天停靠窗口已迁移。请在 trigglow.com/app/docks 创建新的停靠窗口，并从那里添加到 OBS。',
};
const TOKEN_RE = /^[a-f0-9]{64}$/;

export const generateToken = () => crypto.randomBytes(32).toString('hex');

/** Reads the local server token from `file`, creating it (owner-only) when missing or malformed. */
export function loadOrCreateToken(file: string): string {
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (TOKEN_RE.test(t)) return t;
  } catch {
    /* missing: create below */
  }
  const t = generateToken();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, t, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    console.warn('[local-chat] could not persist dock token; using a per-start token:', (err as Error).message);
  }
  return t;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export class LocalChatServer {
  private server: http.Server | null = null;
  private sseClients = new Set<http.ServerResponse>();
  private port: number;
  private boundPort: number | null = null;
  private readonly token: string;

  constructor(private opts: LocalServerOptions) {
    this.port = opts.port ?? 45455;
    this.token = opts.token && TOKEN_RE.test(opts.token) ? opts.token : generateToken();
  }

  start(): Promise<number> {
    return new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      // Startup awaits this, so it must always settle: a few ports up, then any free port (e.g. EACCES on a port Windows
      // reserved for Hyper-V/WSL/Docker), and if even that fails the app runs without the clip toast.
      let tries = 0;
      s.on('error', (err: NodeJS.ErrnoException) => {
        if (this.server) return console.error('[local-chat] server error:', err);
        if (err.code === 'EADDRINUSE' && ++tries < 20) {
          console.warn(`[local-chat] port ${this.port} in use, trying next port`);
          this.port++;
        } else if (this.port !== 0) {
          console.warn(`[local-chat] port ${this.port} unavailable (${err.code}), using any free port`);
          this.port = 0;
        } else {
          console.error('[local-chat] could not start:', err);
          return resolve(0);
        }
        s.listen(this.port, '127.0.0.1');
      });

      s.listen(this.port, '127.0.0.1', () => {
        const addr = s.address();
        this.boundPort = typeof addr === 'object' && addr ? addr.port : this.port;
        this.server = s;
        console.log(`[local-chat] Clip toast server listening on http://127.0.0.1:${this.boundPort}`);
        resolve(this.boundPort);
      });
    });
  }

  /** The clip toast browser source (clip-toast.html) with the same access token — for OBS → Browser Source. */
  getClipToastUrl(): string {
    return this.urlFor('/clip-toast.html');
  }

  private urlFor(pathname: string): string {
    return `http://127.0.0.1:${this.boundPort ?? this.port}${pathname}?token=${this.token}`;
  }

  /** The app's language changed: open clip toasts switch right away (they also re-read GET /api/locale on every reconnect). */
  broadcastLocale(locale: string) {
    this.sendSse({ type: 'locale', locale });
  }

  /** Drives the clip-toast.html browser source: saving → uploading → done / failed. */
  broadcastClip(clip: { phase: string; title?: string }) {
    this.sendSse({ type: 'clip', ...clip });
  }

  private sendSse(data: unknown) {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  private allowedHosts(): Set<string> {
    const p = this.boundPort ?? this.port;
    return new Set([`127.0.0.1:${p}`, `localhost:${p}`]);
  }

  /** Bearer header everywhere; `?token=` only where the client cannot set headers (EventSource). */
  private hasToken(req: http.IncomingMessage, url: URL, allowQuery: boolean): boolean {
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) return safeEqual(auth.slice(7).trim(), this.token);
    if (allowQuery) {
      const q = url.searchParams.get('token');
      if (q) return safeEqual(q, this.token);
    }
    return false;
  }

  private deny(res: http.ServerResponse, status: number, error: string) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error }));
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    // Same-origin only: no CORS headers at all. Never leak the dock URL (and its token) through Referer.
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // DNS rebinding: a hostile page resolving its own name to 127.0.0.1 still sends its own Host.
    const host = (req.headers.host ?? '').toLowerCase();
    if (!this.allowedHosts().has(host)) {
      this.deny(res, 403, 'forbidden_host');
      return;
    }
    // Cross-site requests from a browser carry their Origin; only our own origin may call us.
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin !== `http://${host}`) {
      this.deny(res, 403, 'forbidden_origin');
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { Allow: 'GET' });
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url ?? '/', `http://${host}`);
    const pathname = parsedUrl.pathname;

    if (pathname.startsWith('/api/')) {
      const isStream = pathname === '/api/stream' && req.method === 'GET';
      if (!this.hasToken(req, parsedUrl, isStream)) {
        this.deny(res, 401, 'unauthorized');
        return;
      }
    }

    // SSE stream for the clip toast (clip phases, language)
    if (pathname === '/api/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      // The clip toast only needs to know the stream is live — no user data (overlay slug etc.) here.
      res.write(`data: ${JSON.stringify({ type: 'init' })}\n\n`);

      this.sseClients.add(res);
      req.on('close', () => {
        this.sseClients.delete(res);
      });
      return;
    }

    // The clip toast writes its UI in the app's language (not the OBS browser's).
    if (pathname === '/api/locale' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ locale: this.opts.getLocale?.() ?? 'en' }));
      return;
    }

    if (pathname.startsWith('/api/')) {
      this.deny(res, 404, 'not_found');
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      this.deny(res, 405, 'method_not_allowed');
      return;
    }

    // The old local chat dock (still pasted in some OBS installs): a static note pointing at /app/docks.
    if (pathname === '/' || pathname === '/chat' || pathname === '/dock') {
      const lang = this.opts.getLocale?.() ?? 'en';
      const text = DOCK_MOVED[lang] ?? DOCK_MOVED[lang.split('-')[0]] ?? DOCK_MOVED.en;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><body style="margin:0;padding:16px;background:#161318;color:#efe9e1;font:14px/1.5 Figtree,system-ui,sans-serif">${text}</body>`);
      return;
    }

    // Serve static assets from assetsDir
    const root = path.resolve(this.opts.assetsDir);
    const safePath = path.normalize(path.join(root, pathname.replace(/^\//, '')));
    if (safePath.startsWith(root + path.sep) && fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
      const ext = path.extname(safePath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.png': 'image/png',
        '.ico': 'image/x-icon',
        '.svg': 'image/svg+xml',
        '.woff2': 'font/woff2',
      };
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] ?? 'application/octet-stream' });
      fs.createReadStream(safePath).pipe(res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  stop() {
    for (const client of this.sseClients) {
      try {
        client.end();
      } catch {
        /* ignore */
      }
    }
    this.sseClients.clear();
    this.server?.close();
    this.server = null;
  }
}
