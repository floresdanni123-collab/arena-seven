import * as THREE from 'three';

/**
 * Shift-lock state (toggled with C). When enabled the controlled player faces the camera's horizontal
 * forward direction, movement stays camera-relative (strafing instead of turning) and the PlayerCamera
 * frames the player over the shoulder. The state is owned here so player switching, pass switching,
 * set pieces and replays never reset it; they only ask for the current flattened camera vectors.
 */
export class ShiftLockController {
  constructor(camera, events, initial = false) {
    this.camera = camera;       // PlayerCamera
    this.events = events;
    this.enabled = !!initial;
    this.forward = new THREE.Vector3(0, 0, 1);
    this.right = new THREE.Vector3(-1, 0, 0);
  }

  enable() { this.set(true); }
  disable() { this.set(false); }
  toggle() { this.set(!this.enabled); }

  set(v) {
    if (this.enabled === v) return;
    this.enabled = v;
    this.events.emit('shift_lock', { enabled: v });
  }

  /** Camera forward flattened to the ground plane and normalised. */
  get cameraForward() {
    this.forward.copy(this.camera.forward); this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-6) this.forward.set(0, 0, 1);
    return this.forward.normalize();
  }

  /** Ground-plane right vector perpendicular to cameraForward. */
  get cameraRight() {
    const f = this.cameraForward;
    return this.right.set(-f.z, 0, f.x);
  }
}
