import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyNav } from './nav';
import { allowDevStack, allowLocalhost } from './trust';

test('navigation policy keeps the app on /app', () => {
  allowLocalhost(false);
  assert.equal(classifyNav('https://trigglow.com/app/automations?x=1'), 'allow');
  assert.equal(classifyNav('https://trigglow.com/app'), 'allow');
  assert.equal(classifyNav('https://trigglow.com/login'), 'signin');
  assert.equal(classifyNav('https://trigglow.com/'), 'signin');
  assert.equal(classifyNav('https://trigglow.com/docs'), 'external');
  assert.equal(classifyNav('https://trigglow.com/admin'), 'external');
  assert.equal(classifyNav('https://trigglow.com/application'), 'external');
  assert.equal(classifyNav('https://trigglow.com.evil.io/app'), 'external');
  assert.equal(classifyNav('javascript:alert(1)'), 'ignore');
  assert.equal(classifyNav('file:///etc/passwd'), 'ignore');
});

test('account links go to the browser flow, provider pages never load in the app', () => {
  allowLocalhost(false);
  assert.equal(classifyNav('https://api.trigglow.com/auth/discord/start'), 'link');
  assert.equal(classifyNav('https://api.trigglow.com/auth/twitch/start?intent=link&next=%2Fapp'), 'link');
  assert.equal(classifyNav('https://api.trigglow.com/auth/youtube/start?intent=multistream'), 'link');
  assert.equal(classifyNav('https://api.trigglow.com/auth/spotify/start'), 'link');
  assert.equal(classifyNav('https://api.trigglow.com/auth/kick/start?intent=link'), 'link');
  // Any other /auth page (callbacks, plugin pages) and the providers themselves: system browser.
  assert.equal(classifyNav('https://api.trigglow.com/auth/kick/callback?code=x'), 'external');
  assert.equal(classifyNav('https://evil.io/auth/twitch/start'), 'external');
  assert.equal(classifyNav('https://discord.com/oauth2/authorize'), 'external');
  assert.equal(classifyNav('https://id.twitch.tv/oauth2/authorize'), 'external');
});

test('localhost is only trusted in dev builds', () => {
  allowLocalhost(false);
  assert.equal(classifyNav('http://localhost:5173/app'), 'external');
  assert.equal(classifyNav('http://localhost:5173/auth/twitch/start?intent=link'), 'external');
  allowLocalhost(true);
  assert.equal(classifyNav('http://localhost:5173/app'), 'allow');
  assert.equal(classifyNav('http://localhost:5173/auth/twitch/start?intent=link'), 'link');
  allowLocalhost(false);
});

test('the develop host is only trusted by builds pointed at it', () => {
  allowDevStack(false);
  assert.equal(classifyNav('https://dev.trigglow.com/app'), 'external');
  allowDevStack(true);
  assert.equal(classifyNav('https://dev.trigglow.com/app'), 'allow');
  allowDevStack(false);
});
