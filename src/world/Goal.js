import * as THREE from 'three';
import { PITCH } from '../utils/Constants.js';

/**
 * A goal frame: two posts, crossbar, net panels and a back-frame. `side` is -1 (goal at -Z, BLUE's)
 * or +1 (goal at +Z, RED's). The mouth faces the pitch centre.
 */
export class Goal {
  constructor(side) {
    this.side = side;
    this.group = new THREE.Group();
    this.group.name = side < 0 ? 'GoalBlue' : 'GoalRed';
    const { GOAL_WIDTH: W, GOAL_HEIGHT: H, GOAL_DEPTH: D, POST_RADIUS: R, HALF_LENGTH } = PITCH;
    this.lineZ = side * HALF_LENGTH;
    this.width = W; this.height = H; this.depth = D;

    const postMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.1 });
    const postGeo = new THREE.CylinderGeometry(R, R, H, 14);
    const left = new THREE.Mesh(postGeo, postMat);
    left.position.set(-W / 2, H / 2, 0);
    const right = new THREE.Mesh(postGeo, postMat);
    right.position.set(W / 2, H / 2, 0);
    const barGeo = new THREE.CylinderGeometry(R, R, W + R * 2, 14);
    const bar = new THREE.Mesh(barGeo, postMat);
    bar.rotation.z = Math.PI / 2;
    bar.position.set(0, H, 0);
    [left, right, bar].forEach((m) => { m.castShadow = true; m.receiveShadow = true; });
    this.group.add(left, right, bar);

    // Back frame (thinner, further back)
    const thin = new THREE.CylinderGeometry(R * 0.6, R * 0.6, 1, 8);
    const backMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.5 });
    const backH = H * 0.75;
    const addBar = (from, to) => {
      const len = from.distanceTo(to);
      const m = new THREE.Mesh(thin, backMat);
      m.scale.y = len;
      m.position.copy(from).add(to).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
      this.group.add(m);
    };
    const depthSign = side; // net extends away from pitch
    const bz = depthSign * D;
    addBar(new THREE.Vector3(-W / 2, 0, bz), new THREE.Vector3(-W / 2, backH, bz));
    addBar(new THREE.Vector3(W / 2, 0, bz), new THREE.Vector3(W / 2, backH, bz));
    addBar(new THREE.Vector3(-W / 2, backH, bz), new THREE.Vector3(W / 2, backH, bz));
    addBar(new THREE.Vector3(-W / 2, H, 0), new THREE.Vector3(-W / 2, backH, bz));
    addBar(new THREE.Vector3(W / 2, H, 0), new THREE.Vector3(W / 2, backH, bz));

    // Net: wireframe panels + faint translucent fill
    const netMat = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.35, depthWrite: false });
    const fillMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false });
    const panel = (geo, pos, rot) => {
      const wire = new THREE.Mesh(geo, netMat);
      const fill = new THREE.Mesh(geo, fillMat);
      wire.position.copy(pos); fill.position.copy(pos);
      if (rot) { wire.rotation.copy(rot); fill.rotation.copy(rot); }
      this.group.add(wire, fill);
    };
    // back panel
    panel(new THREE.PlaneGeometry(W, backH, 18, 8), new THREE.Vector3(0, backH / 2, bz), new THREE.Euler(0, 0, 0));
    // top sloping panel from crossbar to back top
    const slopeLen = Math.hypot(D, H - backH);
    const slopeGeo = new THREE.PlaneGeometry(W, slopeLen, 18, 6);
    const slopeAngle = Math.atan2(H - backH, D);
    const slopeRot = new THREE.Euler(depthSign > 0 ? -(Math.PI / 2 - slopeAngle) : (Math.PI / 2 - slopeAngle), 0, 0);
    panel(slopeGeo, new THREE.Vector3(0, (H + backH) / 2, bz / 2), slopeRot);
    // side panels (trapezoids approximated as planes)
    const sideShape = new THREE.Shape();
    sideShape.moveTo(0, 0); sideShape.lineTo(0, H); sideShape.lineTo(bz, backH); sideShape.lineTo(bz, 0); sideShape.closePath();
    const sideGeo = new THREE.ShapeGeometry(sideShape, 6);
    // ShapeGeometry lies in XY; we need it in ZY (x -> z). Rotate about Y by -90deg so local x -> world z... use quaternion.
    [-1, 1].forEach((s) => {
      const wire = new THREE.Mesh(sideGeo, netMat);
      const fill = new THREE.Mesh(sideGeo, fillMat);
      [wire, fill].forEach((m) => {
        m.rotation.y = -Math.PI / 2; // rotation about Y by -90deg maps local +x onto world +z
        m.position.set(s * W / 2, 0, 0);
      });
      this.group.add(wire, fill);
    });

    this.group.position.set(0, 0, this.lineZ);
    // rotate so the net is behind the goal line, away from the pitch: geometry already uses signed bz.

    // Collision data (world space): posts as vertical segments, crossbar as horizontal segment.
    // Post names are from the attacker's point of view (facing this goal, "left" is +x for the +Z goal).
    this.posts = [
      { a: new THREE.Vector3(-W / 2, 0, this.lineZ), b: new THREE.Vector3(-W / 2, H, this.lineZ), r: R, name: side > 0 ? 'RIGHT_POST' : 'LEFT_POST' },
      { a: new THREE.Vector3(W / 2, 0, this.lineZ), b: new THREE.Vector3(W / 2, H, this.lineZ), r: R, name: side > 0 ? 'LEFT_POST' : 'RIGHT_POST' },
      { a: new THREE.Vector3(-W / 2 - R, H, this.lineZ), b: new THREE.Vector3(W / 2 + R, H, this.lineZ), r: R, name: 'CROSSBAR' }
    ];
    // Net volume box (for soft containment of the ball)
    this.netMinZ = Math.min(this.lineZ, this.lineZ + bz);
    this.netMaxZ = Math.max(this.lineZ, this.lineZ + bz);
  }

  /** Is the point inside the mouth of the goal (between the posts, under the bar)? */
  isInMouth(x, y) {
    return Math.abs(x) < this.width / 2 - PITCH.POST_RADIUS && y < this.height - PITCH.POST_RADIUS;
  }
}
