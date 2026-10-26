// Drives every Flask section's read path through the demo device, then each channel's save and a representative
// write, and asserts the firmware allowlist (demo-flask.js tunnelAllows) refused nothing.
import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM: just enough for dom.js h() and the section builders to construct controls.
class El {
  constructor(tag) { this.tag = tag; this.childNodes = []; this.dataset = {}; this.style = {}; this.listeners = {}; this.classList = { toggle() {}, add() {}, remove() {} }; }
  append(...k) { this.childNodes.push(...k.map((x) => (typeof x === 'object' ? x : { text: String(x) }))); }
  replaceChildren(...k) { this.childNodes = []; this.append(...k); }
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
  setAttribute(k, v) { this[k] = v; }
  querySelectorAll() { return []; }
  get firstChild() { return this.childNodes[0]; }
}
globalThis.document = { createElement: (t) => new El(t), createElementNS: (_, t) => new El(t) };
globalThis.innerHeight = 800; globalThis.innerWidth = 400;

const { TunnelHID } = await import('./tunnel.js');
const { DemoFlaskIo } = await import('./demo-flask.js');
const { FlaskProto } = await import('./vendor/flask/flaskproto.js');
const { zmkCapabilities } = await import('./vendor/flask/zmk.js');
const A = await import('./flask-sections-a.js');
const B = await import('./flask-sections-b.js');
const { ui } = await import('./flask-ui.js');

async function connect() {
  const io = new DemoFlaskIo(), hid = new TunnelHID(io), flask = new FlaskProto(hid); flask.line = 'zmk';
  const version = await flask.handshake();
  const caps = zmkCapabilities('totem', version); caps.adaptive = version >= 18;
  const dirty = new Map();
  const F = { flask, app: { flask, hid, protocolVersion: version, caps, family: 'totem' }, caps, version, studio: null, dirty: (ch, l) => dirty.set(ch, l), progress() {} };
  return { io, flask, F, dirty };
}

const SECTIONS = { holdtap: A.holdtap, tapdance: A.tapDance, combos: B.combos, macros: B.macros, autoshift: A.autoshift, adaptive: B.adaptive, shift: A.customShift };

test('every section reads through the demo with no refused frame', async () => {
  const { io, F } = await connect();
  const errors = [];
  ui.report = (m) => errors.push(m);
  for (const [name, build] of Object.entries(SECTIONS)) {
    const body = new El('div');
    await build(body, F);
    assert.ok(body.childNodes.length > 0, `${name} drew something`);
  }
  assert.deepEqual(io.refused, [], 'refused frames');
  assert.deepEqual(errors, []);
});

test('meta is only read as 0x01 and 0x03 (handshake included)', async () => {
  const { io, F } = await connect();
  for (const build of Object.values(SECTIONS)) await build(new El('div'), F);
  const meta = io.log.filter((f) => f[1] === 0x00);
  assert.ok(meta.length >= 1);
  assert.ok(meta.every((f) => f[0] === 0x08 && (f[2] === 0x01 || f[2] === 0x03)), JSON.stringify(meta));
  assert.ok(!io.log.some((f) => (f[1] === 0x25 && f[2] === 0x06) || (f[1] === 0x2a && f[2] === 0x54)), 'no macro state / hold-tap log');
});

test('writes and saves for every section are allowlisted', async () => {
  const { io, flask, F, dirty } = await connect();
  // representative write per section, using the same frames the sections send
  await flask.setBytes(0x2a, 0x50, [3, 0, 200, 0, 0, 0, 0, 1, 0], 1);      // hold-tap slot
  await flask.setU16(0x2c, 0x01, 1);                                       // auto shift
  await flask.setBytes(0x16, 0x50, [1, 0, 7, 0, 0x37, 0, 7, 0, 0x38, 2, 0], 1); // custom shift
  await flask.setBytes(0x28, 0x50, [1, 0, 1, 0, 0, 0, 7, 0, 4, 0, 0, 0, 0], 2);  // tap dance step
  await flask.setBytes(0x24, 0x12, [2, 3, 4, 0xff, 0xff, 1, 0, 0, 0, 7, 0, 0x2b, 0, 0, 0, 0, 0, 0, 0, 0, 0xff], 1); // combo
  await flask.setBytes(0x25, 0x10, [1, 0, 1, 0, 7, 0, 4], 2);              // macro step
  await flask.setBytes(0x2b, 0x50, [1, 0, 0, 7, 0, 4, 1, 0x2c, 0], 1);     // adaptive rule
  for (const ch of [0x2a, 0x2c, 0x16, 0x28, 0x24, 0x25, 0x2b]) await flask.save(ch);
  assert.deepEqual(io.refused, []);
  assert.deepEqual(io.saves, [0x2a, 0x2c, 0x16, 0x28, 0x24, 0x25, 0x2b]);
  void dirty;
});

test('the sections never offer macro playback', async () => {
  const body = new El('div');
  const { F } = await connect();
  await B.macros(body, F);
  const texts = JSON.stringify(body, (k, v) => (k === 'listeners' ? undefined : v));
  assert.ok(!/"textContent":"Play"/.test(texts));
});
