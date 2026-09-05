import { buildOutfieldIntent, applyOutfieldIntent } from './PlayerIntent.js';

/**
 * Translates keyboard/mouse input into an intent for the human-controlled outfield player and applies
 * it (see PlayerIntent.js for the shared build/apply logic). Modes:
 *   normal   - free play: WASD move, LMB hard kick, RMB (hold) low kick, E tackle, Q juke, TAB/SPACE switch
 *   setpiece - free kick / corner / goal kick taker: aim + kick, no movement
 *   throwin  - thrower: RMB hold = throw power, LMB strong throw
 *   penalty  - LMB power shot, RMB hold controlled shot; the run-up is handled by the SetPieceManager
 *   hold     - somebody else is taking a restart: look around only
 * The last built intent is exposed so the network client can send it to the server.
 */
export class PlayerController {
  constructor(input, camera) {
    this.input = input;
    this.camera = camera;
    this.player = null;
    this.enabled = true;
    this.mode = 'normal';
    this.onSwitchRequest = null;
    this.onCycleRequest = null;
    this.onToast = null;
    this.setPieces = null;
    this.shiftLock = null; // ShiftLockController, set by the match
    this.lastIntent = null;
  }

  setPlayer(player) {
    if (this.player) { this.player.cancelCharge(); this.player.faceAim = false; }
    this.player = player;
  }

  update(dt, world) {
    const p = this.player;
    if (!p) return;
    const md = this.input.consumeMouseDelta();
    this.camera.applyMouse(md.x, md.y);
    if (!this.enabled) { p.setMoveInput(0, 0, false); return; }
    const intent = buildOutfieldIntent(this.input, this.camera, this.shiftLock, this.mode);
    this.lastIntent = intent;
    applyOutfieldIntent(p, intent, world, { mode: this.mode, setPieces: this.setPieces, onCycle: this.onCycleRequest, onNearest: this.onSwitchRequest });
  }
}
