import * as THREE from 'three';
import { RESTART, MATCH_STATE, TEAM, PITCH, BALL_STATE } from '../utils/Constants.js';
import { FormationSystem } from '../ai/FormationSystem.js';

/**
 * Penalty shootout after a drawn match. Five each, alternating BLUE / RED, early finish when one side
 * can no longer catch up, then sudden death. The human takes their own penalties and controls their
 * goalkeeper for the opponent's.
 */
export class PenaltyShootoutManager {
  constructor(match) {
    this.match = match;
    this.events = match.events;
    this.active = false;
    this.results = [[], []];      // per team: true (scored) / false (missed)
    this.kickIndex = 0;           // total kicks taken
    this.rounds = 5;
    this.suddenDeath = false;
    this.awaiting = null;         // { team, startTime, kicked, settleTimer }
    this.winner = null;
    this.finished = false;
  }

  start() {
    const m = this.match;
    this.active = true;
    this.results = [[], []];
    this.kickIndex = 0;
    this.suddenDeath = false;
    this.winner = null;
    this.finished = false;
    m.state = MATCH_STATE.PENALTY_SHOOTOUT;
    m.frozen = false;
    m.audio.play('whistle_long', { volume: 0.6 });
    this.events.emit('shootout_start', {});
    this.emitUpdate();
    this.nextKick();
  }

  get currentTeam() { return this.kickIndex % 2 === 0 ? TEAM.BLUE : TEAM.RED; }

  nextKick() {
    const m = this.match;
    const team = this.currentTeam;
    const dir = FormationSystem.attackDir(team);
    const spot = new THREE.Vector3(0, 0, dir * (PITCH.HALF_LENGTH - PITCH.PENALTY_SPOT));
    this.awaiting = { team, kicked: false, settleTimer: 0, elapsed: 0, decided: false };
    m.setPieces.begin({ type: RESTART.PENALTY, team, position: spot, shootout: true, onTaken: () => { this.awaiting.kicked = true; } });
    m.state = MATCH_STATE.PENALTY_SHOOTOUT;
    this.emitUpdate();
  }

  onGoal(team) {
    if (!this.awaiting || this.awaiting.decided) return;
    if (team !== this.awaiting.team) return; // (an own-goal-style rebound cannot happen here)
    this.record(true);
  }

  update(dt) {
    if (!this.active || this.finished) return;
    const m = this.match;
    if (this.tickPause(dt)) return;
    m.setPieces.update(dt);
    const a = this.awaiting;
    if (!a || a.decided) return;
    if (!a.kicked) return;
    a.elapsed += dt;
    const ball = m.ball;
    const dir = FormationSystem.attackDir(a.team);
    const goalZ = dir * PITCH.HALF_LENGTH;
    // Miss conditions: keeper holds it, ball dead, ball past the line outside the goal, or coming back out of the area, or time.
    const held = ball.owner && ball.owner.isGoalkeeper;
    const behindLine = (ball.position.z - goalZ) * dir > ball.radius;
    const dead = ball.speed < 0.6 && a.elapsed > 0.8;
    const comingBack = (goalZ - ball.position.z) * dir > PITCH.PENALTY_SPOT + 4 && a.elapsed > 1.0;
    if (held || dead || behindLine || comingBack) a.settleTimer += dt; else a.settleTimer = 0;
    if (a.settleTimer > 0.45 || a.elapsed > 6) this.record(false);
  }

  record(scored) {
    const a = this.awaiting;
    if (!a || a.decided) return;
    a.decided = true;
    this.results[a.team].push(scored);
    this.kickIndex++;
    this.events.emit('shootout_kick', { team: a.team, scored });
    if (scored) this.match.audio.play('goal', { volume: 0.8 }); else this.match.audio.play('crowd_ooh', { volume: 0.6 });
    const done = this.checkFinished();
    this.emitUpdate();
    // Brief pause before the next taker walks up (frame-timed so it also works under stepping).
    this.match.setPieces.cancel();
    this.match.possession.release(this.match.ball);
    this.pauseTimer = 1.8;
    this.pendingDone = done;
  }

  /** Advance the between-kicks pause; called from update(). */
  tickPause(dt) {
    if (this.pauseTimer === undefined || this.pauseTimer <= 0) return false;
    this.pauseTimer -= dt;
    if (this.pauseTimer <= 0) {
      this.pauseTimer = 0;
      if (this.pendingDone) this.finish(); else this.nextKick();
    }
    return true;
  }

  checkFinished() {
    const b = this.results[0], r = this.results[1];
    const bs = b.filter(Boolean).length, rs = r.filter(Boolean).length;
    if (!this.suddenDeath) {
      const bLeft = this.rounds - b.length, rLeft = this.rounds - r.length;
      if (bs > rs + rLeft) { this.winner = TEAM.BLUE; return true; }
      if (rs > bs + bLeft) { this.winner = TEAM.RED; return true; }
      if (b.length >= this.rounds && r.length >= this.rounds) {
        if (bs !== rs) { this.winner = bs > rs ? TEAM.BLUE : TEAM.RED; return true; }
        this.suddenDeath = true;
      }
      return false;
    }
    // Sudden death: decided when both have taken the same number and the scores differ.
    if (b.length === r.length && b.length > this.rounds && bs !== rs) { this.winner = bs > rs ? TEAM.BLUE : TEAM.RED; return true; }
    return false;
  }

  emitUpdate() {
    this.events.emit('shootout_update', {
      results: [this.results[0].slice(), this.results[1].slice()],
      rounds: this.rounds, suddenDeath: this.suddenDeath, currentTeam: this.currentTeam,
      finished: this.finished || this.winner !== null, winner: this.winner
    });
  }

  finish() {
    this.finished = true;
    this.active = false;
    this.events.emit('shootout_end', { winner: this.winner, results: this.results });
    this.match.finishMatch({ winner: this.winner, shootout: [this.results[0].filter(Boolean).length, this.results[1].filter(Boolean).length] });
  }
}
