/**
 * Owns which player a human controls, one instance per human team. Two ways control moves:
 *   1. Manual: TAB cycles the human's team (goalkeeper included), SPACE jumps to the player nearest the ball.
 *   2. Pass switching: when the HUMAN-controlled player makes an intentional pass (or throw) to a teammate,
 *      control moves to the receiver immediately. AI passes, deflections and keeper distribution never switch.
 * Switching to the goalkeeper suspends the goalkeeper AI; switching away resumes it.
 */
export class PlayerSwitchManager {
  constructor(match, team) {
    this.match = match;
    this.team = team;
    this.events = match.events;
    this.locked = false; // e.g. during replays
    this.lastSwitchTime = -10;
  }

  get human() { return this.match.humans[this.team]; }
  get isLocal() { return this.match.localTeam === this.team; }

  teamPlayers() {
    return this.match.players.filter((p) => p.team === this.team && p.active).sort((a, b) => a.slotIndex - b.slotIndex);
  }

  /** Move human control to `p` (any active player on this team). */
  switchTo(p, { reason = 'manual' } = {}) {
    const m = this.match;
    const old = this.human;
    if (!p || p === old || !p.active || p.team !== this.team) return false;
    if (old) {
      old.isHuman = false;
      old.model.showName(m.debugNames || false); old.model.setMarker(null);
      old.faceAim = false; old.cancelCharge();
      old.speedMult = m.teamManager.difficulty.speedMult;
      if (old.isGoalkeeper && old.ai) { old.ai.threat = null; old.ai.mode = 'POSITION'; }   // keeper AI resumes
      if (!old.ai) old.ai = m.makeOutfieldAI(old);
      if (old.ai && old.ai.moveTarget) old.ai.moveTarget.copy(old.position);
    }
    p.isHuman = true;
    p.speedMult = 1;
    p.model.showName(true);
    p.model.setMarker(this.isLocal ? 0xb8ff3b : (this.team === 0 ? 0x2f7bff : 0xff3b4e));
    m.setHuman(this.team, p);
    m.useController(this.team, p);
    if (this.isLocal) {
      m.camera.setRig(p.isGoalkeeper ? 'keeper' : (m.setPieces.isActive() ? 'setpiece' : 'player'), m.camera.focusPoint);
      m.camera.setTarget(p, false);
    }
    this.lastSwitchTime = m.time;
    this.events.emit('player_switch', { player: p, previous: old, reason, team: this.team });
    return true;
  }

  /** TAB: next teammate in slot order (wraps, includes the goalkeeper). */
  cycle(direction = 1) {
    if (this.locked) return;
    const list = this.teamPlayers();
    const i = list.indexOf(this.human);
    const next = list[(i + direction + list.length) % list.length];
    this.switchTo(next, { reason: 'cycle' });
  }

  /** SPACE: nearest outfield teammate to the ball (only when we don't have it). */
  nearestToBall() {
    if (this.locked || !this.human || this.human.hasBall) return;
    const ball = this.match.ball;
    let best = null;
    for (const p of this.teamPlayers()) {
      if (p === this.human || p.isGoalkeeper || p.sm.isDown()) continue;
      const d = p.position.distanceTo(ball.position);
      if (!best || d < best.d) best = { p, d };
    }
    if (!best || best.d > this.human.position.distanceTo(ball.position) - 1.0) return;
    this.switchTo(best.p, { reason: 'nearest' });
  }

  /** Kick / throw event hook: intentional human passes move control to the receiver. */
  onKick(d) {
    if (this.locked) return;
    const passer = d.player;
    if (!passer || !passer.isHuman || passer.team !== this.team || d.isShot || !d.target) return;
    const target = d.target;
    if (target.team !== passer.team || target === passer || !target.active || target.sm.isDown()) return;
    this.switchTo(target, { reason: 'pass' });
  }
}
