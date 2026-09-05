import { GameRoom } from './GameRoom.js';
import { S2C, QUEUE_STATE } from '../src/net/Protocol.js';

/**
 * Queue-based matchmaking. One queue per region ('AUTO' for now; EU/NA/ASIA/ME can be added by
 * key). Two players in the same region queue are paired into a GameRoom immediately; the queue
 * never holds a session twice, and cancelling or disconnecting removes the entry at once.
 */
export class Matchmaker {
  constructor({ log = console, matchDuration = 300, difficulty = 'NORMAL' } = {}) {
    this.log = log;
    this.queues = new Map();   // region -> [{ session, since }]
    this.rooms = new Map();    // roomId -> GameRoom
    this.matchDuration = matchDuration;
    this.difficulty = difficulty;
    this.ticker = setInterval(() => this.broadcastQueueState(), 1000);
  }

  queueFor(region) {
    const key = typeof region === 'string' && region ? region.toUpperCase() : 'AUTO';
    if (!this.queues.has(key)) this.queues.set(key, []);
    return this.queues.get(key);
  }

  enqueue(session, region = 'AUTO') {
    if (session.queueState !== QUEUE_STATE.IDLE) {
      session.send({ t: S2C.ERROR, code: 'ALREADY_QUEUED', message: `Cannot search while ${session.queueState}` });
      return false;
    }
    const q = this.queueFor(region);
    q.push({ session, since: Date.now() });
    session.queueState = QUEUE_STATE.QUEUED;
    session.region = region;
    this.log.info(`[mm] ${session.displayName} queued (${region}); waiting=${q.length}`);
    this.tryPair(q);
    this.broadcastQueueState();
    return true;
  }

  dequeue(session) {
    for (const q of this.queues.values()) {
      const i = q.findIndex((e) => e.session === session);
      if (i >= 0) q.splice(i, 1);
    }
    if (session.queueState === QUEUE_STATE.QUEUED) session.queueState = QUEUE_STATE.IDLE;
    this.broadcastQueueState();
  }

  tryPair(q) {
    while (q.length >= 2) {
      const a = q.shift(), b = q.shift();
      if (!a.session.connected) { q.unshift(b); a.session.queueState = QUEUE_STATE.IDLE; continue; }
      if (!b.session.connected) { q.unshift(a); b.session.queueState = QUEUE_STATE.IDLE; continue; }
      a.session.queueState = QUEUE_STATE.MATCHED; b.session.queueState = QUEUE_STATE.MATCHED;
      const room = new GameRoom({ sessions: [a.session, b.session], log: this.log, onClose: (r) => this.rooms.delete(r.id), matchDuration: this.matchDuration, difficulty: this.difficulty });
      this.rooms.set(room.id, room);
      this.log.info(`[mm] paired ${a.session.displayName} vs ${b.session.displayName} -> ${room.id}`);
    }
  }

  broadcastQueueState() {
    const now = Date.now();
    for (const [region, q] of this.queues) {
      for (const e of q) e.session.send({ t: S2C.QUEUE, state: 'SEARCHING', region, waiting: q.length, elapsed: Math.round((now - e.since) / 1000) });
    }
  }

  stats() {
    let waiting = 0; for (const q of this.queues.values()) waiting += q.length;
    return { waiting, rooms: Array.from(this.rooms.values()).map((r) => r.summary()) };
  }

  dispose() { clearInterval(this.ticker); }
}
