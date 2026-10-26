// A fake Totem Flask device speaking the real frame protocol ([cmd, channel, id, payload...], 32-byte replies),
// so the vendored codecs and the tunnel transport run unchanged in demo mode and under `node --test`.
// Frame layouts follow vendor/flask/flaskproto.js and the zmk-*-codec.js headers.
const CMD = { set: 0x07, get: 0x08, save: 0x09, unhandled: 0xff };
const u16 = (v) => [(v >> 8) & 0xff, v & 0xff];
const u32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const NAME = (s) => { const a = Array.from(s, (c) => c.charCodeAt(0)); while (a.length < 26) a.push(0); return a; };

// channel:id -> value defaults
const VALUES = {
  '0x00:0x01': 23, '0x00:0x03': 6,
  '0x2a:0x01': 40,
  '0x24:0x01': 1, '0x24:0x02': 16, '0x24:0x03': 50, '0x24:0x04': 4,
  '0x25:0x01': 1, '0x25:0x02': 8, '0x25:0x03': 12, '0x25:0x04': 30, '0x25:0x05': 30, '0x25:0x06': 0,
  '0x28:0x01': 1, '0x28:0x02': 8, '0x28:0x03': 4,
  '0x2b:0x01': 1, '0x2b:0x02': 4, '0x2b:0x03': 12, '0x2b:0x04': 4,
  '0x2c:0x01': 0, '0x2c:0x02': 175, '0x2c:0x03': 0x0f, '0x2c:0x04': 0, '0x2c:0x05': 0, '0x2c:0x06': 0, '0x2c:0x07': 1, '0x2c:0x08': 500,
  '0x16:0x01': 1, '0x16:0x02': 8, '0x16:0x03': 1, '0x16:0x04': 0xffff, '0x16:0x05': 1,
};
// channel:id -> { addr: address bytes, len: payload length, def(addr) -> default payload }
const zeros = (n) => new Array(n).fill(0);
const TABLES = {
  '0x2a:0x50': { addr: 1, len: 9, def: (a) => [a[0], ...u16(200), 0, 0, 0, 0, 1, 0] },
  '0x2a:0x52': { addr: 1, len: 29, def: (a) => (a[0] < 38 ? [a[0], 0, a[0], ...NAME(`Key ${a[0]}`)] : [a[0], 1, 0xff, ...NAME(a[0] === 38 ? 'Combo hold-tap' : 'Autoshift hold-tap')]) },
  '0x24:0x12': { addr: 1, len: 21, def: (a) => [a[0], 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff] },
  '0x25:0x10': { addr: 2, len: 7, def: (a) => [...a, 0, 0, 0, 0, 0] },
  '0x28:0x50': { addr: 2, len: 13, def: (a) => [...a, ...zeros(11)] },
  '0x28:0x51': { addr: 1, len: 3, def: (a) => [a[0], 0, 0] },
  '0x28:0x52': { addr: 1, len: 3, def: (a) => [a[0], 0, 0] },
  '0x28:0x53': { addr: 1, len: 3, def: (a) => [a[0], 0, 0] },
  '0x28:0x54': { addr: 1, len: 2, def: (a) => [a[0], 0] },
  '0x2b:0x50': { addr: 1, len: 9, def: (a) => [a[0], 0, ...zeros(7)] },
  '0x2b:0x51': { addr: 2, len: 13, def: (a) => [...a, ...zeros(11)] },
  '0x2b:0x52': { addr: 1, len: 12, def: (a) => [a[0], ...zeros(11)] },
  '0x16:0x50': { addr: 1, len: 11, def: (a) => [a[0], ...zeros(10)] },
};
const key = (ch, id) => `0x${ch.toString(16).padStart(2, '0')}:0x${id.toString(16).padStart(2, '0')}`;
const usage = (id, page = 7) => ((page << 16) | id) >>> 0;

