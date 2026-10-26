import * as P from './protocol.js';
import { KEY_GROUPS, DEFAULT_DECK, asciiKey, keyLabel } from './keys.js';

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k.startsWith('on') ? e.addEventListener(k.slice(2), v) : k in e ? (e[k] = v) : e.setAttribute(k, v);
  e.append(...kids.flat().filter((x) => x != null));
  return e;
}

// ---------- link (BLE or demo) and serialized writes ----------
let link = null, status = null, textFree = 0, textBuf = '';
let wasConnected = false, device = null, userDisc = false, running = false;
let tail = Promise.resolve(), inflight = 0;

function setState(msg, cls = '') { const s = $('#state'); s.textContent = msg; s.className = cls; }
function log(kind, bytes) {
  const el = $('#log'); el.append(`${kind.padEnd(7)}${hex(bytes)}\n`);
  while (el.childNodes.length > 300) el.firstChild.remove();
  el.scrollTop = el.scrollHeight;
}

// GATT allows one operation at a time, so every op (write or read) is chained. Never rejects.
function run(fn) {
  inflight++;
  const p = tail.then(fn);
  tail = p.then(() => {}, () => {});
  return p.then(() => true, (e) => { console.warn('op failed', e); return false; }).finally(() => { inflight--; });
}
async function tx(kind, bytes) {
  if (!link) return false;
  const ok = await run(() => link.write(kind, bytes));
  if (!ok && kind !== 'mouse') { setState('Write failed, re-reading status', 'err'); refreshStatus(); }
  return ok;
}
const refreshStatus = () => link && run(async () => onStatus(await link.read()));

function onStatus(bytes) {
  status = P.decodeStatus(bytes);
  textFree = status.textFree;
  renderStatus(); flushText();
}

function makeDemoLink() {
  let out = 1;
  const bytes = () => [1, 3, 0, 0, 2, 0x2f, out, 78, 0xff];
  return {
    kind: 'demo',
    async write(kind, b) {
      log(kind, b);
      if (kind === 'control' && b[0] === 7) { out = b[1]; setTimeout(() => onStatus(bytes()), 0); }
      if (kind === 'text') setTimeout(() => onStatus(bytes()), 20);
    },
    async read() { return bytes(); },
    disconnect() {},
  };
}

async function openBle(dev) {
  setState('Connecting...');
  const server = await dev.gatt.connect();
  const svc = await server.getPrimaryService(P.SERVICE);
  const ch = {};
  for (const k of Object.keys(P.CHARS)) ch[k] = await svc.getCharacteristic(P.CHARS[k]);
  const u8 = (dv) => new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  link = {
    kind: 'ble',
    write: (kind, b) => kind === 'mouse' ? ch.mouse.writeValueWithoutResponse(b)
      : (ch[kind].writeValueWithResponse || ch[kind].writeValue).call(ch[kind], b),
    read: async () => u8(await ch.status.readValue()),
    disconnect: () => dev.gatt.connected && dev.gatt.disconnect(),
  };
  // First action: read Status. On a fresh phone this triggers passkey pairing.
  setState('Pairing: enter the passkey shown on the dongle screen if iOS asks', '');
  onStatus(await link.read());
  await ch.status.startNotifications();
  ch.status.addEventListener('characteristicvaluechanged', (e) => { try { onStatus(u8(e.target.value)); } catch (err) { console.warn(err); } });
  afterConnect();
}

function afterConnect() {
  wasConnected = true; userDisc = false;
  setState(status.remoteEnabled ? 'Connected' : 'Connected, but remote input is OFF on the dongle', status.remoteEnabled ? 'ok' : 'err');
  startLoops();
  $('#connect').textContent = 'Disconnect';
  $('#log').hidden = link.kind !== 'demo';
}

async function connectBle() {
  if (!navigator.bluetooth) return setState('No Web Bluetooth here. Use Bluefy on iPhone or desktop Chrome.', 'err');
  try {
    device = await navigator.bluetooth.requestDevice({ filters: [{ namePrefix: 'Totem' }], optionalServices: [P.SERVICE] });
    device.addEventListener('gattserverdisconnected', onGattDisc);
    await openBle(device);
  } catch (e) { link = null; setState(String(e.message || e), 'err'); }
}

async function reconnect(tries = 3) {
  if (!device || link) return;
  for (let i = 0; i < tries && !link && !userDisc; i++) {
    try { setState('Reconnecting...'); await openBle(device); return; }
    catch (e) { link = null; await sleep(1500); }
  }
  if (!link) setState('Reconnect failed. Tap Connect.', 'err');
}

