import * as THREE from 'three';
import { BALL, PITCH, PLAYER, BALL_STATE } from '../utils/Constants.js';
import { closestPointOnSegment, clamp } from '../utils/MathUtils.js';

const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), tmp3 = new THREE.Vector3();
const A = new THREE.Vector3(), B = new THREE.Vector3();

/**
 * Custom rigid-ish ball physics: gravity, quadratic air drag, Magnus lift from spin, ground bounce with
 * friction, rolling resistance, rebound boards, goal frame (capsule) collisions, soft net containment
 * and player body collisions. Integrated with fixed sub-steps for stability at high kick speeds.
 */
export class BallPhysics {
  constructor(goals) {
    this.goals = goals;
    this.substeps = 3;
    this.onBounce = null; // (ball, speed) => void
    this.onPost = null;   // (ball, speed) => void
    this.onBoard = null;
  }

  step(ball, dt, players) {
    if (ball.state === BALL_STATE.GOALKEEPER_HELD || ball.frozen) return;
    const h = dt / this.substeps;
    for (let i = 0; i < this.substeps; i++) this.integrate(ball, h, players);
  }

  integrate(ball, h, players) {
    const p = ball.position, v = ball.velocity, w = ball.spin;
    const r = ball.radius;
    const controlled = ball.state === BALL_STATE.CONTROLLED || ball.state === BALL_STATE.DRIBBLING;

    // --- forces ---
    if (!controlled || p.y > r + 0.02) v.y -= BALL.GRAVITY * h;
    const speed = v.length();
    if (speed > 0.01) {
      // quadratic drag
      const drag = BALL.AIR_DRAG * speed * speed;
      v.addScaledVector(v, -Math.min(drag * h / speed, 0.5));
      // Magnus: F ~ w x v
      if (w.lengthSq() > 0.01 && p.y > r + 0.05) {
        tmp.crossVectors(w, v).multiplyScalar(BALL.MAGNUS * h);
        v.add(tmp);
      }
    }
    // spin decay
    w.multiplyScalar(Math.max(0, 1 - BALL.SPIN_DECAY * h));

    // --- integrate ---
    p.addScaledVector(v, h);

    // --- ground ---
    if (p.y < r) {
      p.y = r;
      if (v.y < -0.4) {
        const impact = -v.y;
        v.y = -v.y * BALL.RESTITUTION;
        v.x *= BALL.GROUND_FRICTION + 0.3; v.z *= BALL.GROUND_FRICTION + 0.3;
        // spin picks up from horizontal velocity on bounce
        w.x += v.z * 0.5; w.z -= v.x * 0.5;
        if (impact > 2.5 && this.onBounce) this.onBounce(ball, impact);
      } else {
        v.y = 0;
      }
    }
    // rolling resistance when on the ground
    if (p.y <= r + 0.005 && Math.abs(v.y) < 0.05) {
      const hs = Math.hypot(v.x, v.z);
      if (hs > 0) {
        const dec = controlled ? BALL.ROLL_DECEL * 0.3 : BALL.ROLL_DECEL;
        const ns = Math.max(0, hs - dec * h);
        const f = ns / hs;
        v.x *= f; v.z *= f;
      }
      if (hs < BALL.SLEEP_SPEED) { v.x = 0; v.z = 0; }
    }
    // rolling spin for visuals
    ball.rollAxis.set(v.z, 0, -v.x);
    ball.rollSpeed = Math.hypot(v.x, v.z) / r;

    // --- max speed ---
    const sp2 = v.lengthSq();
    if (sp2 > BALL.MAX_SPEED * BALL.MAX_SPEED) v.multiplyScalar(BALL.MAX_SPEED / Math.sqrt(sp2));

    this.collideGoals(ball);
    this.collideBoards(ball);
    if (players) this.collidePlayers(ball, players, h);
  }

  collideGoals(ball) {
    const p = ball.position, v = ball.velocity, r = ball.radius;
    for (const goal of this.goals) {
      // Quick reject: far from this goal line
      if (Math.abs(p.z - goal.lineZ) > 3.5 || Math.abs(p.x) > goal.width / 2 + 1.5) continue;
      for (const post of goal.posts) {
        closestPointOnSegment(post.a, post.b, p, tmp);
        tmp2.subVectors(p, tmp);
        const d = tmp2.length();
        const minD = r + post.r;
        if (d < minD && d > 1e-5) {
          tmp2.divideScalar(d);
          p.addScaledVector(tmp2, minD - d);
          const vn = v.dot(tmp2);
          if (vn < 0) {
            v.addScaledVector(tmp2, -(1 + BALL.POST_RESTITUTION) * vn);
            if (this.onPost && -vn > 4) this.onPost(ball, -vn, post.name, goal);
          }
        }
      }
      // Net: once past the line and inside the mouth, keep the ball inside the net box. From the outside
      // the side nets and the back are solid walls so a ball can never be pushed into the net sideways.
      const behind = goal.side > 0 ? p.z > goal.lineZ + r : p.z < goal.lineZ - r;
      const backZ = goal.lineZ + goal.side * goal.depth;
      const inNetDepth = goal.side > 0 ? p.z < backZ + r : p.z > backZ - r;
      const halfW = goal.width / 2 - r * 0.5;
      if (behind && Math.abs(p.x) < halfW && p.y < goal.height) {
        if (goal.side > 0 ? p.z > backZ - r : p.z < backZ + r) {
          p.z = backZ - goal.side * r;
          v.z *= -0.15; v.x *= 0.5; v.y *= 0.5;
        }
        if (p.x > halfW - 0.01) { p.x = halfW - 0.01; v.x = -Math.abs(v.x) * 0.15; }
        if (p.x < -halfW + 0.01) { p.x = -halfW + 0.01; v.x = Math.abs(v.x) * 0.15; }
        if (p.y > goal.height * 0.8) { p.y = goal.height * 0.8; v.y = Math.min(v.y, 0) * 0.2; }
        v.multiplyScalar(0.97);
      } else if (behind && inNetDepth && Math.abs(p.x) < goal.width / 2 + r + 0.3 && p.y < goal.height + 0.3) {
        // Outside the side net (or above the roof net): push away from the net box.
        if (Math.abs(p.x) >= halfW) {
          const s = Math.sign(p.x) || 1;
          p.x = s * (goal.width / 2 + r + 0.31);
          v.x = s * Math.abs(v.x) * 0.3;
        } else {
          p.y = goal.height + 0.31; v.y = Math.abs(v.y) * 0.3;
        }
      }
      // The back of the net is solid from behind as well.
      if (Math.abs(p.x) < goal.width / 2 + 1 && (goal.side > 0 ? p.z > backZ + r && p.z < backZ + 1.2 : p.z < backZ - r && p.z > backZ - 1.2) && p.y < goal.height) {
        p.z = backZ + goal.side * (r + 0.01);
        v.z = goal.side * Math.abs(v.z) * 0.3;
      }
    }
  }

