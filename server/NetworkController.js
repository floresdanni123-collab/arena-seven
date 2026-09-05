import { applyOutfieldIntent, applyKeeperIntent, makeIntent } from '../src/player/PlayerIntent.js';
import { LIMITS } from '../src/net/Protocol.js';

/**
 * Server-side stand-in for the human controllers. Each human slot has one inbox of validated intents
 * received from that client; two thin controller views (outfield / keeper) apply them to whichever
 * player the human currently controls using the exact same apply functions as the local game.
 */
export class NetworkInbox {
  constructor(team) {
    this.team = team;
    this.queue = [];
    this.last = makeIntent();
    this.lastSeq = 0;
    this.received = 0;
    this.dropped = 0;
    this.rateWindow = { t: 0, n: 0 };
  }

  /** Validate and queue an intent from the network. Returns false when rejected. */
  push(raw, now) {
    if (!raw || typeof raw !== 'object') return false;
    // Rate limit
    if (now - this.rateWindow.t > 1000) { this.rateWindow.t = now; this.rateWindow.n = 0; }
    if (++this.rateWindow.n > LIMITS.MAX_INPUT_PER_SEC) { this.dropped++; return false; }
    const seq = Number(raw.seq) | 0;
    if (seq <= this.lastSeq && this.lastSeq !== 0) { this.dropped++; return false; }
    const it = makeIntent();
    const num = (v, lo, hi) => { v = Number(v); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0; };
    it.mx = num(raw.mx, -1, 1); it.mz = num(raw.mz, -1, 1);
    const ml = Math.hypot(it.mx, it.mz); if (ml > 1) { it.mx /= ml; it.mz /= ml; }
    it.ax = num(raw.ax, -1, 1); it.az = num(raw.az, -1, 1);
    const al = Math.hypot(it.ax, it.az); if (al < 1e-4) { it.ax = 0; it.az = 1; } else { it.ax /= al; it.az /= al; }
    it.ap = num(raw.ap, -1, 1);
    it.ix = num(raw.ix, -1, 1); it.iz = num(raw.iz, -1, 1);
    for (const k of ['sp', 'sl', 'tc', 'cs', 'cr', 'kh', 'tk', 'jk', 'cy', 'nr', 'gd', 'gc', 'gr', 'gs', 'gk']) it[k] = !!raw[k];
    it.js = raw.js === 1 || raw.js === -1 ? raw.js : 0;
    it.jt = raw.jt === 1 ? 1 : -1;
    it.seq = seq;
    this.lastSeq = seq;
    this.received++;
    this.queue.push(it);
    if (this.queue.length > 12) this.queue.shift();
    return true;
  }

  /** Drain queued intents; when empty, repeat the last one with all edge flags cleared. */
  drain() {
    if (!this.queue.length) {
      const it = { ...this.last };
      for (const k of ['cs', 'cr', 'kh', 'tk', 'jk', 'cy', 'nr', 'gd', 'gc', 'gr', 'gs', 'gk']) it[k] = false;
      it.cr = this.last.cs ? false : this.last.cr; // keep the client's button-up state so held charges end
      return [it];
    }
    const list = this.queue.splice(0, this.queue.length);
    this.last = list[list.length - 1];
    return list;
  }
}

export class NetworkController {
  constructor(inbox, kind) {
    this.inbox = inbox;
    this.kind = kind; // 'outfield' | 'keeper'
    this.player = null;
    this.mode = 'normal';
    this.enabled = true;
    this.onSwitchRequest = null;
    this.onCycleRequest = null;
    this.onToast = null;
    this.setPieces = null;
    this.shiftLock = null;
    this.state = { rushCooldown: 0, shuffleCooldown: 0, holdTime: 0 };
    this.lastIntent = null;
  }

  setPlayer(player) {
    if (this.player) { this.player.cancelCharge(); this.player.faceAim = false; this.player.accelMult = 1; }
    this.player = player;
    this.state.holdTime = 0;
  }

  update(dt, world) {
    const p = this.player;
    if (!p || !this.enabled) return;
    const intents = this.inbox.drain();
    for (let i = 0; i < intents.length; i++) {
      const it = intents[i];
      this.lastIntent = it;
      const ctx = { mode: this.mode, setPieces: this.setPieces, onCycle: this.onCycleRequest, onNearest: this.onSwitchRequest, state: this.state, dt: i === 0 ? dt : 0, toast: null };
      if (p.isGoalkeeper) applyKeeperIntent(p, it, world, ctx); else applyOutfieldIntent(p, it, world, ctx);
    }
  }
}
