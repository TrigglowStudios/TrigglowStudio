import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

const ASSETS_DIR = path.resolve(__dirname, '../assets');

test('signin.html has language selector with all 16 supported locales', () => {
  const html = fs.readFileSync(path.join(ASSETS_DIR, 'signin.html'), 'utf8');
  assert.ok(html.includes('id="lang-select"'), 'signin.html should contain language select element');

  const requiredLocales = ['en', 'es', 'pt-BR', 'zh', 'fr', 'it', 'de', 'ru', 'ko', 'ja', 'hi', 'ca', 'uk', 'ca-valencia', 'eu', 'gl'];
  for (const loc of requiredLocales) {
    assert.ok(html.includes(`value="${loc}"`), `signin.html must include option for locale ${loc}`);
  }
});

test('signin.html all data-i18n keys are translated across all 16 locales', () => {
  const html = fs.readFileSync(path.join(ASSETS_DIR, 'signin.html'), 'utf8');
  const i18nJs = fs.readFileSync(path.join(ASSETS_DIR, 'i18n.js'), 'utf8');

  // Parse DICT from i18n.js using VM sandbox
  const sandbox: Record<string, any> = {
    document: {
      documentElement: { lang: '' },
      querySelectorAll: () => [],
    },
    location: { search: '' },
    navigator: { language: 'en' },
    localStorage: { getItem: () => null, setItem: () => null },
    URLSearchParams: globalThis.URLSearchParams,
    CustomEvent: globalThis.CustomEvent || class CustomEvent {},
    dispatchEvent: () => true,
    window: {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(i18nJs, sandbox);

  // Extract keys from signin.html
  const matches = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(matches.length > 0, 'Found data-i18n keys in signin.html');

  // Also include error keys used by signin.js
  const extraKeys = [
    'signin.err.expired',
    'signin.err.rate_limited',
    'signin.err.generic',
    'signin.offline',
  ];

  const allKeys = Array.from(new Set([...matches, ...extraKeys]));
  const requiredLocales = ['en', 'es', 'pt-BR', 'zh', 'fr', 'it', 'de', 'ru', 'ko', 'ja', 'hi', 'ca', 'uk', 'ca-valencia', 'eu', 'gl'];

  for (const loc of requiredLocales) {
    sandbox.setLocale(loc);
    for (const key of allKeys) {
      const translated = sandbox.tr(key);
      assert.ok(
        translated && translated !== key,
        `Locale "${loc}" must have translation for "${key}", got "${translated}"`,
      );
    }
  }
});

test('i18n.js setLocale updates currentLocale and triggers localechange', () => {
  const i18nJs = fs.readFileSync(path.join(ASSETS_DIR, 'i18n.js'), 'utf8');

  let dispatchedEvent: any = null;
  const storage: Record<string, string> = {};

  const sandbox: Record<string, any> = {
    document: {
      documentElement: { lang: '' },
      querySelectorAll: () => [],
    },
    location: { search: '' },
    navigator: { language: 'en' },
    URLSearchParams: globalThis.URLSearchParams,
    localStorage: {
      getItem: (k: string) => storage[k] ?? null,
      setItem: (k: string, v: string) => { storage[k] = v; },
    },
    CustomEvent: class CustomEvent {
      type: string;
      detail: any;
      constructor(type: string, opts: any) {
        this.type = type;
        this.detail = opts?.detail;
      }
    },
    window: {},
  };
  sandbox.window = sandbox;
  sandbox.window.dispatchEvent = (e: any) => { dispatchedEvent = e; };

  vm.createContext(sandbox);
  vm.runInContext(i18nJs, sandbox);

  sandbox.setLocale('fr');
  assert.equal(sandbox.getLocale(), 'fr');
  assert.equal(sandbox.document.documentElement.lang, 'fr');
  assert.equal(storage['trigglow.locale'], 'fr');
  assert.equal(dispatchedEvent?.type, 'localechange');
  assert.equal(dispatchedEvent?.detail?.locale, 'fr');
  assert.equal(sandbox.tr('signin.cta'), 'Commencer');

  sandbox.setLocale('de');
  assert.equal(sandbox.tr('signin.cta'), 'Jetzt starten');

  sandbox.setLocale('zh');
  assert.equal(sandbox.tr('signin.cta'), '立即开始');

  sandbox.setLocale('pt-BR');
  assert.equal(sandbox.tr('signin.cta'), 'Começar agora');
});

/** i18n.js inside the app: a fake `trigglowShell` bridge standing in for the main process. */
function loadWithShell(opts: { main: { locale: string; chosen: boolean } | null; saved?: string; search?: string }) {
  const i18nJs = fs.readFileSync(path.join(ASSETS_DIR, 'i18n.js'), 'utf8');
  const storage: Record<string, string> = opts.saved ? { 'trigglow.locale': opts.saved } : {};
  const setCalls: unknown[][] = [];
  const events: string[] = [];
  let onState: ((s: unknown) => void) | null = null;
  const sandbox: Record<string, any> = {
    document: { documentElement: { lang: '' }, querySelectorAll: () => [] },
    location: { search: opts.search ?? '' },
    navigator: { language: 'en-US' },
    URLSearchParams: globalThis.URLSearchParams,
    localStorage: { getItem: (k: string) => storage[k] ?? null, setItem: (k: string, v: string) => { storage[k] = v; } },
    CustomEvent: class CustomEvent {
      type: string;
      detail: any;
      constructor(type: string, o: any) {
        this.type = type;
        this.detail = o?.detail;
      }
    },
    trigglowShell: {
      locale: () => opts.main,
      setLocale: (...args: unknown[]) => {
        setCalls.push(args);
        return Promise.resolve();
      },
      onState: (cb: (s: unknown) => void) => {
        onState = cb;
        return () => {};
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.dispatchEvent = (e: any) => events.push(`${e.type}:${e.detail?.locale}`);
  vm.createContext(sandbox);
  vm.runInContext(i18nJs, sandbox);
  return { sandbox, storage, setCalls, events, pushState: (s: unknown) => onState?.(s), subscribed: () => onState !== null };
}

test("i18n.js: the main process's language wins over this screen's localStorage and the OS", () => {
  const { sandbox, setCalls } = loadWithShell({ main: { locale: 'de', chosen: true }, saved: 'fr' });
  assert.equal(sandbox.getLocale(), 'de');
  assert.equal(sandbox.document.documentElement.lang, 'de');
  assert.deepEqual(setCalls, []);
});

test('i18n.js: an older pick kept in localStorage is handed to main once, as not-fresh, and shown', () => {
  const { sandbox, setCalls } = loadWithShell({ main: { locale: 'en', chosen: false }, saved: 'fr' });
  assert.equal(sandbox.getLocale(), 'fr');
  assert.deepEqual(setCalls, [['fr', false]]);
});

test('i18n.js: with nothing picked anywhere, the main process language (OS) is used', () => {
  const { sandbox, setCalls } = loadWithShell({ main: { locale: 'it', chosen: false } });
  assert.equal(sandbox.getLocale(), 'it');
  assert.deepEqual(setCalls, []);
});

test('i18n.js: a pick on the screen goes to the main process (fresh)', () => {
  const { sandbox, setCalls, storage } = loadWithShell({ main: { locale: 'en', chosen: false } });
  sandbox.setLocale('es');
  assert.equal(sandbox.getLocale(), 'es');
  assert.equal(storage['trigglow.locale'], 'es');
  assert.deepEqual(setCalls, [['es']]);
});

test('i18n.js: follows a language picked elsewhere (state push), ignoring unrelated state', () => {
  const { sandbox, events, pushState } = loadWithShell({ main: { locale: 'en', chosen: true } });
  pushState({ locale: 'zh' });
  assert.equal(sandbox.getLocale(), 'zh');
  assert.equal(sandbox.tr('signin.cta'), '立即开始');
  pushState({ obs: {} });
  pushState({ locale: 'zh' });
  assert.equal(sandbox.getLocale(), 'zh');
  assert.deepEqual(events, ['localechange:zh']);
});

test('i18n.js: ?lang= (set by the framing web page) pins the screen', () => {
  const { sandbox, subscribed } = loadWithShell({ main: { locale: 'de', chosen: true }, search: '?lang=pt-BR' });
  assert.equal(sandbox.getLocale(), 'pt-BR');
  assert.equal(subscribed(), false);
});
