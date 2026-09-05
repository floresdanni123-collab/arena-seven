import * as THREE from 'three';
import { PITCH, PLAYER, TACKLE, KICK, BALL, BALL_STATE, PLAYER_STATE as S, ROLE } from '../utils/Constants.js';
import { FormationSystem } from './FormationSystem.js';
import { clamp, lerp, rand, gaussian, angleDelta, yawFromDir } from '../utils/MathUtils.js';

const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), tmp3 = new THREE.Vector3(), goalPos = new THREE.Vector3(), ownGoalPos = new THREE.Vector3();

/**
 * Outfield AI. Receives a task from TeamAI (CARRY / SUPPORT / CHASE / PRESS / COVER / MARK / HOLD)
 * and turns it into movement intents and actions on its Player. Decisions are made at a think
 * interval that includes the difficulty's reaction delay; movement is updated every frame.
 */
export class AIPlayer {
  constructor(player, teamAI, difficulty) {
    this.player = player;
    this.teamAI = teamAI;
    this.diff = difficulty;
    this.thinkTimer = rand(0, 0.15);
    this.moveTarget = new THREE.Vector3().copy(player.position);
    this.sprint = false;
    this.arrive = 0.6;
    this.task = 'HOLD';
    this.decisionCooldown = 0;
    this.dribbleDir = new THREE.Vector3();
    this.carryTime = 0;
    this.jukeConsidered = 0;
    this.holdBallTimer = 0;
    player.speedMult = difficulty.speedMult;
  }

  update(dt, world) {
    const me = this.player;
    this.thinkTimer -= dt;
    this.decisionCooldown = Math.max(0, this.decisionCooldown - dt);
    // Set pieces: walk to the assigned spot, face the ball and wait for the restart.
    if (me.placement) {
      this.task = 'SETPIECE';
      this.moveTarget.copy(me.placement);
      this.sprint = me.position.distanceTo(me.placement) > 8;
      this.arrive = 0.3;
      me.targetPosition.copy(this.moveTarget);
      this.applyMovement(dt, world);
      return;
    }
    if (this.thinkTimer <= 0) {
      this.thinkTimer = 0.1 + this.diff.reaction * 0.5 + rand(0, 0.05);
      this.think(world);
    }
    if (me.hasBall) this.carryTime += dt; else this.carryTime = 0;
    this.applyMovement(dt, world);
  }

  /* ------------------------------------------------------------ movement */

  applyMovement(dt, world) {
    const me = this.player;
    if (!me.sm.canMove()) { me.setMoveInput(0, 0, false); return; }
    tmp.subVectors(this.moveTarget, me.position); tmp.y = 0;
    const d = tmp.length();
    if (d < this.arrive * 0.5) {
      me.setMoveInput(0, 0, false);
      // face the ball while waiting
      tmp2.subVectors(world.ball.position, me.position); tmp2.y = 0;
      if (tmp2.lengthSq() > 0.01) { me.faceAim = true; me.setAim(tmp2); } else me.faceAim = false;
      return;
    }
    me.faceAim = false;
    tmp.normalize();
    // slow down on arrival
    const mag = d < this.arrive * 2 ? clamp(d / (this.arrive * 2), 0.35, 1) : 1;
    // Local avoidance of other players (light)
    for (const o of world.players) {
      if (o === me) continue;
      tmp2.subVectors(me.position, o.position); tmp2.y = 0;
      const od = tmp2.length();
      if (od < 1.4 && od > 0.01 && !(me.hasBall && false)) {
        tmp.addScaledVector(tmp2.normalize(), (1.4 - od) * 0.6);
      }
    }
    tmp.normalize();
    me.setMoveInput(tmp.x * mag, tmp.z * mag, this.sprint && d > 2.5);
  }

  /* ------------------------------------------------------------ decisions */

