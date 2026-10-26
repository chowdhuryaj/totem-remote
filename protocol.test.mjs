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

import { defaultConfig, cleanConfig, importAny, migrate, classifyMulti, classifyPinch, GESTURES, HOSTS } from './config.js';
test('config defaults cover every gesture and host', () => {
  const c = defaultConfig();
  for (const h of HOSTS) for (const [k] of GESTURES) assert.ok(c.profiles[h].gestures[k].steps.length, h + k);
  assert.deepEqual(c.profiles.Mac.gestures.swipe3L.steps[0], { t: 'key', mods: 1, page: 7, usage: 0x50 });
  assert.deepEqual(c.profiles.Workstation.gestures.swipe3L.steps[0], { t: 'key', mods: 9, page: 7, usage: 0x50 });
  assert.deepEqual(cleanConfig(JSON.parse(JSON.stringify(c))), c);
});
test('import: v2 round trip, old array, garbage', () => {
  const c = defaultConfig();
  assert.deepEqual(importAny(JSON.parse(JSON.stringify(c)), c, 'Mac'), c);
  const old = [{ label: 'x', steps: [{ t: 'text', text: 'hié' }, { t: 'bogus' }] }];
  const n = importAny(old, c, 'Workstation');
  assert.deepEqual(n.profiles.Workstation.pages, [{ name: 'Imported', buttons: [{ label: 'x', steps: [{ t: 'text', text: 'hi' }] }] }]);
  assert.deepEqual(n.profiles.Mac, c.profiles.Mac);
  assert.deepEqual(migrate(old).profiles.Mac.pages[0].buttons, n.profiles.Workstation.pages[0].buttons);
  assert.throws(() => importAny({ foo: 1 }, c, 'Mac'));
});
test('gesture classification', () => {
  assert.equal(classifyMulti(3, -80, 5, 200), 'swipe3L');
  assert.equal(classifyMulti(3, 80, 5, 200), 'swipe3R');
  assert.equal(classifyMulti(3, 2, -90, 200), 'swipe3U');
  assert.equal(classifyMulti(4, 0, 90, 200), 'swipe4D');
  assert.equal(classifyMulti(4, 90, 0, 200), null);
  assert.equal(classifyMulti(3, 3, 2, 120), 'tap3');
  assert.equal(classifyMulti(3, 3, 2, 600), null);
  assert.equal(classifyPinch(200, 100, 10), 'pinchIn');
  assert.equal(classifyPinch(100, 200, 10), 'pinchOut');
  assert.equal(classifyPinch(100, 110, 5), null);
  assert.equal(classifyPinch(100, 160, 100), null);
});

import { ICONS } from './icons.js';
test('workstation sample page is placeholder-only and icons exist', () => {
  const c = defaultConfig(), page = c.profiles.Workstation.pages[0];
  assert.equal(page.name, 'Reading');
  assert.deepEqual(page.buttons.map((b) => b.label), ['Dictate', 'Sign', 'Next', 'Normal CT', 'Normal CXR', 'Impression', 'Zoom', 'W/L', 'Layout']);
  assert.ok(page.buttons.every((b) => b.placeholder));
  for (const h of HOSTS) for (const p of c.profiles[h].pages) for (const b of p.buttons) assert.ok(ICONS[b.icon], b.icon);
  assert.ok(Object.keys(ICONS).length >= 40);
});
