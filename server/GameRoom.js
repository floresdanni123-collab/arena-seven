import { createHeadlessMatch } from './HeadlessMatch.js';
import { buildSnapshot, serializeEvent } from './NetworkState.js';
import { S2C, NET, QUEUE_STATE } from '../src/net/Protocol.js';
import { MATCH_STATE, TEAM } from '../src/utils/Constants.js';

/** Gameplay events relayed to the room's clients (for HUD, audio and replays). */
const RELAYED_EVENTS = ['goal_scored', 'goal_ui', 'kickoff', 'kickoff_setup', 'foul', 'foul_awarded', 'advantage', 'card', 'send_off', 'ball_out', 'set_piece', 'set_piece_ready', 'set_piece_taken', 'play_resumed',
  'replay_start', 'replay_end', 'shootout_start', 'shootout_update', 'shootout_kick', 'shootout_end', 'fulltime_tied', 'save', 'post', 'kick', 'tackle_hit', 'tackle_ball', 'juke_success', 'player_switch', 'match_state', 'toast', 'ball_reset'];

let roomCounter = 0;
const newRoomId = () => 'room_' + (Date.now().toString(36).slice(-4) + (++roomCounter).toString(36)).toUpperCase();

/**
 * One online match: an authoritative headless simulation, two human sessions, a fixed-step tick loop,
 * snapshot broadcasting, readiness/countdown, disconnect grace, rematch handling.
 * Only the two sessions of this room ever receive its traffic.
 */
export class GameRoom {
  constructor({ sessions, log = console, onClose, matchDuration = 300, difficulty = 'NORMAL' }) {
    this.id = newRoomId();
    this.log = log;
    this.onClose = onClose;
    this.matchDuration = matchDuration;
    this.difficulty = difficulty;
    this.state = 'LOADING';       // LOADING | COUNTDOWN | RUNNING | PAUSED | FINISHED | CLOSED
    this.tick = 0;
    this.timer = null;
    this.accumulator = 0;
    this.lastTickAt = 0;
    this.startAt = 0;
    this.rematch = {};
    this.closed = false;

    // Random team assignment
    const first = Math.random() < 0.5 ? 0 : 1;
    this.slots = {};
    this.slots[first] = sessions[0];
    this.slots[1 - first] = sessions[1];
    for (const team of [TEAM.BLUE, TEAM.RED]) {
      const s = this.slots[team];
      s.team = team; s.room = this; s.ready = false; s.queueState = QUEUE_STATE.IN_GAME; s.disconnectedAt = 0;
    }
    this.createMatch();
  }

  get sessions() { return [this.slots[TEAM.BLUE], this.slots[TEAM.RED]]; }
  opponentOf(session) { return this.slots[session.team === TEAM.BLUE ? TEAM.RED : TEAM.BLUE]; }

  createMatch() {
    if (this.match) { this.unsubscribe(); this.match.dispose(); }
    const names = { [TEAM.BLUE]: this.slots[TEAM.BLUE].displayName, [TEAM.RED]: this.slots[TEAM.RED].displayName };
    const { match, events, inboxes } = createHeadlessMatch({ humanNames: names, duration: this.matchDuration, difficulty: this.difficulty });
    this.match = match; this.events = events; this.inboxes = inboxes;
    this.subs = RELAYED_EVENTS.map((name) => events.on(name, (data) => this.relay(name, data)));
    this.subs.push(events.on('fulltime', (d) => this.onFullTime(d)));
    for (const s of this.sessions) s.ready = false;
    this.state = 'LOADING';
    this.tick = 0;
    this.sendMatchFound();
  }

  unsubscribe() { if (this.subs) for (const off of this.subs) off(); this.subs = null; }

  /** Everything a client needs to build the same squads. */
  matchDescriptor(session) {
    const opp = this.opponentOf(session);
    return {
      roomId: this.id, team: session.team, opponent: { name: opp.displayName, playerId: opp.playerId },
      you: { name: session.displayName, playerId: session.playerId },
      roster: this.match.roster, duration: this.matchDuration, difficulty: this.difficulty,
      state: this.state, matchState: this.match.state, score: [...this.match.score]
    };
  }

  sendMatchFound() { for (const s of this.sessions) s.send({ t: S2C.MATCH_FOUND, ...this.matchDescriptor(s) }); }

  /* ------------------------------------------------------------ readiness & start */

  onReady(session) {
    session.ready = true;
    if (this.state !== 'LOADING') { session.send({ t: S2C.START_MATCH, startAt: this.startAt, now: Date.now(), resumed: true }); return; }
    if (this.sessions.every((s) => s.ready)) {
      this.state = 'COUNTDOWN';
      this.startAt = Date.now() + 3300;
      for (const s of this.sessions) s.send({ t: S2C.START_MATCH, startAt: this.startAt, now: Date.now() });
      setTimeout(() => this.startLoop(), 3300);
    }
  }

  startLoop() {
    if (this.closed || this.state === 'FINISHED') return;
    this.state = 'RUNNING';
    this.lastTickAt = Date.now();
    this.accumulator = 0;
    const step = 1000 / NET.TICK_RATE;
    this.timer = setInterval(() => this.loop(step), step);
  }

