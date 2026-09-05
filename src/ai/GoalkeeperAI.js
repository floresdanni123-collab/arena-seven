import * as THREE from 'three';
import { PITCH, GOALKEEPER, BALL_STATE, BALL, PLAYER_STATE as S, CONTROL } from '../utils/Constants.js';
import { FormationSystem } from './FormationSystem.js';
import { GoalkeeperSkills } from '../player/GoalkeeperSkills.js';
import { clamp, lerp, rand, gaussian, timeToPlaneZ, predictBallistic, dirFromYaw } from '../utils/MathUtils.js';

const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), pred = new THREE.Vector3(), hands = new THREE.Vector3();

/**
 * Goalkeeper brain. Positions on the ball-goal line, predicts shots with a human-like reaction delay,
 * dives toward the predicted crossing point, catches slow/central balls and parries powerful ones,
 * collects safe loose balls, rushes attackers who get close, and distributes after a catch.
 */
export class GoalkeeperAI {
  constructor(player, teamAI, difficulty) {
    this.player = player;
    this.teamAI = teamAI;
    this.diff = difficulty;
    this.mode = 'POSITION';
    this.goalZ = -FormationSystem.attackDir(player.team) * PITCH.HALF_LENGTH;
    this.forward = FormationSystem.attackDir(player.team); // direction from goal into the pitch
    this.goalCenter = new THREE.Vector3(0, 0, this.goalZ);
    this.threat = null;        // { t, x, y, detectedAt, reactAt, reacted }
    this.moveTarget = new THREE.Vector3(0, 0, this.goalZ + this.forward * GOALKEEPER.BASE_DEPTH);
    this.sprint = false;
    this.rushTimer = 0;
    this.holdDecision = null;
    this.debugPrediction = new THREE.Vector3();
    this.lastSaveTime = -10;
    player.ai = this;
  }

  update(dt, world) {
    const me = this.player;
    const ball = world.ball;
    const st = me.sm.state;

    // Always face the ball (keeper "watches" play)
    tmp.subVectors(ball.position, me.position); tmp.y = 0;
    if (tmp.lengthSq() > 0.5 && (st !== S.THROWING && st !== S.KICKING)) { me.faceAim = true; me.setAim(tmp); }

    if (st === S.DIVING) { this.updateDive(dt, world); return; }
    if (st === S.HOLDING || st === S.THROWING || st === S.KICKING) { me.setMoveInput(0, 0, false); return; }
    if (!me.sm.canMove()) { me.setMoveInput(0, 0, false); return; }

    // Set pieces: go to the placement and wait (penalties: stay on the line until the kick).
    if (me.placement) {
      this.threat = null;
      this.moveTarget.copy(me.placement);
      this.sprint = me.position.distanceTo(me.placement) > 6;
      this.applyMovement(world, true);
      return;
    }

    // Ball already in my hands? (possession assigned by pickup)
    if (ball.owner === me && ball.state !== BALL_STATE.GOALKEEPER_HELD) {
      if (!this.catchBall(world, false)) { world.possession.release(ball); }
      return;
    }

    this.detectThreat(world);
    if (this.threat && this.threat.reacted) {
      // Acting on a shot: move to the predicted x, dive if we can't get there in time.
      this.reactToShot(world);
    } else {
      this.positionSelf(world, dt);
    }
    this.tryCollect(world);
    this.applyMovement(world);
  }

  /* ------------------------------------------------------------ shot prediction */