// The phone tunnel's allowlist (Totem-ZMK src/phone_remote/remote_proto.c k_flask_channels). Anything else is refused
// with ATT 0x13 (0x0D for frames under 5 bytes), which surfaces as a rejected write exactly like the BLE tunnel.
const ALLOWED = new Set([0x11, 0x16, 0x19, 0x24, 0x25, 0x28, 0x2a, 0x2b, 0x2c]);
const DENIED_VALUES = { 0x25: [0x06], 0x2a: [0x54] };
export function tunnelAllows(frame) {
  const [cmd, ch, id] = frame;
  if (![CMD.set, CMD.get, CMD.save].includes(cmd)) return false;
  if (ch === 0x00) return cmd === CMD.get && (id === 0x01 || id === 0x03);
  return ALLOWED.has(ch) && !(DENIED_VALUES[ch] ?? []).includes(id);
}

export class DemoFlaskIo {
  constructor() {
    this.values = new Map(); this.rows = new Map(); this.onFrame = () => {}; this.log = []; this.saves = []; this.refused = [];
    // seeds so the demo is not empty
    this._put('0x24:0x12', [0, 14, 15, 0xff, 0xff, 1, 0, 0, ...u32(usage(0x29)), ...u32(0), 0, 0, 0, 0, 0xff]); // combo 0: two keys -> Esc
    this._put('0x25:0x10', [0, 0, 1, ...u32(usage(0x0b))]); this._put('0x25:0x10', [0, 1, 1, ...u32(usage(0x0c))]);                  // macro 0: "hi"
    this._put('0x28:0x50', [0, 0, 1, 0, 0, ...u32(usage(0x04)), ...u32(0)]); this._put('0x28:0x50', [0, 1, 1, 0, 0, ...u32(usage(0x05)), ...u32(0)]); // td 0: a, b
    this._put('0x28:0x51', [0, ...u16(220)]);
    this._put('0x16:0x50', [0, ...u32(usage(0x37)), ...u32(usage(0x38)), 2, 0]);                                                     // . -> / on shift
    this._put('0x2b:0x50', [0, 0, ...u32(usage(0x0b)), ...u16(300), 0]); this._put('0x2b:0x51', [0, 0, 1, 0, 0, ...u32(usage(0x0f)), ...u32(0)]); // adaptive 0
    this._put('0x2a:0x50', [14, ...u16(260), ...u16(0), ...u16(0), 1, 1]);
  }
  _put(k, payload) { const t = TABLES[k]; this.rows.set(`${k}:${payload.slice(0, t.addr).join(',')}`, payload.slice(0, t.len)); }
  _reply(cmd, ch, id, payload = []) { const r = new Uint8Array(32); r.set([cmd, ch, id, ...payload].slice(0, 32)); return r; }

  async write(frame) {
    const [cmd, ch, id, ...p] = frame, k = key(ch, id);
    this.log.push(Array.from(frame));
    if (frame.length < 5) { this.refused.push(Array.from(frame)); throw new Error('ATT error 0x0D (invalid attribute length)'); }
    if (!tunnelAllows(frame)) { this.refused.push(Array.from(frame)); throw new Error('ATT error 0x13 (value not allowed)'); }
    let reply;
    if (cmd === CMD.save) { this.saves.push(ch); reply = this._reply(CMD.save, ch, 0); }
    else if (TABLES[k]) {
      const t = TABLES[k], addr = p.slice(0, t.addr), rk = `${k}:${addr.join(',')}`;
      if (cmd === CMD.get) reply = this._reply(CMD.get, ch, id, this.rows.get(rk) ?? t.def(addr));
      else if (cmd === CMD.set) {
        let data = p.slice(0, t.len);
        while (data.length < t.len) data.push(0);
        if (k === '0x2a:0x50') { // clamp term like the firmware, echo what stuck; term 0 resets the slot
          const term = (data[1] << 8) | data[2];
          data = term === 0 ? t.def(addr) : [data[0], ...u16(Math.max(50, Math.min(1000, term))), ...data.slice(3, 8), 1];
        }
        this.rows.set(rk, data); reply = this._reply(CMD.set, ch, id, data);
      }
    } else if (k in VALUES) {
      if (cmd === CMD.get) reply = this._reply(CMD.get, ch, id, u16(this.values.get(k) ?? VALUES[k]));
      else if (cmd === CMD.set) { const v = (p[0] << 8) | p[1]; this.values.set(k, v); reply = this._reply(CMD.set, ch, id, u16(v)); }
    }
    reply ??= this._reply(CMD.unhandled, ch, id);
    setTimeout(() => this.onFrame(reply), 2);
  }
  async close() {}
}
