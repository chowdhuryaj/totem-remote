// Keymap tab: Studio over the already-connected BluetoothDevice (or a fake Studio in demo mode),
// a Totem diagram, a bottom-sheet binding picker, layer actions, Save / Discard.
import { $, h } from './dom.js';
import { StudioClient, GattPort, STUDIO_GATT_SERVICE } from './vendor/flask/zmk-studio.js';
import * as K from './keymap-core.js';
import { DemoStudio } from './demo-studio.js';
import { openPicker } from './picker.js';

export { STUDIO_GATT_SERVICE };
// The Status byte only says "config window open"; the length is the firmware's Kconfig default.
export const CONFIG_WINDOW_S = 300; // firmware default CONFIG_TOTEM_PHONE_REMOTE_CONFIG_WINDOW_S
const NS = 'http://www.w3.org/2000/svg';

// Shares the remote's BluetoothDevice: closing Studio must not drop the remote's GATT link (GattPort.close() would).
class SharedGattPort extends GattPort {
  async close() {
    this._unlisten();
    try { await this._char?.stopNotifications(); } catch { /* link gone */ }
    this._char = null;
  }
}

let deps = { getDevice: () => null, getStatus: () => null, isDemo: () => false };
const s = { client: null, keymap: null, behaviors: null, cat: null, layer: 0, unsaved: false, msg: '', busy: false };
let cfgUntil = 0, cfgTimer = 0;

export function initKeymap(d) {
  deps = d;
  $('#nb-km').onclick = () => { $('#km').showModal(); paint(); };
  $('#km-close').onclick = () => $('#km').close();
  $('#km-connect').onclick = () => (s.client ? down('') : connect());
  $('#km-save').onclick = () => act(async () => { await s.client.saveChanges(); s.unsaved = false; s.msg = 'Saved'; });
  $('#km-discard').onclick = () => { if (confirm('Discard unsaved keymap changes?')) act(async () => { await s.client.discardChanges(); s.layer = 0; await refresh(); s.unsaved = false; s.msg = 'Discarded'; }); };
  $('#km-rename').onclick = () => {
    const l = layer(); const n = prompt('Layer name', l.name || '');
    if (n != null) act(async () => { await s.client.setLayerProps(l.id, n.slice(0, s.keymap.maxLayerNameLength || 20)); await refresh(); s.unsaved = true; });
  };
  $('#km-add').onclick = () => act(async () => { const r = await s.client.addLayer(); await refresh(); s.layer = r.index ?? s.keymap.layers.length - 1; s.unsaved = true; });
  $('#km-remove').onclick = () => {
    if (s.keymap.layers.length > 1 && confirm(`Remove layer "${K.layerLabel(layer().name, s.layer)}"?`)) act(async () => { await s.client.removeLayer(s.layer); s.layer = Math.max(0, s.layer - 1); await refresh(); s.unsaved = true; });
  };
  $('#km-up').onclick = () => move(-1);
  $('#km-down').onclick = () => move(1);
    paint();
}

/** Called with every decoded remote Status. */
export function keymapStatus(st) {
  if (st?.configOpen && !cfgUntil) cfgUntil = Date.now() + CONFIG_WINDOW_S * 1000;
  if (!st?.configOpen) cfgUntil = 0;
  if (!cfgTimer) cfgTimer = setInterval(paintCfg, 1000);
  paint();
}
/** The remote link went away. */
export function keymapDown() { if (s.client) down('Remote disconnected'); }

const layer = () => s.keymap.layers[s.layer];
async function act(fn) {
  s.busy = true; paint();
  try { await fn(); if (s.msg && !/^(Saved|Discarded)$/.test(s.msg)) s.msg = ''; } catch (e) { s.msg = String(e.message || e); }
  s.busy = false; paint();
}
async function move(d) {
  const to = s.layer + d;
  if (to < 0 || to >= s.keymap.layers.length) return;
  act(async () => { const km = await s.client.moveLayer(s.layer, to); s.layer = to; if (km) adopt(km); else await refresh(); s.unsaved = true; });
}
function adopt(km) { s.keymap = km; K.setContext(s.behaviors, km); s.cat = K.catalog(s.behaviors, km); s.layer = Math.min(s.layer, km.layers.length - 1); }
async function refresh() { adopt(await s.client.getKeymap()); }

async function connect() {
  s.busy = true; s.msg = 'Connecting...'; paint();
  let client = null;
  try {
    if (deps.isDemo()) client = new DemoStudio();
    else {
      const dev = deps.getDevice();
      if (!dev) throw new Error('Connect the remote first.');
      client = new StudioClient();
      if (!(await client._attempt(new SharedGattPort(dev), null))) throw new Error('Studio did not answer. Is the config window open?');
      if ((await client.getLockState()) === 0) throw new Error('Studio is locked. Press Phone Config Unlock on the keyboard.');
    }
    s.client = client;
    client.addEventListener('unsaved', (e) => { s.unsaved = !!e.detail; paint(); });
    client.addEventListener('disconnect', () => { if (s.client === client) down('Studio disconnected'); });
    const r = await K.loadAll(client, (i, n) => { s.msg = `Loading behaviors ${i}/${n}`; paintMsg(); });
    s.behaviors = r.behaviors; adopt(r.keymap); s.layer = 0;
    s.unsaved = await client.checkUnsavedChanges();
    s.msg = '';
  } catch (e) {
    s.msg = String(e.message || e);
    try { await client?.disconnect?.(); } catch { /* ignore */ }
    s.client = null;
  }
  s.busy = false; paint();
}
async function down(msg) {
  const c = s.client; s.client = null; s.keymap = null; s.unsaved = false; s.msg = msg;
  try { await c?.disconnect?.(); } catch { /* ignore */ }
  paint();
}

