import * as THREE from 'three';
import { SetPiecePlacements } from './SetPiecePlacements.js';
import { RESTART, MATCH_STATE, SET_PIECE, PITCH, BALL_STATE, KICK, PLAYER_STATE as S } from '../utils/Constants.js';
import { FormationSystem } from '../ai/FormationSystem.js';
import { clamp, lerp, rand, gaussian } from '../utils/MathUtils.js';

const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Runs every dead-ball restart: free kick, penalty, throw-in, corner and goal kick.
 *   SETUP  - ball placed, players walk to their placements (or are nudged after a timeout)
 *   READY  - taker may kick (human input or AI after a delay); everyone else holds position
 *   RUNUP  - penalties: taker runs onto the ball and the stored shot is executed
 * The 'kick' event from the taker ends the set piece and hands play back to the match.
 */
export class SetPieceManager {
  constructor(match) {
    this.match = match;
    this.events = match.events;
    this.current = null;
    this.stateFor = {
      [RESTART.FREE_KICK]: MATCH_STATE.FREE_KICK, [RESTART.PENALTY]: MATCH_STATE.PENALTY, [RESTART.THROW_IN]: MATCH_STATE.THROW_IN,
      [RESTART.CORNER]: MATCH_STATE.CORNER_KICK, [RESTART.GOAL_KICK]: MATCH_STATE.GOAL_KICK
    };
  }

  isActive() { return !!this.current; }
  get type() { return this.current ? this.current.type : null; }
  get taker() { return this.current ? this.current.taker : null; }
  get phase() { return this.current ? this.current.phase : null; }

  /* ------------------------------------------------------------ begin */

  begin(spec) {
    const m = this.match;
    const ball = m.ball;
    if (this.current) this.cleanup();
    const taker = this.chooseTaker(spec);
    const cur = { ...spec, taker, phase: 'SETUP', timer: 0, aiDelay: rand(SET_PIECE.AI_TAKE_DELAY_MIN, SET_PIECE.AI_TAKE_DELAY_MAX), shot: null, kicked: false };
    this.current = cur;
    m.state = this.stateFor[spec.type] || MATCH_STATE.FREE_KICK;
    m.frozen = true;

    // Dead ball at the spot
    m.possession.release(ball);
    ball.reset(spec.position.x, spec.position.z);
    ball.frozen = true;
    m.possession.locked = true;
    m.goalSystem.reset();

    // Placements + locks
    cur.placements = SetPiecePlacements.compute(m, spec, taker);
    for (const p of m.players) {
      p.cancelCharge(); p.pendingKick = null; p.pendingRelease = null;
      if (p.sm.isDown() || p.sm.is(S.TACKLING) || p.sm.is(S.DIVING)) p.resetState();
      const v = cur.placements.get(p);
      p.placement = v ? v.clone() : null;
      p.locked = false;
      if (p.ai && p.ai.moveTarget && v) p.ai.moveTarget.copy(v);
      if (p.isGoalkeeper && p.ai) { p.ai.threat = null; p.ai.mode = 'POSITION'; p.ai.holdLine = spec.type === RESTART.PENALTY && p.team !== spec.team; }
    }

    // Human control: a human takes their own team's set pieces (goal kicks stay with the keeper unless
    // the user switches). In a shootout the defending team's human takes their goalkeeper.
    for (const slot of m.slotList()) {
      if (slot.team === taker.team && !taker.isHuman && spec.type !== RESTART.GOAL_KICK) slot.switcher.switchTo(taker, { reason: 'setpiece' });
      if (spec.shootout && slot.team !== taker.team) {
        const gk = m.teamManager.getGoalkeeper(slot.team);
        if (gk && gk.active && !gk.isHuman) slot.switcher.switchTo(gk, { reason: 'shootout' });
      }
    }
    this.applyControllerMode();

    // Camera: set-piece framing around the ball
    m.camera.setRig('setpiece', spec.position);
    m.cameraDirector.setActive('gameplay', 0.7);
    this.events.emit('set_piece', { type: spec.type, team: spec.team, taker, position: spec.position.clone(), shootout: !!spec.shootout, verdict: spec.verdict || null });
    if (!spec.shootout) m.audio.play('whistle', { volume: 0.5 });
  }

