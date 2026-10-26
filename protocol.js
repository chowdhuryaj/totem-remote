// NEXUS Remote Input protocol v1: encoders and the Status decoder. No DOM, no BLE.
const B = '-5c1a-4b2e-9d3f-8a6b4c2d1e0f';
export const SERVICE = '7e4e0001' + B;
export const CHARS = {
  mouse: '7e4e0002' + B, key: '7e4e0003' + B, text: '7e4e0004' + B,
  control: '7e4e0005' + B, status: '7e4e0006' + B,
};
export const BTN = { left: 1, right: 2, middle: 4, back: 8, forward: 16 };
export const MOD = { LCTRL: 1, LSHIFT: 2, LALT: 4, LGUI: 8, RCTRL: 16, RSHIFT: 32, RALT: 64, RGUI: 128 };
export const PAGE = { KEYBOARD: 0x07, CONSUMER: 0x0c };
export const ACTION = { RELEASE: 0, PRESS: 1, TAP: 2 };
export const TEXT_MAX = 244;
export const KEY_COST = 6; // a Key write occupies this many bytes of the dongle's text ring

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v) || 0));

export function encodeMouse({ buttons = 0, dx = 0, dy = 0, wheel = 0, hwheel = 0 } = {}) {
  const b = new Uint8Array(8), v = new DataView(b.buffer);
  v.setUint8(0, buttons & 0x1f);
  v.setInt16(1, clamp(dx, -32768, 32767), true);
  v.setInt16(3, clamp(dy, -32768, 32767), true);
  v.setInt8(5, clamp(wheel, -128, 127));
  v.setInt8(6, clamp(hwheel, -128, 127));
  return b; // byte 7 reserved = 0
}

export function encodeKey({ action = ACTION.TAP, mods = 0, page = PAGE.KEYBOARD, usage = 0 } = {}) {
  const b = new Uint8Array(6), v = new DataView(b.buffer);
  v.setUint8(0, action); v.setUint8(1, mods & 0xff);
  v.setUint16(2, page, true); v.setUint16(4, usage, true);
  return b;
}

// Keep printable ASCII 0x20-0x7E, \n and \t; drop everything else.
export const filterText = (s) => [...String(s)].filter((c) => (c >= ' ' && c <= '~') || c === '\n' || c === '\t').join('');
export const encodeText = (s) => Uint8Array.from(filterText(s), (c) => c.charCodeAt(0));
export function chunkText(s, size = 20) {
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

// Control 0x06 (game actions) is deliberately absent: this dongle refuses it.
export const control = {
  releaseAll: () => Uint8Array.of(0x01),
  keepalive: () => Uint8Array.of(0x02),
  cancelText: () => Uint8Array.of(0x03),
  typingDelay: (ms) => Uint8Array.of(0x04, clamp(ms, 2, 50)),
  identify: () => Uint8Array.of(0x05),
  output: (o) => Uint8Array.of(0x07, o === 2 ? 2 : 1), // 1 USB, 2 BLE
};

// Reads only the bytes present (6 base, 7 with output, 9 with batteries).
export function decodeStatus(bytes) {
  const b = Uint8Array.from(bytes), n = b.length;
  if (n < 6) throw new Error('Status too short: ' + n);
  const v = new DataView(b.buffer);
  const s = {
    version: b[0],
    remoteEnabled: !!(b[1] & 1), usbConnected: !!(b[1] & 2), typing: !!(b[1] & 4), pairingOpen: !!(b[1] & 8),
    numLock: !!(b[2] & 1), capsLock: !!(b[2] & 2), scrollLock: !!(b[2] & 4),
    textFree: v.getUint16(3, true),
    features: b[5],
    output: n >= 7 ? b[6] : 0,
    battLeft: n >= 9 ? b[7] : 0xff,
    battRight: n >= 9 ? b[8] : 0xff,
  };
  s.hasText = !!(b[5] & 1); s.hasConsumer = !!(b[5] & 2); s.hasHwheel = !!(b[5] & 4);
  s.hasOutput = !!(b[5] & 8); s.hasBatteries = !!(b[5] & 32);
  return s;
}
