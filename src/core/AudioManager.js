import { ASSET_MANIFEST } from '../assets/AssetManifest.js';
import { clamp, rand } from '../utils/MathUtils.js';

/**
 * Web Audio based sound manager.
 *
 * Every sound is referenced by a logical name (kick, pass, tackle, whistle...). If an audio file for
 * that name exists in /public/assets/audio (see AssetManifest.audio) it is decoded and used. If the
 * file is missing the manager falls back to a procedurally synthesised version so the game always
 * has audible feedback. Drop real files into the assets folder to replace them - no code changes.
 */
export class AudioManager {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.buffers = new Map();
    this.loops = new Map();
    this.unlocked = false;
    this.masterGain = null;
    this.musicGain = null;
    this.sfxGain = null;
    this.ambienceGain = null;
    this._noiseBuffer = null;

    settings.onChange((key) => {
      if (key.endsWith('Volume')) this.applyVolumes();
    });

    const unlock = () => this.unlock();
    window.addEventListener('pointerdown', unlock, { once: false });
    window.addEventListener('keydown', unlock, { once: false });
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.masterGain = this.ctx.createGain();
      this.musicGain = this.ctx.createGain();
      this.sfxGain = this.ctx.createGain();
      this.ambienceGain = this.ctx.createGain();
      this.musicGain.connect(this.masterGain);
      this.sfxGain.connect(this.masterGain);
      this.ambienceGain.connect(this.masterGain);
      this.masterGain.connect(this.ctx.destination);
      this.applyVolumes();
      this.loadAll();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.unlocked = true;
  }

  applyVolumes() {
    if (!this.ctx) return;
    const s = this.settings.values;
    this.masterGain.gain.value = s.masterVolume;
    this.musicGain.gain.value = s.musicVolume;
    this.sfxGain.gain.value = s.effectsVolume;
    this.ambienceGain.gain.value = s.effectsVolume;
  }

  async loadAll() {
    const entries = Object.entries(ASSET_MANIFEST.audio);
    await Promise.all(entries.map(async ([name, url]) => {
      try {
        const res = await fetch(url, { method: 'GET' });
        const type = res.headers.get('content-type') || '';
        if (!res.ok || type.includes('text/html')) return; // missing -> synth fallback
        const data = await res.arrayBuffer();
        const buf = await this.ctx.decodeAudioData(data);
        this.buffers.set(name, buf);
      } catch (e) { /* fallback to synthesis */ }
    }));
  }

  get noiseBuffer() {
    if (!this._noiseBuffer) {
      const len = this.ctx.sampleRate * 2;
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this._noiseBuffer = buf;
    }
    return this._noiseBuffer;
  }

  /** Play a one-shot sound. volume 0..1, pitch multiplier. */
  play(name, { volume = 1, pitch = 1 } = {}) {
    if (!this.ctx || !this.unlocked) return;
    const buffer = this.buffers.get(name);
    if (buffer) {
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = pitch;
      const g = this.ctx.createGain();
      g.gain.value = volume;
      src.connect(g).connect(this.sfxGain);
      src.start();
      return;
    }
    this.synth(name, volume, pitch);
  }

  /** Procedural stand-ins so every event is audible before real assets are dropped in. */
  synth(name, volume, pitch) {
    const c = this.ctx, t = c.currentTime;
    const out = this.sfxGain;
    const tone = (freq, dur, type = 'sine', vol = 0.5, decay = true, delay = 0) => {
      const o = c.createOscillator(); const g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(freq * pitch, t + delay);
      g.gain.setValueAtTime(0.0001, t + delay);
      g.gain.exponentialRampToValueAtTime(vol * volume, t + delay + 0.01);
      if (decay) g.gain.exponentialRampToValueAtTime(0.0001, t + delay + dur);
      o.connect(g).connect(out); o.start(t + delay); o.stop(t + delay + dur + 0.05);
      return o;
    };
    const noise = (dur, vol, filterFreq = 1200, q = 0.7, delay = 0, type = 'lowpass') => {
      const src = c.createBufferSource(); src.buffer = this.noiseBuffer;
      const f = c.createBiquadFilter(); f.type = type; f.frequency.value = filterFreq; f.Q.value = q;
      const g = c.createGain();
      g.gain.setValueAtTime(vol * volume, t + delay);
      g.gain.exponentialRampToValueAtTime(0.0001, t + delay + dur);
      src.connect(f).connect(g).connect(out); src.start(t + delay); src.stop(t + delay + dur + 0.05);
    };
    switch (name) {
      case 'kick': {
        const o = tone(150, 0.18, 'sine', 0.9);
        o.frequency.exponentialRampToValueAtTime(45 * pitch, t + 0.15);
        noise(0.12, 0.5, 900, 0.8);
        break;
      }
      case 'pass': {
        const o = tone(190, 0.12, 'sine', 0.55);
        o.frequency.exponentialRampToValueAtTime(70 * pitch, t + 0.1);
        noise(0.08, 0.3, 1400, 0.8);
        break;
      }
      case 'tackle': {
        const o = tone(90, 0.25, 'triangle', 0.8);
        o.frequency.exponentialRampToValueAtTime(35, t + 0.2);
        noise(0.22, 0.6, 500, 0.6);
        break;
      }
      case 'slide': noise(0.45, 0.35, 2200, 0.5); break;
      case 'juke': noise(0.18, 0.3, 3000, 1.2); tone(520, 0.12, 'sine', 0.15); break;
      case 'post': { const o = tone(880, 0.6, 'square', 0.25); o.frequency.exponentialRampToValueAtTime(600, t + 0.5); tone(1320, 0.4, 'sine', 0.15); break; }
      case 'bounce': noise(0.06, 0.25, 800); break;
      case 'whistle': {
        const o = tone(2400, 0.45, 'square', 0.18, false); o.stop(t + 0.5);
        const o2 = tone(2450, 0.45, 'sine', 0.12, false); o2.stop(t + 0.5);
        const lfo = c.createOscillator(); const lg = c.createGain(); lfo.frequency.value = 28; lg.gain.value = 120;
        lfo.connect(lg).connect(o.frequency); lfo.start(t); lfo.stop(t + 0.5);
        break;
      }
      case 'whistle_long': {
        for (let i = 0; i < 3; i++) {
          const o = tone(2400, 0.3, 'square', 0.16, false, i * 0.38); o.stop(t + i * 0.38 + 0.33);
        }
        break;
      }
      case 'goal': {
        noise(2.8, 0.7, 1200, 0.4, 0, 'bandpass');
        noise(2.0, 0.5, 500, 0.5, 0.05);
        tone(523, 0.6, 'triangle', 0.25, true, 0.0); tone(659, 0.6, 'triangle', 0.25, true, 0.15); tone(784, 0.9, 'triangle', 0.3, true, 0.3);
        break;
      }
      case 'save': tone(200, 0.2, 'sine', 0.5); noise(0.3, 0.45, 700); noise(1.2, 0.35, 1000, 0.5, 0.1, 'bandpass'); break;
      case 'crowd_ooh': noise(1.0, 0.35, 700, 0.6, 0, 'bandpass'); break;
      case 'hover': tone(1400, 0.06, 'sine', 0.12); break;
      case 'click': tone(900, 0.08, 'square', 0.12); tone(1800, 0.05, 'sine', 0.1); break;
      case 'ready': tone(660, 0.1, 'sine', 0.2); tone(990, 0.16, 'sine', 0.2, true, 0.08); break;
      case 'stun': tone(120, 0.3, 'sawtooth', 0.3); break;
      case 'catch': tone(130, 0.15, 'sine', 0.6); noise(0.1, 0.4, 600); break;
      default: tone(440, 0.1, 'sine', 0.2);
    }
  }

  /** Continuous ambience (crowd). Uses a file if present, otherwise filtered noise. */
  startAmbience(name = 'crowd', volume = 0.35) {
    if (!this.ctx || this.loops.has(name)) return;
    const buffer = this.buffers.get(name);
    const g = this.ctx.createGain();
    g.gain.value = 0;
    g.gain.linearRampToValueAtTime(volume, this.ctx.currentTime + 2);
    let src;
    if (buffer) {
      src = this.ctx.createBufferSource(); src.buffer = buffer; src.loop = true;
      src.connect(g).connect(this.ambienceGain);
    } else {
      src = this.ctx.createBufferSource(); src.buffer = this.noiseBuffer; src.loop = true;
      const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 420; f.Q.value = 0.35;
      const f2 = this.ctx.createBiquadFilter(); f2.type = 'lowpass'; f2.frequency.value = 1500;
      const lfo = this.ctx.createOscillator(); const lg = this.ctx.createGain();
      lfo.frequency.value = 0.13; lg.gain.value = 0.35; lfo.connect(lg).connect(g.gain); lfo.start();
      src.connect(f).connect(f2).connect(g).connect(this.ambienceGain);
      this.loops.set(name + '_lfo', { src: lfo });
    }
    src.start();
    this.loops.set(name, { src, gain: g });
  }

  setAmbienceLevel(name, volume, ramp = 0.5) {
    const l = this.loops.get(name);
    if (!l || !this.ctx) return;
    l.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    l.gain.gain.linearRampToValueAtTime(volume, this.ctx.currentTime + ramp);
  }

  stopAmbience(name = 'crowd') {
    const l = this.loops.get(name);
    if (!l) return;
    try { l.gain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.8); l.src.stop(this.ctx.currentTime + 0.9); } catch (_) { /* */ }
    this.loops.delete(name);
    const lfo = this.loops.get(name + '_lfo');
    if (lfo) { try { lfo.src.stop(this.ctx.currentTime + 0.9); } catch (_) { /* */ } this.loops.delete(name + '_lfo'); }
  }

  /** Menu music: a file if present, otherwise a soft synthesized pad loop. */
  startMusic() {
    if (!this.ctx || this.loops.has('music')) return;
    const buffer = this.buffers.get('music');
    const g = this.ctx.createGain(); g.gain.value = 0; g.gain.linearRampToValueAtTime(0.5, this.ctx.currentTime + 2);
    g.connect(this.musicGain);
    if (buffer) {
      const src = this.ctx.createBufferSource(); src.buffer = buffer; src.loop = true; src.connect(g); src.start();
      this.loops.set('music', { src, gain: g });
      return;
    }
    const chord = [110, 164.81, 220, 261.63, 329.63];
    const oscs = [];
    chord.forEach((f, i) => {
      const o = this.ctx.createOscillator(); o.type = i % 2 ? 'triangle' : 'sine'; o.frequency.value = f;
      const og = this.ctx.createGain(); og.gain.value = 0.06;
      const lfo = this.ctx.createOscillator(); const lg = this.ctx.createGain();
      lfo.frequency.value = 0.05 + i * 0.033; lg.gain.value = 0.04; lfo.connect(lg).connect(og.gain); lfo.start();
      o.connect(og).connect(g); o.start(); oscs.push(o, lfo);
    });
    this.loops.set('music', { src: { stop: (when) => oscs.forEach(o => o.stop(when)) }, gain: g });
  }

  stopMusic() { this.stopAmbience('music'); }
  randomPitch(spread = 0.12) { return rand(1 - spread, 1 + spread); }
}
