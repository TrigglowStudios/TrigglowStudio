import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { packFilesFromArgv, packStageOutcome } from './pack-open';

test('finds the double-clicked pack among the launch arguments', () => {
  const argv = ['C:\\Program Files\\Trigglow\\Trigglow.exe', '--hidden', 'C:\\Users\\me\\Downloads\\Relay.OverlayTrigglow', 'C:\\missing.overlaytrigglow', 'notes.txt'];
  const exists = (p: string) => !p.includes('missing');
  assert.deepEqual(packFilesFromArgv(argv, exists), [path.resolve('C:\\Users\\me\\Downloads\\Relay.OverlayTrigglow')]);
  assert.deepEqual(packFilesFromArgv(['Trigglow.exe'], exists), []);
});

test('maps the upload answer to what the app does', () => {
  assert.deepEqual(packStageOutcome(201, { id: 'abc' }), { kind: 'wizard', id: 'abc' });
  assert.deepEqual(packStageOutcome(401, {}), { kind: 'signed_out' });
  assert.deepEqual(packStageOutcome(422, { error: 'license_required' }), { kind: 'redeem' });
  assert.deepEqual(packStageOutcome(422, { error: 'not_a_pack' }), { kind: 'error', code: 'not_a_pack' });
  assert.deepEqual(packStageOutcome(500, {}), { kind: 'error', code: 'generic' });
});
