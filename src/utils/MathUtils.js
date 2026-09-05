import * as THREE from 'three';

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;
export const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
export const randInt = (a, b) => Math.floor(rand(a, b + 1));
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const sign = (v) => (v < 0 ? -1 : 1);

/** Exponential damping that is frame-rate independent. */
export const damp = (current, target, lambda, dt) => lerp(current, target, 1 - Math.exp(-lambda * dt));

/** Shortest signed angular difference (b - a) in radians, range [-PI, PI]. */
export function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function dampAngle(current, target, lambda, dt) {
  return current + angleDelta(current, target) * (1 - Math.exp(-lambda * dt));
}

/** Yaw (rotation about Y) of a horizontal direction vector. Facing +Z gives 0. */
export const yawFromDir = (x, z) => Math.atan2(x, z);
export const dirFromYaw = (yaw, out = new THREE.Vector3()) => out.set(Math.sin(yaw), 0, Math.cos(yaw));

export function flatDistance(a, b) {
  const dx = a.x - b.x, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

export function flatDistanceSq(a, b) {
  const dx = a.x - b.x, dz = a.z - b.z;
  return dx * dx + dz * dz;
}

/** Closest point on segment ab to point p (all Vector3), written to out. Returns t in [0,1]. */
export function closestPointOnSegment(a, b, p, out) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const apx = p.x - a.x, apy = p.y - a.y, apz = p.z - a.z;
  const len = abx * abx + aby * aby + abz * abz;
  let t = len > 1e-8 ? (apx * abx + apy * aby + apz * abz) / len : 0;
  t = clamp(t, 0, 1);
  out.set(a.x + abx * t, a.y + aby * t, a.z + abz * t);
  return t;
}

/** Simple ballistic prediction ignoring drag: position after time t. */
export function predictBallistic(pos, vel, t, gravity, out) {
  out.set(pos.x + vel.x * t, pos.y + vel.y * t - 0.5 * gravity * t * t, pos.z + vel.z * t);
  return out;
}

/** Time for a ball at pos travelling with vel to reach the plane z = planeZ. Returns Infinity if never. */
export function timeToPlaneZ(pos, vel, planeZ) {
  if (Math.abs(vel.z) < 1e-4) return Infinity;
  const t = (planeZ - pos.z) / vel.z;
  return t >= 0 ? t : Infinity;
}

export function gaussian() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

export const V3 = {
  a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), d: new THREE.Vector3(), e: new THREE.Vector3()
};
