/** Minimal synchronous event bus used for gameplay events (goal, kick, tackle_hit, juke_success ...). */
export class EventBus {
  constructor() { this.listeners = new Map(); }

  on(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
    return () => this.off(name, fn);
  }

  off(name, fn) { const s = this.listeners.get(name); if (s) s.delete(fn); }

  emit(name, data) {
    const s = this.listeners.get(name);
    if (!s) return;
    for (const fn of Array.from(s)) {
      try { fn(data); } catch (e) { console.error(`[EventBus] listener for "${name}" threw`, e); }
    }
  }

  clear() { this.listeners.clear(); }
}
