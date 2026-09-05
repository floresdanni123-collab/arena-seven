/**
 * Keyboard + mouse input with pointer lock. Exposes per-frame "pressed" edges and held state.
 * Mouse deltas accumulate between frames and are consumed by the camera.
 */
export class InputManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set();
    this.released = new Set();
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

    this._onKeyDown = (e) => {
      if (e.repeat) return;
      const code = e.code;
      if (code === 'Escape') {
        // Browser exits pointer lock on ESC itself; we notify listeners via lock change.
        if (this.onEscape) this.onEscape();
        return;
      }
      if (!this.enabled) return;
      this.keys.add(code);
      this.pressed.add(code);
      if (['Space', 'Tab', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(code)) e.preventDefault();
    };
    this._onKeyUp = (e) => {
      this.keys.delete(e.code);
      this.released.add(e.code);
    };
    this._onMouseDown = (e) => {
      if (!this.enabled) return;
      if (e.target !== this.canvas) return;
      if (this.wantsPointerLock && !this.pointerLocked) {
        this.requestPointerLock();
        return;
      }
      this.mouseButtons.add(e.button);
      this.mousePressed.add(e.button);
      e.preventDefault();
    };
    this._onMouseUp = (e) => {
      if (this.mouseButtons.has(e.button)) {
        this.mouseButtons.delete(e.button);
        this.mouseReleased.add(e.button);
      }
    };
    this._onMouseMove = (e) => {
      if (!this.pointerLocked || !this.enabled) return;
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
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
    window.addEventListener('wheel', this._onWheel, { passive: true });
    window.addEventListener('blur', this._onBlur);
    canvas.addEventListener('contextmenu', this._onContextMenu);
    document.addEventListener('pointerlockchange', this._onLockChange);
  }

  requestPointerLock() {
    if (this.pointerLocked) return;
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

  exitPointerLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  clearAll() {
    this.keys.clear(); this.mouseButtons.clear();
    this.pressed.clear(); this.released.clear();
    this.mousePressed.clear(); this.mouseReleased.clear();
    this.mouseDX = 0; this.mouseDY = 0;
  }

  isDown(code) { return this.keys.has(code); }
  wasPressed(code) { return this.pressed.has(code); }
  wasReleased(code) { return this.released.has(code); }
  isMouseDown(button) { return this.mouseButtons.has(button); }
  wasMousePressed(button) { return this.mousePressed.has(button); }
  wasMouseReleased(button) { return this.mouseReleased.has(button); }

  /** Movement axis in [-1,1]: x = right, z = forward (W positive). */
  getMoveAxis() {
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
    const d = { x: this.mouseDX, y: this.mouseDY };
    this.mouseDX = 0; this.mouseDY = 0;
    return d;
  }

  consumeWheel() { const w = this.wheel; this.wheel = 0; return w; }

  /** Call at the end of every frame to clear edge-triggered sets. */
  endFrame() {
    this.pressed.clear(); this.released.clear();
    this.mousePressed.clear(); this.mouseReleased.clear();
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('blur', this._onBlur);
    this.canvas.removeEventListener('contextmenu', this._onContextMenu);
    document.removeEventListener('pointerlockchange', this._onLockChange);
  }
}
