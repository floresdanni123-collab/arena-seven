import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { ProceduralHumanoid } from './ProceduralHumanoid.js';
import { ASSET_MANIFEST } from '../assets/AssetManifest.js';

/**
 * Visual representation of a player. Uses an imported GLB humanoid when one is available in the
 * asset loader, otherwise the multi-part procedural humanoid. Either way it exposes the same API:
 *   root, setColors(), setNumber(), setName(), showName(), kind ('gltf' | 'procedural')
 */
export class PlayerModel {
  constructor({ assets, goalkeeper = false, shirtColor, shortsColor, socksColor, skinTone, hairColor, hairStyle, number = 0, name = '' }) {
    this.isGoalkeeper = goalkeeper;
    this.root = new THREE.Group();
    this.root.name = 'PlayerModel';
    this.colors = { shirt: shirtColor, shorts: shortsColor, socks: socksColor, skin: skinTone, hair: hairColor };
    this.number = number;
    this.name = name;
    this.humanoid = null;
    this.clips = null;
    this.materialsByRole = {};

    const gltf = assets && (goalkeeper ? (assets.getModel('goalkeeper') || assets.getModel('player')) : assets.getModel('player'));
    if (gltf) this.buildFromGLTF(gltf, assets);
    else this.buildProcedural({ shirtColor, shortsColor, socksColor, skinTone, hairColor, hairStyle, number, goalkeeper });

    this.buildNameTag(name, number);
  }

  buildProcedural(opts) {
    this.kind = 'procedural';
    this.humanoid = new ProceduralHumanoid(opts);
    this.root.add(this.humanoid.root);
    this.height = 1.8;
  }

  buildFromGLTF(gltf, assets) {
    this.kind = 'gltf';
    const scene = skeletonClone(gltf.scene);
    const s = ASSET_MANIFEST.rig.scale || 1;
    scene.scale.setScalar(s);
    scene.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = false;
        o.frustumCulled = false;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        o.material = Array.isArray(o.material) ? mats.map((m) => m.clone()) : mats[0].clone();
        const cloned = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of cloned) this.classifyMaterial(m, o.name);
      }
    });
    this.root.add(scene);
    this.gltfScene = scene;
    // Collect clips (from loader map)
    this.clips = new Map();
    for (const key of Object.keys(ASSET_MANIFEST.animations)) {
      const c = assets.getAnimation(key);
      if (c) this.clips.set(key, c);
    }
    const box = new THREE.Box3().setFromObject(scene);
    this.height = box.max.y - box.min.y || 1.8;
    // Ground the model
    scene.position.y -= box.min.y;
    this.setColors(this.colors);
  }

  classifyMaterial(mat, meshName) {
    const n = ((mat.name || '') + ' ' + (meshName || '')).toLowerCase();
    for (const role of Object.keys(ASSET_MANIFEST.materialNames)) {
      if (ASSET_MANIFEST.materialNames[role].some((k) => n.includes(k))) {
        (this.materialsByRole[role] = this.materialsByRole[role] || []).push(mat);
        return;
      }
    }
  }

  setColors({ shirt, shorts, socks, skin, hair, boots } = {}) {
    Object.assign(this.colors, { shirt, shorts, socks, skin, hair });
    if (this.kind === 'procedural') { this.humanoid.setColors({ shirt, shorts, socks, skin, hair, boots }); return; }
    const apply = (role, hex) => { if (hex === undefined) return; for (const m of this.materialsByRole[role] || []) { if (m.color) m.color.setHex(hex); } };
    apply('shirt', shirt); apply('shorts', shorts); apply('socks', socks); apply('skin', skin); apply('hair', hair); apply('boots', boots);
  }

  setNumber(n) {
    this.number = n;
    if (this.kind === 'procedural') this.humanoid.setNumber(n);
    this.updateNameTag();
  }

  setHairStyle(style) { if (this.kind === 'procedural') this.humanoid.setHairStyle(style); }

  buildNameTag(name, number) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 64;
    this.tagCanvas = c;
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    this.tagTexture = tex;
    this.nameTag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
    this.nameTag.scale.set(1.5, 0.375, 1);
    this.nameTag.position.y = (this.height || 1.8) + 0.45;
    this.nameTag.visible = false;
    this.root.add(this.nameTag);
    this.updateNameTag();
  }

  updateNameTag() {
    const g = this.tagCanvas.getContext('2d');
    g.clearRect(0, 0, 256, 64);
    const text = `${this.number ? this.number + '  ' : ''}${this.name || ''}`.trim();
    if (!text) { this.tagTexture.needsUpdate = true; return; }
    g.font = '700 36px "Barlow Condensed", Impact, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.75)'; g.strokeText(text, 128, 32);
    g.fillStyle = '#ffffff'; g.fillText(text, 128, 32);
    this.tagTexture.needsUpdate = true;
  }

  setName(name) { this.name = name; this.updateNameTag(); }
  showName(v) { this.nameTag.visible = v; }

  /** Marker ring under the controlled player. */
  setMarker(color) {
    if (!this.marker) {
      const geo = new THREE.RingGeometry(0.45, 0.6, 32);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false });
      this.marker = new THREE.Mesh(geo, mat);
      this.marker.rotation.x = -Math.PI / 2;
      this.marker.position.y = 0.02;
      this.root.add(this.marker);
    }
    this.marker.visible = color !== null;
    if (color !== null) this.marker.material.color.setHex(color);
  }

  getFootWorldPosition(side, out) {
    if (this.kind === 'procedural') return this.humanoid.getFootWorldPosition(side, out);
    const names = side === 'r' ? ASSET_MANIFEST.rig.rightFoot : ASSET_MANIFEST.rig.leftFoot;
    for (const n of names) { const b = this.gltfScene.getObjectByName(n); if (b) return b.getWorldPosition(out); }
    return this.root.getWorldPosition(out);
  }

  dispose() {
    if (this.humanoid) this.humanoid.dispose();
    if (this.gltfScene) this.gltfScene.traverse((o) => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose()); });
    this.tagTexture.dispose(); this.nameTag.material.dispose();
    if (this.marker) { this.marker.geometry.dispose(); this.marker.material.dispose(); }
    if (this.root.parent) this.root.parent.remove(this.root);
  }
}
