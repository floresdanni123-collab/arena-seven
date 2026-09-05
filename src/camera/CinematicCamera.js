import * as THREE from 'three';
import { PITCH } from '../utils/Constants.js';
import { lerp, easeInOutSine } from '../utils/MathUtils.js';

/**
 * Slow cinematic camera used behind the main menu: a set of shots (orbit, dolly, crane) that
 * crossfade by blending positions, so the stadium always drifts gently in the background.
 */
export class CinematicCamera {
  constructor(camera) {
    this.camera = camera;
    this.time = 0;
    this.shotIndex = 0;
    this.shotTime = 0;
    this.shotDuration = 14;
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.focus = new THREE.Vector3(6, 1.0, -4); // where the showcase player stands
    this.shots = [
      // orbit around the showcase player
      (t, out, look) => {
        const a = 0.6 + t * 0.09;
        out.set(this.focus.x + Math.cos(a) * 9, 2.3 + Math.sin(t * 0.3) * 0.4, this.focus.z + Math.sin(a) * 9);
        look.set(this.focus.x, 1.1, this.focus.z);
      },
      // crane over the pitch from a corner
      (t, out, look) => {
        out.set(lerp(-30, -18, t / this.shotDuration), lerp(18, 12, t / this.shotDuration), lerp(-40, -26, t / this.shotDuration));
        look.set(0, 0, 0);
      },
      // low dolly along the touchline, looking across at the goal
      (t, out, look) => {
        out.set(PITCH.HALF_WIDTH + 1.5, 1.6, lerp(-12, 12, t / this.shotDuration));
        look.set(0, 1.2, PITCH.HALF_LENGTH * 0.8);
      },
      // high wide from behind the goal
      (t, out, look) => {
        out.set(lerp(-8, 8, t / this.shotDuration), 9, -PITCH.HALF_LENGTH - 14);
        look.set(0, 0, 10);
      }
    ];
    this.nextShot = 0;
    this.blend = 1;
    this.prevPos = new THREE.Vector3(); this.prevLook = new THREE.Vector3();
    this.curPos = new THREE.Vector3(); this.curLook = new THREE.Vector3();
  }

  update(dt) {
    this.time += dt;
    this.shotTime += dt;
    if (this.shotTime >= this.shotDuration) {
      this.shotTime = 0;
      this.shotIndex = (this.shotIndex + 1) % this.shots.length;
      this.blend = 0;
    }
    this.shots[this.shotIndex](this.shotTime, this.curPos, this.curLook);
    if (this.blend < 1) {
      // blend from the previous shot's end pose for a soft cut
      const prevIdx = (this.shotIndex + this.shots.length - 1) % this.shots.length;
      this.shots[prevIdx](this.shotDuration, this.prevPos, this.prevLook);
      this.blend = Math.min(1, this.blend + dt / 2.2);
      const k = easeInOutSine(this.blend);
      this.pos.lerpVectors(this.prevPos, this.curPos, k);
      this.look.lerpVectors(this.prevLook, this.curLook, k);
    } else {
      this.pos.copy(this.curPos); this.look.copy(this.curLook);
    }
    // gentle handheld sway
    this.pos.y += Math.sin(this.time * 0.7) * 0.08;
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
    if (this.camera.fov !== 50) { this.camera.fov = 50; this.camera.updateProjectionMatrix(); }
  }
}
