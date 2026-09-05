import * as THREE from 'three';
import { PlayerStateMachine } from './PlayerStateMachine.js';
import { PlayerAnimationController } from './PlayerAnimationController.js';
import { PLAYER, PLAYER_STATE as S, TACKLE, JUKE, KICK, PITCH, BALL_STATE, GOALKEEPER, ROLE } from '../utils/Constants.js';
import { clamp, lerp, damp, dampAngle, yawFromDir, dirFromYaw, angleDelta, closestPointOnSegment, rand, randInt, gaussian, V3 } from '../utils/MathUtils.js';

const UP = new THREE.Vector3(0, 1, 0);
const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3(), tmpD = new THREE.Vector3();

/**
 * A football player entity: movement, state machine, abilities (kicks, slide tackle, juke), knock-downs
 * and goalkeeper actions. Human input and AI both drive a player exclusively through the public
 * intent API (setMoveInput / setAim / requestTackle / requestJuke / beginCharge / releaseCharge / hardKick).
 */
export class Player {
  constructor({ id, team, role, name, number, model, isHuman = false, difficulty }) {
    this.id = id;
    this.team = team;
    this.role = role;
    this.isGoalkeeper = role === ROLE.GOALKEEPER;
    this.name = name;
    this.number = number;
    this.model = model;
    this.isHuman = isHuman;
    this.difficulty = difficulty;
    this.ai = null;

    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.facing = 0;            // yaw, 0 = +Z
    this.facingDir = new THREE.Vector3(0, 0, 1);
    this.angularSpeed = 0;      // rad/s, used to widen dribble touches on sharp turns
    this.speed = 0;

    this.moveInput = new THREE.Vector3();   // world-space desired direction, magnitude 0..1
    this.sprintInput = false;
    this.aimDir = new THREE.Vector3(0, 0, 1);
    this.aimPitch = 0;
    this.faceAim = false;

    this.sm = new PlayerStateMachine(this);
    this.sm.onExpire = (s) => this.onStateExpired(s);
    this.anim = new PlayerAnimationController(model);

    this.tackleCooldown = 0;
    this.jukeCooldown = 0;
    this.evadeActive = false;
    this.evadeTimer = 0;
    this.charging = false;
    this.chargeTime = 0;
    this.pendingKick = null;
    this.tackle = null;
    this.juke = null;
    this.dive = null;
    this.hasBall = false;
    this.lastTouchTime = -10;
    this.kickImmunity = 0;
    this.homePosition = new THREE.Vector3();
    this.targetPosition = new THREE.Vector3(); // debug: where the AI wants to go
    this.stats = { goals: 0, tackles: 0, jukes: 0, shots: 0, passes: 0, saves: 0 };
    this.speedMult = 1;
    this.accelMult = 1;
    this.heldBallOffset = new THREE.Vector3(0.05, 0.95, 0.42);
    this.recoverVulnerable = false;
    this.active = true;          // false once sent off
    this.holdMode = 'keeper';    // 'keeper' | 'throwin' - where a held ball sits
    this.locked = false;         // set pieces: movement input ignored
    this.placement = null;       // set pieces: where the AI should stand
  }

  /* ------------------------------------------------------------ intents */

  setMoveInput(x, z, sprint = false) {
    this.moveInput.set(x, 0, z);
    const len = this.moveInput.length();
    if (len > 1) this.moveInput.divideScalar(len);
    this.sprintInput = sprint;
  }

  setAim(dir, pitch = 0) {
    if (dir.lengthSq() > 1e-6) { this.aimDir.copy(dir); this.aimDir.y = 0; this.aimDir.normalize(); }
    this.aimPitch = pitch;
  }

  get tackleReady() { return this.tackleCooldown <= 0; }
  get jukeReady() { return this.jukeCooldown <= 0; }
  get chargePower() { return clamp(this.chargeTime / KICK.LOW_MAX_CHARGE, 0, 1); }

  /* ------------------------------------------------------------ main update */

