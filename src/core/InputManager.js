/**
 * Unified input: keyboard/mouse and touch both drive the same named gameplay ACTIONS.
 *
 *   MOVE (axis), SPRINT (held), PASS (pressed / held / released -> low kick, catch, throw),
 *   SHOOT (hard kick, keeper dive/kick), TACKLE (slide, keeper rush), JUKE (juke, keeper shuffle),
 *   SWITCH_CYCLE (Tab), SWITCH_NEAREST (Space), SHIFT_LOCK (C), SKIP (replay), PAUSE, RESET_BALL (R)
 *
 * Desktop bindings stay exactly as before; the TouchControls layer feeds the same actions through
 * `triggerTouch` / `setTouchHeld` / `setTouchAxis` / `addTouchCamera`. Gameplay code only ever asks
 * `pressed(action)`, `held(action)`, `released(action)`, `getMoveAxis()` and `consumeMouseDelta()`.
 *
 * `mode` is 'desktop' or 'touch', switched automatically from the most recent input device.
 */
const KEY_ACTIONS = {
  SPRINT: ['ShiftLeft', 'ShiftRight'],
  TACKLE: ['KeyE'],
  JUKE: ['KeyQ'],
  SWITCH_CYCLE: ['Tab'],
  SWITCH_NEAREST: ['Space'],
  SKIP: ['Space'],
  SHIFT_LOCK: ['KeyC'],
  RESET_BALL: ['KeyR']
};
const MOUSE_ACTIONS = { SHOOT: 0, PASS: 2 };

