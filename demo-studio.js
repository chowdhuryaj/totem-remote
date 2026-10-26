// A fake Studio server backed by TOTEM_DEFAULT, same method names as the vendored StudioClient.
// Lets the Keymap tab run without a dongle (demo mode) and under `node --test`.
import { TOTEM_DEFAULT } from './vendor/flask/zmk-totem-default.js';

const copy = (x) => JSON.parse(JSON.stringify(x));
const MAX_LAYERS = 16;

export class DemoStudio extends EventTarget {
  constructor() {
    super();
    this.connected = true;
    this.layers = TOTEM_DEFAULT.layers.map((l, i) => ({ id: i, name: l.name, bindings: l.bindings.map(([behaviorId, param1, param2]) => ({ behaviorId, param1, param2 })) }));
    this.nextId = this.layers.length;
    this.saved = copy(this.layers);
    this.dirty = false;
    this.calls = [];
  }
  _touch(call) { this.calls.push(call); this.dirty = true; this.dispatchEvent(new CustomEvent('unsaved', { detail: true })); }
  async getDeviceInfo() { return { name: 'Totem (demo)', serialNumber: new Uint8Array() }; }
  async getLockState() { return 1; }
  async getKeymap() {
    return { layers: copy(this.layers), availableLayers: MAX_LAYERS - this.layers.length, maxLayerNameLength: 20 };
  }
  async listAllBehaviors() { return TOTEM_DEFAULT.behaviors.map((b) => b.id); }
  async getBehaviorDetails(id) {
    const b = TOTEM_DEFAULT.behaviors.find((x) => x.id === id);
    if (!b) throw new Error('unknown behavior ' + id);
    return { id: b.id, displayName: b.displayName, metadata: copy(b.metadata) };
  }
  async setLayerBinding(layerId, keyPosition, binding) {
    const l = this.layers.find((x) => x.id === layerId);
    if (!l || keyPosition < 0 || keyPosition >= l.bindings.length) throw new Error('INVALID_LOCATION');
    if (!TOTEM_DEFAULT.behaviors.some((b) => b.id === binding.behaviorId)) throw new Error('INVALID_BEHAVIOR');
    l.bindings[keyPosition] = { behaviorId: binding.behaviorId, param1: binding.param1 >>> 0, param2: binding.param2 >>> 0 };
    this._touch(`setLayerBinding ${layerId} ${keyPosition} ${binding.behaviorId} ${binding.param1 >>> 0} ${binding.param2 >>> 0}`);
  }
  async setLayerProps(layerId, name) {
    const l = this.layers.find((x) => x.id === layerId);
    if (!l) throw new Error('INVALID_ID');
    l.name = name; this._touch(`setLayerProps ${layerId} ${name}`);
  }
  async moveLayer(from, to) {
    if (from < 0 || from >= this.layers.length || to < 0 || to >= this.layers.length) throw new Error('INVALID_DESTINATION');
    this.layers.splice(to, 0, ...this.layers.splice(from, 1)); this._touch(`moveLayer ${from} ${to}`);
    return this.getKeymap();
  }
  async addLayer() {
    if (this.layers.length >= MAX_LAYERS) throw new Error('NO_SPACE');
    const layer = { id: this.nextId++, name: 'New', bindings: this.layers[0].bindings.map(() => ({ behaviorId: 2, param1: 0, param2: 0 })) };
    this.layers.push(layer); this._touch('addLayer');
    return { index: this.layers.length - 1, layer: copy(layer) };
  }
  async removeLayer(index) {
    if (index < 0 || index >= this.layers.length) throw new Error('INVALID_INDEX');
    this.layers.splice(index, 1); this._touch(`removeLayer ${index}`);
  }
  async checkUnsavedChanges() { return this.dirty; }
  async saveChanges() { this.saved = copy(this.layers); this.dirty = false; this.calls.push('saveChanges'); this.dispatchEvent(new CustomEvent('unsaved', { detail: false })); }
  async discardChanges() { this.layers = copy(this.saved); this.dirty = false; this.calls.push('discardChanges'); this.dispatchEvent(new CustomEvent('unsaved', { detail: false })); }
  async disconnect() { this.connected = false; this.dispatchEvent(new CustomEvent('disconnect')); }
}