  update(dt, world) {
    this.tackleCooldown = Math.max(0, this.tackleCooldown - dt);
    this.jukeCooldown = Math.max(0, this.jukeCooldown - dt);
    this.kickImmunity = Math.max(0, this.kickImmunity - dt);
    if (this.evadeActive) { this.evadeTimer -= dt; if (this.evadeTimer <= 0) this.evadeActive = false; }
    if (this.charging) {
      this.chargeTime += dt;
      if (!this.sm.canKick()) { this.charging = false; this.chargeTime = 0; }
    }

    this.sm.update(dt);
    this.updateMovement(dt, world);
    this.updateActions(dt, world);
    this.sm.updateLocomotion(this.speed, this.sprintInput, this.hasBall);

    // Animation
    this.anim.setLocomotion({ speed: this.speed, sprinting: this.sprintInput, hasBall: this.hasBall, isKeeper: this.isGoalkeeper && !this.sm.is(S.CELEBRATING) });
    this.anim.update(dt);

    // Sync visual
    this.model.root.position.copy(this.position);
    this.model.root.rotation.y = this.facing;
  }

  /* ------------------------------------------------------------ movement */

  updateMovement(dt, world) {
    const st = this.sm.state;
    const prevFacing = this.facing;
    let maxSpeed = 0;

    if (this.sm.canMove()) {
      const mag = this.locked ? 0 : this.moveInput.length();
      if (mag > 0.01) {
        const base = this.isGoalkeeper ? (this.sprintInput ? GOALKEEPER.SPRINT : GOALKEEPER.SPEED) : (this.sprintInput ? PLAYER.SPRINT_SPEED : PLAYER.RUN_SPEED);
        maxSpeed = base * clamp(mag, 0, 1) * this.speedMult;
        if (this.hasBall) maxSpeed *= PLAYER.DRIBBLE_MULT;
        if (st === S.HOLDING) maxSpeed = Math.min(maxSpeed, PLAYER.WALK_SPEED);
        tmpA.copy(this.moveInput).normalize().multiplyScalar(maxSpeed);
        this.velocity.x = damp(this.velocity.x, tmpA.x, PLAYER.ACCEL / 6 * this.accelMult, dt);
        this.velocity.z = damp(this.velocity.z, tmpA.z, PLAYER.ACCEL / 6 * this.accelMult, dt);
      } else {
        this.velocity.x = damp(this.velocity.x, 0, PLAYER.DECEL / 3, dt);
        this.velocity.z = damp(this.velocity.z, 0, PLAYER.DECEL / 3, dt);
      }
      // Facing: movement direction, or the aim direction while charging/kicking with the ball.
      let targetYaw = this.facing;
      const wantAim = this.faceAim || this.charging;
      if (wantAim) targetYaw = yawFromDir(this.aimDir.x, this.aimDir.z);
      else if (this.velocity.lengthSq() > 0.4) targetYaw = yawFromDir(this.velocity.x, this.velocity.z);
      this.facing = dampAngle(this.facing, targetYaw, PLAYER.TURN_RATE, dt);
    } else if (st === S.TACKLING) {
      const t = this.sm.stateTime / TACKLE.DURATION;
      const sp = TACKLE.LUNGE_SPEED * Math.pow(1 - clamp(t, 0, 1), 1.15);
      this.velocity.copy(this.tackle.dir).multiplyScalar(sp);
    } else if (st === S.JUKING) {
      const t = this.sm.stateTime / JUKE.DURATION;
      const env = Math.sin(Math.PI * clamp(t, 0, 1));
      dirFromYaw(this.facing, tmpA);
      tmpB.set(tmpA.z, 0, -tmpA.x); // left of facing
      tmpB.multiplyScalar(this.juke.side * JUKE.SIDESTEP_SPEED * env);
      tmpA.multiplyScalar(JUKE.FORWARD_BOOST * env + this.juke.baseSpeed * (1 - t * 0.5));
      this.velocity.copy(tmpA).add(tmpB);
      this.velocity.y = 0;
    } else if (st === S.DIVING) {
      const t = this.sm.stateTime / GOALKEEPER.DIVE_DURATION;
      const sp = this.dive.speed * Math.pow(1 - clamp(t, 0, 1), 1.6);
      this.velocity.copy(this.dive.dir).multiplyScalar(sp);
    } else {
      // kicking, falling, stunned, recovering, throwing, celebrating: bleed off speed
      const rate = st === S.KICKING ? 5 : 12;
      this.velocity.x = damp(this.velocity.x, 0, rate, dt);
      this.velocity.z = damp(this.velocity.z, 0, rate, dt);
      if (st === S.KICKING && this.pendingKick) {
        this.facing = dampAngle(this.facing, yawFromDir(this.pendingKick.dir.x, this.pendingKick.dir.z), 18, dt);
      }
    }

    this.velocity.y = 0;
    this.position.addScaledVector(this.velocity, dt);
    this.position.y = 0;
    this.speed = Math.hypot(this.velocity.x, this.velocity.z);
    this.angularSpeed = angleDelta(prevFacing, this.facing) / Math.max(dt, 1e-4);
    dirFromYaw(this.facing, this.facingDir);

    // Keep inside the boards
    const limX = PITCH.HALF_WIDTH + PITCH.BOARD_MARGIN - PLAYER.RADIUS;
    const limZ = PITCH.HALF_LENGTH + PITCH.BOARD_MARGIN - PLAYER.RADIUS;
    if (this.position.x > limX) { this.position.x = limX; this.velocity.x = Math.min(0, this.velocity.x); }
    if (this.position.x < -limX) { this.position.x = -limX; this.velocity.x = Math.max(0, this.velocity.x); }
    if (this.position.z > limZ) { this.position.z = limZ; this.velocity.z = Math.min(0, this.velocity.z); }
    if (this.position.z < -limZ) { this.position.z = -limZ; this.velocity.z = Math.max(0, this.velocity.z); }
    // Stay out of the goal nets
    const gw = PITCH.GOAL_WIDTH / 2 + 0.3;
    if (Math.abs(this.position.x) < gw && Math.abs(this.position.z) > PITCH.HALF_LENGTH - PLAYER.RADIUS * 0.5) {
      const s = Math.sign(this.position.z);
      this.position.z = s * (PITCH.HALF_LENGTH - PLAYER.RADIUS * 0.5);
      if (Math.sign(this.velocity.z) === s) this.velocity.z = 0;
    }
  }

