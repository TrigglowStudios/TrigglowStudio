import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TextSources, cleanSourceName, isBindingId, renderTemplate, varsFor, type TextData, type WriteResult } from './text-sources';

const data = (over: Partial<TextData> = {}): TextData => ({ follower: 'Ana', sub: null, donation: { name: 'Bo', amount: '5,00 €' }, widgets: [], ...over });

test('templates fill known placeholders and blank unknown ones', () => {
  assert.equal(renderTemplate('{name} · {amount}', { name: 'Bo', amount: '5 €' }), 'Bo · 5 €');
  assert.equal(renderTemplate('{name} {oops}!', { name: 'Ana' }), 'Ana !');
});

test('ids and source names are validated', () => {
  for (const ok of ['latest_follower', 'latest_sub', 'latest_donation', 'widget:abc-123']) assert.equal(isBindingId(ok), true, ok);
  for (const bad of ['widget:', 'widget:a b', 'x', 5, 'widget:' + 'a'.repeat(90)]) assert.equal(isBindingId(bad), false, String(bad));
  assert.equal(cleanSourceName('  Mi texto\n'), 'Mi texto');
  assert.equal(cleanSourceName(''), null);
  assert.equal(cleanSourceName('x'.repeat(101)), null);
});

test('goal placeholders: counts, percent, bar and remaining; money for donation goals', () => {
  const w = { widgetId: 'g1', title: 'Sub goal', current: 7, target: 20, ratio: 0.35, metric: 'subs' };
  const v = varsFor('widget:g1', data({ widgets: [w] }))!;
  assert.deepEqual(v, { title: 'Sub goal', current: '7', target: '20', remaining: '13', percent: 35, bar: '████░░░░░░' });
  const money = varsFor('widget:g2', data({ widgets: [{ widgetId: 'g2', title: 'Tips', current: 2500, target: 10000, ratio: 0.25, metric: 'donations', currency: 'eur' }] }), 'en')!;
  assert.equal(money.current, '€25.00');
  assert.equal(money.target, '€100.00');
  assert.equal(varsFor('widget:nope', data()), null);
  assert.equal(varsFor('latest_sub', data()), null); // no subscriber yet → nothing to write
});

function harness(connected = true, result: () => WriteResult = () => 'ok') {
  const writes: [string, string][] = [];
  let d = data();
  let saved: unknown;
  const ts = new TextSources([], {
    connected: () => connected,
    setText: async (s, t) => {
      writes.push([s, t]);
      return result();
    },
    createSource: async () => true,
    fetchData: async () => d,
    locale: 'en',
    save: (b) => (saved = b),
    onChange: () => undefined,
  });
  return { ts, writes, setData: (x: TextData) => (d = x), saved: () => saved };
}

test('writes a binding once, only rewrites when the text changes, and persists', async () => {
  const h = harness();
  h.ts.add('latest_follower', 'Trigglow Latest Follower', '{name}');
  assert.equal((h.saved() as unknown[]).length, 1);
  await h.ts.sync(true);
  await h.ts.sync(true);
  assert.deepEqual(h.writes, [['Trigglow Latest Follower', 'Ana'], ['Trigglow Latest Follower', 'Ana']]); // force rewrites
  h.writes.length = 0;
  await h.ts.sync(); // not forced and unchanged (and inside the min gap → deferred): no write
  assert.equal(h.writes.length, 0);
  assert.equal(h.ts.status.get('latest_follower'), 'ok');
  assert.equal(h.ts.values.get('latest_follower'), 'Ana');
});

test('reports missing sources, no data and offline instead of writing blindly', async () => {
  const missing = harness(true, () => 'missing');
  missing.ts.add('latest_follower', 'Nope', '{name}');
  missing.ts.add('latest_sub', 'Subs', '{name}');
  await missing.ts.sync(true);
  assert.equal(missing.ts.status.get('latest_follower'), 'missing');
  assert.equal(missing.ts.status.get('latest_sub'), 'nodata');
  const offline = harness(false);
  offline.ts.add('latest_follower', 'X', '{name}');
  await offline.ts.sync(true);
  assert.equal(offline.ts.status.get('latest_follower'), 'offline');
  assert.equal(offline.writes.length, 0);
});

test('the available list offers the three latest values plus quests and goals', async () => {
  const h = harness();
  h.setData(data({ widgets: [{ widgetId: 'q1', kind: 'quest', title: 'Chat 100', current: 1, target: 100, ratio: 0.01, metric: 'messages' }, { widgetId: 'g1', kind: 'goal', title: 'Goal', current: 1, target: 2, ratio: 0.5, metric: 'subs' }] }));
  await h.ts.sync(true);
  assert.deepEqual(h.ts.available().map((a) => [a.id, a.kind]), [['latest_follower', 'latest'], ['latest_sub', 'latest'], ['latest_donation', 'latest'], ['widget:q1', 'quest'], ['widget:g1', 'goal']]);
});

import { normalizeTextBindings } from './text-sources';

test('saved bindings: keeps valid ones, drops junk and duplicates', () => {
  const out = normalizeTextBindings([
    { id: 'latest_follower', source: ' Followers ', template: '{name}' },
    { id: 'latest_follower', source: 'Dup', template: '{name}' },
    { id: 'nope', source: 'X', template: '{name}' },
    { id: 'latest_sub', source: '', template: '{name}' },
    { id: 'widget:g1', source: 'Goal', template: '{percent}%' },
    null,
  ]);
  assert.deepEqual(out, [{ id: 'latest_follower', source: 'Followers', template: '{name}' }, { id: 'widget:g1', source: 'Goal', template: '{percent}%' }]);
  assert.deepEqual(normalizeTextBindings('x'), []);
});