  think(world) {
    const me = this.player;
    const ball = world.ball;
    const a = this.teamAI.getAssignment(me);
    this.task = a.task;
    goalPos.set(0, 0, FormationSystem.attackDir(me.team) * PITCH.HALF_LENGTH);
    ownGoalPos.set(0, 0, -FormationSystem.attackDir(me.team) * PITCH.HALF_LENGTH);

    if (me.hasBall) { this.decideWithBall(world); return; }

    switch (a.task) {
      case 'CHASE': {
        // Intercept: aim a little ahead of the ball along its velocity.
        const dist = me.position.distanceTo(ball.position);
        const lead = clamp(dist / 9, 0, 0.9);
        this.moveTarget.copy(ball.position).addScaledVector(ball.velocity, lead);
        this.moveTarget.y = 0;
        this.sprint = dist > 3;
        this.arrive = 0.3;
        break;
      }
      case 'PRESS': {
        const carrier = ball.owner;
        if (carrier) {
          // Approach from the goal side so the carrier is forced wide.
          tmp.subVectors(ownGoalPos, carrier.position).normalize();
          this.moveTarget.copy(carrier.position).addScaledVector(tmp, 0.9);
          const d = me.position.distanceTo(carrier.position);
          this.sprint = d > 4;
          this.arrive = 0.4;
          this.considerTackle(world, carrier, d);
        } else {
          this.moveTarget.copy(ball.position);
          this.sprint = true; this.arrive = 0.3;
        }
        break;
      }
      case 'COVER': {
        // Second defender: sit between the carrier and our goal, a few metres back.
        const carrier = ball.owner || null;
        const ref = carrier ? carrier.position : ball.position;
        tmp.subVectors(ownGoalPos, ref).normalize();
        this.moveTarget.copy(ref).addScaledVector(tmp, 5.5);
        this.moveTarget.x = lerp(this.moveTarget.x, a.target.x, 0.35);
        this.sprint = me.position.distanceTo(this.moveTarget) > 6;
        this.arrive = 0.8;
        break;
      }
      case 'MARK': {
        const m = a.markTarget;
        if (m) {
          // goal side of the marked player, tightness from difficulty
          tmp.subVectors(ownGoalPos, m.position).normalize();
          const gap = lerp(2.6, 1.2, this.diff.markingTightness);
          this.moveTarget.copy(m.position).addScaledVector(tmp, gap);
          this.sprint = me.position.distanceTo(this.moveTarget) > 7;
          this.arrive = 0.7;
          // intercept passes going to my man
          if (ball.state === BALL_STATE.KICKED && ball.velocity.lengthSq() > 4) {
            tmp2.subVectors(m.position, ball.position);
            const toBall = ball.velocity.clone().normalize();
            if (tmp2.normalize().dot(toBall) > 0.9 && me.position.distanceTo(ball.position) < 10) {
              this.moveTarget.copy(ball.position).addScaledVector(ball.velocity, 0.35);
              this.sprint = true;
            }
          }
        } else { this.moveTarget.copy(a.target); this.sprint = false; this.arrive = 1.0; }
        break;
      }
      case 'SUPPORT': {
        this.moveTarget.copy(a.target);
        // Make yourself available: if an opponent is close to the support point, shift away from them.
        for (const o of world.players) {
          if (o.team === me.team) continue;
          tmp.subVectors(this.moveTarget, o.position); tmp.y = 0;
          const d = tmp.length();
          if (d < 3 && d > 0.01) this.moveTarget.addScaledVector(tmp.normalize(), 3 - d);
        }
        this.clampToPitch(this.moveTarget);
        this.sprint = me.position.distanceTo(this.moveTarget) > 9;
        this.arrive = 1.2;
        break;
      }
      default: { // HOLD -> formation anchor
        this.moveTarget.copy(a.target);
        this.sprint = me.position.distanceTo(this.moveTarget) > 12;
        this.arrive = 1.2;
      }
    }
    me.targetPosition.copy(this.moveTarget);
  }

  considerTackle(world, carrier, d) {
    const me = this.player;
    if (!me.tackleReady || !me.sm.canTackle() || this.decisionCooldown > 0) return;
    if (d > TACKLE.REACH + 1.2 || d < 0.6) return;
    // Only tackle when the carrier is roughly in front of us and we are moving toward them.
    tmp.subVectors(carrier.position, me.position).normalize();
    const facing = tmp.dot(me.facingDir);
    // Only refuse when the carrier is clearly behind us; the lunge itself follows moveInput.
    if (facing < 0.2 && d > 1.2) return;
    // Don't slide in when the carrier just juked (we'd be baited) - unless aggressive.
    if (carrier.evadeActive && Math.random() > this.diff.tackleAggression * 0.4) return;
    // Prefer to tackle when the carrier is moving across/away (harder to shield) and close.
    // Sliding in from behind is usually a foul, so the AI mostly waits for a side-on or front-on chance.
    const fromBehind = carrier.facingDir.dot(tmp) > 0.6;
    const chance = this.diff.tackleAggression * 0.5 * (d < 1.9 ? 1 : 0.5) * (carrier.speed > 3 ? 1.2 : 0.8) * (fromBehind ? 0.3 : 1);
    if (Math.random() < chance) {
      me.setMoveInput(tmp.x, tmp.z, true);
      me.requestTackle(world);
      this.decisionCooldown = 1.0;
    } else {
      this.decisionCooldown = 0.7;
    }
  }

  /* ------------------------------------------------------------ with the ball */