  /* ------------------------------------------------------------ actions */

  updateActions(dt, world) {
    // Pending kick contact
    if (this.pendingKick) {
      this.pendingKick.timer -= dt;
      if (this.pendingKick.timer <= 0) {
        this.executeKick(world);
        this.pendingKick = null;
      }
    }
    if (this.sm.is(S.TACKLING)) this.updateTackle(dt, world);
  }

  /** Slide tackle: E. Skill-based - it only does something if the slide capsule actually reaches the ball or its owner. */
  requestTackle(world) {
    if (!this.sm.canTackle() || this.tackleCooldown > 0 || this.charging) return false;
    const dir = this.moveInput.lengthSq() > 0.01 ? tmpA.copy(this.moveInput).normalize() : tmpA.copy(this.facingDir);
    this.tackle = { dir: dir.clone(), hit: false, evaded: false, resolved: false };
    this.facing = yawFromDir(dir.x, dir.z);
    this.tackleCooldown = TACKLE.COOLDOWN;
    this.sm.set(S.TACKLING, TACKLE.DURATION);
    this.anim.playAction('slideTackle', { fade: 0.06, duration: TACKLE.DURATION });
    this.pendingKick = null; this.charging = false; this.chargeTime = 0;
    world.audio.play('slide', { volume: 0.7, pitch: world.audio.randomPitch() });
    world.events.emit('tackle_start', { player: this });
    return true;
  }

