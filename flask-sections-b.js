// Flask sections, part B: combos, macros, adaptive keys.
import { h } from './dom.js';
import * as K from './keymap-core.js';
import { set, row, slider, toggle, stepper, select, outputButton, keySelect, positionBoard, ui } from './flask-ui.js';
import { CH_ZMK, V } from './vendor/flask/flaskproto.js';
import {
  decodeComboSlotV2, decodeComboSlotV3, encodeComboSlotV2, encodeComboSlotV3, comboSlotV2IsEmpty, findDuplicateCombo, COMBO_ACTION,
} from './vendor/flask/zmk-combos-codec.js';
import { decodeMacroStep, encodeMacroStep, MACRO_ACTION, MACRO_ACTION_LABELS, macroLiveSteps } from './vendor/flask/zmk-macros-codec.js';
import {
  decodeAkRule, encodeAkRule, decodeAkStep, encodeAkStep, decodeAkFallback, encodeAkFallback, akRuleIsEmpty, akSeqLength, textToUsages, usagesToText, AK_ACTION,
} from './vendor/flask/zmk-adaptive-codec.js';
import { usageCap } from './vendor/flask/zmk-keycodes.js';
import { TRIGGER_MODS } from './vendor/flask/zmk-csk-codec.js';

const kp = (id, mods = 0) => (((7 << 16) | id) | (mods << 24)) >>> 0;
const same = (a, b) => ['action', 'behaviorId', 'param1', 'param2'].every((k) => (a[k] ?? 0) === (b[k] ?? 0));

// ---------------------------------------------------------------- combos
export async function combos(body, F) {
  const flask = F.flask, ch = CH_ZMK.combos, caps = F.caps;
  if (!caps.combosTyped) { body.append(h('p', { className: 'hint', textContent: 'This firmware only has usage-only combos; update it to edit combos from the phone.' })); return; }
  let enabled = await flask.getU16(ch, V.combosEnabled), timeout = await flask.getU16(ch, V.combosTimeout);
  const n = await flask.getU16(ch, V.combosSlotCount);
  const keys = caps.combosKeys ? (await flask.getU16(ch, V.combosKeys)) || 4 : 4;
  const timed = caps.combosTimed, id = timed ? V.combosSlotV3 : V.combosSlotV2;
  const dec = (b) => (timed ? decodeComboSlotV3(b, keys) : decodeComboSlotV2(b, keys));
  const enc = (i, s) => (timed ? encodeComboSlotV3(i, s, keys) : encodeComboSlotV2(i, s, keys));
  const slots = [];
  for (let i = 0; i < n; i++) { F.progress(`Reading combos ${i + 1}/${n}`); slots.push(dec(await flask.getBytes(ch, id, [i], 1))); }
  F.progress('');
  const base = F.studio?.keymap?.layers?.[0]?.bindings;
  const posLabel = (p) => { if (!base) return `${p}`; const l = K.legend(base[p]); return l.main.slice(0, 3); };
  const write = async (i, s) => {
    if (!comboSlotV2IsEmpty(s)) { const dup = findDuplicateCombo(slots, i, s.positions); if (dup) throw new Error(`Same keys as combo ${dup.index}. Two combos on one key set freeze the board.`); }
    slots[i] = dec(await flask.setBytes(ch, id, enc(i, s), 1)); F.dirty(ch, 'Combos');
  };
  const list = h('div', { className: 'fl-list' });
  const text = (s) => `${s.positions.map(posLabel).join(' + ')} → ${K.describe({ action: s.action, behaviorId: s.behaviorId, param1: s.param1, param2: s.param2 }, 'zmk-typed')}`;
  const edit = (i) => {
    const d = { ...slots[i], positions: [...slots[i].positions] };
    if (comboSlotV2IsEmpty(slots[i]) && !d.layer) d.layer = 0xff;
    const card = h('div', { className: 'card' });
    const draw = () => set(card, 
      row(`Combo ${i}`),
      h('p', { className: 'hint', textContent: `Tap ${keys > 2 ? '2 to ' + keys : 'the'} keys that must be pressed together.` }),
      positionBoard({ selected: d.positions, max: keys, labelOf: posLabel, onChange: (p) => { d.positions = p; } }),
      row('Output', outputButton(d, `Combo ${i} output`, async (v) => { Object.assign(d, v); draw(); })),
      timed ? row('Window', stepper({ value: d.timeoutMs ?? 0, min: 0, max: 500, step: 10, fmt: (v) => (v ? `${v} ms` : 'global'), onchange: async (v) => { d.timeoutMs = v; return v; } })) : null,
      timed ? row('Prior idle', stepper({ value: d.priorIdleMs ?? 0, min: 0, max: 500, step: 10, fmt: (v) => (v ? `${v} ms` : 'off'), onchange: async (v) => { d.priorIdleMs = v; return v; } })) : null,
      h('div', { className: 'row' },
        h('button', { className: 'primary grow', textContent: 'Write combo', onclick: async () => { try { await write(i, d); fill(); } catch (e) { ui.report(e.message); } } }),
        h('button', { className: 'grow', textContent: 'Delete', onclick: async () => { try { await write(i, { positions: [], action: 0, behaviorId: 0, param1: 0, param2: 0, layer: 0xff }); fill(); } catch (e) { ui.report(e.message); } } }),
        h('button', { className: 'grow', textContent: 'Back', onclick: fill })));
    draw(); set(list, card);
  };
  const fill = () => set(list, 
    ...slots.map((s, i) => (comboSlotV2IsEmpty(s) ? null : h('button', { className: 'card btnrow', onclick: () => edit(i) }, h('b', { textContent: `Combo ${i}` }), h('span', { textContent: text(s) })))).filter(Boolean),
    h('button', { className: 'small', textContent: '+ New combo', onclick: () => { const i = slots.findIndex(comboSlotV2IsEmpty); if (i < 0) ui.report('All combo slots are used.'); else edit(i); } }));
  fill();
  body.append(row('Enabled', toggle(enabled ? 'On' : 'Off', !!enabled, async (on) => { enabled = await flask.setU16(ch, V.combosEnabled, on ? 1 : 0); F.dirty(ch, 'Combos'); return !!enabled; })),
    row('Press window', slider({ min: 10, max: 200, step: 5, value: timeout, fmt: (v) => `${v} ms`, onchange: async (v) => { timeout = await flask.setU16(ch, V.combosTimeout, v); F.dirty(ch, 'Combos'); return timeout; } })), list);
}

