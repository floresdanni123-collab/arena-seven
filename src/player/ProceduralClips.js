import { CH, CHANNEL_COUNT } from './ProceduralHumanoid.js';
import { clamp, easeOutCubic, easeInOutSine, smoothstep } from '../utils/MathUtils.js';

/**
 * Procedural animation clips. Every clip writes a full pose (all channels) into `out`.
 *   loop clips:      fn(out, phase 0..1, params)   -- phase is a shared stride phase
 *   time clips:      fn(out, t seconds, params)    -- idle-style loops driven by wall time
 *   one-shot clips:  fn(out, t seconds, params)    -- t in [0, duration]
 * These stand in for GLB animations and can be replaced by real clips through the AssetManifest.
 */

const TAU = Math.PI * 2;
const zero = (out) => { for (let i = 0; i < CHANNEL_COUNT; i++) out[i] = 0; };
const seg = (t, a, b) => clamp((t - a) / (b - a), 0, 1);           // 0..1 within [a,b]
const bump = (t, a, b) => Math.sin(Math.PI * seg(t, a, b));           // 0 -> 1 -> 0 within [a,b]

/* ------------------------------------------------------------------ locomotion */

function idle(out, t) {
  zero(out);
  const br = Math.sin(t * 1.6);
  out[CH.spineRX] = 0.03 + 0.015 * br;
  out[CH.rootY] = 0.004 * br;
  out[CH.lShoulderRZ] = 0.12 + 0.02 * br; out[CH.rShoulderRZ] = -0.12 - 0.02 * br;
  out[CH.lElbowRX] = -0.15; out[CH.rElbowRX] = -0.15;
  out[CH.lShoulderRX] = 0.05 * Math.sin(t * 1.1); out[CH.rShoulderRX] = 0.05 * Math.sin(t * 1.1 + 1);
  out[CH.lHipRZ] = 0.05; out[CH.rHipRZ] = -0.05;
  out[CH.lKneeRX] = 0.05; out[CH.rKneeRX] = 0.05;
  out[CH.headRY] = 0.08 * Math.sin(t * 0.5);
}

function gait(out, phase, cfg) {
  zero(out);
  const s = Math.sin(TAU * phase);
  const c = Math.cos(TAU * phase);
  // legs: left leg forward when s > 0 (negative RX = forward)
  out[CH.lHipRX] = -cfg.hip * s;
  out[CH.rHipRX] = cfg.hip * s;
  // knees bend most during the swing (leg moving forward)
  out[CH.lKneeRX] = cfg.kneeBase + cfg.knee * Math.max(0, Math.sin(TAU * phase + 1.1));
  out[CH.rKneeRX] = cfg.kneeBase + cfg.knee * Math.max(0, Math.sin(TAU * phase + 1.1 + Math.PI));
  out[CH.lAnkleRX] = 0.15 * c; out[CH.rAnkleRX] = -0.15 * c;
  // arms opposite to legs
  out[CH.lShoulderRX] = cfg.arm * s;
  out[CH.rShoulderRX] = -cfg.arm * s;
  out[CH.lShoulderRZ] = cfg.armOut; out[CH.rShoulderRZ] = -cfg.armOut;
  out[CH.lElbowRX] = -cfg.elbow - 0.2 * Math.max(0, s);
  out[CH.rElbowRX] = -cfg.elbow - 0.2 * Math.max(0, -s);
  // torso
  out[CH.spineRX] = cfg.lean;
  out[CH.spineRY] = cfg.twist * s;
  out[CH.hipsRY] = -cfg.twist * 0.6 * s;
  out[CH.hipsRZ] = cfg.sway * c;
  out[CH.rootY] = cfg.bob * Math.sin(TAU * 2 * phase + 0.4) + cfg.drop;
  out[CH.headRX] = -cfg.lean * 0.6;
  out[CH.lHipRZ] = 0.04; out[CH.rHipRZ] = -0.04;
}

