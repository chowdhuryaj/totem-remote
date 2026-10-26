// Tap-dance slot reads/writes + a shared cache, used by the Tap Dance tab,
// the key inspector's tap-dance mode and the board legend (legend.js shows a
// &ftd key as its tap-1 output). No DOM; talks to app.flask only.
//
// Slot shape: { slot, termMs, priorIdleMs, taps: [out], holds: [out] } with
// out = { slot, tap, hold, action, behaviorId, param1, param2, unknown? }.
// holds / priorIdleMs exist on the wire from proto 22 (TD_V2).

import { CH_ZMK, V } from './flaskproto.js';
import { zmkAllSlotNames, zmkApplySlotNames } from './zmk.js';
import { isRecursiveOutput } from './behavior-catalog.js';
import {
    TD_ACTION, decodeTdStep, encodeTdStep, decodeTdCfg, encodeTdCfg,
    decodeTdPriorIdle, encodeTdPriorIdle, decodeTdRelease, encodeTdRelease, decodeTdFlags, encodeTdFlags, TD_FLAG_EAGER, tdDanceLength,
} from './zmk-tapdance-codec.js';

export const TD_V2 = 22;
export const TD_V3 = 23;
export const tdV3 = (app) => (app?.protocolVersion ?? 0) >= TD_V3;   // after-release window (0x53)
export const tdV2 = (app) => (app?.protocolVersion ?? 0) >= TD_V2;

export const noOut = (slot, tap, hold = false) =>
    ({ slot, tap, hold, action: TD_ACTION.none, behaviorId: 0, param1: 0, param2: 0 });

// ---- app-side defaults (ride the slot-names table, so the v2 export/import carries them) ----

export const tdPrefs = (family) => ({ termMs: 0, priorIdleMs: 0, releaseMs: 0, eager: false, ...(zmkAllSlotNames(family).tdprefs ?? {}) });
export function setTdPrefs(family, p) {
    const all = zmkAllSlotNames(family);
    all.tdprefs = { ...tdPrefs(family), ...p };
    zmkApplySlotNames(family, all);
}

// ---- cache (read by legend.js; null until a load) ----
let cache = null, cacheFor = null;
const subs = new Set();
export const tdSlots = () => cache;
/** Forget the cache (new connection: another device's slots must not label this one's keys). */
export function resetTdSlots() { cache = null; cacheFor = null; for (const f of subs) f(); }
export const tdSlot = (i) => cache?.[i] ?? null;
export function setTdSlots(slots, flask = null) { cache = slots; cacheFor = flask; for (const f of subs) f(); }
/** fn() runs whenever the cache changes; returns an unsubscribe. */
export function onTdSlots(fn) { subs.add(fn); return () => subs.delete(fn); }
function put(s) { if (cache) { cache = cache.slice(); cache[s.slot] = s; for (const f of subs) f(); } }

/** Drop the cache and re-read it (after an import rewrote the slots). */
export async function refreshTdSlots(app) {
    try { setTdSlots(await readAllTdSlots(app), app.flask); } catch { cache = null; }
}

/** One slot from the device. A dance is its contiguous tap prefix; later taps
 * are left unread (`unknown`) and cleared before a write could make them live. */
export async function readTdSlot(app, i, maxTaps = 4) {
    const { flask } = app;
    const v2 = tdV2(app);
    const cfg = decodeTdCfg(await flask.getBytes(CH_ZMK.tapDance, V.tdCfg, [i], 1));
    const priorIdleMs = v2
        ? decodeTdPriorIdle(await flask.getBytes(CH_ZMK.tapDance, V.tdPriorIdle, [i], 1)).priorIdleMs : 0;
    const releaseMs = tdV3(app)
        ? decodeTdRelease(await flask.getBytes(CH_ZMK.tapDance, V.tdRelease, [i], 1)).releaseMs : 0;
    const flags = tdV3(app)
        ? decodeTdFlags(await flask.getBytes(CH_ZMK.tapDance, V.tdFlags, [i], 1)).flags : 0;
    const taps = [], holds = [];
    let ended = false;
    for (let t = 0; t < maxTaps; t++) {
        if (ended) { taps.push({ ...noOut(i, t), unknown: true }); continue; }
        const d = decodeTdStep(await flask.getBytes(CH_ZMK.tapDance, V.tdStep, [i, t], 2));
        // &ftd as a step recurses in the firmware (so does a hold-tap around &fak); &fak itself is fine from proto 22.
        const o = isRecursiveOutput(d, { adaptiveOk: v2 }) ? { ...noOut(i, t), unknown: true } : d;
        taps.push(o);
        if (!o.action) ended = true;
    }
    for (let t = 0; t < maxTaps; t++) {
        if (!v2) { holds.push(noOut(i, t, true)); continue; }   // every index: a stored hold shows when its tap goes live
        const d = decodeTdStep(await flask.getBytes(CH_ZMK.tapDance, V.tdStep, [i, t | 0x80], 2));
        holds.push(isRecursiveOutput(d, { adaptiveOk: true }) ? noOut(i, t, true) : d);
    }
    return { slot: i, termMs: cfg.termMs, priorIdleMs, releaseMs, flags, eager: !!(flags & TD_FLAG_EAGER), taps, holds };
}