function onGattDisc() {
  if (!link || link.kind !== 'ble') return;
  link = null; stopLoops(); resetLocal(); $('#connect').textContent = 'Connect';
  $('#statusbar').hidden = true; setState('Disconnected', 'err');
  if (wasConnected && !userDisc && document.visibilityState === 'visible') reconnect();
}

async function disconnect() {
  userDisc = true; wasConnected = false;
  await releaseAll();
  link?.disconnect(); link = null; stopLoops(); status = null;
  $('#connect').textContent = 'Connect'; $('#demo').textContent = 'Demo'; $('#statusbar').hidden = true;
  setState('Not connected');
}

$('#connect').onclick = () => (link ? disconnect() : connectBle());
$('#demo').onclick = async () => {
  if (link) { const wasDemo = link.kind === 'demo'; await disconnect(); if (wasDemo) return; }
  link = makeDemoLink(); onStatus(await link.read()); afterConnect();
  $('#demo').textContent = 'Stop demo'; $('#connect').textContent = 'Disconnect';
};

// ---------- status bar ----------
function renderStatus() {
  if (!status) return;
  $('#statusbar').hidden = false;
  const o = $('#out'); o.textContent = 'Out: ' + (status.output === 2 ? 'BLE' : status.output === 1 ? 'USB' : '?');
  o.hidden = !status.hasOutput;
  $('#caps').hidden = !status.capsLock;
  const b = [];
  if (status.battLeft !== 0xff) b.push('L ' + status.battLeft + '%');
  if (status.battRight !== 0xff) b.push('R ' + status.battRight + '%');
  $('#batt').textContent = b.join('  ');
  $('#batt').hidden = !b.length;
}
$('#out').onclick = () => {
  const next = status?.output === 2 ? 1 : 2;
  tx('control', P.control.output(next)).then(() => refreshStatus());
};

// ---------- safety, timers ----------
let keepTimer = 0, watchTimer = 0;
function startLoops() {
  if (running) return; running = true; requestAnimationFrame(frame);
  watchTimer = setInterval(() => { if (textBuf) refreshStatus(); }, 700);
}
function stopLoops() { running = false; clearInterval(keepTimer); clearInterval(watchTimer); keepTimer = 0; }
function resetLocal() { m.buttons = 0; m.ev = []; m.dx = m.dy = m.wh = m.hw = 0; mods = 0; textBuf = ''; renderMods(); clearInterval(keepTimer); keepTimer = 0; }
async function releaseAll() {
  resetLocal();
  if (link) await tx('control', P.control.releaseAll());
}
async function goHidden() {
  if (!link) return;
  const l = link;
  await releaseAll();
  if (l.kind === 'ble') { link = null; stopLoops(); l.disconnect(); }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') goHidden();
  else if (wasConnected && !link && device) reconnect();
});
addEventListener('pagehide', goHidden);

// ---------- mouse ----------
const m = { buttons: 0, ev: [], dx: 0, dy: 0, wh: 0, hw: 0, last: 0 };
const clickButton = (mask) => m.ev.push([mask, 1], [mask, 0]);
const setButton = (mask, down) => m.ev.push([mask, down]);
const take = (k, lim) => { const v = Math.max(-lim, Math.min(lim, Math.trunc(m[k]))); m[k] -= v; return v; };
function frame(now) {
  if (!running) return;
  requestAnimationFrame(frame);
  if (inflight) return;
  let changed = false;
  if (m.ev.length) { const [mask, down] = m.ev.shift(); m.buttons = down ? m.buttons | mask : m.buttons & ~mask; changed = true; }
  const dx = take('dx', 32767), dy = take('dy', 32767), wheel = take('wh', 127), hwheel = take('hw', 127);
  if (dx || dy || wheel || hwheel) changed = true;
  if (!changed && !(m.buttons && now - m.last >= 250)) return;
  m.last = now;
  tx('mouse', P.encodeMouse({ buttons: m.buttons, dx, dy, wheel, hwheel }));
}

// ---------- trackpad ----------
const NOTCH = 14; // px of finger travel per scroll notch
let speed = store.get('speed', 1.5), natural = store.get('natural', true);
$('#speed').value = speed; $('#natural').checked = natural;
$('#speed').oninput = (e) => { speed = +e.target.value; store.set('speed', speed); };
$('#natural').onchange = (e) => { natural = e.target.checked; store.set('natural', natural); };
const dir = () => (natural ? 1 : -1);