const WALK = { hip: 0.42, knee: 0.55, kneeBase: 0.08, arm: 0.3, armOut: 0.1, elbow: 0.25, lean: 0.04, twist: 0.06, sway: 0.03, bob: 0.018, drop: 0 };
const JOG = { hip: 0.72, knee: 1.0, kneeBase: 0.15, arm: 0.7, armOut: 0.12, elbow: 1.3, lean: 0.16, twist: 0.1, sway: 0.03, bob: 0.035, drop: -0.02 };
const SPRINT = { hip: 0.95, knee: 1.35, kneeBase: 0.2, arm: 1.05, armOut: 0.14, elbow: 1.6, lean: 0.3, twist: 0.14, sway: 0.035, bob: 0.045, drop: -0.04 };
const DRIBBLE = { hip: 0.58, knee: 0.9, kneeBase: 0.2, arm: 0.5, armOut: 0.2, elbow: 1.1, lean: 0.22, twist: 0.08, sway: 0.03, bob: 0.03, drop: -0.05 };

const walk = (out, p) => gait(out, p, WALK);
const jog = (out, p) => gait(out, p, JOG);
const sprint = (out, p) => gait(out, p, SPRINT);
const dribble = (out, p) => gait(out, p, DRIBBLE);

/* ------------------------------------------------------------------ kicks */

function kickBase(out, t, D, power) {
  zero(out);
  const wind = seg(t, 0, 0.1 * (D / 0.5));
  const swing = seg(t, 0.09, 0.2);
  const settle = seg(t, 0.32, D);
  const fwd = easeOutCubic(swing);
  // right leg: back on windup, then whip forward
  const backAmt = 0.55 * power, fwdAmt = 0.95 * power;
  const hipR = backAmt * wind - (backAmt + fwdAmt) * fwd;
  out[CH.rHipRX] = hipR * (1 - settle) + 0.05 * settle;
  out[CH.rKneeRX] = (1.2 * power * wind) * (1 - fwd) + 0.15 * fwd * (1 - settle) + 0.05;
  out[CH.rAnkleRX] = -0.4 * fwd * (1 - settle);
  // support leg
  out[CH.lHipRX] = 0.12 - 0.15 * fwd * (1 - settle);
  out[CH.lKneeRX] = 0.35 * (1 - settle) + 0.05;
  out[CH.lHipRZ] = 0.08;
  // torso: lean back then over the ball
  out[CH.spineRX] = (-0.25 * power * wind + 0.45 * power * fwd) * (1 - settle) + 0.03;
  out[CH.spineRY] = (-0.3 * wind + 0.5 * fwd) * power * (1 - settle);
  out[CH.hipsRY] = (0.2 * wind - 0.35 * fwd) * power * (1 - settle);
  out[CH.rootY] = -0.06 * (1 - settle) * (0.5 + 0.5 * bump(t, 0.05, 0.3));
  // arms for balance
  out[CH.lShoulderRZ] = 0.9 * power * (wind * 0.6 + fwd * 0.4) * (1 - settle) + 0.12;
  out[CH.rShoulderRZ] = -(0.6 * power * fwd) * (1 - settle) - 0.12;
  out[CH.lShoulderRX] = (-0.5 * fwd + 0.3 * wind) * power * (1 - settle);
  out[CH.rShoulderRX] = (0.6 * fwd - 0.4 * wind) * power * (1 - settle);
  out[CH.lElbowRX] = -0.6; out[CH.rElbowRX] = -0.5;
  out[CH.headRX] = 0.25 * (1 - fwd) * (1 - settle);
}
const lowKick = (out, t) => kickBase(out, t, 0.5, 0.75);
const hardKick = (out, t) => kickBase(out, t, 0.55, 1.15);

/* ------------------------------------------------------------------ slide tackle */

