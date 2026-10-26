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
export function legend(binding) {
  try { return capParts(binding, ADAPTER); } catch { return { top: '', main: '?' }; }
}
export function describe(binding) {
  try { return describeBinding(binding, ADAPTER); } catch (e) { return `(${e.message})`; }
}

/** Board geometry for the SVG: each key as a rect in 1/100 key units with a rotation, plus the bounding box. */
export function boardGeom(geom = TOTEM_GEOM, pad = 8, S = 100) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const keys = geom.map((k, pos) => {
    const r = ((k.r || 0) * Math.PI) / 180, cx = (k.rx || 0) * S, cy = (k.ry || 0) * S;
    for (const [px, py] of [[k.x, k.y], [k.x + k.w, k.y], [k.x, k.y + k.h], [k.x + k.w, k.y + k.h]]) {
      const dx = px * S - cx, dy = py * S - cy;
      const X = cx + dx * Math.cos(r) - dy * Math.sin(r), Y = cy + dx * Math.sin(r) + dy * Math.cos(r);
      x0 = Math.min(x0, X); y0 = Math.min(y0, Y); x1 = Math.max(x1, X); y1 = Math.max(y1, Y);
    }
    return { pos, x: k.x * S, y: k.y * S, w: k.w * S, h: k.h * S, r: k.r || 0, cx, cy };
  });
  return { keys, box: { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad } };
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
export function entryOf(cat, binding) {
  const d = decode(binding, ADAPTER);
  const entry = cat.find((e) => e.id === d.entryId) ?? null;
  return { entry, vals: entry ? { ...defaultParams(entry), ...d.params } : {} };
}
/** Entry + values -> Studio binding {behaviorId, param1, param2}. Throws a readable error when not storable. */
export function bindingFor(entry, vals) {
  if (entry.id === 'advanced') {
    const r = vals.raw;
    if (!r || !Number.isInteger(r.behaviorId)) throw new Error('Pick a behavior');
    return { behaviorId: r.behaviorId, param1: (r.param1 ?? 0) >>> 0, param2: (r.param2 ?? 0) >>> 0 };
  }
  return encode(entry.id, vals, ADAPTER);
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
