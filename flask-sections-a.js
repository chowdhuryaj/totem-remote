// Flask sections, part A: hold-tap timing, auto shift, custom shift, tap dance.
// Each build(body, F) reads from the device, draws phone controls, and writes through the vendored Flask codecs.
// Writes are live; F.dirty(channel, label) records that "Save to keyboard" (flask.save) is pending, as Totem-Flask's save bar does.
import { h } from './dom.js';
import * as K from './keymap-core.js';
import { set, row, slider, toggle, stepper, select, outputButton, keySelect, ui } from './flask-ui.js';
import { holdtapBackend } from './vendor/flask/behavior-catalog.js';
import { HOLDTAP_FLAVORS, HOLDTAP_TERM, decodeHoldtapSlot, encodeHoldtapSlot, clampTerm } from './vendor/flask/zmk-holdtap-codec.js';
import { ASH_GROUPS, ASH_TIMEOUT, ASH_RETRO_LIMIT, clampAshTimeout, clampRetroLimit } from './vendor/flask/zmk-autoshift-codec.js';
import { CH_ZMK, V } from './vendor/flask/flaskproto.js';
import { decodeCskSlot, encodeCskSlot, cskSlotIsEmpty, cskSummary, cskMorphCaps, cskOskCaps, cskOsMode, TRIGGER_MODS, OS_NAMES, OS_ANY } from './vendor/flask/zmk-csk-codec.js';
import { usageCap } from './vendor/flask/zmk-keycodes.js';
import {
  readAllTdSlots, writeTdStep, writeTdTerm, writeTdPriorIdle, writeTdRelease, writeTdEager, clearTdSlot, tdV2, tdV3, noOut,
} from './vendor/flask/zmk-tapdance-io.js';
import { tdDanceLength } from './vendor/flask/zmk-tapdance-codec.js';

const FLAVORS = ['Hold-preferred', 'Balanced', 'Tap-preferred', 'Tap unless interrupted'];
const kp = (id, mods = 0) => (((7 << 16) | id) | (mods << 24)) >>> 0;