  decideWithBall(world) {
    const me = this.player;
    const ball = world.ball;
    const attackDir = FormationSystem.attackDir(me.team);
    const distGoal = me.position.distanceTo(goalPos);
    const nearestOpp = this.nearestOpponent(world, me.position);
    const pressure = nearestOpp ? nearestOpp.d : 99;
    const oppTackling = nearestOpp && nearestOpp.p.sm.is(S.TACKLING) && nearestOpp.d < 3.2;

    // 1. Emergency: an opponent is sliding in -> juke (skill scaled by difficulty)
    if (oppTackling && me.jukeReady && me.sm.canJuke() && Math.random() < this.diff.accuracy * 0.9) {
      tmp.subVectors(nearestOpp.p.position, me.position);
      const left = tmp2.set(me.facingDir.z, 0, -me.facingDir.x);
      const side = tmp.dot(left) > 0 ? -1 : 1; // step away from the tackler
      me.requestJuke(world, side);
      this.decisionCooldown = 0.6;
      return;
    }
    if (this.decisionCooldown > 0 || !me.sm.canKick()) { this.dribble(world, nearestOpp); return; }

    // 2. Shooting
    const shootRange = this.diff.shootRange;
    const angleOK = Math.abs(me.position.x) < distGoal * 0.9 + 4;
    if (distGoal < shootRange && angleOK) {
      const lane = this.laneOpenness(world, me.position, goalPos, me.team);
      const shotChance = clamp((shootRange - distGoal) / shootRange + 0.35, 0, 1) * (0.5 + lane * 0.5) * (pressure < 2 ? 1.3 : 1);
      if (Math.random() < shotChance || distGoal < 9) { this.shoot(world, distGoal); return; }
    }

    // 3. Passing - only once the ball is settled, when pressed, when a clearly better option exists,
    //    or after carrying for a while. Otherwise the carrier keeps driving forward.
    const pass = this.bestPass(world);
    const settled = this.carryTime > 0.45;
    const spaceAhead = this.spaceAhead(world);
    const wantPass = pass && settled && (
      (pressure < 2.2 && Math.random() < 0.8) ||
      (spaceAhead < 5 && pass.score > 1.6 && Math.random() < this.diff.passVision * 0.7) ||
      (this.carryTime > 3.5 + Math.random() * 2.5 && Math.random() < 0.6)
    );
    if (wantPass) { this.pass(world, pass); return; }

    // 4. Clear if deep in own half under pressure
    const ownHalfDepth = -this.teamAI.formation.normZ(me.team, me.position.z);
    if (ownHalfDepth > 0.55 && pressure < 2.2) {
      tmp.set(gaussian() * 0.5, 0, attackDir).normalize();
      me.setAim(tmp);
      me.tryKick(world, 'hard', 1, { dir: tmp, lift: 7 });
      this.decisionCooldown = 0.6;
      return;
    }

    // 5. Dribble
    this.dribble(world, nearestOpp);
  }

  dribble(world, nearestOpp) {
    const me = this.player;
    tmp.subVectors(goalPos, me.position); tmp.y = 0; tmp.normalize();
    // steer around nearby opponents
    for (const o of world.players) {
      if (o.team === me.team) continue;
      tmp2.subVectors(me.position, o.position); tmp2.y = 0;
      const d = tmp2.length();
      if (d < 5 && d > 0.01) {
        // steer around opponents in the way, without giving up ground
        tmp2.normalize();
        const inFront = -tmp2.dot(tmp) > 0.2 ? 1 : 0.4;
        tmp.addScaledVector(tmp2, (5 - d) / 5 * 0.9 * inFront);
      }
    }
    // stay off the touchline
    if (Math.abs(me.position.x) > PITCH.HALF_WIDTH - 4) tmp.x -= Math.sign(me.position.x) * 0.8;
    tmp.normalize();
    this.dribbleDir.lerp(tmp, 0.5).normalize();
    this.moveTarget.copy(me.position).addScaledVector(this.dribbleDir, 6);
    this.clampToPitch(this.moveTarget);
    this.sprint = !nearestOpp || nearestOpp.d > 3.5;
    this.arrive = 0.2;
    me.targetPosition.copy(this.moveTarget);
  }

  shoot(world, distGoal) {
    const me = this.player;
    const keeper = world.players.find((p) => p.isGoalkeeper && p.team !== me.team);
    // Pick the corner away from the keeper, with difficulty-based error.
    const half = PITCH.GOAL_WIDTH / 2 - 0.55;
    let targetX = keeper ? (keeper.position.x > 0 ? -half : half) : (Math.random() < 0.5 ? -half : half);
    targetX += gaussian() * (1.2 - this.diff.accuracy) * 1.6;
    tmp.set(targetX - me.position.x, 0, goalPos.z - me.position.z).normalize();
    me.setAim(tmp);
    me.stats.shots++;
    if (distGoal > 13 || Math.random() < 0.35) {
      me.tryKick(world, 'hard', 1, { dir: tmp, lift: lerp(1.5, 4.5, Math.random()) });
    } else {
      const power = clamp(0.7 + distGoal / 30, 0.75, 1);
      me.tryKick(world, 'low', power, { dir: tmp });
    }
    this.decisionCooldown = 0.7;
    world.events.emit('ai_shot', { player: me });
  }