  updateTackle(dt, world) {
    const t = this.sm.stateTime;
    if (this.tackle.resolved || t < TACKLE.ACTIVE_START || t > TACKLE.ACTIVE_END) return;
    const ball = world.ball;
    // Capsule from the player's feet forward along the slide direction
    const a = tmpA.copy(this.position); a.y = 0.25;
    const b = tmpB.copy(this.position).addScaledVector(this.tackle.dir, TACKLE.REACH); b.y = 0.25;

    // --- ball contact (tracked so the referee knows whether the ball was played first) ---
    let ballContact = false, ballDist = Infinity;
    if (ball.state !== BALL_STATE.GOALKEEPER_HELD) {
      closestPointOnSegment(a, b, ball.position, tmpC);
      ballDist = tmpC.distanceTo(ball.position);
      if (ballDist < TACKLE.RADIUS + ball.radius && ball.position.y < 1.0) ballContact = true;
    }
    if (ballContact && !this.tackle.ballTouched) { this.tackle.ballTouched = true; this.tackle.ballTouchTime = t; }

    // --- player contact: the ball owner first, otherwise the nearest opponent inside the capsule ---
    const owner = ball.owner;
    let victim = null, victimDist = Infinity;
    const testPlayer = (p) => {
      if (p === this || p.team === this.team || p.sm.isDown() || p.sm.is(S.TACKLING)) return;
      tmpD.copy(p.position); tmpD.y = 0.25;
      closestPointOnSegment(a, b, tmpD, tmpC);
      const d = tmpC.distanceTo(tmpD);
      if (d < TACKLE.RADIUS + PLAYER.RADIUS * 0.6 && d < victimDist) { victim = p; victimDist = d; }
    };
    if (owner && owner !== this) testPlayer(owner);
    if (!victim) for (const p of world.players) testPlayer(p);
    if (ballContact && owner && owner !== this && owner.team !== this.team && !victim) victim = owner;

    if (!victim && !ballContact) return;
    this.tackle.resolved = true;

    // Clean poke of a loose ball, nobody hit.
    if (!victim) {
      this.tackle.hit = true;
      tmpC.copy(this.tackle.dir).multiplyScalar(TACKLE.KNOCK_SPEED * 0.9);
      tmpC.y = 0.6;
      ball.setVelocity(tmpC);
      ball.state = BALL_STATE.LOOSE;
      ball.recordTouch(this, 'TACKLE');
      world.possession.release(ball);
      world.audio.play('pass', { volume: 0.6 });
      world.events.emit('tackle_ball', { player: this });
      return;
    }

    if (victim.evadeActive && victim === owner) {
      // Juke timed correctly: the tackle fails and the slider goes straight past.
      this.tackle.evaded = true;
      victim.stats.jukes++;
      world.events.emit('juke_success', { player: victim, tackler: this });
      world.audio.play('juke', { volume: 0.9 });
      return;
    }

    // Build the contact record for the referee. "Ball first" means the slide reached the ball before
    // the player: an earlier frame, or the ball is nearer to the tackler along the slide than the victim.
    const victimHadBall = victim === owner;
    const ballAlong = (ball.position.x - this.position.x) * this.tackle.dir.x + (ball.position.z - this.position.z) * this.tackle.dir.z;
    const victimAlong = (victim.position.x - this.position.x) * this.tackle.dir.x + (victim.position.z - this.position.z) * this.tackle.dir.z;
    const ballFirst = this.tackle.ballTouched && (this.tackle.ballTouchTime < t - 1e-4 || (ballContact && ballAlong <= victimAlong + 0.1));
    const fromBehind = clamp(this.tackle.dir.dot(victim.facingDir), 0, 1);
    const contact = {
      tackler: this, victim, ballFirst, ballDistance: Math.min(ballDist, ball.position.distanceTo(victim.position)),
      fromBehind, progress: clamp((t - TACKLE.ACTIVE_START) / (TACKLE.ACTIVE_END - TACKLE.ACTIVE_START), 0, 1),
      victimHadBall, victimSpeed: victim.speed, tackleSpeed: this.speed, location: victim.position.clone(), time: world.time
    };
    const res = world.rules ? world.rules.onTackleContact(contact) : { foul: false, knockDown: true, loosenBall: true };
    if (!this.tackle) return; // the referee may have sent us off (state reset) during the call

    this.tackle.hit = true;
    this.tackle.foul = res.foul;
    if (!res.foul) this.stats.tackles++;
    if (res.knockDown) victim.knockDown(this.tackle.dir, world);
    if (res.loosenBall && (victimHadBall || ballContact)) {
      world.possession.release(ball);
      tmpC.copy(this.tackle.dir).multiplyScalar(res.foul ? TACKLE.KNOCK_SPEED * 0.45 : TACKLE.KNOCK_SPEED);
      tmpC.x += gaussian() * 1.2; tmpC.z += gaussian() * 1.2; tmpC.y = 0.8;
      ball.setVelocity(tmpC);
      ball.state = BALL_STATE.LOOSE;
      ball.recordTouch(this, 'TACKLE');
      this.kickImmunity = 0.15;
    }
    world.audio.play('tackle', { volume: 1, pitch: world.audio.randomPitch(0.08) });
    world.events.emit('tackle_hit', { player: this, victim, foul: res.foul });
  }

  /** Juke: Q. Side +1 = left, -1 = right. Evade window only covers the first JUKE.EVADE_WINDOW seconds. */
  requestJuke(world, sideHint = 0) {
    if (!this.sm.canJuke() || this.jukeCooldown > 0) return false;
    let side = sideHint;
    if (!side) {
      // Choose the side from lateral movement input, else random.
      const left = tmpA.set(this.facingDir.z, 0, -this.facingDir.x);
      const lat = this.moveInput.dot(left);
      side = Math.abs(lat) > 0.3 ? Math.sign(lat) : (Math.random() < 0.5 ? 1 : -1);
    }
    this.juke = { side, baseSpeed: Math.min(this.speed, PLAYER.RUN_SPEED), style: randInt(0, 2) };
    this.jukeCooldown = JUKE.COOLDOWN;
    this.evadeActive = true;
    this.evadeTimer = JUKE.EVADE_WINDOW;
    this.sm.set(S.JUKING, JUKE.DURATION);
    this.anim.playAction(side > 0 ? 'jukeLeft' : 'jukeRight', { fade: 0.05, duration: JUKE.DURATION, params: { style: this.juke.style } });
    this.charging = false; this.chargeTime = 0; this.pendingKick = null;
    world.audio.play('slide', { volume: 0.25, pitch: 1.5 });
    world.events.emit('juke_start', { player: this });
    return true;
  }

