import * as THREE from 'three';
import { GoalkeeperSkills } from './GoalkeeperSkills.js';
import { KICK, SET_PIECE, SHIFT_LOCK, PLAYER, GOALKEEPER, BALL_STATE, PLAYER_STATE as S } from '../utils/Constants.js';
import { clamp, lerp } from '../utils/MathUtils.js';

const dir = new THREE.Vector3(), tmp = new THREE.Vector3(), left = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * A player "intent" is the compact, network-safe description of what the human wants this frame:
 * world-space move vector, aim, and edge-triggered actions. Controllers BUILD an intent from local
 * input and APPLY it to their player; the multiplayer server applies intents received from clients
 * with exactly the same functions, so online and offline control behave identically.
 *
 * Intent fields: mx, mz (move dir, magnitude <= 1), sp (sprint), ax, az (aim dir), ap (aim pitch),
 * sl (shift lock), ix, iz (raw input axes), cs (charge start), cr (charge release), kh (hard kick),
 * tk (tackle), jk (juke), js (juke side), jt (juke style), cy (cycle player), nr (nearest player),
 * gd (keeper dive), gc (keeper catch), gr (keeper rush), gs (keeper shuffle), gk (keeper kick out).
 */

export function makeIntent() {
  return { mx: 0, mz: 0, sp: false, ax: 0, az: 1, ap: 0, sl: false, tc: false, ix: 0, iz: 0, cs: false, cr: false, kh: false, tk: false, jk: false, js: 0, jt: -1, cy: false, nr: false, gd: false, gc: false, gr: false, gs: false, gk: false };
}

/**
 * Common part: movement + aim from the input manager and camera. Reads named ACTIONS (see
 * InputManager) so keyboard/mouse and touch produce identical intents.
 */
function buildBase(intent, input, camera, shiftLock, allowMove) {
  const axis = input.getMoveAxis();
  const sl = !!(shiftLock && shiftLock.enabled);
  if (sl) { const f = shiftLock.cameraForward, r = shiftLock.cameraRight; dir.set(f.x * axis.z + r.x * axis.x, 0, f.z * axis.z + r.z * axis.x); }
  else camera.inputToWorld(axis.x, axis.z, dir);
  intent.mx = allowMove ? dir.x : 0; intent.mz = allowMove ? dir.z : 0;
  intent.sp = input.held('SPRINT');
  intent.ax = camera.aimDir.x; intent.az = camera.aimDir.z; intent.ap = camera.aimPitch;
  intent.sl = sl; intent.tc = input.mode === 'touch'; intent.ix = axis.x; intent.iz = axis.z;
  intent.cy = input.pressed('SWITCH_CYCLE');
  return axis;
}

/* ================================================================ outfield */

export function buildOutfieldIntent(input, camera, shiftLock, mode) {
  const intent = makeIntent();
  const axis = buildBase(intent, input, camera, shiftLock, mode === 'normal');
  if (mode === 'hold') return intent;
  intent.cs = input.pressed('PASS');
  intent.cr = input.released('PASS') || (!input.held('PASS') && !intent.cs);
  intent.kh = input.pressed('SHOOT');
  if (mode === 'normal') {
    intent.nr = input.pressed('SWITCH_NEAREST');
    intent.tk = input.pressed('TACKLE');
    if (input.pressed('JUKE')) {
      intent.jk = true;
      if (axis.x < -0.3) intent.js = 1; else if (axis.x > 0.3) intent.js = -1;
      else if (intent.sl && axis.z > 0.3) intent.jt = 1;
    }
  }
  return intent;
}

/**
 * Apply an outfield intent. ctx: { mode, setPieces, onCycle, onNearest }.
 * `world.replica` (client prediction) keeps ball/rules side effects off - only the local player moves.
 */