  loop(stepMs) {
    if (this.closed) return;
    const now = Date.now();
    if (this.state !== 'RUNNING') { this.lastTickAt = now; return; }
    this.accumulator += now - this.lastTickAt;
    this.lastTickAt = now;
    let steps = 0;
    while (this.accumulator >= stepMs && steps < 5) {
      this.accumulator -= stepMs;
      this.match.update(stepMs / 1000);
      this.tick++;
      steps++;
      if (this.tick % Math.round(NET.TICK_RATE / NET.SNAPSHOT_RATE) === 0) this.broadcast(buildSnapshot(this.match, this.tick, Date.now()));
    }
    if (steps === 5) this.accumulator = 0; // dropped frames: don't spiral
  }

  /* ------------------------------------------------------------ input */

  onInput(session, intent) {
    if (this.state !== 'RUNNING' || session.team === undefined) return;
    this.inboxes[session.team].push(intent, Date.now());
  }

  /* ------------------------------------------------------------ relay */

  relay(name, data) {
    const payload = serializeEvent(data);
    this.broadcast({ t: S2C.EVENT, name, data: payload, st: Date.now(), mt: this.match.time });
  }

  broadcast(msg) { for (const s of this.sessions) s.send(msg); }

  /* ------------------------------------------------------------ end of match */

  onFullTime(d) {
    if (this.state === 'FINISHED') return;
    this.state = 'FINISHED';
    this.stopLoop();
    this.broadcast({ t: S2C.MATCH_END, reason: d.reason || 'FULL_TIME', winner: d.winner, score: d.score, shootout: d.shootout || null });
    this.rematch = {};
  }

  onRematch(session, accept) {
    if (this.state !== 'FINISHED') return;
    if (!accept) { this.close('REMATCH_DECLINED', session); return; }
    this.rematch[session.team] = true;
    this.broadcast({ t: S2C.REMATCH, requestedBy: session.team, accepted: !!(this.rematch[0] && this.rematch[1]) });
    if (this.rematch[0] && this.rematch[1]) {
      // Swap teams for the rematch and rebuild.
      const b = this.slots[TEAM.BLUE], r = this.slots[TEAM.RED];
      this.slots[TEAM.BLUE] = r; this.slots[TEAM.RED] = b;
      r.team = TEAM.BLUE; b.team = TEAM.RED;
      this.rematch = {};
      this.createMatch();
    }
  }

  /* ------------------------------------------------------------ connection handling */

  onDisconnect(session) {
    if (this.closed) return;
    session.disconnectedAt = Date.now();
    const opp = this.opponentOf(session);
    if (this.state === 'FINISHED') { this.close('OPPONENT_LEFT', session); return; }
    if (this.state === 'RUNNING') this.state = 'PAUSED';
    opp.send({ t: S2C.OPPONENT_STATUS, status: 'DISCONNECTED', grace: NET.RECONNECT_GRACE });
    session.graceTimer = setTimeout(() => {
      if (this.closed || session.connected) return;
      // No reconnect: the remaining player wins.
      this.log.info(`[room ${this.id}] ${session.displayName} did not reconnect, awarding win`);
      this.forfeit(session);
    }, NET.RECONNECT_GRACE * 1000);
  }

  onReconnect(session) {
    if (this.closed) return;
    clearTimeout(session.graceTimer);
    session.disconnectedAt = 0;
    const opp = this.opponentOf(session);
    opp.send({ t: S2C.OPPONENT_STATUS, status: 'RECONNECTED' });
    // Re-send the match description so the client can rebuild, then resume when it reports ready.
    session.ready = false;
    session.send({ t: S2C.MATCH_FOUND, ...this.matchDescriptor(session), resumed: true });
    if (this.state === 'PAUSED') {
      // Resume once the returning client is ready; poll briefly.
      const waitReady = setInterval(() => {
        if (this.closed) { clearInterval(waitReady); return; }
        if (session.ready) { clearInterval(waitReady); this.state = 'RUNNING'; this.lastTickAt = Date.now(); this.accumulator = 0; this.broadcast({ t: S2C.OPPONENT_STATUS, status: 'RESUMED' }); }
      }, 100);
      setTimeout(() => clearInterval(waitReady), 20000);
    }
  }

  forfeit(leaver) {
    const winner = leaver.team === TEAM.BLUE ? TEAM.RED : TEAM.BLUE;
    this.state = 'FINISHED';
    this.stopLoop();
    const opp = this.opponentOf(leaver);
    opp.send({ t: S2C.MATCH_END, reason: 'OPPONENT_DISCONNECTED', winner, score: [...this.match.score], shootout: null });
    this.close('FORFEIT', leaver, false);
  }

  onLeave(session) {
    if (this.closed) return;
    if (this.state === 'FINISHED') { this.close('OPPONENT_LEFT', session); return; }
    this.forfeit(session);
  }

  stopLoop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  close(reason, by = null, notify = true) {
    if (this.closed) return;
    this.closed = true;
    this.stopLoop();
    this.unsubscribe();
    for (const s of this.sessions) {
      clearTimeout(s.graceTimer);
      if (notify && s !== by) s.send({ t: S2C.REMATCH, declined: true, reason });
      s.room = null; s.team = undefined; s.ready = false; s.queueState = QUEUE_STATE.IDLE;
    }
    if (this.match) this.match.dispose();
    this.log.info(`[room ${this.id}] closed (${reason})`);
    if (this.onClose) this.onClose(this);
  }

  /** Debug summary for the health endpoint. */
  summary() { return { id: this.id, state: this.state, tick: this.tick, matchState: this.match ? this.match.state : null, score: this.match ? this.match.score : null, players: this.sessions.map((s) => ({ name: s.displayName, team: s.team, connected: s.connected })) }; }
}
