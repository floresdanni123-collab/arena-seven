import * as THREE from 'three';
import { FOUL, PITCH } from '../utils/Constants.js';
import { FormationSystem } from '../ai/FormationSystem.js';
import { clamp } from '../utils/MathUtils.js';

const tmp = new THREE.Vector3();

/**
 * Decides whether a tackle contact is a foul and how serious it is. Pure evaluation: it does not
 * stop play or move players - the RulesManager acts on the verdict.
 *
 * A contact record contains:
 *   tackler, victim, ballFirst (ball reached before the player), ballDistance (ball to contact point),
 *   fromBehind (0..1), progress (0..1 how early in the slide), victimHadBall, victimSpeed, location
 */
export class FoulManager {
  constructor(events) {
    this.events = events;
    this.foulCounts = new Map();   // player -> fouls committed
    this.cards = new Map();        // player -> { yellow: n, red: bool }
    this.tolerance = FOUL.TOLERANCE;
  }

  reset() { this.foulCounts.clear(); this.cards.clear(); }

  getCards(player) { return this.cards.get(player) || { yellow: 0, red: false }; }

  /**
   * Evaluate a tackle contact. Returns { foul, severity, card, reason, dogso, inBox, penalty }.
   */
  evaluate(contact, world) {
    const { tackler, victim, ballFirst, ballDistance, fromBehind, progress, victimHadBall, victimSpeed, location } = contact;
    const result = { foul: false, severity: 0, card: null, reason: 'CLEAN', dogso: false, inBox: false, penalty: false, tackler, victim, location: location.clone() };
    if (!victim || tackler.team === victim.team) return result;

    // Clean: played the ball first (or the ball was right there and the slide reached it in time).
    if (ballFirst && ballDistance < FOUL.BALL_NEAR) {
      // Ball first but reckless from behind at high speed can still be a foul on a strict referee.
      const reckless = fromBehind > 0.75 && progress < 0.25 && victimSpeed > 5;
      if (!reckless || Math.random() < this.tolerance) return result;
      result.reason = 'RECKLESS_FROM_BEHIND';
      result.severity = 0.45;
    } else if (ballDistance > FOUL.BALL_FAR) {
      result.reason = 'NO_BALL';
      result.severity = 0.55 + 0.2 * Math.min(1, (ballDistance - FOUL.BALL_FAR) / 3);
    } else {
      result.reason = 'PLAYER_FIRST';
      result.severity = 0.35;
    }
    result.foul = true;
    // Aggravating factors
    result.severity += fromBehind * 0.25;
    result.severity += (1 - progress) * 0.12;          // full-speed contact at the start of the slide
    result.severity += victimSpeed > 6.5 ? 0.12 : 0;    // victim was sprinting: dangerous
    if (!victimHadBall && ballDistance > 4) result.severity += 0.15; // off-the-ball hit
    result.severity = clamp(result.severity, 0, 1);

    // Location: inside the tackler's own penalty area -> penalty.
    const goalZ = -FormationSystem.attackDir(tackler.team) * PITCH.HALF_LENGTH;
    const fwd = FormationSystem.attackDir(tackler.team);
    const depth = (location.z - goalZ) * fwd;
    result.inBox = Math.abs(location.x) < PITCH.PENALTY_AREA_WIDTH / 2 && depth >= -0.3 && depth <= PITCH.PENALTY_AREA_DEPTH;
    result.penalty = result.inBox;

    // Denying an obvious goal-scoring opportunity: victim carrying the ball, close to goal, no other defender
    // between them and the goal.
    if (victimHadBall) {
      const attackGoalZ = FormationSystem.attackDir(victim.team) * PITCH.HALF_LENGTH;
      const distGoal = Math.hypot(victim.position.x, attackGoalZ - victim.position.z);
      if (distGoal < 22 && Math.abs(victim.position.x) < 12) {
        let defendersBetween = 0;
        for (const p of world.players) {
          if (p.team !== tackler.team || p === tackler || p.isGoalkeeper) continue;
          const closer = Math.abs(attackGoalZ - p.position.z) < Math.abs(attackGoalZ - victim.position.z);
          if (closer && Math.abs(p.position.x - victim.position.x) < 6) defendersBetween++;
        }
        if (defendersBetween === 0) result.dogso = true;
      }
    }

    // Cards, tuned to be uncommon.
    const count = (this.foulCounts.get(tackler) || 0) + 1;
    this.foulCounts.set(tackler, count);
    const prior = this.getCards(tackler);
    let card = null;
    if (result.severity >= FOUL.RED_SEVERITY || (result.dogso && result.severity >= 0.7)) card = 'RED';
    else if (result.severity >= FOUL.YELLOW_SEVERITY || result.dogso || count % FOUL.REPEAT_FOULS_FOR_YELLOW === 0) card = 'YELLOW';
    // Tolerance softens marginal bookings.
    if (card === 'YELLOW' && result.severity < FOUL.YELLOW_SEVERITY + 0.12 && !result.dogso && Math.random() < this.tolerance * 0.6) card = null;
    if (card === 'YELLOW' && prior.yellow >= 1) card = 'RED_SECOND_YELLOW';
    if (card) {
      const c = { yellow: prior.yellow + (card === 'YELLOW' || card === 'RED_SECOND_YELLOW' ? 1 : 0), red: prior.red || card !== 'YELLOW' };
      this.cards.set(tackler, c);
    }
    result.card = card;
    return result;
  }
}