export function applyOutfieldIntent(p, it, world, ctx) {
  const mode = ctx.mode || 'normal';
  if (it.cy && ctx.onCycle) ctx.onCycle();
  tmp.set(it.ax, 0, it.az);
  p.setAim(tmp, it.ap);
  switch (mode) {
    case 'hold': p.setMoveInput(0, 0, false); p.faceAim = false; return;
    case 'setpiece':
      p.setMoveInput(0, 0, false); p.faceAim = true;
      if (it.cs) p.beginCharge();
      if (p.charging && it.cr) p.releaseCharge(world);
      if (it.kh) p.hardKick(world);
      return;
    case 'throwin':
      p.setMoveInput(0, 0, false); p.faceAim = true;
      if (it.cs) p.beginCharge();
      if (p.charging && it.cr) { const power = p.chargePower; p.cancelCharge(); throwIn(p, it, world, power); }
      if (it.kh) throwIn(p, it, world, 1);
      return;
    case 'penalty': {
      p.setMoveInput(0, 0, false); p.faceAim = true;
      if (!ctx.setPieces) return;
      const lift = lerp(KICK.HARD_MIN_LIFT * 0.5, KICK.HARD_MAX_LIFT * 0.55, clamp((it.ap + 0.12) / 0.55, 0, 1));
      if (it.kh) { ctx.setPieces.requestPenaltyShot({ type: 'hard', power: 1, dir: tmp.clone(), lift }); return; }
      if (it.cs) p.beginCharge();
      if (p.charging && it.cr) { const power = Math.max(0.55, p.chargePower); p.cancelCharge(); ctx.setPieces.requestPenaltyShot({ type: 'low', power, dir: tmp.clone(), lift: undefined }); }
      return;
    }
    default: {
      p.setMoveInput(it.mx, it.mz, it.sp);
      p.turnRate = it.sl ? SHIFT_LOCK.ROTATION_SPEED : PLAYER.TURN_RATE;
      p.faceAim = it.sl ? true : (p.charging || (p.hasBall && it.ix === 0 && it.iz === 0));
      if (it.nr && ctx.onNearest) ctx.onNearest();
      if (it.cs) p.beginCharge();
      if (p.charging && it.cr) p.releaseCharge(world);
      if (it.kh) p.hardKick(world);
      if (it.tk) p.requestTackle(world, it.sl ? tmp : null);
      if (it.jk) p.requestJuke(world, it.js, it.jt);
    }
  }
}

function throwIn(p, it, world, power) {
  tmp.set(it.ax, 0, it.az).normalize();
  const target = p.findPassTarget(world, tmp, KICK.PASS_ASSIST_CONE);
  if (target) tmp.applyAxisAngle(UP, clamp(target.angle, -KICK.PASS_ASSIST_MAX_BEND, KICK.PASS_ASSIST_MAX_BEND));
  const speed = lerp(SET_PIECE.THROW_MIN_SPEED, SET_PIECE.THROW_MAX_SPEED, power);
  const lift = lerp(1.6, 3.6, power) + clamp(it.ap, -0.2, 0.4) * 3;
  p.throwIn(tmp.clone(), speed, lift, world, target ? target.player : null);
}

/* ================================================================ goalkeeper */

export function buildKeeperIntent(input, camera, shiftLock, mode) {
  const intent = makeIntent();
  buildBase(intent, input, camera, shiftLock, mode !== 'setpiece' && mode !== 'hold');
  intent.nr = input.pressed('SWITCH_NEAREST');
  intent.kh = input.pressed('SHOOT');         // dive (no ball) / kick out (with ball)
  intent.cs = input.pressed('PASS');          // catch (no ball) / start throw charge (with ball)
  intent.cr = input.released('PASS') || (!input.held('PASS') && !intent.cs);
  intent.gr = input.pressed('TACKLE');        // rush / smother
  intent.gs = input.pressed('JUKE');          // quick shuffle
  return intent;
}

/**
 * Apply a keeper intent. ctx: { mode, state: { rushCooldown, shuffleCooldown, holdTime }, toast(text), onCycle, onNearest, dt }.
 */
