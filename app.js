import * as P from './protocol.js';
import { KEY_GROUPS, asciiKey, keyLabel } from './keys.js';
import { GESTURES, defaultConfig, cleanConfig, importAny, migrate, classifyMulti, classifyPinch } from './config.js';

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

// ---------- link (BLE or demo) and serialized GATT ops ----------
let link = null, status = null, textFree = 0;
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
  renderStatus(); pump();
}

// ---------- one FIFO for text, key taps, deck steps, gesture actions ----------
// Nothing overtakes text that is still waiting for text_free.
const fifo = []; let pumping = false, gen = 0;
function enqueue(it) {
  const t = fifo[fifo.length - 1];
  if (it.t === 'text' && t?.t === 'text') t.text += it.text; else fifo.push(it);
  pump();
}
async function pump() {
  if (pumping || !link) return;
  pumping = true; const g0 = gen;
  try {
    while (fifo.length && g0 === gen && link) {
      const it = fifo[0];
      if (it.t === 'text') {
        if (status && !status.hasText) { fifo.shift(); continue; }
        if (textFree <= 0) break; // resumes from onStatus
        const n = Math.min(20, textFree, it.text.length);
        const chunk = it.text.slice(0, n); it.text = it.text.slice(n); textFree -= n;
        if (!it.text) fifo.shift();
        await tx('text', P.encodeText(chunk));
      } else if (it.t === 'delay') { fifo.shift(); await sleep(it.ms); }
      else { fifo.shift(); await tx(it.kind, it.bytes); }
    }
  } finally { pumping = false; }
}
const tapKey = (mods, page, usage) => enqueue({ t: 'tx', kind: 'key', bytes: P.encodeKey({ action: P.ACTION.TAP, mods, page, usage }) });
function typeText(s) {
  s = P.filterText(s); if (!s) return;
  if (mods) { for (const c of s) { const k = asciiKey(c); if (k) tapKey(k.shift ? P.MOD.LSHIFT : 0, 7, k.usage); } return; } // held mods apply on the dongle
  enqueue({ t: 'text', text: s });
}
function runSteps(steps) {
  for (const s of steps) {
    if (s.t === 'key') tapKey(s.mods, s.page, s.usage);
    else if (s.t === 'text') typeText(s.text);
    else if (s.t === 'delay') enqueue({ t: 'delay', ms: s.ms });
  }
}

// ---------- connection ----------
function makeDemoLink() {
  let out = 1, free = 512;
  const bytes = () => [1, 3, 0, free & 255, free >> 8, 0x2f, out, 78, 0xff];
  return {
    kind: 'demo',
    setFree(n) { free = n; setTimeout(() => onStatus(bytes()), 0); }, // lets tests simulate a full text queue
    async write(kind, b) {
      log(kind, b);
      if (kind === 'control' && b[0] === 7) { out = b[1]; setTimeout(() => onStatus(bytes()), 0); }
    },
    async read() { return bytes(); },
    disconnect() {},
  };
}

const u8 = (dv) => new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
async function openBle(dev) {
  setState('Connecting...');
  // First action is reading Status (starts pairing). Chrome on Android can fail this read, or drop the link,
  // until the passkey is entered, so retry with backoff for ~30 s, reconnecting if needed.
  const t0 = performance.now(); let ch = null, first = null, lastErr;
  for (let i = 0; !first && performance.now() - t0 < 30000; i++) {
    try {
      if (!ch || !dev.gatt.connected) {
        const server = await dev.gatt.connect();
        const svc = await server.getPrimaryService(P.SERVICE);
        ch = {}; for (const k of Object.keys(P.CHARS)) ch[k] = await svc.getCharacteristic(P.CHARS[k]);
      }
      first = u8(await ch.status.readValue());
    } catch (e) {
      lastErr = e; ch = null;
      setState('Enter the code shown on the dongle');
      await sleep(Math.min(500 + i * 500, 3000));
    }
  }
  if (!first) throw lastErr || new Error('Pairing timed out');
  link = {
    kind: 'ble',
    write: (kind, b) => kind === 'mouse' ? ch.mouse.writeValueWithoutResponse(b)
      : (ch[kind].writeValueWithResponse || ch[kind].writeValue).call(ch[kind], b),
    read: async () => u8(await ch.status.readValue()),
    disconnect: () => dev.gatt.connected && dev.gatt.disconnect(),
  };
  onStatus(first);
  await ch.status.startNotifications();
  ch.status.addEventListener('characteristicvaluechanged', (e) => { try { onStatus(u8(e.target.value)); } catch (err) { console.warn(err); } });
  afterConnect();
}

