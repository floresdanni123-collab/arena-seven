import * as THREE from 'three';
import { clamp, damp, lerp, rand } from '../utils/MathUtils.js';
import { SHIFT_LOCK } from '../utils/Constants.js';

const DEFAULT_PITCH = 0.34;

/**
 * Third-person football camera: orbits behind the controlled player, yaw/pitch from the mouse,
 * smooth follow, sprint zoom-out, optional shake. Provides the aim direction used for kicks.
 */
export class PlayerCamera {
  constructor(camera, settings) {
    this.camera = camera;
    this.settings = settings;
    this.yaw = 0;
    this.pitch = DEFAULT_PITCH;
    this.distance = 7.6;
    this.currentDistance = this.distance;
    this.height = 1.35;
    this.target = null;
    this.smoothTarget = new THREE.Vector3();
    this.smoothPos = new THREE.Vector3();
    this.lookAt = new THREE.Vector3();
    this.shake = 0;
    this.shakeOffset = new THREE.Vector3();
    this.initialised = false;
    this.aimDir = new THREE.Vector3(0, 0, 1);
    this.forward = new THREE.Vector3();
    this.right = new THREE.Vector3();
    this.fovBase = 62;
    this.position = new THREE.Vector3();
    this.focusPoint = null;
    this.rigs = {
      player: { distance: 7.6, height: 1.35, pitch: DEFAULT_PITCH },
      keeper: { distance: 7.2, height: 2.0, pitch: 0.3 },
      setpiece: { distance: 9.5, height: 2.1, pitch: 0.4 }
    };
    this.rig = 'player';
    this.shiftLock = null;   // ShiftLockController, set by the match
    this.shoulder = 0;       // 0 = centred behind the player, 1 = over-the-shoulder framing
    this.shoulderOffset = new THREE.Vector3();
  }

  /** Switch framing preset; distance/height ease in through the normal damping. */
  setRig(name, focusPoint = null) {
    const r = this.rigs[name] || this.rigs.player;
    this.rig = name;
    this.distance = r.distance;
    this.height = r.height;
    this.focusPoint = focusPoint ? focusPoint.clone() : null;
    if (name === 'setpiece') this.pitch = r.pitch;
  }

  setTarget(player, snap = false) {
    this.target = player;
    if (snap || !this.initialised) {
      this.yaw = player.facing;
      this.pitch = DEFAULT_PITCH;
      this.smoothTarget.copy(player.position).add(new THREE.Vector3(0, this.height, 0));
      this.computeIdealPosition(this.smoothPos, this.distance);
      this.initialised = true;
    }
  }

  applyMouse(dx, dy) {
    const sens = 0.0022 * this.settings.get('mouseSensitivity');
    const invert = this.settings.get('invertY') ? -1 : 1;
    this.yaw -= dx * sens;
    this.pitch += dy * sens * 0.8 * invert;
    this.pitch = clamp(this.pitch, 0.06, 0.82);
  }

  /** Kick elevation hint in radians: looking "up" (low camera) lifts the ball, looking down drives it. */
  get aimPitch() { return (DEFAULT_PITCH - this.pitch) * 1.8; }

  computeIdealPosition(out, distance) {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    out.set(
      this.smoothTarget.x - Math.sin(this.yaw) * cp * distance,
      this.smoothTarget.y + sp * distance,
      this.smoothTarget.z - Math.cos(this.yaw) * cp * distance
    );
    return out;
  }

  addShake(amount) {
    if (!this.settings.get('cameraShake')) return;
    this.shake = Math.min(1, this.shake + amount);
  }

  update(dt) {
    if (!this.target) return;
    const p = this.target;
    // follow target with lag; look slightly ahead of the player's velocity
    const ahead = 0.35;
    const tx = p.position.x + p.velocity.x * ahead * 0.25;
    const tz = p.position.z + p.velocity.z * ahead * 0.25;
    this.smoothTarget.x = damp(this.smoothTarget.x, tx, 14, dt);
    this.smoothTarget.z = damp(this.smoothTarget.z, tz, 14, dt);
    this.smoothTarget.y = damp(this.smoothTarget.y, this.height, 8, dt);

    // Aim vectors first: the shoulder offset below is built from the current yaw.
    this.aimDir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.forward.copy(this.aimDir);
    this.right.set(-this.forward.z, 0, this.forward.x);

    // Shift lock: over-the-shoulder framing, blended in/out over SHIFT_LOCK.TRANSITION seconds.
    // Set-piece framing overrides it; the shift-lock state itself is untouched.
    const slActive = !!(this.shiftLock && this.shiftLock.enabled) && this.rig !== 'setpiece';
    this.shoulder = damp(this.shoulder, slActive ? 1 : 0, 3 / SHIFT_LOCK.TRANSITION, dt);
    const keeper = this.rig === 'keeper';
    const slDist = keeper ? SHIFT_LOCK.KEEPER_DISTANCE : SHIFT_LOCK.DISTANCE;
    const slHeight = keeper ? SHIFT_LOCK.KEEPER_HEIGHT : SHIFT_LOCK.HEIGHT;
    const slSide = keeper ? SHIFT_LOCK.KEEPER_SIDE_OFFSET : SHIFT_LOCK.SIDE_OFFSET;
    this.smoothTarget.y = damp(this.smoothTarget.y, lerp(this.height, slHeight, this.shoulder), 8, dt);
    this.shoulderOffset.copy(this.right).multiplyScalar(slSide * this.shoulder);

    const sprinting = p.sprintInput && p.speed > 6.5;
    const wantDist = lerp(this.distance, slDist, this.shoulder) + (sprinting ? 1.1 : 0) + (p.hasBall ? -0.3 : 0);
    this.currentDistance = damp(this.currentDistance, wantDist, 3, dt);

    const ideal = this.computeIdealPosition(new THREE.Vector3(), this.currentDistance).add(this.shoulderOffset);
    // Lock the orbit rigidly (no lag on rotation) but smooth the distance/target motion
    this.smoothPos.x = damp(this.smoothPos.x, ideal.x, 30, dt);
    this.smoothPos.y = damp(this.smoothPos.y, ideal.y, 20, dt);
    this.smoothPos.z = damp(this.smoothPos.z, ideal.z, 30, dt);
    if (this.smoothPos.y < 0.55) this.smoothPos.y = 0.55;

    // shake
    if (this.shake > 0.001) {
      this.shake = damp(this.shake, 0, 6, dt);
      const s = this.shake * 0.35;
      this.shakeOffset.set(rand(-s, s), rand(-s, s), rand(-s, s));
    } else this.shakeOffset.set(0, 0, 0);

    // Output pose (applied by the CameraDirector so rig changes can be blended)
    this.position.copy(this.smoothPos).add(this.shakeOffset);
    this.lookAt.copy(this.smoothTarget).add(this.shoulderOffset);
    this.lookAt.y += 0.25;
    if (this.focusPoint) {
      // Set pieces: bias the look-at toward the ball so the target is framed while aiming.
      this.lookAt.lerp(this.focusPoint, 0.35);
    }

    const fov = this.fovBase + (sprinting ? 4 : 0);
    if (Math.abs(this.camera.fov - fov) > 0.05) { this.camera.fov = damp(this.camera.fov, fov, 4, dt); this.camera.updateProjectionMatrix(); }

  }

  /** Convert an input axis (x right, z forward) into a world direction relative to the camera. */
  inputToWorld(x, z, out) {
    out.set(this.forward.x * z + this.right.x * x, 0, this.forward.z * z + this.right.z * x);
    return out;
  }
}
