import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dockCredentialHash, trigglowDockIn, trigglowDocksIn, withBrowserDock, withLegacyDockReplaced, withTrigglowDocks } from './obs-fix';
import { allowDevStack, allowLocalhost, dockKindOf, isTrigglowDockUrl } from './trust';

test('OBS dock installer takes the public dock URLs and #e= desktop tickets, never #k= secrets', () => {
  allowLocalhost(false);
  allowDevStack(false);
  const e = `tgde_${'A'.repeat(43)}`;
  const k = `tgdr_${'A'.repeat(43)}`;
  for (const origin of ['https://www.trigglow.com', 'https://trigglow.com']) {
    assert.equal(isTrigglowDockUrl(`${origin}/dock/activity`), true, origin);
    assert.equal(isTrigglowDockUrl(`${origin}/dock/chat`), true, origin);
    assert.equal(isTrigglowDockUrl(`${origin}/dock/activity#e=${e}`), true, origin);
    assert.equal(isTrigglowDockUrl(`${origin}/dock/chat#e=${e}`), true, origin);
  }
  // The secret URLs of before 0.8.0 are refused.
  assert.equal(isTrigglowDockUrl(`https://www.trigglow.com/dock/activity#k=${k}`), false);
  assert.equal(isTrigglowDockUrl(`https://www.trigglow.com/dock/chat#k=${k}`), false);
  // The old dock host never served the dock: refused even with a valid ticket.
  assert.equal(isTrigglowDockUrl('https://dock.trigglow.com/activity'), false);
  assert.equal(isTrigglowDockUrl(`https://dock.trigglow.com/activity#e=${e}`), false);
  assert.equal(isTrigglowDockUrl(`https://www.trigglow.com/activity#e=${e}`), false);
  // Wrong ticket shapes, paths, hosts, schemes, ports and query strings.
  assert.equal(isTrigglowDockUrl('https://www.trigglow.com/dock/chat#e=tgde_short'), false);
  assert.equal(isTrigglowDockUrl(`https://www.trigglow.com/dock/chat#e=${e}&k=${k}`), false);
  assert.equal(isTrigglowDockUrl(`https://www.trigglow.com/dock/chat#x=${e}`), false);
  assert.equal(isTrigglowDockUrl(`https://www.trigglow.com/dock/other#e=${e}`), false);
  assert.equal(isTrigglowDockUrl('https://www.trigglow.com/dock/chat/'), false);
  assert.equal(isTrigglowDockUrl('https://www.trigglow.com/dock/'), false);
  assert.equal(isTrigglowDockUrl('https://www.trigglow.com/app/docks'), false);
  assert.equal(isTrigglowDockUrl('https://www.trigglow.com.evil.io/dock/chat'), false);
  assert.equal(isTrigglowDockUrl('https://evil.io/www.trigglow.com/dock/chat'), false);
  assert.equal(isTrigglowDockUrl('https://api.trigglow.com/dock/chat'), false);
  assert.equal(isTrigglowDockUrl('https://user@www.trigglow.com/dock/chat'), false);
  assert.equal(isTrigglowDockUrl('https://www.trigglow.com:8443/dock/chat'), false);
  assert.equal(isTrigglowDockUrl('http://www.trigglow.com/dock/chat'), false);
  assert.equal(isTrigglowDockUrl('https://www.trigglow.com/dock/chat?x=1'), false);
  assert.equal(isTrigglowDockUrl('javascript:alert(1)'), false);
  // The develop stack and localhost only for builds pointed at them.
  assert.equal(isTrigglowDockUrl('https://dev.trigglow.com/dock/chat'), false);
  assert.equal(isTrigglowDockUrl('http://localhost:5173/dock/chat'), false);
  allowDevStack(true);
  assert.equal(isTrigglowDockUrl(`https://dev.trigglow.com/dock/activity#e=${e}`), true);
  allowDevStack(false);
  allowLocalhost(true);
  assert.equal(isTrigglowDockUrl('http://localhost:5173/dock/chat'), true);
  assert.equal(isTrigglowDockUrl(`http://127.0.0.1:5174/dock/activity#e=${e}`), true);
  assert.equal(isTrigglowDockUrl(`http://localhost:5173/dock/activity#k=${k}`), false);
  assert.equal(isTrigglowDockUrl('http://dock.localhost:5173/chat'), false);
  allowLocalhost(false);
  assert.equal(dockKindOf('https://www.trigglow.com/dock/chat'), 'chat');
  assert.equal(dockKindOf(`https://www.trigglow.com/dock/activity#e=${e}`), 'activity');
  assert.equal(dockKindOf('https://dock.trigglow.com/chat'), null);
});

