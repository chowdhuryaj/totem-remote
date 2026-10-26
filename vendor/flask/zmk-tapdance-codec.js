// flask_tapdance frame codecs (ZMK line, channel 0x28) — pure functions,
// no imports, vector-importable. Two payload-addressed frames:
//
//   step 0x50: [slot, tap, action, bid_hi, bid_lo, p1 u32 BE, p2 u32 BE]
//   cfg  0x51: [slot, term_hi, term_lo]   (term ms; 0 = firmware default 200)
//   flg  0x54: [slot, flags]              (proto 23: bit0 = eager)
//   rel  0x53: [slot, ms_hi, ms_lo]       (proto 23: resolve this long after release, 0 = off)
//   idle 0x52: [slot, ms_hi, ms_lo]       (proto 22: fast-typing bypass, 0 = off)
//
// proto 22: bit 7 (0x80) of the step's tap byte selects the HOLD output of
// that tap count (tap & 0x7F). Decoded as { tap, hold }.
//
// action: 0 none / 1 usage / 2 flask_macros slot / 3 behavior by Studio
// local id with two params — same vocabulary as combos slot v2. A dance's
// length is its contiguous configured prefix (the first NONE tap ends it).

export const TD_ACTION = { none: 0, usage: 1, macro: 2, behavior: 3 };

export function decodeTdStep(bytes) {
    const u32 = (o) =>
        (((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0);
    return {
        slot: bytes[0], tap: (bytes[1] ?? 0) & 0x7F, hold: !!((bytes[1] ?? 0) & 0x80),
        action: bytes[2] ?? 0,
        behaviorId: (((bytes[3] ?? 0) << 8) | (bytes[4] ?? 0)) >>> 0,
        param1: u32(5), param2: u32(9),
    };
}

export function encodeTdStep(slot, tap,
    { action = 0, behaviorId = 0, param1 = 0, param2 = 0, hold = false }) {
    param1 = param1 >>> 0;
    param2 = param2 >>> 0;
    return [slot & 0xFF, (tap & 0x7F) | (hold ? 0x80 : 0), action & 0xFF,
        (behaviorId >>> 8) & 0xFF, behaviorId & 0xFF,
        (param1 >>> 24) & 0xFF, (param1 >>> 16) & 0xFF, (param1 >>> 8) & 0xFF, param1 & 0xFF,
        (param2 >>> 24) & 0xFF, (param2 >>> 16) & 0xFF, (param2 >>> 8) & 0xFF, param2 & 0xFF];
}

export function decodeTdCfg(bytes) {
    return { slot: bytes[0], termMs: (((bytes[1] ?? 0) << 8) | (bytes[2] ?? 0)) >>> 0 };
}

export function encodeTdCfg(slot, termMs = 0) {
    termMs = termMs & 0xFFFF;
    return [slot & 0xFF, (termMs >>> 8) & 0xFF, termMs & 0xFF];
}

export function decodeTdRelease(bytes) {
    return { slot: bytes[0], releaseMs: (((bytes[1] ?? 0) << 8) | (bytes[2] ?? 0)) >>> 0 };
}

/** proto 23: after a mid-dance release the dance resolves at min(term deadline, release + releaseMs); 0 = off. */
export function encodeTdRelease(slot, ms = 0) {
    ms = Math.max(0, Math.min(1000, ms | 0));
    return [slot & 0xFF, (ms >>> 8) & 0xFF, ms & 0xFF];
}

export const TD_FLAG_EAGER = 0x01;

export function decodeTdFlags(bytes) {
    const flags = (bytes[1] ?? 0) & 0xFF;
    return { slot: bytes[0], flags, eager: !!(flags & TD_FLAG_EAGER) };
}

/** proto 23, 0x54: [slot, flags]. bit0 = eager: each tap's output fires at the press, holds are ignored. */
export function encodeTdFlags(slot, flags = 0) {
    return [slot & 0xFF, flags & 0xFF];
}

export function decodeTdPriorIdle(bytes) {
    return { slot: bytes[0], priorIdleMs: (((bytes[1] ?? 0) << 8) | (bytes[2] ?? 0)) >>> 0 };
}

export function encodeTdPriorIdle(slot, ms = 0) {
    ms = Math.max(0, Math.min(1000, ms | 0));
    return [slot & 0xFF, (ms >>> 8) & 0xFF, ms & 0xFF];
}

/** A dance fires only its contiguous configured prefix. */
export function tdDanceLength(taps) {
    let n = 0;
    while (n < taps.length && taps[n].action !== TD_ACTION.none) n++;
    return n;
}

export function tdSlotIsEmpty({ termMs = 0, priorIdleMs = 0, releaseMs = 0, flags = 0, taps = [] }) {
    return termMs === 0 && priorIdleMs === 0 && releaseMs === 0 && flags === 0 && taps.every((t) => t.action === TD_ACTION.none);
}
