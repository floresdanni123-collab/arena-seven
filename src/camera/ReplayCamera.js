import * as THREE from 'three';
import { PITCH } from '../utils/Constants.js';
import { damp, clamp } from '../utils/MathUtils.js';

const tmp = new THREE.Vector3();

/**
 * Cinematic camera rigs used by replays. Each shot type turns the current ball position (from the
 * recorded snapshot) plus event context into a camera position and look-at, with damping so the
 * tracking feels operated rather than locked.
 *
 * Shot types: broadcast, behindGoal, behindShooter, lowSideline, closeUp
 */
export class ReplayCamera {
  constructor() {
    this.position = new THREE.Vector3();
    this.lookAt = new THREE.Vector3();
    this.shot = 'broadcast';
    this.context = { goalSide: 1, shooterPos: new THREE.Vector3(), shotDir: new THREE.Vector3(0, 0, 1) };
    this.initialised = false;
    this.targetPos = new THREE.Vector3();
    this.targetLook = new THREE.Vector3();
  }

  setShot(shot, context, snapBall) {
    this.shot = shot;
    if (context) Object.assign(this.context, context);
    this.initialised = false;
    if (snapBall) this.compute(snapBall);
    this.position.copy(this.targetPos);
    this.lookAt.copy(this.targetLook);
    this.initialised = true;
  }

  compute(ball) {
    const s = this.context.goalSide;
    const goalZ = s * PITCH.HALF_LENGTH;
    switch (this.shot) {
      case 'behindGoal':
        this.targetPos.set(clamp(ball.x * 0.35, -6, 6), 3.4, goalZ + s * 6.5);
        this.targetLook.set(ball.x, Math.max(0.6, ball.y), ball.z);
        break;
      case 'behindShooter': {
        const sp = this.context.shooterPos;
        tmp.copy(this.context.shotDir).setY(0);
        if (tmp.lengthSq() < 1e-4) tmp.set(0, 0, s);
        tmp.normalize();
        this.targetPos.set(sp.x - tmp.x * 5.5, 2.6, sp.z - tmp.z * 5.5);
        this.targetLook.set(ball.x, Math.max(0.8, ball.y), ball.z);
        break;
      }
      case 'lowSideline': {
        const side = ball.x >= 0 ? 1 : -1;
        this.targetPos.set(side * (PITCH.HALF_WIDTH + 2.5), 1.3, goalZ - s * 9);
        this.targetLook.set(ball.x, Math.max(0.5, ball.y), ball.z);
        break;
      }
      case 'closeUp':
        this.targetPos.set(ball.x + 3.5, 1.6, ball.z - s * 4);
        this.targetLook.set(ball.x, ball.y + 0.3, ball.z);
        break;
      default: { // broadcast: TV gantry on the west side in front of the stand roof, following the ball
        this.targetPos.set(-PITCH.HALF_WIDTH - 7.5, 12.5, clamp(ball.z * 0.7, -PITCH.HALF_LENGTH * 0.75, PITCH.HALF_LENGTH * 0.75));
        this.targetLook.set(ball.x * 0.6, 0.8, ball.z);
      }
    }
  }

  update(dt, ball) {
    this.compute(ball);
    if (!this.initialised) { this.position.copy(this.targetPos); this.lookAt.copy(this.targetLook); this.initialised = true; return; }
    const posLambda = this.shot === 'broadcast' ? 3 : 6;
    this.position.x = damp(this.position.x, this.targetPos.x, posLambda, dt);
    this.position.y = damp(this.position.y, this.targetPos.y, posLambda, dt);
    this.position.z = damp(this.position.z, this.targetPos.z, posLambda, dt);
    this.lookAt.x = damp(this.lookAt.x, this.targetLook.x, 9, dt);
    this.lookAt.y = damp(this.lookAt.y, this.targetLook.y, 9, dt);
    this.lookAt.z = damp(this.lookAt.z, this.targetLook.z, 9, dt);
  }
}
