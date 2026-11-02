import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidAccelerator } from './hotkey';

test('accepts sensible shortcuts', () => {
  for (const a of ['CommandOrControl+Alt+C', 'Control+Shift+F9', 'Alt+1', 'CommandOrControl+Shift+Up', 'Shift+F5']) assert.equal(isValidAccelerator(a), true, a);
});

test('rejects bare keys, shift-only, junk and duplicates', () => {
  for (const a of ['C', 'Shift+C', '', 'Ctrl+', 'Ctrl+Alt', 'Ctrl+Ctrl+C', 'Ctrl+Foo+C', 'Ctrl+CC', 'A'.repeat(60)]) assert.equal(isValidAccelerator(a), false, a);
});

import { normalizeControlHotkeys } from './hotkey';

test('control hotkeys: keeps valid ones, drops junk, unknown actions and duplicates', () => {
  const out = normalizeControlHotkeys({ skip: 'Ctrl+Alt+S', 'toggle-mute': 'ctrl+alt+s', clear: 'C', nope: 'Ctrl+Alt+X', repeat: 'Ctrl+Alt+R', 'toggle-pause': 5 });
  assert.deepEqual(out, { skip: 'Ctrl+Alt+S', repeat: 'Ctrl+Alt+R' });
  assert.deepEqual(normalizeControlHotkeys(null), {});
});

test('control hotkeys: song-request (music-*) actions are kept, and still never share a combination', () => {
  const out = normalizeControlHotkeys({
    skip: 'Ctrl+Alt+N',
    'music-skip': 'ctrl+alt+n', // same keys as the alert skip → dropped
    'music-toggle-pause': 'Ctrl+Alt+P',
    'music-volume-up': 'Ctrl+Alt+Up',
  });
  assert.deepEqual(out, { skip: 'Ctrl+Alt+N', 'music-toggle-pause': 'Ctrl+Alt+P', 'music-volume-up': 'Ctrl+Alt+Up' });
});
