import * as THREE from 'three';
import { PITCH } from '../utils/Constants.js';
import { rand } from '../utils/MathUtils.js';

/**
 * Stadium environment: tiered stands with an instanced crowd, roof canopies, floodlight towers,
 * a players' tunnel, and a gradient sky dome. Built once and reused for the menu and the match.
 */
export class Stadium {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'Stadium';
    this.crowdMeshes = [];
    this.lightFixtures = [];
    this.time = 0;
    this.build();
  }

  build() {
    this.buildSky();
    this.buildStands();
    this.buildFloodlights();
    this.buildTunnel();
  }

  buildSky() {
    const geo = new THREE.SphereGeometry(420, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        top: { value: new THREE.Color(0x0a1330) },
        mid: { value: new THREE.Color(0x1b2f6b) },
        bottom: { value: new THREE.Color(0x3f4f8a) }
      },
      vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; varying vec3 vPos;
        void main(){
          float h = normalize(vPos).y;
          vec3 c = h > 0.0 ? mix(mid, top, pow(h, 0.6)) : mix(mid, bottom, pow(-h, 0.8));
          gl_FragColor = vec4(c, 1.0);
        }`
    });
    const sky = new THREE.Mesh(geo, mat);
    sky.name = 'Sky';
    this.group.add(sky);

    // A few faint stars
    const starCount = 500;
    const pos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const theta = rand(0, Math.PI * 2), phi = rand(0.1, 1.2);
      const r = 400;
      pos[i * 3] = r * Math.cos(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.sin(phi);
      pos[i * 3 + 2] = r * Math.cos(phi) * Math.sin(theta);
    }
    const sgeo = new THREE.BufferGeometry();
    sgeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const stars = new THREE.Points(sgeo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: true, transparent: true, opacity: 0.7 }));
    this.group.add(stars);
  }

  buildStands() {
    const { HALF_LENGTH, HALF_WIDTH, BOARD_MARGIN } = PITCH;
    const innerX = HALF_WIDTH + BOARD_MARGIN + 4;
    const innerZ = HALF_LENGTH + BOARD_MARGIN + 4;
    const tiers = 12;
    const stepDepth = 1.1;
    const stepHeight = 0.62;
    const concrete = new THREE.MeshStandardMaterial({ color: 0x5c626e, roughness: 0.85 });
    const concreteDark = new THREE.MeshStandardMaterial({ color: 0x3a3f49, roughness: 0.9 });
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x252a35, roughness: 0.8 });

    // Seat / crowd instancing
    const seatGeo = new THREE.BoxGeometry(0.42, 0.42, 0.42);
    const headGeo = new THREE.SphereGeometry(0.16, 6, 5);
    const crowdColors = [0x1f5fe6, 0xe0242f, 0xffffff, 0xf2f2f2, 0x1b1b24, 0xb8ff3b, 0x3a3a55, 0x774422, 0xffc93b, 0x2f7bff, 0x7a1a22, 0xdddddd];
    const skinColors = [0xd9a37b, 0xa8734f, 0x6b4a32, 0xf1c9a5, 0x8c5a3c];

    const sides = [
      { name: 'west', axis: 'x', sign: -1, length: HALF_LENGTH * 2 + 8, inner: innerX },
      { name: 'east', axis: 'x', sign: 1, length: HALF_LENGTH * 2 + 8, inner: innerX },
      { name: 'north', axis: 'z', sign: -1, length: HALF_WIDTH * 2 + 8, inner: innerZ },
      { name: 'south', axis: 'z', sign: 1, length: HALF_WIDTH * 2 + 8, inner: innerZ }
    ];

    const seatsPerMeter = 1.6;
    const totalSeatsEstimate = sides.reduce((s, side) => s + Math.floor(side.length * seatsPerMeter) * tiers, 0);
    const bodyMesh = new THREE.InstancedMesh(seatGeo, new THREE.MeshStandardMaterial({ roughness: 0.9 }), totalSeatsEstimate);
    const headMesh = new THREE.InstancedMesh(headGeo, new THREE.MeshStandardMaterial({ roughness: 0.8 }), totalSeatsEstimate);
    bodyMesh.castShadow = false; headMesh.castShadow = false;
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    let idx = 0;
    this.crowdBase = [];

    for (const side of sides) {
      const standGroup = new THREE.Group();
      // Tier steps
      for (let t = 0; t < tiers; t++) {
        const depthPos = side.inner + t * stepDepth + stepDepth / 2;
        const h = stepHeight * (t + 1);
        const stepGeo = side.axis === 'x'
          ? new THREE.BoxGeometry(stepDepth, h, side.length)
          : new THREE.BoxGeometry(side.length, h, stepDepth);
        const step = new THREE.Mesh(stepGeo, t % 2 ? concrete : concreteDark);
        if (side.axis === 'x') step.position.set(side.sign * depthPos, h / 2, 0);
        else step.position.set(0, h / 2, side.sign * depthPos);
        step.receiveShadow = true;
        standGroup.add(step);

        // Crowd on this tier
        const count = Math.floor(side.length * seatsPerMeter);
        for (let i = 0; i < count; i++) {
          if (idx >= totalSeatsEstimate) break;
          const along = -side.length / 2 + (i + 0.5) * (side.length / count) + rand(-0.12, 0.12);
          const back = depthPos + rand(-0.15, 0.15);
          const y = h + 0.25;
          if (side.axis === 'x') dummy.position.set(side.sign * back, y, along);
          else dummy.position.set(along, y, side.sign * back);
          dummy.rotation.set(0, side.axis === 'x' ? (side.sign < 0 ? Math.PI / 2 : -Math.PI / 2) : (side.sign < 0 ? 0 : Math.PI), 0);
          dummy.scale.set(1, rand(0.9, 1.3), 1);
          dummy.updateMatrix();
          bodyMesh.setMatrixAt(idx, dummy.matrix);
          // Team-biased colours: west/north lean blue, east/south lean red
          const teamBias = (side.name === 'west' || side.name === 'north') ? 0x1f5fe6 : 0xe0242f;
          const c = Math.random() < 0.45 ? teamBias : crowdColors[Math.floor(Math.random() * crowdColors.length)];
          bodyMesh.setColorAt(idx, color.setHex(c));
          dummy.position.y = y + 0.32 * dummy.scale.y;
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          headMesh.setMatrixAt(idx, dummy.matrix);
          headMesh.setColorAt(idx, color.setHex(skinColors[Math.floor(Math.random() * skinColors.length)]));
          this.crowdBase.push({ y: dummy.position.y, phase: rand(0, Math.PI * 2) });
          idx++;
        }
      }

      // Back wall & roof canopy
      const backDepth = side.inner + tiers * stepDepth;
      const wallH = stepHeight * tiers + 3;
      const wallGeo = side.axis === 'x' ? new THREE.BoxGeometry(0.6, wallH, side.length + 2) : new THREE.BoxGeometry(side.length + 2, wallH, 0.6);
      const wall = new THREE.Mesh(wallGeo, wallMat);
      if (side.axis === 'x') wall.position.set(side.sign * (backDepth + 0.3), wallH / 2, 0);
      else wall.position.set(0, wallH / 2, side.sign * (backDepth + 0.3));
      standGroup.add(wall);

      const roofDepth = tiers * stepDepth + 3;
      const roofGeo = side.axis === 'x' ? new THREE.BoxGeometry(roofDepth, 0.35, side.length + 2) : new THREE.BoxGeometry(side.length + 2, 0.35, roofDepth);
      const roof = new THREE.Mesh(roofGeo, new THREE.MeshStandardMaterial({ color: 0xcfd4dc, roughness: 0.5, metalness: 0.4 }));
      const roofY = wallH + 1.5;
      if (side.axis === 'x') { roof.position.set(side.sign * (side.inner + roofDepth / 2 - 1), roofY, 0); roof.rotation.z = side.sign * 0.12; }
      else { roof.position.set(0, roofY, side.sign * (side.inner + roofDepth / 2 - 1)); roof.rotation.x = -side.sign * 0.12; }
      standGroup.add(roof);

      // Roof underside light strip (emissive)
      const stripGeo = side.axis === 'x' ? new THREE.BoxGeometry(0.3, 0.2, side.length) : new THREE.BoxGeometry(side.length, 0.2, 0.3);
      const strip = new THREE.Mesh(stripGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2d0, emissiveIntensity: 2.2 }));
      if (side.axis === 'x') strip.position.set(side.sign * (side.inner + 1), roofY - 0.5, 0);
      else strip.position.set(0, roofY - 0.5, side.sign * (side.inner + 1));
      standGroup.add(strip);

      // Front barrier wall at pitch level
      const barrierGeo = side.axis === 'x' ? new THREE.BoxGeometry(0.3, 1.2, side.length) : new THREE.BoxGeometry(side.length, 1.2, 0.3);
      const barrier = new THREE.Mesh(barrierGeo, new THREE.MeshStandardMaterial({ color: 0x8e95a3, roughness: 0.6, metalness: 0.3 }));
      if (side.axis === 'x') barrier.position.set(side.sign * (side.inner - 0.2), 0.6, 0);
      else barrier.position.set(0, 0.6, side.sign * (side.inner - 0.2));
      standGroup.add(barrier);

      this.group.add(standGroup);
    }
    bodyMesh.count = idx; headMesh.count = idx;
    bodyMesh.instanceMatrix.needsUpdate = true;
    headMesh.instanceMatrix.needsUpdate = true;
    if (bodyMesh.instanceColor) bodyMesh.instanceColor.needsUpdate = true;
    if (headMesh.instanceColor) headMesh.instanceColor.needsUpdate = true;
    this.group.add(bodyMesh, headMesh);
    this.crowdMeshes = [bodyMesh, headMesh];
    this.crowdBody = bodyMesh; this.crowdHead = headMesh;

    // Corner pillars to close the gaps
    const cornerH = stepHeight * tiers + 4.5;
    const cornerGeo = new THREE.CylinderGeometry(3, 3.4, cornerH, 10);
    const cornerMat = new THREE.MeshStandardMaterial({ color: 0x2c313d, roughness: 0.8 });
    const cx = innerX + tiers * stepDepth - 1, cz = innerZ + tiers * stepDepth - 1;
    [[-cx, -cz], [cx, -cz], [-cx, cz], [cx, cz]].forEach(([x, z]) => {
      const p = new THREE.Mesh(cornerGeo, cornerMat);
      p.position.set(x, cornerH / 2, z);
      this.group.add(p);
    });
  }

  buildFloodlights() {
    const { HALF_LENGTH, HALF_WIDTH } = PITCH;
    const towerH = 30;
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x9aa3b2, roughness: 0.5, metalness: 0.6 });
    const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff6dd, emissiveIntensity: 3.5 });
    const positions = [[-HALF_WIDTH - 22, -HALF_LENGTH - 22], [HALF_WIDTH + 22, -HALF_LENGTH - 22], [-HALF_WIDTH - 22, HALF_LENGTH + 22], [HALF_WIDTH + 22, HALF_LENGTH + 22]];
    positions.forEach(([x, z], i) => {
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.6, towerH, 10), poleMat);
      pole.position.y = towerH / 2;
      g.add(pole);
      const head = new THREE.Group();
      head.position.y = towerH;
      const frame = new THREE.Mesh(new THREE.BoxGeometry(6, 3.2, 0.4), new THREE.MeshStandardMaterial({ color: 0x333944, roughness: 0.7 }));
      head.add(frame);
      for (let r = 0; r < 3; r++) for (let c = 0; c < 6; c++) {
        const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.3), lampMat);
        lamp.position.set(-2.5 + c, -1 + r, 0.3);
        head.add(lamp);
      }
      head.lookAt(new THREE.Vector3(0, 0, 0));
      g.add(head);
      g.position.set(x, 0, z);
      this.group.add(g);

      // Actual spot lights (no shadows; the directional key light does shadows).
      const spot = new THREE.SpotLight(0xfff1d6, 380, 200, 0.55, 0.6, 1.4);
      spot.position.set(x, towerH, z);
      spot.target.position.set(0, 0, 0);
      spot.castShadow = false;
      this.group.add(spot, spot.target);

      // Light glow sprite
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: Stadium.glowTexture(), color: 0xfff3d0, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending }));
      glow.scale.set(14, 14, 1);
      glow.position.set(x, towerH, z);
      this.group.add(glow);
      this.lightFixtures.push({ spot, glow, i });
    });
  }

  buildTunnel() {
    const { HALF_WIDTH, BOARD_MARGIN } = PITCH;
    const x = -(HALF_WIDTH + BOARD_MARGIN + 4);
    const g = new THREE.Group();
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x1b1f28, roughness: 0.8 });
    const arch = new THREE.Mesh(new THREE.BoxGeometry(6, 4.5, 8), frameMat);
    arch.position.set(x - 2.5, 2.25, 0);
    g.add(arch);
    const hole = new THREE.Mesh(new THREE.BoxGeometry(6.2, 3.2, 4.2), new THREE.MeshStandardMaterial({ color: 0x05070c, roughness: 1 }));
    hole.position.set(x - 2.4, 1.6, 0);
    g.add(hole);
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(5, 0.3, 6), new THREE.MeshStandardMaterial({ color: 0x1f5fe6, roughness: 0.4, metalness: 0.2 }));
    canopy.position.set(x - 0.5, 4.2, 0);
    g.add(canopy);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(5.4, 1), new THREE.MeshStandardMaterial({ map: Stadium.textTexture('PLAYERS TUNNEL', '#0b1020', '#b8ff3b'), emissive: 0xffffff, emissiveMap: Stadium.textTexture('PLAYERS TUNNEL', '#0b1020', '#b8ff3b'), emissiveIntensity: 0.4 }));
    sign.position.set(x + 0.55, 3.7, 0);
    sign.rotation.y = Math.PI / 2;
    g.add(sign);
    // Dugouts
    [-14, 14].forEach((z) => {
      const dug = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.2, 8), new THREE.MeshStandardMaterial({ color: 0x1a1f2a, roughness: 0.7, metalness: 0.2, transparent: true, opacity: 0.9 }));
      dug.position.set(x + 0.3, 1.1, z);
      g.add(dug);
      const bench = new THREE.Mesh(new THREE.BoxGeometry(1, 0.5, 7), new THREE.MeshStandardMaterial({ color: z < 0 ? 0x1f5fe6 : 0xe0242f, roughness: 0.6 }));
      bench.position.set(x + 0.6, 0.5, z);
      g.add(bench);
    });
    this.group.add(g);
  }

  static glowTexture() {
    if (Stadium._glow) return Stadium._glow;
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,245,210,0.55)');
    grad.addColorStop(1, 'rgba(255,240,200,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
    Stadium._glow = new THREE.CanvasTexture(c);
    return Stadium._glow;
  }

  static textTexture(text, bg, fg) {
    const c = document.createElement('canvas'); c.width = 1024; c.height = 192;
    const g = c.getContext('2d');
    g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height);
    g.font = '900 120px "Barlow Condensed", Impact, sans-serif';
    g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 512, 100);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /** Subtle crowd movement + reactive "jump" on goals (excitement 0..1). */
  update(dt, excitement = 0) {
    this.time += dt;
    if (!this.crowdBody) return;
    // Animate only a slice of instances per frame to keep the cost small.
    const count = this.crowdBody.count;
    const slice = Math.min(count, 400);
    const start = Math.floor((this.time * 900) % count);
    const m = new THREE.Matrix4();
    const amp = 0.04 + excitement * 0.45;
    for (let k = 0; k < slice; k++) {
      const i = (start + k) % count;
      const base = this.crowdBase[i];
      const bob = Math.abs(Math.sin(this.time * (2 + excitement * 6) + base.phase)) * amp;
      this.crowdHead.getMatrixAt(i, m);
      m.elements[13] = base.y + bob;
      this.crowdHead.setMatrixAt(i, m);
    }
    this.crowdHead.instanceMatrix.needsUpdate = true;
  }
}
