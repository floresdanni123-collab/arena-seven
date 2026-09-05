import * as THREE from 'three';
import { smoothstep } from '../utils/MathUtils.js';

/**
 * Chooses which camera rig drives the real camera and blends between rigs so that entering a replay,
 * a set piece or a new controlled player never snaps. Sources expose `position` and `lookAt`.
 */
export class CameraDirector {
  constructor(camera) {
    this.camera = camera;
    this.sources = new Map();
    this.active = null;
    this.blend = null; // { fromPos, fromLook, t, duration }
    this.curPos = new THREE.Vector3();
    this.curLook = new THREE.Vector3();
    this.fromPos = new THREE.Vector3();
    this.fromLook = new THREE.Vector3();
  }

  register(name, source) { this.sources.set(name, source); if (!this.active) this.active = name; }

  /** Switch rig with a timed blend (seconds). Zero = cut. */
  setActive(name, blendSeconds = 0.6) {
    if (this.active === name) return;
    if (blendSeconds > 0 && this.active) {
      this.fromPos.copy(this.curPos);
      this.fromLook.copy(this.curLook);
      this.blend = { t: 0, duration: blendSeconds };
    } else this.blend = null;
    this.active = name;
  }

  get activeName() { return this.active; }

  update(dt) {
    const src = this.sources.get(this.active);
    if (!src) return;
    this.curPos.copy(src.position);
    this.curLook.copy(src.lookAt);
    if (this.blend) {
      this.blend.t += dt;
      const k = smoothstep(0, 1, this.blend.t / this.blend.duration);
      this.curPos.lerpVectors(this.fromPos, src.position, k);
      this.curLook.lerpVectors(this.fromLook, src.lookAt, k);
      if (this.blend.t >= this.blend.duration) this.blend = null;
    }
    this.camera.position.copy(this.curPos);
    this.camera.lookAt(this.curLook);
  }
}