  detectThreat(world) {
    const ball = world.ball;
    const me = this.player;
    const towardGoal = -this.forward; // ball must travel toward our goal line
    const vz = ball.velocity.z * towardGoal;
    const speed = ball.speed;
    const inFlight = ball.state === BALL_STATE.KICKED || ball.state === BALL_STATE.LOOSE || ball.state === BALL_STATE.FREE;
    const distToLine = Math.abs(ball.position.z - this.goalZ);
    if (!inFlight || vz < 3 || speed < 6 || distToLine > 34 || ball.owner) { this.threat = null; return; }

    // Predict where the ball crosses the keeper's line (slightly in front of the goal line).
    const lineZ = this.goalZ + this.forward * 0.9;
    // Drag makes the ball slower than the instantaneous velocity suggests; scale for prediction.
    tmp2.copy(ball.velocity).multiplyScalar(0.93);
    const t = timeToPlaneZ(ball.position, tmp2, lineZ);
    if (!isFinite(t) || t > 2.2) { this.threat = null; return; }
    predictBallistic(ball.position, tmp2, t, BALL.GRAVITY, pred);
    // Bounces: if the prediction dips below ground, assume it bounces and stays low.
    if (pred.y < ball.radius) pred.y = ball.radius + Math.abs(pred.y) * 0.3;
    this.debugPrediction.copy(pred);
    const onTarget = Math.abs(pred.x) < PITCH.GOAL_WIDTH / 2 + 0.9 && pred.y < PITCH.GOAL_HEIGHT + 0.8;
    if (!onTarget) { this.threat = null; return; }

    if (!this.threat) {
      const reaction = lerp(GOALKEEPER.REACTION_MIN, GOALKEEPER.REACTION_MAX, Math.random()) * this.diff.gkReactionMult;
      this.threat = { detectedAt: world.time, reactAt: world.time + reaction, reacted: false, t, x: pred.x, y: pred.y };
    } else {
      this.threat.t = t; this.threat.x = pred.x; this.threat.y = pred.y;
      if (world.time >= this.threat.reactAt) this.threat.reacted = true;
    }
  }

  reactToShot(world) {
    const me = this.player;
    const th = this.threat;
    const dx = th.x - me.position.x;
    const timeLeft = th.t;
    const runSpeed = GOALKEEPER.SPRINT;
    const canRun = Math.abs(dx) < runSpeed * timeLeft * 0.75 + 0.35;
    const reach = GOALKEEPER.DIVE_REACH * this.diff.gkReach;

    if (Math.abs(dx) < 0.55 && th.y < 1.9) {
      // Right at us: hold position, ready to catch.
      this.moveTarget.set(th.x, 0, me.position.z);
      this.sprint = false;
      return;
    }
    // Dive commitment point: the wider the ball, the earlier the keeper has to go.
    const diveAt = clamp(0.38 + Math.abs(dx) * 0.16, 0.4, 0.95);
    if (canRun && timeLeft > diveAt) {
      this.moveTarget.set(th.x, 0, me.position.z);
      this.sprint = true;
      return;
    }
    // Dive now if the ball is reachable and about to arrive.
    if (timeLeft < diveAt && Math.abs(dx) < reach + 0.5 && me.sm.isLocomotion()) {
      // Which side is that from the keeper's point of view? Keeper faces the pitch (aimDir).
      dirFromYaw(me.facing, tmp);
      const left = tmp2.set(tmp.z, 0, -tmp.x);
      const side = Math.sign(dx * left.x) || 1;
      const low = th.y < 0.9;
      const speed = clamp(Math.abs(dx) / Math.max(timeLeft, 0.25), 3.5, 9.5);
      me.startDive(side, low, speed, world);
      this.diveTarget = { x: th.x, y: th.y };
      world.events.emit('gk_dive', { player: me });
    }
  }

  updateDive(dt, world) {
    const me = this.player;
    const outcome = GoalkeeperSkills.updateDiveContact(world, me, dt, { catchSkill: this.diff.gkReach, reach: this.diff.gkReach });
    if (outcome) { this.threat = null; if (outcome === 'catch') this.mode = 'HOLD'; }
  }

  /* ------------------------------------------------------------ positioning */