export class InputManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressedKeys = new Set();
    this.releasedKeys = new Set();
    this.mouseButtons = new Set();
    this.mousePressed = new Set();
    this.mouseReleased = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.pointerLocked = false;
    this.enabled = true;
    this.wantsPointerLock = false;
    this.onPointerLockChange = null;
    this.onEscape = null;

    // Touch action layer
    this.touch = { axis: { x: 0, z: 0 }, active: false, camDX: 0, camDY: 0 };
    this.touchPressed = new Set();
    this.touchReleased = new Set();
    this.touchHeld = new Set();
    this.mode = 'desktop';
    this.modeListeners = new Set();
    this.lastTouchInputAt = 0;

    this._onKeyDown = (e) => {
      if (e.repeat) return;
      const code = e.code;
      if (code === 'Escape') { if (this.onEscape) this.onEscape(); return; }
      if (!this.enabled) return;
      this.keys.add(code);
      this.pressedKeys.add(code);
      if (['Space', 'Tab', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(code)) e.preventDefault();
      this.noteDevice('desktop');
    };
    this._onKeyUp = (e) => { this.keys.delete(e.code); this.releasedKeys.add(e.code); };
    this._onMouseDown = (e) => {
      if (!this.enabled) return;
      if (e.target !== this.canvas) return;
      if (this.mode === 'touch') return; // touch layer handles taps on the canvas
      if (this.wantsPointerLock && !this.pointerLocked) { this.requestPointerLock(); return; }
      this.mouseButtons.add(e.button);
      this.mousePressed.add(e.button);
      e.preventDefault();
    };
    this._onMouseUp = (e) => {
      if (this.mouseButtons.has(e.button)) { this.mouseButtons.delete(e.button); this.mouseReleased.add(e.button); }
    };
    this._onMouseMove = (e) => {
      if (!this.pointerLocked || !this.enabled) return;
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
    };
    this._onPointerDown = (e) => {
      if (e.pointerType === 'touch') this.noteDevice('touch');
      else if (e.pointerType === 'mouse') this.noteDevice('desktop');
    };
    this._onWheel = (e) => { if (this.enabled) this.wheel += Math.sign(e.deltaY); };
    this._onContextMenu = (e) => e.preventDefault();
    this._onLockChange = () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (!this.pointerLocked) this.clearAll();
      if (this.onPointerLockChange) this.onPointerLockChange(this.pointerLocked);
    };
    this._onBlur = () => this.clearAll();

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('pointerdown', this._onPointerDown, { capture: true, passive: true });
    window.addEventListener('wheel', this._onWheel, { passive: true });
    window.addEventListener('blur', this._onBlur);
    canvas.addEventListener('contextmenu', this._onContextMenu);
    document.addEventListener('pointerlockchange', this._onLockChange);
  }

  /* ------------------------------------------------------------ device mode */

  noteDevice(mode) {
    if (mode === 'touch') this.lastTouchInputAt = performance.now();
    // A mouse click shortly after touch input is usually a synthesised event: ignore it.
    if (mode === 'desktop' && performance.now() - this.lastTouchInputAt < 800) return;
    this.setMode(mode);
  }

  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.clearAll();
    for (const l of this.modeListeners) l(mode);
  }

  onModeChange(fn) { this.modeListeners.add(fn); return () => this.modeListeners.delete(fn); }

  /* ------------------------------------------------------------ pointer lock */

  requestPointerLock() {
    if (this.pointerLocked || this.mode === 'touch') return;
    const plain = () => {
      try {
        const p2 = this.canvas.requestPointerLock();
        if (p2 && p2.catch) p2.catch((e) => console.warn('[Input] pointer lock unavailable:', e && e.message));
      } catch (e) { console.warn('[Input] pointer lock unavailable:', e && e.message); }
    };
    try {
      const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(() => plain());
    } catch (e) { plain(); }
  }

  exitPointerLock() { if (document.pointerLockElement) document.exitPointerLock(); }

  clearAll() {
    this.keys.clear(); this.mouseButtons.clear();
    this.pressedKeys.clear(); this.releasedKeys.clear();
    this.mousePressed.clear(); this.mouseReleased.clear();
    this.mouseDX = 0; this.mouseDY = 0;
    this.touchPressed.clear(); this.touchReleased.clear(); this.touchHeld.clear();
    this.touch.axis.x = 0; this.touch.axis.z = 0; this.touch.active = false; this.touch.camDX = 0; this.touch.camDY = 0;
  }

  /* ------------------------------------------------------------ raw queries (kept for compatibility) */

  isDown(code) { return this.keys.has(code); }
  wasPressed(code) { return this.pressedKeys.has(code); }
  wasReleased(code) { return this.releasedKeys.has(code); }
  isMouseDown(button) { return this.mouseButtons.has(button); }
  wasMousePressed(button) { return this.mousePressed.has(button); }
  wasMouseReleased(button) { return this.mouseReleased.has(button); }

  /* ------------------------------------------------------------ action queries */

  pressed(action) {
    if (this.touchPressed.has(action)) return true;
    const keys = KEY_ACTIONS[action];
    if (keys && keys.some((k) => this.pressedKeys.has(k))) return true;
    const mb = MOUSE_ACTIONS[action];
    return mb !== undefined && this.mousePressed.has(mb);
  }

  released(action) {
    if (this.touchReleased.has(action)) return true;
    const keys = KEY_ACTIONS[action];
    if (keys && keys.some((k) => this.releasedKeys.has(k))) return true;
    const mb = MOUSE_ACTIONS[action];
    return mb !== undefined && this.mouseReleased.has(mb);
  }

  held(action) {
    if (this.touchHeld.has(action)) return true;
    const keys = KEY_ACTIONS[action];
    if (keys && keys.some((k) => this.keys.has(k))) return true;
    const mb = MOUSE_ACTIONS[action];
    return mb !== undefined && this.mouseButtons.has(mb);
  }

  /** Movement axis in [-1,1]: x = right, z = forward. Touch joystick is analogue; keys are digital. */
  getMoveAxis() {
    if (this.touch.active) return { x: this.touch.axis.x, z: this.touch.axis.z };
    let x = 0, z = 0;
    if (this.isDown('KeyW') || this.isDown('ArrowUp')) z += 1;
    if (this.isDown('KeyS') || this.isDown('ArrowDown')) z -= 1;
    if (this.isDown('KeyD') || this.isDown('ArrowRight')) x += 1;
    if (this.isDown('KeyA') || this.isDown('ArrowLeft')) x -= 1;
    const len = Math.hypot(x, z);
    if (len > 1) { x /= len; z /= len; }
    return { x, z };
  }

  consumeMouseDelta() {
    const d = { x: this.mouseDX + this.touch.camDX, y: this.mouseDY + this.touch.camDY };
    this.mouseDX = 0; this.mouseDY = 0; this.touch.camDX = 0; this.touch.camDY = 0;
    return d;
  }

  consumeWheel() { const w = this.wheel; this.wheel = 0; return w; }

  /* ------------------------------------------------------------ touch feeders */

  triggerTouch(action) { this.touchPressed.add(action); this.noteDevice('touch'); }
  setTouchHeld(action, v) {
    if (v) { if (!this.touchHeld.has(action)) { this.touchHeld.add(action); this.touchPressed.add(action); } this.noteDevice('touch'); }
    else if (this.touchHeld.has(action)) { this.touchHeld.delete(action); this.touchReleased.add(action); } // releases never re-flag the device
  }
  setTouchAxis(x, z, active) { this.touch.axis.x = x; this.touch.axis.z = z; this.touch.active = active; }
  addTouchCamera(dx, dy) { this.touch.camDX += dx; this.touch.camDY += dy; }

  /** Call at the end of every frame to clear edge-triggered sets. */
  endFrame() {
    this.pressedKeys.clear(); this.releasedKeys.clear();
    this.mousePressed.clear(); this.mouseReleased.clear();
    this.touchPressed.clear(); this.touchReleased.clear();
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('pointerdown', this._onPointerDown, { capture: true });
    window.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('blur', this._onBlur);
    this.canvas.removeEventListener('contextmenu', this._onContextMenu);
    document.removeEventListener('pointerlockchange', this._onLockChange);
  }
}
