import { TACKLE, JUKE } from '../utils/Constants.js';
import { DeviceInfo } from '../core/DeviceInfo.js';

/** Pointer capture keeps a drag on its element even when the finger leaves it; tolerate stale ids. */
const capture = (el, id) => { try { if (el.setPointerCapture) el.setPointerCapture(id); } catch (_) { /* not an active pointer */ } };

const ICONS = {
  pause: '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><path d="M4 7h11l5 5-5 5H4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="9" cy="12" r="2"/></svg>',
  switch: '<svg viewBox="0 0 24 24"><path d="M7 7h10l-3-3M17 17H7l3 3" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  rotate: '<svg viewBox="0 0 64 64"><rect x="20" y="8" width="24" height="48" rx="4" fill="none" stroke="currentColor" stroke-width="3"/><path d="M50 22a18 18 0 0 1 6 14M14 42a18 18 0 0 1-6-14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M56 30l-4 6-6-3M8 34l4-6 6 3" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};

/** Button labels per control context. null hides the button. */
const LABELS = {
  OUTFIELD:        { pass: 'PASS', shoot: 'SHOOT', tackle: 'TACKLE', juke: 'JUKE' },
  GOALKEEPER:      { pass: 'CATCH', shoot: 'DIVE', tackle: 'RUSH', juke: 'SHUFFLE' },
  GOALKEEPER_BALL: { pass: 'THROW', shoot: 'KICK', tackle: null, juke: null },
  SETPIECE:        { pass: 'PASS', shoot: 'SHOOT', tackle: null, juke: null },
  THROWIN:         { pass: 'THROW', shoot: 'LONG', tackle: null, juke: null },
  PENALTY:         { pass: 'PLACED', shoot: 'POWER', tackle: null, juke: null },
  HOLD:            { pass: null, shoot: null, tackle: null, juke: null }
};
const HINTS = {
  SETPIECE: 'DRAG TO AIM · HOLD PASS FOR A DRIVEN KICK · SHOOT FOR POWER',
  THROWIN: 'DRAG TO AIM · HOLD THROW FOR DISTANCE',
  PENALTY: 'DRAG TO AIM · PLACED OR POWER SHOT',
  GOALKEEPER_PENALTY: 'STICK LEFT / RIGHT + DIVE'
};

/**
 * Touch control layer: analogue joystick, sprint, camera-drag zone, contextual action cluster,
 * pause and replay-skip buttons, rotate-device overlay and first-run tutorial. Every button feeds
 * the same named actions as the keyboard/mouse through the InputManager, so gameplay, set pieces
 * and multiplayer see identical input. Multi-touch is tracked per pointer id.
 */
export class TouchControls {
  constructor(root, input, settings, { onPause, onSkip, onShiftLock } = {}) {
    this.input = input;
    this.settings = settings;
    this.onPause = onPause; this.onSkip = onSkip; this.onShiftLock = onShiftLock;
    this.pointers = new Map();
    this.visible = false;
    this.context = { mode: 'OUTFIELD', replay: false, shiftLock: false, tackleCd: 0, jukeCd: 0 };
    this.stick = { active: false, cx: 0, cy: 0, radius: 60, x: 0, z: 0 };
    this.lastVibrate = 0;

    this.el = document.createElement('div');
    this.el.className = 'touch-layer hidden';
    this.el.innerHTML = `
      <div class="tc-stick-zone" data-zone="stick"></div>
      <div class="tc-cam-zone" data-zone="cam"></div>
      <div class="tc-stick hidden" data-stick><div class="base"></div><div class="knob"></div></div>
      <button class="tc-btn tc-sprint" data-hold="SPRINT"><span>SPRINT</span></button>
      <div class="tc-actions" data-actions>
        <button class="tc-btn tc-shoot primary" data-tap="SHOOT"><span data-label>SHOOT</span></button>
        <button class="tc-btn tc-pass primary" data-hold="PASS"><span data-label>PASS</span><i class="charge" data-charge></i></button>
        <button class="tc-btn tc-tackle medium" data-tap="TACKLE"><span data-label>TACKLE</span><b class="cd" data-cd></b><i class="ring"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" data-ring/></svg></i></button>
        <button class="tc-btn tc-juke medium" data-tap="JUKE"><span data-label>JUKE</span><b class="cd" data-cd></b><i class="ring"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" data-ring/></svg></i></button>
        <button class="tc-btn tc-switch small" data-tap="SWITCH_CYCLE">${ICONS.switch}<span>SWITCH</span></button>
        <button class="tc-btn tc-lock small" data-tap="SHIFT_LOCK">${ICONS.lock}<span>LOCK</span></button>
      </div>
      <button class="tc-btn tc-pause" data-pause aria-label="Pause">${ICONS.pause}</button>
      <button class="tc-btn tc-skip hidden" data-skip><span>SKIP REPLAY</span></button>
      <div class="tc-hint hidden" data-hint></div>
      <div class="tc-rotate hidden" data-rotate>${ICONS.rotate}<div class="t">ROTATE YOUR DEVICE</div><div class="s">ARENA SEVEN PLAYS IN LANDSCAPE</div></div>
    `;
    root.appendChild(this.el);
    this.q = (s) => this.el.querySelector(s);
    this.stickEl = this.q('[data-stick]');
    this.knob = this.stickEl.querySelector('.knob');
    this.buttons = { shoot: this.q('.tc-shoot'), pass: this.q('.tc-pass'), tackle: this.q('.tc-tackle'), juke: this.q('.tc-juke'), switch: this.q('.tc-switch'), lock: this.q('.tc-lock'), sprint: this.q('.tc-sprint') };
    this.chargeEl = this.q('[data-charge]');
    this.hintEl = this.q('[data-hint]');
    this.rotateEl = this.q('[data-rotate]');
    this.skipEl = this.q('[data-skip]');
    this.bind();
    this.applySettings();
    settings.onChange((k) => { if (['joystickSize', 'buttonSize', 'controlOpacity', 'leftHanded', 'touchSensitivity'].includes(k)) this.applySettings(); });
    this._onResize = () => this.updateOrientation();
    window.addEventListener('resize', this._onResize);
    if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', this._onResize);
  }