export function applyKeeperIntent(p, it, world, ctx) {
  const st = ctx.state;
  const dt = ctx.dt || 0;
  st.rushCooldown = Math.max(0, (st.rushCooldown || 0) - dt);
  st.shuffleCooldown = Math.max(0, (st.shuffleCooldown || 0) - dt);
  if (it.cy && ctx.onCycle) ctx.onCycle();
  if (it.nr && ctx.onNearest) ctx.onNearest();
  const ball = world.ball;
  const held = ball.owner === p && ball.state === BALL_STATE.GOALKEEPER_HELD;
  const inBox = GoalkeeperSkills.inOwnBox(p);
  p.accelMult = inBox ? 1.7 : 1.0;
  tmp.set(it.ax, 0, it.az);
  p.setAim(tmp, it.ap);
  if (ctx.mode === 'setpiece' || ctx.mode === 'hold') p.setMoveInput(0, 0, false); else p.setMoveInput(it.mx, it.mz, it.sp);
  p.turnRate = it.sl ? SHIFT_LOCK.ROTATION_SPEED : PLAYER.TURN_RATE;
  p.faceAim = it.sl ? true : (it.ix === 0 && it.iz === 0 || held);
  if (ctx.mode === 'hold') return;

  if (held) {
    st.holdTime = (st.holdTime || 0) + dt;
    if (it.kh) {
      const lift = lerp(KICK.HARD_MIN_LIFT, KICK.HARD_MAX_LIFT, clamp((it.ap + 0.12) / 0.55, 0, 1));
      const target = p.findPassTarget(world, tmp, 0.2);
      p.startKickOut(tmp.clone(), GOALKEEPER.KICK_SPEED, lift, world, target ? target.player : null);
      return;
    }
    if (it.cs) p.beginCharge();
    if (p.charging && it.cr) {
      const power = p.chargePower;
      p.cancelCharge();
      const target = p.findPassTarget(world, tmp, KICK.PASS_ASSIST_CONE);
      dir.copy(tmp).normalize();
      if (target) dir.applyAxisAngle(UP, clamp(target.angle, -KICK.PASS_ASSIST_MAX_BEND, KICK.PASS_ASSIST_MAX_BEND));
      const speed = lerp(SET_PIECE.THROW_MIN_SPEED, GOALKEEPER.THROW_SPEED + 2, power);
      const lift = power < 0.25 ? 0.15 : lerp(1.2, 3.2, power);
      p.startThrow(dir.clone(), speed, lift, world, target ? target.player : null, power);
      return;
    }
    if (st.holdTime > 7 && p.sm.is(S.HOLDING)) p.startKickOut(tmp.clone(), GOALKEEPER.KICK_SPEED, 7, world);
    return;
  }
  st.holdTime = 0;

  if (it.kh && p.sm.isLocomotion()) {
    left.set(p.facingDir.z, 0, -p.facingDir.x);
    let lateral = tmp.dot(left);
    // Shift lock and touch: the stick (A/D) picks the dive side, else the ball's side.
    if (it.sl || it.tc) {
      if (it.ix < -0.3) lateral = 1; else if (it.ix > 0.3) lateral = -1;
      else lateral = dir.subVectors(ball.position, p.position).dot(left);
    }
    const side = lateral >= 0 ? 1 : -1;
    const height = it.ap > 0.14 ? 'high' : it.ap < -0.12 ? 'low' : 'mid';
    const speed = clamp(5 + Math.abs(lateral) * 4, 5, 9);
    GoalkeeperSkills.dive(world, p, side, height, speed);
    p.diveManual = true;
    if (!inBox && ctx.toast) ctx.toast('NO HANDS OUTSIDE THE BOX');
  }
  if (it.cs) {
    if (!inBox) { if (ctx.toast) ctx.toast('NO HANDS OUTSIDE THE BOX'); }
    else if (!GoalkeeperSkills.trySmother(world, p, 1.45) && ctx.toast) ctx.toast('TOO FAR TO CATCH');
  }
  if (it.gr && st.rushCooldown <= 0 && p.sm.isLocomotion()) {
    const d = p.position.distanceTo(ball.position);
    if (!ball.owner && d < 4.5 && inBox) {
      dir.subVectors(ball.position, p.position).setY(0);
      left.set(p.facingDir.z, 0, -p.facingDir.x);
      const side = dir.dot(left) >= 0 ? 1 : -1;
      p.facing = Math.atan2(dir.x, dir.z) - side * Math.PI / 2;
      GoalkeeperSkills.dive(world, p, side, 'low', clamp(d * 2.2, 4, 8));
      p.diveManual = true;
      st.rushCooldown = 2.5;
    } else if (ctx.toast) ctx.toast(inBox ? 'NO LOOSE BALL NEARBY' : 'NO HANDS OUTSIDE THE BOX');
  }
  if (it.gs && st.shuffleCooldown <= 0 && p.sm.isLocomotion()) {
    left.set(p.facingDir.z, 0, -p.facingDir.x);
    let side = 0;
    if (it.ix < -0.3) side = 1; else if (it.ix > 0.3) side = -1;
    if (!side) side = tmp.dot(left) >= 0 ? 1 : -1;
    p.velocity.addScaledVector(left, side * 6.5);
    p.anim.playAction(side > 0 ? 'jukeLeft' : 'jukeRight', { fade: 0.05, duration: 0.35, params: { style: 0 } });
    st.shuffleCooldown = 1.6;
    world.audio.play('slide', { volume: 0.25, pitch: 1.6 });
  }
}

/** True when the intent carries an edge-triggered action (sent immediately by the network client). */
export function intentHasAction(it) {
  return it.cs || it.cr || it.kh || it.tk || it.jk || it.cy || it.nr || it.gr || it.gs || it.gd || it.gc || it.gk;
}