const pad = $('#pad'), ptrs = new Map();
let g = null, lastTap = 0;
pad.addEventListener('pointerdown', (e) => {
  pad.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const now = performance.now();
  if (ptrs.size === 1) {
    g = { mode: 'one', t0: now, moved: 0, tapOK: true, drag: false };
    if (now - lastTap < 300) { setButton(P.BTN.left, 1); g.drag = true; } // tap, then touch and hold: drag
  } else if (g && !g.drag && ptrs.size === 2 && g.mode === 'one') {
    Object.assign(g, { mode: 'two', t0: now, moved: 0, tapOK: true });
  } else if (g && !g.drag) { g.mode = 'none'; g.tapOK = false; }
});
pad.addEventListener('pointermove', (e) => {
  const p = ptrs.get(e.pointerId); if (!p || !g) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
  const d = Math.hypot(dx, dy); g.moved += d;
  if (g.mode === 'one') {
    if (g.moved > 8) g.tapOK = false;
    const k = speed * (1 + Math.min(d, 40) * 0.04); // mild acceleration
    m.dx += dx * k; m.dy += dy * k;
  } else if (g.mode === 'two') {
    if (g.moved > 10) g.tapOK = false;
    m.wh += (dy / 2 / NOTCH) * dir(); m.hw += (dx / 2 / NOTCH) * dir();
  }
});
function padUp(e) {
  if (!ptrs.delete(e.pointerId) || !g) return;
  const now = performance.now();
  if (g.mode === 'one' && ptrs.size === 0) {
    if (g.drag) { setButton(P.BTN.left, 0); lastTap = 0; }
    else if (e.type === 'pointerup' && g.tapOK && now - g.t0 < 250) { clickButton(P.BTN.left); lastTap = now; }
  } else if (g.mode === 'two') {
    if (e.type === 'pointerup' && g.tapOK && now - g.t0 < 300) clickButton(P.BTN.right);
    g.mode = 'none';
  }
  if (ptrs.size === 0) g = null;
}
pad.addEventListener('pointerup', padUp);
pad.addEventListener('pointercancel', padUp);

const strip = $('#strip'); let sy = null;
strip.addEventListener('pointerdown', (e) => { strip.setPointerCapture(e.pointerId); sy = e.clientY; });
strip.addEventListener('pointermove', (e) => { if (sy == null) return; m.wh += ((e.clientY - sy) / NOTCH) * dir(); sy = e.clientY; });
for (const t of ['pointerup', 'pointercancel']) strip.addEventListener(t, () => { sy = null; });

// ---------- keyboard ----------
const tapKey = (mods, page, usage) => tx('key', P.encodeKey({ action: P.ACTION.TAP, mods, page, usage }));
let mods = 0;
const MODS = [['Ctrl', P.MOD.LCTRL], ['Alt', P.MOD.LALT], ['Cmd', P.MOD.LGUI], ['Shift', P.MOD.LSHIFT]];
function renderMods() { for (const b of $('#mods').children) b.classList.toggle('on', !!(mods & +b.dataset.bit)); }
function toggleMod(bit) {
  const down = !(mods & bit);
  mods = down ? mods | bit : mods & ~bit;
  tx('key', P.encodeKey({ action: down ? P.ACTION.PRESS : P.ACTION.RELEASE, mods: bit, usage: 0 }));
  if (mods && !keepTimer) keepTimer = setInterval(() => tx('control', P.control.keepalive()), 250);
  if (!mods) { clearInterval(keepTimer); keepTimer = 0; }
  renderMods();
}
$('#mods').append(...MODS.map(([n, bit]) => h('button', { textContent: n, onclick: () => toggleMod(bit) }, ) ));
[...$('#mods').children].forEach((b, i) => { b.dataset.bit = MODS[i][1]; });
const SPECIAL = [['Esc', 0x29], ['Tab', 0x2b], ['Enter', 0x28], ['Bksp', 0x2a], ['Del', 0x4c], ['Up', 0x52], ['Down', 0x51], ['Left', 0x50], ['Right', 0x4f], ['Home', 0x4a], ['End', 0x4d], ['PgUp', 0x4b], ['PgDn', 0x4e], ['Space', 0x2c]];
$('#special').append(...SPECIAL.map(([n, u]) => h('button', { textContent: n, onclick: () => tapKey(0, 7, u) })));