// ---------------------------------------------------------------- hold-tap
export async function holdtap(body, F) {
  const ch = 0x2a, flask = F.flask;
  const count = await flask.getU16(ch, 0x01);
  const be = holdtapBackend(flask, { slotCount: count, onDirty: () => F.dirty(ch, 'Hold-tap timing') });
  const rows = [];
  for (let i = 0; i < count; i++) {
    F.progress(`Reading hold-taps ${i + 1}/${count}`);
    const info = await be.slotInfo(i);
    rows.push({ info, s: await be.readSlot(i) });
  }
  F.progress('');
  const base = F.studio?.keymap?.layers?.[0]?.bindings;
  const legendOf = (info) => { if (!base || info.keyPos == null) return ''; const l = K.legend(base[info.keyPos]); return `${l.top ? l.top + ' ' : ''}${l.main}`.replace(/ · .*?(?= |$)/g, ''); };
  let showAll = false;
  const wanted = (r) => showAll || r.s.custom || r.info.kind === 'virtual' || /^(Mod-tap|LT)/.test(base ? K.legend(base[r.info.keyPos]).top : '');
  const list = h('div', { className: 'fl-list' });
  const all = h('div');
  const putSlot = async (r, patch) => {
    const next = { ...(await be.readSlot(r.info.slot)), ...patch };
    const echo = decodeHoldtapSlot(await flask.setBytes(ch, 0x50, encodeHoldtapSlot(next), 1));
    r.s = await be.readSlot(echo.slot); F.dirty(ch, 'Hold-tap timing');
    return r.s;
  };
  const rowEl = (r) => h('div', { className: 'card' },
    row(r.info.kind === 'virtual' ? (r.info.name || `Slot ${r.info.slot}`) : `Key ${r.info.keyPos}  ${legendOf(r.info)}`,
      r.s.custom ? h('span', { className: 'chip', textContent: 'edited' }) : null),
    slider({ min: HOLDTAP_TERM.min, max: HOLDTAP_TERM.max, step: 10, value: r.s.term, fmt: (v) => `${v} ms`, onchange: async (v) => { r.s.term = await be.write(r.info.slot, clampTerm(v)); return r.s.term; } }),
    h('details', {}, h('summary', { textContent: 'Flavor, quick-tap, prior idle' }),
      row('Flavor', select(FLAVORS.map((t, i) => [i, t]), r.s.flavor, async (v) => { await putSlot(r, { flavor: +v }); })),
      row('Quick-tap', stepper({ value: r.s.quick, min: 0, max: 1000, step: 10, fmt: (v) => v ? `${v} ms` : 'off', onchange: async (v) => (await putSlot(r, { quick: v })).quick })),
      row('Prior idle', stepper({ value: r.s.idle, min: 0, max: 1000, step: 10, fmt: (v) => v ? `${v} ms` : 'off', onchange: async (v) => (await putSlot(r, { idle: v })).idle })),
      h('button', { className: 'small', textContent: 'Reset to compiled default', onclick: async () => { await be.reset(r.info.slot); r.s = await be.readSlot(r.info.slot); fill(); } })));
  const fill = () => {
    const shown = rows.filter(wanted);
    const vis = shown.length ? shown : rows;
    set(list, ...vis.map(rowEl));
    all.replaceChildren(
      h('div', { className: 'card' }, row(`All shown keys (${vis.filter((r) => r.info.kind === 'key').length})`),
        slider({ min: HOLDTAP_TERM.min, max: HOLDTAP_TERM.max, step: 10, value: 200, fmt: (v) => `${v} ms`,
          onchange: async (v) => { for (const r of vis) if (r.info.kind === 'key') r.s.term = await be.write(r.info.slot, clampTerm(v)); fill(); return v; } })),
      h('button', { className: 'small', textContent: showAll ? 'Hide unedited keys' : 'Show all keys', onclick: () => { showAll = !showAll; fill(); } }));
  };
  fill();
  body.append(h('p', { className: 'hint', textContent: 'How long a hold-tap waits before it counts as a hold. Values apply from the next press. Save writes them to flash.' }), all, list);
}

// ---------------------------------------------------------------- auto shift
const ASH_IDS = { enabled: V.ashEnabled, timeout: V.ashTimeout, groups: V.ashGroups, modifiers: V.ashModifiers, repeat: V.ashRepeat, noAutoRepeat: V.ashNoAutoRepeat, retro: V.ashRetro, retroLimit: V.ashRetroLimit };
export async function autoshift(body, F) {
  const v = {};
  for (const [k, id] of Object.entries(ASH_IDS)) v[k] = await F.flask.getU16(CH_ZMK.autoShift, id);
  const put = async (k, val) => { v[k] = await F.flask.setU16(CH_ZMK.autoShift, ASH_IDS[k], val); F.dirty(CH_ZMK.autoShift, 'Auto shift'); return v[k]; };
  const flag = (label, k) => toggle(label, !!v[k], async (on) => !!(await put(k, on ? 1 : 0)));
  body.append(
    h('p', { className: 'hint', textContent: 'Hold a key slightly longer to get its shifted symbol.' }),
    row('Auto shift', flag(v.enabled ? 'On' : 'Off', 'enabled')),
    row('Hold time', slider({ min: ASH_TIMEOUT.min, max: ASH_TIMEOUT.max, step: 5, value: v.timeout, fmt: (x) => `${x} ms`, onchange: (x) => put('timeout', clampAshTimeout(x)) })),
    row('Keys', h('div', { className: 'chips' }, ...Object.entries(ASH_GROUPS).map(([name, bit]) => toggle(name, !!(v.groups & bit), async (on) => { const g = await put('groups', on ? v.groups | bit : v.groups & ~bit); return !!(g & bit); })))),
    row('Also modifiers', flag('Modifiers', 'modifiers')), row('Repeat', flag('Repeat', 'repeat')), row('No auto-repeat', flag('No auto-repeat', 'noAutoRepeat')),
    row('Retro shift', flag('Retro', 'retro')),
    row('Retro window', slider({ min: 0, max: ASH_RETRO_LIMIT.max, step: 50, value: v.retroLimit, fmt: (x) => (x ? `${x} ms` : 'no limit'), onchange: (x) => put('retroLimit', clampRetroLimit(x)) })));
}

