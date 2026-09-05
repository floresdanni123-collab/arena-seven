import { C2S, S2C, CONN_STATE, NET, encode, decode } from './Protocol.js';
import { EventBus } from '../core/EventBus.js';

const STORAGE_KEY = 'arena7.net.session';

/**
 * WebSocket client with a clean connection state machine, ping measurement and reconnect tokens.
 * Emits: 'state' {state}, 'welcome', 'queue', 'match_found', 'start_match', 'snapshot', 'event',
 *        'opponent', 'match_end', 'rematch', 'error', 'disconnected'.
 */
export class NetworkClient {
  constructor(url) {
    this.url = url;
    this.state = CONN_STATE.DISCONNECTED;
    this.events = new EventBus();
    this.ws = null;
    this.identity = null;        // { playerId, sessionId, token, displayName }
    this.ping = 0;
    this.clockOffset = 0;        // serverTime - clientTime (ms)
    this.pingTimer = null;
    this.stats = { received: 0, snapshots: 0, snapshotRate: 0, lastSnapshotAt: 0, snapWindow: [] };
    this.reconnectAttempts = 0;
    this.wantReconnect = false;
    this.lastMatch = null;
  }

  static defaultUrl() {
    const env = import.meta.env && import.meta.env.VITE_GAME_SERVER_URL;
    if (env) return env;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // Local dev: Vite on 5173, server on 8787. Deployed: the Node server serves the client too, same origin.
    const local = ['localhost', '127.0.0.1'].includes(location.hostname) || /^192\.168\.|^10\./.test(location.hostname);
    return local && location.port === '5173' ? `${proto}://${location.hostname}:8787` : `${proto}://${location.host}`;
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.events.emit('state', { state });
  }

  get serverNow() { return Date.now() + this.clockOffset; }

  loadStoredSession() {
    try { const raw = sessionStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
  }
  storeSession() {
    try { if (this.identity) sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ sessionId: this.identity.sessionId, token: this.identity.token })); } catch (_) { /* */ }
  }
  clearSession() { try { sessionStorage.removeItem(STORAGE_KEY); } catch (_) { /* */ } }

  connect({ reconnect = true } = {}) {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    this.wantReconnect = true;
    this.setState(this.reconnectAttempts > 0 ? CONN_STATE.RECONNECTING : CONN_STATE.CONNECTING);
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) { this.events.emit('error', { code: 'CONNECT', message: String(e) }); this.scheduleReconnect(); return; }
    this.ws = ws;
    ws.onopen = () => {
      const stored = reconnect ? (this.identity ? { sessionId: this.identity.sessionId, token: this.identity.token } : this.loadStoredSession()) : null;
      this.send({ t: C2S.HELLO, reconnect: stored || undefined });
    };
    ws.onmessage = (ev) => this.onMessage(decode(ev.data));
    ws.onclose = () => {
      this.stopPing();
      const wasInMatch = this.state === CONN_STATE.IN_MATCH || this.state === CONN_STATE.LOADING_MATCH || this.state === CONN_STATE.MATCH_FOUND;
      this.events.emit('disconnected', { wasInMatch });
      if (this.wantReconnect && wasInMatch) this.scheduleReconnect();
      else this.setState(CONN_STATE.DISCONNECTED);
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  scheduleReconnect() {
    if (!this.wantReconnect) return;
    this.reconnectAttempts++;
    if (this.reconnectAttempts > 8) { this.setState(CONN_STATE.DISCONNECTED); this.events.emit('error', { code: 'RECONNECT_FAILED', message: 'Could not reach the server' }); return; }
    this.setState(CONN_STATE.RECONNECTING);
    setTimeout(() => this.connect({ reconnect: true }), Math.min(4000, 500 * this.reconnectAttempts));
  }

  disconnect() {
    this.wantReconnect = false;
    this.stopPing();
    if (this.ws) { try { this.ws.close(); } catch (_) { /* */ } }
    this.ws = null;
    this.setState(CONN_STATE.DISCONNECTED);
  }

  send(msg) { if (this.ws && this.ws.readyState === 1) this.ws.send(encode(msg)); }

  /* ---------------------------------------------------------- API */

  findMatch(region = 'AUTO') { this.send({ t: C2S.FIND_MATCH, region }); this.setState(CONN_STATE.SEARCHING); }
  cancelMatch() { this.send({ t: C2S.CANCEL_MATCH }); this.setState(CONN_STATE.CONNECTED); }
  ready() { this.send({ t: C2S.READY }); }
  sendInput(intent) { this.send({ t: C2S.INPUT, i: intent }); }
  rematch(accept) { this.send({ t: C2S.REMATCH, accept }); }
  leave() { this.send({ t: C2S.LEAVE }); this.lastMatch = null; this.clearSession(); this.setState(CONN_STATE.CONNECTED); }

  /* ---------------------------------------------------------- inbound */

  onMessage(msg) {
    if (!msg) return;
    this.stats.received++;
    switch (msg.t) {
      case S2C.WELCOME:
        this.identity = { playerId: msg.playerId, sessionId: msg.sessionId, token: msg.token, displayName: msg.displayName };
        this.storeSession();
        this.reconnectAttempts = 0;
        this.setState(msg.resumed ? CONN_STATE.LOADING_MATCH : (msg.queueState === 'QUEUED' ? CONN_STATE.SEARCHING : CONN_STATE.CONNECTED));
        this.startPing();
        this.events.emit('welcome', msg);
        break;
      case S2C.QUEUE:
        if (msg.state === 'SEARCHING') this.setState(CONN_STATE.SEARCHING);
        this.events.emit('queue', msg);
        break;
      case S2C.MATCH_FOUND:
        this.lastMatch = msg;
        this.setState(CONN_STATE.MATCH_FOUND);
        this.events.emit('match_found', msg);
        break;
      case S2C.START_MATCH:
        this.setState(CONN_STATE.IN_MATCH);
        this.events.emit('start_match', msg);
        break;
      case S2C.SNAPSHOT: {
        const now = performance.now();
        this.stats.snapshots++;
        this.stats.snapWindow.push(now);
        while (this.stats.snapWindow.length && now - this.stats.snapWindow[0] > 1000) this.stats.snapWindow.shift();
        this.stats.snapshotRate = this.stats.snapWindow.length;
        this.stats.lastSnapshotAt = now;
        this.events.emit('snapshot', msg);
        break;
      }
      case S2C.EVENT: this.events.emit('event', msg); break;
      case S2C.OPPONENT_STATUS: this.events.emit('opponent', msg); break;
      case S2C.MATCH_END: this.setState(CONN_STATE.MATCH_FINISHED); this.events.emit('match_end', msg); break;
      case S2C.REMATCH: this.events.emit('rematch', msg); break;
      case S2C.PONG: {
        const now = Date.now();
        const rtt = now - msg.c;
        this.ping = this.ping ? Math.round(this.ping * 0.7 + rtt * 0.3) : rtt;
        const offset = msg.s - (msg.c + rtt / 2);
        this.clockOffset = this.clockOffset ? this.clockOffset * 0.8 + offset * 0.2 : offset;
        break;
      }
      case S2C.ERROR: this.events.emit('error', msg); break;
      default: break;
    }
  }

  startPing() {
    this.stopPing();
    const probe = () => this.send({ t: C2S.PING, c: Date.now() });
    probe();
    this.pingTimer = setInterval(probe, NET.PING_INTERVAL * 1000);
  }
  stopPing() { if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; } }
}
