import { PLAYER_STATE as S } from '../utils/Constants.js';

const LOCOMOTION = new Set([S.IDLE, S.WALKING, S.RUNNING, S.SPRINTING, S.DRIBBLING]);
const CAN_KICK = new Set([S.IDLE, S.WALKING, S.RUNNING, S.SPRINTING, S.DRIBBLING, S.HOLDING]);
const CAN_TACKLE = new Set([S.IDLE, S.WALKING, S.RUNNING, S.SPRINTING, S.DRIBBLING]);
const CAN_JUKE = new Set([S.IDLE, S.WALKING, S.RUNNING, S.SPRINTING, S.DRIBBLING]);
const CAN_MOVE = new Set([S.IDLE, S.WALKING, S.RUNNING, S.SPRINTING, S.DRIBBLING, S.HOLDING]);
const CAN_CONTROL_BALL = new Set([S.IDLE, S.WALKING, S.RUNNING, S.SPRINTING, S.DRIBBLING, S.JUKING, S.KICKING]);
const VULNERABLE = new Set([S.IDLE, S.WALKING, S.RUNNING, S.SPRINTING, S.DRIBBLING, S.KICKING, S.JUKING, S.RECOVERING]);

/**
 * Finite state machine for a player. Locomotion states are derived from speed every frame; action
 * states are timed and expire back to locomotion (or chain into another state via onExpire).
 */
export class PlayerStateMachine {
  constructor(player) {
    this.player = player;
    this.state = S.IDLE;
    this.stateTime = 0;
    this.duration = 0;
    this.onExpire = null;
    this.previous = S.IDLE;
  }

  set(state, duration = 0) {
    if (this.state !== state) this.previous = this.state;
    this.state = state;
    this.stateTime = 0;
    this.duration = duration;
  }

  update(dt) {
    this.stateTime += dt;
    if (this.duration > 0 && this.stateTime >= this.duration) {
      const expired = this.state;
      this.duration = 0;
      if (this.onExpire) this.onExpire(expired);
      else this.set(S.IDLE);
    }
  }

  /** Update the locomotion sub-state from the player's current speed. Only valid while in locomotion. */
  updateLocomotion(speed, sprinting, hasBall) {
    if (!this.isLocomotion()) return;
    let next;
    if (speed < 0.25) next = S.IDLE;
    else if (speed < 3.2) next = S.WALKING;
    else if (sprinting && speed > 6.8) next = S.SPRINTING;
    else next = S.RUNNING;
    if (hasBall && next !== S.IDLE) next = S.DRIBBLING;
    if (next !== this.state) this.set(next);
  }

  get progress() { return this.duration > 0 ? Math.min(1, this.stateTime / this.duration) : 1; }
  is(state) { return this.state === state; }
  isLocomotion() { return LOCOMOTION.has(this.state); }
  canKick() { return CAN_KICK.has(this.state); }
  canTackle() { return CAN_TACKLE.has(this.state); }
  canJuke() { return CAN_JUKE.has(this.state); }
  canMove() { return CAN_MOVE.has(this.state); }
  canControlBall() { return CAN_CONTROL_BALL.has(this.state); }
  isVulnerable() { return VULNERABLE.has(this.state); }
  isDown() { return this.state === S.FALLING || this.state === S.STUNNED || this.state === S.RECOVERING; }
}