// ---------------------------------------------------------------- custom shift (mod morph)
export async function customShift(body, F) {
  const flask = F.flask, ch = CH_ZMK.customShift;
  const morph = await cskMorphCaps(flask), osk = morph && await cskOskCaps(flask), osMode = osk ? await cskOsMode(flask) : null;
  let enabled = await flask.getU16(ch, V.cskEnabled);
  const n = await flask.getU16(ch, V.cskSlotCount);
  const slots = [];
  for (let i = 0; i < n; i++) slots.push(decodeCskSlot(await flask.getBytes(ch, V.cskSlot, [i], 1)));
  const list = h('div', { className: 'fl-list' });
  const write = async (i, s) => { slots[i] = decodeCskSlot(await flask.setBytes(ch, V.cskSlot, encodeCskSlot(i, s), 1)); F.dirty(ch, 'Custom shift'); };
  const edit = (i) => {
    const d = { ...slots[i] }; if (cskSlotIsEmpty(d)) { d.base = kp(0x37); d.shifted = kp(0x38); d.mods = 2; }
    const id = (u) => u & 0xffff, mods = (u) => u >>> 24;
    const card = h('div', { className: 'card' });
    const draw = () => set(card, 
      row(`Slot ${i}`),
      row('When I press', keySelect(id(d.base), (c) => { d.base = kp(c); })),
      row('With held', h('div', { className: 'chips' }, ...TRIGGER_MODS.map((t) => toggle(t.glyph + ' ' + t.name, !!(d.mods & t.bit), async (on) => { d.mods = on ? d.mods | t.bit : d.mods & ~t.bit; if (!d.mods) d.mods = 2; return !!(d.mods & t.bit); })))),
      row('Send', keySelect(id(d.shifted), (c) => { d.shifted = kp(c, mods(d.shifted)); })),
      row('With', h('div', { className: 'chips' }, ...TRIGGER_MODS.map((t) => toggle(t.glyph, !!(mods(d.shifted) & t.bit), async (on) => { d.shifted = kp(id(d.shifted), on ? mods(d.shifted) | t.bit : mods(d.shifted) & ~t.bit); return on; })))),
      morph ? row('Keep held mods', toggle(d.keep ? 'Keep' : 'Drop', !!d.keep, async (on) => { d.keep = on; return on; })) : null,
      osk ? row('Only on', select([[0, 'Any OS'], [1, 'Mac'], [2, 'Windows']], d.os ?? 0, (x) => { d.os = +x; })) : null,
      h('div', { className: 'row' },
        h('button', { className: 'primary grow', textContent: 'Write slot', onclick: async () => { try { await write(i, d); fill(); } catch (e) { ui.report(e.message); } } }),
        h('button', { className: 'grow', textContent: 'Clear', onclick: async () => { try { await write(i, { base: 0, shifted: 0 }); fill(); } catch (e) { ui.report(e.message); } } })));
    draw(); set(list, card);
  };
  const fill = () => set(list, 
    ...slots.map((s, i) => (cskSlotIsEmpty(s) ? null : h('button', { className: 'card btnrow', onclick: () => edit(i) }, h('b', { textContent: `Slot ${i}` }), h('span', { textContent: cskSummary(s, usageCap) })))).filter(Boolean),
    h('button', { className: 'small', textContent: '+ New', onclick: () => { const i = slots.findIndex(cskSlotIsEmpty); if (i < 0) ui.report('All slots are used.'); else edit(i); } }));
  fill();
  body.append(h('p', { className: 'hint', textContent: osMode ? `Keyboard is in ${OS_NAMES[osMode]} mode.` : 'Swap a key for another when held with modifiers (like Shift + . = ?).' }),
    row('Enabled', toggle(enabled ? 'On' : 'Off', !!enabled, async (on) => { enabled = await flask.setU16(ch, V.cskEnabled, on ? 1 : 0); F.dirty(ch, 'Custom shift'); return !!enabled; })), list);
}