  positionSelf(world, dt) {
    const me = this.player;
    const ball = world.ball;
    const ownerIsOpp = ball.owner && ball.owner.team !== me.team;

    // Rush decision: attacker very close with the ball, few defenders between.
    const ballDist = ball.position.distanceTo(this.goalCenter);
    if (ownerIsOpp && ballDist < GOALKEEPER.RUSH_DISTANCE && this.rushTimer <= 0 && Math.abs(ball.position.x) < 7) {
      const defendersBetween = world.players.filter((p) => p.team === me.team && !p.isGoalkeeper && Math.abs(p.position.z - ball.position.z) < 3 && Math.abs(p.position.x - ball.position.x) < 3).length;
      if (defendersBetween === 0 && Math.random() < 0.5 * this.diff.gkReach) { this.mode = 'RUSH'; this.rushTimer = 1.6; }
    }
    if (this.mode === 'RUSH') {
      this.rushTimer -= dt;
      tmp.subVectors(ball.position, this.goalCenter);
      const d = tmp.length();
      tmp.normalize();
      this.moveTarget.copy(this.goalCenter).addScaledVector(tmp, Math.min(d * 0.7, 9));
      this.sprint = true;
      // Smother if the ball is within reach and loose enough
      if (me.position.distanceTo(ball.position) < 1.2 && ball.speed < 9 && !ball.owner) this.catchBall(world, false);
      else if (me.position.distanceTo(ball.position) < 1.5 && ownerIsOpp && me.sm.isLocomotion() && Math.random() < 0.6) {
        // dive at the attacker's feet
        dirFromYaw(me.facing, tmp); const left = tmp2.set(tmp.z, 0, -tmp.x);
        const side = Math.sign(tmp2.subVectors(ball.position, me.position).dot(left)) || 1;
        me.startDive(side, true, 5, world);
      }
      if (this.rushTimer <= 0 || !ownerIsOpp || ballDist > GOALKEEPER.RUSH_DISTANCE + 4) { this.mode = 'POSITION'; this.rushTimer = 2.5; }
      return;
    }
    this.rushTimer = Math.max(0, this.rushTimer - dt);
    this.mode = 'POSITION';

    // Bisect the angle: stand on the line between goal centre and ball, a bit off the line.
    tmp.subVectors(ball.position, this.goalCenter); tmp.y = 0;
    const d = tmp.length();
    tmp.normalize();
    const far = clamp((d - 8) / 30, 0, 1);
    let depth = GOALKEEPER.BASE_DEPTH + far * 2.4 + (ownerIsOpp ? 0 : 1.2);
    depth = Math.min(depth, GOALKEEPER.MAX_DEPTH);
    this.moveTarget.copy(this.goalCenter).addScaledVector(tmp, depth);
    // Shift toward the near post when the ball is wide, but never beyond the post.
    const postLimit = PITCH.GOAL_WIDTH / 2 - 0.45;
    this.moveTarget.x = clamp(this.moveTarget.x + Math.sign(ball.position.x) * far * 0.3, -postLimit - 0.6, postLimit + 0.6);
    // Never behind the line
    const minZ = this.goalZ + this.forward * 0.7;
    if ((this.moveTarget.z - minZ) * this.forward < 0) this.moveTarget.z = minZ;
    this.sprint = me.position.distanceTo(this.moveTarget) > 3.5;
  }

  tryCollect(world) {
    const me = this.player;
    const ball = world.ball;
    if (ball.owner || this.threat) return;
    const inBox = Math.abs(ball.position.x) < PITCH.PENALTY_AREA_WIDTH / 2 + 1 && (ball.position.z - this.goalZ) * this.forward < PITCH.PENALTY_AREA_DEPTH + 1 && (ball.position.z - this.goalZ) * this.forward > -1;
    if (!inBox) return;
    let nearestOpp = 99;
    for (const p of world.players) if (p.team !== me.team) nearestOpp = Math.min(nearestOpp, p.position.distanceTo(ball.position));
    const myDist = me.position.distanceTo(ball.position);
    const safe = ball.speed < 12 && (myDist < nearestOpp * 0.9 || nearestOpp > 6);
    if (!safe) return;
    this.mode = 'COLLECT';
    this.moveTarget.copy(ball.position).addScaledVector(ball.velocity, 0.2);
    this.sprint = myDist > 2;
    if (myDist < 1.1 && ball.position.y < 1.2) {
      if (nearestOpp < 2.5 && me.sm.isLocomotion() && Math.random() < 0.5) {
        // Opponent arriving: dive onto the ball
        dirFromYaw(me.facing, tmp); const left = tmp2.set(tmp.z, 0, -tmp.x);
        const side = Math.sign(tmp2.subVectors(ball.position, me.position).dot(left)) || 1;
        me.startDive(side, true, 4, world);
      } else {
        this.catchBall(world, false, true);
      }
    }
  }

