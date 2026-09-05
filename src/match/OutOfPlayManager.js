import * as THREE from 'three';
import { PITCH, RESTART, TEAM, REPLAY } from '../utils/Constants.js';

/**
 * Watches the ball against the pitch boundaries during open play and produces a restart decision:
 *   { type: THROW_IN | CORNER | GOAL_KICK, team, position, exitPoint, line, lastTouch, keeperTouched }
 * Goals are detected by GoalSystem first, so anything crossing a goal line here is not a goal.
 */
export class OutOfPlayManager {
  constructor(goals) {
    this.goals = goals;
    this.enabled = true;
    this.lastDecision = null;
  }

  /** Returns a restart decision when the whole ball has left the field, else null. */
  check(ball) {
    if (!this.enabled || ball.owner) return null;
    const r = ball.radius;
    const p = ball.position;
    const touchTeam = ball.lastTouchTeam >= 0 ? ball.lastTouchTeam : (ball.lastTouch ? ball.lastTouch.team : TEAM.BLUE);
    const other = touchTeam === TEAM.BLUE ? TEAM.RED : TEAM.BLUE;

    // Touchlines
    if (Math.abs(p.x) - r > PITCH.HALF_WIDTH) {
      const side = Math.sign(p.x);
      const z = Math.max(-PITCH.HALF_LENGTH + 1, Math.min(PITCH.HALF_LENGTH - 1, p.z));
      return this.decision({
        type: RESTART.THROW_IN, team: other, line: side > 0 ? 'EAST' : 'WEST',
        position: new THREE.Vector3(side * (PITCH.HALF_WIDTH - 0.35), 0, z),
        exitPoint: p.clone(), lastTouch: ball.lastTouchPlayer, lastTouchType: ball.lastTouchType
      });
    }

    // Goal lines (not a goal - GoalSystem ran first)
    if (Math.abs(p.z) - r > PITCH.HALF_LENGTH) {
      const side = Math.sign(p.z);                       // +1: RED's goal line (BLUE attacks it)
      const defendingTeam = side > 0 ? TEAM.RED : TEAM.BLUE;
      const attackingTeam = defendingTeam === TEAM.BLUE ? TEAM.RED : TEAM.BLUE;
      const keeperTouched = ball.lastTouchPlayer && ball.lastTouchPlayer.isGoalkeeper && ball.lastTouchTeam === defendingTeam;
      const lastByDefence = touchTeam === defendingTeam;
      if (lastByDefence) {
        // Corner for the attacking team, on the side the ball went out.
        const cx = Math.sign(p.x || 1) * (PITCH.HALF_WIDTH - SET_PIECE_CORNER_INSET);
        return this.decision({
          type: RESTART.CORNER, team: attackingTeam, line: side > 0 ? 'SOUTH' : 'NORTH',
          position: new THREE.Vector3(cx, 0, side * (PITCH.HALF_LENGTH - SET_PIECE_CORNER_INSET)),
          exitPoint: p.clone(), lastTouch: ball.lastTouchPlayer, lastTouchType: ball.lastTouchType, keeperTouched
        });
      }
      // Goal kick for the defending team, taken from the side the ball went out.
      const gx = Math.sign(p.x || 1) * 3.0;
      return this.decision({
        type: RESTART.GOAL_KICK, team: defendingTeam, line: side > 0 ? 'SOUTH' : 'NORTH',
        position: new THREE.Vector3(gx, 0, side * (PITCH.HALF_LENGTH - 3.0)),
        exitPoint: p.clone(), lastTouch: ball.lastTouchPlayer, lastTouchType: ball.lastTouchType, keeperTouched
      });
    }
    return null;
  }

  decision(d) { this.lastDecision = d; return d; }

  /**
   * Was the exit "close" to the goal frame? Used for missed-shot replay significance.
   * Returns the distance from the exit point to the nearest part of the goal mouth.
   */
  static missDistance(exitPoint) {
    const halfW = PITCH.GOAL_WIDTH / 2, h = PITCH.GOAL_HEIGHT;
    const dx = Math.max(0, Math.abs(exitPoint.x) - halfW);
    const dy = Math.max(0, exitPoint.y - h);
    return Math.hypot(dx, dy);
  }
}

const SET_PIECE_CORNER_INSET = 0.4;
