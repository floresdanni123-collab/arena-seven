import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

const SHADOW_SIZES = { OFF: 0, LOW: 1024, MEDIUM: 2048, HIGH: 4096 };

/**
 * Owns the WebGL renderer, the scene graph, lighting and optional post-processing.
 * Quality settings can be changed live.
 */
export class SceneManager {
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.settings = settings;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b1224);
    this.scene.fog = new THREE.Fog(0x0b1224, 140, 320);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 600);
    this.camera.position.set(0, 12, -30);
    this.camera.lookAt(0, 0, 0);

    this.setupLights();
    this.composer = null;
    this.bloomPass = null;
    this.applyQuality();
    this.resize();

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    settings.onChange((key) => {
      if (key === 'graphicsQuality' || key === 'shadowQuality') this.applyQuality();
    });
  }

  setupLights() {
    this.hemi = new THREE.HemisphereLight(0x9fb8ff, 0x2a4a1a, 0.55);
    this.scene.add(this.hemi);

    this.ambient = new THREE.AmbientLight(0xffffff, 0.25);
    this.scene.add(this.ambient);

    // Main "floodlight" key light with shadows.
    this.sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
    this.sun.position.set(-40, 70, -30);
    this.sun.castShadow = true;
    this.sun.shadow.camera.left = -48;
    this.sun.shadow.camera.right = 48;
    this.sun.shadow.camera.top = 48;
    this.sun.shadow.camera.bottom = -48;
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 200;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // Fill light from the opposite side, no shadows (keeps cost low).
    this.fill = new THREE.DirectionalLight(0xcfe0ff, 0.7);
    this.fill.position.set(45, 40, 40);
    this.scene.add(this.fill);
  }

  applyQuality() {
    const q = this.settings.get('graphicsQuality');
    const sq = this.settings.get('shadowQuality');
    const dpr = window.devicePixelRatio || 1;
    this.renderer.setPixelRatio(q === 'LOW' ? Math.min(dpr, 1) : q === 'MEDIUM' ? Math.min(dpr, 1.5) : Math.min(dpr, 2));

    const size = SHADOW_SIZES[sq] ?? 2048;
    this.renderer.shadowMap.enabled = size > 0;
    this.sun.castShadow = size > 0;
    if (size > 0) {
      this.sun.shadow.mapSize.set(size, size);
      if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    }
    this.renderer.shadowMap.needsUpdate = true;

    // Post-processing (bloom) only on HIGH.
    if (q === 'HIGH') {
      if (!this.composer) {
        this.composer = new EffectComposer(this.renderer);
        this.composer.addPass(new RenderPass(this.scene, this.camera));
        this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.28, 0.6, 0.86);
        this.composer.addPass(this.bloomPass);
        this.composer.addPass(new OutputPass());
      }
    } else if (this.composer) {
      this.composer.dispose();
      this.composer = null;
      this.bloomPass = null;
    }
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    if (w < 2 || h < 2) { this.sized = false; return; } // hidden / not laid out yet
    this.lastW = w; this.lastH = h;
    this.sized = true;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.composer) this.composer.setSize(w, h);
  }

  render() {
    // Late or missed resize events (e.g. the page was hidden while loading) are caught here.
    if (!this.sized || window.innerWidth !== this.lastW || window.innerHeight !== this.lastH) this.resize();
    if (!this.sized) return;
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  /** Keep the shadow camera centred near a focus point so resolution is spent where it matters. */
  focusShadows(x, z) {
    this.sun.position.set(x - 40, 70, z - 30);
    this.sun.target.position.set(x, 0, z);
    this.sun.target.updateMatrixWorld();
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    if (this.composer) this.composer.dispose();
    this.renderer.dispose();
  }
}

/** Recursively dispose geometries/materials of an object and remove it from its parent. */
export function disposeObject(obj) {
  if (!obj) return;
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        for (const k in m) { const v = m[k]; if (v && v.isTexture) v.dispose(); }
        m.dispose();
      }
    }
  });
  if (obj.parent) obj.parent.remove(obj);
}
