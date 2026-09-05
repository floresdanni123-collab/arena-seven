import { buildKeeperIntent, applyKeeperIntent } from './PlayerIntent.js';

/**
 * Human goalkeeper controls (see PlayerIntent.js for the shared build/apply logic).
 *   WASD move (fast lateral shuffle inside the box), Shift rush, mouse aim.
 *   No ball:   LMB dive toward the aim (height from camera pitch), RMB catch/smother nearby ball,
 *              E rush-and-smother a loose ball, Q quick lateral shuffle burst.
 *   With ball: LMB powerful kick, RMB hold/release = throw (short hold = roll).
 * Hands are only usable inside the keeper's own penalty area (GoalkeeperSkills enforces it).
 */
export class GoalkeeperController {
  constructor(input, camera) {
    this.input = input;
    this.camera = camera;
    this.player = null;
    this.enabled = true;
    this.mode = 'normal';
    this.onSwitchRequest = null;
    this.onCycleRequest = null;
    this.onToast = null;
    this.shiftLock = null;
    this.state = { rushCooldown: 0, shuffleCooldown: 0, holdTime: 0 };
    this.lastToast = 0;
    this.lastIntent = null;
  }

  setPlayer(player) {
    if (this.player) { this.player.cancelCharge(); this.player.faceAim = false; this.player.accelMult = 1; }
    this.player = player;
    this.state.holdTime = 0;
  }

  toast(text, world) {
    if (world.time - this.lastToast < 1.2) return;
    this.lastToast = world.time;
    if (this.onToast) this.onToast(text);
  }

  update(dt, world) {
    const p = this.player;
    if (!p) return;
    const md = this.input.consumeMouseDelta();
    this.camera.applyMouse(md.x, md.y);
    if (!this.enabled) { p.setMoveInput(0, 0, false); return; }
    const intent = buildKeeperIntent(this.input, this.camera, this.shiftLock, this.mode);
    this.lastIntent = intent;
    applyKeeperIntent(p, intent, world, { mode: this.mode, state: this.state, dt, toast: (t) => this.toast(t, world), onCycle: this.onCycleRequest, onNearest: this.onSwitchRequest });
  }
}