  applyMovement(world, free = false) {
    const me = this.player;
    // Keep the keeper inside the box region (set-piece placements may send them anywhere).
    if (!free) {
      const maxDepth = PITCH.PENALTY_AREA_DEPTH + 2;
      const depth = (this.moveTarget.z - this.goalZ) * this.forward;
      if (depth > maxDepth) this.moveTarget.z = this.goalZ + this.forward * maxDepth;
      this.moveTarget.x = clamp(this.moveTarget.x, -PITCH.PENALTY_AREA_WIDTH / 2 - 1, PITCH.PENALTY_AREA_WIDTH / 2 + 1);
    }
    if (this.holdLine) {
      // Penalty: stay on the goal line until the kick, shuffling sideways only.
      this.moveTarget.z = this.goalZ + this.forward * 0.35;
      this.moveTarget.x = clamp(this.moveTarget.x, -1.2, 1.2);
    }
    tmp.subVectors(this.moveTarget, me.position); tmp.y = 0;
    const d = tmp.length();
    me.targetPosition.copy(this.moveTarget);
    if (d < 0.18) { me.setMoveInput(0, 0, false); return; }
    tmp.normalize();
    const mag = d < 1.2 ? clamp(d / 1.2, 0.3, 1) : 1;
    me.setMoveInput(tmp.x * mag, tmp.z * mag, this.sprint && d > 1.5);
  }

  /* ------------------------------------------------------------ catching / parrying / distribution */

  /** Hands-rule aware catch (GoalkeeperSkills refuses outside the box). Returns true on success. */
  catchBall(world, wasDive, pickup = false) {
    const ok = GoalkeeperSkills.catchBall(world, this.player, { wasDive, pickup });
    if (ok) { this.threat = null; this.mode = 'HOLD'; }
    return ok;
  }

  parry(world) {
    GoalkeeperSkills.parry(world, this.player, { body: !GoalkeeperSkills.canUseHands(this.player, world.ball) });
    this.threat = null;
  }

  /** Called by the Player when the HOLDING state times out: choose how to distribute. */
  onHoldExpired() {
    const me = this.player;
    const world = this.world;
    if (!world || world.ball.owner !== me) { me.sm.set(S.IDLE); return; }
    // Score teammates by openness and how far forward they are; prefer a safe throw to a near player.
    let best = null;
    for (const p of world.players) {
      if (p.team !== me.team || p === me || p.sm.isDown()) continue;
      let nearestOpp = 99;
      for (const o of world.players) if (o.team !== me.team) nearestOpp = Math.min(nearestOpp, o.position.distanceTo(p.position));
      const d = me.position.distanceTo(p.position);
      const forward = (p.position.z - me.position.z) * this.forward;
      const score = clamp(nearestOpp / 8, 0, 1) * 1.2 + clamp(forward / 40, 0, 1) * 0.6 - (d > 26 ? 0.4 : 0) + (p.isHuman ? 0.15 : 0);
      if (!best || score > best.score) best = { p, score, d };
    }
    if (!best) { me.sm.set(S.IDLE); return; }
    tmp.subVectors(best.p.position, me.position).addScaledVector(best.p.velocity, 0.6); tmp.y = 0; tmp.normalize();
    if (best.d < 22) {
      me.startThrow(tmp, clamp(best.d * 0.8, 8, GOALKEEPER.THROW_SPEED), 2.2 + best.d * 0.05, world);
    } else {
      tmp.applyAxisAngle(new THREE.Vector3(0, 1, 0), gaussian() * 0.08);
      me.startKickOut(tmp, GOALKEEPER.KICK_SPEED, 7.5, world);
    }
    this.mode = 'POSITION';
  }

  setWorld(world) { this.world = world; }
}
