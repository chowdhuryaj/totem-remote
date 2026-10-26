// Keymap logic with no DOM: loading Studio state into the catalog context, board geometry, legends, binding encode.
import { setZmkContext, keyboardUsages, consumerUsages, layerLabel } from './vendor/flask/zmk-keycodes.js';
import { catalogFor, CATALOG_GROUPS, decode, encode, capParts, describeBinding, entryById, TIMING_PARAM } from './vendor/flask/behavior-catalog.js';
import { TOTEM_GEOM } from './vendor/flask/zmk-totem-layout.js';

export { CATALOG_GROUPS, keyboardUsages, consumerUsages, layerLabel, decode, encode, entryById, describeBinding, TIMING_PARAM, TOTEM_GEOM };
export const ADAPTER = 'zmk-studio';

/** Reads keymap + every behavior's details through `client` (StudioClient or DemoStudio) and sets the catalog context. */
export async function loadAll(client, onProgress = () => {}) {
  const keymap = await client.getKeymap();
  const ids = await client.listAllBehaviors();
  const behaviors = new Map();
  for (let i = 0; i < ids.length; i++) {
    onProgress(i + 1, ids.length);
    try { const d = await client.getBehaviorDetails(ids[i]); behaviors.set(d.id, d); } catch (e) { console.warn('behavior', ids[i], e.message); }
  }
  setContext(behaviors, keymap);
  return { keymap, behaviors };
}
export function setContext(behaviors, keymap) {
  setZmkContext({ behaviors, layers: keymap.layers.map((l) => ({ id: l.id, name: l.name })) });
}
export const catalog = (behaviors, keymap) => catalogFor({ adapter: ADAPTER, behaviors, layerCount: keymap.layers.length });

/** {top, main} legend for a binding; never throws. */
export function legend(binding, adapter = ADAPTER) {
  try { return capParts(binding, adapter); } catch { return { top: '', main: '?' }; }
}
export function describe(binding, adapter = ADAPTER) {
  try { return describeBinding(binding, adapter); } catch (e) { return `(${e.message})`; }
}

/** Board geometry for the SVG: each key as a rect in 1/100 key units with a rotation, plus the bounding box.
 * `stack`: put the right half under the left half (portrait phones) so each half gets the full width. */
export function boardGeom(geom = TOTEM_GEOM, { stack = false, pad = 8, gap = 60, S = 100 } = {}) {
  const corners = (k) => {
    const r = ((k.r || 0) * Math.PI) / 180, cx = (k.rx || 0) * S, cy = (k.ry || 0) * S;
    return [[k.x, k.y], [k.x + k.w, k.y], [k.x, k.y + k.h], [k.x + k.w, k.y + k.h]].map(([px, py]) => {
      const dx = px * S - cx, dy = py * S - cy;
      return [cx + dx * Math.cos(r) - dy * Math.sin(r), cy + dx * Math.sin(r) + dy * Math.cos(r)];
    });
  };
  const mid = (Math.min(...geom.map((k) => k.x)) + Math.max(...geom.map((k) => k.x + k.w))) / 2;
  const bb = () => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
  const grow = (b, [X, Y]) => { b.x0 = Math.min(b.x0, X); b.y0 = Math.min(b.y0, Y); b.x1 = Math.max(b.x1, X); b.y1 = Math.max(b.y1, Y); };
  const half = [bb(), bb()];
  const hand = geom.map((k) => { const cs = corners(k), h = (cs.reduce((s, c) => s + c[0], 0) / 4) / S < mid ? 0 : 1; cs.forEach((c) => grow(half[h], c)); return h; });
  // right half moves left under the left half (aligned on its left edge) when stacking
  const tx = stack ? half[0].x0 - half[1].x0 : 0, ty = stack ? half[0].y1 - half[1].y0 + gap : 0;
  const all = bb();
  const keys = geom.map((k, pos) => {
    const mv = hand[pos] === 1 ? [tx, ty] : [0, 0];
    corners(k).forEach(([X, Y]) => grow(all, [X + mv[0], Y + mv[1]]));
    return { pos, x: k.x * S, y: k.y * S, w: k.w * S, h: k.h * S, r: k.r || 0, cx: (k.rx || 0) * S, cy: (k.ry || 0) * S, tx: mv[0], ty: mv[1], hand: hand[pos] };
  });
  return { keys, box: { x: all.x0 - pad, y: all.y0 - pad, w: all.x1 - all.x0 + 2 * pad, h: all.y1 - all.y0 + 2 * pad } };
}

/** Default values for an entry's params (what the picker starts from). */
export function defaultParams(entry) {
  const v = {};
  for (const p of entry.params) {
    if (p.default !== undefined) v[p.key] = p.default;
    else if (p.kind === 'key') v[p.key] = 0x04;
    else if (p.kind === 'layer' || p.kind === 'choice') v[p.key] = p.options?.[0] ?? 0;
    else if (p.kind === 'slot' || p.kind === 'num') v[p.key] = p.min ?? 0;
    else if (p.kind === 'mods') v[p.key] = 0;
  }
  if (entry.id === 'advanced') v.raw = null;
  return v;
}
/** Binding -> {entry, vals}: the entry the binding decodes to (from the device catalog) and its current values. */
export function entryOf(cat, binding, adapter = ADAPTER) {
  const d = decode(binding, adapter);
  const entry = cat.find((e) => e.id === d.entryId) ?? null;
  return { entry, vals: entry ? { ...defaultParams(entry), ...d.params } : {} };
}
/** Entry + values -> Studio binding {behaviorId, param1, param2}. Throws a readable error when not storable. */
export function bindingFor(entry, vals, adapter = ADAPTER) {
  if (entry.id === 'advanced') {
    const r = vals.raw;
    if (!r || !Number.isInteger(r.behaviorId)) throw new Error('Pick a behavior');
    const raw = { behaviorId: r.behaviorId, param1: (r.param1 ?? 0) >>> 0, param2: (r.param2 ?? 0) >>> 0 };
    return adapter === 'zmk-typed' ? { action: 3, ...raw } : raw;
  }
  return encode(entry.id, vals, adapter);
}

/** Quick key matches for the search box: {entryId, params, label}. */
export function searchKeys(term, limit = 12) {
  const t = term.trim().toLowerCase();
  if (!t) return [];
  const out = [];
  for (const k of keyboardUsages) if (`${k.label} ${k.cap}`.toLowerCase().includes(t)) out.push({ entryId: 'key', params: { key: k.code, mods: 0 }, label: k.label });
  for (const k of consumerUsages) if (`${k.label} ${k.cap}`.toLowerCase().includes(t)) out.push({ entryId: 'media-key', params: { code: k.code }, label: k.label });
  return out.slice(0, limit);
}
