import * as THREE from 'three';
import { CHANNEL_COUNT } from './ProceduralHumanoid.js';
import { PROCEDURAL_CLIPS } from './ProceduralClips.js';
import { PLAYER } from '../utils/Constants.js';
import { clamp, damp, rand } from '../utils/MathUtils.js';

/**
 * Speed keys for locomotion blending: idle -> walk -> jog -> sprint.
 * Returns weights [idle, walk, jog, sprint] that sum to 1.
 */
function locomotionWeights(speed) {
  const keys = [0, PLAYER.WALK_SPEED, PLAYER.RUN_SPEED, PLAYER.SPRINT_SPEED];
  const w = [0, 0, 0, 0];
  if (speed <= keys[0] + 0.12) { w[0] = 1; return w; }
  if (speed >= keys[3]) { w[3] = 1; return w; }
  for (let i = 0; i < 3; i++) {
    if (speed >= keys[i] && speed < keys[i + 1]) {
      const t = (speed - keys[i]) / (keys[i + 1] - keys[i]);
      w[i] = 1 - t; w[i + 1] = t;
      return w;
    }
  }
  w[0] = 1; return w;
}

/** Stride length in metres per full gait cycle at a given speed. */
function strideLength(speed) {
  return clamp(0.9 + speed * 0.19, 1.0, 2.7);
}

/* ============================================================== procedural backend */

class ProceduralBackend {
  constructor(humanoid) {
    this.humanoid = humanoid;
    this.locoPose = new Float32Array(CHANNEL_COUNT);
    this.actionPose = new Float32Array(CHANNEL_COUNT);
    this.finalPose = new Float32Array(CHANNEL_COUNT);
    this.scratch = [0, 1, 2, 3, 4, 5].map(() => new Float32Array(CHANNEL_COUNT));
    this.weights = [1, 0, 0, 0];
    this.targetWeights = [1, 0, 0, 0];
    this.dribbleMix = 0;
    this.keeperMix = 0;
    this.phase = rand(0, 1);
    this.time = rand(0, 10);
    this.action = null; // { name, clip, t, weight, fade, duration, params, finished, hold }
    this.actionWeight = 0;
    this.speed = 0;
    this.sprinting = false;
    this.hasBall = false;
    this.isKeeper = false;
  }

  setLocomotion({ speed, sprinting, hasBall, isKeeper }) {
    this.speed = speed; this.sprinting = sprinting; this.hasBall = hasBall; this.isKeeper = isKeeper;
  }

  playAction(name, { fade = 0.1, duration, params = {} } = {}) {
    const clip = PROCEDURAL_CLIPS[name];
    if (!clip) { console.warn('[Anim] unknown procedural clip', name); return false; }
    this.action = { name, clip, t: 0, fade, duration: duration || clip.duration || 1, params, finished: false, hold: !!clip.hold, fadingOut: false };
    return true;
  }

  stopAction(fade = 0.15) {
    if (!this.action) return;
    this.action.fadingOut = true;
    this.action.fadeOutRate = 1 / Math.max(0.01, fade);
  }

  get currentAction() { return this.action; }

  update(dt) {
    this.time += dt;
    // ---- locomotion ----
    const target = locomotionWeights(this.speed);
    for (let i = 0; i < 4; i++) this.weights[i] = damp(this.weights[i], target[i], 12, dt);
    const sum = this.weights[0] + this.weights[1] + this.weights[2] + this.weights[3] || 1;
    const stride = strideLength(this.speed);
    this.phase = (this.phase + (this.speed / stride) * dt) % 1;
    this.dribbleMix = damp(this.dribbleMix, this.hasBall ? 1 : 0, 8, dt);
    this.keeperMix = damp(this.keeperMix, this.isKeeper ? 1 : 0, 8, dt);

    const S = this.scratch;
    const loco = this.locoPose;
    loco.fill(0);
    const idleW = this.weights[0] / sum;
    // idle
    if (idleW > 0.001) {
      if (this.keeperMix < 0.999) { PROCEDURAL_CLIPS.idle.fn(S[0], this.time); this.accumulate(loco, S[0], idleW * (1 - this.keeperMix)); }
      if (this.keeperMix > 0.001) { PROCEDURAL_CLIPS.gkIdle.fn(S[0], this.time); this.accumulate(loco, S[0], idleW * this.keeperMix); }
    }
    // gait blend (walk/jog/sprint), with dribble variant mixed in
    const gaitW = 1 - idleW;
    if (gaitW > 0.001) {
      const wWalk = this.weights[1] / sum, wJog = this.weights[2] / sum, wSprint = this.weights[3] / sum;
      const outfield = 1 - this.keeperMix;
      if (outfield > 0.001) {
        const dm = this.dribbleMix;
        if (wWalk > 0.001) { PROCEDURAL_CLIPS.walk.fn(S[1], this.phase); this.accumulate(loco, S[1], wWalk * outfield); }
        if (wJog > 0.001) {
          PROCEDURAL_CLIPS.jog.fn(S[2], this.phase); this.accumulate(loco, S[2], wJog * outfield * (1 - dm));
          if (dm > 0.001) { PROCEDURAL_CLIPS.dribble.fn(S[3], this.phase); this.accumulate(loco, S[3], wJog * outfield * dm); }
        }
        if (wSprint > 0.001) {
          PROCEDURAL_CLIPS.sprint.fn(S[4], this.phase); this.accumulate(loco, S[4], wSprint * outfield * (1 - dm * 0.5));
          if (dm > 0.001) { PROCEDURAL_CLIPS.dribble.fn(S[3], this.phase); this.accumulate(loco, S[3], wSprint * outfield * dm * 0.5); }
        }
      }
      if (this.keeperMix > 0.001) { PROCEDURAL_CLIPS.gkMove.fn(S[5], this.phase); this.accumulate(loco, S[5], gaitW * this.keeperMix); }
    }

    // ---- action layer ----
    let aw = 0;
    const a = this.action;
    if (a) {
      a.t += dt;
      const fadeIn = clamp(a.t / a.fade, 0, 1);
      if (!a.fadingOut) {
        if (a.t >= a.duration) {
          a.finished = true;
          if (!a.hold) { a.fadingOut = true; a.fadeOutRate = 1 / 0.16; }
        }
      }
      if (a.fadingOut) {
        this.actionWeight = Math.max(0, this.actionWeight - a.fadeOutRate * dt);
        if (this.actionWeight <= 0.0001) { this.action = null; }
      } else {
        this.actionWeight = fadeIn;
      }
      if (this.action) {
        const clipT = Math.min(a.t, a.duration);
        a.clip.fn(this.actionPose, a.clip.mode === 'time' ? a.t : clipT, { ...a.params, duration: a.duration });
      }
    } else {
      this.actionWeight = 0;
    }
    aw = this.action ? this.actionWeight : 0;

    const f = this.finalPose;
    for (let i = 0; i < CHANNEL_COUNT; i++) f[i] = loco[i] * (1 - aw) + this.actionPose[i] * aw;
    this.humanoid.applyPose(f);
  }

