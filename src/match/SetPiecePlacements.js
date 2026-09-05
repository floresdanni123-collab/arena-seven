import * as THREE from 'three';
import { PITCH, ROLE, RESTART, SET_PIECE } from '../utils/Constants.js';
import { FormationSystem } from '../ai/FormationSystem.js';
import { clamp } from '../utils/MathUtils.js';

const tmp = new THREE.Vector3();

/**
 * Computes where every player should stand for a restart. Returns Map(player -> Vector3).
 * Coordinates are built in "attacking team space" (depth measured from the defended goal line into
 * the pitch) and converted with the team's attack direction.
 */
export const SetPiecePlacements = {
  compute(match, spec, taker) {
    switch (spec.type) {
      case RESTART.FREE_KICK: return this.freeKick(match, spec, taker);
      case RESTART.CORNER: return this.corner(match, spec, taker);
      case RESTART.GOAL_KICK: return this.goalKick(match, spec, taker);
      case RESTART.THROW_IN: return this.throwIn(match, spec, taker);
      case RESTART.PENALTY: return this.penalty(match, spec, taker);
      default: return new Map();
    }
  },

  clampPitch(v) {
    v.x = clamp(v.x, -PITCH.HALF_WIDTH + 0.6, PITCH.HALF_WIDTH - 0.6);
    v.z = clamp(v.z, -PITCH.HALF_LENGTH + 0.6, PITCH.HALF_LENGTH - 0.6);
    v.y = 0;
    return v;
  },

  /** Point at `depth` metres in front of the goal that `team` attacks, `x` across. */
  attackGoalPoint(team, x, depth, out = new THREE.Vector3()) {
    const dir = FormationSystem.attackDir(team);
    return out.set(x * dir, 0, dir * (PITCH.HALF_LENGTH - depth));
  },

  /** Point at `depth` metres in front of the goal that `team` defends. */
  ownGoalPoint(team, x, depth, out = new THREE.Vector3()) {
    const dir = FormationSystem.attackDir(team);
    return out.set(x * dir, 0, -dir * (PITCH.HALF_LENGTH - depth));
  },

  /** Default: formation anchors around the ball for whoever is not explicitly placed. */
  fillWithAnchors(match, map, spec, teamPhase) {
    for (const p of match.players) {
      if (map.has(p) || !p.active) continue;
      const phase = teamPhase(p.team);
      const v = match.formation.getAnchor(p.team, p.slotIndex, spec.position, phase, new THREE.Vector3());
      map.set(p, this.clampPitch(v));
    }
  },

  /** Push every opponent of `team` at least `dist` from the ball (goalkeepers on their line are exempt). */
  enforceDistance(match, map, spec, team, dist, exemptKeeper = true) {
    for (const [p, v] of map) {
      if (p.team === team) continue;
      if (exemptKeeper && p.isGoalkeeper) continue;
      tmp.subVectors(v, spec.position); tmp.y = 0;
      const d = tmp.length();
      if (d < dist) {
        if (d < 0.01) tmp.set(0, 0, -FormationSystem.attackDir(team));
        tmp.normalize();
        v.copy(spec.position).addScaledVector(tmp, dist + 0.3);
        this.clampPitch(v);
      }
    }
  },

  /** Keep players from stacking on the same spot. */
  separate(map, minDist = 1.4) {
    const entries = Array.from(map.entries());
    for (let iter = 0; iter < 3; iter++) {
      for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i][1], b = entries[j][1];
        tmp.subVectors(b, a); tmp.y = 0;
        const d = tmp.length();
        if (d < minDist) {
          if (d < 0.01) tmp.set(1, 0, 0); else tmp.normalize();
          const push = (minDist - d) / 2;
          a.addScaledVector(tmp, -push); b.addScaledVector(tmp, push);
          this.clampPitch(a); this.clampPitch(b);
        }
      }
    }
  },

  outfield(match, team, exclude) {
    return match.players.filter((p) => p.team === team && p.active && !p.isGoalkeeper && p !== exclude);
  },

  /* ------------------------------------------------------------ free kick */

  freeKick(match, spec, taker) {
    const map = new Map();
    const team = spec.team, opp = team === 0 ? 1 : 0;
    const dir = FormationSystem.attackDir(team);
    const goal = new THREE.Vector3(0, 0, dir * PITCH.HALF_LENGTH);
    const toGoal = tmp.subVectors(goal, spec.position).setY(0).normalize().clone();
    const distGoal = spec.position.distanceTo(goal);
    map.set(taker, this.clampPitch(spec.position.clone().addScaledVector(toGoal, -0.95)));

    // Attackers: two runners ahead of the ball near the box, others on attack anchors.
    const mates = this.outfield(match, team, taker).sort((a, b) => a.position.distanceTo(spec.position) - b.position.distanceTo(spec.position));
    if (distGoal < 32) {
      const side = new THREE.Vector3(-toGoal.z, 0, toGoal.x);
      const runner1 = this.attackGoalPoint(team, 4.5, 9.5);
      const runner2 = this.attackGoalPoint(team, -4.5, 10.5);
      if (mates[0]) map.set(mates[0], this.clampPitch(runner1));
      if (mates[1]) map.set(mates[1], this.clampPitch(runner2));
      if (mates[2]) map.set(mates[2], this.clampPitch(spec.position.clone().addScaledVector(side, 5).addScaledVector(toGoal, -1)));
    }

    // Defenders: a wall when the kick is in range, the rest mark runners.
    const defenders = this.outfield(match, opp).sort((a, b) => a.position.distanceTo(spec.position) - b.position.distanceTo(spec.position));
    if (distGoal < SET_PIECE.WALL_DISTANCE_MAX) {
      const n = distGoal < 15 ? 3 : 2;
      const wallCenter = spec.position.clone().addScaledVector(toGoal, SET_PIECE.OPPONENT_DISTANCE + 0.2);
      const side = new THREE.Vector3(-toGoal.z, 0, toGoal.x);
      // shade the wall toward the near post
      const nearPostShift = Math.sign(spec.position.x || 1) * 0.6;
      for (let i = 0; i < n && i < defenders.length; i++) {
        const off = (i - (n - 1) / 2) * 0.75 + nearPostShift;
        map.set(defenders[i], this.clampPitch(wallCenter.clone().addScaledVector(side, off)));
      }
      // markers on the runners
      let mi = n;
      for (const [p, v] of Array.from(map.entries())) {
        if (p.team !== team || p === taker || mi >= defenders.length) continue;
        const d = defenders[mi++];
        const g = this.ownGoalPoint(opp, 0, 0);
        const toOwnGoal = g.sub(v).setY(0).normalize();
        map.set(d, this.clampPitch(v.clone().addScaledVector(toOwnGoal, 1.6)));
      }
    }
    // Keepers
    for (const p of match.players) {
      if (!p.isGoalkeeper || !p.active) continue;
      map.set(p, this.ownGoalPoint(p.team, clamp(spec.position.x * 0.15, -1.5, 1.5), p.team === opp ? 1.4 : 2.5));
    }
    this.fillWithAnchors(match, map, spec, (t) => (t === team ? 'attack' : 'defend'));
    this.enforceDistance(match, map, spec, team, SET_PIECE.OPPONENT_DISTANCE);
    this.separate(map);
    return map;
  },

  /* ------------------------------------------------------------ corner */

  corner(match, spec, taker) {
    const map = new Map();
    const team = spec.team, opp = team === 0 ? 1 : 0;
    const dir = FormationSystem.attackDir(team);
    const sideX = Math.sign(spec.position.x) || 1;    // which corner (world x sign)
    const sx = sideX * dir;                            // in team space, +1 means the corner is on the "left" (team-space x)
    const inward = new THREE.Vector3(-sideX, 0, -dir).normalize();
    map.set(taker, this.clampPitch(spec.position.clone().addScaledVector(inward, 0.8)));

    const mates = this.outfield(match, team, taker).sort((a, b) => a.position.distanceTo(spec.position) - b.position.distanceTo(spec.position));
    const boxSpots = [
      this.attackGoalPoint(team, sx * 1.8, 5.0),   // near post
      this.attackGoalPoint(team, 0, 7.5),          // penalty spot
      this.attackGoalPoint(team, -sx * 2.4, 5.5),  // far post
      this.attackGoalPoint(team, sx * 4, 12.5),    // edge of the box
      this.attackGoalPoint(team, 0, 27)            // cover
    ];
    mates.forEach((p, i) => { if (boxSpots[i]) map.set(p, this.clampPitch(boxSpots[i])); });

    // Defenders: near post guard, then markers on each box attacker, rest at the box edge.
    const defenders = this.outfield(match, opp).sort((a, b) => a.position.distanceTo(spec.position) - b.position.distanceTo(spec.position));
    let di = 0;
    if (defenders[di]) map.set(defenders[di++], this.clampPitch(this.attackGoalPoint(team, sx * 2.9, 0.7)));
    for (let i = 0; i < 3 && i < mates.length && di < defenders.length; i++) {
      const spot = map.get(mates[i]);
      const g = this.attackGoalPoint(team, 0, 0);
      const toGoal = g.sub(spot).setY(0).normalize();
      map.set(defenders[di++], this.clampPitch(spot.clone().addScaledVector(toGoal, 1.2)));
    }
    while (di < defenders.length) map.set(defenders[di], this.clampPitch(this.attackGoalPoint(team, (di % 2 ? 1 : -1) * 5, 13 + di)), di++);

    for (const p of match.players) {
      if (!p.isGoalkeeper || !p.active) continue;
      if (p.team === opp) map.set(p, this.attackGoalPoint(team, sx * 0.9, 1.1));
      else map.set(p, this.ownGoalPoint(team, 0, 3));
    }
    this.fillWithAnchors(match, map, spec, (t) => (t === team ? 'attack' : 'defend'));
    this.enforceDistance(match, map, spec, team, SET_PIECE.OPPONENT_DISTANCE);
    this.separate(map, 1.2);
    return map;
  },

  /* ------------------------------------------------------------ goal kick */

  goalKick(match, spec, taker) {
    const map = new Map();
    const team = spec.team, opp = team === 0 ? 1 : 0;
    const dir = FormationSystem.attackDir(team);
    map.set(taker, this.clampPitch(spec.position.clone().add(new THREE.Vector3(0, 0, -dir * 0.9))));
    const mates = this.outfield(match, team, taker);
    const spots = {
      [ROLE.DEFENDER]: [this.ownGoalPoint(team, -13, 11), this.ownGoalPoint(team, 13, 11), this.ownGoalPoint(team, 0, 14)],
      [ROLE.MIDFIELDER]: [this.ownGoalPoint(team, -9, 23), this.ownGoalPoint(team, 9, 23), this.ownGoalPoint(team, 0, 27)],
      [ROLE.ATTACKER]: [this.ownGoalPoint(team, 0, 36)]
    };
    const used = { [ROLE.DEFENDER]: 0, [ROLE.MIDFIELDER]: 0, [ROLE.ATTACKER]: 0 };
    for (const p of mates) {
      const list = spots[p.role] || spots[ROLE.MIDFIELDER];
      const v = list[used[p.role] % list.length]; used[p.role]++;
      map.set(p, this.clampPitch(v.clone()));
    }
    // Opponents press from the halfway line
    const opps = this.outfield(match, opp);
    opps.forEach((p, i) => map.set(p, this.clampPitch(this.ownGoalPoint(team, (i - opps.length / 2 + 0.5) * 6, 26 + (i % 2) * 6))));
    for (const p of match.players) if (p.isGoalkeeper && p.active && p.team === opp) map.set(p, this.ownGoalPoint(opp, 0, 2));
    this.fillWithAnchors(match, map, spec, () => 'neutral');
    this.enforceDistance(match, map, spec, team, PITCH.PENALTY_AREA_DEPTH + 2);
    this.separate(map);
    return map;
  },

  /* ------------------------------------------------------------ throw-in */

  throwIn(match, spec, taker) {
    const map = new Map();
    const team = spec.team, opp = team === 0 ? 1 : 0;
    const dir = FormationSystem.attackDir(team);
    const sideX = Math.sign(spec.position.x) || 1;
    map.set(taker, spec.position.clone());
    const mates = this.outfield(match, team, taker).sort((a, b) => a.position.distanceTo(spec.position) - b.position.distanceTo(spec.position));
    const options = [
      new THREE.Vector3(spec.position.x - sideX * 3.5, 0, spec.position.z + dir * 6),
      new THREE.Vector3(spec.position.x - sideX * 6.5, 0, spec.position.z - dir * 2),
      new THREE.Vector3(spec.position.x - sideX * 2.5, 0, spec.position.z - dir * 7)
    ];
    mates.forEach((p, i) => { if (options[i]) map.set(p, this.clampPitch(options[i])); });
    const defenders = this.outfield(match, opp).sort((a, b) => a.position.distanceTo(spec.position) - b.position.distanceTo(spec.position));
    defenders.forEach((d, i) => {
      if (i < 3 && mates[i]) {
        const v = map.get(mates[i]);
        map.set(d, this.clampPitch(v.clone().add(new THREE.Vector3(-sideX * 1.2, 0, -dir * 1.5))));
      }
    });
    this.fillWithAnchors(match, map, spec, (t) => (t === team ? 'attack' : 'defend'));
    this.enforceDistance(match, map, spec, team, 2.2);
    this.separate(map);
    return map;
  },

  /* ------------------------------------------------------------ penalty */

  penalty(match, spec, taker) {
    const map = new Map();
    const team = spec.team, opp = team === 0 ? 1 : 0;
    const dir = FormationSystem.attackDir(team);
    map.set(taker, spec.position.clone().add(new THREE.Vector3(0.4 * dir, 0, -dir * SET_PIECE.PENALTY_RUNUP)));
    // Everyone else on an arc behind the ball, outside the area.
    const others = match.players.filter((p) => p.active && p !== taker && !p.isGoalkeeper);
    others.forEach((p, i) => {
      const a = (i / Math.max(1, others.length - 1)) * Math.PI * 0.8 + Math.PI * 0.1;
      const r = 12.5;
      const v = new THREE.Vector3(Math.cos(a) * r, 0, spec.position.z - dir * (Math.sin(a) * r * 0.55 + 4.5));
      map.set(p, this.clampPitch(v));
    });
    for (const p of match.players) {
      if (!p.isGoalkeeper || !p.active) continue;
      if (p.team === opp) map.set(p, this.attackGoalPoint(team, 0, 0.35));
      else map.set(p, spec.shootout ? this.ownGoalPoint(team, 0, 20) : this.ownGoalPoint(team, 0, 2.5));
    }
    this.separate(map, 1.2);
    return map;
  }
};
