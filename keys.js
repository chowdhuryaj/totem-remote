// Key picker table and ASCII -> HID usage (US layout). Pages: 7 keyboard, 0xC consumer.
const K = (label, usage, page = 7) => ({ label, page, usage });
const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));
export const KEY_GROUPS = [
  { name: 'Letters', keys: range(26, (i) => K(String.fromCharCode(65 + i), 4 + i)) },
  { name: 'Digits', keys: range(10, (i) => K(String((i + 1) % 10), i < 9 ? 0x1e + i : 0x27)) },
  { name: 'F1-F12', keys: range(12, (i) => K('F' + (i + 1), 0x3a + i)) },
  { name: 'F13-F24', keys: range(12, (i) => K('F' + (i + 13), 0x68 + i)) },
  { name: 'Arrows', keys: [K('Up', 0x52), K('Down', 0x51), K('Left', 0x50), K('Right', 0x4f)] },
  { name: 'Named', keys: [
    K('Enter', 0x28), K('Esc', 0x29), K('Backspace', 0x2a), K('Tab', 0x2b), K('Space', 0x2c),
    K('Delete', 0x4c), K('Home', 0x4a), K('End', 0x4d), K('PgUp', 0x4b), K('PgDn', 0x4e),
    K('Insert', 0x49), K('CapsLock', 0x39), K('PrtSc', 0x46), K('Menu', 0x65),
    K('-', 0x2d), K('=', 0x2e), K('[', 0x2f), K(']', 0x30), K('\\', 0x31),
    K(';', 0x33), K("'", 0x34), K('`', 0x35), K(',', 0x36), K('.', 0x37), K('/', 0x38) ] },
  { name: 'Media', keys: [
    K('Play/Pause', 0xcd, 0xc), K('Next', 0xb5, 0xc), K('Previous', 0xb6, 0xc),
    K('Vol up', 0xe9, 0xc), K('Vol down', 0xea, 0xc), K('Mute', 0xe2, 0xc),
    K('Bright up', 0x6f, 0xc), K('Bright down', 0x70, 0xc) ] },
];

export const keyLabel = (page, usage) =>
  KEY_GROUPS.flatMap((g) => g.keys).find((k) => k.page === page && k.usage === usage)?.label ?? `0x${page.toString(16)}:0x${usage.toString(16)}`;

const PLAIN = '-=[]\;\'`,./', SHIFTED = '_+{}|:"~<>?', PLAIN_U = [0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38];
const NUMROW = '!@#$%^&*()';
// -> { usage, shift } or null
export function asciiKey(c) {
  if (c >= 'a' && c <= 'z') return { usage: 4 + c.charCodeAt(0) - 97, shift: false };
  if (c >= 'A' && c <= 'Z') return { usage: 4 + c.charCodeAt(0) - 65, shift: true };
  if (c >= '1' && c <= '9') return { usage: 0x1e + c.charCodeAt(0) - 49, shift: false };
  if (c === '0') return { usage: 0x27, shift: false };
  if (c === ' ') return { usage: 0x2c, shift: false };
  if (c === '\n') return { usage: 0x28, shift: false };
  if (c === '\t') return { usage: 0x2b, shift: false };
  let i = NUMROW.indexOf(c);
  if (i >= 0) return { usage: i === 9 ? 0x27 : 0x1e + i, shift: true };
  if ((i = PLAIN.indexOf(c)) >= 0) return { usage: PLAIN_U[i], shift: false };
  if ((i = SHIFTED.indexOf(c)) >= 0) return { usage: PLAIN_U[i], shift: true };
  return null;
}