function slideTackle(out, t, p = {}) {
  zero(out);
  const D = p.duration || 0.78;
  const down = easeOutCubic(seg(t, 0, 0.22));
  const up = easeInOutSine(seg(t, D - 0.25, D));
  const k = down * (1 - up);
  out[CH.hipsRX] = -1.25 * k;                 // torso tips back, legs point forward along the ground
  out[CH.rootY] = -0.58 * k;
  out[CH.rHipRX] = -0.15 * k;                 // leading leg straight, slightly raised
  out[CH.rKneeRX] = 0.08 + 0.15 * (1 - k);
  out[CH.rAnkleRX] = -0.5 * k;
  out[CH.lHipRX] = 0.75 * k;                  // trailing leg tucked under
  out[CH.lHipRZ] = 0.35 * k;
  out[CH.lKneeRX] = 1.75 * k + 0.1;
  out[CH.spineRX] = 0.55 * k;                 // sit up a little
  out[CH.headRX] = 0.35 * k;
  out[CH.lShoulderRX] = 0.9 * k; out[CH.lShoulderRZ] = 0.8 * k + 0.1;
  out[CH.rShoulderRX] = -0.5 * k; out[CH.rShoulderRZ] = -1.1 * k - 0.1;
  out[CH.lElbowRX] = -0.4; out[CH.rElbowRX] = -0.3;
}

/* ------------------------------------------------------------------ jukes */

function juke(out, t, dir, style) {
  // dir: +1 = left, -1 = right. style: 0 sidestep, 1 body feint, 2 shoulder drop
  zero(out);
  const D = 0.58;
  const a = bump(t, 0, D);            // main lean envelope
  const feint = bump(t, 0, 0.22);     // quick opposite feint first
  const plant = bump(t, 0.12, 0.42);
  const leanAmt = style === 2 ? 0.55 : 0.4;
  out[CH.hipsRZ] = dir * leanAmt * a - dir * 0.2 * feint * (style === 1 ? 1.4 : 0.6);
  out[CH.spineRZ] = dir * 0.3 * a - dir * 0.15 * feint;
  out[CH.spineRX] = 0.25 + 0.15 * plant;
  out[CH.spineRY] = -dir * 0.35 * a * (style === 2 ? 1.5 : 1);
  out[CH.headRY] = -dir * 0.4 * a;
  out[CH.headRZ] = -dir * 0.15 * a;
  out[CH.rootY] = -0.1 * plant - 0.03;
  // legs: cross-over step
  const inner = dir > 0 ? 'l' : 'r', outer = dir > 0 ? 'r' : 'l';
  out[CH[inner + 'HipRZ']] = dir * 0.55 * plant;   // planted leg splays out
  out[CH[inner + 'HipRX']] = 0.25 * plant;
  out[CH[inner + 'KneeRX']] = 0.45 * plant + 0.1;
  out[CH[outer + 'HipRZ']] = -dir * 0.2 * a;
  out[CH[outer + 'HipRX']] = -0.7 * bump(t, 0.05, 0.35) + 0.4 * bump(t, 0.3, D);
  out[CH[outer + 'KneeRX']] = 1.1 * bump(t, 0.05, 0.4) + 0.1;
  // arms counter-balance
  out[CH.lShoulderRZ] = 0.35 + dir * 0.5 * a; out[CH.rShoulderRZ] = -0.35 + dir * 0.5 * a;
  out[CH.lShoulderRX] = -dir * 0.6 * a; out[CH.rShoulderRX] = dir * 0.6 * a;
  out[CH.lElbowRX] = -1.0; out[CH.rElbowRX] = -1.0;
}
const jukeLeft = (out, t, p = {}) => juke(out, t, 1, p.style || 0);
const jukeRight = (out, t, p = {}) => juke(out, t, -1, p.style || 0);

/* ------------------------------------------------------------------ fall / recover */

