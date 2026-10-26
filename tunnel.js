// Flask tunnel: the phone-side equivalent of webhid.js's FlaskHID. FlaskProto only needs
// request(prefix, echoBytes, opts) -> Promise<32-byte reply>, so the vendored codecs run unchanged.
// One frame (1-32 bytes) per write, one 32-byte notify per reply, no fragmentation.
import { TUNNEL_CHAR, SERVICE } from './protocol.js';

export class TunnelError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

export class TunnelHID extends EventTarget {
  /** io: { write(Uint8Array) -> Promise, onFrame: set by us, close() } */
  constructor(io) {
    super();
    this.io = io; this._chain = Promise.resolve(); this._pending = null;
    io.onFrame = (b) => this._onFrame(b);
  }
  pause() {} resume() {}   // webhid.js polls the HUD; nothing polls here

  _onFrame(b) {
    const p = this._pending;
    if (p && p.matches(b)) { clearTimeout(p.timer); this._pending = null; p.resolve(b); }
  }
  _enqueue(fn) {
    const run = this._chain.then(fn, fn);
    this._chain = run.then(() => {}, () => {});
    return run;
  }
  _sendOnce(prefix, matches, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending) { this._pending = null; reject(new TunnelError('timeout', 'Keyboard did not answer in time')); }
      }, timeoutMs);
      this._pending = { matches, resolve, reject, timer };
      // The firmware refuses frames under 5 bytes (ATT 0x0D); u16 gets are 3 bytes, so pad with zeros.
      const frame = Uint8Array.from([...prefix.slice(0, 32), 0, 0, 0, 0, 0].slice(0, Math.max(5, Math.min(prefix.length, 32))));
      Promise.resolve().then(() => this.io.write(frame)).catch((e) => {
        clearTimeout(timer); this._pending = null;
        reject(new TunnelError('writeFailed', /0x82|not permitted|authoriz/i.test(String(e?.message)) ? 'Config window is closed' : `Tunnel write failed: ${e?.message ?? e}`));
      });
    });
  }
  // Same retry shape as webhid.js: a timeout is retried after a drain gap, any other error is final.
  async _send(prefix, matches, { timeoutMs = 500, retries = 2 } = {}) {
    for (let a = 0; a < retries; a++) {
      try { return await this._sendOnce(prefix, matches, timeoutMs); }
      catch (e) { if (e.kind !== 'timeout') throw e; await new Promise((r) => setTimeout(r, 250)); }
    }
    return this._sendOnce(prefix, matches, timeoutMs);
  }
  /** Match on the echoed (channel, value id) and the first `echoBytes` payload bytes. */
  request(prefix, echoBytes = 0, opts = undefined) {
    const ch = prefix[1] ?? 0, id = prefix[2] ?? 0, echo = prefix.slice(3, 3 + echoBytes);
    return this._enqueue(() => this._send(prefix, (r) => r[1] === ch && r[2] === id && echo.every((b, i) => r[3 + i] === b), opts));
  }
  async close() { try { await this.io.close?.(); } catch { /* link gone */ } }
}

/** Real transport over the connected remote's GATT service. Subscribes to notifications only now,
 * i.e. while the config window is open (the caller checks Status first). */
export async function openBleTunnel(device) {
  const server = device.gatt.connected ? device.gatt : await device.gatt.connect();
  const svc = await server.getPrimaryService(SERVICE);
  const ch = await svc.getCharacteristic(TUNNEL_CHAR);
  const io = { onFrame: () => {}, write: (b) => (ch.writeValueWithResponse || ch.writeValue).call(ch, b) };
  const onValue = (e) => { const v = e.target.value; io.onFrame(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)); };
  ch.addEventListener('characteristicvaluechanged', onValue);
  await ch.startNotifications();
  io.close = async () => { ch.removeEventListener('characteristicvaluechanged', onValue); try { await ch.stopNotifications(); } catch { /* ignore */ } };
  return new TunnelHID(io);
}
