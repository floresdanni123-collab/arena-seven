import 'dotenv/config';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { Matchmaker } from './Matchmaker.js';
import { C2S, S2C, QUEUE_STATE, LIMITS, encode, decode } from '../src/net/Protocol.js';

/**
 * Arena Seven multiplayer server: WebSocket matchmaking + authoritative match rooms.
 *
 * Environment: PORT (default 8787), CLIENT_ORIGIN (comma-separated allowed origins, or * / unset),
 * NODE_ENV, MATCH_DURATION (seconds), AI_DIFFICULTY (EASY|NORMAL|HARD), LOG_LEVEL.
 */
const PORT = Number(process.env.PORT) || 8787;
const ORIGINS = (process.env.CLIENT_ORIGIN || '*').split(',').map((s) => s.trim()).filter(Boolean);
const MATCH_DURATION = Number(process.env.MATCH_DURATION) || 300;
const AI_DIFFICULTY = process.env.AI_DIFFICULTY || 'NORMAL';
const QUIET = process.env.LOG_LEVEL === 'silent';
const log = { info: (...a) => { if (!QUIET) console.log(new Date().toISOString(), ...a); }, warn: (...a) => console.warn(...a), error: (...a) => console.error(...a) };

const sessions = new Map();     // sessionId -> Session (kept through the reconnect grace period)
const matchmaker = new Matchmaker({ log, matchDuration: MATCH_DURATION, difficulty: AI_DIFFICULTY });
let playerCounter = 1000 + Math.floor(Math.random() * 8000);

class Session {
  constructor(ws) {
    this.sessionId = crypto.randomUUID();
    this.token = crypto.randomBytes(18).toString('base64url');
    this.playerId = 'p' + (++playerCounter);
    this.displayName = 'Player ' + playerCounter;
    this.queueState = QUEUE_STATE.IDLE;
    this.room = null;
    this.team = undefined;
    this.ws = ws;
    this.connected = true;
    this.alive = true;
    this.lastSeen = Date.now();
  }
  send(msg) { if (this.connected && this.ws && this.ws.readyState === 1) { try { this.ws.send(encode(msg)); } catch (_) { /* closed */ } } }
  bind(ws) { this.ws = ws; this.connected = true; this.alive = true; }
}

/* ------------------------------------------------------------ HTTP (health) + WS */

// Optional static hosting of the built client (dist/) so one service can serve game + matchmaking.
const DIST = path.resolve(process.cwd(), 'dist');
const SERVE_CLIENT = process.env.SERVE_CLIENT !== 'false' && fs.existsSync(path.join(DIST, 'index.html'));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health' || (url === '/' && !SERVE_CLIENT)) {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ ok: true, name: 'arena-seven-server', sessions: sessions.size, ...matchmaker.stats() }));
    return;
  }
  if (SERVE_CLIENT) {
    let file = path.join(DIST, url === '/' ? 'index.html' : url);
    if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable' });
    fs.createReadStream(file).pipe(res);
    return;
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server, verifyClient: ({ origin }) => ORIGINS.includes('*') || !origin || ORIGINS.includes(origin) });

wss.on('connection', (ws) => {
  let session = null;
  ws.on('message', (raw) => {
    const msg = decode(raw.toString());
    if (!msg || typeof msg.t !== 'string') return;
    if (msg.t === C2S.HELLO) { session = handleHello(ws, msg); return; }
    if (!session) { ws.send(encode({ t: S2C.ERROR, code: 'NO_HELLO', message: 'Send hello first' })); return; }
    session.lastSeen = Date.now();
    switch (msg.t) {
      case C2S.PING: session.send({ t: S2C.PONG, c: msg.c, s: Date.now() }); break;
      case C2S.FIND_MATCH: matchmaker.enqueue(session, msg.region); break;
      case C2S.CANCEL_MATCH: matchmaker.dequeue(session); session.send({ t: S2C.QUEUE, state: 'IDLE', waiting: 0, elapsed: 0 }); break;
      case C2S.READY: if (session.room) session.room.onReady(session); break;
      case C2S.INPUT: if (session.room) session.room.onInput(session, msg.i); break;
      case C2S.REMATCH: if (session.room) session.room.onRematch(session, !!msg.accept); break;
      case C2S.LEAVE: matchmaker.dequeue(session); if (session.room) session.room.onLeave(session); break;
      default: session.send({ t: S2C.ERROR, code: 'UNKNOWN', message: msg.t });
    }
  });
  ws.on('pong', () => { if (session) session.alive = true; });
  ws.on('close', () => { if (session) handleClose(session); });
  ws.on('error', () => { if (session) handleClose(session); });
});

function handleHello(ws, msg) {
  let session = null;
  const rc = msg.reconnect;
  if (rc && typeof rc.sessionId === 'string' && typeof rc.token === 'string') {
    const existing = sessions.get(rc.sessionId);
    if (existing && existing.token === rc.token) {
      // Same person, same slot. Refuse if a live socket already holds it.
      if (existing.connected && existing.ws !== ws && existing.ws.readyState === 1) {
        ws.send(encode({ t: S2C.ERROR, code: 'SESSION_IN_USE', message: 'That session is already connected' }));
      } else {
        session = existing;
        session.bind(ws);
        const resumed = !!session.room;
        session.send({ t: S2C.WELCOME, playerId: session.playerId, sessionId: session.sessionId, token: session.token, displayName: session.displayName, resumed, queueState: session.queueState });
        if (resumed) session.room.onReconnect(session);
        log.info(`[ws] ${session.displayName} reconnected (${resumed ? 'in room ' + session.room.id : 'idle'})`);
        return session;
      }
    }
  }
  session = new Session(ws);
  if (typeof msg.name === 'string' && msg.name.trim()) session.displayName = msg.name.trim().slice(0, LIMITS.MAX_NAME_LENGTH);
  sessions.set(session.sessionId, session);
  session.send({ t: S2C.WELCOME, playerId: session.playerId, sessionId: session.sessionId, token: session.token, displayName: session.displayName, resumed: false, queueState: QUEUE_STATE.IDLE });
  log.info(`[ws] ${session.displayName} connected (${sessions.size} sessions)`);
  return session;
}

function handleClose(session) {
  if (!session.connected) return;
  session.connected = false;
  matchmaker.dequeue(session);
  if (session.room) session.room.onDisconnect(session);
  // Sessions without a room are forgotten after a short while; in-room sessions live for the grace period.
  setTimeout(() => { if (!session.connected && !session.room) sessions.delete(session.sessionId); }, 60000);
  log.info(`[ws] ${session.displayName} disconnected`);
}

// Liveness: terminate dead sockets.
const heartbeat = setInterval(() => {
  for (const s of sessions.values()) {
    if (!s.connected || !s.ws) continue;
    if (!s.alive) { try { s.ws.terminate(); } catch (_) { /* */ } continue; }
    s.alive = false;
    try { s.ws.ping(); } catch (_) { /* */ }
  }
}, 10000);

server.listen(PORT, () => log.info(`Arena Seven server listening on :${PORT} (origins: ${ORIGINS.join(', ')}, ${MATCH_DURATION}s matches, AI ${AI_DIFFICULTY})`));

const shutdown = () => { clearInterval(heartbeat); matchmaker.dispose(); wss.close(); server.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
