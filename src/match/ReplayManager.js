import * as THREE from 'three';
import { ReplayCamera } from '../camera/ReplayCamera.js';
import { REPLAY, PITCH } from '../utils/Constants.js';
import { clamp } from '../utils/MathUtils.js';

const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
const ballPos = new THREE.Vector3();

/**
 * Rolling recorder + cinematic playback.
 *
 * Every live frame `record()` accumulates time and, at REPLAY.RATE Hz, stores a compact snapshot: ball
 * position/rotation/velocity, each player's position, yaw, animation state and flags, plus the controlled
 * player. Playback interpolates between snapshots and applies them straight to the visuals; the live
 * simulation (physics, AI, input) is not run at all while a replay plays.
 */
export class ReplayManager {
  constructor(match) {
    this.match = match;
    this.capacity = REPLAY.BUFFER_SECONDS * REPLAY.RATE;
    this.snapshots = [];
    this.accumulator = 0;
    this.events = [];
    this.playing = null;
    this.camera = new ReplayCamera();
    this.onComplete = null;
    this.lastShot = null; // { time, player, position, velocity, team }
  }

  clear() { this.snapshots.length = 0; this.events.length = 0; this.accumulator = 0; }

  /* ------------------------------------------------------------ recording */

  record(dt) {
    this.accumulator += dt;
    const interval = 1 / REPLAY.RATE;
    if (this.accumulator < interval) return;
    this.accumulator -= interval;
    const m = this.match;
    const ball = m.ball;
    const snap = {
      t: m.time,
      ball: [ball.position.x, ball.position.y, ball.position.z, ball.mesh.quaternion.x, ball.mesh.quaternion.y, ball.mesh.quaternion.z, ball.mesh.quaternion.w],
      vel: [ball.velocity.x, ball.velocity.y, ball.velocity.z],
      ownerId: ball.owner ? ball.owner.id : -1,
      humanId: m.human ? m.human.id : -1,
      players: m.players.map((p) => ({ p, x: p.position.x, z: p.position.z, yaw: p.facing, anim: p.anim.captureState(), state: p.sm.state }))
    };
    this.snapshots.push(snap);
    if (this.snapshots.length > this.capacity) this.snapshots.shift();
  }

  /** Remember shots so replays know where the interesting moment is. */
  noteKick(d) {
    if (d.isShot) this.lastShot = { time: this.match.time, player: d.player, position: d.position.clone(), velocity: d.velocity.clone(), team: d.player.team };
    this.events.push({ type: d.isShot ? 'shot' : 'kick', time: this.match.time, player: d.player });
    if (this.events.length > 60) this.events.shift();
  }

  get bufferSeconds() { return this.snapshots.length ? this.snapshots[this.snapshots.length - 1].t - this.snapshots[0].t : 0; }

  /** Recent shot (within `window` seconds) toward the goal on `goalSide`, or null. */
  recentShot(window = 3.5, goalSide = null) {
    const s = this.lastShot;
    if (!s || this.match.time - s.time > window) return null;
    if (goalSide !== null && Math.sign(s.velocity.z) !== goalSide) return null;
    return s;
  }

  /* ------------------------------------------------------------ playback */

  /**
   * Start a replay. kind: 'goal' | 'save' | 'miss'. eventTime is when the notable moment happened
   * (goal crossing, save contact, ball out). shot: the shot record (optional).
   */
  play({ kind, eventTime, shot, goalSide, onComplete }) {
    if (this.snapshots.length < 8) { if (onComplete) onComplete(); return false; }
    const first = this.snapshots[0].t, last = this.snapshots[this.snapshots.length - 1].t;
    const shotTime = shot ? shot.time : eventTime - 0.9;
    const start = clamp(Math.min(shotTime - REPLAY.LEAD_IN + 1.2, eventTime - REPLAY.LEAD_IN), first, last - 0.5);
    const end = clamp(eventTime + REPLAY.LEAD_OUT, start + 1, last);
    const shooterPos = shot ? shot.position.clone() : new THREE.Vector3();
    const shotDir = shot ? shot.velocity.clone().setY(0).normalize() : new THREE.Vector3(0, 0, goalSide || 1);
    const context = { goalSide: goalSide || (shot ? Math.sign(shot.velocity.z) || 1 : 1), shooterPos, shotDir };
    // Shot plan: [ {shot, from, to, speed} ] - the second angle rewinds slightly for a classic double take.
    let plan;
    const cut = clamp(shotTime - 0.25, start + 0.3, end - 0.4);
    if (kind === 'goal') {
      plan = [
        { shot: 'broadcast', from: start, to: cut + 0.35, speed: 1 },
        { shot: Math.random() < 0.5 ? 'behindGoal' : 'behindShooter', from: cut - 0.2, to: end, speed: REPLAY.SLOWMO }
      ];
    } else if (kind === 'save') {
      plan = [
        { shot: 'broadcast', from: start, to: cut + 0.2, speed: 1 },
        { shot: 'behindShooter', from: cut - 0.15, to: end, speed: REPLAY.SLOWMO }
      ];
    } else {
      plan = [
        { shot: 'broadcast', from: start, to: cut + 0.2, speed: 1 },
        { shot: 'lowSideline', from: cut - 0.1, to: end, speed: REPLAY.SLOWMO }
      ];
    }
    this.playing = { kind, plan, segment: 0, t: plan[0].from, context, end };
    this.onComplete = onComplete || null;
    this.camera.setShot(plan[0].shot, context, this.ballAt(plan[0].from));
    this.match.events.emit('replay_start', { kind });
    return true;
  }