  chooseTaker(spec) {
    const m = this.match;
    const team = spec.team;
    const candidates = m.players.filter((p) => p.team === team && p.active);
    if (spec.type === RESTART.GOAL_KICK) return candidates.find((p) => p.isGoalkeeper) || candidates[0];
    if (spec.preferredTaker && spec.preferredTaker.active) return spec.preferredTaker;
    const outfield = candidates.filter((p) => !p.isGoalkeeper);
    const hu = m.humans[team];
    if (hu && hu.active && !hu.isGoalkeeper) return hu;
    if (spec.type === RESTART.PENALTY) {
      // best attacker available
      const order = { ATT: 0, MID: 1, DEF: 2 };
      return outfield.sort((a, b) => (order[a.role] ?? 3) - (order[b.role] ?? 3))[0] || candidates[0];
    }
    return outfield.sort((a, b) => a.position.distanceTo(spec.position) - b.position.distanceTo(spec.position))[0] || candidates[0];
  }

  applyControllerMode() {
    const m = this.match;
    const cur = this.current;
    for (const slot of m.slotList()) {
      const isTaker = cur && slot.human === cur.taker;
      let mode = 'normal';
      if (cur) {
        if (isTaker) mode = cur.type === RESTART.THROW_IN ? 'throwin' : cur.type === RESTART.PENALTY ? 'penalty' : 'setpiece';
        else mode = 'hold';
      }
      slot.controller.mode = mode;
      slot.gkController.mode = mode === 'hold' ? 'setpiece' : mode;
    }
  }

  /* ------------------------------------------------------------ update */

  update(dt) {
    const cur = this.current;
    if (!cur) return;
    const m = this.match;
    cur.timer += dt;
    switch (cur.phase) {
      case 'SETUP': this.updateSetup(dt); break;
      case 'READY': this.updateReady(dt); break;
      case 'RUNUP': this.updateRunup(dt); break;
      case 'KICKING': this.updateKicking(dt); break;
      default: break;
    }
  }

  /** Watchdog: a refused kick (ball not in reach) must never leave the restart hanging. */
  updateKicking(dt) {
    const cur = this.current;
    cur.kickWatch = (cur.kickWatch || 0) + dt;
    if (cur.kicked || cur.kickWatch < 2.0) return;
    cur.kickWatch = 0;
    cur.retries = (cur.retries || 0) + 1;
    const taker = cur.taker;
    if (cur.retries > 2) { this.complete(); return; }
    // Re-seat the taker behind the ball along their facing and try again.
    taker.resetState();
    taker.position.copy(cur.position).addScaledVector(taker.facingDir, -0.9); taker.position.y = 0;
    taker.velocity.set(0, 0, 0);
    cur.phase = 'READY'; cur.timer = 0; cur.aiDelay = 0.3; cur.shot = null;
    this.applyControllerMode();
  }

  updateSetup(dt) {
    const cur = this.current;
    const m = this.match;
    let ready = true;
    for (const p of m.players) {
      if (!p.placement || !p.active) continue;
      const d = p.position.distanceTo(p.placement);
      if (p.isHuman) this.driveTo(p, p.placement, dt); // AI players drive themselves via placement
      if (d > 0.7) ready = false;
    }
    // The taker must be at the ball before the restart can go ahead: wait for them a little longer
    // than everyone else (they may have been far away), then seat them at the spot regardless.
    const takerDist = cur.taker.placement ? cur.taker.position.distanceTo(cur.taker.placement) : 0;
    const takerClose = takerDist < 3.5;
    if (ready || (cur.timer > SET_PIECE.SETUP_TIMEOUT && takerClose) || cur.timer > SET_PIECE.SETUP_TIMEOUT + 3.5) {
      // Nudge stragglers the last bit so nobody is stuck inside the exclusion zone.
      for (const p of m.players) {
        if (!p.placement || !p.active) continue;
        if (p === cur.taker || p.position.distanceTo(p.placement) < 3.5) { p.position.copy(p.placement); p.velocity.set(0, 0, 0); }
        p.setMoveInput(0, 0, false);
        this.facePlayer(p);
      }
      this.enterReady();
    }
  }

