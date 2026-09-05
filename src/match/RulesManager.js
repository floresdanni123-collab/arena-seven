import * as THREE from 'three';
import { FoulManager } from './FoulManager.js';
import { FOUL, RESTART, PITCH } from '../utils/Constants.js';
import { FormationSystem } from '../ai/FormationSystem.js';

const tmp = new THREE.Vector3();

/**
 * The referee. Receives tackle contacts from players, asks the FoulManager for a verdict, applies the
 * simple advantage rule, hands out cards and tells the match which restart to play.
 * Physics never talks to this class; players report contacts through world.rules.
 */
export class RulesManager {
  constructor(match) {
    this.match = match;
    this.events = match.events;
    this.fouls = new FoulManager(this.events);
    this.pending = null;      // advantage being assessed: { verdict, time }
    this.enabled = true;
    this.foulLog = [];
  }

  reset() { this.pending = null; }

  /**
   * Called by Player.updateTackle when the slide capsule reaches an opponent.
   * Returns what should physically happen: { foul, knockDown, loosenBall, verdict }.
   */
  onTackleContact(contact) {
    const world = this.match.world;
    const verdict = this.fouls.evaluate(contact, world);
    if (!verdict.foul || !this.enabled || !this.match.isOpenPlay()) {
      return { foul: false, knockDown: true, loosenBall: true, verdict };
    }
    verdict.time = this.match.time;
    verdict.victimHadBall = contact.victimHadBall;
    this.foulLog.push(verdict);
    this.events.emit('foul', { verdict });
    // Penalties are given straight away; other fouls may be waved on (advantage).
    if (verdict.penalty || !contact.victimHadBall) this.award(verdict);
    else this.pending = { verdict, time: this.match.time, team: contact.victim.team };
    return { foul: true, knockDown: true, loosenBall: contact.victimHadBall, verdict };
  }

  /** Advantage assessment, run every frame of open play. */
  update(dt) {
    if (!this.pending) return;
    const { verdict, time, team } = this.pending;
    const ball = this.match.ball;
    const elapsed = this.match.time - time;
    const owner = ball.owner;
    // Opponents won the ball: bring it back.
    if (owner && owner.team !== team) { this.pending = null; this.award(verdict); return; }
    if (elapsed < FOUL.ADVANTAGE_WINDOW) return;
    this.pending = null;
    const keeps = owner && owner.team === team && !owner.sm.isDown();
    if (keeps) {
      const dir = FormationSystem.attackDir(team);
      const progressed = (owner.position.z - verdict.location.z) * dir > 0.5;
      let pressure = 99;
      for (const p of this.match.players) if (p.team !== team && !p.isGoalkeeper) pressure = Math.min(pressure, p.position.distanceTo(owner.position));
      if (progressed && pressure > 2.2) {
        this.events.emit('advantage', { verdict, team });
        if (verdict.card) this.applyCard(verdict, true);
        return;
      }
    }
    this.award(verdict);
  }

  award(verdict) {
    if (verdict.card) this.applyCard(verdict, false);
    const type = verdict.penalty ? RESTART.PENALTY : RESTART.FREE_KICK;
    const position = verdict.location.clone();
    position.x = Math.max(-PITCH.HALF_WIDTH + 1, Math.min(PITCH.HALF_WIDTH - 1, position.x));
    position.z = Math.max(-PITCH.HALF_LENGTH + 1, Math.min(PITCH.HALF_LENGTH - 1, position.z));
    this.match.onFoulAwarded({ type, team: verdict.victim.team, position, verdict });
  }

  applyCard(verdict, deferred) {
    const card = verdict.card;
    const player = verdict.tackler;
    const isRed = card === 'RED' || card === 'RED_SECOND_YELLOW';
    this.events.emit('card', { player, card: isRed ? 'RED' : 'YELLOW', secondYellow: card === 'RED_SECOND_YELLOW', deferred, verdict });
    if (isRed) this.match.sendOff(player);
  }
}