function fallPose(out, k) {
  // k 0..1 from standing to lying face-down
  zero(out);
  out[CH.hipsRX] = 1.35 * k;
  out[CH.rootY] = -0.72 * k;
  out[CH.spineRX] = 0.25 * k;
  out[CH.headRX] = -0.6 * k;
  out[CH.lShoulderRX] = -1.6 * k; out[CH.rShoulderRX] = -1.6 * k;
  out[CH.lShoulderRZ] = 0.5 * k + 0.1; out[CH.rShoulderRZ] = -0.5 * k - 0.1;
  out[CH.lElbowRX] = -0.9 * k - 0.1; out[CH.rElbowRX] = -0.9 * k - 0.1;
  out[CH.lHipRX] = -0.2 * k; out[CH.rHipRX] = 0.1 * k;
  out[CH.lKneeRX] = 0.5 * k + 0.05; out[CH.rKneeRX] = 0.2 * k + 0.05;
  out[CH.lHipRZ] = 0.15 * k; out[CH.rHipRZ] = -0.15 * k;
}
function fall(out, t, p = {}) {
  const D = p.duration || 0.7;
  fallPose(out, easeOutCubic(seg(t, 0, D * 0.7)));
  // small bounce on impact
  const imp = bump(t, D * 0.55, D * 0.95);
  out[CH.rootY] += 0.04 * imp;
}
function recover(out, t, p = {}) {
  const D = p.duration || 0.6;
  const k = 1 - easeInOutSine(seg(t, 0, D));
  fallPose(out, k);
  // push up with arms as we rise
  const push = bump(t, 0, D * 0.7);
  out[CH.lShoulderRX] -= 0.4 * push; out[CH.rShoulderRX] -= 0.4 * push;
  out[CH.lKneeRX] += 0.8 * push; out[CH.rKneeRX] += 0.8 * push;
  out[CH.spineRX] += 0.4 * push;
}

/* ------------------------------------------------------------------ celebration */

function celebrate(out, t) {
  zero(out);
  const jump = Math.max(0, Math.sin(t * 5.2));
  out[CH.rootY] = 0.22 * jump - 0.02;
  out[CH.lShoulderRX] = -2.9 + 0.2 * Math.sin(t * 5.2); out[CH.rShoulderRX] = -2.9 - 0.2 * Math.sin(t * 5.2);
  out[CH.lShoulderRZ] = 0.35; out[CH.rShoulderRZ] = -0.35;
  out[CH.lElbowRX] = -0.4; out[CH.rElbowRX] = -0.4;
  out[CH.lKneeRX] = 0.25 * (1 - jump) + 0.5 * jump; out[CH.rKneeRX] = 0.25 * (1 - jump) + 0.5 * jump;
  out[CH.lHipRX] = -0.3 * jump; out[CH.rHipRX] = -0.3 * jump;
  out[CH.spineRX] = -0.15; out[CH.headRX] = -0.35;
  out[CH.hipsRY] = 0.2 * Math.sin(t * 2.6);
}

/* ------------------------------------------------------------------ goalkeeper */