  enterReady() {
    const cur = this.current;
    const m = this.match;
    cur.phase = 'READY';
    cur.timer = 0;
    // Only the taker and the human are locked; AI players keep walking to their spots if late.
    // Opponents still inside the exclusion zone are moved out now so the restart is never obstructed.
    const dist = cur.type === RESTART.THROW_IN ? 2.2 : cur.type === RESTART.GOAL_KICK ? PITCH.PENALTY_AREA_DEPTH + 1 : SET_PIECE.OPPONENT_DISTANCE;
    for (const p of m.players) {
      p.locked = p === cur.taker || p.isHuman;
      if (p.team !== cur.team && !p.isGoalkeeper && p.placement && p.position.distanceTo(cur.position) < dist) {
        p.position.copy(p.placement); p.velocity.set(0, 0, 0);
      }
    }
    const taker = cur.taker;
    taker.locked = true;
    this.facePlayer(taker);
    if (cur.type === RESTART.THROW_IN) {
      // Ball into the thrower's hands
      m.possession.locked = false;
      m.possession.assign(m.ball, taker, BALL_STATE.GOALKEEPER_HELD);
      taker.holdMode = 'throwin';
      taker.startHold(30);
      m.possession.locked = true;
      m.ball.frozen = false;
    }
    if (taker === m.human && m.camera) { m.camera.setTarget(taker, false); m.camera.yaw = taker.facing; }
    this.events.emit('set_piece_ready', { type: cur.type, taker });
  }

  updateReady(dt) {
    const cur = this.current;
    const m = this.match;
    const taker = cur.taker;
    // Keep everyone parked (their AI holds placement); the taker keeps facing the target.
    if (!taker.isHuman) {
      if (cur.timer >= cur.aiDelay) this.aiTake();
      return;
    }
    // Human penalty: wait for the controller to hand us a shot request.
    if (cur.type === RESTART.PENALTY && cur.shot) { this.enterRunup(); return; }
    // An idle human (AFK, tabbed out, online opponent waiting) must not freeze the match forever.
    if (cur.timer >= SET_PIECE.HUMAN_TAKE_TIMEOUT) { this.events.emit('toast', { text: 'RESTART TAKEN AUTOMATICALLY' }); this.aiTake(); }
  }

  /** Human penalty input arrives here (from the controller). */
  requestPenaltyShot(shot) {
    const cur = this.current;
    if (!cur || cur.type !== RESTART.PENALTY || cur.phase !== 'READY') return false;
    cur.shot = shot;
    return true;
  }

  enterRunup() {
    const cur = this.current;
    cur.phase = 'RUNUP';
    cur.timer = 0;
    cur.taker.locked = false;
    for (const slot of this.match.slotList()) slot.controller.mode = 'hold';
  }

  updateRunup(dt) {
    const cur = this.current;
    const m = this.match;
    const taker = cur.taker;
    const ball = m.ball;
    tmp.subVectors(ball.position, taker.position); tmp.y = 0;
    const d = tmp.length();
    if (d > KICK.REACH * 0.7 || !taker.ballInKickRange(ball)) {
      tmp.normalize();
      taker.setMoveInput(tmp.x, tmp.z, d > 2.2);
      if (cur.timer > 3) this.executeStoredShot(); // safety
      return;
    }
    taker.setMoveInput(0, 0, false);
    this.executeStoredShot();
  }

  executeStoredShot() {
    const cur = this.current;
    const taker = cur.taker;
    const shot = cur.shot;
    const ok = taker.tryKick(this.match.world, shot.type, shot.power, { dir: shot.dir, lift: shot.lift, isShot: true, setPiece: 'PENALTY' });
    if (!ok) { taker.locked = false; cur.phase = 'READY'; cur.shot = null; this.applyControllerMode(); }
    else cur.phase = 'KICKING';
  }

  /* ------------------------------------------------------------ AI takers */

