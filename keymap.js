// Keymap tab: Studio over the already-connected BluetoothDevice (or a fake Studio in demo mode),
// a Totem diagram, a bottom-sheet binding picker, layer actions, Save / Discard.
import { $, h } from './dom.js';
import { StudioClient, GattPort, STUDIO_GATT_SERVICE } from './vendor/flask/zmk-studio.js';
import * as K from './keymap-core.js';
import { DemoStudio } from './demo-studio.js';

export { STUDIO_GATT_SERVICE };
// Guess: the Status byte only says "config window open", not for how long. Replace when the firmware exposes it.
export const CONFIG_WINDOW_S = 60;
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
  $('#pk-cancel').onclick = () => $('#picker').close();
  $('#pk-apply').onclick = applyPick;
  $('#pk-search').oninput = () => { pk.term = $('#pk-search').value; drawList(); };
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

function board() {
  const { keys, box } = K.boardGeom();
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
  svg.setAttribute('class', 'kb');
  const L = layer();
  for (const k of keys) {
    const b = L.bindings[k.pos], lg = K.legend(b);
    const g = document.createElementNS(NS, 'g');
    g.dataset.pos = k.pos;
    if (k.r) g.setAttribute('transform', `rotate(${k.r} ${k.cx} ${k.cy})`);
    const dim = lg.main === '▽' || lg.main === '∅';
    const rect = document.createElementNS(NS, 'rect');
    for (const [a, v] of [['x', k.x + 4], ['y', k.y + 4], ['width', k.w - 8], ['height', k.h - 8], ['rx', 14], ['class', 'kr' + (dim ? ' dim' : '') + (lg.top ? ' hold' : '')]]) rect.setAttribute(a, v);
    g.append(rect);
    const text = (cls, str, y) => { const t = document.createElementNS(NS, 'text'); t.setAttribute('x', k.x + k.w / 2); t.setAttribute('y', y); t.setAttribute('class', cls); t.textContent = str; return t; };
    const main = lg.main.length > 6 ? lg.main.slice(0, 5) + '…' : lg.main;
    if (lg.top) { const top = lg.top.replace(/^Mod-tap\s*/, '').replace(/^LT\s*/, '').trim() || lg.top;
      g.append(text('kt', top.length > 7 ? top.slice(0, 6) + '…' : top, k.y + k.h * 0.34)); g.append(text('km', main, k.y + k.h * 0.74)); }
    else g.append(text('km', main, k.y + k.h * 0.58));
    g.addEventListener('click', () => openPicker(k.pos));
    svg.append(g);
  }
  return svg;
}

// ---------- binding picker ----------
const pk = { pos: 0, entry: null, vals: {}, binding: null, term: '' };

function openPicker(pos) {
  const cur = layer().bindings[pos];
  pk.pos = pos; pk.term = ''; $('#pk-search').value = ''; $('#pk-msg').textContent = '';
  const { entry, vals } = K.entryOf(s.cat, cur);
  pk.entry = entry; pk.vals = vals; pk.binding = null;
  $('#pk-title').textContent = `${K.layerLabel(layer().name, s.layer)} · key ${pos}`;
  $('#pk-current').textContent = 'Now: ' + K.describe(cur);
  drawParams(); drawPreview(); drawList();
  $('#picker').showModal();
}
function choose(entry, vals) {
  pk.entry = entry; pk.vals = { ...K.defaultParams(entry), ...vals };
  drawParams(); drawPreview(); drawList();
}
function drawPreview() {
  if (!pk.entry) { pk.binding = null; $('#pk-preview').textContent = 'Pick something below.'; $('#pk-apply').disabled = true; return; }
  try {
    pk.binding = K.bindingFor(pk.entry, pk.vals);
    const lg = K.legend(pk.binding);
    $('#pk-preview').textContent = `${K.describe(pk.binding)}   [${lg.top ? lg.top + ' ' : ''}${lg.main}]`;
  } catch (e) { pk.binding = null; $('#pk-preview').textContent = e.message; }
  $('#pk-apply').disabled = !pk.binding;
}

