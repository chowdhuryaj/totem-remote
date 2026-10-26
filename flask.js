// "Flask" sheet: tuning sections over the phone tunnel (config window only). Same sections as Totem-Flask's
// Behaviour tabs, with phone controls. Transport: tunnel.js; protocol/codecs: vendor/flask.
import { $, h } from './dom.js';
import { TunnelHID, openBleTunnel } from './tunnel.js';
import { DemoFlaskIo } from './demo-flask.js';
import { FlaskProto } from './vendor/flask/flaskproto.js';
import { zmkCapabilities } from './vendor/flask/zmk.js';
import { ui } from './flask-ui.js';
import { studioCtx, ensureStudio, CONFIG_WINDOW_S } from './keymap.js';
import * as A from './flask-sections-a.js';
import * as B from './flask-sections-b.js';

// need = capability flag (zmkCapabilities) that gates the section; null = always offered once connected.
export const SECTIONS = [
  { id: 'holdtap', title: 'Hold-tap', need: 'flask', min: 17, build: A.holdtap },
  { id: 'tapdance', title: 'Tap dance', need: 'tapDance', build: A.tapDance },
  { id: 'combos', title: 'Combos', need: 'combos', build: B.combos },
  { id: 'macros', title: 'Macros', need: 'macros', build: B.macros },
  { id: 'autoshift', title: 'Auto shift', need: 'autoshift', build: A.autoshift },
  { id: 'adaptive', title: 'Adaptive', need: 'adaptive', min: 18, build: B.adaptive },
  { id: 'shift', title: 'Custom shift', need: 'customShift', build: A.customShift },
  { id: 'modes', title: 'Modes', need: 'never', note: 'Not built on the phone yet: modes are whole-config snapshots, which need the full export/import engine.' },
];

let deps = { queue: null, getDevice: () => null, getStatus: () => null, isDemo: () => false };
const st = { hid: null, flask: null, app: null, version: null, caps: null, section: 'holdtap', busy: false, msg: '', dirtyCh: new Map() };
let epoch = 0;

export function initFlask(d) {
  deps = d;
  $('#nb-fl').onclick = () => { $('#fl').showModal(); paint(); };
  $('#fl-close').onclick = () => $('#fl').close();
  $('#fl-connect').onclick = () => (st.flask ? down('') : connect());
  $('#fl-save').onclick = saveAll;
  $('#fl-reload').onclick = () => openSection(st.section);
  ui.report = (m) => { st.msg = m; $('#fl-msg').textContent = m; };
  ui.studio = async () => ensureStudio();
  paint();
}

/** Called on every remote Status: the tunnel only exists while the config window is open. */
export function flaskStatus(s) { if (st.flask && !deps.isDemo() && !(s?.hasConfig && s?.configOpen)) down('Config window closed'); else if ($('#fl').open) paint(); }
export function flaskDown() { if (st.flask) down('Remote disconnected'); }

async function down(msg) {
  epoch++;
  const hid = st.hid; Object.assign(st, { hid: null, flask: null, app: null, version: null, caps: null, msg, dirtyCh: new Map() });
  try { await hid?.close(); } catch { /* ignore */ }
  paint();
}

async function connect() {
  st.busy = true; st.msg = 'Connecting...'; paint();
  try {
    if (deps.isDemo()) st.hid = new TunnelHID(new DemoFlaskIo());
    else {
      const dev = deps.getDevice(), s = deps.getStatus();
      if (!dev) throw new Error('Connect the remote first.');
      if (!s?.hasConfig) throw new Error('This firmware has no Flask tunnel.');
      if (!s.configOpen) throw new Error('Press Phone Config Unlock on the keyboard.');
      st.hid = await openBleTunnel(dev, deps.queue);
    }
    st.flask = new FlaskProto(st.hid); st.flask.line = 'zmk';
    st.version = await st.flask.handshake();
    if (st.version == null) throw new Error('The keyboard did not answer the Flask handshake.');
    st.caps = zmkCapabilities('totem', st.version);
    st.caps.adaptive = st.version >= 18;
    st.app = { flask: st.flask, hid: st.hid, protocolVersion: st.version, caps: st.caps, family: 'totem' };
    st.msg = '';
    await openSection(st.section);
  } catch (e) {
    st.msg = String(e.message || e);
    const hid = st.hid; st.hid = st.flask = null; try { await hid?.close(); } catch { /* ignore */ }
  }
  st.busy = false; paint();
}