// ---------------------------------------------------------------- macros
const ACTIONS = [MACRO_ACTION.tap, MACRO_ACTION.press, MACRO_ACTION.release, MACRO_ACTION.wait];
export async function macros(body, F) {
  const flask = F.flask, ch = CH_ZMK.macros;
  let enabled = await flask.getU16(ch, V.macrosEnabled), tapMs = await flask.getU16(ch, V.macrosTapMs), waitMs = await flask.getU16(ch, V.macrosWaitMs);
  const n = await flask.getU16(ch, V.macrosSlotCount), cap = await flask.getU16(ch, V.macrosStepCount);
  const readSlot = async (m) => {
    const out = [];
    for (let s = 0; s < cap; s++) { const d = decodeMacroStep(await flask.getBytes(ch, V.macrosStep, [m, s], 2)); if (d.action === MACRO_ACTION.empty) break; out.push({ action: d.action, param: d.param }); }
    return out;
  };
  const slots = [];
  for (let m = 0; m < n; m++) { F.progress(`Reading macros ${m + 1}/${n}`); slots.push(await readSlot(m)); }
  F.progress('');
  const label = (st) => (st.action === MACRO_ACTION.wait ? `wait ${st.param} ms` : `${MACRO_ACTION_LABELS[st.action]} ${usageCap(st.param)}`);
  const summary = (steps) => {
    if (!steps.length) return 'empty';
    const t = usagesToText(steps.filter((s) => s.action === MACRO_ACTION.tap).map((s) => s.param));
    return t != null && steps.every((s) => s.action === MACRO_ACTION.tap) ? `types "${t}"` : macroLiveSteps(steps).map(label).join(', ');
  };
  const list = h('div', { className: 'fl-list' });
  const saveSteps = async (m, steps) => {
    const live = steps.slice(0, cap);
    for (let s = 0; s < live.length; s++) await flask.setBytes(ch, V.macrosStep, encodeMacroStep(m, s, live[s]), 2);
    if (live.length < cap) await flask.setBytes(ch, V.macrosStep, encodeMacroStep(m, live.length, { action: MACRO_ACTION.empty }), 2);
    slots[m] = await readSlot(m); F.dirty(ch, 'Macros');
  };
  const edit = (m) => {
    const d = slots[m].map((x) => ({ ...x }));
    const card = h('div', { className: 'card' });
    const draw = () => set(card, 
      row(`Macro ${m}  (${d.length}/${cap} steps)`),
      ...d.map((st, i) => h('div', { className: 'step' },
        h('div', { className: 'row' },
          select(ACTIONS.map((a) => [a, MACRO_ACTION_LABELS[a]]), st.action, (v) => { st.action = +v; st.param = st.action === MACRO_ACTION.wait ? 100 : kp(0x04); draw(); }),
          st.action === MACRO_ACTION.wait
            ? stepper({ value: st.param, min: 10, max: 5000, step: 10, fmt: (v) => `${v} ms`, onchange: async (v) => { st.param = v; return v; } })
            : keySelect(st.param & 0xffff, (c) => { st.param = kp(c, st.param >>> 24); }),
          h('button', { className: 'small', textContent: 'Del', onclick: () => { d.splice(i, 1); draw(); } })))),
      h('div', { className: 'row' },
        h('button', { className: 'small', textContent: '+ Tap', onclick: () => { if (d.length < cap) { d.push({ action: MACRO_ACTION.tap, param: kp(0x04) }); draw(); } } }),
        h('button', { className: 'small', textContent: '+ Wait', onclick: () => { if (d.length < cap) { d.push({ action: MACRO_ACTION.wait, param: 100 }); draw(); } } })),
      row('Type text', h('input', { placeholder: 'e.g. hello', onchange: (e) => { const u = textToUsages(e.target.value); if (!u) { ui.report('Printable ASCII only.'); return; } d.splice(0, d.length, ...u.slice(0, cap).map((param) => ({ action: MACRO_ACTION.tap, param }))); draw(); } })),
      h('div', { className: 'row' },
        h('button', { className: 'primary grow', textContent: 'Write macro', onclick: async () => { try { await saveSteps(m, d); fill(); } catch (e) { ui.report(e.message); } } }),
        h('button', { className: 'grow', textContent: 'Play', onclick: async () => { try { await flask.setU16(ch, V.macrosState, m + 1); } catch (e) { ui.report(e.message); } } }),
        h('button', { className: 'grow', textContent: 'Back', onclick: fill })));
    draw(); set(list, card);
  };
  const fill = () => set(list, ...slots.map((st, m) => h('button', { className: 'card btnrow', onclick: () => edit(m) }, h('b', { textContent: `Macro ${m}` }), h('span', { textContent: summary(st) }))));
  fill();
  body.append(h('p', { className: 'hint', textContent: 'Key sequences you can put on a key (Keymap tab, Macro). Edits are written when you tap Write macro.' }),
    row('Enabled', toggle(enabled ? 'On' : 'Off', !!enabled, async (on) => { enabled = await flask.setU16(ch, V.macrosEnabled, on ? 1 : 0); F.dirty(ch, 'Macros'); return !!enabled; })),
    row('Tap length', slider({ min: 5, max: 200, step: 5, value: tapMs, fmt: (v) => `${v} ms`, onchange: async (v) => { tapMs = await flask.setU16(ch, V.macrosTapMs, v); F.dirty(ch, 'Macros'); return tapMs; } })),
    row('Wait between', slider({ min: 5, max: 200, step: 5, value: waitMs, fmt: (v) => `${v} ms`, onchange: async (v) => { waitMs = await flask.setU16(ch, V.macrosWaitMs, v); F.dirty(ch, 'Macros'); return waitMs; } })), list);
}

