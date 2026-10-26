import test from 'node:test';
import assert from 'node:assert/strict';
import { TunnelHID } from './tunnel.js';
import { DemoFlaskIo } from './demo-flask.js';
import { FlaskProto, CH_ZMK, V } from './vendor/flask/flaskproto.js';
import { zmkCapabilities } from './vendor/flask/zmk.js';
import { readAllTdSlots } from './vendor/flask/zmk-tapdance-io.js';
import { decodeComboSlotV3 } from './vendor/flask/zmk-combos-codec.js';
import { decodeMacroStep } from './vendor/flask/zmk-macros-codec.js';
import { decodeHoldtapSlot } from './vendor/flask/zmk-holdtap-codec.js';

const mk = () => { const io = new DemoFlaskIo(), hid = new TunnelHID(io), flask = new FlaskProto(hid); flask.line = 'zmk'; return { io, hid, flask }; };

test('tunnel: handshake, caps, frames are 1-32 bytes, replies 32', async () => {
  const { io, flask } = mk();
  const v = await flask.handshake();
  assert.equal(v, 23);
  assert.equal(zmkCapabilities('totem', v).combosTimed, true);
  assert.ok(io.log.every((f) => f.length >= 1 && f.length <= 32));
  assert.deepEqual(io.log[0], [0x08, 0x00, 0x01]);
});

test('unhandled channel -> FlaskProto throws', async () => {
  const { flask } = mk();
  await assert.rejects(flask.getU16(0x2d, 0x01), /unhandled/);
});

test('reads through the vendored codecs: combo, macro, tap dance, hold-tap', async () => {
  const { flask } = mk();
  const c = decodeComboSlotV3(await flask.getBytes(CH_ZMK.combos, V.combosSlotV3, [0], 1), 4);
  assert.deepEqual(c.positions, [14, 15]); assert.equal(c.param1, (7 << 16) | 0x29);
  assert.equal(decodeMacroStep(await flask.getBytes(CH_ZMK.macros, V.macrosStep, [0, 1], 2)).param, (7 << 16) | 0x0c);
  const tds = await readAllTdSlots({ flask, protocolVersion: 23 });
  assert.equal(tds.length, 8); assert.equal(tds[0].termMs, 220); assert.equal(tds[0].taps[1].param1, (7 << 16) | 0x05);
  const ht = decodeHoldtapSlot(await flask.getBytes(0x2a, 0x50, [14], 1));
  assert.equal(ht.term, 260);
});

test('hold-tap write clamps and echoes; save is sent, never retried', async () => {
  const { io, flask } = mk();
  const echo = decodeHoldtapSlot(await flask.setBytes(0x2a, 0x50, [3, 0x27, 0x10, 0, 0, 0, 0, 1, 0], 1)); // 10000 ms
  assert.equal(echo.term, 1000);
  await flask.save(0x2a);
  assert.deepEqual(io.saves, [0x2a]);
});

test('request matching ignores a stale reply for another slot', async () => {
  const { io, hid } = mk();
  const p = hid.request([0x08, 0x24, 0x12, 5], 1);
  io.onFrame(new Uint8Array([0x08, 0x24, 0x12, 4, ...new Array(28).fill(0)])); // wrong slot first
  const r = await p;
  assert.equal(r[3], 5);
});

test('write failure surfaces as a readable error', async () => {
  const io = { onFrame() {}, write: async () => { throw new Error('GATT Error 0x82'); } };
  await assert.rejects(new TunnelHID(io).request([0x08, 0, 1]), /Config window is closed/);
});