  collideBoards(ball) {
    const p = ball.position, v = ball.velocity, r = ball.radius;
    const bx = PITCH.HALF_WIDTH + PITCH.BOARD_MARGIN - r;
    const bz = PITCH.HALF_LENGTH + PITCH.BOARD_MARGIN - r;
    const inMouth = Math.abs(p.x) < PITCH.GOAL_WIDTH / 2 + 0.2;
    const hitBoard = (speed) => { if (this.onBoard && speed > 2) this.onBoard(ball, speed); };
    if (p.y < PITCH.BOARD_HEIGHT + r) {
      if (p.x > bx) { p.x = bx; if (v.x > 0) { hitBoard(v.x); v.x = -v.x * PITCH.BOARD_RESTITUTION; } }
      if (p.x < -bx) { p.x = -bx; if (v.x < 0) { hitBoard(-v.x); v.x = -v.x * PITCH.BOARD_RESTITUTION; } }
      if (!inMouth) {
        if (p.z > bz) { p.z = bz; if (v.z > 0) { hitBoard(v.z); v.z = -v.z * PITCH.BOARD_RESTITUTION; } }
        if (p.z < -bz) { p.z = -bz; if (v.z < 0) { hitBoard(-v.z); v.z = -v.z * PITCH.BOARD_RESTITUTION; } }
      } else {
        // behind the goal, a back board a bit further out
        const bb = bz + 1.0;
        if (p.z > bb) { p.z = bb; v.z = -Math.abs(v.z) * 0.3; }
        if (p.z < -bb) { p.z = -bb; v.z = Math.abs(v.z) * 0.3; }
      }
    } else {
      // Ball flying over the boards: hard outer wall (stands) so it never leaves the arena.
      const ox = bx + 5, oz = bz + 5;
      if (p.x > ox) { p.x = ox; v.x = -Math.abs(v.x) * 0.4; }
      if (p.x < -ox) { p.x = -ox; v.x = Math.abs(v.x) * 0.4; }
      if (p.z > oz) { p.z = oz; v.z = -Math.abs(v.z) * 0.4; }
      if (p.z < -oz) { p.z = -oz; v.z = Math.abs(v.z) * 0.4; }
    }
  }

  collidePlayers(ball, players, h) {
    const p = ball.position, v = ball.velocity, r = ball.radius;
    for (const pl of players) {
      if (pl === ball.owner) continue;
      if (pl.kickImmunity > 0 && ball.lastTouch === pl) continue;
      const dx = p.x - pl.position.x, dz = p.z - pl.position.z;
      const d2 = dx * dx + dz * dz;
      // Body cylinder; a player lying down (falling/recovering) is lower.
      const bodyH = pl.sm.isDown() || pl.sm.state === 'TACKLING' ? 0.5 : PLAYER.HEIGHT;
      const bodyR = pl.sm.isDown() ? PLAYER.RADIUS * 0.8 : PLAYER.RADIUS;
      const minD = bodyR + r;
      if (d2 >= minD * minD || p.y > bodyH + r) continue;
      const d = Math.sqrt(d2) || 1e-4;
      const nx = dx / d, nz = dz / d;
      p.x = pl.position.x + nx * minD; p.z = pl.position.z + nz * minD;
      // relative velocity along the normal
      const rvx = v.x - pl.velocity.x, rvz = v.z - pl.velocity.z;
      const vn = rvx * nx + rvz * nz;
      if (vn < 0) {
        const j = -(1 + BALL.PLAYER_RESTITUTION) * vn;
        v.x += nx * j; v.z += nz * j;
        // the body also carries the ball a bit
        v.x += pl.velocity.x * 0.35; v.z += pl.velocity.z * 0.35;
        v.y = Math.max(v.y, 0);
        // A body contact on a fast ball is a block/deflection; on a slow ball it is just a touch.
        const wasShot = ball.lastTouchType === 'SHOT' && ball.lastTouchTeam !== pl.team;
        const impactSpeed = Math.abs(vn);
        ball.recordTouch(pl, impactSpeed > 6 ? (wasShot ? (pl.isGoalkeeper ? 'SAVE' : 'BLOCK') : 'DEFLECTION') : 'DRIBBLE');
        if (wasShot && pl.isGoalkeeper && impactSpeed > 6 && this.onKeeperBlock) this.onKeeperBlock(ball, pl, impactSpeed);
        if (ball.state === BALL_STATE.KICKED && Math.abs(vn) > 6) ball.state = BALL_STATE.LOOSE;
        ball.deflected = true;
        ball.deflectedBy = pl;
      }
    }
  }
}