function typeText(s) {
  s = P.filterText(s); if (!s) return;
  if (mods) { for (const c of s) { const k = asciiKey(c); if (k) tapKey(k.shift ? P.MOD.LSHIFT : 0, 7, k.usage); } return; } // mods already held on the dongle
  textBuf += s; flushText();
}
function flushText() {
  if (!link || !textBuf) return;
  if (status && !status.hasText) { textBuf = ''; return; }
  while (textBuf && textFree > 0) {
    const n = Math.min(20, textFree, textBuf.length);
    const chunk = textBuf.slice(0, n); textBuf = textBuf.slice(n); textFree -= n;
    tx('text', P.encodeText(chunk));
  }
}

const inp = $('#hidden');
$('#kbd').onclick = () => inp.focus();
const KEYMAP = { Backspace: 0x2a, Enter: 0x28, Tab: 0x2b, Escape: 0x29, ArrowUp: 0x52, ArrowDown: 0x51, ArrowLeft: 0x50, ArrowRight: 0x4f };
inp.addEventListener('keydown', (e) => {
  if (e.key in KEYMAP && !e.metaKey && !e.ctrlKey) { e.preventDefault(); tapKey(0, 7, KEYMAP[e.key]); }
});
inp.addEventListener('beforeinput', (e) => {
  if (e.inputType === 'deleteContentBackward') { e.preventDefault(); tapKey(0, 7, 0x2a); }
  else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') { e.preventDefault(); tapKey(0, 7, 0x28); }
  else if (e.data != null && e.inputType.startsWith('insert')) { e.preventDefault(); typeText(e.data); }
});
inp.addEventListener('input', () => { const v = inp.value; inp.value = ''; if (v) typeText(v); }); // fallback for IMEs

// ---------- stream deck ----------
let deck = store.get('deck.v1', null) || structuredClone(DEFAULT_DECK), editing = false;
const saveDeck = () => store.set('deck.v1', deck);
const stepSummary = (s) => s.t === 'key' ? `${[[1, 'Ctrl'], [2, 'Shift'], [4, 'Alt'], [8, 'Cmd']].filter(([b]) => s.mods & b).map(([, n]) => n + '+').join('')}${keyLabel(s.page, s.usage)}` : s.t === 'text' ? `"${s.text}"` : `${s.ms}ms`;

function renderDeck() {
  const el = $('#deck'); el.replaceChildren(...deck.map((b, i) => h('button', {
    textContent: b.label || '(blank)', title: b.steps.map(stepSummary).join(', '),
    onclick: () => (editing ? openEditor(i) : runButton(b)),
  })));
  $('#deck-edit').classList.toggle('on', editing); $('#deck-add').hidden = !editing;
}
async function drain() { for (let i = 0; i < 200 && textBuf; i++) await sleep(30); }
async function runButton(b) {
  for (const s of b.steps) {
    if (s.t === 'key') await tapKey(s.mods, s.page, s.usage);
    else if (s.t === 'text') { typeText(s.text); await drain(); }
    else if (s.t === 'delay') await sleep(s.ms);
  }
}
$('#deck-edit').onclick = () => { editing = !editing; renderDeck(); };
$('#deck-add').onclick = () => openEditor(-1);

