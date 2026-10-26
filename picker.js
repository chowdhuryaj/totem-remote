// Bottom-sheet binding picker, shared by the Keymap tab (Studio bindings) and the Flask sections (typed outputs).
import { $, h } from './dom.js';
import * as K from './keymap-core.js';

const pk = { entry: null, vals: {}, binding: null, term: '', adapter: K.ADAPTER, cat: [], onApply: null };
let wired = false;

/** adapter: 'zmk-studio' ({behaviorId,param1,param2}) or 'zmk-typed' ({action,behaviorId,param1,param2}).
 * onApply(binding) may throw; its message is shown in the sheet. */
export function openPicker({ title, current, cat, adapter = K.ADAPTER, currentText, onApply }) {
  if (!wired) { wired = true; $('#pk-cancel').onclick = () => $('#picker').close(); $('#pk-apply').onclick = applyPick; $('#pk-search').oninput = () => { pk.term = $('#pk-search').value; drawList(); }; }
  Object.assign(pk, { term: '', adapter, cat, onApply, binding: null });
  $('#pk-search').value = ''; $('#pk-msg').textContent = '';
  const r = current ? K.entryOf(cat, current, adapter) : { entry: null, vals: {} };
  pk.entry = r.entry; pk.vals = r.vals;
  $('#pk-title').textContent = title;
  $('#pk-current').textContent = 'Now: ' + (currentText ?? (current ? K.describe(current, adapter) : 'nothing'));
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
    pk.binding = K.bindingFor(pk.entry, pk.vals, pk.adapter);
    const lg = K.legend(pk.binding, pk.adapter);
    $('#pk-preview').textContent = `${K.describe(pk.binding, pk.adapter)}   [${lg.top ? lg.top + ' ' : ''}${lg.main}]`;
  } catch (e) { pk.binding = null; $('#pk-preview').textContent = e.message; }
  $('#pk-apply').disabled = !pk.binding;
}

const KEY_GROUPS = [['Letters', (c) => c >= 4 && c <= 0x1d], ['Numbers', (c) => c >= 0x1e && c <= 0x27], ['F keys', (c) => (c >= 0x3a && c <= 0x45) || (c >= 0x68 && c <= 0x73)], ['Other', () => true]];
export function keySelect(value, onchange) {
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
  if (quick.length) out.push(h('h4', { textContent: 'Keys' }), h('div', { className: 'chips' }, ...quick.map((q) => h('button', { className: 'small', textContent: q.label, onclick: () => choose(pk.cat.find((e) => e.id === q.entryId), q.params) }))));
  for (const g of K.CATALOG_GROUPS) {
    const es = pk.cat.filter((e) => e.group === g.id && (!t || `${e.name} ${e.desc} ${g.label}`.toLowerCase().includes(t)));
    if (!es.length) continue;
    out.push(h('h4', { textContent: g.label }), h('div', { className: 'chips' }, ...es.map((e) => h('button', { className: 'small' + (pk.entry?.id === e.id ? ' on' : ''), textContent: e.name, title: e.desc, onclick: () => choose(e, e.id === pk.entry?.id ? pk.vals : {}) }))));
  }
  $('#pk-list').replaceChildren(...out);
}
async function applyPick() {
  if (!pk.binding) return;
  $('#pk-apply').disabled = true;
  try { await pk.onApply(pk.binding); $('#picker').close(); }
  catch (e) { $('#pk-msg').textContent = String(e.message || e); $('#pk-apply').disabled = false; }
}