function gkIdle(out, t) {
  zero(out);
  const b = Math.sin(t * 3.2);
  out[CH.rootY] = -0.14 + 0.012 * b;
  out[CH.lHipRX] = -0.5; out[CH.rHipRX] = -0.5;
  out[CH.lHipRZ] = 0.22; out[CH.rHipRZ] = -0.22;
  out[CH.lKneeRX] = 0.75; out[CH.rKneeRX] = 0.75;
  out[CH.spineRX] = 0.42;
  out[CH.headRX] = -0.3;
  out[CH.lShoulderRZ] = 0.7 + 0.03 * b; out[CH.rShoulderRZ] = -0.7 - 0.03 * b;
  out[CH.lShoulderRX] = -0.5; out[CH.rShoulderRX] = -0.5;
  out[CH.lElbowRX] = -1.2; out[CH.rElbowRX] = -1.2;
}
function gkMove(out, phase) {
  gait(out, phase, { hip: 0.45, knee: 0.7, kneeBase: 0.45, arm: 0.2, armOut: 0.6, elbow: 1.1, lean: 0.3, twist: 0.05, sway: 0.04, bob: 0.025, drop: -0.1 });
  out[CH.lShoulderRX] -= 0.4; out[CH.rShoulderRX] -= 0.4;
  out[CH.headRX] = -0.25;
}
function gkDive(out, t, dir, p = {}) {
  // dir +1 = dive to the keeper's left (+X in local space), -1 = right
  zero(out);
  const D = p.duration || 0.9;
  const low = p.low ? 1 : 0;
  const launch = easeOutCubic(seg(t, 0, 0.28));
  const recoverK = easeInOutSine(seg(t, D - 0.3, D));
  const k = launch * (1 - recoverK);
  out[CH.hipsRZ] = dir * (1.25 + 0.2 * low) * k;
  out[CH.rootY] = (-0.15 - 0.5 * k) * (1 - low * 0.2) + (1 - low) * 0.25 * bump(t, 0.05, 0.45);
  out[CH.spineRZ] = dir * 0.3 * k;
  out[CH.spineRX] = 0.2 * (1 - k) + 0.1;
  out[CH.headRZ] = dir * 0.25 * k;
  const lead = dir > 0 ? 'l' : 'r', trail = dir > 0 ? 'r' : 'l';
  out[CH[lead + 'ShoulderRZ']] = dir * (2.6 * k + 0.4);
  out[CH[lead + 'ShoulderRX']] = -0.4 * k;
  out[CH[lead + 'ElbowRX']] = -0.15;
  out[CH[trail + 'ShoulderRZ']] = -dir * (1.9 * k + 0.4);
  out[CH[trail + 'ShoulderRX']] = -0.6 * k;
  out[CH[trail + 'ElbowRX']] = -0.6;
  out[CH[lead + 'HipRX']] = -0.3 * k; out[CH[lead + 'KneeRX']] = 0.2 + 0.5 * (1 - k);
  out[CH[trail + 'HipRX']] = 0.5 * k; out[CH[trail + 'KneeRX']] = 1.0 * k + 0.3 * (1 - k);
  out[CH[trail + 'HipRZ']] = -dir * 0.4 * k;
}
const gkDiveLeft = (out, t, p) => gkDive(out, t, 1, p);
const gkDiveRight = (out, t, p) => gkDive(out, t, -1, p);

