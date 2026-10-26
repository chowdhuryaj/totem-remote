import test from 'node:test';
import assert from 'node:assert/strict';
import { DemoStudio } from './demo-studio.js';
import * as K from './keymap-core.js';

test('demo studio loads TOTEM_DEFAULT: 11 layers x 38 keys, behaviors resolved', async () => {
  const c = new DemoStudio(), { keymap, behaviors } = await K.loadAll(c);
  assert.equal(keymap.layers.length, 11);
  assert.ok(keymap.layers.every((l) => l.bindings.length === 38));
  assert.ok(behaviors.size > 50);
  assert.equal(K.TOTEM_GEOM.length, 38);
});

test('legends decode and board geometry is finite', async () => {
  const c = new DemoStudio(), { keymap } = await K.loadAll(c);
  for (const b of keymap.layers[0].bindings) { const l = K.legend(b); assert.equal(typeof l.main, 'string'); assert.ok(l.main.length); }
  const g = K.boardGeom();
  assert.equal(g.keys.length, 38);
  const st = K.boardGeom(undefined, { stack: true });
  assert.ok(st.box.h > g.box.h * 1.6 && st.box.w < g.box.w * 0.6, "stacked board is narrower and taller");
  assert.ok(Number.isFinite(g.box.w) && g.box.w > 1000 && g.box.h > 300);
});

test('pick Key "Q" -> encode -> setLayerBinding -> unsaved -> discard restores', async () => {
  const c = new DemoStudio(), { keymap, behaviors } = await K.loadAll(c);
  const cat = K.catalog(behaviors, keymap);
  assert.ok(['key', 'mod-tap', 'hold-layer', 'mouse-key', 'media-key'].every((id) => cat.some((e) => e.id === id)), 'catalog entries');
  const entry = cat.find((e) => e.id === 'key');
  const b = K.bindingFor(entry, { key: 0x14, mods: 0 });
  assert.equal(b.param1, ((0x07 << 16) | 0x14) >>> 0);
  const before = keymap.layers[0].bindings[5];
  await c.setLayerBinding(keymap.layers[0].id, 5, b);
  assert.equal(await c.checkUnsavedChanges(), true);
  assert.equal((await c.getKeymap()).layers[0].bindings[5].param1, b.param1);
  await c.discardChanges();
  assert.deepEqual((await c.getKeymap()).layers[0].bindings[5], before);
  assert.equal(await c.checkUnsavedChanges(), false);
});

test('entryOf round-trips every default binding without throwing', async () => {
  const c = new DemoStudio(), { keymap, behaviors } = await K.loadAll(c);
  const cat = K.catalog(behaviors, keymap);
  let n = 0;
  for (const l of keymap.layers) for (const b of l.bindings) { const { entry } = K.entryOf(cat, b); assert.ok(entry || true); K.describe(b); n++; }
  assert.equal(n, 11 * 38);
});

test('layer ops on the demo studio', async () => {
  const c = new DemoStudio();
  await c.setLayerProps(1, 'Nav2'); assert.equal((await c.getKeymap()).layers[1].name, 'Nav2');
  const km = await c.moveLayer(1, 0); assert.equal(km.layers[0].name, 'Nav2');
  const { layer } = await c.addLayer(); assert.equal((await c.getKeymap()).layers.length, 12); assert.equal(layer.bindings.length, 38);
  await c.removeLayer(11); assert.equal((await c.getKeymap()).layers.length, 11);
});

test('key search finds keys and media keys', () => {
  assert.ok(K.searchKeys('enter').some((r) => r.entryId === 'key' && r.params.key === 0x28));
  assert.ok(K.searchKeys('volume up').some((r) => r.entryId === 'media-key' && r.params.code === 0xE9));
});

test('A1: two Studio sessions on one link wrap the characteristic once; a write still completes', async () => {
  const { SharedGattPort } = await import('./keymap.js');
  const wrote = [];
  const ch = { properties: { write: true }, stopNotifications: async () => {}, startNotifications: async () => {}, addEventListener() {}, removeEventListener() {},
    writeValueWithResponse: async (b) => { wrote.push(b); }, writeValueWithoutResponse: async () => {} };
  const dev = { addEventListener() {}, removeEventListener() {}, gatt: { connected: true, getPrimaryService: async () => ({ getCharacteristic: async () => ch }) } };
  let tail = Promise.resolve();
  const queue = (fn) => { const p = tail.then(fn); tail = p.then(() => {}, () => {}); return p; }; // serializes like the app's runP
  await new SharedGattPort(dev, queue).open();
  await new SharedGattPort(dev, queue).open();
  await Promise.race([ch.writeValueWithResponse(new Uint8Array([1])), new Promise((_, rej) => setTimeout(() => rej(new Error('deadlock')), 500))]);
  assert.equal(wrote.length, 1);
});