  aiTake() {
    const cur = this.current;
    const m = this.match;
    const taker = cur.taker;
    const world = m.world;
    const team = taker.team;
    const dir = FormationSystem.attackDir(team);
    const goal = tmp2.set(0, 0, dir * PITCH.HALF_LENGTH);
    const diff = m.teamManager.difficulty;
    cur.phase = 'KICKING';
    taker.locked = true;
    switch (cur.type) {
      case RESTART.PENALTY: {
        cur.shot = this.aiPenaltyShot(taker);
        this.enterRunup();
        return;
      }
      case RESTART.THROW_IN: {
        const target = this.bestReceiver(taker, 18);
        tmp.subVectors(target ? target.position : goal, taker.position).setY(0).normalize();
        const d = target ? taker.position.distanceTo(target.position) : 10;
        taker.throwIn(tmp.clone(), clamp(Math.sqrt(2 * 9.81 * Math.max(1, d) * 0.55), SET_PIECE.THROW_MIN_SPEED, SET_PIECE.THROW_MAX_SPEED), 2.2 + d * 0.06, world, target);
        return;
      }
      case RESTART.CORNER: {
        // Cross toward the penalty spot / far post with some spread.
        const aim = SetPiecePlacements.attackGoalPoint(team, gaussian() * 1.8 - Math.sign(cur.position.x) * dir * 1.2, 6 + rand(0, 3));
        tmp.subVectors(aim, taker.position).setY(0).normalize();
        taker.setAim(tmp);
        taker.tryKick(world, 'hard', 1, { dir: tmp.clone(), lift: 5.5, speed: clamp(taker.position.distanceTo(aim) * 0.95, 16, 24), isPass: true, target: this.bestReceiver(taker, 30) });
        return;
      }
      case RESTART.GOAL_KICK: {
        const short = this.bestReceiver(taker, 22, 8);
        if (short && Math.random() < 0.6) {
          tmp.subVectors(short.position, taker.position).setY(0).normalize();
          const d = taker.position.distanceTo(short.position);
          taker.setAim(tmp);
          taker.tryKick(world, 'low', 0.5, { dir: tmp.clone(), speed: clamp(Math.sqrt(30 + 2 * 3.2 * d), 9, 20), target: short, isPass: true });
        } else {
          tmp.set(gaussian() * 0.35, 0, dir).normalize();
          taker.setAim(tmp);
          taker.tryKick(world, 'hard', 1, { dir: tmp.clone(), lift: 8, speed: 27, isPass: true });
        }
        return;
      }
      default: { // FREE_KICK
        const distGoal = taker.position.distanceTo(goal);
        const angleOK = Math.abs(taker.position.x) < distGoal * 0.8;
        if (distGoal < diff.shootRange + 5 && angleOK && Math.random() < 0.8) {
          const keeper = m.teamManager.getGoalkeeper(team === 0 ? 1 : 0);
          const half = PITCH.GOAL_WIDTH / 2 - 0.5;
          let x = keeper ? (keeper.position.x > 0 ? -half : half) : (Math.random() < 0.5 ? -half : half);
          x += gaussian() * (1.15 - diff.accuracy) * 1.5;
          tmp.set(x - taker.position.x, 0, goal.z - taker.position.z).normalize();
          taker.setAim(tmp);
          taker.tryKick(world, 'hard', 1, { dir: tmp.clone(), lift: lerp(2.2, 5.5, clamp(distGoal / 26, 0, 1)), isShot: true, setPiece: 'FREE_KICK' });
        } else {
          const target = this.bestReceiver(taker, 34);
          if (target) {
            tmp.subVectors(target.position, taker.position).setY(0).normalize();
            const d = taker.position.distanceTo(target.position);
            taker.setAim(tmp);
            if (d > 22) taker.tryKick(world, 'hard', 1, { dir: tmp.clone(), lift: 5, speed: clamp(d, 20, 29), target, isPass: true });
            else taker.tryKick(world, 'low', 0.5, { dir: tmp.clone(), speed: clamp(Math.sqrt(30 + 2 * 3.2 * d), 8, 22), target, isPass: true });
          } else {
            tmp.set(gaussian() * 0.3, 0, dir).normalize();
            taker.setAim(tmp);
            taker.tryKick(world, 'hard', 1, { dir: tmp.clone(), lift: 6, isPass: true });
          }
        }
      }
    }
  }