const docksOf = (ini: string) => JSON.parse(/ExtraBrowserDocks=(.*)/.exec(ini)![1]) as { title: string; url: string }[];

test('"Change the URL in OBS" swaps only the dock whose #k= credential matches, and keeps its title (review L2)', () => {
  const mine = `tgdr_${'B'.repeat(43)}`;
  const other = `tgdr_${'D'.repeat(43)}`;
  const e = `tgde_${'C'.repeat(43)}`;
  const next = `https://www.trigglow.com/dock/activity#e=${e}`;
  const ini = `[BasicWindow]\nExtraBrowserDocks=${JSON.stringify([
    { title: 'Otro canal', url: `https://dock.trigglow.com/activity#k=${other}` },
    { title: 'Mi actividad', url: `https://dock.trigglow.com/activity#k=${mine}` },
    { title: 'Chat', url: `https://dock.trigglow.com/chat#k=${mine}` },
    { title: 'Otra cosa', url: 'https://example.com' },
  ])}\n`;
  const r = withLegacyDockReplaced(ini, 'Trigglow OBS', next, 'activity', dockCredentialHash(mine));
  assert.equal(r.replaced, true);
  const docks = docksOf(r.ini);
  assert.deepEqual(
    docks.map((d) => d.title),
    ['Otro canal', 'Mi actividad', 'Chat', 'Otra cosa'],
  );
  assert.equal(docks[0].url, `https://dock.trigglow.com/activity#k=${other}`);
  assert.equal(docks[1].url, next);
  // The chat dock with the same credential is another kind: untouched.
  assert.equal(docks[2].url, `https://dock.trigglow.com/chat#k=${mine}`);
});

test('"Change the URL in OBS" never guesses: no hash, or no matching dock, adds the new one (review L2)', () => {
  const only = `tgdr_${'B'.repeat(43)}`;
  const next = `https://www.trigglow.com/dock/activity#e=tgde_${'C'.repeat(43)}`;
  const ini = `[BasicWindow]\nExtraBrowserDocks=${JSON.stringify([{ title: 'Trigglow OBS', url: `https://dock.trigglow.com/activity#k=${only}` }])}\n`;
  // The only #k= dock of that kind, even with the same title, is not replaced without its hash.
  const noHash = withLegacyDockReplaced(ini, 'Trigglow OBS 2', next, 'activity');
  assert.equal(noHash.replaced, false);
  assert.equal(noHash.ini, withBrowserDock(ini, 'Trigglow OBS 2', next));
  const wrong = withLegacyDockReplaced(ini, 'Trigglow OBS 2', next, 'activity', dockCredentialHash(`tgdr_${'Z'.repeat(43)}`));
  assert.equal(wrong.replaced, false);
  assert.equal(withLegacyDockReplaced(ini, 'X', next, 'activity', 'not-a-hash').replaced, false);
  assert.equal(withLegacyDockReplaced(ini, 'X', next, 'activity', dockCredentialHash(only)).replaced, true);
});

const iniWith = (docks: { title: string; url: string }[]) => `[General]\nFirstRun=true\n\n[BasicWindow]\nExtraBrowserDocks=${JSON.stringify(docks)}\n`;
const E = (c: string) => `tgde_${c.repeat(43)}`;

test('recognises Trigglow docks already in OBS, by kind, code-linked or legacy', () => {
  assert.deepEqual(trigglowDockIn(`https://www.trigglow.com/dock/activity#e=${E('A')}`), { kind: 'activity', legacy: false });
  assert.deepEqual(trigglowDockIn('https://trigglow.com/dock/chat'), { kind: 'chat', legacy: false });
  assert.deepEqual(trigglowDockIn(`https://dock.trigglow.com/chat#k=tgdr_${'B'.repeat(43)}`), { kind: 'chat', legacy: true });
  assert.equal(trigglowDockIn('https://evil.io/dock/activity'), null);
  assert.equal(trigglowDockIn('https://www.trigglow.com/app/docks'), null);
  assert.equal(trigglowDockIn(42), null);
  const ini = iniWith([
    { title: 'Mi actividad', url: `https://www.trigglow.com/dock/activity#e=${E('A')}` },
    { title: 'Chat viejo', url: `https://dock.trigglow.com/chat#k=tgdr_${'B'.repeat(43)}` },
    { title: 'Otra', url: 'https://example.com' },
  ]);
  assert.deepEqual(trigglowDocksIn(ini), { activity: { linked: true, legacy: false }, chat: { linked: false, legacy: true } });
  assert.deepEqual(trigglowDocksIn(null), { activity: { linked: false, legacy: false }, chat: { linked: false, legacy: false } });
});

