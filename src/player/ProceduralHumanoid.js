import * as THREE from 'three';

/**
 * Pose channel layout shared by the procedural clips and the procedural animator.
 * Rotation conventions (radians): +RX swings a hanging limb backwards (-Z), knees/elbows bend with +/-RX,
 * +RZ swings a hanging limb outwards to the character's left, spineRX + leans forward.
 */
export const CHANNELS = [
  'rootY', 'hipsRX', 'hipsRY', 'hipsRZ',
  'spineRX', 'spineRY', 'spineRZ',
  'headRX', 'headRY', 'headRZ',
  'lShoulderRX', 'lShoulderRY', 'lShoulderRZ', 'lElbowRX',
  'rShoulderRX', 'rShoulderRY', 'rShoulderRZ', 'rElbowRX',
  'lHipRX', 'lHipRY', 'lHipRZ', 'lKneeRX', 'lAnkleRX',
  'rHipRX', 'rHipRY', 'rHipRZ', 'rKneeRX', 'rAnkleRX'
];
export const CH = {};
CHANNELS.forEach((c, i) => { CH[c] = i; });
export const CHANNEL_COUNT = CHANNELS.length;

const HIPS_HEIGHT = 0.95;

/**
 * A multi-part humanoid built from primitives, with a joint hierarchy the procedural animator drives.
 * Materials are exposed (shirt, shorts, skin, socks, boots, hair) so kits can be recoloured live.
 */
