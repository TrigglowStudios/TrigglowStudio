import assert from 'node:assert/strict';
import { test } from 'node:test';
import { obsHint, parseWebsocketConfig } from './obs-detect';

test('reads port and password from obs-websocket config', () => {
  const raw = JSON.stringify({ server_enabled: true, server_port: 4466, auth_required: true, server_password: 'abc123' });
  assert.deepEqual(parseWebsocketConfig(raw), { serverEnabled: true, port: 4466, password: 'abc123' });
});

test('no password unless auth is required', () => {
  const raw = JSON.stringify({ server_enabled: true, server_port: 4455, auth_required: false, server_password: 'leftover' });
  assert.equal(parseWebsocketConfig(raw).password, undefined);
});

test('disabled server and bad input', () => {
  assert.equal(parseWebsocketConfig(JSON.stringify({ server_enabled: false })).serverEnabled, false);
  assert.deepEqual(parseWebsocketConfig('not json'), { serverEnabled: null });
  assert.equal(parseWebsocketConfig(JSON.stringify({ server_port: 99999 })).port, undefined);
});

test('hint picks the most actionable next step', () => {
  assert.equal(obsHint('connected', null), 'connected');
  assert.equal(obsHint('error', { running: false, serverEnabled: true }, 'connect ECONNREFUSED'), 'not_running');
  assert.equal(obsHint('error', { running: true, serverEnabled: false }, 'connect ECONNREFUSED'), 'server_disabled');
  assert.equal(obsHint('error', { running: true, serverEnabled: true }, 'Authentication failed.'), 'auth_failed');
  assert.equal(obsHint('error', { running: true, serverEnabled: null }, 'connect ECONNREFUSED'), 'unreachable');
  assert.equal(obsHint('connecting', null), 'checking');
});
