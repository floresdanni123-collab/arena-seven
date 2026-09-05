import * as THREE from 'three';
import { BALL_STATE, CONTROL, PLAYER_STATE as S } from '../utils/Constants.js';
import { clamp } from '../utils/MathUtils.js';

const target = new THREE.Vector3(), tmp = new THREE.Vector3(), rel = new THREE.Vector3();

/**
 * Decides who controls the ball and keeps a controlled ball "on a string" in front of the owner's
 * feet using a spring, not parenting. The ball remains a physics object throughout: strong impacts
 * (tackles, collisions) can knock it loose and the owner can outrun it.
 */
export class PossessionSystem {
  constructor() {
    this.owner = null;
    this.teamPossessionTime = [0, 0];
    this.lastOwner = null;
    this.onGain = null; // (player, ball) => void
    this.onLose = null;
  }

  release(ball) {
    if (ball.owner) {
      ball.owner.hasBall = false;
      this.lastOwner = ball.owner;
      if (this.onLose) this.onLose(ball.owner, ball);
    }
    ball.owner = null;
    this.owner = null;
    if (ball.state === BALL_STATE.CONTROLLED || ball.state === BALL_STATE.DRIBBLING || ball.state === BALL_STATE.GOALKEEPER_HELD) ball.state = BALL_STATE.FREE;
  }

  assign(ball, player, state = BALL_STATE.CONTROLLED) {
    if (ball.owner === player) {
      // Same owner, different kind of control (e.g. keeper picks up a ball from their feet).
      if (ball.state !== state) { ball.state = state; ball.frozen = false; if (state === BALL_STATE.GOALKEEPER_HELD) ball.recordTouch(player, 'KEEPER_TOUCH'); }
      return;
    }
    if (ball.owner) { ball.owner.hasBall = false; this.lastOwner = ball.owner; }
    ball.owner = player;
    this.owner = player;
    player.hasBall = true;
    ball.state = state;
    ball.frozen = false;
    ball.recordTouch(player, state === BALL_STATE.GOALKEEPER_HELD ? 'KEEPER_TOUCH' : 'DRIBBLE');
    ball.spin.set(0, 0, 0);
    if (this.onGain) this.onGain(player, ball);
  }

  update(dt, ball, players, time) {
    const owner = ball.owner;
    // Set pieces: nobody may take a dead ball until it is put back into play.
    if (this.locked && (!owner || ball.state !== BALL_STATE.GOALKEEPER_HELD)) {
      if (owner && ball.state === BALL_STATE.GOALKEEPER_HELD) this.updateHeld(ball, owner);
      return;
    }
    if (owner) {
      this.teamPossessionTime[owner.team] += dt;
      if (ball.state === BALL_STATE.GOALKEEPER_HELD) {
        this.updateHeld(ball, owner);
        return;
      }
      // Can the owner still control it?
      if (!owner.sm.canControlBall()) {
        this.release(ball);
        ball.state = BALL_STATE.LOOSE;
      } else {
        this.updateControlled(dt, ball, owner);
      }
      return;
    }

    // Free ball: who can take it?
    if (ball.state === BALL_STATE.GOALKEEPER_HELD) ball.state = BALL_STATE.FREE;
    let best = null, bestScore = Infinity;
    for (const p of players) {
      if (!p.sm.canControlBall() || p.sm.is(S.KICKING)) continue;
      if (p.kickImmunity > 0 && ball.lastTouch === p) continue;
      const dx = ball.position.x - p.position.x, dz = ball.position.z - p.position.z;
      const d = Math.hypot(dx, dz);
      const reach = CONTROL.RADIUS * (p.isGoalkeeper ? 1.15 : 1);
      if (d > reach || ball.position.y > 1.1) continue;
      rel.subVectors(ball.velocity, p.velocity);
      const relSpeed = Math.hypot(rel.x, rel.z);
      const maxCapture = p.isGoalkeeper ? CONTROL.CAPTURE_MAX_SPEED * 1.4 : CONTROL.CAPTURE_MAX_SPEED;
      if (relSpeed > maxCapture) continue;
      // Prefer players the ball is moving towards / who face the ball
      const facingDot = d > 0.05 ? (dx * p.facingDir.x + dz * p.facingDir.z) / d : 1;
      const score = d - facingDot * 0.25 + relSpeed * 0.02;
      if (score < bestScore) { bestScore = score; best = p; }
    }
    if (best) {
      // A fast ball is "trapped": kill most of its relative velocity
      this.assign(ball, best, BALL_STATE.CONTROLLED);
      ball.velocity.multiplyScalar(0.25);
      ball.velocity.y = 0;
      if (ball.position.y > ball.radius + 0.05) ball.position.y = ball.radius;
    }
  }

  updateControlled(dt, ball, owner) {
    owner.getControlPoint(target, ball);
    tmp.subVectors(target, ball.position);
    tmp.y = 0;
    const dist = tmp.length();

    // Too far away: the ball is loose (owner outran it, or it was knocked away)
    if (dist > CONTROL.LOSE_DISTANCE) {
      this.release(ball);
      ball.state = BALL_STATE.LOOSE;
      return;
    }
    ball.state = owner.speed > 0.8 ? BALL_STATE.DRIBBLING : BALL_STATE.CONTROLLED;

    // Spring-damper toward the control point, plus feed-forward of the owner's velocity so the ball
    // is pushed ahead naturally while running and doesn't lag behind.
    const stiffness = CONTROL.SPRING * (owner.sm.is(S.JUKING) ? 1.6 : 1);
    const damping = CONTROL.DAMPING;
    const ax = tmp.x * stiffness - (ball.velocity.x - owner.velocity.x) * damping;
    const az = tmp.z * stiffness - (ball.velocity.z - owner.velocity.z) * damping;
    ball.velocity.x += ax * dt;
    ball.velocity.z += az * dt;
    // Sprinting gives longer, looser touches: reduce the pull so the ball runs a bit ahead.
    if (owner.sprintInput && owner.speed > 7) {
      ball.velocity.x = ball.velocity.x * 0.985 + owner.velocity.x * 0.015 * 1.08;
      ball.velocity.z = ball.velocity.z * 0.985 + owner.velocity.z * 0.015 * 1.08;
    }
    // Keep it on the ground while dribbling
    if (ball.position.y > ball.radius + 0.02) ball.velocity.y -= 12 * dt;
    else { ball.velocity.y = 0; ball.position.y = ball.radius; }
    const maxRel = 4.5;
    rel.subVectors(ball.velocity, owner.velocity);
    const rs = Math.hypot(rel.x, rel.z);
    if (rs > maxRel) { const f = maxRel / rs; ball.velocity.x = owner.velocity.x + rel.x * f; ball.velocity.z = owner.velocity.z + rel.z * f; }
  }

  updateHeld(ball, keeper) {
    keeper.getHeldBallPosition(target);
    ball.position.copy(target);
    ball.velocity.set(0, 0, 0);
    ball.spin.set(0, 0, 0);
  }

  possessionShare() {
    const total = this.teamPossessionTime[0] + this.teamPossessionTime[1];
    return total > 0 ? this.teamPossessionTime[0] / total : 0.5;
  }

  reset() { this.owner = null; this.lastOwner = null; }
}