function afterConnect() {
  wasConnected = true; userDisc = false;
  setState(status.remoteEnabled ? 'Connected' : 'Connected, but remote input is OFF on the dongle', status.remoteEnabled ? 'ok' : 'err');
  startLoops(); wakeLock();
  $('#connect').textContent = 'Disconnect';
  $('#log').hidden = link.kind !== 'demo';
}

async function connectBle() {
  if (!navigator.bluetooth) return setState('No Web Bluetooth here. Use Chrome (desktop/Android) or Bluefy on iPhone.', 'err');
  try {
    device = await navigator.bluetooth.requestDevice({ filters: [{ namePrefix: 'Totem' }], optionalServices: [P.SERVICE] });
    device.addEventListener('gattserverdisconnected', onGattDisc);
    await openBle(device);
  } catch (e) { link = null; setState(String(e.message || e), 'err'); }
}

async function reconnect(tries = 3) {
  if (!device || link) return;
  for (let i = 0; i < tries && !link && !userDisc; i++) {
    try { await openBle(device); return; }
    catch (e) { link = null; await sleep(1500); }
  }
  if (!link) setState('Reconnect failed. Tap Connect.', 'err');
}

function onGattDisc() {
  if (!link || link.kind !== 'ble') return;
  link = null; stopLoops(); resetLocal(); unwake(); $('#connect').textContent = 'Connect';
  $('#statusbar').hidden = true; setState('Disconnected', 'err');
  if (wasConnected && !userDisc && document.visibilityState === 'visible') reconnect();
}

async function disconnect() {
  userDisc = true; wasConnected = false;
  await releaseAll();
  link?.disconnect(); link = null; stopLoops(); unwake(); status = null;
  $('#connect').textContent = 'Connect'; $('#demo').textContent = 'Demo'; $('#statusbar').hidden = true;
  setState('Not connected');
}

$('#connect').onclick = () => (link ? disconnect() : connectBle());
$('#demo').onclick = async () => {
  if (link) { const wasDemo = link.kind === 'demo'; await disconnect(); if (wasDemo) return; }
  link = makeDemoLink(); window.__demo = link; onStatus(await link.read()); afterConnect();
  $('#demo').textContent = 'Stop demo'; $('#connect').textContent = 'Disconnect';
};

// Screen wake lock (Chrome Android and others where present); every use is optional.
let wl = null;
async function wakeLock() {
  try { if (!wl && navigator.wakeLock && document.visibilityState === 'visible') { wl = await navigator.wakeLock.request('screen'); wl.addEventListener('release', () => { wl = null; }); } } catch { wl = null; }
}
function unwake() { try { wl?.release(); } catch { /* ignore */ } wl = null; }

// ---------- status bar ----------
let autoHost = 'Mac';
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
  if (status.output) { const nh = status.output === 2 ? 'Mac' : 'Workstation'; if (nh !== autoHost) { autoHost = nh; renderDeck(); } }
}
$('#out').onclick = () => {
  const next = status?.output === 2 ? 1 : 2;
  tx('control', P.control.output(next)).then(() => refreshStatus());
};

