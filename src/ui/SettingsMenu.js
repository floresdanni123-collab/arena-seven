/**
 * Settings panel. Every control writes straight to Settings (persisted to localStorage) and live
 * systems react via Settings.onChange.
 */
export class SettingsMenu {
  constructor(root, settings, { onClose, audio }) {
    this.settings = settings;
    this.audio = audio;
    this.el = document.createElement('div');
    this.el.className = 'screen panel-screen hidden';
    this.el.innerHTML = `
      <div class="panel">
        <h2>Settings<small>Saved automatically</small></h2>
        <div data-rows></div>
        <div class="panel-actions"><button class="btn" data-action="reset">Reset stats</button><button class="btn accent" data-action="close">Back</button></div>
      </div>`;
    root.appendChild(this.el);
    this.rows = this.el.querySelector('[data-rows]');
    this.build();
    this.el.querySelector('[data-action="close"]').addEventListener('click', () => { audio.play('click'); onClose(); });
    this.el.querySelector('[data-action="reset"]').addEventListener('click', () => { audio.play('click'); settings.resetStats(); });
  }

  slider(label, key, min, max, step, fmt = (v) => Math.round(v * 100) + '%') {
    const row = document.createElement('div');
    row.className = 'setting-row';
    row.innerHTML = `<label>${label}</label><input type="range" min="${min}" max="${max}" step="${step}" value="${this.settings.get(key)}"><div class="value">${fmt(this.settings.get(key))}</div>`;
    const input = row.querySelector('input'), value = row.querySelector('.value');
    input.addEventListener('input', () => { const v = parseFloat(input.value); this.settings.set(key, v); value.textContent = fmt(v); });
    input.addEventListener('change', () => this.audio.play('click', { volume: 0.4 }));
    this.rows.appendChild(row);
    return row;
  }

  segmented(label, key, options, fmt = (o) => o) {
    const row = document.createElement('div');
    row.className = 'setting-row';
    row.innerHTML = `<label>${label}</label><div class="seg"></div><div class="value"></div>`;
    const seg = row.querySelector('.seg');
    const refresh = () => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === String(this.settings.get(key))));
    for (const o of options) {
      const b = document.createElement('button');
      b.dataset.v = String(o); b.textContent = fmt(o);
      b.addEventListener('click', () => { this.audio.play('click', { volume: 0.4 }); this.settings.set(key, o); refresh(); });
      seg.appendChild(b);
    }
    refresh();
    this.rows.appendChild(row);
    this.refreshers = this.refreshers || []; this.refreshers.push(refresh);
  }

  toggle(label, key, onToggle) {
    const row = document.createElement('div');
    row.className = 'setting-row';
    row.innerHTML = `<label>${label}</label><div></div><div class="toggle ${this.settings.get(key) ? 'on' : ''}"></div>`;
    const t = row.querySelector('.toggle');
    t.addEventListener('click', () => {
      const v = !this.settings.get(key);
      this.settings.set(key, v);
      t.classList.toggle('on', v);
      this.audio.play('click', { volume: 0.4 });
      if (onToggle) onToggle(v);
    });
    this.rows.appendChild(row);
    this.refreshers = this.refreshers || []; this.refreshers.push(() => t.classList.toggle('on', !!this.settings.get(key)));
  }

  build() {
    this.slider('Master volume', 'masterVolume', 0, 1, 0.01);
    this.slider('Music volume', 'musicVolume', 0, 1, 0.01);
    this.slider('Effects volume', 'effectsVolume', 0, 1, 0.01);
    this.slider('Mouse sensitivity', 'mouseSensitivity', 0.2, 3, 0.05, (v) => v.toFixed(2) + 'x');
    this.toggle('Invert Y', 'invertY');
    this.segmented('Graphics quality', 'graphicsQuality', ['LOW', 'MEDIUM', 'HIGH']);
    this.segmented('Shadow quality', 'shadowQuality', ['OFF', 'LOW', 'MEDIUM', 'HIGH']);
    this.toggle('Camera shake', 'cameraShake');
    this.toggle('Fullscreen', 'fullscreen', (v) => {
      if (v) document.documentElement.requestFullscreen?.().catch(() => {});
      else if (document.fullscreenElement) document.exitFullscreen?.();
    });
    this.segmented('AI difficulty', 'difficulty', ['EASY', 'NORMAL', 'HARD']);
    this.segmented('Match length', 'matchDuration', [120, 300, 480], (v) => `${v / 60} MIN`);
    this.toggle('Show controls in HUD', 'showControls');
    this.toggle('Shift lock default (C toggles in play)', 'shiftLockDefault');
    const head = document.createElement('div');
    head.className = 'setting-head';
    head.textContent = 'MOBILE CONTROLS';
    this.rows.appendChild(head);
    this.slider('Touch camera sensitivity', 'touchSensitivity', 0.3, 3, 0.05, (v) => v.toFixed(2) + 'x');
    this.slider('Joystick size', 'joystickSize', 0.7, 1.5, 0.05, (v) => Math.round(v * 100) + '%');
    this.slider('Button size', 'buttonSize', 0.7, 1.5, 0.05, (v) => Math.round(v * 100) + '%');
    this.slider('Control opacity', 'controlOpacity', 0.3, 1, 0.05);
    this.toggle('Left-handed layout', 'leftHanded');
    this.toggle('Haptics (vibration)', 'haptics');
  }

  show() { (this.refreshers || []).forEach((f) => f()); this.el.classList.remove('hidden'); }
  hide() { this.el.classList.add('hidden'); }
}
