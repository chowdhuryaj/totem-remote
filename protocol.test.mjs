import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from './protocol.js';
import { asciiKey } from './keys.js';

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ').toUpperCase();

test('mouse example', () => {
  assert.equal(hex(P.encodeMouse({ buttons: 1, dx: 5, dy: -3, wheel: 1 })), '01 05 00 FD FF 01 00 00');
});

test('key examples', () => {
  const K = P.encodeKey;
  assert.equal(hex(K({ action: 2, mods: 1, usage: 6 })), '02 01 07 00 06 00');
  assert.equal(hex(K({ action: 1, usage: 4 })), '01 00 07 00 04 00');
  assert.equal(hex(K({ action: 0, usage: 4 })), '00 00 07 00 04 00');
  assert.equal(hex(K({ action: 1, mods: 1, usage: 0 })), '01 01 07 00 00 00');
  assert.equal(hex(K({ action: 2, page: 0x0c, usage: 0xcd })), '02 00 0C 00 CD 00');
});

test('text example and filtering', () => {
  assert.equal(hex(P.encodeText('Hi\n')), '48 69 0A');
  assert.equal(P.filterText('aé\r\tb\u0007~'), 'a\tb~');
  assert.deepEqual(P.chunkText('x'.repeat(45)).map((c) => c.length), [20, 20, 5]);
});

test('control examples', () => {
  assert.equal(hex(P.control.releaseAll()), '01');
  assert.equal(hex(P.control.typingDelay(10)), '04 0A');
  assert.equal(hex(P.control.output(2)), '07 02');
  assert.equal(hex(P.control.output(1)), '07 01');
});

test('status example', () => {
  const s = P.decodeStatus([0x01, 0x03, 0x02, 0x00, 0x02, 0x2f, 0x01, 0x4e, 0xff]);
  assert.equal(s.remoteEnabled, true); assert.equal(s.usbConnected, true);
  assert.equal(s.capsLock, true); assert.equal(s.numLock, false);
  assert.equal(s.textFree, 512); assert.equal(s.features, 0x2f);
  assert.equal(s.output, 1); assert.equal(s.battLeft, 78); assert.equal(s.battRight, 0xff);
  assert.equal(s.hasBatteries, true);
});

test('short status (older firmware)', () => {
  const s = P.decodeStatus([1, 1, 0, 0x10, 0, 0x03]);
  assert.equal(s.textFree, 16); assert.equal(s.output, 0); assert.equal(s.battLeft, 0xff);
});

test('ascii to usage', () => {
  assert.deepEqual(asciiKey('A'), { usage: 4, shift: true });
  assert.deepEqual(asciiKey('!'), { usage: 0x1e, shift: true });
  assert.deepEqual(asciiKey('?'), { usage: 0x38, shift: true });
});