// ---------- painting ----------
function paintCfg() {
  const chip = $('#km-cfg'), st = deps.getStatus();
  if (deps.isDemo()) { chip.hidden = false; chip.textContent = 'demo'; return; }
  chip.hidden = !st;
  if (!st) return;
  if (!st.configOpen) { chip.textContent = 'config locked'; return; }
  const left = Math.max(0, Math.round((cfgUntil - Date.now()) / 1000));
  chip.textContent = left ? `config open ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'config open';
}
function paintMsg() {
  const st = deps.getStatus();
  let m = s.msg;
  if (!m && !s.client) m = deps.isDemo() ? 'Demo: a fake Studio backed by the default Totem keymap.' : !deps.getDevice() ? 'Connect the remote first, then open this tab.'
    : st?.configOpen ? 'Config window is open. Tap Connect.' : 'Press Phone Config Unlock on the keyboard';
  $('#km-msg').textContent = m;
}
function paint() {
  paintCfg(); paintMsg();
  const st = deps.getStatus(), on = !!s.client;
  $('#km-connect').textContent = on ? 'Disconnect Studio' : 'Connect to keyboard';
  $('#km-connect').disabled = s.busy || (!on && !deps.isDemo() && !(deps.getDevice() && st?.configOpen));
  $('#km-unsaved').hidden = !(on && s.unsaved);
  for (const id of ['km-layerops', 'km-actions']) $('#' + id).hidden = !on;
  $('#km-save').disabled = s.busy || !s.unsaved; $('#km-discard').disabled = s.busy || !s.unsaved;
  for (const id of ['km-rename', 'km-add', 'km-remove', 'km-up', 'km-down']) $('#' + id).disabled = s.busy;
  $('#km-layers').replaceChildren(...(on ? s.keymap.layers.map((l, i) => h('button', { className: 'small' + (i === s.layer ? ' on' : ''), textContent: K.layerLabel(l.name, i), onclick: () => { s.layer = i; paint(); } })) : []));
  $('#km-board').replaceChildren(on ? board() : h('span'));
}

// Estimated text width in key units (system font averages ~0.55 em per glyph).
const squeeze = (t, str, size, avail) => { if (str.length * size * 0.55 > avail) { t.setAttribute('textLength', avail); t.setAttribute('lengthAdjust', 'spacingAndGlyphs'); } };
function board() {
  const portrait = innerHeight >= innerWidth;
  const { keys, box } = K.boardGeom(undefined, { stack: portrait });
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
  svg.setAttribute('class', 'kb');
  const L = layer();
  for (const k of keys) {
    const b = L.bindings[k.pos], lg = K.legend(b);
    const g = document.createElementNS(NS, 'g');
    g.dataset.pos = k.pos;
    g.setAttribute('transform', `translate(${k.tx} ${k.ty})` + (k.r ? ` rotate(${k.r} ${k.cx} ${k.cy})` : ''));
    const dim = lg.main === '▽' || lg.main === '∅';
    const rect = document.createElementNS(NS, 'rect');
    for (const [a, v] of [['x', k.x + 4], ['y', k.y + 4], ['width', k.w - 8], ['height', k.h - 8], ['rx', 14], ['class', 'kr' + (dim ? ' dim' : '') + (lg.top ? ' hold' : '')]]) rect.setAttribute(a, v);
    g.append(rect);
    const text = (cls, str, y, size) => { const t = document.createElementNS(NS, 'text'); t.setAttribute('x', k.x + k.w / 2); t.setAttribute('y', y); t.setAttribute('class', cls); t.textContent = str; squeeze(t, str, size, k.w - 14); return t; };
    const main = lg.main.length > 8 ? lg.main.slice(0, 7) + '…' : lg.main;
    // Hold part: drop the variant tags (" · live", " · fast") that only matter in the picker.
    const top = lg.top.replace(/^Mod-tap\s*/, '').replace(/^LT\s*/, '').replace(/ · .*$/, '').trim();
    if (top) { g.append(text('kt', top, k.y + k.h * 0.3, 24)); g.append(text('km', main, k.y + k.h * 0.74, 38)); }
    else g.append(text('km', main, k.y + k.h * 0.58, 38));
    g.addEventListener('click', () => editKey(k.pos));
    svg.append(g);
  }
  return svg;
}

function editKey(pos) {
  const l = layer();
  openPicker({
    title: `${K.layerLabel(l.name, s.layer)} · key ${pos}`, current: l.bindings[pos], cat: s.cat,
    onApply: async (b) => {
      await s.client.setLayerBinding(l.id, pos, b);
      l.bindings[pos] = { behaviorId: b.behaviorId, param1: b.param1 >>> 0, param2: b.param2 >>> 0 };
      s.unsaved = true; paint();
    },
  });
}

/** Behaviors/catalog for pickers in other sheets; null until Studio is connected. */
export const studioCtx = () => (s.client ? { cat: s.cat, behaviors: s.behaviors, keymap: s.keymap } : null);
/** Connects Studio on demand (needs a user gesture on a real link); resolves to the ctx or null. */
export async function ensureStudio() { if (!s.client && !s.busy) await connect(); return studioCtx(); }
