import * as THREE from 'three';
import { ROLE, PLAYER, PITCH } from '../utils/Constants.js';
import { FormationSystem } from './FormationSystem.js';

/**
 * Team-level coordination: decides the team phase (attack / defend / neutral) and hands each player a
 * task so that only a couple of players go for the ball while the rest keep shape, mark or support.
 */
export class TeamAI {
  constructor(team, formation, difficulty) {
    this.team = team;
    this.formation = formation;
    this.diff = difficulty;
    this.players = [];
    this.assignments = new Map();
    this.phase = 'neutral';
    this.timer = 0;
    this.tmp = new THREE.Vector3();
    this.ownGoal = new THREE.Vector3(0, 0, -FormationSystem.attackDir(team) * PITCH.HALF_LENGTH);
  }

  setPlayers(players) {
    this.players = players;
    for (const p of players) this.assignments.set(p, { task: 'HOLD', target: new THREE.Vector3().copy(p.homePosition), markTarget: null });
  }

  getAssignment(player) { return this.assignments.get(player); }

  update(dt, world) {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.12;
    const ball = world.ball;
    const owner = ball.owner;
    this.phase = owner ? (owner.team === this.team ? 'attack' : 'defend') : 'neutral';

    const outfield = this.players.filter((p) => !p.isGoalkeeper);
    const opponents = world.players.filter((p) => p.team !== this.team);

    // Anchors first
    for (const p of this.players) {
      const a = this.assignments.get(p);
      this.formation.getAnchor(this.team, p.slotIndex, ball.position, this.phase, a.target);
      p.homePosition.copy(a.target);
      a.task = 'HOLD';
      a.markTarget = null;
    }

    if (this.phase === 'neutral') {
      const ranked = outfield.filter((p) => !p.sm.isDown()).map((p) => ({ p, t: this.timeToBall(p, ball) })).sort((x, y) => x.t - y.t);
      // Two chasers; if the human is the closest, one AI also goes so play keeps flowing.
      const chasers = ranked.slice(0, 2);
      for (const c of chasers) this.assignments.get(c.p).task = 'CHASE';
      // Defenders drop a little deeper while the ball is loose near our goal
      return;
    }

    if (this.phase === 'attack') {
      for (const p of outfield) {
        const a = this.assignments.get(p);
        if (p === owner) { a.task = 'CARRY'; continue; }
        a.task = 'SUPPORT';
        // don't crowd the carrier
        this.tmp.subVectors(a.target, owner.position); this.tmp.y = 0;
        const d = this.tmp.length();
        if (d < 6 && d > 0.01) a.target.addScaledVector(this.tmp.normalize(), 6 - d);
        // spread out from other supporting teammates
        for (const q of outfield) {
          if (q === p || q === owner) continue;
          const qa = this.assignments.get(q);
          this.tmp.subVectors(a.target, qa.target); this.tmp.y = 0;
          const dq = this.tmp.length();
          if (dq < 5 && dq > 0.01) a.target.addScaledVector(this.tmp.normalize(), (5 - dq) * 0.5);
        }
      }
      return;
    }

    // ---- defend ----
    const carrier = owner;
    const ranked = outfield.filter((p) => !p.sm.isDown()).map((p) => ({ p, d: p.position.distanceTo(carrier.position) })).sort((x, y) => x.d - y.d);
    if (ranked[0]) this.assignments.get(ranked[0].p).task = 'PRESS';
    if (ranked[1]) this.assignments.get(ranked[1].p).task = 'COVER';
    // Markers: defenders and midfielders not pressing mark the most dangerous free opponents.
    const dangerous = opponents
      .filter((o) => o !== carrier && !o.isGoalkeeper)
      .map((o) => ({ o, d: o.position.distanceTo(this.ownGoal) }))
      .sort((x, y) => x.d - y.d);
    const markers = outfield.filter((p) => { const t = this.assignments.get(p).task; return t === 'HOLD' && (p.role === ROLE.DEFENDER || p.role === ROLE.MIDFIELDER); });
    const taken = new Set();
    for (const m of markers) {
      // marker takes the nearest dangerous opponent inside our half that nobody else marks
      let best = null;
      for (const dg of dangerous) {
        if (taken.has(dg.o)) continue;
        const inOurHalf = this.formation.normZ(this.team, dg.o.position.z) < 0.15;
        if (!inOurHalf) continue;
        const dist = m.position.distanceTo(dg.o.position);
        if (!best || dist < best.dist) best = { o: dg.o, dist };
      }
      if (best && best.dist < 18) {
        taken.add(best.o);
        const a = this.assignments.get(m);
        a.task = 'MARK'; a.markTarget = best.o;
      }
    }
  }

  timeToBall(p, ball) {
    const d = p.position.distanceTo(ball.position);
    let t = d / (PLAYER.SPRINT_SPEED * p.speedMult);
    if (p.isHuman) t *= 1.05;
    return t;
  }
}
