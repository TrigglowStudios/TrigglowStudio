import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APP_LOCALES, pickLocale, reconcileAccountLocale, toAppLocale, type LocalePrefs } from './locale';

const none: LocalePrefs = { locale: null, localePending: false };

test('toAppLocale maps language tags to the shipped set, anything else to null', () => {
  assert.equal(toAppLocale('fr-CA'), 'fr');
  assert.equal(toAppLocale('pt_PT'), 'pt-BR');
  assert.equal(toAppLocale('zh-Hans-CN'), 'zh');
  assert.equal(toAppLocale(' DE '), 'de');
  assert.equal(toAppLocale('en-GB'), 'en');
  for (const l of APP_LOCALES) assert.equal(toAppLocale(l), l);
  for (const bad of ['ar', 'nl-NL', '', null, undefined, 5, {}]) assert.equal(toAppLocale(bad), null);
});

test('with nothing picked the OS decides, and an unsupported OS language falls back to English', () => {
  assert.equal(pickLocale(none, null, 'es-MX'), 'es');
  assert.equal(pickLocale(none, null, 'ar-SA'), 'en');
  assert.equal(pickLocale(none, null, undefined), 'en');
  assert.equal(pickLocale(none, null, 'ja-JP'), 'ja');
  assert.equal(pickLocale(none, null, 'uk-UA'), 'uk');
  assert.equal(pickLocale(none, null, 'ca-ES-valencia'), 'ca-valencia');
  assert.equal(pickLocale(none, null, 'eu-ES'), 'eu');
  assert.equal(pickLocale(none, null, 'gl-ES'), 'gl');
});

test('a language picked in the app beats the OS', () => {
  assert.equal(pickLocale({ locale: 'fr', localePending: true }, null, 'en-US'), 'fr');
  assert.equal(pickLocale({ locale: 'fr', localePending: false }, null, 'en-US'), 'fr');
});

test("signed in, the account's language beats an older pick and the OS", () => {
  assert.equal(pickLocale({ locale: 'fr', localePending: false }, 'de', 'en-US'), 'de');
  assert.equal(pickLocale(none, 'it', 'en-US'), 'it');
});

test('a pick the account has not got yet beats the account (it is the newest choice)', () => {
  assert.equal(pickLocale({ locale: 'fr', localePending: true }, 'de', 'en-US'), 'fr');
});

test('a waiting pick is pushed to the account, and is done once the account has it', () => {
  const waiting: LocalePrefs = { locale: 'fr', localePending: true };
  assert.deepEqual(reconcileAccountLocale(waiting, 'en'), { prefs: waiting, push: 'fr' });
  assert.deepEqual(reconcileAccountLocale(waiting, null), { prefs: waiting, push: 'fr' });
  assert.deepEqual(reconcileAccountLocale(waiting, 'fr'), { prefs: { locale: 'fr', localePending: false }, push: null });
});

test("otherwise the account's language is remembered (for the signed-out screens), never pushed", () => {
  assert.deepEqual(reconcileAccountLocale({ locale: 'fr', localePending: false }, 'de'), { prefs: { locale: 'de', localePending: false }, push: null });
  assert.deepEqual(reconcileAccountLocale(none, 'es'), { prefs: { locale: 'es', localePending: false }, push: null });
  // Account never set: keep what we have, do not write it.
  assert.deepEqual(reconcileAccountLocale({ locale: 'fr', localePending: false }, null), { prefs: { locale: 'fr', localePending: false }, push: null });
  assert.deepEqual(reconcileAccountLocale(none, null), { prefs: none, push: null });
});

test('a language just changed on the account (web dashboard menu) beats a pick still waiting', () => {
  assert.deepEqual(reconcileAccountLocale({ locale: 'fr', localePending: true }, 'de', true), { prefs: { locale: 'de', localePending: false }, push: null });
});