  accumulate(dst, src, w) { for (let i = 0; i < CHANNEL_COUNT; i++) dst[i] += src[i] * w; }
  isActionFinished() { return !this.action || this.action.finished; }
  /** Replay support: the final pose is the complete animation state. */
  captureState() { return new Float32Array(this.finalPose); }
  applyState(a, b, t) {
    const f = this.finalPose;
    if (!b) { f.set(a); } else { for (let i = 0; i < CHANNEL_COUNT; i++) f[i] = a[i] + (b[i] - a[i]) * t; }
    this.humanoid.applyPose(f);
  }
  dispose() {}
}

/* ============================================================== GLB / AnimationMixer backend */

const CLIP_ALIASES = {
  sprint: ['sprint', 'jog', 'walk'],
  jog: ['jog', 'sprint', 'walk'],
  walk: ['walk', 'jog'],
  dribble: ['dribble', 'jog'],
  gkIdle: ['gkIdle', 'idle'],
  gkMove: ['gkMove', 'walk', 'jog'],
  gkKick: ['gkKick', 'hardKick', 'lowKick'],
  hardKick: ['hardKick', 'lowKick'],
  lowKick: ['lowKick', 'hardKick'],
  jukeRight: ['jukeRight', 'jukeLeft'],
  jukeLeft: ['jukeLeft', 'jukeRight'],
  gkDiveRight: ['gkDiveRight', 'gkDiveLeft'],
  gkDiveLeft: ['gkDiveLeft', 'gkDiveRight'],
  gkParry: ['gkParry', 'gkCatch'],
  gkPickup: ['gkPickup', 'gkCatch'],
  gkThrow: ['gkThrow', 'gkKick', 'hardKick'],
  recover: ['recover', 'idle'],
  celebrate: ['celebrate', 'idle']
};

class MixerBackend {
  constructor(root, clips) {
    this.mixer = new THREE.AnimationMixer(root);
    this.clips = clips; // Map name -> AnimationClip
    this.actions = new Map();
    this.loco = {};
    const locoNames = ['idle', 'walk', 'jog', 'sprint', 'dribble', 'gkIdle', 'gkMove'];
    for (const n of locoNames) {
      const clip = this.resolve(n);
      if (!clip) continue;
      const act = this.mixer.clipAction(clip);
      act.setLoop(THREE.LoopRepeat, Infinity);
      act.enabled = true; act.setEffectiveWeight(n === 'idle' ? 1 : 0); act.play();
      this.loco[n] = act;
    }
    this.weights = [1, 0, 0, 0];
    this.dribbleMix = 0; this.keeperMix = 0;
    this.speed = 0; this.hasBall = false; this.isKeeper = false;
    this.action = null; this.actionWeight = 0;
    this.mixer.addEventListener('finished', (e) => {
      if (this.action && e.action === this.action.act) {
        this.action.finished = true;
        if (!this.action.hold) this.stopAction(0.16);
      }
    });
  }

  resolve(name) {
    const candidates = CLIP_ALIASES[name] || [name];
    for (const c of candidates) if (this.clips.has(c)) return this.clips.get(c);
    return null;
  }

