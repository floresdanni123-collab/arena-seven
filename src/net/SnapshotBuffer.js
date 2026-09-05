/**
 * Ordered buffer of server snapshots keyed by server time (ms). `sample(t)` returns the two snapshots
 * bracketing t plus the interpolation factor so remote entities can be rendered slightly behind
 * real time without jitter.
 */
export class SnapshotBuffer {
  constructor(keepMs = 2500) {
    this.items = [];
    this.keepMs = keepMs;
    this.latest = null;
  }

  push(snap) {
    if (this.latest && snap.st < this.latest.st) return; // out of order: drop
    this.items.push(snap);
    this.latest = snap;
    const cutoff = snap.st - this.keepMs;
    while (this.items.length > 2 && this.items[0].st < cutoff) this.items.shift();
  }

  get length() { return this.items.length; }
  get oldest() { return this.items[0] || null; }

  /** { a, b, k } with a.st <= t <= b.st when possible; clamps at the ends. */
  sample(t) {
    const s = this.items;
    if (!s.length) return { a: null, b: null, k: 0 };
    if (t <= s[0].st) return { a: s[0], b: null, k: 0 };
    if (t >= s[s.length - 1].st) return { a: s[s.length - 1], b: null, k: 0, extrapolate: (t - s[s.length - 1].st) / 1000 };
    let lo = 0, hi = s.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (s[mid].st <= t) lo = mid; else hi = mid; }
    const a = s[lo], b = s[hi];
    const k = Math.max(0, Math.min(1, (t - a.st) / Math.max(1, b.st - a.st)));
    return { a, b, k };
  }

  clear() { this.items.length = 0; this.latest = null; }
}