const editor = $('#editor');
function openEditor(idx) {
  const draft = idx >= 0 ? structuredClone(deck[idx]) : { label: '', steps: [{ t: 'key', mods: 0, page: 7, usage: 4 }] };
  const draw = () => {
    const move = (a, dlt) => { const j = a + dlt; if (j < 0 || j >= draft.steps.length) return; [draft.steps[a], draft.steps[j]] = [draft.steps[j], draft.steps[a]]; draw(); };
    editor.replaceChildren(
      h('h3', { textContent: idx >= 0 ? 'Edit button' : 'New button' }),
      h('input', { value: draft.label, placeholder: 'Label', oninput: (e) => { draft.label = e.target.value; } }),
      ...draft.steps.map((s, i) => h('div', { className: 'step' },
        h('div', { className: 'row' },
          h('select', { value: s.t, onchange: (e) => { draft.steps[i] = { key: { t: 'key', mods: 0, page: 7, usage: 4 }, text: { t: 'text', text: '' }, delay: { t: 'delay', ms: 100 } }[e.target.value]; draw(); } },
            ...['key', 'text', 'delay'].map((t) => h('option', { value: t, textContent: t, selected: t === s.t }))),
          h('button', { textContent: 'Up', onclick: () => move(i, -1) }),
          h('button', { textContent: 'Down', onclick: () => move(i, 1) }),
          h('button', { textContent: 'Del', onclick: () => { draft.steps.splice(i, 1); draw(); } })),
        s.t === 'key' ? h('div', { className: 'row' },
          ...[['Ctrl', 1], ['Shift', 2], ['Alt', 4], ['Cmd', 8]].map(([n, b]) => h('label', {}, h('input', { type: 'checkbox', checked: !!(s.mods & b), onchange: (e) => { s.mods = e.target.checked ? s.mods | b : s.mods & ~b; } }), ' ' + n)),
          h('select', { onchange: (e) => { [s.page, s.usage] = e.target.value.split(':').map(Number); } },
            ...KEY_GROUPS.map((gr) => h('optgroup', { label: gr.name }, ...gr.keys.map((k) => h('option', { value: `${k.page}:${k.usage}`, textContent: k.label, selected: k.page === s.page && k.usage === s.usage })))))) :
        s.t === 'text' ? h('input', { value: s.text, placeholder: 'Text (printable ASCII, \\n, \\t)', oninput: (e) => { s.text = P.filterText(e.target.value); } }) :
        h('input', { type: 'number', min: 0, max: 10000, value: s.ms, oninput: (e) => { s.ms = Math.max(0, Math.min(10000, +e.target.value || 0)); } }))),
      h('div', { className: 'row' },
        h('button', { textContent: '+ Step', onclick: () => { draft.steps.push({ t: 'key', mods: 0, page: 7, usage: 4 }); draw(); } }),
        idx >= 0 ? h('button', { textContent: 'Left', onclick: () => { if (idx > 0) { [deck[idx - 1], deck[idx]] = [deck[idx], deck[idx - 1]]; saveDeck(); renderDeck(); editor.close(); } } }) : null,
        idx >= 0 ? h('button', { textContent: 'Right', onclick: () => { if (idx < deck.length - 1) { [deck[idx + 1], deck[idx]] = [deck[idx], deck[idx + 1]]; saveDeck(); renderDeck(); editor.close(); } } }) : null),
      h('div', { className: 'row' },
        h('button', { className: 'primary', textContent: 'Save', onclick: () => { if (idx >= 0) deck[idx] = draft; else deck.push(draft); saveDeck(); renderDeck(); editor.close(); } }),
        idx >= 0 ? h('button', { textContent: 'Delete', onclick: () => { deck.splice(idx, 1); saveDeck(); renderDeck(); editor.close(); } }) : null,
        h('button', { textContent: 'Cancel', onclick: () => editor.close() })));
  };
  draw(); editor.showModal();
}

const jd = $('#jsond');
$('#deck-json').onclick = () => { $('#jsonta').value = JSON.stringify(deck, null, 1); $('#json-msg').textContent = ''; jd.showModal(); };
$('#json-close').onclick = () => jd.close();
$('#json-reset').onclick = () => { deck = structuredClone(DEFAULT_DECK); saveDeck(); renderDeck(); $('#jsonta').value = JSON.stringify(deck, null, 1); };
function cleanDeck(arr) {
  if (!Array.isArray(arr)) throw new Error('Expected a JSON array');
  const int = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.trunc(+v) || 0));
  return arr.map((b) => ({
    label: String(b?.label ?? '').slice(0, 40),
    steps: (Array.isArray(b?.steps) ? b.steps : []).flatMap((s) =>
      s?.t === 'key' ? [{ t: 'key', mods: int(s.mods, 0, 255), page: s.page === 0x0c ? 0x0c : 7, usage: int(s.usage, 0, 0xffff) }]
      : s?.t === 'text' ? [{ t: 'text', text: P.filterText(s.text ?? '') }]
      : s?.t === 'delay' ? [{ t: 'delay', ms: int(s.ms, 0, 10000) }] : []),
  }));
}
$('#json-import').onclick = () => {
  try { deck = cleanDeck(JSON.parse($('#jsonta').value)); saveDeck(); renderDeck(); $('#json-msg').textContent = `Imported ${deck.length} buttons.`; }
  catch (e) { $('#json-msg').textContent = 'Import failed: ' + e.message; }
};
renderDeck();

// ---------- tabs ----------
for (const b of document.querySelectorAll('nav button')) b.onclick = () => {
  for (const x of document.querySelectorAll('nav button')) x.classList.toggle('on', x === b);
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.id !== 'tab-' + b.dataset.tab;
};