// ---------------------------------------------------------------- adaptive keys
export async function adaptive(body, F) {
  const flask = F.flask, ch = CH_ZMK.adaptive;
  let enabled = await flask.getU16(ch, V.akEnabled);
  const sets = await flask.getU16(ch, V.akSetCount), nRules = await flask.getU16(ch, V.akRuleCount), nSteps = (await flask.getU16(ch, V.akStepCount)) || 6;
  const out = (d) => ({ action: d.action, behaviorId: d.behaviorId, param1: d.param1, param2: d.param2 });
  const rules = [];
  for (let i = 0; i < nRules; i++) {
    F.progress(`Reading adaptive keys ${i + 1}/${nRules}`);
    const r = { ...decodeAkRule(await flask.getBytes(ch, V.akRule, [i], 1)), index: i, steps: [] };
    for (let s = 0; s < nSteps && r.trigger; s++) { const o = out(decodeAkStep(await flask.getBytes(ch, V.akStep, [i, s], 2))); r.steps.push(o); if (!o.action) break; }
    rules.push(r);
  }
  const fall = [];
  for (let st = 0; st < sets; st++) fall.push(out(decodeAkFallback(await flask.getBytes(ch, V.akFallback, [st], 1))));
  F.progress('');
  const stepsText = (steps) => { const n = akSeqLength(steps), t = usagesToText(steps.slice(0, n)); return t ?? steps.slice(0, n).map((o) => K.describe(o, 'zmk-typed')).join(', '); };
  const trigText = (r) => { const m = r.trigger >>> 24; return `${TRIGGER_MODS.filter((t) => m & t.bit).map((t) => t.glyph).join('')}${usageCap(((7 << 16) | (r.trigger & 0xffff)) >>> 0)}`; };
  const list = h('div', { className: 'fl-list' });
  const writeRule = async (i, d) => {
    const want = Array.from({ length: nSteps }, (_, k) => d.steps[k] ?? { action: 0, behaviorId: 0, param1: 0, param2: 0 });
    for (let s = 0; s < nSteps; s++) {
      const cur = rules[i].steps[s];
      if (cur && same(cur, want[s])) continue;
      await flask.setBytes(ch, V.akStep, encodeAkStep(i, s, want[s]), 2); // steps first, so the rule goes live complete
    }
    const echo = decodeAkRule(await flask.setBytes(ch, V.akRule, encodeAkRule(i, d), 1));
    rules[i] = { ...echo, index: i, steps: want.slice(0, akSeqLength(want) + 1) }; F.dirty(ch, 'Adaptive keys');
  };
  const edit = (i) => {
    const r = rules[i], d = { set: r.set, trigger: r.trigger || kp(0x04), maxIdleMs: r.maxIdleMs || 300, strict: r.strict, skip: r.skip, steps: r.steps.map((x) => ({ ...x })) };
    const card = h('div', { className: 'card' });
    const draw = () => set(card, 
      row(`Rule ${i}`),
      row('When I type', keySelect(d.trigger & 0xffff, (c) => { d.trigger = kp(c, d.trigger >>> 24); })),
      row('With', h('div', { className: 'chips' }, ...TRIGGER_MODS.map((t) => toggle(t.glyph, !!((d.trigger >>> 24) & t.bit), async (on) => { const m = (d.trigger >>> 24) & ~t.bit | (on ? t.bit : 0); d.trigger = kp(d.trigger & 0xffff, m); return on; })))),
      row('After a key', select(Array.from({ length: sets }, (_, s) => [s, `set ${s}`]), d.set, (v) => { d.set = +v; })),
      row('Within', stepper({ value: d.maxIdleMs, min: 0, max: 2000, step: 50, fmt: (v) => (v ? `${v} ms` : 'any time'), onchange: async (v) => { d.maxIdleMs = v; return v; } })),
      row('Match', h('div', { className: 'chips' }, toggle('Exact mods', !!d.strict, async (on) => { d.strict = on; return on; }), toggle('Skip last key', !!d.skip, async (on) => { d.skip = on; return on; }))),
      ...Array.from({ length: Math.min(nSteps, akSeqLength(d.steps) + 1) }, (_, s) => row(`Output ${s + 1}`, outputButton(d.steps[s] ?? { action: 0 }, `Rule ${i} · output ${s + 1}`, async (v) => { d.steps[s] = v; draw(); }))),
      row('Type text', h('input', { placeholder: 'replace outputs with text', onchange: (e) => { const u = textToUsages(e.target.value); if (!u) { ui.report('Printable ASCII only.'); return; } d.steps = u.slice(0, nSteps).map((param1) => ({ action: AK_ACTION.usage, behaviorId: 0, param1, param2: 0 })); draw(); } })),
      h('div', { className: 'row' },
        h('button', { className: 'primary grow', textContent: 'Write rule', onclick: async () => { try { await writeRule(i, d); fill(); } catch (e) { ui.report(e.message); } } }),
        h('button', { className: 'grow', textContent: 'Delete', onclick: async () => { try { await writeRule(i, { set: 0, trigger: 0, maxIdleMs: 0, strict: false, skip: false, steps: [] }); fill(); } catch (e) { ui.report(e.message); } } }),
        h('button', { className: 'grow', textContent: 'Back', onclick: fill })));
    draw(); set(list, card);
  };
  const fill = () => set(list, 
    ...rules.map((r, i) => (akRuleIsEmpty(r) ? null : h('button', { className: 'card btnrow', onclick: () => edit(i) }, h('b', { textContent: `${trigText(r)} → ${stepsText(r.steps)}` }), h('span', { textContent: `set ${r.set}${r.maxIdleMs ? `, within ${r.maxIdleMs} ms` : ''}` })))).filter(Boolean),
    h('button', { className: 'small', textContent: '+ New rule', onclick: () => { const i = rules.findIndex(akRuleIsEmpty); if (i < 0) ui.report('All rule slots are used.'); else edit(i); } }),
    h('h4', { textContent: 'Fallback when no rule matches' }),
    ...fall.map((o, st) => row(`Set ${st}`, outputButton(o, `Fallback · set ${st}`, async (v) => { const echo = out(decodeAkFallback(await flask.setBytes(ch, V.akFallback, encodeAkFallback(st, v), 1))); fall[st] = echo; F.dirty(ch, 'Adaptive keys'); fill(); }))));
  fill();
  body.append(h('p', { className: 'hint', textContent: 'A key that types something different depending on the key before it. Put one on a key with the Keymap tab (Adaptive).' }),
    row('Enabled', toggle(enabled ? 'On' : 'Off', !!enabled, async (on) => { enabled = await flask.setU16(ch, V.akEnabled, on ? 1 : 0); F.dirty(ch, 'Adaptive keys'); return !!enabled; })), list);
}
