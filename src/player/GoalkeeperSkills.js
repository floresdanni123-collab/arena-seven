import * as THREE from 'three';
import { PITCH, GOALKEEPER, BALL_STATE, PLAYER_STATE as S } from '../utils/Constants.js';
import { FormationSystem } from '../ai/FormationSystem.js';
import { clamp, lerp, gaussian } from '../utils/MathUtils.js';

const tmp = new THREE.Vector3(), hands = new THREE.Vector3(), swept = new THREE.Vector3();

/**
 * Goalkeeper mechanics shared by the AI keeper and the human-controlled keeper: the hand-use rule
 * (hands only inside the keeper's own penalty area), catching, parrying, smothering and the contact
 * test while diving. Keeping these here means both control modes obey exactly the same rules.
 */
export const GoalkeeperSkills = {
  ownGoalZ(keeper) { return -FormationSystem.attackDir(keeper.team) * PITCH.HALF_LENGTH; },
  forward(keeper) { return FormationSystem.attackDir(keeper.team); },

  /** True when the keeper is inside their own penalty area (where hands are allowed). */
  inOwnBox(keeper, margin = 0.2) {
    const goalZ = this.ownGoalZ(keeper), fwd = this.forward(keeper);
    const depth = (keeper.position.z - goalZ) * fwd;
    return Math.abs(keeper.position.x) < PITCH.PENALTY_AREA_WIDTH / 2 + margin && depth > -1 && depth < PITCH.PENALTY_AREA_DEPTH + margin;
  },

  /** Ball inside the keeper's own penalty area. */
  ballInOwnBox(keeper, ball, margin = 0.2) {
    const goalZ = this.ownGoalZ(keeper), fwd = this.forward(keeper);
    const depth = (ball.position.z - goalZ) * fwd;
    return Math.abs(ball.position.x) < PITCH.PENALTY_AREA_WIDTH / 2 + margin && depth > -1 && depth < PITCH.PENALTY_AREA_DEPTH + margin;
  },

  canUseHands(keeper, ball) { return this.inOwnBox(keeper) && this.ballInOwnBox(keeper, ball, 0.6); },

  /** Take the ball into the hands. Returns false (and does nothing) when hands are not allowed. */
  catchBall(world, keeper, { wasDive = false, pickup = false } = {}) {
    const ball = world.ball;
    if (!this.canUseHands(keeper, ball)) return false;
    // A shot counts as saved whether it is caught in flight or trapped at the feet first and then picked up.
    const wasShot = (ball.lastTouchType === 'SHOT' && ball.lastTouchTeam !== keeper.team && ball.speed > 7) ||
      (ball.lastTouchPlayer === keeper && ball.previousTouchType === 'SHOT' && ball.previousTouchTeam !== keeper.team && ball.time - ball.lastTouchTime < 1.5 && (ball.lastShotSpeed || 0) > 7);
    world.possession.assign(ball, keeper, BALL_STATE.GOALKEEPER_HELD);
    if (pickup) keeper.startPickup(); else keeper.startHold(keeper.isHuman ? 8 : GOALKEEPER.HOLD_TIME);
    keeper.holdMode = 'keeper';
    ball.velocity.set(0, 0, 0);
    ball.recordTouch(keeper, 'SAVE');
    world.audio.play('catch', { volume: 0.7 });
    if (wasShot) {
      keeper.stats.saves++;
      world.events.emit('save', { player: keeper, type: 'catch', dive: wasDive, shotSpeed: ball.lastShotSpeed || 0 });
    }
    return true;
  },

  /** Push the ball away with the hands (inside the box) or the body (outside). */
  parry(world, keeper, { body = false } = {}) {
    const ball = world.ball;
    const spd = ball.speed;
    const fwd = this.forward(keeper);
    tmp.set(gaussian() * 0.8 + Math.sign(ball.position.x || gaussian()) * 0.6, body ? 0.25 : 0.45, fwd * 0.8).normalize();
    tmp.multiplyScalar(clamp(spd * (body ? 0.35 : 0.45), 5, 15));
    ball.setVelocity(tmp);
    ball.state = BALL_STATE.LOOSE;
    ball.spin.set(0, 0, 0);
    ball.recordTouch(keeper, body ? 'BLOCK' : 'SAVE');
    keeper.kickImmunity = 0.4;
    keeper.stats.saves++;
    world.audio.play('save', { volume: 0.9 });
    world.events.emit('save', { player: keeper, type: body ? 'block' : 'parry', dive: true, shotSpeed: spd });
  },

  /**
   * Called every frame while the keeper is DIVING. Tests the travelling hands against the ball and
   * resolves a catch / parry / body block. Returns the outcome or null.
   */
  updateDiveContact(world, keeper, dt, { catchSkill = 1, reach = 1 } = {}) {
    const ball = world.ball;
    if (ball.owner || !keeper.dive) return null;
    const progress = clamp(keeper.sm.stateTime / 0.3, 0, 1);
    hands.copy(keeper.position).addScaledVector(keeper.dive.dir, 0.4 + progress * (GOALKEEPER.DIVE_REACH * reach - 0.4));
    hands.z += this.forward(keeper) * 0.35;
    const height = keeper.dive.height || (keeper.dive.low ? 'low' : 'mid');
    hands.y = height === 'low' ? 0.4 : height === 'high' ? lerp(1.2, 2.0, progress) : lerp(0.9, 1.5, progress);
    swept.copy(ball.position).addScaledVector(ball.velocity, -dt * 0.5);
    const d = Math.min(hands.distanceTo(ball.position), hands.distanceTo(swept));
    if (d >= 0.9 + ball.radius || keeper.sm.stateTime >= 0.75) return null;
    const handsOK = this.canUseHands(keeper, ball);
    if (!handsOK) { this.parry(world, keeper, { body: true }); return 'block'; }
    const fast = ball.speed > GOALKEEPER.CATCH_MAX_SPEED * 0.8;
    if (!fast && Math.random() < 0.7 * catchSkill) { this.catchBall(world, keeper, { wasDive: true }); return 'catch'; }
    this.parry(world, keeper);
    return 'parry';
  },

  /** Pick up / smother a loose ball within reach. Hands rule applies. */
  trySmother(world, keeper, maxDist = 1.15) {
    const ball = world.ball;
    if ((ball.owner && ball.owner !== keeper) || ball.state === BALL_STATE.GOALKEEPER_HELD || ball.position.y > 1.3) return false;
    if (keeper.position.distanceTo(ball.position) > maxDist) return false;
    if (!this.canUseHands(keeper, ball)) return false;
    if (ball.speed > GOALKEEPER.CATCH_MAX_SPEED * 1.1) return false;
    return this.catchBall(world, keeper, { pickup: true });
  },

  /** Start a dive in the keeper's local left/right with a height band; shared entry point. */
  dive(world, keeper, sideSign, height = 'mid', speed = 6) {
    const low = height === 'low';
    if (!keeper.startDive(sideSign, low, speed, world)) return false;
    keeper.dive.height = height;
    return true;
  }
};