// ---------------------------------------------------------------- tap dance
export async function tapDance(body, F) {
  const app = F.app, flask = F.flask, ch = CH_ZMK.tapDance;
  let enabled = await flask.getU16(ch, V.tdEnabled);
  F.progress('Reading tap dances…');
  let slots = await readAllTdSlots(app);
  F.progress('');
  const d = () => F.dirty(ch, 'Tap dance');
  const list = h('div', { className: 'fl-list' });
  const summary = (s) => { const n = tdDanceLength(s.taps); return n ? s.taps.slice(0, n).map((o) => K.describe({ action: o.action, behaviorId: o.behaviorId, param1: o.param1, param2: o.param2 }, 'zmk-typed')).join(' / ') : 'empty'; };
  const editor = (s) => {
    const card = h('div', { className: 'card' });
    const draw = () => {
      const len = tdDanceLength(s.taps);
      set(card, 
        row(`Dance ${s.slot}`),
        row('Tap window', slider({ min: 0, max: 600, step: 10, value: s.termMs, fmt: (v) => (v ? `${v} ms` : 'default'), onchange: async (v) => { await writeTdTerm(app, s, v); d(); return s.termMs; } })),
        ...s.taps.map((o, t) => (t > len ? null : row(`${t + 1}× tap`,
          outputButton(o, `Dance ${s.slot} · ${t + 1} tap${t ? 's' : ''}`, async (v) => { await writeTdStep(app, s, t, false, v); d(); draw(); }),
          tdV2(app) ? outputButton(s.holds[t], `Dance ${s.slot} · hold on ${t + 1}`, async (v) => { await writeTdStep(app, s, t, true, v); d(); draw(); }) : null))),
        tdV3(app) ? row('Instant', toggle(s.eager ? 'On' : 'Off', !!s.eager, async (on) => { await writeTdEager(app, s, on); d(); return s.eager; })) : null,
        tdV3(app) ? row('After release', stepper({ value: s.releaseMs, min: 0, max: 1000, step: 10, fmt: (v) => (v ? `${v} ms` : 'off'), onchange: async (v) => { await writeTdRelease(app, s, v); d(); return s.releaseMs; } })) : null,
        tdV2(app) ? row('Prior idle', stepper({ value: s.priorIdleMs, min: 0, max: 1000, step: 10, fmt: (v) => (v ? `${v} ms` : 'off'), onchange: async (v) => { await writeTdPriorIdle(app, s, v); d(); return s.priorIdleMs; } })) : null,
        h('div', { className: 'row' },
          h('button', { className: 'grow', textContent: 'Clear dance', onclick: async () => { try { await clearTdSlot(app, s); d(); draw(); } catch (e) { ui.report(e.message); } } }),
          h('button', { className: 'grow', textContent: 'Back', onclick: fill })));
    };
    draw(); set(list, card);
  };
  const fill = () => set(list, ...slots.map((s) => h('button', { className: 'card btnrow', onclick: () => editor(s) }, h('b', { textContent: `Dance ${s.slot}` }), h('span', { textContent: summary(s) }))));
  fill();
  body.append(h('p', { className: 'hint', textContent: 'Different output per tap count. Put one on a key with the Keymap tab (Tap dance).' }),
    row('Enabled', toggle(enabled ? 'On' : 'Off', !!enabled, async (on) => { enabled = await flask.setU16(ch, V.tdEnabled, on ? 1 : 0); d(); return !!enabled; })), list);
}
