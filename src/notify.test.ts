import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Burst, parseNotification } from './notify';

test('accepts a well-formed notification and only in-app click targets', () => {
  assert.deepEqual(parseNotification({ kind: 'donation', title: 'New donation', body: 'Ana donated 5 €', url: '/app/activity' }), { kind: 'donation', title: 'New donation', body: 'Ana donated 5 €', url: '/app/activity' });
  assert.equal(parseNotification({ kind: 'sub', title: 't', body: 'b', url: 'https://evil.example' })?.url, undefined);
  assert.equal(parseNotification({ kind: 'sub', title: 't', body: 'b', url: '/application' })?.url, undefined);
  assert.equal(parseNotification({ kind: 'sub', title: 't', body: '', url: '/app' })?.url, '/app');
});

test('rejects junk and oversized text', () => {
  for (const bad of [null, 'x', {}, { kind: 'a', title: 't' }, { kind: 'a', title: 'x'.repeat(200), body: 'b' }, { kind: 'a', title: 't', body: 5 }]) assert.equal(parseNotification(bad), null);
});

test('bursts show the first few, hold the rest, and summarise once', () => {
  const b = new Burst(3, 1000);
  assert.deepEqual([0, 1, 2, 3, 4].map((t) => b.take(t)), [true, true, true, false, false]);
  assert.equal(b.flush(), 2);
  assert.equal(b.flush(), 0);
  assert.equal(b.take(2000), true); // window elapsed
});