const F = () => ({
  flask: st.flask, app: st.app, caps: st.caps, version: st.version,
  studio: studioCtx(),
  dirty: (ch, label) => { st.dirtyCh.set(ch, label); paintSave(); },
  progress: (t) => { $('#fl-msg').textContent = t; },
});

async function openSection(id) {
  st.section = id; st.msg = '';
  const sec = SECTIONS.find((x) => x.id === id), body = $('#fl-body'), my = ++epoch;
  paintTabs();
  body.replaceChildren();
  if (!st.flask) return;
  if (sec.note) { body.append(h('p', { className: 'hint', textContent: sec.note })); return; }
  if (sec.need !== 'flask' && !st.caps[sec.need]) { body.append(h('p', { className: 'hint', textContent: `This firmware (protocol ${st.version}) does not have ${sec.title}.` })); return; }
  if (sec.min && st.version < sec.min) { body.append(h('p', { className: 'hint', textContent: `${sec.title} needs protocol ${sec.min}; this firmware is ${st.version}.` })); return; }
  body.append(h('p', { className: 'hint', textContent: 'Reading from the keyboard…' }));
  const next = h('div');
  try { await sec.build(next, F()); if (my === epoch) body.replaceChildren(...next.childNodes); $('#fl-msg').textContent = ''; }
  catch (e) { if (my === epoch) { body.replaceChildren(h('p', { className: 'hint', textContent: `Could not read ${sec.title}: ${e.message}` })); $('#fl-msg').textContent = ''; } }
}

async function saveAll() {
  const chans = [...st.dirtyCh.entries()];
  st.busy = true; paint();
  try { for (const [ch, label] of chans) { $('#fl-msg').textContent = `Saving ${label}…`; await st.flask.save(ch); st.dirtyCh.delete(ch); } $('#fl-msg').textContent = 'Saved'; }
  catch (e) { ui.report(`Save failed: ${e.message}`); }
  st.busy = false; paint();
}

let cfgUntil = 0;
function paintTabs() {
  $('#fl-tabs').replaceChildren(...SECTIONS.map((sec) => h('button', { className: 'small' + (sec.id === st.section ? ' on' : ''), textContent: sec.title, disabled: !st.flask, onclick: () => openSection(sec.id) })));
}
function paintSave() {
  const n = st.dirtyCh.size;
  $('#fl-save').disabled = st.busy || !n; $('#fl-save').textContent = n ? `Save to keyboard (${[...st.dirtyCh.values()].join(', ')})` : 'Saved';
  $('#fl-unsaved').hidden = !n;
}
function paint() {
  const s = deps.getStatus(), on = !!st.flask, demo = deps.isDemo();
  if (s?.configOpen && !cfgUntil) cfgUntil = Date.now() + CONFIG_WINDOW_S * 1000; if (!s?.configOpen) cfgUntil = 0;
  const left = Math.max(0, Math.round((cfgUntil - Date.now()) / 1000));
  $('#fl-cfg').hidden = !demo && !s; $('#fl-cfg').textContent = demo ? 'demo' : !s?.hasConfig ? 'no tunnel' : s.configOpen ? `config open ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'config locked';
  if (!st.msg && !on) $('#fl-msg').textContent = demo ? 'Demo: a fake Totem answering the Flask protocol.' : !deps.getDevice() ? 'Connect the remote first.' : !s?.hasConfig ? 'This firmware has no Flask tunnel.' : s.configOpen ? 'Config window is open. Tap Connect.' : 'Press Phone Config Unlock on the keyboard';
  else if (st.msg) $('#fl-msg').textContent = st.msg;
  $('#fl-connect').textContent = on ? 'Disconnect' : 'Connect to keyboard';
  $('#fl-connect').disabled = st.busy || (!on && !demo && !(deps.getDevice() && s?.hasConfig && s?.configOpen));
  for (const id of ['fl-bar']) $('#' + id).hidden = !on;
  if (!on) $('#fl-body').replaceChildren();
  paintTabs(); paintSave();
}
setInterval(() => { if ($('#fl')?.open) paint(); }, 1000);
