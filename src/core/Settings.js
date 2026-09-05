const STORAGE_KEY = 'arena7.settings.v1';

export const DEFAULT_SETTINGS = {
  masterVolume: 0.8,
  musicVolume: 0.5,
  effectsVolume: 0.9,
  mouseSensitivity: 1.0,
  graphicsQuality: 'HIGH',     // LOW | MEDIUM | HIGH
  shadowQuality: 'MEDIUM',     // OFF | LOW | MEDIUM | HIGH
  cameraShake: true,
  fullscreen: false,
  difficulty: 'NORMAL',        // EASY | NORMAL | HARD
  matchDuration: 300,
  invertY: false,
  showControls: true,
  shiftLockDefault: false,
  // Mobile / touch controls
  touchSensitivity: 1.0,
  joystickSize: 1.0,
  buttonSize: 1.0,
  controlOpacity: 0.75,
  leftHanded: false,
  haptics: true,
  touchTutorialSeen: false,
  qualityAutoSet: false
};

export const DEFAULT_PROFILE = {
  playerName: 'YOU',
  shirtNumber: 10,
  shirtColor: 0x1f5fe6,
  shortsColor: 0xf5f7ff,
  skinTone: 0xd9a37b,
  hairStyle: 1,
  hairColor: 0x2a1a10
};

export const DEFAULT_STATS = {
  matches: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0,
  playerGoals: 0, tackles: 0, jukes: 0, shots: 0
};

/**
 * Persistent settings / profile / stats backed by localStorage.
 * Listeners are notified when a setting changes so live systems (audio, renderer, camera) can react.
 */
export class Settings {
  constructor() {
    this.values = { ...DEFAULT_SETTINGS };
    this.profile = { ...DEFAULT_PROFILE };
    this.stats = { ...DEFAULT_STATS };
    this.listeners = new Set();
    this.load();
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        Object.assign(this.values, data.settings || {});
        Object.assign(this.profile, data.profile || {});
        Object.assign(this.stats, data.stats || {});
      }
    } catch (e) {
      console.warn('[Settings] failed to load, using defaults', e);
    }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings: this.values, profile: this.profile, stats: this.stats }));
    } catch (e) {
      console.warn('[Settings] failed to save', e);
    }
  }

  get(key) { return this.values[key]; }

  set(key, value) {
    if (this.values[key] === value) return;
    this.values[key] = value;
    this.save();
    for (const l of this.listeners) l(key, value, this.values);
  }

  setProfile(patch) { Object.assign(this.profile, patch); this.save(); }
  addStats(patch) { for (const k in patch) this.stats[k] = (this.stats[k] || 0) + patch[k]; this.save(); }
  resetStats() { this.stats = { ...DEFAULT_STATS }; this.save(); }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}
