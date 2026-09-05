import * as THREE from 'three';
import { PITCH, ROLE, TEAM } from '../utils/Constants.js';
import { clamp, lerp } from '../utils/MathUtils.js';

/**
 * Formation anchors in normalised team space: x in [-1,1] across the pitch, z in [-1,1] where -1 is the
 * team's own goal line and +1 the opponent's. Anchors are shifted toward the ball and forward/back
 * depending on whether the team is attacking, then converted to world space per team direction.
 */
export const FORMATIONS = {
  '2-3-1': [
    { role: ROLE.GOALKEEPER, x: 0, z: -0.94 },
    { role: ROLE.DEFENDER, x: -0.45, z: -0.6 },
    { role: ROLE.DEFENDER, x: 0.45, z: -0.6 },
    { role: ROLE.MIDFIELDER, x: -0.68, z: -0.18 },
    { role: ROLE.MIDFIELDER, x: 0, z: -0.3 },
    { role: ROLE.MIDFIELDER, x: 0.68, z: -0.18 },
    { role: ROLE.ATTACKER, x: 0, z: 0.22 }
  ],
  '3-2-1': [
    { role: ROLE.GOALKEEPER, x: 0, z: -0.94 },
    { role: ROLE.DEFENDER, x: -0.6, z: -0.58 },
    { role: ROLE.DEFENDER, x: 0, z: -0.66 },
    { role: ROLE.DEFENDER, x: 0.6, z: -0.58 },
    { role: ROLE.MIDFIELDER, x: -0.45, z: -0.15 },
    { role: ROLE.MIDFIELDER, x: 0.45, z: -0.15 },
    { role: ROLE.ATTACKER, x: 0, z: 0.25 }
  ]
};

export class FormationSystem {
  constructor(formationName = '2-3-1') {
    this.slots = FORMATIONS[formationName] || FORMATIONS['2-3-1'];
    this.tmp = new THREE.Vector3();
  }

  /** Direction of attack along Z for a team: BLUE attacks +Z. */
  static attackDir(team) { return team === TEAM.BLUE ? 1 : -1; }

  /** Convert normalised team-space coordinates to world space. */
  toWorld(team, nx, nz, out) {
    const dir = FormationSystem.attackDir(team);
    out.set(nx * PITCH.HALF_WIDTH * 0.82 * dir, 0, nz * PITCH.HALF_LENGTH * dir);
    return out;
  }

  /** Normalised z (own goal -1 .. opponent goal +1) of a world z for a team. */
  normZ(team, worldZ) { return (worldZ / PITCH.HALF_LENGTH) * FormationSystem.attackDir(team); }

  /**
   * World-space anchor for a slot. `phase` is 'attack' | 'defend' | 'neutral'. The whole block slides
   * along the pitch with the ball and drifts sideways toward the ball so the team stays compact.
   */
  getAnchor(team, slotIndex, ballPos, phase, out) {
    const slot = this.slots[slotIndex];
    const dir = FormationSystem.attackDir(team);
    const ballNz = clamp(this.normZ(team, ballPos.z), -1, 1);
    const ballNx = clamp((ballPos.x / (PITCH.HALF_WIDTH * 0.82)) * dir, -1, 1);
    let nz = slot.z, nx = slot.x;
    if (slot.role === ROLE.GOALKEEPER) {
      return this.toWorld(team, nx * 0.3 + ballNx * 0.12, -0.95, out);
    }
    const shift = phase === 'attack' ? 0.28 : phase === 'defend' ? -0.22 : 0;
    // slide with the ball (block moves as a unit) and keep some distance from it
    nz = nz + shift + (ballNz - nz) * (phase === 'defend' ? 0.42 : 0.3);
    nx = nx + ballNx * (phase === 'defend' ? 0.35 : 0.22);
    // attackers push higher in attack, defenders never go beyond mid when defending
    if (slot.role === ROLE.ATTACKER && phase === 'attack') nz = Math.max(nz, ballNz + 0.15);
    if (slot.role === ROLE.DEFENDER && phase === 'defend') nz = Math.min(nz, ballNz - 0.12);
    nz = clamp(nz, -0.9, 0.92);
    nx = clamp(nx, -1.05, 1.05);
    return this.toWorld(team, nx, nz, out);
  }

  /** Kick-off positions: compact inside the team's own half. The kicking team's attacker stands on the ball. */
  getKickoffPosition(team, slotIndex, isKickingTeam, out) {
    const slot = this.slots[slotIndex];
    let nx = slot.x, nz = slot.z;
    if (slot.role === ROLE.ATTACKER) { nz = isKickingTeam ? -0.045 : -0.25; nx = isKickingTeam ? 0.02 : 0; }
    else if (slot.role === ROLE.MIDFIELDER) { nz = lerp(slot.z, -0.3, 0.5); if (isKickingTeam && slot.x === 0) { nz = -0.26; nx = 0.18; } }
    else if (slot.role === ROLE.DEFENDER) nz = -0.55;
    return this.toWorld(team, nx, nz, out);
  }

  roleOf(slotIndex) { return this.slots[slotIndex].role; }
}
