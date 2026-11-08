import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { LocalChatServer, loadOrCreateToken } from './local-server';

const TOKEN = 'a'.repeat(64);
const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigglow-dock-'));
fs.writeFileSync(path.join(assetsDir, 'clip-toast.html'), '<!doctype html><div id="t"></div>');

const server = new LocalChatServer({
  assetsDir,
  token: TOKEN,
  port: 0,
  getLocale: () => 'pt-BR',
  cs2Token: 'gsi-token',
  onCs2Gsi: (p) => gsi.push(p),
});
const gsi: unknown[] = [];
let port = 0;

before(async () => {
  port = await server.start();
});
after(() => {
  server.stop();
  fs.rmSync(assetsDir, { recursive: true, force: true });
});

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Raw http.request so the Host header can be forged (fetch would refuse to). */
function request(opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: { Host: `127.0.0.1:${port}`, ...opts.headers } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          body += c;
          // SSE never ends: stop after the init event.
          if (res.headers['content-type']?.startsWith('text/event-stream') && body.includes('"type"')) {
            req.destroy();
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
          }
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const auth = { Authorization: `Bearer ${TOKEN}` };

test('getClipToastUrl points at clip-toast.html with the same token, and that page is served', async () => {
  const url = server.getClipToastUrl();
  assert.equal(url, `http://127.0.0.1:${port}/clip-toast.html?token=${TOKEN}`);
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
});

test('API without a token or with a wrong one → 401 (header and query)', async () => {
  assert.equal((await request({ path: '/api/locale' })).status, 401);
  assert.equal((await request({ path: '/api/stream' })).status, 401);
  assert.equal((await request({ path: '/api/locale', headers: { Authorization: `Bearer ${'b'.repeat(64)}` } })).status, 401);
  assert.equal((await request({ path: '/api/locale', headers: { Authorization: 'Bearer short' } })).status, 401);
  assert.equal((await request({ path: `/api/stream?token=${'b'.repeat(64)}` })).status, 401);
});

test('?token= is accepted only on the SSE stream', async () => {
  assert.equal((await request({ path: `/api/locale?token=${TOKEN}` })).status, 401);
});

test('the old chat dock routes are gone', async () => {
  assert.equal((await request({ path: '/api/status', headers: auth })).status, 404);
  assert.equal((await request({ method: 'POST', path: '/api/send', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
});

test('GET /api/locale answers the app language', async () => {
  const res = await request({ path: '/api/locale', headers: auth });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { locale: 'pt-BR' });
});

test('broadcastLocale pushes the new language to open clip toasts over SSE', async () => {
  const body = await new Promise<string>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: `/api/stream?token=${TOKEN}`, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        text += c;
        if (text.includes('"init"') && !text.includes('"locale"')) server.broadcastLocale('fr');
        if (text.includes('"locale"')) {
          req.destroy();
          resolve(text);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
  assert.ok(body.includes(`data: ${JSON.stringify({ type: 'locale', locale: 'fr' })}\n\n`));
});

test('foreign Host (DNS rebinding) → 403, even with the token', async () => {
  assert.equal((await request({ path: '/api/locale', headers: { ...auth, Host: `evil.example:${port}` } })).status, 403);
  assert.equal((await request({ path: '/', headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await request({ path: '/api/locale', headers: { ...auth, Host: '127.0.0.1:1' } })).status, 403);
  assert.equal((await request({ path: '/api/locale', headers: { ...auth, Host: `localhost:${port}` } })).status, 200);
});

test('cross-site Origin → 403', async () => {
  const res = await request({ path: '/api/locale', headers: { ...auth, Origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
  const same = await request({ path: '/api/locale', headers: { ...auth, Origin: `http://127.0.0.1:${port}` } });
  assert.equal(same.status, 200);
});

test('no CORS: OPTIONS and responses never send Access-Control-Allow-Origin', async () => {
  const pre = await request({ method: 'OPTIONS', path: '/api/locale', headers: { 'Access-Control-Request-Method': 'GET' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers['access-control-allow-origin'], undefined);
  const res = await request({ path: '/api/locale', headers: auth });
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('SSE init event carries no user data', async () => {
  const res = await request({ path: `/api/stream?token=${TOKEN}` });
  assert.equal(res.status, 200);
  assert.match(res.body, /"type":"init"/);
  assert.doesNotMatch(res.body, /overlaySlug|displayName|user/);
});

test('the old dock URL shows where the dock moved, in the app language; path traversal stays inside assets', async () => {
  const page = await request({ path: '/' });
  assert.equal(page.status, 200);
  assert.match(page.body, /trigglow\.com\/app\/docks/);
  assert.match(page.body, /Crie um novo/);
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.equal((await request({ path: '/../package.json' })).status, 404);
});

test('loadOrCreateToken persists a 64-hex token and reuses it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigglow-tok-'));
  try {
    const file = path.join(dir, 'tok');
    const a = loadOrCreateToken(file);
    assert.match(a, /^[a-f0-9]{64}$/);
    assert.equal(loadOrCreateToken(file), a);
    fs.writeFileSync(file, 'garbage');
    assert.notEqual(loadOrCreateToken(file), 'garbage');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CS2 GSI: only bodies with the right auth.token reach onCs2Gsi', async () => {
  const post = (body: string) => request({ method: 'POST', path: '/cs2-gsi', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal((await post(JSON.stringify({ auth: { token: 'nope' } }))).status, 401);
  assert.equal((await post('{not json')).status, 400);
  assert.equal(gsi.length, 0);
  assert.equal((await post(JSON.stringify({ auth: { token: 'gsi-token' }, map: { name: 'de_dust2' } }))).status, 200);
  assert.deepEqual(gsi, [{ auth: { token: 'gsi-token' }, map: { name: 'de_dust2' } }]);
  // A browser page can't post here: the Origin check runs first.
  assert.equal((await request({ method: 'POST', path: '/cs2-gsi', headers: { Origin: 'https://evil.example' }, body: '{}' })).status, 403);
});
