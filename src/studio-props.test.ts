import test from 'node:test';
import assert from 'node:assert/strict';
import { boxOf, cleanPropertyValue, dialogFilters, propertyKind } from './studio-props';

test('libobs property types map to the field the window draws', () => {
  assert.equal(propertyKind({ type: 1 }), 'bool');
  assert.equal(propertyKind({ type: 2, details: { type: 1 } }), 'slider');
  assert.equal(propertyKind({ type: 4, details: { type: 2 } }), 'textarea');
  assert.equal(propertyKind({ type: 4, details: { type: 3 } }), 'info');
  assert.equal(propertyKind({ type: 9 }), 'font');
  assert.equal(propertyKind({ type: 10 }), 'files');
  assert.equal(propertyKind({ type: 13 }), 'color-alpha');
  assert.equal(propertyKind({ type: 12 }), null);
});

test('only values of the right shape reach libobs', () => {
  assert.equal(cleanPropertyValue('int', 3.6), 4);
  assert.equal(cleanPropertyValue('int', '3'), undefined);
  assert.equal(cleanPropertyValue('color', -5), 0);
  assert.equal(cleanPropertyValue('color', 0x1ffffffff), 0xffffffff);
  assert.deepEqual(cleanPropertyValue('font', { face: 'Arial', size: 2, style: 'Bold', flags: 99 }), { face: 'Arial', style: 'Bold', size: 4, flags: 15 });
  assert.equal(cleanPropertyValue('font', { size: 20 }), undefined);
  assert.deepEqual(cleanPropertyValue('files', [{ value: 'C:/a.png', selected: true }, { value: '' }, 'junk', { value: 'C:/b.png', hidden: true }]), [
    { value: 'C:/a.png', selected: false, hidden: false },
    { value: 'C:/b.png', selected: false, hidden: true },
  ]);
  assert.equal(cleanPropertyValue('info', 'x'), undefined);
  assert.equal(cleanPropertyValue('button', true), undefined);
});

test('file filters from libobs become dialog filters', () => {
  assert.deepEqual(dialogFilters('Image Files (*.bmp *.tga *.png);;All Files (*.*)'), [
    { name: 'Image Files', extensions: ['bmp', 'tga', 'png'] },
    { name: 'All Files', extensions: ['*'] },
  ]);
  assert.deepEqual(dialogFilters(''), []);
});

test('the box of a turned or flipped item is its outline on the canvas', () => {
  assert.deepEqual(boxOf({ x: 10, y: 20 }, { w: 100, h: 50 }, 0), { x: 10, y: 20, width: 100, height: 50 });
  const r = boxOf({ x: 100, y: 0 }, { w: 100, h: 50 }, 90);
  assert.deepEqual([Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], [50, 0, 50, 100]);
  assert.deepEqual(boxOf({ x: 200, y: 0 }, { w: -100, h: 50 }, 0), { x: 100, y: 0, width: 100, height: 50 });
});
