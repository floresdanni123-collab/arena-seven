import * as THREE from 'three';
import { KICK, SET_PIECE } from '../utils/Constants.js';
import { clamp, lerp } from '../utils/MathUtils.js';

const dir = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Translates keyboard/mouse input into intents on the human-controlled outfield player, relative to
 * the third-person camera. Modes:
 *   normal   - free play: WASD move, LMB hard kick, RMB (hold) low kick, E tackle, Q juke, TAB/SPACE switch
 *   setpiece - free kick / corner / goal kick taker: aim + kick, no movement
 *   throwin  - thrower: RMB hold = throw power, LMB strong throw
 *   penalty  - LMB power shot, RMB hold controlled shot; the run-up is handled by the SetPieceManager
 *   hold     - somebody else is taking a restart: look around only
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
  }

  setPlayer(player) {
    if (this.player) { this.player.cancelCharge(); this.player.faceAim = false; }
    this.player = player;
  }

  update(dt, world) {
    const p = this.player;
    if (!p) return;
    const input = this.input;

    // Camera look
    const md = input.consumeMouseDelta();
    this.camera.applyMouse(md.x, md.y);
    if (!this.enabled) { p.setMoveInput(0, 0, false); return; }

    // Switching is always available except mid-run-up
    if (input.wasPressed('Tab') && this.onCycleRequest) this.onCycleRequest();
    if (input.wasPressed('Space') && this.mode === 'normal' && this.onSwitchRequest) this.onSwitchRequest();

    p.setAim(this.camera.aimDir, this.camera.aimPitch);
    switch (this.mode) {
      case 'hold': p.setMoveInput(0, 0, false); p.faceAim = false; return;
      case 'setpiece': this.updateSetPiece(world, p); return;
      case 'throwin': this.updateThrowIn(world, p); return;
      case 'penalty': this.updatePenalty(world, p); return;
      default: this.updateNormal(dt, world, p);
    }
  }

  updateNormal(dt, world, p) {
    const input = this.input;
    const axis = input.getMoveAxis();
    this.camera.inputToWorld(axis.x, axis.z, dir);
    const sprint = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
    p.setMoveInput(dir.x, dir.z, sprint);
    p.faceAim = p.charging || (p.hasBall && axis.x === 0 && axis.z === 0);

    if (input.wasMousePressed(2)) p.beginCharge();
    if (input.wasMouseReleased(2)) p.releaseCharge(world);
    if (p.charging && !input.isMouseDown(2)) p.releaseCharge(world);
    if (input.wasMousePressed(0)) p.hardKick(world);

    if (input.wasPressed('KeyE')) p.requestTackle(world);
    if (input.wasPressed('KeyQ')) {
      let side = 0;
      if (axis.x < -0.3) side = 1; else if (axis.x > 0.3) side = -1;
      p.requestJuke(world, side);
    }
  }

  updateSetPiece(world, p) {
    const input = this.input;
    p.setMoveInput(0, 0, false);
    p.faceAim = true;
    if (input.wasMousePressed(2)) p.beginCharge();
    if (p.charging && (input.wasMouseReleased(2) || !input.isMouseDown(2))) p.releaseCharge(world);
    if (input.wasMousePressed(0)) p.hardKick(world);
  }

  updateThrowIn(world, p) {
    const input = this.input;
    p.setMoveInput(0, 0, false);
    p.faceAim = true;
    if (input.wasMousePressed(2)) p.beginCharge();
    if (p.charging && (input.wasMouseReleased(2) || !input.isMouseDown(2))) {
      const power = p.chargePower;
      p.cancelCharge();
      this.throw(world, p, power);
    }
    if (input.wasMousePressed(0)) this.throw(world, p, 1);
  }

  throw(world, p, power) {
    const target = p.findPassTarget(world, this.camera.aimDir, KICK.PASS_ASSIST_CONE);
    dir.copy(this.camera.aimDir);
    if (target) dir.applyAxisAngle(UP, clamp(target.angle, -KICK.PASS_ASSIST_MAX_BEND, KICK.PASS_ASSIST_MAX_BEND));
    const speed = lerp(SET_PIECE.THROW_MIN_SPEED, SET_PIECE.THROW_MAX_SPEED, power);
    const lift = lerp(1.6, 3.6, power) + clamp(this.camera.aimPitch, -0.2, 0.4) * 3;
    p.throwIn(dir.clone(), speed, lift, world, target ? target.player : null);
  }

  updatePenalty(world, p) {
    const input = this.input;
    p.setMoveInput(0, 0, false);
    p.faceAim = true;
    if (!this.setPieces) return;
    const lift = lerp(KICK.HARD_MIN_LIFT * 0.5, KICK.HARD_MAX_LIFT * 0.55, clamp((this.camera.aimPitch + 0.12) / 0.55, 0, 1));
    if (input.wasMousePressed(0)) {
      this.setPieces.requestPenaltyShot({ type: 'hard', power: 1, dir: this.camera.aimDir.clone(), lift });
      return;
    }
    if (input.wasMousePressed(2)) p.beginCharge();
    if (p.charging && (input.wasMouseReleased(2) || !input.isMouseDown(2))) {
      const power = Math.max(0.55, p.chargePower);
      p.cancelCharge();
      this.setPieces.requestPenaltyShot({ type: 'low', power, dir: this.camera.aimDir.clone(), lift: undefined });
    }
  }
}
