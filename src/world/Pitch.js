import * as THREE from 'three';
import { PITCH } from '../utils/Constants.js';

/**
 * The playing surface: a striped grass texture with crisp white markings painted into a canvas,
 * plus the surrounding turf apron and the arcade rebound boards.
 */
export class Pitch {
  constructor(assets) {
    this.group = new THREE.Group();
    this.group.name = 'Pitch';
    this.build(assets);
  }

  build(assets) {
    const { LENGTH, WIDTH, HALF_LENGTH, HALF_WIDTH, BOARD_MARGIN } = PITCH;

    // ---- Grass + markings texture ----
    const texW = 2048;
    const texH = Math.round(texW * (LENGTH / WIDTH));
    const canvas = document.createElement('canvas');
    canvas.width = texW; canvas.height = texH;
    const ctx = canvas.getContext('2d');
    const pxPerM = texW / WIDTH;

    // base grass
    ctx.fillStyle = '#3f8f2c';
    ctx.fillRect(0, 0, texW, texH);

    // mowing stripes along the length (z)
    const stripes = 14;
    const stripeH = texH / stripes;
    for (let i = 0; i < stripes; i++) {
      ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.07)';
      ctx.fillRect(0, i * stripeH, texW, stripeH);
    }
    // subtle cross stripes
    const cross = 10;
    for (let i = 0; i < cross; i++) {
      ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.018)' : 'rgba(0,0,0,0.02)';
      ctx.fillRect(i * (texW / cross), 0, texW / cross, texH);
    }
    // grass noise
    const img = ctx.getImageData(0, 0, texW, texH);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * 18;
      d[i] += n; d[i + 1] += n * 1.2; d[i + 2] += n * 0.6;
    }
    ctx.putImageData(img, 0, 0);

    // markings: x across (texture x), z along (texture y, +z = down in canvas => we flip later via texture)
    const X = (x) => (x + HALF_WIDTH) * pxPerM;
    const Z = (z) => (z + HALF_LENGTH) * pxPerM;
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = PITCH.LINE_WIDTH * pxPerM;
    ctx.lineCap = 'butt';

    // touchlines & goal lines
    ctx.strokeRect(X(-HALF_WIDTH) + ctx.lineWidth / 2, Z(-HALF_LENGTH) + ctx.lineWidth / 2, WIDTH * pxPerM - ctx.lineWidth, LENGTH * pxPerM - ctx.lineWidth);
    // halfway line
    ctx.beginPath(); ctx.moveTo(X(-HALF_WIDTH), Z(0)); ctx.lineTo(X(HALF_WIDTH), Z(0)); ctx.stroke();
    // centre circle + spot
    ctx.beginPath(); ctx.arc(X(0), Z(0), PITCH.CENTER_CIRCLE_RADIUS * pxPerM, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(X(0), Z(0), 0.2 * pxPerM, 0, Math.PI * 2); ctx.fill();

    const drawEnd = (sgn) => {
      const gl = sgn * HALF_LENGTH;
      const paW = PITCH.PENALTY_AREA_WIDTH / 2, paD = PITCH.PENALTY_AREA_DEPTH;
      const gaW = PITCH.GOAL_AREA_WIDTH / 2, gaD = PITCH.GOAL_AREA_DEPTH;
      // penalty area
      ctx.beginPath();
      ctx.moveTo(X(-paW), Z(gl)); ctx.lineTo(X(-paW), Z(gl - sgn * paD)); ctx.lineTo(X(paW), Z(gl - sgn * paD)); ctx.lineTo(X(paW), Z(gl));
      ctx.stroke();
      // goal area
      ctx.beginPath();
      ctx.moveTo(X(-gaW), Z(gl)); ctx.lineTo(X(-gaW), Z(gl - sgn * gaD)); ctx.lineTo(X(gaW), Z(gl - sgn * gaD)); ctx.lineTo(X(gaW), Z(gl));
      ctx.stroke();
      // penalty spot
      ctx.beginPath(); ctx.arc(X(0), Z(gl - sgn * PITCH.PENALTY_SPOT), 0.18 * pxPerM, 0, Math.PI * 2); ctx.fill();
      // penalty arc (outside the area)
      const r = PITCH.CENTER_CIRCLE_RADIUS * pxPerM;
      const cx = X(0), cz = Z(gl - sgn * PITCH.PENALTY_SPOT);
      const edge = Z(gl - sgn * paD);
      const dz = Math.abs(edge - cz);
      if (dz < r) {
        const a = Math.acos(dz / r);
        ctx.beginPath();
        if (sgn > 0) ctx.arc(cx, cz, r, Math.PI * 1.5 - a, Math.PI * 1.5 + a);
        else ctx.arc(cx, cz, r, Math.PI * 0.5 - a, Math.PI * 0.5 + a);
        ctx.stroke();
      }
      // corner arcs
      const cr = 0.8 * pxPerM;
      [[-HALF_WIDTH, 0], [HALF_WIDTH, Math.PI]].forEach(([x]) => {
        ctx.beginPath();
        ctx.arc(X(x), Z(gl), cr, 0, Math.PI * 2);
        ctx.stroke();
      });
    };
    drawEnd(1); drawEnd(-1);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.flipY = true;

    // Fine detail grass normal-ish variation via a repeating bump canvas.
    const bump = document.createElement('canvas'); bump.width = bump.height = 256;
    const bctx = bump.getContext('2d');
    const bimg = bctx.createImageData(256, 256);
    for (let i = 0; i < bimg.data.length; i += 4) { const v = 110 + Math.random() * 60; bimg.data[i] = bimg.data[i + 1] = bimg.data[i + 2] = v; bimg.data[i + 3] = 255; }
    bctx.putImageData(bimg, 0, 0);
    const bumpTex = new THREE.CanvasTexture(bump);
    bumpTex.wrapS = bumpTex.wrapT = THREE.RepeatWrapping;
    bumpTex.repeat.set(WIDTH * 1.5, LENGTH * 1.5);

    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0, bumpMap: bumpTex, bumpScale: 0.015 });
    // The canvas y axis (down) maps to +z, and PlaneGeometry rotated -90deg about X puts texture v=1 at -z...
    // We rotate the plane so canvas top (z=-HALF_LENGTH) sits at -Z.
    const geo = new THREE.PlaneGeometry(WIDTH, LENGTH, 1, 1);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2; // canvas top (v=1) lands at -Z, canvas bottom at +Z
    mesh.receiveShadow = true;
    mesh.name = 'PitchSurface';
    this.group.add(mesh);
    this.surface = mesh;

    // ---- Surrounding apron (darker turf) ----
    const apronW = WIDTH + BOARD_MARGIN * 2 + 0.5;
    const apronL = LENGTH + BOARD_MARGIN * 2 + 0.5;
    const apronGeo = new THREE.PlaneGeometry(apronW, apronL);
    const apronMat = new THREE.MeshStandardMaterial({ color: 0x2f6b22, roughness: 0.95, bumpMap: bumpTex, bumpScale: 0.02 });
    const apron = new THREE.Mesh(apronGeo, apronMat);
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = -0.005;
    apron.receiveShadow = true;
    this.group.add(apron);

    // Concrete ring around the apron
    const ringGeo = new THREE.PlaneGeometry(apronW + 24, apronL + 24);
    const ringMat = new THREE.MeshStandardMaterial({ color: 0x4a4f58, roughness: 0.9 });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -0.01;
    ring.receiveShadow = true;
    this.group.add(ring);

    this.buildBoards();
  }

  /** Low arcade rebound boards with advertising faces. */
  buildBoards() {
    const { HALF_LENGTH, HALF_WIDTH, BOARD_MARGIN, BOARD_HEIGHT, GOAL_WIDTH } = PITCH;
    const bx = HALF_WIDTH + BOARD_MARGIN;
    const bz = HALF_LENGTH + BOARD_MARGIN;
    const ads = ['ARENA SEVEN', 'FUTSAL LEAGUE', 'HYPERBOOT', 'VOLT ENERGY', 'PITCHSIDE TV', 'NORTH STAND', 'STRIKE ZONE', 'SEVEN-A-SIDE'];
    const palette = ['#1f5fe6', '#e0242f', '#b8ff3b', '#ffc93b', '#ffffff', '#00c2d6', '#ff7a1f', '#8a2be2'];

    const makeAdTexture = (text, bg, fg, w = 1024, h = 128) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d');
      g.fillStyle = bg; g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(0,0,0,0.15)'; g.fillRect(0, h - 10, w, 10);
      g.font = `900 ${h * 0.62}px "Barlow Condensed", Impact, Arial Narrow, sans-serif`;
      g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(text, w / 2, h / 2 + 4);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
      return t;
    };

    const boardMat = new THREE.MeshStandardMaterial({ color: 0x1a1d26, roughness: 0.6, metalness: 0.2 });
    const segmentLen = 8;
    let adIndex = 0;
    const addSide = (length, center, rotY, inwardSign) => {
      const count = Math.ceil(length / segmentLen);
      const actual = length / count;
      for (let i = 0; i < count; i++) {
        const offset = -length / 2 + actual * (i + 0.5);
        const group = new THREE.Group();
        const body = new THREE.Mesh(new THREE.BoxGeometry(actual - 0.05, BOARD_HEIGHT, 0.25), boardMat);
        body.position.y = BOARD_HEIGHT / 2;
        body.castShadow = false; body.receiveShadow = true;
        group.add(body);
        const bg = palette[adIndex % palette.length];
        const fg = (bg === '#ffffff' || bg === '#b8ff3b' || bg === '#ffc93b') ? '#0b1020' : '#ffffff';
        const tex = makeAdTexture(ads[adIndex % ads.length], bg, fg);
        adIndex++;
        const face = new THREE.Mesh(new THREE.PlaneGeometry(actual - 0.15, BOARD_HEIGHT - 0.12), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.25 }));
        face.position.set(0, BOARD_HEIGHT / 2, -0.13 * inwardSign);
        if (inwardSign < 0) face.rotation.y = Math.PI;
        group.add(face);
        group.position.copy(center);
        group.rotation.y = rotY;
        group.translateX(offset);
        this.group.add(group);
      }
    };
    // Sides along z (left/right touchline boards)
    addSide(bz * 2, new THREE.Vector3(-bx, 0, 0), Math.PI / 2, -1);
    addSide(bz * 2, new THREE.Vector3(bx, 0, 0), -Math.PI / 2, -1);
    // Ends along x (behind goals), leave a gap near the goal so the net is visible
    const endLen = (bx * 2 - GOAL_WIDTH - 5) / 2;
    const endCenterX = GOAL_WIDTH / 2 + 2.5 + endLen / 2;
    addSide(endLen, new THREE.Vector3(-endCenterX, 0, -bz), 0, 1);
    addSide(endLen, new THREE.Vector3(endCenterX, 0, -bz), 0, 1);
    addSide(endLen, new THREE.Vector3(-endCenterX, 0, bz), Math.PI, 1);
    addSide(endLen, new THREE.Vector3(endCenterX, 0, bz), Math.PI, 1);
    // Short boards next to goals (behind the goal net)
    const backZ = bz + 0.0;
    [-1, 1].forEach((s) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(GOAL_WIDTH + 5, BOARD_HEIGHT * 0.9, 0.25), boardMat);
      b.position.set(0, BOARD_HEIGHT * 0.45, s * (backZ + 1.2));
      this.group.add(b);
    });
  }
}
