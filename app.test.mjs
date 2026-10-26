// Drives app.js in demo mode behind a Proxy-free minimal DOM: mouse coalescing/retry (M1), hung-op teardown (M3),
// ghost pointers (M5), button repeats (M2), held-mod resend without keepalives (M6), text retry and flow control (m5, m10).
import test from 'node:test';
import assert from 'node:assert/strict';

const created = [], rafs = new Map(); let rafId = 0;
const mkEl = () => {
  const e = { listeners: {}, dataset: {}, style: {}, children: [], childNodes: [], value: '', open: false, hidden: false, textContent: '',
    classList: { toggle() {}, add() {}, remove() {} }, firstChild: null,
    addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }, setAttribute(k, v) { this[k] = v; },
    append() {}, replaceChildren() {}, setPointerCapture() {}, focus() {}, showModal() {}, close() {}, closest: () => null };
  created.push(e); return e;
};
const els = new Map();
globalThis.document = { visibilityState: 'visible', body: mkEl(), addEventListener() {}, querySelector: (s) => { if (!els.has(s)) els.set(s, mkEl()); return els.get(s); },
  querySelectorAll: () => [], createElement: () => mkEl(), createElementNS: () => mkEl() };
const winL = {};
Object.assign(globalThis, { window: globalThis, self: globalThis, top: globalThis, innerHeight: 800, innerWidth: 400,
  addEventListener: (t, f) => { winL[t] = f; },
  requestAnimationFrame: (f) => { rafs.set(++rafId, f); return rafId; }, cancelAnimationFrame: (i) => rafs.delete(i) });
const si = globalThis.setInterval; globalThis.setInterval = (f, t) => { const x = si(f, t); x.unref?.(); return x; }; // flask.js and app.js start timers at load