  setLocomotion({ speed, hasBall, isKeeper }) { this.speed = speed; this.hasBall = hasBall; this.isKeeper = isKeeper; }

  playAction(name, { fade = 0.1, duration, hold } = {}) {
    const clip = this.resolve(name);
    if (!clip) return false;
    if (this.action) { this.action.act.fadeOut(0.05); }
    const act = this.mixer.clipAction(clip);
    act.reset();
    act.setLoop(THREE.LoopOnce, 1);
    act.clampWhenFinished = true;
    act.enabled = true;
    act.timeScale = duration ? clip.duration / duration : 1;
    act.setEffectiveWeight(1);
    act.fadeIn(fade);
    act.play();
    this.action = { name, act, finished: false, hold: hold ?? (name === 'fall' || name === 'gkCatch'), t: 0, fade, duration: duration || clip.duration };
    return true;
  }

  stopAction(fade = 0.15) {
    if (!this.action) return;
    this.action.act.fadeOut(fade);
    const a = this.action;
    setTimeout(() => { if (this.action === a) this.action = null; }, fade * 1000 + 20);
  }

  update(dt) {
    const target = locomotionWeights(this.speed);
    for (let i = 0; i < 4; i++) this.weights[i] = damp(this.weights[i], target[i], 12, dt);
    this.dribbleMix = damp(this.dribbleMix, this.hasBall ? 1 : 0, 8, dt);
    this.keeperMix = damp(this.keeperMix, this.isKeeper ? 1 : 0, 8, dt);
    // action weight: mirror the action's effective weight so locomotion fades under it
    let aw = 0;
    if (this.action) { this.action.t += dt; aw = this.action.act.getEffectiveWeight(); }
    const locoScale = 1 - aw;
    const [wi, ww, wj, ws] = this.weights;
    const out = 1 - this.keeperMix, kp = this.keeperMix;
    const set = (n, w, timeScale = 1) => { const a = this.loco[n]; if (!a) return; a.setEffectiveWeight(w * locoScale); a.timeScale = timeScale; };
    set('idle', wi * out);
    set('gkIdle', wi * kp);
    set('walk', ww * out, clamp(this.speed / PLAYER.WALK_SPEED, 0.6, 1.4));
    set('jog', wj * out * (1 - this.dribbleMix), clamp(this.speed / PLAYER.RUN_SPEED, 0.7, 1.3));
    set('dribble', (wj + ws * 0.5) * out * this.dribbleMix, clamp(this.speed / PLAYER.RUN_SPEED, 0.7, 1.4));
    set('sprint', ws * out * (1 - this.dribbleMix * 0.5), clamp(this.speed / PLAYER.SPRINT_SPEED, 0.8, 1.2));
    set('gkMove', (ww + wj + ws) * kp, clamp(this.speed / PLAYER.WALK_SPEED, 0.7, 1.6));
    this.mixer.update(dt);
  }

  isActionFinished() { return !this.action || this.action.finished; }
  get currentAction() { return this.action; }
  /** Replay support: record locomotion inputs and the running one-shot, re-drive the mixer on playback. */
  captureState() {
    return { speed: this.speed, hasBall: this.hasBall, isKeeper: this.isKeeper, action: this.action ? { name: this.action.name, t: this.action.act.time } : null };
  }
  applyState(a, b, t) {
    const s = b && t > 0.5 ? b : a;
    this.setLocomotion({ speed: s.speed, hasBall: s.hasBall, isKeeper: s.isKeeper });
    if (s.action) {
      const clip = this.resolve(s.action.name);
      if (clip) {
        const act = this.mixer.clipAction(clip);
        if (!this.action || this.action.act !== act) { this.playAction(s.action.name, { fade: 0.01 }); }
        act.time = s.action.t;
      }
    } else if (this.action) { this.stopAction(0.05); }
    this.mixer.update(0.0001);
  }
  dispose() { this.mixer.stopAllAction(); }
}

/* ============================================================== facade */

/**
 * Uniform animation API for a player regardless of whether it is driven by procedural clips or a
 * GLB rig with AnimationMixer. Game code only talks to this class.
 */
export class PlayerAnimationController {
  constructor(model) {
    this.model = model;
    if (model.kind === 'gltf') this.backend = new MixerBackend(model.root, model.clips);
    else this.backend = new ProceduralBackend(model.humanoid);
    this.locomotion = { speed: 0, sprinting: false, hasBall: false, isKeeper: !!model.isGoalkeeper };
  }

  setLocomotion(patch) { Object.assign(this.locomotion, patch); this.backend.setLocomotion(this.locomotion); }
  playAction(name, opts) { return this.backend.playAction(name, opts); }
  stopAction(fade) { this.backend.stopAction(fade); }
  isActionFinished() { return this.backend.isActionFinished(); }
  get currentActionName() { const a = this.backend.currentAction; return a ? a.name : null; }
  captureState() { return this.backend.captureState(); }
  applyState(a, b, t) { this.backend.applyState(a, b, t); }
  update(dt) { this.backend.update(dt); }
  dispose() { this.backend.dispose(); }
}
