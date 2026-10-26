// Host profiles (deck pages + gesture map), defaults, import/export, gesture classification. Pure: no DOM.
export const HOSTS = ['Mac', 'Workstation'];
export const GESTURES = [
  ['swipe3L', '3-finger swipe left'], ['swipe3R', '3-finger swipe right'],
  ['swipe3U', '3-finger swipe up'], ['swipe3D', '3-finger swipe down'],
  ['swipe4U', '4-finger swipe up'], ['swipe4D', '4-finger swipe down'],
  ['pinchIn', 'Pinch in'], ['pinchOut', 'Pinch out'], ['tap3', '3-finger tap'],
];
const C = 1, S = 2, A = 4, G = 8; // Ctrl, Shift, Alt, Cmd/Win
const act = (label, mods, usage, page = 7) => ({ label, steps: [{ t: 'key', mods, page, usage }] });
const media = () => [act('Play / Pause', 0, 0xcd, 0xc), act('Vol +', 0, 0xe9, 0xc), act('Vol -', 0, 0xea, 0xc), act('Mute', 0, 0xe2, 0xc)];

function defaultProfile(host) {
  const mac = host === 'Mac', m = mac ? G : C, n = mac ? 'Cmd+' : 'Ctrl+';
  const main = [...media(), act(n + 'C', m, 6), act(n + 'V', m, 0x19), mac ? act('Cmd+Tab', G, 0x2b) : act('Alt+Tab', A, 0x2b)];
  const edit = [['X', 0x1b], ['Z', 0x1d], ['A', 4], ['S', 0x16], ['F', 9], ['W', 0x1a]].map(([k, u]) => act(n + k, m, u));
  const gestures = mac ? {
    swipe3L: act('Space left', C, 0x50), swipe3R: act('Space right', C, 0x4f),
    swipe3U: act('Mission Control', C, 0x52), swipe3D: act('App Expose', C, 0x51),
    swipe4U: act('Mission Control', C, 0x52), swipe4D: act('App Expose', C, 0x51),
    pinchIn: act('Zoom out', G, 0x2d), pinchOut: act('Zoom in', G, 0x2e), tap3: act('Look up', G | C, 7),
  } : {
    swipe3L: act('Desktop left', G | C, 0x50), swipe3R: act('Desktop right', G | C, 0x4f),
    swipe3U: act('Task view', G, 0x2b), swipe3D: act('Show desktop', G, 7),
    swipe4U: act('Task view', G, 0x2b), swipe4D: act('Show desktop', G, 7),
    pinchIn: act('Zoom out', C, 0x2d), pinchOut: act('Zoom in', C, 0x2e), tap3: act('Search', G, 0x16),
  };
  return { pages: [{ name: 'Main', buttons: main }, { name: 'Edit', buttons: edit }], gestures };
}
export const defaultConfig = () => ({ version: 2, override: null, profiles: { Mac: defaultProfile('Mac'), Workstation: defaultProfile('Workstation') } });

const int = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.trunc(+v) || 0));
const ascii = (s) => [...String(s ?? '')].filter((c) => (c >= ' ' && c <= '~') || c === '\n' || c === '\t').join('');
export function cleanAction(b) {
  return {
    label: String(b?.label ?? '').slice(0, 40),
    steps: (Array.isArray(b?.steps) ? b.steps : []).flatMap((s) =>
      s?.t === 'key' ? [{ t: 'key', mods: int(s.mods, 0, 255), page: s.page === 0x0c ? 0x0c : 7, usage: int(s.usage, 0, 0xffff) }]
      : s?.t === 'text' ? [{ t: 'text', text: ascii(s.text) }]
      : s?.t === 'delay' ? [{ t: 'delay', ms: int(s.ms, 0, 10000) }] : []),
  };
}
export const cleanDeck = (arr) => { if (!Array.isArray(arr)) throw new Error('Expected a JSON array'); return arr.map(cleanAction); };

export function cleanConfig(o) {
  const d = defaultConfig(), out = { version: 2, override: HOSTS.includes(o?.override) ? o.override : null, profiles: {} };
  for (const h of HOSTS) {
    const p = o?.profiles?.[h], dp = d.profiles[h];
    const pages = Array.isArray(p?.pages) ? p.pages.map((pg, i) => ({ name: String(pg?.name ?? 'Page ' + (i + 1)).slice(0, 20), buttons: cleanDeck(pg?.buttons ?? []) })) : [];
    const gestures = {};
    for (const [k] of GESTURES) gestures[k] = p?.gestures?.[k] ? cleanAction(p.gestures[k]) : dp.gestures[k];
    out.profiles[h] = { pages: pages.length ? pages : dp.pages, gestures };
  }
  return out;
}

// Accepts the v2 object, or the old single-deck array (replaces `host`'s pages with one page).
export function importAny(data, cfg, host) {
  if (Array.isArray(data)) {
    const next = structuredClone(cfg);
    next.profiles[host].pages = [{ name: 'Imported', buttons: cleanDeck(data) }];
    return next;
  }
  if (data && typeof data === 'object' && data.version >= 2) return cleanConfig(data);
  throw new Error('Unrecognised JSON (need version 2 object or a deck array)');
}
export function migrate(oldDeck) {
  const c = defaultConfig();
  if (Array.isArray(oldDeck)) c.profiles.Mac.pages[0].buttons = cleanDeck(oldDeck);
  return c;
}

// n = fingers (3 or 4); dx,dy = centroid travel in px; dt in ms.
export function classifyMulti(n, dx, dy, dt) {
  const d = Math.hypot(dx, dy);
  if (n === 3 && d < 12 && dt < 300) return 'tap3';
  if (d < 50 || (n !== 3 && n !== 4)) return null;
  if (Math.abs(dx) > Math.abs(dy)) return n === 3 ? (dx < 0 ? 'swipe3L' : 'swipe3R') : null;
  return `swipe${n}${dy < 0 ? 'U' : 'D'}`;
}
// d0/d1 = finger distance at start/end, travel = centroid movement.
export function classifyPinch(d0, d1, travel) {
  const dd = d1 - d0;
  return Math.abs(dd) > 40 && travel < Math.abs(dd) ? (dd < 0 ? 'pinchIn' : 'pinchOut') : null;
}
