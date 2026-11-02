import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMultipart } from './multipart';

test('builds a well-formed multipart body', async () => {
  const blob = buildMultipart('B', { title: 'Hi' }, { name: 'clip.mkv', type: 'video/x-matroska', data: new Blob([new Uint8Array([1, 2, 3])]) });
  const body = Buffer.from(await blob.arrayBuffer()).toString('latin1');
  assert.ok(body.startsWith('--B\r\nContent-Disposition: form-data; name="title"\r\n\r\nHi\r\n'));
  assert.ok(body.includes('name="file"; filename="clip.mkv"\r\nContent-Type: video/x-matroska\r\n\r\n\u0001\u0002\u0003\r\n--B--\r\n'));
  assert.equal(blob.size, body.length);
});
