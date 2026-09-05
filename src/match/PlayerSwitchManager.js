/**
 * Owns which player the human controls. Two ways control moves:
 *   1. Manual: TAB cycles the human's team (goalkeeper included), SPACE jumps to the player nearest the ball.
 *   2. Pass switching: when the HUMAN-controlled player makes an intentional pass (or throw) to a teammate,
 *      control moves to the receiver immediately. AI passes, deflections and keeper distribution never switch.
 * Switching to the goalkeeper suspends the goalkeeper AI; switching away resumes it.
 */
export class PlayerSwitchManager {
  constructor(match) {
    this.match = match;
    this.events = match.events;
    this.locked = false; // e.g. during replays
    this.lastSwitchTime = -10;
  }

  get human() { return this.match.human; }

  teamPlayers() {
    return this.match.players.filter((p) => p.team === this.human.team && p.active).sort((a, b) => a.slotIndex - b.slotIndex);
  }

  /** Move human control to `p` (any active player on the human's team). */
  switchTo(p, { reason = 'manual' } = {}) {
    const m = this.match;
    const old = m.human;
    if (!p || p === old || !p.active) return false;
    if (old) {
      old.isHuman = false;
      old.model.showName(m.debugNames || false); old.model.setMarker(null);
      old.faceAim = false; old.cancelCharge();
      if (old.isGoalkeeper && old.ai) { old.ai.threat = null; old.ai.mode = 'POSITION'; }   // keeper AI resumes
      if (!old.isGoalkeeper && !old.ai) old.ai = m.makeOutfieldAI(old);
      if (old.ai && old.ai.moveTarget) old.ai.moveTarget.copy(old.position);
    }
    p.isHuman = true;
    p.speedMult = 1;
    p.model.showName(true); p.model.setMarker(0xb8ff3b);
    m.human = p;
    m.teamManager.human = p;
    // Controller: keepers get the goalkeeper controller, everyone else the outfield one.
    m.useController(p.isGoalkeeper ? m.gkController : m.controller, p);
    m.camera.setRig(p.isGoalkeeper ? 'keeper' : (m.setPieces.isActive() ? 'setpiece' : 'player'), m.camera.focusPoint);
    m.camera.setTarget(p, false);
    this.lastSwitchTime = m.time;
    this.events.emit('player_switch', { player: p, previous: old, reason });
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
    if (this.locked || this.human.hasBall) return;
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
    if (!passer || !passer.isHuman || d.isShot || !d.target) return;
    const target = d.target;
    if (target.team !== passer.team || target === passer || !target.active || target.sm.isDown()) return;
    this.switchTo(target, { reason: 'pass' });
  }
}
