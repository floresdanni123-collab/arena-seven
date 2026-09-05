import * as THREE from 'three';
import { GoalkeeperSkills } from './GoalkeeperSkills.js';
import { GOALKEEPER, KICK, BALL_STATE, PLAYER_STATE as S, SET_PIECE } from '../utils/Constants.js';
import { clamp, lerp } from '../utils/MathUtils.js';

const dir = new THREE.Vector3(), tmp = new THREE.Vector3(), left = new THREE.Vector3();

/**
 * Human goalkeeper controls.
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
    this.rushCooldown = 0;
    this.shuffleCooldown = 0;
    this.holdTime = 0;
    this.lastToast = 0;
    this.onToast = null;
  }

  setPlayer(player) {
    if (this.player) { this.player.cancelCharge(); this.player.faceAim = false; this.player.accelMult = 1; }
    this.player = player;
    this.holdTime = 0;
  }

  toast(text, world) {
    if (world.time - this.lastToast < 1.2) return;
    this.lastToast = world.time;
    if (this.onToast) this.onToast(text);
  }

  update(dt, world) {
    const p = this.player;
    if (!p) return;
    const input = this.input;
    const md = input.consumeMouseDelta();
    this.camera.applyMouse(md.x, md.y);
    this.rushCooldown = Math.max(0, this.rushCooldown - dt);
    this.shuffleCooldown = Math.max(0, this.shuffleCooldown - dt);
    if (!this.enabled) { p.setMoveInput(0, 0, false); return; }

    const ball = world.ball;
    const held = ball.owner === p && ball.state === BALL_STATE.GOALKEEPER_HELD;
    const inBox = GoalkeeperSkills.inOwnBox(p);
    p.accelMult = inBox ? 1.7 : 1.0;

    // Movement (locked while taking a set piece)
    const axis = input.getMoveAxis();
    this.camera.inputToWorld(axis.x, axis.z, dir);
    const sprint = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
    if (this.mode === 'setpiece') p.setMoveInput(0, 0, false); else p.setMoveInput(dir.x, dir.z, sprint);
    p.setAim(this.camera.aimDir, this.camera.aimPitch);
    p.faceAim = axis.x === 0 && axis.z === 0 || held;

    if (input.wasPressed('Tab') && this.onCycleRequest) this.onCycleRequest();
    if (input.wasPressed('Space') && this.onSwitchRequest) this.onSwitchRequest();

    if (held) { this.updateWithBall(dt, world, p); return; }
    this.holdTime = 0;

    // --- No ball ---
    if (input.wasMousePressed(0) && p.sm.isLocomotion()) {
      // Dive toward the aim direction; height from camera pitch.
      left.set(p.facingDir.z, 0, -p.facingDir.x);
      const lateral = this.camera.aimDir.dot(left);
      const side = lateral >= 0 ? 1 : -1;
      const pitch = this.camera.aimPitch;
      const height = pitch > 0.14 ? 'high' : pitch < -0.12 ? 'low' : 'mid';
      const speed = clamp(5 + Math.abs(lateral) * 4, 5, 9);
      GoalkeeperSkills.dive(world, p, side, height, speed);
      p.diveManual = true;
      if (!inBox) this.toast('NO HANDS OUTSIDE THE BOX', world);
    }
    if (input.wasMousePressed(2)) {
      if (!GoalkeeperSkills.inOwnBox(p)) this.toast('NO HANDS OUTSIDE THE BOX', world);
      else if (!GoalkeeperSkills.trySmother(world, p, 1.45)) this.toast('TOO FAR TO CATCH', world);
    }
    if (input.wasPressed('KeyE') && this.rushCooldown <= 0 && p.sm.isLocomotion()) {
      const d = p.position.distanceTo(ball.position);
      if (!ball.owner && d < 4.5 && GoalkeeperSkills.inOwnBox(p)) {
        // Rush: dive at the ball along the ground.
        tmp.subVectors(ball.position, p.position).setY(0);
        left.set(p.facingDir.z, 0, -p.facingDir.x);
        const side = tmp.dot(left) >= 0 ? 1 : -1;
        // Dive direction is lateral; turn to face the ball first so the lunge goes the right way.
        p.facing = Math.atan2(tmp.x, tmp.z) - side * Math.PI / 2;
        GoalkeeperSkills.dive(world, p, side, 'low', clamp(d * 2.2, 4, 8));
        p.diveManual = true;
        this.rushCooldown = 2.5;
      } else {
        this.toast(GoalkeeperSkills.inOwnBox(p) ? 'NO LOOSE BALL NEARBY' : 'NO HANDS OUTSIDE THE BOX', world);
      }
    }
    if (input.wasPressed('KeyQ') && this.shuffleCooldown <= 0 && p.sm.isLocomotion()) {
      // Quick lateral shuffle burst in the input direction (A/D), or toward the aim side.
      left.set(p.facingDir.z, 0, -p.facingDir.x);
      let side = 0;
      if (axis.x < -0.3) side = 1; else if (axis.x > 0.3) side = -1;
      if (!side) side = this.camera.aimDir.dot(left) >= 0 ? 1 : -1;
      p.velocity.addScaledVector(left, side * 6.5);
      p.anim.playAction(side > 0 ? 'jukeLeft' : 'jukeRight', { fade: 0.05, duration: 0.35, params: { style: 0 } });
      this.shuffleCooldown = 1.6;
      world.audio.play('slide', { volume: 0.25, pitch: 1.6 });
    }
  }

  updateWithBall(dt, world, p) {
    const input = this.input;
    this.holdTime += dt;
    // Distribution
    if (input.wasMousePressed(0)) {
      const lift = lerp(KICK.HARD_MIN_LIFT, KICK.HARD_MAX_LIFT, clamp((this.camera.aimPitch + 0.12) / 0.55, 0, 1));
      const target = p.findPassTarget(world, this.camera.aimDir, 0.2);
      p.startKickOut(this.camera.aimDir.clone(), GOALKEEPER.KICK_SPEED, lift, world, target ? target.player : null);
      return;
    }
    if (input.wasMousePressed(2)) p.beginCharge();
    if (p.charging && (input.wasMouseReleased(2) || !input.isMouseDown(2))) {
      const power = p.chargePower;
      p.cancelCharge();
      const target = p.findPassTarget(world, this.camera.aimDir, KICK.PASS_ASSIST_CONE);
      dir.copy(this.camera.aimDir);
      if (target) {
        const bend = clamp(target.angle, -KICK.PASS_ASSIST_MAX_BEND, KICK.PASS_ASSIST_MAX_BEND);
        dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), bend);
      }
      const speed = lerp(SET_PIECE.THROW_MIN_SPEED, GOALKEEPER.THROW_SPEED + 2, power);
      const lift = power < 0.25 ? 0.15 : lerp(1.2, 3.2, power); // short hold = roll along the ground
      p.startThrow(dir.clone(), speed, lift, world, target ? target.player : null, power);
      return;
    }
    // Keeper may only hold for a limited time: auto-clear.
    if (this.holdTime > 7 && p.sm.is(S.HOLDING)) {
      p.startKickOut(this.camera.aimDir.clone(), GOALKEEPER.KICK_SPEED, 7, world);
    }
  }
}