  pass(world, pass) {
    const me = this.player;
    const target = pass.player;
    // lead the receiver
    const dist = me.position.distanceTo(target.position);
    tmp.copy(target.position).addScaledVector(target.velocity, clamp(dist / 14, 0.1, 1.0));
    tmp.sub(me.position); tmp.y = 0;
    const d = tmp.length(); tmp.normalize();
    const err = (1 - this.diff.accuracy) * 0.14 * gaussian();
    tmp.applyAxisAngle(new THREE.Vector3(0, 1, 0), err);
    me.setAim(tmp);
    if (d > 24 && Math.random() < 0.6) {
      me.tryKick(world, 'hard', 1, { dir: tmp, lift: 5, speed: clamp(d * 0.95, 20, 30), target, isPass: true });
    } else {
      // Speed so the ball arrives with ~5.5 m/s left after rolling resistance (plus a little drag).
      const arrive = 5.5, decel = BALL.ROLL_DECEL * 1.25;
      const speed = clamp(Math.sqrt(arrive * arrive + 2 * decel * d) * (1 + (1 - this.diff.accuracy) * 0.12 * gaussian()), 7, 24);
      me.tryKick(world, 'low', clamp(speed / KICK.LOW_MAX_SPEED, 0.15, 1), { dir: tmp, target, isPass: true, speed });
    }
    this.decisionCooldown = 0.5;
  }

  /** Distance to the nearest opponent inside a forward cone toward the goal (99 if clear). */
  spaceAhead(world) {
    const me = this.player;
    tmp3.subVectors(goalPos, me.position); tmp3.y = 0; tmp3.normalize();
    let best = 99;
    for (const o of world.players) {
      if (o.team === me.team || o.isGoalkeeper) continue;
      tmp2.subVectors(o.position, me.position); tmp2.y = 0;
      const d = tmp2.length();
      if (d < 0.01 || d > 12) continue;
      if (tmp2.divideScalar(d).dot(tmp3) > 0.5 && d < best) best = d;
    }
    return best;
  }

  /* ------------------------------------------------------------ evaluation helpers */

  nearestOpponent(world, pos) {
    let best = null;
    for (const p of world.players) {
      if (p.team === this.player.team || p.sm.isDown()) continue;
      const d = p.position.distanceTo(pos);
      if (!best || d < best.d) best = { p, d };
    }
    return best;
  }

  /** 0..1 how clear the line from a to b is of opponents (1 = nobody near the lane). */
  laneOpenness(world, a, b, team) {
    let worst = 1;
    tmp3.subVectors(b, a); const len = tmp3.length(); tmp3.normalize();
    for (const p of world.players) {
      if (p.team === team || p.isGoalkeeper) continue;
      tmp2.subVectors(p.position, a);
      const t = tmp2.dot(tmp3);
      if (t < 0.5 || t > len) continue;
      const perp = Math.sqrt(Math.max(0, tmp2.lengthSq() - t * t));
      const open = clamp(perp / 2.2, 0, 1);
      if (open < worst) worst = open;
    }
    return worst;
  }

  bestPass(world) {
    const me = this.player;
    let best = null;
    for (const p of world.players) {
      if (p === me || p.team !== me.team || p.sm.isDown() || p.isGoalkeeper) continue;
      const d = me.position.distanceTo(p.position);
      if (d < 3 || d > 34) continue;
      const lane = this.laneOpenness(world, me.position, p.position, me.team);
      if (lane < 0.3) continue;
      const nearestOpp = this.nearestOpponent(world, p.position);
      const space = nearestOpp ? clamp(nearestOpp.d / 6, 0, 1) : 1;
      const forward = (p.position.distanceTo(goalPos) < me.position.distanceTo(goalPos)) ? 0.45 : 0;
      const towardGoal = clamp(1 - p.position.distanceTo(goalPos) / 60, 0, 1) * 0.4;
      const score = lane * 0.6 + space * 0.7 + forward + towardGoal - d * 0.008 + (p.isHuman ? 0.12 : 0);
      if (!best || score > best.score) best = { player: p, score, distance: d };
    }
    return best;
  }

  clampToPitch(v) {
    v.x = clamp(v.x, -PITCH.HALF_WIDTH + 1, PITCH.HALF_WIDTH - 1);
    v.z = clamp(v.z, -PITCH.HALF_LENGTH + 1.5, PITCH.HALF_LENGTH - 1.5);
    v.y = 0;
  }
}
