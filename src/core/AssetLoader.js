import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ASSET_MANIFEST } from '../assets/AssetManifest.js';

/**
 * Loads optional GLB models, animation clips and textures listed in the AssetManifest.
 * Anything missing resolves to null so callers can fall back to procedural content.
 */
export class AssetLoader {
  constructor() {
    this.gltfLoader = new GLTFLoader();
    this.textureLoader = new THREE.TextureLoader();
    this.models = new Map();      // name -> gltf scene (template)
    this.animations = new Map();  // name -> AnimationClip
    this.textures = new Map();
    this.progress = 0;
    this.onProgress = null;
  }

  async exists(url) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      const type = res.headers.get('content-type') || '';
      return res.ok && !type.includes('text/html');
    } catch (_) { return false; }
  }

  loadGLTF(url) {
    return new Promise((resolve, reject) => this.gltfLoader.load(url, resolve, undefined, reject));
  }

  async loadAll() {
    const tasks = [];
    const modelEntries = Object.entries(ASSET_MANIFEST.models);
    const animEntries = Object.entries(ASSET_MANIFEST.animations);
    const texEntries = Object.entries(ASSET_MANIFEST.textures);
    const total = modelEntries.length + animEntries.length + texEntries.length;
    let done = 0;
    const tick = () => { done++; this.progress = done / total; if (this.onProgress) this.onProgress(this.progress); };

    for (const [name, url] of modelEntries) {
      tasks.push((async () => {
        if (await this.exists(url)) {
          try {
            const gltf = await this.loadGLTF(url);
            this.models.set(name, gltf);
            // Clips baked into the character file take priority over separate files.
            for (const clip of gltf.animations || []) {
              const key = this.normaliseClipName(clip.name);
              if (key && !this.animations.has(key)) this.animations.set(key, clip);
            }
            console.info(`[Assets] loaded model "${name}" from ${url}`);
          } catch (e) { console.warn(`[Assets] failed to load ${url}`, e); }
        }
        tick();
      })());
    }
    for (const [name, url] of animEntries) {
      tasks.push((async () => {
        if (await this.exists(url)) {
          try {
            const gltf = await this.loadGLTF(url);
            const clip = gltf.animations && gltf.animations[0];
            if (clip) { clip.name = name; this.animations.set(name, clip); }
          } catch (e) { console.warn(`[Assets] failed to load ${url}`, e); }
        }
        tick();
      })());
    }
    for (const [name, url] of texEntries) {
      tasks.push((async () => {
        if (await this.exists(url)) {
          try {
            const tex = await this.textureLoader.loadAsync(url);
            tex.colorSpace = THREE.SRGBColorSpace;
            this.textures.set(name, tex);
          } catch (e) { /* ignore */ }
        }
        tick();
      })());
    }
    await Promise.all(tasks);
    return this;
  }

  normaliseClipName(name) {
    const n = name.toLowerCase().replace(/[^a-z]/g, '');
    for (const key of Object.keys(ASSET_MANIFEST.animations)) {
      if (n === key.toLowerCase()) return key;
    }
    const aliases = { running: 'jog', run: 'jog', walking: 'walk', standing: 'idle', kick: 'hardKick', pass: 'lowKick', slide: 'slideTackle', tackle: 'slideTackle' };
    return aliases[n] || null;
  }

  hasPlayerModel() { return this.models.has('player'); }
  getModel(name) { return this.models.get(name) || null; }
  getAnimation(name) { return this.animations.get(name) || null; }
  getTexture(name) { return this.textures.get(name) || null; }
}