export async function readAllTdSlots(app) {
    const { flask } = app;
    const count = await flask.getU16(CH_ZMK.tapDance, V.tdSlotCount);
    const maxTaps = (await flask.getU16(CH_ZMK.tapDance, V.tdTaps)) || 4;
    const slots = [];
    for (let i = 0; i < count; i++) slots.push(await readTdSlot(app, i, maxTaps));
    return slots;
}

/** Fill the cache once per connection (the board legend needs it before the tab opens). */
export async function ensureTdSlots(app) {
    if (!app?.flask || !app.caps?.tapDance) return cache;
    if (cache && cacheFor === app.flask) return cache;
    try { app.hid?.pause?.(); setTdSlots(await readAllTdSlots(app), app.flask); }
    catch { /* legend falls back to "TD n" */ }
    finally { app.hid?.resume?.(); }
    return cache;
}

// ---- writes: each returns the device's echo, and updates the cache ----

/** Write tap t (or its hold output). Unread taps behind a newly live one are cleared first. */
export async function writeTdStep(app, s, t, hold, step) {
    const { flask } = app;
    const w = (tt, hh, x) => flask.setBytes(CH_ZMK.tapDance, V.tdStep, encodeTdStep(s.slot, tt, { ...x, hold: hh }), 2);
    if (!hold && step.action) {
        for (let k = t + 1; k < s.taps.length; k++) {
            if (s.taps[k].unknown) s.taps[k] = decodeTdStep(await w(k, false, noOut(s.slot, k)));
        }
    }
    const echo = decodeTdStep(await w(t, hold, step));
    (hold ? s.holds : s.taps)[t] = echo;
    // The dance now ends at t: holds at t and beyond would come back when the gap is refilled.
    if (!hold && !echo.action && tdV2(app)) {
        for (let k = t; k < s.holds.length; k++) {
            if (s.holds[k].action) s.holds[k] = decodeTdStep(await w(k, true, noOut(s.slot, k, true)));
        }
    }
    put(s);
    return echo;
}

export async function writeTdTerm(app, s, termMs) {
    const r = await app.flask.setBytes(CH_ZMK.tapDance, V.tdCfg, encodeTdCfg(s.slot, termMs), 1);
    s.termMs = decodeTdCfg(r).termMs;
    put(s);
}

export async function writeTdPriorIdle(app, s, ms) {
    const r = await app.flask.setBytes(CH_ZMK.tapDance, V.tdPriorIdle, encodeTdPriorIdle(s.slot, ms), 1);
    s.priorIdleMs = decodeTdPriorIdle(r).priorIdleMs;
    put(s);
}

export async function writeTdRelease(app, s, ms) {
    const r = await app.flask.setBytes(CH_ZMK.tapDance, V.tdRelease, encodeTdRelease(s.slot, ms), 1);
    s.releaseMs = decodeTdRelease(r).releaseMs;
    put(s);
}

/** Instant (eager) mode: every tap fires at the press, holds unused. Other flag bits are kept. */
export async function writeTdEager(app, s, on) {
    const flags = on ? (s.flags ?? 0) | TD_FLAG_EAGER : (s.flags ?? 0) & ~TD_FLAG_EAGER;
    const r = await app.flask.setBytes(CH_ZMK.tapDance, V.tdFlags, encodeTdFlags(s.slot, flags), 1);
    const d = decodeTdFlags(r);
    s.flags = d.flags; s.eager = d.eager;
    put(s);
}

/** Empty a slot: every tap and hold, term and bypass. */
export async function clearTdSlot(app, s) {
    for (let t = 0; t < s.taps.length; t++) {
        await writeTdStep(app, s, t, false, noOut(s.slot, t));
        if (tdV2(app)) await writeTdStep(app, s, t, true, noOut(s.slot, t, true));
    }
    await writeTdTerm(app, s, 0);
    if (tdV2(app)) await writeTdPriorIdle(app, s, 0);
    if (tdV3(app)) { await writeTdRelease(app, s, 0); await writeTdEager(app, s, false); }
}
