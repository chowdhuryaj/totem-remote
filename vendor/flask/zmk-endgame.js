// efogtech Endgame trackball (ZMK, PCB rev 08, nRF52833) — keymap editing
// over ZMK Studio RPC only. ZMK-line module, import-free so node tests load it.
//
// No Flask raw-HID protocol on this board: everything the keymap tab shows
// (geometry, layers, behavior names) comes over Studio. This file holds only
// what Studio can't say: the USB identity, what each button IS, the unlock
// gesture, and which bindings must not be lost.
//
// Source of truth: chowdhuryaj/endgame-trackball-config @ aj-1.5.3-dongle
// (config/efogtech_trackball_0.keymap, boards/arm/efogtech_trackball_0/).

// efog.tech USB identity (not the stock ZMK 1d50:615e). The board exposes TWO
// CDC ports with this VID/PID: Studio RPC and the Zephyr shell/log console.
export const ENDGAME_VIDPID = { vid: 0x0011, pid: 0x0006 };

export const ENDGAME_LAYER_NAMES = ['Default', 'Extras', 'Device', 'Scroll', 'Snipe', 'User'];

// Key positions as the keymap lists them: 8 buttons in 4 rows of 2, then the
// two rotary encoders, each modeled as two keys (one per direction).
export const ENDGAME_KEY_LABELS = [
    'Top left (Studio Unlock / Snipe)', 'Top right (Esc / Scroll)',
    'Upper left (middle click)', 'Upper right (copy/paste)',
    'Left click', 'Right click',
    'MB4 (Extras)', 'MB5 (Device)',
    'Left wheel up', 'Right wheel up',
    'Left wheel down', 'Right wheel down',
];

export const ENDGAME_UNLOCK_TEXT = 'Studio is locked. On the Endgame, tap the top-left button'
    + ' (or hold MB4 and press right click). Editing resumes on its own.';

// MB5 is physically dead, so the Device layer is unreachable. These two
// Extras-layer bindings are the ONLY way to unlock Studio or leave dongle
// mode. Matched by Studio display name (ids can shift across builds).
export const ENDGAME_PROTECTED = new Map([
    ['Studio Unlock', 'unlock ZMK Studio'],
    ['Hold: layer, tap: Studio Unlock', 'unlock ZMK Studio (top-left tap)'],
    ['Leave dongle (click) or switch to dongle (double-click)', 'leave dongle mode (back to USB)'],
]);

/** Warning text when replacing `oldName` with `newName` would drop a
 * protected binding, else null. */
export function endgameRebindWarning(oldName, newName, where) {
    const role = ENDGAME_PROTECTED.get(oldName);
    if (!role || oldName === newName) return null;
    return `${where} holds "${oldName}". MB5 is dead, so this key is your only way to ${role}.`
        + ' Replace it anyway?';
}

/** Warning text when removing a layer whose bindings include a protected
 * behavior, else null. `names` = display names of the layer's bindings. */
export function endgameRemoveLayerWarning(names, layerName) {
    const hit = names.filter((n) => ENDGAME_PROTECTED.has(n));
    if (!hit.length) return null;
    return `Layer "${layerName}" holds ${hit.map((n) => `"${n}"`).join(' and ')}.`
        + ' MB5 is dead, so removing it can leave you unable to unlock Studio or leave dongle mode. Remove anyway?';
}