  aiPenaltyShot(taker) {
    const diff = this.match.teamManager.difficulty;
    const dir = FormationSystem.attackDir(taker.team);
    const half = PITCH.GOAL_WIDTH / 2 - 0.55;
    const corner = (Math.random() < 0.5 ? -1 : 1) * half * lerp(0.6, 1, Math.random());
    const x = corner + gaussian() * (1.2 - diff.accuracy) * 1.3;
    const goalZ = dir * PITCH.HALF_LENGTH;
    const d = new THREE.Vector3(x - this.current.position.x, 0, goalZ - this.current.position.z).normalize();
    const hard = Math.random() < 0.55;
    return { type: hard ? 'hard' : 'low', power: hard ? 1 : 0.95, dir: d, lift: hard ? lerp(1.5, 4.5, Math.random()) : 0.8 };
  }

  /** Most open teammate within range (openness = distance from the nearest opponent). */
  bestReceiver(taker, maxDist, minDist = 3) {
    const m = this.match;
    let best = null;
    for (const p of m.players) {
      if (p.team !== taker.team || p === taker || !p.active || p.isGoalkeeper || p.sm.isDown()) continue;
      const d = taker.position.distanceTo(p.position);
      if (d < minDist || d > maxDist) continue;
      let open = 99;
      for (const o of m.players) if (o.team !== taker.team && o.active) open = Math.min(open, o.position.distanceTo(p.position));
      const dir = FormationSystem.attackDir(taker.team);
      const forward = (p.position.z - taker.position.z) * dir;
      const score = Math.min(open, 8) * 0.7 + forward * 0.04 + (p.isHuman ? 0.8 : 0) - d * 0.02;
      if (!best || score > best.score) best = { p, score };
    }
    return best ? best.p : null;
  }

  /* ------------------------------------------------------------ helpers */

  driveTo(p, target, dt) {
    tmp.subVectors(target, p.position); tmp.y = 0;
    const d = tmp.length();
    if (d < 0.25) { p.setMoveInput(0, 0, false); return; }
    tmp.normalize();
    const mag = d < 1.5 ? clamp(d / 1.5, 0.35, 1) : 1;
    p.setMoveInput(tmp.x * mag, tmp.z * mag, d > 6);
  }

  facePlayer(p) {
    const cur = this.current;
    const m = this.match;
    if (p === cur.taker) {
      if (cur.type === RESTART.THROW_IN) tmp.set(-Math.sign(p.position.x || 1), 0, 0);
      else if (cur.type === RESTART.GOAL_KICK) tmp.set(0, 0, FormationSystem.attackDir(p.team));
      else if (cur.type === RESTART.CORNER) SetPiecePlacements.attackGoalPoint(p.team, 0, 8, tmp).sub(p.position).setY(0); // face the box, ball in front
      else tmp.set(0, 0, FormationSystem.attackDir(p.team) * PITCH.HALF_LENGTH).sub(p.position).setY(0);
    } else {
      tmp.subVectors(m.ball.position, p.position).setY(0);
    }
    if (tmp.lengthSq() > 1e-4) {
      tmp.normalize();
      p.facing = Math.atan2(tmp.x, tmp.z);
      p.facingDir.copy(tmp);
      p.aimDir.copy(tmp);
    }
    p.faceAim = false;
  }

  /** Called by the match when the taker's kick/throw event fires. */
  onTakerKick(d) {
    const cur = this.current;
    if (!cur || d.player !== cur.taker || cur.kicked) return false;
    cur.kicked = true;
    this.complete();
    return true;
  }

  complete() {
    const cur = this.current;
    if (!cur) return;
    const m = this.match;
    this.cleanup();
    this.events.emit('set_piece_taken', { type: cur.type, team: cur.team, taker: cur.taker, shootout: !!cur.shootout });
    if (cur.onTaken) cur.onTaken();
    if (!cur.shootout) m.resumePlay();
    else { m.frozen = false; m.ball.frozen = false; m.possession.locked = false; } // shootout: ball is live, match state stays
  }

  cancel() { this.cleanup(); }

  cleanup() {
    const m = this.match;
    for (const p of m.players) { p.placement = null; p.locked = false; if (p.isGoalkeeper && p.ai) p.ai.holdLine = false; }
    m.possession.locked = false;
    m.ball.frozen = false;
    this.current = null;
    for (const slot of m.slotList()) { slot.controller.mode = 'normal'; slot.gkController.mode = 'normal'; }
    if (m.camera && m.human) m.camera.setRig(m.human.isGoalkeeper ? 'keeper' : 'player');
  }
}