// ---------- safety, timers ----------
let keepTimer = 0, watchTimer = 0;
function startLoops() {
  if (running) return; running = true; requestAnimationFrame(frame);
  watchTimer = setInterval(() => { if (fifo.length) refreshStatus(); }, 700);
}
function stopLoops() { running = false; clearInterval(keepTimer); clearInterval(watchTimer); keepTimer = 0; }
function resetLocal() {
  m.buttons = 0; m.ev = []; m.dx = m.dy = m.wh = m.hw = 0; mods = 0; renderMods();
  fifo.length = 0; gen++; dragLocked = false; clearTimeout(lockTimer);
  clearInterval(keepTimer); keepTimer = 0;
}
async function releaseAll() {
  resetLocal();
  if (link) await tx('control', P.control.releaseAll());
}
async function goHidden() {
  if (!link) return;
  const l = link;
  await releaseAll();
  unwake();
  if (l.kind === 'ble') { link = null; stopLoops(); l.disconnect(); }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') goHidden();
  else { if (wasConnected && !link && device) reconnect(); if (link) wakeLock(); }
});
addEventListener('pagehide', goHidden);

// ---------- config: host profiles, deck pages, gestures ----------
let cfg = cleanConfig(store.get('cfg.v2', null) ?? migrate(store.get('deck.v1', null)));
let pageIdx = 0, editing = false;
const saveCfg = () => store.set('cfg.v2', cfg);
const host = () => cfg.override || autoHost;
const profile = () => cfg.profiles[host()];

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
  if (!changed && !(m.buttons && now - m.last >= 250)) return; // held button: resend every 250 ms
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
let g = null, lastTap = 0, dragLocked = false, lockTimer = 0;
const ctr = () => { let x = 0, y = 0; for (const p of ptrs.values()) { x += p.x; y += p.y; } const n = ptrs.size || 1; return { x: x / n, y: y / n }; };
const dist2 = () => { const [a, b] = [...ptrs.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
const armLock = () => { clearTimeout(lockTimer); lockTimer = setTimeout(unlock, 5000); }; // safety release after 5 s idle
function unlock() { clearTimeout(lockTimer); if (dragLocked) { dragLocked = false; setButton(P.BTN.left, 0); } }
function fire(key) { const a = profile().gestures[key]; if (a) runSteps(a.steps); }

pad.addEventListener('pointerdown', (e) => {
  pad.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const now = performance.now();
  if (dragLocked) armLock();
  if (ptrs.size === 1) {
    g = { mode: 'one', t0: now, moved: 0, tapOK: true, drag: false, unlock: dragLocked };
    if (!dragLocked && now - lastTap < 300) { setButton(P.BTN.left, 1); g.drag = true; } // tap-and-a-half: drag
  } else if (g && !g.drag && !g.unlock && g.mode !== 'none') {
    const n = ptrs.size;
    if (n === 2 && g.mode === 'one') Object.assign(g, { mode: 'two', t0: now, moved: 0, tapOK: true, c0: ctr(), d0: dist2() });
    else if (n === 3 || n === 4) Object.assign(g, { mode: 'multi', n, t0: now, moved: 0, c0: ctr() });
    else g.mode = 'none';
  }
});
pad.addEventListener('pointermove', (e) => {
  const p = ptrs.get(e.pointerId); if (!p || !g) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
  const d = Math.hypot(dx, dy); g.moved += d;
  if (dragLocked) armLock();
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
  if (!ptrs.has(e.pointerId) || !g) { ptrs.delete(e.pointerId); return; }
  const now = performance.now(), up = e.type === 'pointerup';
  const c = ctr(), d = ptrs.size === 2 ? dist2() : 0; // measured before this finger leaves
  ptrs.delete(e.pointerId);
  if (g.mode === 'one' && ptrs.size === 0) {
    if (g.drag) {
      if (up && g.moved > 8) { dragLocked = true; armLock(); } // stays held after lift until the next tap
      else setButton(P.BTN.left, 0);
      lastTap = 0;
    } else if (g.unlock) {
      if (up && g.tapOK && now - g.t0 < 250) { unlock(); lastTap = 0; }
    } else if (up && g.tapOK && now - g.t0 < 250) { clickButton(P.BTN.left); lastTap = now; }
  } else if (g.mode === 'two') {
    if (up && g.tapOK && now - g.t0 < 300) clickButton(P.BTN.right);
    else if (up) { const k = classifyPinch(g.d0, d, Math.hypot(c.x - g.c0.x, c.y - g.c0.y)); if (k) fire(k); }
    g.mode = 'none';
  } else if (g.mode === 'multi') {
    if (up) { const k = classifyMulti(g.n, c.x - g.c0.x, c.y - g.c0.y, now - g.t0); if (k) fire(k); }
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
let mods = 0;
const MODS = [['Ctrl', P.MOD.LCTRL], ['Alt', P.MOD.LALT], ['Cmd', P.MOD.LGUI], ['Shift', P.MOD.LSHIFT]];
function renderMods() { for (const b of $('#mods').children) b.classList.toggle('on', !!(mods & +b.dataset.bit)); }
function toggleMod(bit) {
  const down = !(mods & bit);
  mods = down ? mods | bit : mods & ~bit;
  enqueue({ t: 'tx', kind: 'key', bytes: P.encodeKey({ action: down ? P.ACTION.PRESS : P.ACTION.RELEASE, mods: bit, usage: 0 }) });
  if (mods && !keepTimer) keepTimer = setInterval(() => tx('control', P.control.keepalive()), 250);
  if (!mods) { clearInterval(keepTimer); keepTimer = 0; }
  renderMods();
}
$('#mods').append(...MODS.map(([n, bit]) => h('button', { textContent: n, onclick: () => toggleMod(bit) })));
[...$('#mods').children].forEach((b, i) => { b.dataset.bit = MODS[i][1]; });
const SPECIAL = [['Esc', 0x29], ['Tab', 0x2b], ['Enter', 0x28], ['Bksp', 0x2a], ['Del', 0x4c], ['Up', 0x52], ['Down', 0x51], ['Left', 0x50], ['Right', 0x4f], ['Home', 0x4a], ['End', 0x4d], ['PgUp', 0x4b], ['PgDn', 0x4e], ['Space', 0x2c]];
$('#special').append(...SPECIAL.map(([n, u]) => h('button', { textContent: n, onclick: () => tapKey(0, 7, u) })));

const inp = $('#hidden'); let composing = false;
$('#kbd').onclick = () => inp.focus();
const KEYMAP = { Backspace: 0x2a, Enter: 0x28, Tab: 0x2b, Escape: 0x29, ArrowUp: 0x52, ArrowDown: 0x51, ArrowLeft: 0x50, ArrowRight: 0x4f };
inp.addEventListener('keydown', (e) => {
  if (e.key in KEYMAP && !e.metaKey && !e.ctrlKey) { e.preventDefault(); tapKey(0, 7, KEYMAP[e.key]); }
});
inp.addEventListener('beforeinput', (e) => {
  if (composing || e.isComposing || e.inputType === 'insertCompositionText') return; // Android IMEs: sent at compositionend
  if (e.inputType === 'deleteContentBackward') { e.preventDefault(); tapKey(0, 7, 0x2a); }
  else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') { e.preventDefault(); tapKey(0, 7, 0x28); }
  else if (e.data != null && e.inputType.startsWith('insert')) { e.preventDefault(); typeText(e.data); }
});
inp.addEventListener('compositionstart', () => { composing = true; });
inp.addEventListener('compositionend', () => { composing = false; const v = inp.value; inp.value = ''; typeText(v); });
inp.addEventListener('input', () => { if (composing) return; const v = inp.value; inp.value = ''; if (v) typeText(v); });

// ---------- stream deck (pages per host) ----------
const stepSummary = (s) => s.t === 'key' ? `${[[1, 'Ctrl'], [2, 'Shift'], [4, 'Alt'], [8, 'Cmd/Win']].filter(([b]) => s.mods & b).map(([, n]) => n + '+').join('')}${keyLabel(s.page, s.usage)}` : s.t === 'text' ? `"${s.text}"` : `${s.ms}ms`;
const stepsTitle = (a) => a.steps.map(stepSummary).join(', ');
let swiped = false;

function renderDeck() {
  const p = profile(); pageIdx = Math.max(0, Math.min(pageIdx, p.pages.length - 1));
  $('#host').value = cfg.override || ''; $('#hostname').textContent = host() + (cfg.override ? '' : ' (auto)');
  const page = p.pages[pageIdx];
  $('#deck').replaceChildren(...page.buttons.map((b, i) => h('button', {
    textContent: b.label || '(blank)', title: stepsTitle(b),
    onclick: () => { if (swiped) return; editing ? openEditor(b, { onSave: (d) => { page.buttons[i] = d; }, onDelete: () => page.buttons.splice(i, 1), onMove: (dl) => swap(page.buttons, i, dl) }) : runSteps(b.steps); },
  })));
  $('#pages').replaceChildren(
    ...p.pages.map((pg, i) => h('button', { textContent: pg.name, className: i === pageIdx ? 'on' : '', onclick: () => { pageIdx = i; renderDeck(); } })),
    ...(editing ? [
      h('button', { textContent: '+Page', onclick: () => { p.pages.push({ name: 'Page ' + (p.pages.length + 1), buttons: [] }); pageIdx = p.pages.length - 1; saveCfg(); renderDeck(); } }),
      h('button', { textContent: 'Rename', onclick: () => { const n = prompt('Page name', page.name); if (n) { page.name = n.slice(0, 20); saveCfg(); renderDeck(); } } }),
      h('button', { textContent: 'DelPage', onclick: () => { if (p.pages.length > 1 && confirm('Delete page ' + page.name + '?')) { p.pages.splice(pageIdx, 1); saveCfg(); renderDeck(); } } }),
    ] : []));
  $('#deck-edit').classList.toggle('on', editing); $('#deck-add').hidden = !editing;
  renderGest();
}
function swap(arr, i, dl) { const j = i + dl; if (j >= 0 && j < arr.length) [arr[i], arr[j]] = [arr[j], arr[i]]; }
$('#deck-edit').onclick = () => { editing = !editing; renderDeck(); };
$('#deck-add').onclick = () => {
  const page = profile().pages[pageIdx];
  openEditor({ label: '', steps: [{ t: 'key', mods: 0, page: 7, usage: 4 }] }, { onSave: (d) => page.buttons.push(d) });
};
$('#host').onchange = (e) => { cfg.override = e.target.value || null; saveCfg(); renderDeck(); };
// swipe the deck left/right to change page
let sx = null, sy0 = null;
$('#deck').addEventListener('pointerdown', (e) => { sx = e.clientX; sy0 = e.clientY; });
$('#deck').addEventListener('pointerup', (e) => {
  if (sx == null) return;
  const dx = e.clientX - sx, dy = e.clientY - sy0; sx = null;
  const n = profile().pages.length;
  if (Math.abs(dx) > 60 && Math.abs(dy) < 40 && n > 1) {
    pageIdx = (pageIdx + (dx < 0 ? 1 : -1) + n) % n; swiped = true; setTimeout(() => { swiped = false; }, 80); renderDeck();
  }
});

function renderGest() {
  $('#gest').replaceChildren(...GESTURES.map(([k, name]) => {
    const a = profile().gestures[k];
    return h('button', { title: stepsTitle(a), onclick: () => openEditor(a, { onSave: (d) => { profile().gestures[k] = d; } }) },
      h('b', { textContent: name }), h('br'), a.label || stepsTitle(a));
  }));
  $('#gesthost').textContent = 'Gestures for ' + host();
}

// ---------- editor (deck buttons and gesture actions) ----------
const editor = $('#editor');
function openEditor(src, { onSave, onDelete, onMove }) {
  const draft = structuredClone(src);
  const done = () => { saveCfg(); renderDeck(); editor.close(); };
  const draw = () => {
    const move = (a, dlt) => { const j = a + dlt; if (j < 0 || j >= draft.steps.length) return; [draft.steps[a], draft.steps[j]] = [draft.steps[j], draft.steps[a]]; draw(); };
    editor.replaceChildren(
      h('input', { value: draft.label, placeholder: 'Label', oninput: (e) => { draft.label = e.target.value; } }),
      ...draft.steps.map((s, i) => h('div', { className: 'step' },
        h('div', { className: 'row' },
          h('select', { value: s.t, onchange: (e) => { draft.steps[i] = { key: { t: 'key', mods: 0, page: 7, usage: 4 }, text: { t: 'text', text: '' }, delay: { t: 'delay', ms: 100 } }[e.target.value]; draw(); } },
            ...['key', 'text', 'delay'].map((t) => h('option', { value: t, textContent: t, selected: t === s.t }))),
          h('button', { textContent: 'Up', onclick: () => move(i, -1) }),
          h('button', { textContent: 'Down', onclick: () => move(i, 1) }),
          h('button', { textContent: 'Del', onclick: () => { draft.steps.splice(i, 1); draw(); } })),
        s.t === 'key' ? h('div', { className: 'row' },
          ...[['Ctrl', 1], ['Shift', 2], ['Alt', 4], ['Cmd/Win', 8]].map(([n, b]) => h('label', {}, h('input', { type: 'checkbox', checked: !!(s.mods & b), onchange: (e) => { s.mods = e.target.checked ? s.mods | b : s.mods & ~b; } }), ' ' + n)),
          h('select', { onchange: (e) => { [s.page, s.usage] = e.target.value.split(':').map(Number); } },
            ...KEY_GROUPS.map((gr) => h('optgroup', { label: gr.name }, ...gr.keys.map((k) => h('option', { value: `${k.page}:${k.usage}`, textContent: k.label, selected: k.page === s.page && k.usage === s.usage })))))) :
        s.t === 'text' ? h('input', { value: s.text, placeholder: 'Text (printable ASCII, \\n, \\t)', oninput: (e) => { s.text = P.filterText(e.target.value); } }) :
        h('input', { type: 'number', min: 0, max: 10000, value: s.ms, oninput: (e) => { s.ms = Math.max(0, Math.min(10000, +e.target.value || 0)); } }))),
      h('div', { className: 'row' },
        h('button', { textContent: '+ Step', onclick: () => { draft.steps.push({ t: 'key', mods: 0, page: 7, usage: 4 }); draw(); } }),
        onMove ? h('button', { textContent: 'Left', onclick: () => { onMove(-1); done(); } }) : null,
        onMove ? h('button', { textContent: 'Right', onclick: () => { onMove(1); done(); } }) : null),
      h('div', { className: 'row' },
        h('button', { className: 'primary', textContent: 'Save', onclick: () => { onSave(draft); done(); } }),
        onDelete ? h('button', { textContent: 'Delete', onclick: () => { onDelete(); done(); } }) : null,
        h('button', { textContent: 'Cancel', onclick: () => editor.close() })));
  };
  draw(); editor.showModal();
}

// ---------- JSON export / import (everything, version 2; old single-deck arrays still import) ----------
const jd = $('#jsond');
$('#deck-json').onclick = () => { $('#jsonta').value = JSON.stringify(cfg, null, 1); $('#json-msg').textContent = ''; jd.showModal(); };
$('#json-close').onclick = () => jd.close();
$('#json-reset').onclick = () => { cfg = defaultConfig(); saveCfg(); renderDeck(); $('#jsonta').value = JSON.stringify(cfg, null, 1); };
$('#json-import').onclick = () => {
  try { cfg = importAny(JSON.parse($('#jsonta').value), cfg, host()); pageIdx = 0; saveCfg(); renderDeck(); $('#json-msg').textContent = 'Imported.'; }
  catch (e) { $('#json-msg').textContent = 'Import failed: ' + e.message; }
};
renderDeck();

// ---------- tabs ----------
for (const b of document.querySelectorAll('nav button')) b.onclick = () => {
  for (const x of document.querySelectorAll('nav button')) x.classList.toggle('on', x === b);
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.id !== 'tab-' + b.dataset.tab;
};
