import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withServerEnabled, writeFileAtomic, type AtomicFs } from './obs-fix';

test('turns the server on and keeps everything else', () => {
  const out = JSON.parse(withServerEnabled(JSON.stringify({ server_enabled: false, server_port: 4466, auth_required: true, server_password: 'keep', alerts_enabled: true })));
  assert.deepEqual(out, { server_enabled: true, server_port: 4466, auth_required: true, server_password: 'keep', alerts_enabled: true, first_load: false });
});

test('missing file becomes a secure default with a generated password', () => {
  const out = JSON.parse(withServerEnabled(null, () => 'generated'));
  assert.equal(out.server_enabled, true);
  assert.equal(out.server_port, 4455);
  assert.equal(out.auth_required, true);
  assert.equal(out.server_password, 'generated');
});

test('fills a missing password but respects auth turned off; survives corrupt input', () => {
  assert.equal(JSON.parse(withServerEnabled(JSON.stringify({ auth_required: true }), () => 'pw')).server_password, 'pw');
  assert.equal(JSON.parse(withServerEnabled(JSON.stringify({ auth_required: false }), () => 'pw')).server_password, undefined);
  assert.equal(JSON.parse(withServerEnabled('{oops', () => 'pw')).server_enabled, true);
});

test('OBS config writes go through a temp file and a rename, keeping a .bak', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigglow-atomic-'));
  const file = path.join(dir, 'user.ini');
  fs.writeFileSync(file, 'old');
  writeFileAtomic(file, 'new');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.equal(fs.readFileSync(`${file}.trigglow-bak`, 'utf8'), 'old');
  assert.equal(fs.existsSync(`${file}.trigglow-tmp`), false);
  // A file that did not exist yet: written, no backup.
  const fresh = path.join(dir, 'global.ini');
  writeFileAtomic(fresh, 'x');
  assert.equal(fs.readFileSync(fresh, 'utf8'), 'x');
  assert.equal(fs.existsSync(`${fresh}.trigglow-bak`), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a locked OBS config (rename refused) is left untouched and the temp file is removed', () => {
  const files = new Map<string, string>([['user.ini', 'original']]);
  const fake: AtomicFs = {
    writeFileSync: ((f: string, d: string) => void files.set(String(f), String(d))) as AtomicFs['writeFileSync'],
    existsSync: ((f: string) => files.has(String(f))) as AtomicFs['existsSync'],
    copyFileSync: ((a: string, b: string) => void files.set(String(b), files.get(String(a))!)) as AtomicFs['copyFileSync'],
    renameSync: (() => {
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }) as AtomicFs['renameSync'],
    unlinkSync: ((f: string) => void files.delete(String(f))) as AtomicFs['unlinkSync'],
  };
  assert.throws(() => writeFileAtomic('user.ini', 'new', fake), /EPERM/);
  assert.equal(files.get('user.ini'), 'original');
  assert.equal(files.has('user.ini.trigglow-tmp'), false);
});
