// Small phone-native controls shared by the Flask sections.
import { h } from './dom.js';
import * as K from './keymap-core.js';
import { keySelect } from './picker.js';
import { openPicker } from './picker.js';
import { isRecursiveOutput } from './vendor/flask/behavior-catalog.js';

export { keySelect };
export const ui = { report: (m) => console.warn(m), studio: async () => null };

/** replaceChildren that skips null/undefined (conditional controls). */
export const set = (el, ...k) => el.replaceChildren(...k.filter((x) => x != null));

const run = async (fn) => { try { return await fn(); } catch (e) { ui.report(String(e?.message || e)); return undefined; } };

export const row = (label, ...ctl) => h('div', { className: 'frow' }, h('span', { className: 'fl', textContent: label }), ...ctl);

/** Range slider that writes on release. `onchange(v)` returns the value the device applied (clamp echo). */
export function slider({ min, max, step = 1, value, fmt = String, onchange }) {
  const out = h('span', { className: 'val', textContent: fmt(value) });
  const inp = h('input', { type: 'range', min, max, step, value });
  inp.addEventListener('input', () => { out.textContent = fmt(+inp.value); });
  inp.addEventListener('change', async () => {
    const v = await run(() => onchange(+inp.value));
    inp.value = v ?? value; out.textContent = fmt(+inp.value); value = +inp.value;
  });
  return h('div', { className: 'sl' }, inp, out);
}

/** Two-state button; `onchange(bool)` returns the applied state. */
export function toggle(label, value, onchange) {
  const b = h('button', { className: 'small tg' + (value ? ' on' : ''), textContent: label });
  b.addEventListener('click', async () => {
    const v = await run(() => onchange(!value));
    if (v !== undefined) value = !!v;
    b.classList.toggle('on', value);
  });
  return b;
}

/** - [n] + control; `onchange(n)` returns the applied number. */
export function stepper({ value, min = 0, max = 1000, step = 10, fmt = String, onchange }) {
  const out = h('span', { className: 'val', textContent: fmt(value) });
  const set = async (n) => {
    n = Math.max(min, Math.min(max, n));
    const v = await run(() => onchange(n));
    value = v ?? value; out.textContent = fmt(value);
  };
  return h('div', { className: 'stp' }, h('button', { className: 'small', textContent: '−', onclick: () => set(value - step) }), out, h('button', { className: 'small', textContent: '+', onclick: () => set(value + step) }));
}

export const select = (options, value, onchange) =>
  h('select', { onchange: (e) => onchange(e.target.value) }, ...options.map(([v, t]) => h('option', { value: v, textContent: t, selected: String(v) === String(value) })));

/** A typed output (flask action/behaviorId/param1/param2) as a button that opens the shared picker. */
export const typedOf = (o) => (o && o.action ? { action: o.action, behaviorId: o.behaviorId ?? 0, param1: o.param1 >>> 0, param2: (o.param2 ?? 0) >>> 0 } : null);
export const outText = (o) => (o && o.action ? K.describe(typedOf(o), 'zmk-typed') : 'empty');

export function outputButton(o, title, onPick) {
  const b = h('button', { className: 'small out', textContent: outText(o) });
  b.addEventListener('click', async () => {
    const st = await ui.studio();
    if (!st) { ui.report('Behaviors are needed to pick an output: connect the Keymap tab first.'); return; }
    openPicker({
      title, current: typedOf(o), cat: st.cat, adapter: 'zmk-typed', currentText: outText(o),
      onApply: async (v) => {
        const t = { action: v.action ?? 0, behaviorId: v.behaviorId ?? 0, param1: v.param1 >>> 0, param2: (v.param2 ?? 0) >>> 0 };
        if (isRecursiveOutput(t, { adaptiveOk: true })) throw new Error('That output would run a tap dance or adaptive key from inside one, which reboots the keyboard. Pick something else.');
        await onPick(t);
      },
    });
  });
  return b;
}

/** Totem key picker: tap keys to toggle membership. `labelOf(pos)` -> short text. Stacked halves on portrait phones. */
export function positionBoard({ selected, max = 4, labelOf = () => '', onChange }) {
  const NS = 'http://www.w3.org/2000/svg';
  const { keys, box } = K.boardGeom(undefined, { stack: innerHeight >= innerWidth });
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`); svg.setAttribute('class', 'kb sm');
  const sel = new Set(selected);
  const draw = () => {
    for (const g of svg.querySelectorAll('g')) g.firstChild.setAttribute('class', 'kr' + (sel.has(+g.dataset.pos) ? ' hold' : ''));
  };
  for (const k of keys) {
    const g = document.createElementNS(NS, 'g'); g.dataset.pos = k.pos;
    g.setAttribute('transform', `translate(${k.tx} ${k.ty})` + (k.r ? ` rotate(${k.r} ${k.cx} ${k.cy})` : ''));
    const r = document.createElementNS(NS, 'rect');
    for (const [a, v] of [['x', k.x + 4], ['y', k.y + 4], ['width', k.w - 8], ['height', k.h - 8], ['rx', 14], ['class', 'kr']]) r.setAttribute(a, v);
    const t = document.createElementNS(NS, 'text'); t.setAttribute('x', k.x + k.w / 2); t.setAttribute('y', k.y + k.h * 0.6); t.setAttribute('class', 'km'); t.textContent = labelOf(k.pos) || String(k.pos);
    g.append(r, t);
    g.addEventListener('click', () => {
      if (sel.has(k.pos)) sel.delete(k.pos); else if (sel.size < max) sel.add(k.pos); else return;
      draw(); onChange([...sel].sort((a, b) => a - b));
    });
    svg.append(g);
  }
  draw();
  return svg;
}