function gkCatch(out, t) {
  zero(out);
  const reach = bump(t, 0, 0.3);
  const hug = easeOutCubic(seg(t, 0.18, 0.45));
  out[CH.rootY] = -0.1;
  out[CH.lKneeRX] = 0.5; out[CH.rKneeRX] = 0.5; out[CH.lHipRX] = -0.35; out[CH.rHipRX] = -0.35;
  out[CH.lHipRZ] = 0.15; out[CH.rHipRZ] = -0.15;
  out[CH.spineRX] = 0.3 + 0.15 * hug;
  out[CH.lShoulderRX] = -1.5 * reach - 0.9 * hug; out[CH.rShoulderRX] = -1.5 * reach - 0.9 * hug;
  out[CH.lShoulderRZ] = 0.3 - 0.2 * hug; out[CH.rShoulderRZ] = -0.3 + 0.2 * hug;
  out[CH.lElbowRX] = -0.3 - 1.4 * hug; out[CH.rElbowRX] = -0.3 - 1.4 * hug;
  out[CH.headRX] = 0.3 * hug;
}
function gkParry(out, t) {
  zero(out);
  const k = bump(t, 0, 0.5);
  out[CH.rootY] = 0.18 * bump(t, 0, 0.4) - 0.08;
  out[CH.lShoulderRX] = -2.6 * k; out[CH.rShoulderRX] = -2.6 * k;
  out[CH.lShoulderRZ] = 0.6 * k + 0.2; out[CH.rShoulderRZ] = -0.6 * k - 0.2;
  out[CH.lElbowRX] = -0.2; out[CH.rElbowRX] = -0.2;
  out[CH.spineRX] = -0.15 * k + 0.15;
  out[CH.lKneeRX] = 0.35; out[CH.rKneeRX] = 0.35; out[CH.lHipRX] = -0.25; out[CH.rHipRX] = -0.25;
}
function gkPickup(out, t, p = {}) {
  zero(out);
  const D = p.duration || 0.7;
  const k = bump(t, 0, D);
  out[CH.spineRX] = 1.05 * k + 0.1;
  out[CH.rootY] = -0.22 * k - 0.05;
  out[CH.lHipRX] = -0.55 * k; out[CH.rHipRX] = -0.55 * k;
  out[CH.lKneeRX] = 1.0 * k + 0.15; out[CH.rKneeRX] = 1.0 * k + 0.15;
  out[CH.lShoulderRX] = -0.6 * k; out[CH.rShoulderRX] = -0.6 * k;
  out[CH.lShoulderRZ] = 0.2; out[CH.rShoulderRZ] = -0.2;
  out[CH.lElbowRX] = -0.2 - 0.6 * (1 - k); out[CH.rElbowRX] = -0.2 - 0.6 * (1 - k);
  out[CH.headRX] = -0.5 * k;
}
function gkThrow(out, t, p = {}) {
  zero(out);
  const D = p.duration || 0.6;
  const wind = easeOutCubic(seg(t, 0, 0.22));
  const release = easeOutCubic(seg(t, 0.2, 0.4));
  const settle = seg(t, 0.42, D);
  const k = (1 - settle);
  out[CH.rShoulderRX] = (1.2 * wind - 3.2 * release) * k;
  out[CH.rShoulderRZ] = -0.5 * k - 0.1;
  out[CH.rElbowRX] = (-1.4 * wind + 1.1 * release) * k - 0.15;
  out[CH.lShoulderRX] = (-0.8 * wind + 0.4 * release) * k; out[CH.lShoulderRZ] = 0.4 * k + 0.1; out[CH.lElbowRX] = -0.6;
  out[CH.spineRY] = (0.45 * wind - 0.7 * release) * k;
  out[CH.spineRX] = (-0.2 * wind + 0.35 * release) * k + 0.05;
  out[CH.hipsRY] = (0.2 * wind - 0.3 * release) * k;
  out[CH.lHipRX] = -0.35 * release * k; out[CH.lKneeRX] = 0.35; out[CH.rKneeRX] = 0.25;
  out[CH.rootY] = -0.05;
}

export const PROCEDURAL_CLIPS = {
  idle: { fn: idle, mode: 'time' },
  walk: { fn: walk, mode: 'phase' },
  jog: { fn: jog, mode: 'phase' },
  sprint: { fn: sprint, mode: 'phase' },
  dribble: { fn: dribble, mode: 'phase' },
  gkIdle: { fn: gkIdle, mode: 'time' },
  gkMove: { fn: gkMove, mode: 'phase' },
  lowKick: { fn: lowKick, mode: 'once', duration: 0.5 },
  hardKick: { fn: hardKick, mode: 'once', duration: 0.55 },
  gkKick: { fn: hardKick, mode: 'once', duration: 0.55 },
  slideTackle: { fn: slideTackle, mode: 'once', duration: 0.78 },
  jukeLeft: { fn: jukeLeft, mode: 'once', duration: 0.58 },
  jukeRight: { fn: jukeRight, mode: 'once', duration: 0.58 },
  fall: { fn: fall, mode: 'once', duration: 0.7, hold: true },
  recover: { fn: recover, mode: 'once', duration: 0.6 },
  celebrate: { fn: celebrate, mode: 'time' },
  gkDiveLeft: { fn: gkDiveLeft, mode: 'once', duration: 0.9 },
  gkDiveRight: { fn: gkDiveRight, mode: 'once', duration: 0.9 },
  gkCatch: { fn: gkCatch, mode: 'once', duration: 0.5, hold: true },
  gkParry: { fn: gkParry, mode: 'once', duration: 0.5 },
  gkPickup: { fn: gkPickup, mode: 'once', duration: 0.7 },
  gkThrow: { fn: gkThrow, mode: 'once', duration: 0.6 }
};