  beginCharge() {
    if (!this.sm.canKick() || this.charging || this.pendingKick) return false;
    this.charging = true;
    this.chargeTime = 0;
    return true;
  }

  cancelCharge() { this.charging = false; this.chargeTime = 0; }

  releaseCharge(world) {
    if (!this.charging) return false;
    const power = this.chargePower;
    this.charging = false; this.chargeTime = 0;
    return this.tryKick(world, 'low', power);
  }

  hardKick(world) {
    if (this.charging) return false;
    return this.tryKick(world, 'hard', 1);
  }

  /** Can this player touch the ball with a kick right now? */
  ballInKickRange(ball) {
    if (ball.state === BALL_STATE.GOALKEEPER_HELD && ball.owner !== this) return false;
    const dx = ball.position.x - this.position.x, dz = ball.position.z - this.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > KICK.REACH || ball.position.y > 1.3) return false;
    // Must be roughly in front of the player (or very close)
    if (dist > 0.55) {
      const dot = (dx * this.facingDir.x + dz * this.facingDir.z) / dist;
      if (dot < -0.2) return false;
    }
    return true;
  }

  tryKick(world, type, power, opts = {}) {
    if (!this.sm.canKick()) return false;
    const ball = world.ball;
    if (!this.ballInKickRange(ball) && !this.hasBall) return false;
    const dir = tmpA.copy(opts.dir || this.aimDir); dir.y = 0; dir.normalize();
    this.pendingKick = {
      type, power, timer: KICK.WINDUP, dir: dir.clone(),
      lift: opts.lift, speed: opts.speed, target: opts.target || null, isPass: opts.isPass
    };
    this.sm.set(S.KICKING, KICK.DURATION);
    this.anim.playAction(type === 'hard' ? (this.isGoalkeeper ? 'gkKick' : 'hardKick') : 'lowKick', { fade: 0.05, duration: KICK.DURATION });
    return true;
  }

  executeKick(world) {
    const k = this.pendingKick;
    const ball = world.ball;
    if (!this.ballInKickRange(ball) && !(this.hasBall && ball.position.distanceTo(this.position) < KICK.REACH * 1.3)) {
      world.events.emit('kick_whiff', { player: this });
      return;
    }
    const dir = tmpA.copy(k.dir);
    const acc = this.isHuman ? 1 : (this.difficulty ? this.difficulty.accuracy : 0.8);
    let speed, lift, spinY = 0;
    if (k.type === 'low') {
      const p = Math.pow(k.power, 0.9);
      speed = k.speed ?? lerp(KICK.LOW_MIN_SPEED, KICK.LOW_MAX_SPEED, p);
      lift = k.lift ?? KICK.LOW_MAX_LIFT * k.power * (0.25 + 0.75 * k.power);
      // Mild pass assist for humans: bend towards a teammate inside the aim cone.
      if (this.isHuman && !k.target) {
        const assist = this.findPassTarget(world, dir, KICK.PASS_ASSIST_CONE);
        if (assist) {
          const bend = clamp(assist.angle, -KICK.PASS_ASSIST_MAX_BEND, KICK.PASS_ASSIST_MAX_BEND);
          dir.applyAxisAngle(UP, bend);
          k.target = assist.player;
        }
      }
      const err = KICK.LOW_INACCURACY * (2 - acc) * gaussian();
      dir.applyAxisAngle(UP, err);
      // Curl from the angle between body facing and kick direction (outside/inside of the foot)
      const curl = angleDelta(this.facing, yawFromDir(dir.x, dir.z));
      spinY = -curl * 6;
    } else {
      speed = k.speed ?? KICK.HARD_SPEED * (0.94 + 0.06 * Math.random());
      const pitchT = clamp((this.aimPitch + 0.12) / 0.55, 0, 1);
      lift = k.lift ?? lerp(KICK.HARD_MIN_LIFT, KICK.HARD_MAX_LIFT, pitchT);
      const err = KICK.HARD_INACCURACY * (2 - acc) * gaussian();
      dir.applyAxisAngle(UP, err);
      const curl = angleDelta(this.facing, yawFromDir(dir.x, dir.z));
      spinY = -curl * 10 + gaussian() * 2;
    }
    // Shot or pass? A kick aimed at the goal frame is a shot unless a teammate clearly sits on the
    // line of the kick well short of the goal (then it is an intentional pass, and control follows it).
    let isShot = k.isShot;
    if (isShot === undefined) {
      const shotAim = this.isShotDirection(dir, speed);
      if (this.isHuman && !k.target && k.type === 'hard') {
        const assist = this.findPassTarget(world, dir, 0.24);
        if (assist && assist.distance > 5) k.target = assist.player;
      }
      const goalDist = Math.abs((this.team === 0 ? 1 : -1) * PITCH.HALF_LENGTH - this.position.z);
      const targetDist = k.target ? this.position.distanceTo(k.target.position) : Infinity;
      const drivenShot = k.type === 'low' && k.power >= 0.72;
      isShot = shotAim && (!k.target || drivenShot || targetDist > goalDist * (k.type === 'hard' ? 0.6 : 0.75));
      if (isShot) k.target = null;
    }
    tmpB.copy(dir).multiplyScalar(speed);
    tmpB.y = lift;
    world.possession.release(ball);
    ball.kick(tmpB, this, spinY, isShot ? 'SHOT' : 'PASS');
    ball.lastShotSpeed = isShot ? speed : 0;
    this.kickImmunity = 0.32;
    this.lastTouchTime = world.time;
    if (isShot) this.stats.shots++;
    if (k.isPass || k.target) this.stats.passes++;
    world.audio.play(k.type === 'hard' ? 'kick' : (k.power > 0.75 ? 'kick' : 'pass'), { volume: k.type === 'hard' ? 1 : 0.5 + 0.5 * k.power, pitch: world.audio.randomPitch(0.1) });
    world.events.emit('kick', { player: this, type: k.type, power: k.power, target: isShot ? null : k.target, isShot, velocity: tmpB.clone(), position: ball.position.clone(), setPiece: k.setPiece || null });
  }

  /** Does a kick in this direction head for the opponent's goal frame (with a small margin)? */
  isShotDirection(dir, speed) {
    const goalZ = (this.team === 0 ? 1 : -1) * PITCH.HALF_LENGTH;
    const dz = goalZ - this.position.z;
    if (dz * dir.z <= 0 || Math.abs(dz) > 36) return false;
    const t = dz / dir.z;
    const xAtLine = this.position.x + dir.x * t;
    const margin = 1.6 + Math.abs(dz) * 0.03;
    return Math.abs(xAtLine) < PITCH.GOAL_WIDTH / 2 + margin && speed > 12;
  }

  /** Find the teammate closest to the aim direction inside a cone. Returns { player, angle, distance } or null. */
  findPassTarget(world, dir, cone) {
    let best = null;
    for (const p of world.players) {
      if (p === this || p.team !== this.team || p.sm.isDown()) continue;
      tmpC.subVectors(p.position, this.position);
      const dist = tmpC.length();
      if (dist < 2 || dist > 40) continue;
      // lead the runner slightly
      tmpC.addScaledVector(p.velocity, Math.min(1.2, dist / 16));
      tmpC.y = 0; tmpC.normalize();
      const angle = angleDelta(yawFromDir(dir.x, dir.z), yawFromDir(tmpC.x, tmpC.z));
      if (Math.abs(angle) > cone) continue;
      const score = Math.abs(angle) + dist * 0.004;
      if (!best || score < best.score) best = { player: p, angle, distance: dist, score };
    }
    return best;
  }

  /** Knocked over by a tackle or collision. */
  knockDown(dir, world) {
    if (this.sm.is(S.FALLING) || this.sm.is(S.DIVING)) return;
    this.sm.set(S.FALLING, 0.7);
    this.anim.playAction('fall', { fade: 0.06, duration: 0.7 });
    this.velocity.copy(dir).multiplyScalar(2.5);
    this.charging = false; this.chargeTime = 0; this.pendingKick = null;
    this.evadeActive = false;
    this.hasBall = false;
    if (world) world.audio.play('stun', { volume: 0.5 });
  }

  stun(duration = 0.8) {
    if (this.sm.isDown()) return;
    this.sm.set(S.STUNNED, duration);
    this.charging = false; this.pendingKick = null;
  }

  celebrate(duration) {
    this.sm.set(S.CELEBRATING, duration);
    this.anim.playAction('celebrate', { fade: 0.15, duration });
    this.charging = false; this.pendingKick = null;
  }

  /* ------------------------------------------------------------ goalkeeper actions */

  startDive(sideSign, low, speed, world) {
    if (!this.sm.isLocomotion() && !this.sm.is(S.HOLDING)) return false;
    // sideSign: +1 dive towards the keeper's left (their local +X), -1 right
    dirFromYaw(this.facing, tmpA);
    tmpB.set(tmpA.z, 0, -tmpA.x).multiplyScalar(sideSign); // left vector * sign
    this.dive = { dir: tmpB.clone(), speed, low, side: sideSign };
    this.sm.set(S.DIVING, GOALKEEPER.DIVE_DURATION);
    this.anim.playAction(sideSign > 0 ? 'gkDiveLeft' : 'gkDiveRight', { fade: 0.05, duration: GOALKEEPER.DIVE_DURATION, params: { low } });
    if (world) world.audio.play('slide', { volume: 0.4, pitch: 0.8 });
    return true;
  }

  startHold(duration = GOALKEEPER.HOLD_TIME) {
    this.sm.set(S.HOLDING, duration);
    this.anim.playAction('gkCatch', { fade: 0.08, duration: 0.5 });
    this.hasBall = true;
  }

  startPickup() {
    this.sm.set(S.HOLDING, GOALKEEPER.HOLD_TIME + 0.4);
    this.anim.playAction('gkPickup', { fade: 0.08, duration: 0.7 });
  }

  startThrow(dir, speed, lift, world, target = null, power = 1) {
    const ball = world.ball;
    this.sm.set(S.THROWING, 0.6);
    this.anim.playAction('gkThrow', { fade: 0.05, duration: 0.6 });
    this.facing = yawFromDir(dir.x, dir.z);
    this.pendingKick = null;
    // release after the wind-up
    this.pendingRelease = { timer: 0.22, dir: dir.clone(), speed, lift, type: 'throw', target, power, touch: 'PASS' };
    this._releaseWorld = world;
    ball.state = BALL_STATE.GOALKEEPER_HELD;
  }

  startKickOut(dir, speed, lift, world, target = null) {
    this.sm.set(S.KICKING, KICK.DURATION);
    this.anim.playAction('gkKick', { fade: 0.05, duration: KICK.DURATION });
    this.facing = yawFromDir(dir.x, dir.z);
    this.pendingRelease = { timer: KICK.WINDUP + 0.05, dir: dir.clone(), speed, lift, type: 'kick', target };
    this._releaseWorld = world;
  }

  /** Throw-in: the ball is held above the head and released forward. `target` enables pass switching. */
  throwIn(dir, speed, lift, world, target = null) {
    const ball = world.ball;
    if (ball.owner !== this) return false;
    this.sm.set(S.THROWING, 0.6);
    this.anim.playAction('gkThrow', { fade: 0.05, duration: 0.6 });
    this.facing = yawFromDir(dir.x, dir.z);
    this.pendingKick = null;
    this.pendingRelease = { timer: 0.24, dir: dir.clone(), speed, lift, type: 'throw', target, touch: 'THROW' };
    this.holdMode = 'throwin';
    return true;
  }

  /** Called by the possession system while a player holds the ball (keeper or throw-in). */
  getHeldBallPosition(out) {
    const st = this.sm.state;
    dirFromYaw(this.facing, tmpA);
    const left = tmpB.set(tmpA.z, 0, -tmpA.x);
    if (this.holdMode === 'throwin') {
      // Above and slightly behind the head, swinging forward on release.
      const t = st === S.THROWING ? clamp(this.sm.stateTime / 0.24, 0, 1) : 0;
      out.copy(this.position).addScaledVector(tmpA, lerp(-0.25, 0.45, t));
      out.y = lerp(2.05, 1.9, t);
      return out;
    }
    if (st === S.THROWING || st === S.KICKING) {
      // ball at the hand/foot as it is released
      out.copy(this.position).addScaledVector(tmpA, 0.5).addScaledVector(left, -0.25);
      out.y = st === S.THROWING ? 1.35 : 0.4;
    } else {
      const t = this.sm.stateTime;
      const rise = clamp(t / 0.35, 0, 1);
      out.copy(this.position).addScaledVector(tmpA, 0.42);
      out.y = lerp(0.35, 0.95, rise);
    }
    return out;
  }

  /* ------------------------------------------------------------ state chaining */

  onStateExpired(state) {
    switch (state) {
      case S.TACKLING: {
        const hit = this.tackle && this.tackle.hit;
        this.recoverVulnerable = !hit;
        this.sm.set(S.RECOVERING, hit ? TACKLE.RECOVER_HIT : TACKLE.RECOVER_MISS);
        break;
      }
      case S.FALLING:
        this.sm.set(S.RECOVERING, 0.6);
        this.anim.playAction('recover', { fade: 0.08, duration: 0.6 });
        break;
      case S.DIVING:
        this.sm.set(S.RECOVERING, 0.35);
        break;
      case S.STUNNED:
        this.sm.set(S.RECOVERING, 0.3);
        break;
      case S.HOLDING:
        // The goalkeeper AI decides distribution; if nothing was chosen keep holding a bit longer.
        if (this.ai && this.ai.onHoldExpired) this.ai.onHoldExpired();
        else this.sm.set(S.IDLE);
        break;
      default:
        this.sm.set(S.IDLE);
        this.recoverVulnerable = false;
    }
  }

  /** Per-frame hook for goalkeeper release timers (run by the match loop after update). */
  updateRelease(dt, world) {
    if (!this.pendingRelease) return;
    this.pendingRelease.timer -= dt;
    if (this.pendingRelease.timer > 0) return;
    const r = this.pendingRelease;
    this.pendingRelease = null;
    const ball = world.ball;
    if (ball.owner !== this) return;
    this.getHeldBallPosition(tmpC);
    ball.position.copy(tmpC);
    world.possession.release(ball);
    tmpB.copy(r.dir).multiplyScalar(r.speed); tmpB.y = r.lift;
    const isShot = r.type === 'kick' && this.isShotDirection(r.dir, r.speed);
    ball.kick(tmpB, this, 0, r.touch || (isShot ? 'SHOT' : 'PASS'));
    this.kickImmunity = 0.6;
    this.holdMode = 'keeper';
    if (r.target) this.stats.passes++;
    world.audio.play(r.type === 'kick' ? 'kick' : 'pass', { volume: r.type === 'kick' ? 0.9 : 0.5 });
    world.events.emit('kick', { player: this, type: r.type, power: r.power ?? 1, target: isShot ? null : (r.target || null), isShot, velocity: tmpB.clone(), position: ball.position.clone(), setPiece: r.setPiece || null });
  }

  /* ------------------------------------------------------------ helpers */

  /** Point where the ball sits while dribbling. */
  getControlPoint(out, ball) {
    const sprint = this.sprintInput && this.speed > PLAYER.RUN_SPEED + 0.5;
    let offset = this.speed < 1 ? 0.48 : this.speed < PLAYER.RUN_SPEED * 0.8 ? 0.55 : sprint ? 0.95 : 0.66;
    // Sharp turns push the ball wider
    const turn = clamp(Math.abs(this.angularSpeed) / 6, 0, 1);
    offset += turn * 0.35;
    dirFromYaw(this.facing, tmpA);
    out.copy(this.position).addScaledVector(tmpA, offset);
    // slight lateral drift to the "strong foot" side
    tmpB.set(tmpA.z, 0, -tmpA.x);
    out.addScaledVector(tmpB, -0.12 + turn * 0.25 * -Math.sign(this.angularSpeed || 1));
    out.y = ball ? ball.radius : 0.15;
    return out;
  }

  teleport(x, z, yaw) {
    this.position.set(x, 0, z);
    this.velocity.set(0, 0, 0);
    this.facing = yaw;
    dirFromYaw(yaw, this.facingDir);
    this.model.root.position.copy(this.position);
    this.model.root.rotation.y = yaw;
  }

  resetState() {
    this.sm.set(S.IDLE);
    this.charging = false; this.chargeTime = 0; this.pendingKick = null; this.pendingRelease = null;
    this.evadeActive = false; this.hasBall = false; this.tackle = null; this.juke = null; this.dive = null;
    this.anim.stopAction(0.1);
    this.moveInput.set(0, 0, 0);
    this.holdMode = 'keeper'; this.locked = false; this.placement = null; this.faceAim = false;
  }

  get isDown() { return this.sm.isDown(); }

  dispose() {
    this.anim.dispose();
    this.model.dispose();
  }
}