  /* ------------------------------------------------------------ settings / layout */

  applySettings() {
    const s = this.settings.values;
    this.el.style.setProperty('--tc-stick', s.joystickSize);
    this.el.style.setProperty('--tc-btn', s.buttonSize);
    this.el.style.setProperty('--tc-opacity', s.controlOpacity);
    this.el.classList.toggle('left-handed', !!s.leftHanded);
    this.stick.radius = 62 * s.joystickSize;
  }

  setVisible(v) {
    this.visible = v;
    this.el.classList.toggle('hidden', !v);
    if (!v) this.releaseAll();
    this.updateOrientation();
  }

  updateOrientation() {
    const show = this.visible && this.input.mode === 'touch' && DeviceInfo.isPortrait;
    this.rotateEl.classList.toggle('hidden', !show);
  }

  /* ------------------------------------------------------------ pointer handling */

  bind() {
    const el = this.el;
    const prevent = (e) => { if (e.cancelable) e.preventDefault(); };
    el.addEventListener('touchstart', prevent, { passive: false });
    el.addEventListener('touchmove', prevent, { passive: false });
    el.addEventListener('contextmenu', prevent);

    // Buttons: pressed feedback + action mapping, each pointer independent.
    for (const btn of el.querySelectorAll('.tc-btn')) {
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (btn.disabled) return;
        capture(btn, e.pointerId);
        btn.classList.add('pressed');
        this.pointers.set(e.pointerId, { kind: 'button', btn });
        this.pressButton(btn);
      });
      const up = (e) => {
        const p = this.pointers.get(e.pointerId);
        if (!p || p.kind !== 'button') return;
        this.pointers.delete(e.pointerId);
        btn.classList.remove('pressed');
        this.releaseButton(btn);
      };
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      btn.addEventListener('lostpointercapture', up);
    }

    // Zones: joystick on one side, camera drag on the other.
    const onZoneDown = (e) => {
      if (e.pointerType === 'mouse' && this.input.mode !== 'touch') return;
      e.preventDefault();
      const zone = e.currentTarget.dataset.zone;
      capture(e.currentTarget, e.pointerId);
      if (zone === 'stick') {
        if ([...this.pointers.values()].some((p) => p.kind === 'stick')) return;
        this.pointers.set(e.pointerId, { kind: 'stick' });
        this.beginStick(e.clientX, e.clientY);
      } else {
        this.pointers.set(e.pointerId, { kind: 'cam', x: e.clientX, y: e.clientY });
      }
      this.input.noteDevice('touch');
    };
    const onZoneMove = (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      if (p.kind === 'stick') this.moveStick(e.clientX, e.clientY);
      else if (p.kind === 'cam') {
        const k = 2.4 * (this.settings.get('touchSensitivity') || 1);
        this.input.addTouchCamera((e.clientX - p.x) * k, (e.clientY - p.y) * k);
        p.x = e.clientX; p.y = e.clientY;
      }
    };
    const onZoneUp = (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      this.pointers.delete(e.pointerId);
      if (p.kind === 'stick') this.endStick();
    };
    for (const zone of el.querySelectorAll('[data-zone]')) {
      zone.addEventListener('pointerdown', onZoneDown);
      zone.addEventListener('pointermove', onZoneMove);
      zone.addEventListener('pointerup', onZoneUp);
      zone.addEventListener('pointercancel', onZoneUp);
      zone.addEventListener('lostpointercapture', onZoneUp);
    }
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); });
  }

  pressButton(btn) {
    const hold = btn.dataset.hold, tap = btn.dataset.tap;
    this.vibrate(tap === 'SHOOT' || tap === 'TACKLE' ? 12 : 6);
    if (btn.dataset.pause !== undefined) { if (this.onPause) this.onPause(); return; }
    if (btn.dataset.skip !== undefined) { if (this.onSkip) this.onSkip(); return; }
    if (hold) { this.input.setTouchHeld(hold, true); return; }
    if (tap) this.input.triggerTouch(tap);
  }

  releaseButton(btn) {
    const hold = btn.dataset.hold;
    if (hold) this.input.setTouchHeld(hold, false);
  }

  /** Safety net: any lost touch (tab switch, gesture, OS overlay) releases everything. */
  releaseAll() {
    for (const [id, p] of this.pointers) {
      if (p.kind === 'button') { p.btn.classList.remove('pressed'); this.releaseButton(p.btn); }
    }
    this.pointers.clear();
    this.endStick();
    this.input.setTouchHeld('PASS', false);
    this.input.setTouchHeld('SPRINT', false);
  }

  /* ------------------------------------------------------------ joystick */

  beginStick(x, y) {
    const r = this.stick.radius;
    const rect = this.el.getBoundingClientRect();
    // Semi-floating: the base anchors where the thumb lands, kept clear of the screen edge.
    this.stick.cx = Math.min(Math.max(x, rect.left + r + 8), rect.right - r - 8);
    this.stick.cy = Math.min(Math.max(y, rect.top + r + 8), rect.bottom - r - 8);
    this.stick.active = true;
    this.stickEl.classList.remove('hidden', 'returning');
    this.stickEl.style.left = `${this.stick.cx - rect.left}px`;
    this.stickEl.style.top = `${this.stick.cy - rect.top}px`;
    this.moveStick(x, y);
  }

  moveStick(x, y) {
    if (!this.stick.active) return;
    const r = this.stick.radius;
    let dx = x - this.stick.cx, dy = y - this.stick.cy;
    const len = Math.hypot(dx, dy);
    const clamped = Math.min(len, r);
    if (len > 0) { dx = dx / len * clamped; dy = dy / len * clamped; }
    this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    // Analogue magnitude with a dead zone, smooth (no 8-way snapping).
    const dead = 0.12;
    const mag = clamped / r;
    const m = mag <= dead ? 0 : (mag - dead) / (1 - dead);
    const nx = len > 0 ? dx / clamped : 0, ny = len > 0 ? dy / clamped : 0;
    this.stick.x = nx * m; this.stick.z = -ny * m; // screen up = forward
    this.input.setTouchAxis(this.stick.x, this.stick.z, true);
  }

  endStick() {
    if (!this.stick.active) return;
    this.stick.active = false;
    this.stick.x = 0; this.stick.z = 0;
    this.input.setTouchAxis(0, 0, false);
    this.knob.style.transform = 'translate(-50%, -50%)';
    this.stickEl.classList.add('returning');
    clearTimeout(this.stickHideTimer);
    this.stickHideTimer = setTimeout(() => { if (!this.stick.active) this.stickEl.classList.add('hidden'); }, 220);
  }

  /* ------------------------------------------------------------ context (labels, cooldowns) */

  setContext(ctx) {
    Object.assign(this.context, ctx);
    const mode = ctx.replay ? 'HOLD' : (this.context.mode || 'OUTFIELD');
    const labels = LABELS[mode] || LABELS.OUTFIELD;
    for (const key of ['pass', 'shoot', 'tackle', 'juke']) {
      const btn = this.buttons[key];
      const label = labels[key];
      btn.classList.toggle('hidden', !label);
      if (label) { const s = btn.querySelector('[data-label]'); if (s.textContent !== label) s.textContent = label; }
    }
    const moveable = mode === 'OUTFIELD' || mode === 'GOALKEEPER' || mode === 'GOALKEEPER_BALL';
    this.buttons.sprint.classList.toggle('hidden', !moveable || !!ctx.replay);
    this.q('[data-zone="stick"]').classList.toggle('disabled', !moveable || !!ctx.replay);
    this.buttons.switch.classList.toggle('hidden', !!ctx.replay || mode === 'PENALTY');
    this.buttons.lock.classList.toggle('hidden', !!ctx.replay);
    this.buttons.lock.classList.toggle('active', !!this.context.shiftLock);
    this.q('[data-pause]').classList.toggle('hidden', !!ctx.replay);
    this.skipEl.classList.toggle('hidden', !ctx.replay);
    const hint = ctx.replay ? null : (mode === 'GOALKEEPER' && ctx.shootout ? HINTS.GOALKEEPER_PENALTY : HINTS[mode]);
    this.hintEl.classList.toggle('hidden', !hint);
    if (hint && this.hintEl.textContent !== hint) this.hintEl.textContent = hint;
  }

  /** Per-frame: cooldown numbers / rings and the pass charge fill. */
  update(match) {
    if (!this.visible || !match || !match.human) return;
    const p = match.human;
    this.setCooldown(this.buttons.tackle, p.isGoalkeeper ? 0 : p.tackleCooldown, TACKLE.COOLDOWN);
    this.setCooldown(this.buttons.juke, p.isGoalkeeper ? 0 : p.jukeCooldown, JUKE.COOLDOWN);
    const charge = p.charging ? p.chargePower : 0;
    this.chargeEl.style.height = `${Math.round(charge * 100)}%`;
    this.buttons.pass.classList.toggle('charging', p.charging);
  }

  setCooldown(btn, cd, max) {
    const cdEl = btn.querySelector('[data-cd]');
    const ring = btn.querySelector('[data-ring]');
    const cooling = cd > 0;
    btn.classList.toggle('cooling', cooling);
    if (cooling) {
      const t = cd.toFixed(1);
      if (cdEl.textContent !== t) cdEl.textContent = t;
      const frac = 1 - cd / max;
      const c = 2 * Math.PI * 16;
      ring.style.strokeDasharray = `${c}`;
      ring.style.strokeDashoffset = `${c * (1 - frac)}`;
    } else if (cdEl.textContent) { cdEl.textContent = ''; ring.style.strokeDashoffset = '0'; }
  }

  /* ------------------------------------------------------------ feedback */

  vibrate(ms) {
    if (!this.settings.get('haptics') || !DeviceInfo.canVibrate || this.input.mode !== 'touch' || !this.visible) return;
    const now = performance.now();
    if (now - this.lastVibrate < 40) return;
    this.lastVibrate = now;
    try { navigator.vibrate(ms); } catch (_) { /* unsupported */ }
  }

  /* ------------------------------------------------------------ tutorial */

  showTutorial(onDone) {
    if (this.tutorialEl) return;
    const t = document.createElement('div');
    t.className = 'tc-tutorial';
    t.innerHTML = `
      <div class="box">
        <div class="head">TOUCH CONTROLS</div>
        <div class="grid">
          <div><b>LEFT STICK</b><span>Move · push further to run</span></div>
          <div><b>DRAG RIGHT SIDE</b><span>Look / aim</span></div>
          <div><b>SPRINT</b><span>Hold while moving</span></div>
          <div><b>PASS</b><span>Tap for a short pass, hold for power</span></div>
          <div><b>SHOOT</b><span>Power shot toward the aim</span></div>
          <div><b>TACKLE</b><span>Slide (10s cooldown)</span></div>
          <div><b>JUKE</b><span>Evade · stick left/right picks the side</span></div>
          <div><b>SWITCH · LOCK</b><span>Change player · shift-lock camera</span></div>
        </div>
        <button class="btn accent" data-done>GOT IT</button>
      </div>`;
    this.el.parentElement.appendChild(t);
    this.tutorialEl = t;
    t.querySelector('[data-done]').addEventListener('click', () => { t.remove(); this.tutorialEl = null; if (onDone) onDone(); });
  }

  dispose() { window.removeEventListener('resize', this._onResize); this.el.remove(); }
}