export class ProceduralHumanoid {
  constructor(opts = {}) {
    this.root = new THREE.Group();
    this.root.name = 'ProceduralHumanoid';
    this.joints = {};
    this.materials = {
      shirt: new THREE.MeshStandardMaterial({ color: opts.shirtColor ?? 0x1f5fe6, roughness: 0.75 }),
      shorts: new THREE.MeshStandardMaterial({ color: opts.shortsColor ?? 0xffffff, roughness: 0.8 }),
      skin: new THREE.MeshStandardMaterial({ color: opts.skinTone ?? 0xd9a37b, roughness: 0.65 }),
      socks: new THREE.MeshStandardMaterial({ color: opts.socksColor ?? 0x1f5fe6, roughness: 0.85 }),
      boots: new THREE.MeshStandardMaterial({ color: opts.bootColor ?? 0x111111, roughness: 0.5, metalness: 0.1 }),
      hair: new THREE.MeshStandardMaterial({ color: opts.hairColor ?? 0x2a1a10, roughness: 0.9 }),
      gloves: new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.6 })
    };
    this.isGoalkeeper = !!opts.goalkeeper;
    this.build(opts);
  }

  mesh(geo, mat, castShadow = true) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = castShadow;
    m.receiveShadow = false;
    return m;
  }

  build(opts) {
    const M = this.materials;
    const J = this.joints;

    // ---- Hips / pelvis ----
    const hips = new THREE.Group(); hips.position.y = HIPS_HEIGHT; hips.name = 'hips';
    this.root.add(hips); J.hips = hips;
    const pelvis = this.mesh(new THREE.BoxGeometry(0.34, 0.2, 0.22), M.shorts);
    pelvis.position.y = 0.0;
    hips.add(pelvis);

    // ---- Spine / torso ----
    const spine = new THREE.Group(); spine.position.y = 0.08; spine.name = 'spine';
    hips.add(spine); J.spine = spine;
    const torsoGeo = new THREE.CapsuleGeometry(0.2, 0.28, 6, 12);
    const torso = this.mesh(torsoGeo, M.shirt);
    torso.scale.set(1.0, 1.0, 0.62);
    torso.position.y = 0.3;
    spine.add(torso);
    // shoulders/chest bulk
    const chest = this.mesh(new THREE.BoxGeometry(0.44, 0.16, 0.2), M.shirt);
    chest.position.y = 0.48;
    spine.add(chest);
    // number on back
    this.numberPlane = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.28), new THREE.MeshStandardMaterial({ transparent: true, roughness: 0.8, alphaTest: 0.1 }));
    this.numberPlane.position.set(0, 0.32, -0.135);
    this.numberPlane.rotation.y = Math.PI;
    spine.add(this.numberPlane);

    // ---- Head ----
    const head = new THREE.Group(); head.position.y = 0.6; head.name = 'head';
    spine.add(head); J.head = head;
    const neck = this.mesh(new THREE.CylinderGeometry(0.055, 0.065, 0.1, 10), M.skin);
    neck.position.y = 0.03;
    head.add(neck);
    const skull = this.mesh(new THREE.SphereGeometry(0.115, 16, 14), M.skin);
    skull.position.y = 0.16;
    skull.scale.set(0.92, 1.08, 0.95);
    head.add(skull);
    this.hairMesh = null;
    this.setHairStyle(opts.hairStyle ?? 1);
    // eyes (tiny, dark) so the head has a front
    const eyeGeo = new THREE.SphereGeometry(0.014, 6, 6);
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
    [-0.038, 0.038].forEach((x) => { const e = new THREE.Mesh(eyeGeo, eyeMat); e.position.set(x, 0.18, 0.1); head.add(e); });

    // ---- Arms ----
    const buildArm = (side) => {
      const s = side === 'l' ? 1 : -1;
      const shoulder = new THREE.Group(); shoulder.position.set(s * 0.25, 0.5, 0); shoulder.name = side + 'Shoulder';
      spine.add(shoulder); J[side + 'Shoulder'] = shoulder;
      const sleeve = this.mesh(new THREE.CapsuleGeometry(0.065, 0.16, 4, 10), M.shirt);
      sleeve.position.y = -0.13;
      shoulder.add(sleeve);
      const elbow = new THREE.Group(); elbow.position.y = -0.28; elbow.name = side + 'Elbow';
      shoulder.add(elbow); J[side + 'Elbow'] = elbow;
      const forearm = this.mesh(new THREE.CapsuleGeometry(0.05, 0.18, 4, 10), M.skin);
      forearm.position.y = -0.14;
      elbow.add(forearm);
      const hand = this.mesh(new THREE.SphereGeometry(0.055, 10, 8), this.isGoalkeeper ? M.gloves : M.skin);
      hand.position.y = -0.29;
      hand.scale.set(0.8, 1.1, 1.1);
      elbow.add(hand);
    };
    buildArm('l'); buildArm('r');

    // ---- Legs ----
    const buildLeg = (side) => {
      const s = side === 'l' ? 1 : -1;
      const hip = new THREE.Group(); hip.position.set(s * 0.1, -0.05, 0); hip.name = side + 'Hip';
      hips.add(hip); J[side + 'Hip'] = hip;
      const shortLeg = this.mesh(new THREE.CylinderGeometry(0.1, 0.095, 0.2, 10), M.shorts);
      shortLeg.position.y = -0.1;
      hip.add(shortLeg);
      const thigh = this.mesh(new THREE.CapsuleGeometry(0.082, 0.24, 4, 10), M.skin);
      thigh.position.y = -0.25;
      hip.add(thigh);
      const knee = new THREE.Group(); knee.position.y = -0.44; knee.name = side + 'Knee';
      hip.add(knee); J[side + 'Knee'] = knee;
      const shin = this.mesh(new THREE.CapsuleGeometry(0.065, 0.26, 4, 10), M.socks);
      shin.position.y = -0.22;
      knee.add(shin);
      const ankle = new THREE.Group(); ankle.position.y = -0.42; ankle.name = side + 'Ankle';
      knee.add(ankle); J[side + 'Ankle'] = ankle;
      const boot = this.mesh(new THREE.BoxGeometry(0.11, 0.09, 0.27), M.boots);
      boot.position.set(0, -0.045, 0.05);
      ankle.add(boot);
      const toe = this.mesh(new THREE.SphereGeometry(0.06, 8, 6), M.boots);
      toe.position.set(0, -0.05, 0.17);
      toe.scale.set(0.9, 0.7, 1);
      ankle.add(toe);
    };
    buildLeg('l'); buildLeg('r');

    this.setNumber(opts.number ?? 0);
  }

  setHairStyle(style) {
    if (this.hairMesh) { this.joints.head.remove(this.hairMesh); this.hairMesh.geometry.dispose(); }
    let geo;
    switch (style) {
      case 0: geo = null; break; // shaved
      case 2: geo = new THREE.SphereGeometry(0.125, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.42); break; // cap style
      case 3: geo = new THREE.BoxGeometry(0.2, 0.09, 0.2); break; // flat top
      default: geo = new THREE.SphereGeometry(0.122, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55); // regular
    }
    if (!geo) { this.hairMesh = null; return; }
    const hair = this.mesh(geo, this.materials.hair);
    hair.position.y = style === 3 ? 0.27 : 0.17;
    hair.scale.set(0.95, style === 2 ? 1.05 : 1.12, 0.98);
    this.joints.head.add(hair);
    this.hairMesh = hair;
  }

  setNumber(num) {
    const c = document.createElement('canvas'); c.width = 128; c.height = 148;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 128, 148);
    g.font = '900 118px "Barlow Condensed", Impact, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const shirt = this.materials.shirt.color;
    const lum = 0.299 * shirt.r + 0.587 * shirt.g + 0.114 * shirt.b;
    g.fillStyle = lum > 0.5 ? '#111111' : '#ffffff';
    g.fillText(String(num), 64, 80);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    if (this.numberPlane.material.map) this.numberPlane.material.map.dispose();
    this.numberPlane.material.map = tex;
    this.numberPlane.material.needsUpdate = true;
    this.numberPlane.visible = num > 0;
  }

  setColors({ shirt, shorts, socks, skin, hair, boots }) {
    if (shirt !== undefined) this.materials.shirt.color.setHex(shirt);
    if (shorts !== undefined) this.materials.shorts.color.setHex(shorts);
    if (socks !== undefined) this.materials.socks.color.setHex(socks);
    if (skin !== undefined) this.materials.skin.color.setHex(skin);
    if (hair !== undefined) this.materials.hair.color.setHex(hair);
    if (boots !== undefined) this.materials.boots.color.setHex(boots);
  }

  /** Apply a pose array (see CHANNELS) to the joint hierarchy. */
  applyPose(p) {
    const J = this.joints;
    J.hips.position.y = HIPS_HEIGHT + p[CH.rootY];
    J.hips.rotation.set(p[CH.hipsRX], p[CH.hipsRY], p[CH.hipsRZ]);
    J.spine.rotation.set(p[CH.spineRX], p[CH.spineRY], p[CH.spineRZ]);
    J.head.rotation.set(p[CH.headRX], p[CH.headRY], p[CH.headRZ]);
    J.lShoulder.rotation.set(p[CH.lShoulderRX], p[CH.lShoulderRY], p[CH.lShoulderRZ]);
    J.lElbow.rotation.set(p[CH.lElbowRX], 0, 0);
    J.rShoulder.rotation.set(p[CH.rShoulderRX], p[CH.rShoulderRY], p[CH.rShoulderRZ]);
    J.rElbow.rotation.set(p[CH.rElbowRX], 0, 0);
    J.lHip.rotation.set(p[CH.lHipRX], p[CH.lHipRY], p[CH.lHipRZ]);
    J.lKnee.rotation.set(p[CH.lKneeRX], 0, 0);
    J.lAnkle.rotation.set(p[CH.lAnkleRX], 0, 0);
    J.rHip.rotation.set(p[CH.rHipRX], p[CH.rHipRY], p[CH.rHipRZ]);
    J.rKnee.rotation.set(p[CH.rKneeRX], 0, 0);
    J.rAnkle.rotation.set(p[CH.rAnkleRX], 0, 0);
  }

  /** World position of the right (kicking) foot, used for ball contact visuals. */
  getFootWorldPosition(side, out) {
    return this.joints[side + 'Ankle'].getWorldPosition(out);
  }

  dispose() {
    this.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    Object.values(this.materials).forEach((m) => m.dispose());
    if (this.numberPlane.material.map) this.numberPlane.material.map.dispose();
    this.numberPlane.material.dispose();
  }
}