test('"Set up both docks": writes both into an OBS without them, keeping the other docks', () => {
  const ini = iniWith([{ title: 'Otra', url: 'https://example.com' }]);
  const out = withTrigglowDocks(ini, [
    { kind: 'activity', title: 'Trigglow Activity', url: `https://www.trigglow.com/dock/activity#e=${E('A')}` },
    { kind: 'chat', title: 'Trigglow Chat', url: `https://www.trigglow.com/dock/chat#e=${E('C')}` },
  ]);
  assert.deepEqual(out.results, [
    { kind: 'activity', action: 'added' },
    { kind: 'chat', action: 'added' },
  ]);
  assert.deepEqual(
    docksOf(out.ini).map((d) => [d.title, d.url]),
    [
      ['Otra', 'https://example.com'],
      ['Trigglow Activity', `https://www.trigglow.com/dock/activity#e=${E('A')}`],
      ['Trigglow Chat', `https://www.trigglow.com/dock/chat#e=${E('C')}`],
    ],
  );
  assert.match(out.ini, /^\[General\]\r?\nFirstRun=true/);
  // Running it again never duplicates: both kinds are now kept.
  const again = withTrigglowDocks(out.ini, [
    { kind: 'activity', title: 'Trigglow Activity', url: `https://www.trigglow.com/dock/activity#e=${E('X')}` },
    { kind: 'chat', title: 'Trigglow Chat', url: `https://www.trigglow.com/dock/chat#e=${E('Y')}` },
  ]);
  assert.deepEqual(again.results.map((r) => r.action), ['kept', 'kept']);
  assert.equal(again.ini, out.ini);
});

test('"Set up both docks": swaps only the legacy dock whose credential matches, keeps a linked one, never reuses a name', () => {
  const mine = `tgdr_${'B'.repeat(43)}`;
  const other = `tgdr_${'D'.repeat(43)}`;
  const ini = iniWith([
    { title: 'Actividad', url: `https://www.trigglow.com/dock/activity#e=${E('A')}` },
    { title: 'Chat de antes', url: `https://dock.trigglow.com/chat#k=${mine}` },
    { title: 'Chat de otro canal', url: `https://dock.trigglow.com/chat#k=${other}` },
    { title: 'Trigglow Chat', url: 'https://example.com/not-ours' },
  ]);
  const chat = `https://www.trigglow.com/dock/chat#e=${E('C')}`;
  const out = withTrigglowDocks(ini, [
    { kind: 'activity', title: 'Trigglow Activity', url: `https://www.trigglow.com/dock/activity#e=${E('N')}` },
    { kind: 'chat', title: 'Trigglow Chat', url: chat, replaceCredentialHash: dockCredentialHash(mine) },
  ]);
  assert.deepEqual(out.results, [
    { kind: 'activity', action: 'kept' },
    { kind: 'chat', action: 'replaced' },
  ]);
  const docks = docksOf(out.ini);
  assert.deepEqual(docks.map((d) => d.title), ['Actividad', 'Chat de antes', 'Chat de otro canal', 'Trigglow Chat']);
  assert.equal(docks[1]!.url, chat);
  assert.equal(docks[2]!.url, `https://dock.trigglow.com/chat#k=${other}`);
  assert.equal(docks[3]!.url, 'https://example.com/not-ours');

  // No hash match: the new chat dock is added under a free name, the foreign "Trigglow Chat" stays.
  const added = withTrigglowDocks(ini, [{ kind: 'chat', title: 'Trigglow Chat', url: chat, replaceCredentialHash: dockCredentialHash(`tgdr_${'Z'.repeat(43)}`) }]);
  assert.deepEqual(added.results, [{ kind: 'chat', action: 'added' }]);
  const d2 = docksOf(added.ini);
  assert.equal(d2.find((d) => d.title === 'Trigglow Chat')!.url, 'https://example.com/not-ours');
  assert.equal(d2.find((d) => d.title === 'Trigglow Chat 2')!.url, chat);
  assert.equal(d2.length, 5);
});

