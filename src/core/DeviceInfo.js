/**
 * Capability-based device detection (no user-agent sniffing for decisions).
 */
export const DeviceInfo = {
  get touchCapable() {
    return (navigator.maxTouchPoints && navigator.maxTouchPoints > 0) || 'ontouchstart' in window;
  },
  get coarsePointer() {
    return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  },
  get hoverCapable() {
    return typeof matchMedia === 'function' && matchMedia('(hover: hover)').matches;
  },
  /** Touch-first device: coarse pointer and no hover, or many touch points and no mouse hover. */
  get touchFirst() {
    return this.touchCapable && (this.coarsePointer || !this.hoverCapable);
  },
  get isPortrait() { return window.innerHeight > window.innerWidth; },
  get isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.platform || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  },
  get canVibrate() { return typeof navigator.vibrate === 'function'; },
  /** Rough performance tier for first-launch graphics defaults. */
  get suggestedQuality() {
    if (!this.touchFirst) return 'HIGH';
    const cores = navigator.hardwareConcurrency || 4;
    const mem = navigator.deviceMemory || 4;
    const big = Math.max(screen.width, screen.height) >= 1000;
    if (cores >= 6 && mem >= 4 && big) return 'MEDIUM';
    return cores >= 4 ? 'MEDIUM' : 'LOW';
  }
};
