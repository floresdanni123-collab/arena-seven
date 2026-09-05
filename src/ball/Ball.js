import * as THREE from 'three';
import { BALL, BALL_STATE } from '../utils/Constants.js';

/**
 * The match ball. Visual is a classic panelled sphere (procedural texture), or the GLB in the manifest.
 * Physical state lives here; BallPhysics integrates it and PossessionSystem manages ownership.
 */
export class Ball {
  constructor(assets) {
    this.radius = BALL.RADIUS;
    this.position = new THREE.Vector3(0, this.radius, 0);
    this.velocity = new THREE.Vector3();
    this.spin = new THREE.Vector3();
    this.rollAxis = new THREE.Vector3(1, 0, 0);
    this.rollSpeed = 0;
    this.state = BALL_STATE.FREE;
    this.owner = null;
    this.lastTouch = null;
    this.lastKicker = null;
    this.kickTime = -10;
    this.kickType = null;
    this.deflected = false;
    this.deflectedBy = null;
    this.time = 0;
    this.frozen = false;          // set pieces: ball sits still until taken
    // Last-touch ledger (used by throw-ins, corners, goal kicks, replays, stats)
    this.lastTouchPlayer = null;
    this.lastTouchTeam = -1;
    this.lastTouchType = null;
    this.lastTouchTime = -10;
    this.previousTouchPlayer = null;
    this.touchLog = [];

    this.group = new THREE.Group();
    this.group.name = 'Ball';
    if (assets === 'headless') {
      // Server-side: transform holders only (the mesh quaternion is still tracked for replication).
      this.headless = true;
      this.mesh = new THREE.Object3D();
      this.group.add(this.mesh);
      this.shadow = new THREE.Object3D();
      this.shadow.material = { opacity: 0 };
      return;
    }
    const gltf = assets && assets.getModel('ball');
    if (gltf) {
      const s = gltf.scene.clone();
      const box = new THREE.Box3().setFromObject(s);
      const size = box.getSize(new THREE.Vector3()).length() / Math.sqrt(3);
      s.scale.setScalar((this.radius * 2) / size);
      s.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      this.mesh = s;
    } else {
      const tex = assets && assets.getTexture('ballAlbedo') || Ball.makeTexture();
      const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.45, metalness: 0.02 });
      this.mesh = new THREE.Mesh(new THREE.SphereGeometry(this.radius, 28, 22), mat);
      this.mesh.castShadow = true;
    }
    this.group.add(this.mesh);

    // soft contact shadow blob (cheap, reads well when the ball is in the air)
    const blobTex = Ball.makeBlobTexture();
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, opacity: 0.45, depthWrite: false }));
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.renderOrder = 1;
    this.group.add(this.shadow);
  }

  static makeTexture() {
    const c = document.createElement('canvas'); c.width = 512; c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#f4f4f4'; g.fillRect(0, 0, 512, 256);
    // pentagon-ish dark patches in a rough equirectangular layout
    const patches = [[64, 64], [192, 128], [320, 64], [448, 128], [128, 200], [384, 200], [256, 20], [256, 236], [0, 128], [512, 128]];
    g.fillStyle = '#151515';
    for (const [x, y] of patches) {
      g.beginPath();
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + i * (Math.PI * 2 / 5);
        const px = x + Math.cos(a) * 28, py = y + Math.sin(a) * 28;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath(); g.fill();
    }
    // seams
    g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 2;
    for (let i = 0; i < 8; i++) { g.beginPath(); g.moveTo(i * 64, 0); g.lineTo(i * 64 + 32, 256); g.stroke(); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  }

  static makeBlobTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
    grad.addColorStop(0, 'rgba(0,0,0,0.75)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }

  /**
   * Record a meaningful contact. Every system that touches the ball goes through here so the
   * last-touch ledger (player, team, type, time) stays reliable.
   */
  recordTouch(player, type) {
    if (!player) return;
    if (this.lastTouchPlayer !== player) {
      this.previousTouchPlayer = this.lastTouchPlayer;
      this.previousTouchType = this.lastTouchType;
      this.previousTouchTeam = this.lastTouchTeam;
    }
    this.lastTouchPlayer = player;
    this.lastTouchTeam = player.team;
    this.lastTouchType = type;
    this.lastTouchTime = this.time;
    this.lastTouch = player;
    this.touchLog.push({ player, type, time: this.time });
    if (this.touchLog.length > 24) this.touchLog.shift();
  }

  /** Apply a kick impulse: sets velocity directly (arcade feel) and records the kicker. */
  kick(velocity, kicker, spinY = 0, touchType = 'PASS') {
    this.velocity.copy(velocity);
    this.spin.set(0, spinY, 0);
    this.owner = null;
    this.frozen = false;
    this.state = BALL_STATE.KICKED;
    this.lastKicker = kicker;
    this.kickTime = this.time;
    this.deflected = false;
    this.deflectedBy = null;
    this.recordTouch(kicker, touchType);
    if (this.position.y < this.radius + 0.01) this.position.y = this.radius + 0.01;
  }

  setVelocity(v) { this.velocity.copy(v); }

  get speed() { return this.velocity.length(); }
  get horizontalSpeed() { return Math.hypot(this.velocity.x, this.velocity.z); }
  get isOnGround() { return this.position.y <= this.radius + 0.01; }

  reset(x = 0, z = 0) {
    this.position.set(x, this.radius, z);
    this.velocity.set(0, 0, 0);
    this.spin.set(0, 0, 0);
    this.state = BALL_STATE.FREE;
    this.owner = null;
    this.lastTouch = null;
    this.lastKicker = null;
    this.deflected = false;
    this.frozen = false;
    this.lastTouchPlayer = null; this.lastTouchTeam = -1; this.lastTouchType = null; this.previousTouchPlayer = null;
  }

  update(dt) {
    this.time += dt;
    this.group.position.copy(this.position);
    // Kicked balls transition to free once they slow down or after a short time.
    if (this.state === BALL_STATE.KICKED && (this.time - this.kickTime > 1.2 || this.speed < 5)) this.state = BALL_STATE.FREE;
    if (this.state === BALL_STATE.LOOSE && this.speed < 2.5) this.state = BALL_STATE.FREE;
    // Rolling visual
    if (this.rollSpeed > 0.01 && this.rollAxis.lengthSq() > 1e-6) {
      const axis = this.rollAxis.clone().normalize();
      this.mesh.rotateOnWorldAxis(axis, this.rollSpeed * dt);
    }
    if (this.spin.lengthSq() > 0.01 && !this.isOnGround) this.mesh.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), this.spin.y * dt);
    // Contact shadow
    const h = this.position.y - this.radius;
    const s = 0.38 + h * 0.12;
    this.shadow.scale.set(s, s, 1);
    this.shadow.position.y = -this.position.y + 0.015;
    this.shadow.material.opacity = Math.max(0.08, 0.5 - h * 0.08);
  }
}