  get isPlaying() { return !!this.playing; }

  skip() { if (this.playing) this.finish(); }

  finish() {
    this.playing = null;
    this.restoreLive();
    this.match.events.emit('replay_end', {});
    const cb = this.onComplete; this.onComplete = null;
    if (cb) cb();
  }

  update(dt) {
    const pb = this.playing;
    if (!pb) return;
    const seg = pb.plan[pb.segment];
    pb.t += dt * seg.speed;
    if (pb.t >= seg.to) {
      pb.segment++;
      if (pb.segment >= pb.plan.length) { this.finish(); return; }
      const next = pb.plan[pb.segment];
      pb.t = next.from;
      this.camera.setShot(next.shot, pb.context, this.ballAt(next.from));
    }
    this.applyTime(pb.t);
    this.camera.update(dt, ballPos);
  }

  /** Interpolated ball position at time t (for camera setup). */
  ballAt(t) {
    const { a, b, k } = this.findPair(t);
    if (!a) return ballPos.set(0, 0.15, 0);
    if (!b) return ballPos.set(a.ball[0], a.ball[1], a.ball[2]);
    return ballPos.set(a.ball[0] + (b.ball[0] - a.ball[0]) * k, a.ball[1] + (b.ball[1] - a.ball[1]) * k, a.ball[2] + (b.ball[2] - a.ball[2]) * k);
  }

  findPair(t) {
    const s = this.snapshots;
    if (!s.length) return { a: null, b: null, k: 0 };
    if (t <= s[0].t) return { a: s[0], b: null, k: 0 };
    if (t >= s[s.length - 1].t) return { a: s[s.length - 1], b: null, k: 0 };
    let lo = 0, hi = s.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (s[mid].t <= t) lo = mid; else hi = mid; }
    const a = s[lo], b = s[hi];
    const k = clamp((t - a.t) / Math.max(1e-4, b.t - a.t), 0, 1);
    return { a, b, k };
  }

  /** Write the interpolated snapshot straight into the visuals. */
  applyTime(t) {
    const { a, b, k } = this.findPair(t);
    if (!a) return;
    const m = this.match;
    const ball = m.ball;
    if (b) {
      ball.group.position.set(a.ball[0] + (b.ball[0] - a.ball[0]) * k, a.ball[1] + (b.ball[1] - a.ball[1]) * k, a.ball[2] + (b.ball[2] - a.ball[2]) * k);
      qa.set(a.ball[3], a.ball[4], a.ball[5], a.ball[6]); qb.set(b.ball[3], b.ball[4], b.ball[5], b.ball[6]);
      ball.mesh.quaternion.copy(qa.slerp(qb, k));
    } else {
      ball.group.position.set(a.ball[0], a.ball[1], a.ball[2]);
      ball.mesh.quaternion.set(a.ball[3], a.ball[4], a.ball[5], a.ball[6]);
    }
    ballPos.copy(ball.group.position);
    const h = ball.group.position.y - ball.radius;
    ball.shadow.position.y = -ball.group.position.y + 0.015;
    ball.shadow.scale.setScalar(0.38 + h * 0.12);
    const bMap = b ? new Map(b.players.map((e) => [e.p, e])) : null;
    for (const ea of a.players) {
      const p = ea.p;
      const eb = bMap ? bMap.get(p) : null;
      if (eb) {
        p.model.root.position.set(ea.x + (eb.x - ea.x) * k, 0, ea.z + (eb.z - ea.z) * k);
        let dy = eb.yaw - ea.yaw; while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
        p.model.root.rotation.y = ea.yaw + dy * k;
        p.anim.applyState(ea.anim, eb.anim, k);
      } else {
        p.model.root.position.set(ea.x, 0, ea.z);
        p.model.root.rotation.y = ea.yaw;
        p.anim.applyState(ea.anim, null, 0);
      }
    }
  }

  /** Put visuals back on the live state after playback. */
  restoreLive() {
    const m = this.match;
    for (const p of m.players) {
      p.model.root.position.copy(p.position);
      p.model.root.rotation.y = p.facing;
    }
    m.ball.group.position.copy(m.ball.position);
  }

  /* ------------------------------------------------------------ significance */

  /** Is a save worth replaying? */
  isSignificantSave(saveData) {
    if (!saveData) return false;
    return !!saveData.dive || (saveData.shotSpeed || 0) > REPLAY.MIN_SHOT_SPEED;
  }

  /** Is a missed shot worth replaying? exitPoint: where the ball crossed the goal line. */
  isSignificantMiss(shot, exitPoint, hitPost) {
    if (!shot) return false;
    if (hitPost) return true;
    const speed = shot.velocity.length();
    if (speed < REPLAY.MIN_SHOT_SPEED) return false;
    const halfW = PITCH.GOAL_WIDTH / 2, h = PITCH.GOAL_HEIGHT;
    const dx = Math.max(0, Math.abs(exitPoint.x) - halfW);
    const dy = Math.max(0, exitPoint.y - h);
    return Math.hypot(dx, dy) < REPLAY.MISS_MARGIN;
  }
}