await import('./app.js');
const $ = (s) => document.querySelector(s);
const fire = (el, type, ev = {}) => { for (const f of el.listeners[type] || []) f({ type, preventDefault() {}, ...ev }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let T = 1000;
const frame = async () => { T += 16; const fs = [...rafs.values()]; rafs.clear(); for (const f of fs) f(T); await sleep(3); };
const demoBtn = $('#demo');
const connect = async () => { if (demoBtn.textContent === 'Stop demo') await demoBtn.onclick(); await demoBtn.onclick(); return window.__demo; };
// Wrap the demo link's write: record every attempt and every success, track concurrent mouse writes.
function spy(d) {
  const r = { tried: [], ok: [], conc: 0, maxConc: 0 }, orig = d.write.bind(d);
  d.write = async (k, b) => {
    r.tried.push([k, [...b]]); if (k === 'mouse') r.maxConc = Math.max(r.maxConc, ++r.conc);
    try { const v = await orig(k, b); r.ok.push([k, [...b]]); return v; } finally { if (k === 'mouse') r.conc--; }
  };
  r.mouse = (list = r.ok) => list.filter(([k]) => k === 'mouse').map(([, b]) => ({ btn: b[0], dx: (b[1] | (b[2] << 8)) << 16 >> 16, dy: (b[3] | (b[4] << 8)) << 16 >> 16, wheel: b[5] << 24 >> 24 }));
  r.text = () => r.ok.filter(([k]) => k === 'text').map(([, b]) => String.fromCharCode(...b)).join('');
  return r;
}
const pad = $('#pad');
const down = (id, x = 0, y = 0, t = T) => fire(pad, 'pointerdown', { pointerId: id, clientX: x, clientY: y, timeStamp: t });
const move = (id, x, y, t = T) => fire(pad, 'pointermove', { pointerId: id, clientX: x, clientY: y, timeStamp: t });
const up = (id) => fire(pad, 'pointerup', { pointerId: id });
const type = (data) => fire($('#hidden'), 'beforeinput', { inputType: 'insertText', data, isComposing: false });
const sumDx = (r) => r.mouse().reduce((a, p) => a + p.dx, 0);

test('M1: one mouse write in flight, movement coalesces; rejected write puts movement back', async () => {
  let d = await connect(), r = spy(d);
  d.opts.delay = 30;
  down(1); move(1, 20, 0); await frame();      // write 1 starts
  move(1, 40, 0); await frame();               // busy: nothing sent, delta kept
  assert.equal(r.tried.length, 1);
  await sleep(50); await frame(); await sleep(50);
  assert.equal(r.maxConc, 1);
  assert.equal(r.mouse().length, 2);
  const delivered = sumDx(r); up(1);
  d.opts.delay = 0;
  // control run vs a run whose first write is rejected: same total movement arrives
  d = await connect(); r = spy(d);
  down(1); move(1, 20, 0); await frame(); await frame(); up(1);
  const control = sumDx(r);
  d = await connect(); r = spy(d); d.opts.fail = 1;
  down(1); move(1, 20, 0); await frame(); await sleep(10); await frame(); await frame(); up(1);
  assert.equal(r.tried.filter(([k]) => k === 'mouse').length > r.ok.filter(([k]) => k === 'mouse').length, true, 'one attempt was rejected');
  assert.equal(sumDx(r), control);
  assert.ok(control > 0 && delivered > control);
});

test('M2: a button change is repeated for 3 frames', async () => {
  const d = await connect(), r = spy(d);
  down(1); up(1);                                   // quick tap = click
  for (let i = 0; i < 8; i++) await frame();
  assert.deepEqual(r.mouse().map((p) => p.btn), [1, 0, 0, 0]);
});

test('M6: held modifier resends Mouse every 250 ms, no Control keepalive', async () => {
  const d = await connect(), r = spy(d);
  const ctrl = created.find((e) => e.textContent === 'Ctrl' && e.listeners.click);
  fire(ctrl, 'click');
  for (let i = 0; i < 40; i++) await frame();       // 40 * 16 ms = 640 ms
  const n = r.mouse().length;
  assert.ok(n >= 3 && n <= 4, 'mouse packets: ' + n);
  assert.equal(r.tried.filter(([k, b]) => k === 'control' && b[0] === 2).length, 0);
  assert.ok(r.ok.some(([k, b]) => k === 'key' && b[0] === 1 && b[1] === 1), 'Ctrl press sent');
  fire(ctrl, 'click');
});

test('M5: lost pointerup / disconnect leave no ghost finger', async () => {
  let d = await connect(), r = spy(d);
  down(1); fire(pad, 'lostpointercapture', { pointerId: 1 });
  down(2, 0, 0); move(2, 30, 0); await frame();
  assert.ok(sumDx(r) > 0 && r.mouse().every((p) => p.wheel === 0), 'single finger moves the cursor');
  up(2);
  down(3);                                         // ghost: no up
  d = await connect(); r = spy(d);                 // stop + start demo => resetLocal
  down(4, 0, 0); move(4, 30, 0); await frame();
  assert.ok(sumDx(r) > 0 && r.mouse().every((p) => p.wheel === 0));
  up(4);
});

test('m1: exactly one frame loop after reconnects', async () => {
  await connect(); await connect(); await frame();
  assert.equal(rafs.size, 1);
});

test('m5/m10: failed text write keeps the chunk and retries once; drain waits for text_free', async () => {
  let d = await connect(), r = spy(d); d.opts.fail = 1;
  type('hello world');
  await sleep(80);
  assert.equal(r.text(), 'hello world');
  assert.equal(r.tried.filter(([k]) => k === 'text').length, 2);
  d = await connect(); r = spy(d); d.opts.drain = true; d.setFree(30);
  await sleep(10); type('x'.repeat(100)); await sleep(80);
  assert.equal(r.text().length, 30, 'stops when the ring is full');
  d.setFree(512); await sleep(80);
  assert.equal(r.text().length, 100);
});

test('M3: a hung op tears the link down; the next link is not blocked behind it', { timeout: 10000 }, async () => {
  let d = await connect(); d.opts.delay = 4000;
  type('stuck');
  await sleep(3300);
  assert.equal($('#state').textContent, 'Disconnected');
  assert.equal($('#connect').textContent, 'Connect');
  d = await connect(); const r = spy(d);
  type('ok'); await sleep(60);
  assert.equal(r.text(), 'ok');
  assert.equal(rafs.size, 1);
});

test('A2: failing text write is dropped after 3 tries; no retry loop', async () => {
  const d = await connect(), r = spy(d); d.opts.fail = 1000;
  type('abc');
  await sleep(400);
  assert.equal(r.tried.filter(([k]) => k === 'text').length, 3);
  d.opts.fail = 0; await sleep(100);
  assert.equal(r.tried.filter(([k]) => k === 'text').length, 3, 'stays dropped');
});