const KEY_GROUPS = [['Letters', (c) => c >= 4 && c <= 0x1d], ['Numbers', (c) => c >= 0x1e && c <= 0x27], ['F keys', (c) => (c >= 0x3a && c <= 0x45) || (c >= 0x68 && c <= 0x73)], ['Other', () => true]];
function keySelect(value, onchange) {
  const seen = new Set(), groups = KEY_GROUPS.map(([name, test]) => h('optgroup', { label: name }, ...K.keyboardUsages.filter((k) => !seen.has(k.code) && test(k.code) && seen.add(k.code)).map((k) => h('option', { value: k.code, textContent: k.label, selected: k.code === value }))));
  return h('select', { onchange: (e) => onchange(+e.target.value) }, ...groups);
}
const MODS = [['⌃', 1], ['⇧', 2], ['⌥', 4], ['⌘', 8]];
function modsControl(value, onchange) {
  const right = value >= 0x10, left = right ? value >> 4 : value & 0x0f;
  const set = (l, r) => onchange(r ? (l << 4) & 0xff : l);
  return h('div', { className: 'row' },
    ...MODS.map(([g, b]) => h('button', { className: 'small' + (left & b ? ' on' : ''), textContent: g, onclick: () => { set(left ^ b, right); drawParams(); } })),
    h('button', { className: 'small' + (right ? ' on' : ''), textContent: 'Right', onclick: () => { set(left, !right); drawParams(); } }));
}
function control(p) {
  const v = pk.vals, set = (x) => { v[p.key] = x; drawPreview(); };
  const lab = (n, el) => h('label', { className: 'field' }, n, el);
  const name = { key: 'Key', tap: 'Tap key', hold: 'Hold', mods: 'Modifiers', layer: 'Layer', slot: 'Slot', code: 'Option', timing: 'Timing', mode: 'Mode', live: 'Live', profile: 'Profile' }[p.key] ?? p.key;
  if (p.kind === 'mods') return lab(name, modsControl(v[p.key] ?? 0, set));
  if (p.kind === 'key') return lab(name, keySelect(v[p.key] ?? 4, set));
  if (p.kind === 'raw') {
    const bs = pk.entry.behaviors ?? [], r = v.raw ?? { behaviorId: bs[0]?.id, param1: 0, param2: 0 };
    const upd = (o) => { v.raw = { ...r, ...o }; drawPreview(); };
    if (!v.raw && bs.length) v.raw = r;
    return h('div', { className: 'field' }, 'Behavior',
      h('select', { onchange: (e) => upd({ behaviorId: +e.target.value }) }, ...bs.map((b) => h('option', { value: b.id, textContent: b.displayName || '#' + b.id, selected: b.id === r.behaviorId }))),
      h('div', { className: 'row' }, h('input', { type: 'number', value: r.param1 ?? 0, oninput: (e) => upd({ param1: +e.target.value || 0 }) }), h('input', { type: 'number', value: r.param2 ?? 0, oninput: (e) => upd({ param2: +e.target.value || 0 }) })));
  }
  if (p.kind === 'ms' && !p.variants?.length) {
    const out = h('span', { textContent: `${v[p.key] ?? p.default} ms` });
    return lab(name, h('div', { className: 'row' }, h('input', { type: 'range', className: 'grow', min: p.min, max: p.max, step: p.step || 10, value: v[p.key] ?? p.default, oninput: (e) => { out.textContent = e.target.value + ' ms'; set(+e.target.value); } }), out));
  }
  if (p.kind === 'ms' || p.kind === 'choice' || p.kind === 'layer') {
    const opts = p.kind === 'ms' ? p.variants : p.options;
    return lab(name, h('select', { onchange: (e) => set(isNaN(+opts[0]) ? e.target.value : +e.target.value) },
      ...opts.map((o) => h('option', { value: o, textContent: p.kind === 'ms' ? `${o} ms` : p.labels?.[o] ?? String(o), selected: o === v[p.key] }))));
  }
  return lab(name, h('input', { type: 'number', min: p.min, max: p.max, value: v[p.key] ?? p.min ?? 0, oninput: (e) => set(+e.target.value || 0) }));
}
function drawParams() {
  $('#pk-params').replaceChildren(...(pk.entry ? [h('b', { textContent: pk.entry.name }), h('span', { className: 'desc', textContent: pk.entry.desc }), ...pk.entry.params.map(control)] : []));
}
function drawList() {
  const t = pk.term.trim().toLowerCase(), out = [];
  const quick = K.searchKeys(pk.term);
  if (quick.length) out.push(h('h4', { textContent: 'Keys' }), h('div', { className: 'chips' }, ...quick.map((q) => h('button', { className: 'small', textContent: q.label, onclick: () => choose(s.cat.find((e) => e.id === q.entryId), q.params) }))));
  for (const g of K.CATALOG_GROUPS) {
    const es = s.cat.filter((e) => e.group === g.id && (!t || `${e.name} ${e.desc} ${g.label}`.toLowerCase().includes(t)));
    if (!es.length) continue;
    out.push(h('h4', { textContent: g.label }), h('div', { className: 'chips' }, ...es.map((e) => h('button', { className: 'small' + (pk.entry?.id === e.id ? ' on' : ''), textContent: e.name, title: e.desc, onclick: () => choose(e, e.id === pk.entry?.id ? pk.vals : {}) }))));
  }
  $('#pk-list').replaceChildren(...out);
}
async function applyPick() {
  if (!pk.binding) return;
  $('#pk-apply').disabled = true;
  try {
    const l = layer();
    await s.client.setLayerBinding(l.id, pk.pos, pk.binding);
    l.bindings[pk.pos] = { behaviorId: pk.binding.behaviorId, param1: pk.binding.param1 >>> 0, param2: pk.binding.param2 >>> 0 };
    s.unsaved = true; $('#picker').close(); paint();
  } catch (e) { $('#pk-msg').textContent = String(e.message || e); $('#pk-apply').disabled = false; }
}
